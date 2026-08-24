#!/usr/bin/env python3
"""Refresh the latest 60 Shanghai/Shenzhen A-share breadth observations.

The official Eastmoney "牛熊风向标" endpoint supplies the latest month.  Older
observations are reconstructed from Eastmoney's per-security daily valuation
table with exactly the same rule: CHANGE_RATE > 0 is an advancer and
CHANGE_RATE < 0 is a decliner.  Beijing Stock Exchange securities are excluded.

Output: data/market_breadth_history.json
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "data" / "market_breadth_history.json"
HISTORY_URL = "https://emdatah5.eastmoney.com/dc/NXFXB/GetUpDownData"
DAILY_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
TARGET_DAYS = 60
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
        if len(date) == 10 and up >= 0 and down >= 0 and up + down > 1000:
            rows[date] = {"date": date, "up": up, "down": down}
    return rows


def _computed_day(day: dt.date) -> dict | None:
    """Compute one day's breadth from Eastmoney's all-security daily table."""
    date = day.isoformat()
    payload = _get_json(
        DAILY_URL,
        params={
            "reportName": "RPT_VALUEANALYSIS_DET",
            "columns": "SECUCODE,SECURITY_NAME_ABBR,CHANGE_RATE",
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

    up = down = flat = 0
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
            change = float(item.get("CHANGE_RATE"))
        except (TypeError, ValueError):
            continue
        if change > 0:
            up += 1
        elif change < 0:
            down += 1
        else:
            flat += 1

    if up + down + flat < 1000:
        return None
    return {"date": date, "up": up, "down": down, "flat": flat}


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
        return {
            str(row["date"]): row
            for row in payload.get("series", [])
            if row.get("date") and row.get("up") is not None and row.get("down") is not None
        }
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


def refresh() -> dict:
    rows = _load_existing()
    try:
        official = _official_month()
        rows.update(official)
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
    earliest = min((dt.date.fromisoformat(d) for d in rows), default=dt.date.today() + dt.timedelta(days=1))
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

    payload = {
        "updatedAt": dt.datetime.now(BEIJING_TZ).isoformat(timespec="minutes"),
        "scope": "沪深 A 股（上海、深圳；不含北京证券交易所）",
        "source": "东方财富牛熊风向标 + 东方财富个股日行情",
        "method": "涨跌家数采用东方财富官方近月序列；更早日期按个股日涨跌幅汇总",
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
