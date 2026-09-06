#!/usr/bin/env python3
"""Refresh the latest 60 Shanghai/Shenzhen A-share breadth observations.

The official Eastmoney "牛熊风向标" endpoint supplies the latest month.  Older
observations are reconstructed from Eastmoney's per-security daily valuation
table with exactly the same rule: CHANGE_RATE > 0 is an advancer and
CHANGE_RATE < 0 is a decliner.  Limit-up/limit-down counts use Eastmoney's
official 15:00 Shanghai/Shenzhen minute point when available and otherwise are
reconstructed from the same daily table with the exchange 5%/10%/20% price
limit rules.  Beijing Stock Exchange securities are excluded.

Output: data/market_breadth_history.json
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import math
import time
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "data" / "market_breadth_history.json"
HISTORY_URL = "https://emdatah5.eastmoney.com/dc/NXFXB/GetUpDownData"
DAILY_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
LIMIT_TREND_URL = "https://push2.eastmoney.com/api/qt/stock/updown/trend/get"
TARGET_DAYS = 60
MIN_HS_SECURITIES = 4000
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://data.eastmoney.com/",
}
BEIJING_TZ = dt.timezone(dt.timedelta(hours=8))
MARKET_CLOSE = dt.time(15, 0)


def _get_json(url: str, *, params: dict, attempts: int = 3) -> dict | list:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = Request(f"{url}?{urlencode(params)}", headers=HEADERS)
            with urlopen(request, timeout=35) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # pragma: no cover - network-dependent retry
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last_error}")


def _official_month() -> dict[str, dict]:
    """Return Eastmoney's own recent breadth series (normally 21 sessions)."""
    payload = _get_json(HISTORY_URL, params={"type": 1})
    rows: dict[str, dict] = {}
    if not isinstance(payload, list):
        return rows
    for item in payload:
        date = str(item.get("time") or "")[:10]
        try:
            up = int(item.get("up"))
            down = int(item.get("down"))
        except (TypeError, ValueError):
            continue
        if len(date) == 10 and up >= 0 and down >= 0 and up + down >= MIN_HS_SECURITIES:
            rows[date] = {"date": date, "up": up, "down": down}
    return rows


def _is_hs_code(code: str) -> bool:
    """Return whether *code* belongs to the Shanghai/Shenzhen A-share universe."""
    return len(code) == 6 and code.isdigit() and code[0] in "036"


def _is_limit_close(code: str, name: str, close: float, change: float, direction: int) -> bool:
    """Return whether a Shanghai/Shenzhen stock closed at its price limit.

    Eastmoney exposes high-precision daily change rates but not the prior close
    in this table.  Reconstruct the prior close, round it to the one-cent tick,
    then compare the published close with the exchange limit price.  This also
    handles low-priced stocks whose displayed move can differ noticeably from
    exactly 5%, 10% or 20% because of tick rounding.
    """
    if not _is_hs_code(code) or direction not in (-1, 1):
        return False
    upper_name = str(name or "").strip().upper()
    if upper_name.startswith(("N", "C")):
        return False
    # Registration-based boards retain a 20% band even for risk-warning names;
    # main-board ST names use 5%, and other main-board stocks use 10%.
    if code.startswith(("30", "68")):
        limit_rate = Decimal("0.20")
    elif "ST" in upper_name:
        limit_rate = Decimal("0.05")
    else:
        limit_rate = Decimal("0.10")
    try:
        close_price = Decimal(str(close)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        change_rate = Decimal(str(change)) / Decimal("100")
        denominator = Decimal("1") + change_rate
        if close_price <= 0 or denominator <= 0:
            return False
        previous_close = (close_price / denominator).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        limit_price = (
            previous_close * (Decimal("1") + Decimal(direction) * limit_rate)
        ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError, ValueError):
        return False
    return close_price == limit_price


def _nonnegative_int(value) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0 or not number.is_integer():
        return None
    return int(number)


def _normalize_existing_row(raw: dict) -> dict | None:
    """Validate persisted data so a damaged JSON value cannot become sticky."""
    if not isinstance(raw, dict):
        return None
    date = str(raw.get("date") or "")
    try:
        if dt.date.fromisoformat(date).isoformat() != date:
            return None
    except ValueError:
        return None
    up = _nonnegative_int(raw.get("up"))
    down = _nonnegative_int(raw.get("down"))
    flat = _nonnegative_int(raw.get("flat", 0))
    if up is None or down is None or flat is None or up + down + flat < MIN_HS_SECURITIES:
        return None
    row = {**raw, "date": date, "up": up, "down": down, "flat": flat}
    limit_up = _nonnegative_int(raw.get("limitUp"))
    limit_down = _nonnegative_int(raw.get("limitDown"))
    if limit_up is None or limit_down is None or limit_up > up or limit_down > down:
        row.pop("limitUp", None)
        row.pop("limitDown", None)
        row.pop("limitSource", None)
        row.pop("limitAsOf", None)
    else:
        row["limitUp"] = limit_up
        row["limitDown"] = limit_down
    return row


def _official_intraday_limit_counts(day: dt.date) -> dict | None:
    """Return the official Shanghai/Shenzhen closing minute point for *day*."""
    payload = _get_json(
        LIMIT_TREND_URL,
        params={
            "time": 930,
            "secids": "0.399002,1.000002",
            "ut": "3fdae003f2fa8ed9a849bb70c93587d5",
            "fields": "f1,f2,f3,f4,f5",
        },
    )
    trends = (payload.get("data") or {}).get("trends") if isinstance(payload, dict) else None
    if not isinstance(trends, list) or not trends:
        return None
    parts = str(trends[-1]).split(",")
    if len(parts) < 3:
        return None
    source_time = parts[0]
    if not source_time.startswith(day.isoformat() + " "):
        return None
    try:
        source_dt = dt.datetime.fromisoformat(source_time)
    except ValueError:
        return None
    # Historical JSON is a daily close series.  Never persist a 10:xx/14:xx
    # partial observation; the web page overlays that value only in memory.
    if source_dt.time() < MARKET_CLOSE:
        return None
    try:
        limit_up = int(float(parts[1]))
        limit_down = int(float(parts[2]))
    except (TypeError, ValueError):
        return None
    if limit_up < 0 or limit_down < 0:
        return None
    return {
        "limitUp": limit_up,
        "limitDown": limit_down,
        "limitSource": "eastmoney_hs_minute_close",
        "limitAsOf": source_time,
    }


def _computed_day(day: dt.date) -> dict | None:
    """Compute one day's breadth from Eastmoney's all-security daily table."""
    date = day.isoformat()
    payload = _get_json(
        DAILY_URL,
        params={
            "reportName": "RPT_VALUEANALYSIS_DET",
            "columns": "SECUCODE,SECURITY_NAME_ABBR,CLOSE_PRICE,CHANGE_RATE",
            "pageNumber": 1,
            "pageSize": 6000,
            "sortColumns": "SECURITY_CODE",
            "sortTypes": 1,
            "source": "WEB",
            "client": "WEB",
            "filter": f"(TRADE_DATE='{date}')",
        },
    )
    data = (payload.get("result") or {}).get("data") if isinstance(payload, dict) else None
    if not data or len(data) < 1000:
        return None

    up = down = flat = limit_up = limit_down = 0
    for item in data:
        secucode = str(item.get("SECUCODE") or "")
        # 沪深 A 股；排除北交所、B 股及没有正常股票代码的历史证券。
        if not (secucode.endswith(".SH") or secucode.endswith(".SZ")):
            continue
        code = secucode.split(".", 1)[0]
        if not (len(code) == 6 and code.isdigit()):
            continue
        name = str(item.get("SECURITY_NAME_ABBR") or "")
        if name.startswith(("退市", "已退")):
            continue
        try:
            close = float(item.get("CLOSE_PRICE"))
            change = float(item.get("CHANGE_RATE"))
        except (TypeError, ValueError):
            continue
        if change > 0:
            up += 1
        elif change < 0:
            down += 1
        else:
            flat += 1
        if _is_limit_close(code, name, close, change, 1):
            limit_up += 1
        elif _is_limit_close(code, name, close, change, -1):
            limit_down += 1

    # A complete contemporary Shanghai/Shenzhen universe has well above 4,000
    # rows.  Reject a silently truncated page instead of persisting plausible
    # but materially understated counts.
    if up + down + flat < MIN_HS_SECURITIES:
        return None
    return {
        "date": date,
        "up": up,
        "down": down,
        "flat": flat,
        "limitUp": limit_up,
        "limitDown": limit_down,
        "limitSource": "eastmoney_daily_limit_rule_total",
    }


def _candidate_weekdays(before: dt.date, limit: int = 100) -> list[dt.date]:
    result: list[dt.date] = []
    cursor = before - dt.timedelta(days=1)
    while len(result) < limit:
        if cursor.weekday() < 5:
            result.append(cursor)
        cursor -= dt.timedelta(days=1)
    return result


def _load_existing() -> dict[str, dict]:
    try:
        payload = json.loads(OUTPUT.read_text(encoding="utf-8"))
        rows: dict[str, dict] = {}
        for raw in payload.get("series", []):
            row = _normalize_existing_row(raw)
            if row:
                rows[row["date"]] = row
        return rows
    except (OSError, ValueError, TypeError):
        return {}


def _recent_missing_days(rows: dict[str, dict], now: dt.datetime | None = None) -> list[dt.date]:
    """Return missing weekdays after the latest row, including today after 15:00."""
    now = now or dt.datetime.now(BEIJING_TZ)
    if now.tzinfo is None:
        now = now.replace(tzinfo=BEIJING_TZ)
    now = now.astimezone(BEIJING_TZ)
    end = now.date()
    if now.time() < MARKET_CLOSE:
        end -= dt.timedelta(days=1)

    latest = max((dt.date.fromisoformat(day) for day in rows), default=end - dt.timedelta(days=14))
    cursor = latest + dt.timedelta(days=1)
    missing: list[dt.date] = []
    while cursor <= end:
        if cursor.weekday() < 5:
            missing.append(cursor)
        cursor += dt.timedelta(days=1)
    return missing


def _collect_computed_days(rows: dict[str, dict], days: list[dt.date], label: str) -> None:
    if not days:
        return
    print(f"{label}: checking {len(days)} candidate day(s)")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(_computed_day, day): day for day in days}
        for future in concurrent.futures.as_completed(futures):
            day = futures[future]
            try:
                row = future.result()
            except Exception as exc:
                print(f"  {day}: failed ({exc})")
                continue
            if row:
                rows[row["date"]] = row
                print(f"  {row['date']}: up={row['up']} down={row['down']} flat={row.get('flat', 0)}")


def _merge_official_rows(rows: dict[str, dict], official: dict[str, dict]) -> None:
    """Merge official breadth without erasing already persisted limit counts."""
    for date, row in official.items():
        rows[date] = {**rows.get(date, {}), **row}


def _enrich_limit_row(row: dict, today: dt.date) -> dict:
    day = dt.date.fromisoformat(str(row["date"]))
    has_counts = row.get("limitUp") is not None and row.get("limitDown") is not None
    source = row.get("limitSource")
    if has_counts and day < today and source in {
        "eastmoney_daily_limit_rule_total", "eastmoney_hs_minute_close"
    }:
        return row
    if day == today:
        try:
            intraday = _official_intraday_limit_counts(day)
            if intraday:
                return {**row, **intraday}
        except Exception as exc:  # pragma: no cover - network-dependent fallback
            print(f"  {day}: closing minute failed ({exc}); using daily reconstruction")
    computed = _computed_day(day)
    if not computed:
        return row
    return {
        **row,
        "limitUp": computed["limitUp"],
        "limitDown": computed["limitDown"],
        "limitSource": computed["limitSource"],
    }


def _collect_limit_counts(rows: list[dict], today: dt.date) -> list[dict]:
    candidates = []
    for row in rows:
        day = dt.date.fromisoformat(str(row["date"]))
        missing = row.get("limitUp") is None or row.get("limitDown") is None
        legacy_or_mixed_scope = row.get("limitSource") not in {
            "eastmoney_daily_limit_rule_total", "eastmoney_hs_minute_close"
        }
        today_not_closing_minute = day == today and row.get("limitSource") != "eastmoney_hs_minute_close"
        if missing or legacy_or_mixed_scope or today_not_closing_minute:
            candidates.append(row)
    if not candidates:
        return rows
    print(f"Limit-up/down enrichment: checking {len(candidates)} session(s)")
    by_date = {str(row["date"]): row for row in rows}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(_enrich_limit_row, row, today): str(row["date"]) for row in candidates}
        for future in concurrent.futures.as_completed(futures):
            date = futures[future]
            try:
                enriched = future.result()
            except Exception as exc:
                print(f"  {date}: limit enrichment failed ({exc})")
                continue
            by_date[date] = enriched
            if enriched.get("limitUp") is not None and enriched.get("limitDown") is not None:
                print(
                    f"  {date}: limit-up={enriched['limitUp']} "
                    f"limit-down={enriched['limitDown']} ({enriched.get('limitSource', 'unknown')})"
                )
    return [by_date[str(row["date"])] for row in rows]


def refresh() -> dict:
    now = dt.datetime.now(BEIJING_TZ)
    rows = _load_existing()
    try:
        official = _official_month()
        # A manual/workflow run before 15:00 must not turn an intraday aggregate
        # into a permanent daily observation.
        if now.time() < MARKET_CLOSE:
            official.pop(now.date().isoformat(), None)
        _merge_official_rows(rows, official)
        print(f"Eastmoney official breadth: {len(official)} sessions")
    except Exception as exc:
        official = {}
        print(f"Eastmoney official breadth unavailable: {exc}")

    # Eastmoney's official monthly series can lag the closing bell. After
    # 15:00 Beijing time, compute any missing recent session directly from the
    # complete Shanghai/Shenzhen per-security daily table instead of waiting
    # for the official aggregate to publish later.
    _collect_computed_days(rows, _recent_missing_days(rows), "Recent close")

    # The official endpoint is intentionally capped at one month.  On first
    # run, backfill only the missing older sessions from the daily stock table.
    earliest = min((dt.date.fromisoformat(d) for d in rows), default=now.date() + dt.timedelta(days=1))
    candidates = _candidate_weekdays(earliest, limit=100)
    need = max(0, TARGET_DAYS - len(rows))

    index = 0
    while need > 0 and index < len(candidates):
        batch = candidates[index:index + 8]
        index += len(batch)
        _collect_computed_days(rows, batch, "Historical backfill")
        need = max(0, TARGET_DAYS - len(rows))

    ordered = [rows[key] for key in sorted(rows)][-TARGET_DAYS:]
    if len(ordered) < TARGET_DAYS:
        raise RuntimeError(f"only {len(ordered)} valid trading sessions collected")

    ordered = _collect_limit_counts(ordered, now.date())
    invalid_limits = []
    for row in ordered:
        limit_up = _nonnegative_int(row.get("limitUp"))
        limit_down = _nonnegative_int(row.get("limitDown"))
        if (
            limit_up is None
            or limit_down is None
            or limit_up > int(row["up"])
            or limit_down > int(row["down"])
        ):
            invalid_limits.append(row["date"])
            continue
        row["limitUp"] = limit_up
        row["limitDown"] = limit_down
    if invalid_limits:
        raise RuntimeError(
            f"invalid limit-up/down data for {len(invalid_limits)} sessions: {invalid_limits[:3]}"
        )

    payload = {
        "updatedAt": dt.datetime.now(BEIJING_TZ).isoformat(timespec="minutes"),
        "scope": "沪深 A 股（上海、深圳；不含北京证券交易所）",
        "source": "东方财富牛熊风向标 + 东方财富沪深涨跌停分钟序列 + 东方财富个股日行情",
        "method": "涨跌家数采用官方近月序列；涨跌停统一为全部沪深A股口径，收盘日优先采用官方15:00分钟点，其余历史按个股收盘价及交易所5%/10%/20%限价规则重建（排除N/C新股及退市旧证券）",
        "series": ordered,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


if __name__ == "__main__":
    result = refresh()
    first = result["series"][0]
    last = result["series"][-1]
    print(
        f"saved {len(result['series'])} sessions: {first['date']} to {last['date']} "
        f"(latest up={last['up']} down={last['down']})"
    )
