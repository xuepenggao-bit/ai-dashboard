#!/usr/bin/env python3
"""Daily, source-backed annual broker net-profit forecast snapshots.

Eastmoney's individual institution forecasts contain explicit profit amounts;
EPS multiplied by a current share count is deliberately not a fallback. Pure
HK broker rows are supplied by the separately tested Economic Net parser.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import copy
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import time
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from broker_hk_source import hk_url, parse_hk_forecasts

ROOT = Path(__file__).resolve().parents[2]
BEIJING = dt.timezone(dt.timedelta(hours=8))
CURRENCIES = {"CNY", "HKD", "USD"}
HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json,text/html,*/*", "Referer": "https://emweb.securities.eastmoney.com/"}


def number(value):
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def day(value):
    try:
        return dt.date.fromisoformat(str(value)[:10]).isoformat()
    except (TypeError, ValueError):
        return ""


def normalized_code(value, market):
    value = str(value or "").strip()
    length = 5 if market == "HK" else 6
    if not value.isdigit() or not 0 < int(value) < 10 ** length:
        raise ValueError("Invalid security code")
    return value.zfill(length)


def a_market(code):
    if re.fullmatch(r"6\d{5}", code):
        return "SH"
    if re.fullmatch(r"[03]\d{5}", code):
        return "SZ"
    raise ValueError("Unsupported A-share market/code: " + str(code))


def a_url(code):
    return "https://emweb.securities.eastmoney.com/PC_HSF10/ProfitForecast/PageAjax?code=" + a_market(code) + code


def a_page(code):
    return "https://emweb.securities.eastmoney.com/PC_HSF10/ProfitForecast/Index?type=web&code=" + a_market(code) + code


def read_url(url, attempts=3, timeout=12):
    last = None
    for attempt in range(attempts):
        try:
            headers = {**HEADERS, "Referer": "https://www.etnet.com.hk/" if "etnet.com.hk/" in url else HEADERS["Referer"]}
            with urlopen(Request(url, headers=headers), timeout=timeout) as response:
                raw = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
                return raw.decode(charset, errors="replace")
        except Exception as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(.5 * (attempt + 1))
    raise RuntimeError(str(last)[:240])


def parse_a_forecasts(payload, code, target_year, as_of):
    """Read only the individual forecast table, with explicit year/E/profit.

    Provider row order is retained for publication-day ties; no intraday order
    is invented when the provider only disclosed a calendar date.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("ycmx"), list):
        raise ValueError("A-share forecast-detail table is absent")
    market = a_market(code)
    output = []
    for index, row in enumerate(payload["ycmx"]):
        if not isinstance(row, dict) or str(row.get("SECURITY_CODE")) != code or row.get("SECUCODE") != code + "." + market:
            continue
        published = day(row.get("PUBLISH_DATE"))
        broker, broker_code = str(row.get("ORG_NAME_ABBR") or "").strip(), str(row.get("ORG_CODE") or "").strip()
        if not published or published > as_of or not broker or broker_code == "00000000" or re.search("平均|汇总|共识|一致预期", broker):
            continue
        # Some future/legacy pages place the requested year in another slot.
        slots = [i for i in range(1, 5) if number(row.get("YEAR" + str(i))) == target_year and str(row.get("YEAR_MARK" + str(i)) or "").strip().upper() == "E"]
        if len(slots) != 1:
            continue
        value = number(row.get("PARENT_NETPROFIT" + str(slots[0])))
        if value is None:
            continue
        # The official A-share net-profit table is denominated in CNY yuan.
        # If a future schema explicitly contradicts it, do not reinterpret it.
        supplied_currency = row.get("CURRENCY_CODE") or row.get("CURRENCY")
        if supplied_currency and str(supplied_currency).upper() not in {"CNY", "RMB", "人民币"}:
            continue
        researcher = str(row.get("RESEARCHER") or "").strip()
        ident = "eastmoney-a-" + hashlib.sha256("|".join((code, broker_code or broker, published, researcher, str(target_year))).encode()).hexdigest()[:20]
        output.append({"id": ident, "broker": broker, "brokerCode": broker_code, "researcher": researcher,
                       "title": "机构盈利预测明细（研报摘录） · " + broker,
                       "publishedAt": published, "forecastYear": target_year, "currency": "CNY", "profitYi": value / 1e8,
                       "url": a_page(code), "sourceType": "provider_broker_detail", "sourceOrder": index,
                       "metric": "parent_net_profit", "dateType": "provider_publication_date", "periodBasis": "calendar_year",
                       "sourceNote": "东方财富按机构提供的研报摘录，原始字段为归母净利润（元），非扣非、非EPS反推；链接为提供商预测明细页。"})
    return output


def broker_key(report):
    if report.get("brokerCode"):
        return "code:" + str(report["brokerCode"])
    return "name:" + re.sub(r"\s+|股份有限公司|有限责任公司|有限公司", "", str(report.get("broker") or "")).casefold()


def select_reports(reports, target_year, as_of, limit=5):
    valid, seen, identities = [], set(), {}
    for order, raw in enumerate(reports):
        if not isinstance(raw, dict):
            continue
        r = copy.deepcopy(raw)
        value, published = number(r.get("profitYi")), day(r.get("publishedAt"))
        ident = str(r.get("id") or "")
        signature = (value, r.get("currency"), r.get("forecastYear"))
        if ident:
            if ident in identities and identities[ident] != signature:
                raise ValueError("Conflicting forecast amounts/currencies/years share one report identity")
            identities[ident] = signature
        if value is None or r.get("forecastYear") != target_year or not published or published > as_of or r.get("currency") not in CURRENCIES or not r.get("broker") or not str(r.get("url") or "").startswith("https://"):
            continue
        if not ident or ident in seen:
            continue
        seen.add(ident)
        r.update(profitYi=value, publishedAt=published)
        r.setdefault("sourceOrder", order)
        valid.append(r)
    valid.sort(key=lambda r: (-dt.date.fromisoformat(r["publishedAt"]).toordinal(), r["sourceOrder"], r["id"]))
    unique, brokers = [], set()
    for r in valid:
        key = broker_key(r)
        if key not in brokers:
            brokers.add(key)
            unique.append(r)
    currencies = {r["currency"] for r in unique}
    if len(currencies) > 1:
        raise ValueError("Mixed forecast currencies cannot be averaged")
    return unique[:limit]


def parse_ah_map(document):
    if not isinstance(document, dict) or document.get("schemaVersion") != 1 or document.get("complete") is not True:
        raise ValueError("A/H mapping is not a complete verified snapshot")
    pairs, total = document.get("pairs"), document.get("total")
    if not isinstance(pairs, list) or not isinstance(total, int) or isinstance(total, bool) or total < 1 or len(pairs) != total:
        raise ValueError("A/H mapping count is incomplete")
    result = {}
    for p in pairs:
        hk, a = str(p.get("hkCode") or ""), str(p.get("aCode") or "")
        if not re.fullmatch(r"\d{5}", hk) or not re.fullmatch(r"\d{6}", a) or hk in result or p.get("aMarket") != a_market(a):
            raise ValueError("A/H mapping contains invalid/duplicate identities")
        result[hk] = a
    return result


def universe(portfolio, mapping):
    sources, lookup = {}, {}
    for group in portfolio.get("sectors") or []:
        for stock in group.get("stocks") or []:
            market = "HK" if stock.get("mkt") == "HK" else "A"
            code = normalized_code(stock.get("code"), market)
            requested = market + ":" + code
            source_market, source_code = ("A", mapping[code]) if market == "HK" and code in mapping else (market, code)
            if source_market == "A":
                a_market(source_code)
            key = source_market + ":" + source_code
            lookup[requested] = key
            sources[key] = {"market": source_market, "code": source_code}
    return sources, lookup


def fetch_reports(item, year, as_of, fetch=read_url):
    if item["market"] == "A":
        # HTTP 200 may be an empty/intermediate cache response or HTML rather
        # than JSON. Retry semantic failures too; never call them no forecasts.
        url, last = a_url(item["code"]), None
        for attempt in range(3):
            retry_url = url if attempt == 0 else url + "&_=" + str(int(time.time() * 1000))
            raw = fetch(retry_url)
            try:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8-sig")
                payload = json.loads(str(raw).lstrip("\ufeff").strip())
                return parse_a_forecasts(payload, item["code"], year, as_of)
            except (json.JSONDecodeError, ValueError) as exc:
                last = exc
                if attempt < 2:
                    time.sleep(.5 * (attempt + 1))
        raise ValueError("A-share forecast-detail response invalid after 3 attempts: " + str(last)[:180])
    raw = fetch(hk_url(item["code"]))
    # A changed/template/block page must not be misreported as an empty source.
    if not re.search(r"财政年度|財政年度", raw) or not re.search(r"证券商|證券商", raw):
        raise ValueError("HK broker detail table is absent or unreadable")
    return [{**r, "metric": "net_profit"} for r in parse_hk_forecasts(raw, item["code"], year, as_of)]


def content(entry):
    return {k: v for k, v in entry.items() if k not in {"updatedAt", "lastChecked", "error"}}


def summarize(item, reports, year, as_of, checked_at, old=None, error=None):
    selected = select_reports(reports, year, as_of) if error is None else []
    result = {**item, "forecastYear": year, "currency": selected[0]["currency"] if selected else ("CNY" if item["market"] == "A" else None),
              "metric": "parent_net_profit" if item["market"] == "A" else "net_profit", "meanProfitYi": sum(r["profitYi"] for r in selected) / len(selected) if selected else None,
              "reportCount": len(selected), "reports": selected, "status": "ok" if selected else "no_reports", "stale": False,
              "lastChecked": checked_at, "updatedAt": checked_at}
    if error is not None:
        if isinstance(old, dict) and old.get("forecastYear") == year and old.get("metric") == result["metric"] and old.get("market") == item["market"] and old.get("code") == item["code"]:
            try:
                preserved = select_reports(old.get("reports") or [], year, as_of)
            except (TypeError, ValueError):
                preserved = []
            if preserved:
                result.update(currency=preserved[0]["currency"], reports=preserved, reportCount=len(preserved),
                              meanProfitYi=sum(r["profitYi"] for r in preserved) / len(preserved), updatedAt=old.get("updatedAt") or checked_at)
        result.update(status="source_error", stale=True, error=str(error)[:260])
    elif isinstance(old, dict) and content(old) == content(result):
        result["updatedAt"] = old.get("updatedAt") or checked_at
    return result


def build_snapshot(portfolio, ah_document, previous=None, as_of=None, checked_at=None, workers=4, fetch=read_url):
    as_of = day(as_of or dt.datetime.now(BEIJING).date())
    if not as_of:
        raise ValueError("Invalid as-of date")
    year = int(as_of[:4])
    checked_at = checked_at or dt.datetime.now(BEIJING).isoformat(timespec="seconds")
    previous = previous or {}
    sources, lookup = universe(portfolio, parse_ah_map(ah_document))
    old = previous.get("stocks") or {}
    result = {}
    def run(pair):
        key, item = pair
        try:
            reports = fetch_reports(item, year, as_of, fetch)
            value = summarize(item, reports, year, as_of, checked_at, old.get(key))
        except Exception as exc:
            value = summarize(item, [], year, as_of, checked_at, old.get(key), exc)
        return key, value
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(8, int(workers)))) as pool:
        for key, entry in pool.map(run, sources.items()):
            result[key] = entry
    method = {"limit": 5, "selection": "latest_per_broker", "metric": "net_profit_by_source",
              "target": "current_year_forecast_only", "sourcePosture": "public_provider_broker_excerpts_not_independently_verified_pdfs",
              "notes": "最近5家机构各自最新的当年净利润预测，不足5家取全部；A股采用来源所列归母净利润，A/H复用A股研报；纯港股按来源纯利/亏损定义及标示财政年度，更新日不冒称原研报发布日期。EPS及当前股本不用于反推净利润。"}
    meaningful = {"targetYear": year, "method": method, "lookup": lookup,
                  "stocks": {key: content(value) for key, value in sorted(result.items())}}
    before = {"targetYear": previous.get("targetYear"), "method": previous.get("method"), "lookup": previous.get("lookup"),
              "stocks": {key: content(value) for key, value in sorted((previous.get("stocks") or {}).items())}}
    return {"schemaVersion": 1, "targetYear": year, "generatedAt": previous.get("generatedAt", checked_at) if meaningful == before else checked_at,
            "lastChecked": checked_at, "asOf": as_of, "method": method, "lookup": lookup,
            "mappingCheckedAt": ah_document.get("checkedAt"), "stocks": dict(sorted(result.items()))}


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        if default is not None:
            return default
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--portfolio", type=Path, default=ROOT / "portfolio.json")
    parser.add_argument("--ah-map", type=Path, default=ROOT / "data/ah_share_map.json")
    parser.add_argument("--output", type=Path, default=ROOT / "data/broker_profit_forecasts.json")
    parser.add_argument("--as-of", default=dt.datetime.now(BEIJING).date().isoformat())
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    data = build_snapshot(load(args.portfolio), load(args.ah_map), load(args.output, {}), args.as_of, workers=args.workers)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = {status: sum(s["status"] == status for s in data["stocks"].values()) for status in ("ok", "no_reports", "source_error")}
    print(json.dumps({"output": str(args.output), "year": data["targetYear"], "stocks": len(data["stocks"]), **counts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
