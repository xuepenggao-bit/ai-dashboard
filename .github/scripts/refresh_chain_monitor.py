#!/usr/bin/env python3
"""Fetch reported A-share chain financials and explicitly defined TTM valuation.

Amounts are CNY yuan, capYi is CNY 100 million, and growth rates are percent.
Q2 is H1 minus Q1; TTM is prior FY plus current YTD minus prior-year YTD.
Missing/zero bases are never invented. Provider data are not issuer filings and
are not a point-in-time archive: historical restatements may replace old values.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import copy
import datetime as dt
import json
import math
import re
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "data" / "chain_monitor.json"
RESEARCH = ROOT / "data" / "chain_research.json"
BEIJING = dt.timezone(dt.timedelta(hours=8))
API = "https://datacenter-web.eastmoney.com/api/data/v1/get"
FIN_REPORT = "RPT_F10_FINANCE_MAINFINADATA"
VAL_REPORT = "RPT_VALUEANALYSIS_DET"
METRICS = ("revenue", "netProfit", "deductedProfit", "operatingCashFlow")
FIELDS = {
    "revenue": "TOTALOPERATEREVE", "netProfit": "PARENTNETPROFIT",
    "deductedProfit": "KCFJCXSYJLR", "operatingCashFlow": "NETCASH_OPERATE_PK",
}
HEADERS = {
    "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/plain, */*",
    "Referer": "https://quote.eastmoney.com/",
}
GROUPS = [
    {"id": "server", "name": "AI服务器", "codes": ["000977", "603019", "000063"]},
    {"id": "pcb", "name": "PCB与材料", "codes": ["002463", "002916", "600183"]},
    {"id": "chip", "name": "算力芯片与互连", "codes": ["688041", "688256", "688008"]},
    {"id": "memory", "name": "存储与模组", "codes": ["603986", "688525", "301308"]},
    {"id": "cooling", "name": "液冷与电源", "codes": ["002837", "300499", "002335"]},
    {"id": "application", "name": "AI应用", "codes": ["002230", "688327", "688787"]},
    {"id": "optical", "name": "光模块", "codes": ["300308", "300502", "300394"]},
    {"id": "aidc", "name": "AIDC", "codes": ["300442", "300738", "603881"]},
    {"id": "idc", "name": "传统IDC", "codes": ["300383", "600845"]},
    {"id": "software", "name": "软件与云转型", "codes": ["688111", "600588", "600570"]},
]
NAMES = dict(zip(
    [code for group in GROUPS for code in group["codes"]],
    ["浪潮信息", "中科曙光", "中兴通讯", "沪电股份", "深南电路", "生益科技",
     "海光信息", "寒武纪", "澜起科技", "兆易创新", "佰维存储", "江波龙",
     "英维克", "高澜股份", "科华数据", "科大讯飞", "云从科技", "海天瑞声",
     "中际旭创", "新易盛", "天孚通信", "润泽科技", "奥飞数据", "数据港",
     "光环新网", "宝信软件", "金山办公", "用友网络", "恒生电子"],
))


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def day(value):
    text = str(value or "")[:10]
    try:
        return dt.date.fromisoformat(text).isoformat()
    except ValueError:
        return None


def period(report_date):
    date = day(report_date)
    if not date:
        return None
    return date[:4] + {"03-31": "Q1", "06-30": "H1", "09-30": "9M", "12-31": "FY"}.get(date[5:], "")


def values(row):
    return {metric: number((row or {}).get(field)) for metric, field in FIELDS.items()}


def subtract(left, right):
    return {key: left[key] - right[key] if left.get(key) is not None and right.get(key) is not None else None
            for key in METRICS}


def growth(current, previous):
    """Absolute-denominator convention; negative bases still need status labels."""
    return {key: (current[key] - previous[key]) / abs(previous[key]) * 100
            if current.get(key) is not None and previous.get(key) not in (None, 0) else None
            for key in METRICS}


def base_sign(previous):
    return {key: "missing" if previous.get(key) is None else "positive" if previous[key] > 0
            else "negative" if previous[key] < 0 else "zero" for key in METRICS}


def quarter_data(label, current, previous):
    return {"period": label, **current, "previous": previous,
            "yoy": growth(current, previous), "yoyBase": base_sign(previous)}


def build_financials(code, rows, as_of):
    """Accept only completed report periods with an actual disclosed date."""
    accepted = {}
    for row in rows:
        report_date, disclosure = day(row.get("REPORT_DATE")), day(row.get("NOTICE_DATE"))
        if str(row.get("SECURITY_CODE")) != code or not report_date or not disclosure:
            continue
        if report_date > as_of or disclosure > as_of or disclosure < report_date:
            continue
        if row.get("CURRENCY") not in (None, "CNY", "人民币"):
            continue
        old = accepted.get(report_date)
        if old is None or str(row.get("UPDATE_DATE") or "") > str(old.get("UPDATE_DATE") or ""):
            accepted[report_date] = row
    if not accepted:
        return None
    latest_date = max(accepted)
    latest = accepted[latest_date]
    current = values(latest)
    if current["revenue"] is None or current["netProfit"] is None:
        return None
    year = int(latest_date[:4])
    prior_date = str(year - 1) + latest_date[4:]
    previous = values(accepted.get(prior_date))
    q1 = values(accepted.get(f"{year}-03-31"))
    q1_previous = values(accepted.get(f"{year - 1}-03-31"))
    h1 = values(accepted.get(f"{year}-06-30"))
    h1_previous = values(accepted.get(f"{year - 1}-06-30"))
    q2 = subtract(h1, q1)
    q2_previous = subtract(h1_previous, q1_previous)
    def single_quarter(y, q):
        dates = {1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31"}
        cumulative = values(accepted.get(f"{y}-{dates[q]}"))
        return cumulative if q == 1 else subtract(cumulative, values(accepted.get(f"{y}-{dates[q - 1]}")))
    latest_q = {"03-31": 1, "06-30": 2, "09-30": 3, "12-31": 4}.get(latest_date[5:])
    previous_y, previous_q = (year, latest_q - 1) if latest_q and latest_q > 1 else (year - 1, 4)
    latest_quarter = quarter_data(f"{year}Q{latest_q}", single_quarter(year, latest_q), single_quarter(year - 1, latest_q)) if latest_q else None
    previous_quarter = quarter_data(f"{previous_y}Q{previous_q}", single_quarter(previous_y, previous_q), single_quarter(previous_y - 1, previous_q)) if latest_q else None
    if latest_date.endswith("12-31"):
        ttm = dict(current)
    else:
        annual = values(accepted.get(f"{year - 1}-12-31"))
        ttm = {key: annual[key] + current[key] - previous[key]
               if all(value is not None for value in (annual[key], current[key], previous[key])) else None
               for key in METRICS}
    issues = []
    if any(current[key] is None for key in METRICS):
        issues.append("latest_report_metric_missing")
    if any(previous[key] is None for key in METRICS):
        issues.append("prior_year_same_period_missing")
    if any(ttm[key] is None for key in METRICS):
        issues.append("ttm_inputs_missing")
    return {
        "code": code, "name": latest.get("SECURITY_NAME_ABBR") or NAMES.get(code, code),
        "reportPeriod": period(latest_date), "reportDate": latest_date,
        "disclosureDate": day(latest.get("NOTICE_DATE")),
        "financials": {
            "currency": "CNY", "unit": "yuan", "current": current, "previous": previous,
            "yoy": growth(current, previous), "yoyBase": base_sign(previous),
            "q1": quarter_data(f"{year}Q1", q1, q1_previous),
            "q2": quarter_data(f"{year}Q2", q2, q2_previous),
            "latestQuarter": latest_quarter, "previousQuarter": previous_quarter,
            "q2VsQ1": growth(q2, q1), "ttm": ttm,
            "method": "reported_YTD; Q2=H1-Q1; TTM=prior_FY+current_YTD-prior_YTD",
            "growthMethod": "(current-previous)/abs(previous)*100; zero_or_missing=null",
        },
        "financialStatus": "partial" if issues else "ok", "financialErrors": issues,
    }


def api_url(report, codes, as_of, page_number=1):
    code_filter = "(SECURITY_CODE in (" + ",".join('"' + code + '"' for code in codes) + "))"
    if report == FIN_REPORT:
        # Four years cover Q1/Q2 comparisons even when latest is a previous FY.
        start = f"{int(as_of[:4]) - 3}-01-01"
        filters = f"{code_filter}(REPORT_DATE>='{start}')(REPORT_DATE<='{as_of}')(NOTICE_DATE<='{as_of}')"
        columns = ",".join(["SECURITY_CODE", "SECURITY_NAME_ABBR", "REPORT_DATE", "NOTICE_DATE",
                            "UPDATE_DATE", "CURRENCY", *FIELDS.values()])
        sort_columns, sort_types = "SECURITY_CODE,REPORT_DATE", "1,-1"
    else:
        start = (dt.date.fromisoformat(as_of) - dt.timedelta(days=21)).isoformat()
        filters = f"{code_filter}(TRADE_DATE>='{start}')(TRADE_DATE<='{as_of}')"
        columns = "SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_DATE,CLOSE_PRICE,CHANGE_RATE,TOTAL_MARKET_CAP,PE_TTM,PE_LAR,PB_MRQ"
        sort_columns, sort_types = "SECURITY_CODE,TRADE_DATE", "1,-1"
    return API + "?" + urlencode({"reportName": report, "columns": columns, "filter": filters,
        "pageSize": 500, "pageNumber": page_number, "sortColumns": sort_columns,
        "sortTypes": sort_types, "source": "WEB", "client": "WEB"})


def request_text(url, encoding="utf-8"):
    error = None
    for attempt in range(2):
        try:
            with urlopen(Request(url, headers=HEADERS), timeout=12) as response:
                return response.read(8_000_000).decode(encoding, errors="replace")
        except Exception as exc:
            error = exc
            if not attempt:
                time.sleep(0.25)
    raise RuntimeError(str(error))


def fetch_report(report, codes, as_of):
    rows, urls = [], []
    page_number, pages = 1, 1
    while page_number <= pages:
        url = api_url(report, codes, as_of, page_number)
        payload = json.loads(request_text(url))
        if not payload.get("success") or not isinstance(payload.get("result"), dict):
            raise RuntimeError(payload.get("message") or "API result missing")
        result = payload["result"]
        batch = result.get("data") or []
        if not isinstance(batch, list):
            raise RuntimeError("API data is not a list")
        rows.extend(batch)
        urls.append(url)
        pages = int(result.get("pages") or 1)
        if pages > 20:
            raise RuntimeError("unexpected pagination size")
        page_number += 1
    return rows, urls


def quote_valid(quote, as_of):
    if not isinstance(quote, dict) or not day(quote.get("date")) or quote["date"] > as_of:
        return False
    price = number(quote.get("price"))
    if price is None or price <= 0:
        return False
    cap = number(quote.get("capYi"))
    if cap is None or cap <= 0:
        return False
    return True


def parse_tencent(text, as_of, now=None):
    now = now or dt.datetime.now(BEIJING)
    quotes = {}
    for match in re.finditer(r'v_((?:sh|sz)\d{6})="([^"]*)"', text):
        ticker, fields = match[1], match[2].split("~")
        if len(fields) <= 53 or fields[2] != ticker[2:]:
            continue
        try:
            timestamp = dt.datetime.strptime(fields[30], "%Y%m%d%H%M%S").replace(tzinfo=BEIJING)
        except ValueError:
            continue
        quote_date = timestamp.date().isoformat()
        if quote_date > as_of or (quote_date == now.date().isoformat() and timestamp > now + dt.timedelta(minutes=5)):
            continue
        if (dt.date.fromisoformat(as_of) - timestamp.date()).days > 21:
            continue
        quote = {
            "price": number(fields[3]), "capYi": number(fields[45]),
            "pb": number(fields[46]), "changePct": number(fields[32]),
            "date": quote_date, "dateTime": timestamp.isoformat(), "source": "Tencent",
            "peTtm": None, "peTtmDate": None, "peTtmSource": None,
            "providerPe39": number(fields[39]), "providerPe53": number(fields[53]),
            "marketCapBasis": "total_shares_at_A_price",
        }
        if quote_valid(quote, as_of):
            quotes[ticker[2:]] = quote
    return quotes


def parse_valuations(rows, as_of):
    quotes = {}
    for row in rows:
        code, quote_date = str(row.get("SECURITY_CODE") or ""), day(row.get("TRADE_DATE"))
        if not quote_date or quote_date > as_of or not re.fullmatch(r"\d{6}", code):
            continue
        cap = number(row.get("TOTAL_MARKET_CAP"))
        quote = {
            "price": number(row.get("CLOSE_PRICE")), "capYi": cap / 1e8 if cap is not None else None,
            "changePct": number(row.get("CHANGE_RATE")), "pb": number(row.get("PB_MRQ")),
            "date": quote_date, "dateTime": quote_date + "T15:00:00+08:00", "source": "Eastmoney valuation",
            "peTtm": number(row.get("PE_TTM")), "peTtmDate": quote_date,
            "peTtmSource": "Eastmoney RPT_VALUEANALYSIS_DET.PE_TTM",
            "marketCapBasis": "provider_total_market_cap",
        }
        if quote.get("peTtm") is not None and quote["peTtm"] <= 0:
            quote["peTtm"] = None
        if quote_valid(quote, as_of) and (code not in quotes or quote_date > quotes[code]["date"]):
            quotes[code] = quote
    return quotes


def combine_quotes(old, live, valuation, financials, as_of):
    candidates = [quote for quote in (old, valuation, live) if quote_valid(quote, as_of)]
    if not candidates:
        return None
    # Prefer newly fetched values on an identical timestamp (also allows field
    # corrections during lunch/after close, when the market timestamp is fixed).
    quote = copy.deepcopy(max(enumerate(candidates), key=lambda item: (item[1].get("dateTime") or item[1]["date"], item[0]))[1])
    for field in ("price", "capYi", "pb", "changePct", "peTtm"):
        quote[field] = number(quote.get(field))
    # Carry an explicitly dated provider TTM, never field 39/dynamic PE.
    pe_candidates = [q for q in (old, valuation) if quote_valid(q, as_of)
                     and number(q.get("peTtm")) is not None and number(q["peTtm"]) > 0
                     and day(q.get("peTtmDate")) and q["peTtmDate"] <= as_of]
    if pe_candidates:
        pe = max(pe_candidates, key=lambda q: q["peTtmDate"])
        for field in ("peTtm", "peTtmDate", "peTtmSource"):
            quote[field] = pe.get(field)
        quote["peTtm"] = number(quote["peTtm"])
    profit = number((financials or {}).get("ttm", {}).get("netProfit"))
    quote["peTtmCalculated"] = quote["capYi"] * 1e8 / profit if profit and profit > 0 else None
    quote["peTtmCalculatedSource"] = "market_cap / reported_TTM_parent_net_profit"
    return quote


def keep_same_period_metrics(fresh, previous):
    """Preserve the entire coherent schedule if a re-read loses valid amounts.

    Do not mix new inputs with saved derived values: that could break Q2/TTM
    identities after a restatement. Called only for the exact same report date.
    """
    retained = []
    def inspect(new, old, path=""):
        if not isinstance(new, dict) or not isinstance(old, dict):
            return
        for key, value in new.items():
            dotted = path + "." + key if path else key
            if isinstance(value, dict):
                inspect(value, old.get(key), dotted)
            elif value is None and number(old.get(key)) is not None:
                retained.append(dotted)
    inspect(fresh, previous)
    if retained:
        fresh.clear()
        fresh.update(copy.deepcopy(previous))
    return retained


def refresh(previous, as_of, now=None, fetcher=fetch_report, text_fetcher=request_text):
    now = now or dt.datetime.now(BEIJING)
    retrieved_at = now.isoformat()
    codes = [code for group in GROUPS for code in group["codes"]]
    old_by_code = {row.get("code"): row for row in (previous or {}).get("stocks", []) if isinstance(row, dict)}
    raw_financials, raw_values, financial_urls, valuation_urls, errors = [], [], [], [], []
    jobs = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for offset in range(0, len(codes), 8):
            chunk = codes[offset:offset + 8]
            for report in (FIN_REPORT, VAL_REPORT):
                jobs[pool.submit(fetcher, report, chunk, as_of)] = (report, chunk)
        for job in concurrent.futures.as_completed(jobs):
            report, chunk = jobs[job]
            try:
                rows, urls = job.result()
                if report == FIN_REPORT:
                    raw_financials.extend(rows)
                    financial_urls.extend(urls)
                else:
                    raw_values.extend(rows)
                    valuation_urls.extend(urls)
            except Exception as exc:
                errors.append({"stage": "financials" if report == FIN_REPORT else "valuation",
                               "codes": chunk, "message": str(exc)[:300]})
    ticker_codes = [("sh" if code.startswith("6") else "sz") + code for code in codes]
    tencent_url = "https://qt.gtimg.cn/q=" + ",".join(ticker_codes)
    try:
        live = parse_tencent(text_fetcher(tencent_url, "gb18030"), as_of, now)
    except Exception as exc:
        live = {}
        errors.append({"stage": "quotes", "message": str(exc)[:300]})
    valuation = parse_valuations(raw_values, as_of)
    stocks, fresh_count = [], 0
    for group in GROUPS:
        for code in group["codes"]:
            old = old_by_code.get(code) or {}
            fresh = build_financials(code, raw_financials, as_of)
            old_valid = (day(old.get("reportDate")) and day(old.get("disclosureDate"))
                         and old["reportDate"] <= as_of and old["disclosureDate"] <= as_of
                         and number((old.get("financials") or {}).get("current", {}).get("revenue")) is not None)
            older = fresh and old_valid and fresh["reportDate"] < old["reportDate"]
            if fresh and not older:
                stock = fresh
                fresh_count += 1
                stock["lastSuccessAt"] = retrieved_at
                stock["status"] = fresh.pop("financialStatus")
                stock["errors"] = fresh.pop("financialErrors")
                if old_valid and fresh["reportDate"] == old["reportDate"]:
                    retained = keep_same_period_metrics(stock["financials"], old.get("financials"))
                    if retained:
                        stock["status"] = "partial"
                        stock["errors"].append("same_period_missing_metrics_kept_previous")
                        stock["retainedFinancialFields"] = retained
            elif old_valid:
                stock = copy.deepcopy(old)
                stock["status"] = "stale"
                stock["errors"] = ["financial_report_older_than_saved" if older else "financial_refresh_failed_kept_previous"]
            else:
                stock = {"code": code, "name": NAMES[code], "reportPeriod": None, "reportDate": None,
                         "disclosureDate": None, "financials": None, "status": "missing",
                         "errors": ["no_valid_reported_financials"]}
            stock["group"] = group["id"]
            quote = combine_quotes(old.get("quote"), live.get(code), valuation.get(code), stock.get("financials"), as_of)
            if quote:
                stock["quote"] = quote
                quote_age = (dt.date.fromisoformat(as_of) - dt.date.fromisoformat(quote["date"])).days
                if quote_age > 7 or code not in live and code not in valuation:
                    stock["errors"].append("quote_stale_kept_previous")
                    if stock["status"] == "ok":
                        stock["status"] = "partial"
            else:
                stock["quote"] = None
                stock["errors"].append("quote_missing")
                if stock["status"] == "ok":
                    stock["status"] = "partial"
            sources = [item for item in old.get("sources", []) if isinstance(item, dict)] if stock["status"] == "stale" or stock.get("retainedFinancialFields") else []
            if fresh and not older:
                sources.append({"name": "Eastmoney reported financial metrics", "url": api_url(FIN_REPORT, [code], as_of),
                                "retrievedAt": retrieved_at, "evidence": "provider_standardized"})
                sources.append({"name": "Financial reports", "url": f"https://data.eastmoney.com/bbsj/{code}.html",
                                "retrievedAt": retrieved_at})
            if code in valuation:
                sources.append({"name": "Eastmoney explicit TTM valuation", "url": api_url(VAL_REPORT, [code], as_of),
                                "retrievedAt": retrieved_at})
            if code in live:
                sources.append({"name": "Tencent live A-share quote", "url": "https://qt.gtimg.cn/q=" + ticker_codes[codes.index(code)],
                                "retrievedAt": retrieved_at})
            stock["sources"] = list({item["url"]: item for item in sources if item.get("url")}.values())
            stocks.append(stock)
    usable = [stock for stock in stocks if stock.get("financials")]
    if not usable:
        raise RuntimeError("No valid financials; refusing to write an empty financial snapshot")
    status = "ok" if all(stock["status"] == "ok" for stock in stocks) and not errors else "partial" if fresh_count else "stale"
    return {"schemaVersion": 1, "asOf": as_of, "generatedAt": retrieved_at,
            "lastSuccessAt": retrieved_at if fresh_count else (previous or {}).get("lastSuccessAt"),
            "status": status, "errors": errors, "groups": GROUPS, "stocks": stocks,
            "coverage": {"total": len(codes), "financials": len(usable), "freshFinancials": fresh_count,
                         "quotes": sum(bool(stock.get("quote")) for stock in stocks)},
            "notes": ["Issuer-wide financials, not pure AI segment revenue; category membership is a monitoring label.",
                      "Negative-base growth is not ordinary positive-base earnings growth.",
                      "Provider-standardized financials can contain later restatements; not a historical point-in-time archive.",
                      "Tencent field 45 uses total shares at A-share price, not an A+H price-weighted capitalization; field 44 is float capitalization.",
                      "PE_TTM is explicitly sourced and dated; Tencent field 39 is retained only as an unclassified raw provider field."]}


def attach_research(snapshot, research):
    """Preserve dated issuer evidence separately from live quantitative fields."""
    if not isinstance(research, dict) or not isinstance(research.get("groups"), list):
        return snapshot
    if not day(research.get("asOf")) or research["asOf"] > snapshot["asOf"]:
        return snapshot
    snapshot["research"] = research
    by_group = {item.get("id"): item for item in research["groups"]}
    for stock in snapshot["stocks"]:
        group = by_group.get(stock["group"], {})
        issuer = [{**item, "evidence": "issuer_filing"} for item in group.get("sources", [])
                  if stock["name"] in item.get("name", "")]
        stock["sources"] = list({item["url"]: item for item in issuer + stock.get("sources", [])
                                  if item.get("url")}.values())
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of", default=dt.datetime.now(BEIJING).date().isoformat())
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if day(args.as_of) != args.as_of:
        parser.error("--as-of must be YYYY-MM-DD")
    if args.as_of > dt.datetime.now(BEIJING).date().isoformat():
        parser.error("--as-of cannot be in the future")
    previous = {}
    if args.output.exists():
        try:
            previous = json.loads(args.output.read_text(encoding="utf-8"))
        except (ValueError, OSError) as exc:
            print(f"Warning: existing snapshot unreadable: {exc}")
    try:
        snapshot = refresh(previous, args.as_of)
        research = json.loads(RESEARCH.read_text(encoding="utf-8")) if RESEARCH.exists() else previous.get("research")
        attach_research(snapshot, research)
    except Exception as exc:
        print(f"Refresh failed; existing file left unchanged: {exc}")
        return 1
    if not args.dry_run:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        temporary.replace(args.output)
    print(json.dumps({"status": snapshot["status"], "asOf": snapshot["asOf"], "coverage": snapshot["coverage"],
                      "errors": snapshot["errors"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
