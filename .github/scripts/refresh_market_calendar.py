#!/usr/bin/env python3
"""Refresh exchange holidays, never infer trading days from government workdays.

Only complete annual schedules from SSE and HKEX are promoted to verified years.
An unavailable or incomplete source cannot erase a previously verified calendar.
"""
from __future__ import annotations

import argparse
import copy
from datetime import date, datetime, timedelta, timezone
from html import unescape
import json
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

SSE_URL = "https://www.sse.com.cn/disclosure/dealinstruc/closed/"
HKEX_BASE = "https://www.hkex.com.hk/News/HKEX-Calendar"
CN = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parents[2]
USER_AGENT = "Mozilla/5.0 (compatible; AShareDashboardCalendar/1.0)"


def text(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", value))).strip()


def fetch(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with urlopen(request, timeout=25) as response:
        if response.status != 200:
            raise ValueError(f"HTTP {response.status}")
        raw = response.read(8_000_001)
        if len(raw) > 8_000_000:
            raise ValueError("official calendar response too large")
        return raw.decode("utf-8-sig")


def valid_year(record: dict, year: int, market: str) -> bool:
    if not isinstance(record, dict) or record.get("verified") is not True:
        return False
    holidays = record.get("holidays")
    half_days = record.get("halfDays")
    if not isinstance(holidays, list) or not isinstance(half_days, list):
        return False
    if holidays != sorted(set(holidays)) or not 10 <= len(holidays) <= 30:
        return False
    try:
        if any(date.fromisoformat(day).year != year or date.fromisoformat(day).weekday() > 4 for day in holidays):
            return False
        half_dates = [item["date"] for item in half_days]
        if half_dates != sorted(set(half_dates)) or len(half_dates) > 3:
            return False
        if any(date.fromisoformat(item["date"]).year != year or
               date.fromisoformat(item["date"]).weekday() > 4 or
               item["date"] in holidays or item["closeMinute"] != 730 for item in half_days):
            return False
    except (ValueError, TypeError, KeyError):
        return False
    source = record.get("sourceUrl", "")
    allowed = "https://www.sse.com.cn/" if market == "A" else "https://www.hkex.com.hk/"
    return source.startswith(allowed) and (market != "A" or not half_days)


def parse_sse(html: str, source_url: str = SSE_URL) -> tuple[int, dict]:
    # Restrict parsing to the annual table, not a partial notice or Stock Connect.
    match = re.search(r"(?:<strong[^>]*>\s*)?(20\d{2})年休市安排(?:\s*</strong>)?.*?(<table\b.*?</table>)", html, re.S)
    if not match:
        raise ValueError("SSE complete annual holiday table unavailable")
    year = int(match[1])
    rows = re.findall(r"<tr\b[^>]*>(.*?)</tr>", match[2], re.S)
    expected = {"元旦", "春节", "清明节", "劳动节", "端午节", "中秋节", "国庆节"}
    labels, holidays = set(), set()
    for row in rows:
        cells = re.findall(r"<td\b[^>]*>(.*?)</td>", row, re.S)
        if len(cells) != 2:
            raise ValueError("SSE annual table row changed")
        label = text(cells[0]).rstrip("：:")
        if label not in expected or label in labels:
            raise ValueError("SSE holiday labels changed or duplicated")
        labels.add(label)
        # Only the initial exchange holiday clause. The later make-up workdays
        # are still weekend closures and MUST NOT be converted into trading days.
        clause = text(cells[1]).split("休市", 1)[0]
        clean = re.sub(r"[（(][^）)]*[）)]", "", clause).strip()
        period = re.fullmatch(r"(\d{1,2})月(\d{1,2})日(?:至(?:(\d{1,2})月)?(\d{1,2})日)?", clean)
        if not period:
            raise ValueError(f"SSE holiday period changed: {clean}")
        start = date(year, int(period[1]), int(period[2]))
        end = date(year, int(period[3] or period[1]), int(period[4] or period[2]))
        if end < start or (end - start).days > 15:
            raise ValueError("SSE holiday interval invalid")
        day = start
        while day <= end:
            if day.weekday() < 5:
                holidays.add(day.isoformat())
            day += timedelta(days=1)
    if labels != expected:
        raise ValueError("SSE annual holiday table incomplete")
    record = {"verified": True, "sourceUrl": source_url,
              "holidays": sorted(holidays), "halfDays": []}
    if not valid_year(record, year, "A"):
        raise ValueError("SSE annual schedule failed validation")
    return year, record


def hkex_url(year: int) -> str:
    # HKEX's defaultDate shifts the two-year loaded range. December of the
    # requested year provides Jan-Dec coverage; query-only datefrom does not.
    return HKEX_BASE + f"?sc_lang=en&defaultDate={year}-12-01&currenttab=all-agenda&order=asc&currentCount=2000"


def parse_hkex(html: str, year: int, source_url: str | None = None) -> dict:
    source_url = source_url or hkex_url(year)
    match = re.search(r"var\s+calendarDataSource\s*=\s*'((?:[^'\\]|\\.)*)'\s*;", html, re.S)
    ranges = re.search(r"var\s+calendarDataSourceRanage\s*=\s*\[(.*?)\];", html, re.S)
    if not match or not ranges:
        raise ValueError("HKEX structured official calendar unavailable")
    # Extract JSON only. Never evaluate executable JavaScript from a webpage.
    raw = match[1].replace("\\'", "'")
    payload = json.loads(raw)
    boundaries = re.findall(r"new Date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*,", ranges[1])
    if len(boundaries) != 2:
        raise ValueError("HKEX calendar coverage unavailable")
    start, end = [date(int(y), int(m) + 1, int(d)) for y, m, d in boundaries]
    if start > date(year, 1, 1) or end < date(year, 12, 31):
        raise ValueError(f"HKEX calendar does not cover all of {year}")
    rows = payload.get("monthly")
    if not isinstance(rows, list) or not rows:
        raise ValueError("HKEX calendar events missing")
    holidays, half_days = set(), set()
    for row in rows:
        day = row.get("startdate", "")
        if not day.startswith(str(year) + "-"):
            continue
        parsed = date.fromisoformat(day)
        if row.get("enddate") != day:
            # Every accepted cash-market event must be an unambiguous day.
            if row.get("holidayIcon") == "HongKongPublicHolidays":
                raise ValueError("HKEX holiday range changed")
            continue
        description = text(row.get("description", "")).lower()
        name = text(row.get("name", ""))
        if row.get("holidayIcon") == "HongKongPublicHolidays" and description == "hong kong market is closed":
            if parsed.weekday() < 5:
                holidays.add(day)
        elif row.get("activityIcon") == "SecuritiesandDerivatives" and re.fullmatch(
                r"Half-Day Trading Day - Afternoon Session is Closed on .+ Eve", name, re.I):
            if parsed.weekday() < 5:
                half_days.add(day)
    record = {"verified": True, "sourceUrl": source_url,
              "holidays": sorted(holidays),
              "halfDays": [{"date": day, "closeMinute": 730} for day in sorted(half_days)]}
    if not valid_year(record, year, "HK"):
        raise ValueError("HKEX complete annual schedule failed validation")
    # Annual Jan 1 and Christmas-season closures are useful completeness checks;
    # they must come from HKEX events, never filled by a government-calendar rule.
    if not any(day.endswith("-01-01") for day in holidays) and date(year, 1, 1).weekday() < 5:
        raise ValueError("HKEX January closure missing")
    if not any(day.startswith(f"{year}-12-") for day in holidays):
        raise ValueError("HKEX Christmas closure missing")
    return record


def refresh(existing: dict, year: int, loader=fetch) -> tuple[dict, list[str]]:
    result = copy.deepcopy(existing)
    if result.get("schemaVersion") != 1 or not isinstance(result.get("markets"), dict):
        raise ValueError("verified calendar seed required")
    errors = []
    staged = []
    try:
        sse_year, record = parse_sse(loader(SSE_URL))
        if not year - 1 <= sse_year <= year + 1:
            raise ValueError("SSE annual schedule year stale or implausible")
        staged.append(("A", sse_year, record))
    except Exception as exc:
        errors.append("A: " + str(exc))
    for hk_year in [year, year + 1]:
        try:
            staged.append(("HK", hk_year, parse_hkex(loader(hkex_url(hk_year)), hk_year)))
        except Exception as exc:
            errors.append(f"HK {hk_year}: {exc}")
    for market, target, record in staged:
        target_years = result["markets"].setdefault(market, {"label": "沪深A股" if market == "A" else "香港股票", "years": {}}).setdefault("years", {})
        previous = target_years.get(str(target))
        if previous and previous.get("verified") and not valid_year(previous, target, market):
            raise ValueError(f"existing {market} {target} record malformed")
        # Preserve original documentary provenance alongside the fresh HTML.
        sources = set(previous.get("sourceUrls", [])) if previous else set()
        if previous and previous.get("sourceUrl"):
            sources.add(previous["sourceUrl"])
        sources.add(record["sourceUrl"])
        record["sourceUrls"] = sorted(sources)
        target_years[str(target)] = record
    # No false success timestamp if both sources fail. Existing bytes stay valid.
    if staged:
        result["updatedAt"] = datetime.now(CN).isoformat(timespec="seconds")
    return result, errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "data/market_sessions.json")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--year", type=int, default=datetime.now(CN).year)
    parser.add_argument("--sse-html", type=Path)
    parser.add_argument("--hkex-html", type=Path)
    parser.add_argument("--hkex-next-html", type=Path)
    args = parser.parse_args()
    existing = json.loads(args.input.read_text(encoding="utf-8"))
    def loader(url):
        override = args.sse_html if url == SSE_URL else (args.hkex_html if f"defaultDate={args.year}-" in url else args.hkex_next_html)
        return override.read_text(encoding="utf-8") if override else fetch(url)
    result, errors = refresh(existing, args.year, loader)
    for error in errors:
        print("Preserved verified schedule; source not promoted: " + error, file=sys.stderr)
    for market in ["A", "HK"]:
        if not valid_year(result["markets"].get(market, {}).get("years", {}).get(str(args.year), {}), args.year, market):
            raise ValueError(f"current-year {market} verified schedule missing")
    if result != existing:
        output = args.output or args.input
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Verified calendar years: " + "; ".join(m + " " + ",".join(sorted(result["markets"][m]["years"])) for m in ["A", "HK"]))
    # A complete current-year seed remains operational if the website is down.
    # Warnings are actionable in logs; do not overwrite a year with guesses.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
