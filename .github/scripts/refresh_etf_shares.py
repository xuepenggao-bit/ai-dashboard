#!/usr/bin/env python3
"""Daily disclosed ETF share counts. Price changes are never treated as flows."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone, timedelta
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SSE_PAGE = "https://www.sse.com.cn/market/funddata/volumn/etfvolumn/"
SSE_QUERY = "https://query.sse.com.cn/commonQuery.do"
NAV_API = "https://api.fund.eastmoney.com/f10/lsjz"
CALENDAR_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,240,qfq"
FUNDS = [
    {"code": "510300", "index": "沪深300", "label": "华泰柏瑞沪深300ETF"},
    {"code": "510500", "index": "中证500", "label": "南方中证500ETF"},
    {"code": "512100", "index": "中证1000", "label": "南方中证1000ETF"},
]
MIN_POINTS = 2
WINDOW = 61  # One baseline plus sixty daily changes.
SPLIT_THRESHOLD = Decimal("0.30")
CN_TZ = timezone(timedelta(hours=8))


def iso_date(value):
    if not isinstance(value, str):
        return None
    s = value.strip()
    if re.fullmatch(r"\d{8}", s):
        s = f"{s[:4]}-{s[4:6]}-{s[6:]}"
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return None
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        return None


def decimal_number(value):
    if isinstance(value, bool) or value is None:
        return None
    text = str(value).strip().replace(",", "").replace("￥", "").replace("¥", "")
    if text in ("", "-", "--", "null", "None"):
        return None
    try:
        result = Decimal(text)
    except InvalidOperation:
        return None
    return result if result.is_finite() else None


def shares_from_wan(value):
    number = decimal_number(value)
    if number is None or number <= 0 or number > Decimal("1e10"):
        return None
    raw = number * 10000
    # The exchange's rounding of its 万份 field gives an integer number of shares.
    if raw != raw.to_integral_value():
        return None
    return int(raw)


def request_json(url, referer=SSE_PAGE):
    last = None
    for attempt in range(3):
        try:
            request = Request(url, headers={
                "User-Agent": "Mozilla/5.0 ETF-disclosure-monitor/1.0",
                "Accept": "application/json, text/plain, */*", "Referer": referer,
            })
            with urlopen(request, timeout=25) as response:
                text = response.read(8 * 1024 * 1024).decode("utf-8")
            # SSE can serve JSONP; its data is still treated only as data.
            if not text.lstrip().startswith(("{", "[")):
                match = re.fullmatch(r"\s*[\w.]+\((.*)\);?\s*", text, re.S)
                if not match:
                    raise ValueError("not JSON or JSONP")
                text = match.group(1)
            payload = json.loads(text)
            if not isinstance(payload, dict):
                raise ValueError("unexpected response type")
            if payload.get("actionErrors"):
                raise ValueError("exchange returned actionErrors")
            return payload
        except Exception as exc:
            last = exc
            if attempt < 2:
                time.sleep(0.7 * (attempt + 1))
    raise RuntimeError(f"request failed: {url.split('?')[0]}: {last}")


def sse_json(sql_id, **params):
    return request_json(SSE_QUERY + "?" + urlencode({
        "sqlId": sql_id, "isPagination": "false", **params,
    }))


def parse_share_rows(payload, requested_date=None):
    rows = payload.get("result")
    if not isinstance(rows, list):
        raise ValueError("SSE shares: result is not a list")
    codes = {fund["code"] for fund in FUNDS}
    result = {}
    for row in rows:
        code = str(row.get("SEC_CODE", ""))
        if code not in codes:
            continue
        day = iso_date(row.get("STAT_DATE"))
        shares = shares_from_wan(row.get("TOT_VOL"))
        if not day or shares is None or (requested_date and day != requested_date):
            raise ValueError(f"invalid exchange shares for {code}/{requested_date}")
        item = {"date": day, "shares": shares, "status": "reported"}
        if code in result and result[code] != item:
            raise ValueError(f"conflicting share observations for {code}")
        result[code] = item
    return result


def fetch_shares(day=""):
    return parse_share_rows(sse_json(
        "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L", STAT_DATE=day,
    ), day or None)


def fetch_calendar():
    payload = request_json(CALENDAR_URL, "https://gu.qq.com/")
    data = (payload.get("data") or {}).get("sh000001") or {}
    rows = data.get("day") or data.get("qfqday")
    if not isinstance(rows, list):
        raise ValueError("no trading-calendar observations")
    days = sorted({day for row in rows if isinstance(row, list) and row
                   if (day := iso_date(row[0]))})
    days = [day for day in days if day <= datetime.now(CN_TZ).date().isoformat()]
    if len(days) < WINDOW:
        raise ValueError("trading calendar too short")
    return days


def parse_nav_rows(payload, start, end):
    if payload.get("ErrCode") not in (None, 0):
        raise ValueError("NAV provider error")
    rows = (payload.get("Data") or {}).get("LSJZList")
    if not isinstance(rows, list):
        raise ValueError("NAV disclosure: no LSJZList")
    result = {}
    for row in rows:
        day = iso_date(row.get("FSRQ"))
        nav = decimal_number(row.get("DWJZ"))  # Unit NAV, never LJJZ or trading price.
        if day and start <= day <= end and nav is not None and 0 < nav < 1000:
            result[day] = {"nav": float(nav), "navDate": day,
                           "navSource": "天天基金/东方财富：基金披露单位净值DWJZ"}
    return result


def parse_pcf_nav(payload, code):
    result = {}
    for row in payload.get("result") or []:
        if str(row.get("TRADE_CODE", "")) != code:
            continue
        day = iso_date(row.get("PRE_TRADING_DAY"))
        publication = iso_date(row.get("TRADING_DAY"))
        nav = decimal_number(row.get("NAV"))
        if day and publication and day < publication and nav is not None and 0 < nav < 1000:
            result[day] = {"nav": float(nav), "navDate": day,
                           "navSource": "上交所申赎清单：PRE_TRADING_DAY所属单位净值"}
    return result


def fetch_nav(code, start, end):
    result, warnings = {}, []
    try:
        seen_dates = set()
        # The public service can cap pageSize at twenty even when requesting 100.
        for page in range(1, 7):
            payload = request_json(NAV_API + "?" + urlencode({
                "fundCode": code, "pageIndex": page, "pageSize": 100,
                "startDate": start, "endDate": end,
            }), f"https://fundf10.eastmoney.com/jjjz_{code}.html")
            parsed = parse_nav_rows(payload, start, end)
            result.update(parsed)
            rows = (payload.get("Data") or {}).get("LSJZList") or []
            dates = {day for row in rows if (day := iso_date(row.get("FSRQ")))}
            if not dates or not (dates - seen_dates):
                break
            seen_dates.update(dates)
            if min(dates) <= start:
                break
            total = decimal_number(payload.get("TotalCount"))
            if total is not None and len(seen_dates) >= total:
                break
    except Exception as exc:
        warnings.append(f"{code}历史单位净值暂不可用：{exc}")
    try:
        official = parse_pcf_nav(sse_json(
            "COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C", FUNDID2=code,
        ), code)
        for day, item in official.items():
            if day in result and abs(result[day]["nav"] - item["nav"]) > 0.0002:
                warnings.append(f"{code}/{day}净值源不一致，采用上交所官方净值")
            result[day] = item
    except Exception as exc:
        warnings.append(f"{code}官方最新单位净值暂不可用：{exc}")
    return result, warnings


def check_disclosures(code, start, end):
    payload = sse_json("COMMON_PL_JJXX_JJGG_NEW_L", type="inParams",
        SECURITY_CODE=code, START_DATE=start, END_DATE=end, DATE_DESC="1")
    rows = payload.get("result")
    if not isinstance(rows, list):
        raise ValueError("no official announcement result")
    actions = [{"date": iso_date(row.get("SSEDATE")), "title": row.get("TITLE"),
                "url": "https://www.sse.com.cn" + str(row.get("URL", ""))}
               for row in rows if str(row.get("SECURITY_CODE")) == code
               and re.search(r"拆分|份额折算|份额合并", str(row.get("TITLE", "")))]
    return {"source": "上交所基金公告标题检索", "from": start, "to": end,
            "status": "action_review_required" if actions else "no_action_title_found",
            "checkedAnnouncements": len(rows), "actions": actions,
            "note": "公告标题检索为辅助筛查，不等于已审阅全部公告正文；日份额变化超30%会停止申赎估算。"}


def make_series(observations, navs, calendar, disclosure=None):
    positions = {day: index for index, day in enumerate(calendar)}
    result, previous = [], None
    action_review = bool((disclosure or {}).get("actions"))
    for day in sorted(observations):
        raw = observations[day]
        shares = decimal_number(raw.get("shares"))
        if not iso_date(day) or shares is None or shares <= 0 or shares > Decimal("1e14") or shares != shares.to_integral_value():
            continue
        nav_item = navs.get(day) or {}
        nav = decimal_number(nav_item.get("nav"))
        if nav_item.get("navDate") != day or nav is None or not 0 < nav < 1000:
            nav = None
        item = {"date": day, "shares": int(shares), "sourceUrl": SSE_PAGE,
                "previousDate": previous["date"] if previous else None,
                "deltaShares": None, "changePct": None,
                "nav": float(nav) if nav is not None else None,
                "navDate": day if nav is not None else None,
                "navSource": nav_item.get("navSource") if nav is not None else None,
                "estimatedFlowYuan": None, "status": "reported", "metricStatus": "baseline"}
        if previous:
            consecutive = (day in positions and previous["date"] in positions and
                           positions[day] - positions[previous["date"]] == 1)
            prior_shares = Decimal(previous["shares"])
            delta = shares - prior_shares
            pct = delta / prior_shares
            if not consecutive:
                item["metricStatus"] = "nonconsecutive"
            elif action_review or abs(pct) > SPLIT_THRESHOLD:
                item["metricStatus"] = "split_review"
            else:
                item["metricStatus"] = "daily_change"
                item["deltaShares"] = int(delta)
                item["changePct"] = round(float(pct * 100), 8)
                if nav is not None:
                    item["estimatedFlowYuan"] = round(float(delta * nav), 2)
        result.append(item)
        previous = item
    return result


def valid_cache(payload):
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
        return False
    by_code = {fund.get("code"): fund for fund in payload.get("funds", []) if isinstance(fund, dict)}
    for fund in FUNDS:
        series = by_code.get(fund["code"], {}).get("series", [])
        if not isinstance(series, list):
            return False
        valid = [row for row in series if isinstance(row, dict) and iso_date(row.get("date"))
                 and (shares := decimal_number(row.get("shares"))) is not None
                 and 0 < shares <= Decimal("1e14") and shares == shares.to_integral_value()]
        if len(valid) < MIN_POINTS:
            return False
        if len(valid) != len(series) or len({row["date"] for row in valid}) != len(series):
            return False
    return True


def refresh(old=None, workers=4):
    old = old if valid_cache(old) else {}
    calendar = sorted(set(fetch_calendar()) | {
        day for value in old.get("tradingDates", []) if (day := iso_date(value))
    })
    latest_rows = fetch_shares()
    if set(latest_rows) != {fund["code"] for fund in FUNDS}:
        raise RuntimeError("latest exchange disclosure missing one of the three sample ETFs")
    latest_days = {row["date"] for row in latest_rows.values()}
    if len(latest_days) != 1:
        raise RuntimeError("latest disclosure dates differ across sample ETFs")
    latest = latest_days.pop()
    if latest > datetime.now(CN_TZ).date().isoformat() or latest not in calendar:
        raise RuntimeError("exchange disclosure date is not a known trading day")
    wanted_days = [day for day in calendar if day <= latest][-WINDOW:]
    old_funds = {fund["code"]: fund for fund in old.get("funds", [])}
    observations, navs = {}, {}
    for fund in FUNDS:
        code = fund["code"]
        series = old_funds.get(code, {}).get("series", [])
        if series and max(row["date"] for row in series) > latest:
            raise RuntimeError("exchange source regressed; retain newer cached disclosure")
        observations[code] = {row["date"]: {"shares": row["shares"]} for row in series}
        navs[code] = {row["date"]: {key: row.get(key) for key in ("nav", "navDate", "navSource")}
                      for row in series if row.get("nav") is not None}
        observations[code][latest] = latest_rows[code]
    # Incremental operation: only missing observations plus the prior date for revisions.
    missing = [day for day in wanted_days if day != latest and
               (day == wanted_days[-2] or any(day not in observations[fund["code"]] for fund in FUNDS))]
    failures = []
    with ThreadPoolExecutor(max_workers=min(max(workers, 1), 4)) as pool:
        jobs = {pool.submit(fetch_shares, day): day for day in missing}
        for future in as_completed(jobs):
            day = jobs[future]
            try:
                rows = future.result()
                if set(rows) != {fund["code"] for fund in FUNDS}:
                    raise RuntimeError("incomplete sample disclosure")
                for code, row in rows.items():
                    observations[code][day] = row
            except Exception as exc:
                failures.append(f"{day}: {exc}")
    if failures:
        # Do not publish partial fresh snapshots or manufacture zeros. The file remains untouched.
        raise RuntimeError("daily shares unavailable; preserve cache: " + "; ".join(failures[:4]))
    funds, warnings = [], []
    for fund in FUNDS:
        code = fund["code"]
        missing_nav_days = [day for day in wanted_days if
                            day not in navs[code] or navs[code][day].get("navDate") != day
                            or decimal_number(navs[code][day].get("nav")) is None]
        nav_start = min(missing_nav_days + [latest])
        fetched_navs, nav_warnings = fetch_nav(code, nav_start, latest)
        navs[code].update(fetched_navs)
        warnings.extend(nav_warnings)
        disclosure = check_disclosures(code, wanted_days[0], datetime.now(CN_TZ).date().isoformat())
        series = make_series(observations[code], navs[code], calendar, disclosure)
        if len(series) < MIN_POINTS:
            raise RuntimeError(f"too few official observations for {code}")
        funds.append({**fund, "source": SSE_PAGE,
                      "navSource": "上交所申赎清单最新净值；天天基金/东方财富历史披露净值",
                      "disclosure": disclosure, "series": series})
    return {"schemaVersion": 1, "updatedAt": datetime.now(CN_TZ).isoformat(timespec="seconds"),
            "asOf": latest, "source": "上交所每日清算后ETF总份额；上交所与天天基金已披露单位净值",
            "sourceUrl": SSE_PAGE, "calendarSource": "腾讯上证综指日线交易日期",
            "coverage": "3只代表ETF，非全市场合计", "frequency": "日频，按交易所已披露清算后数据",
            "tradingDates": calendar,
            "methodology": "每日净份额变化=本日总份额−上一连续交易日总份额；申赎估算=每日净份额变化×同日已披露单位净值，包含实物申赎，并非现金净流入或基金规模变化。缺同日净值时不估算金额；缺日或疑似拆份不计算每日变化。",
            "methodologyDetails": {"sharesUnit": "份", "sourceSharesUnit": "万份",
                "delta": "本日总份额减上一连续交易日总份额；缺日或疑似拆份不计算日变化",
                "estimatedFlow": "每日净份额变化×同日已披露单位净值；仅申赎估算，包含实物申赎，不是现金净流入或基金规模变化",
                "navMissing": "缺少同日单位净值时估算金额为null，不使用场内价格或前日净值代替",
                "splitGuard": "官方公告标题检索及单日份额变化绝对值超过30%的异常拦截",
                "window": "首次回填61个份额观察值，可计算60个交易日变化；以后增量累计历史"},
            "warnings": warnings, "funds": funds}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("data/etf_shares.json"))
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    old = None
    if args.output.exists():
        try:
            old = json.loads(args.output.read_text(encoding="utf-8"))
        except Exception:
            pass
    try:
        payload = refresh(old, args.workers)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(args.output)
        print(json.dumps({"asOf": payload["asOf"], "counts": {
            fund["code"]: len(fund["series"]) for fund in payload["funds"]}}, ensure_ascii=False))
    except Exception as exc:
        print(f"ETF shares refresh failed; existing data retained: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
