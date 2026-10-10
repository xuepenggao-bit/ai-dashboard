#!/usr/bin/env python3
"""Refresh SSE personal A-share account openings without losing good history.

The official table counts securities accounts, not deduplicated investors. Its
MDATE is the date of the entire report; TERM identifies the individual month.
Future months are zero-filled placeholders and must never enter the chart.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "data" / "account_openings.json"
BEIJING = dt.timezone(dt.timedelta(hours=8))
SOURCE_URL = "https://www.sse.com.cn/aboutus/publication/monthly/investor/"
API_URL = "https://query.sse.com.cn/commonQuery.do"
SQL_ID = "COMMON_SSE_TZZ_M_STOCK_ACCT_C"
SCOPE = "上交所个人A股账户新开户数（非去重投资者人数）"
OFFICIAL_SOURCE = "上交所官方月报"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Referer": SOURCE_URL,
}
REPORT_PATTERN = re.compile(r"[0-9]{4}(?:0[1-9]|1[0-2])\Z")
TERM_PATTERN = re.compile(r"([0-9]{4})\.(0[1-9]|1[0-2])\Z")
AMOUNT_PATTERN = re.compile(r"[0-9]+(?:\.[0-9]{1,4})?\Z")
MAX_RESPONSE_BYTES = 2_000_000


def report_month(value):
    if not isinstance(value, str) or not REPORT_PATTERN.fullmatch(value):
        raise ValueError("报表日期必须是YYYYMM格式")
    if int(value[:4]) < 1990:
        raise ValueError("报表年份超出上交所统计范围")
    return value


def decimal_amount(value, official=False):
    """Validate amounts exactly; no binary-float arithmetic or NaN coercion."""
    if isinstance(value, bool) or (official and not isinstance(value, str)):
        raise ValueError("个人A股开户数不是有效的十进制数")
    text = str(value)
    if not AMOUNT_PATTERN.fullmatch(text):
        raise ValueError("个人A股开户数必须是最多四位小数的正数")
    try:
        amount = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError("个人A股开户数无法解析") from exc
    if not amount.is_finite() or amount <= 0 or amount >= Decimal("1000000"):
        raise ValueError("个人A股开户数不在有效正值范围")
    return amount


def decode_response(text):
    """SSE can return an error wrapped in parentheses even with HTTP 200."""
    text = text.strip()
    if text.startswith("(") and text.endswith(")"):
        text = text[1:-1].strip()
    try:
        payload = json.loads(text, parse_float=Decimal)
    except (ValueError, TypeError) as exc:
        raise ValueError("上交所返回非JSON数据") from exc
    if not isinstance(payload, dict):
        raise ValueError("上交所返回的数据不是对象")
    if payload.get("success") in (False, "false", "False") or payload.get("error"):
        raise ValueError("上交所返回接口错误，保留现有数据")
    return payload


def request_report(month=None):
    params = {"sqlId": SQL_ID, "isPagination": "false"}
    if month is not None:
        params["MDATE"] = report_month(month)
    url = API_URL + "?" + urlencode(params)
    error = None
    for attempt in range(2):
        try:
            with urlopen(Request(url, headers=HEADERS), timeout=12) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise ValueError("上交所响应超出允许大小")
            return decode_response(body.decode("utf-8"))
        except Exception as exc:
            error = exc
            if attempt == 0:
                time.sleep(0.4)
    raise RuntimeError("官方月报请求失败: " + str(error)) from error


def parse_report(payload, expected_month=None, current_month=None):
    """Return (report date, complete finalized monthly rows) or reject it all."""
    if not isinstance(payload, dict):
        raise ValueError("官方月报格式错误")
    if payload.get("success") in (False, "false", "False") or payload.get("error"):
        raise ValueError("官方月报接口返回错误")
    if payload.get("actionErrors") or payload.get("fieldErrors"):
        raise ValueError("官方月报接口返回字段错误")
    if payload.get("sqlId") != SQL_ID:
        raise ValueError("官方月报数据表标识不匹配")
    raw_rows = payload.get("result")
    if not isinstance(raw_rows, list) or not raw_rows:
        raise ValueError("官方月报尚未发布或返回空数据")
    if not isinstance(raw_rows[0], dict):
        raise ValueError("官方月报行格式错误")
    date = report_month(raw_rows[0].get("MDATE"))
    if expected_month is not None and date != report_month(expected_month):
        raise ValueError("官方月报日期与请求日期不一致")
    if current_month is not None and date > report_month(current_month):
        raise ValueError("官方月报日期位于未来")
    year, last_month = int(date[:4]), int(date[4:])
    rows, seen = [], set()
    for raw in raw_rows:
        if not isinstance(raw, dict) or report_month(raw.get("MDATE")) != date:
            raise ValueError("同一官方月报出现不一致的数据日期")
        term = raw.get("TERM")
        if term in (f"{year}年合计", "累计总户数"):
            continue
        match = TERM_PATTERN.fullmatch(term) if isinstance(term, str) else None
        if not match:
            raise ValueError("官方月报月份必须是YYYY.MM格式")
        row_year, month = int(match[1]), int(match[2])
        if row_year != year or month in seen:
            raise ValueError("官方月报出现跨年或重复月份")
        seen.add(month)
        # Rows after the report date are unpublished zero-filled placeholders.
        if month > last_month:
            continue
        amount = decimal_amount(raw.get("A_PERSON"), official=True)
        rows.append({"year": year, "month": month, "personalWan": amount,
                     "source": OFFICIAL_SOURCE, "reportMonth": date})
    if {row["month"] for row in rows} != set(range(1, last_month + 1)):
        raise ValueError("官方月报缺少已发布月份，保留现有数据")
    return date, sorted(rows, key=lambda row: row["month"])


def validate_cache(previous):
    if not isinstance(previous, dict) or previous.get("schemaVersion") != 1:
        raise ValueError("现有开户数缓存格式无效")
    records = previous.get("records")
    if not isinstance(records, list):
        raise ValueError("现有开户数缓存缺少records")
    seen = set()
    for row in records:
        if not isinstance(row, dict):
            raise ValueError("现有开户数记录格式无效")
        year, month = row.get("year"), row.get("month")
        if type(year) is not int or year < 1990 or type(month) is not int or not 1 <= month <= 12:
            raise ValueError("现有开户数记录月份无效")
        key = (year, month)
        if key in seen:
            raise ValueError("现有开户数缓存包含重复月份")
        seen.add(key)
        date = report_month(row.get("reportMonth"))
        if date[:4] != str(year) or int(date[4:]) < month:
            raise ValueError("现有开户数记录报表日期无效")
        decimal_amount(row.get("personalWan"))
    if previous.get("latestReportMonth") is not None:
        report_month(previous["latestReportMonth"])


def merge_records(previous, candidates):
    merged = {(row["year"], row["month"]): copy.deepcopy(row) for row in previous}
    changes = {"added": 0, "corrected": 0, "verified": 0, "stale": 0}
    for row in sorted(candidates, key=lambda item: (item["reportMonth"], item["year"], item["month"])):
        key = (row["year"], row["month"])
        old = merged.get(key)
        if old and row["reportMonth"] < old["reportMonth"]:
            changes["stale"] += 1
            continue
        if old is None:
            changes["added"] += 1
        elif decimal_amount(old["personalWan"]) != row["personalWan"]:
            changes["corrected"] += 1
        elif old.get("source") != OFFICIAL_SOURCE or old["reportMonth"] != row["reportMonth"]:
            changes["verified"] += 1
        merged[key] = copy.deepcopy(row)
    return [merged[key] for key in sorted(merged)], changes


def refresh_data(previous, now=None, fetcher=None):
    validate_cache(previous)
    now = now or dt.datetime.now(BEIJING)
    if now.tzinfo is None:
        raise ValueError("检查时间必须带时区")
    now = now.astimezone(BEIJING)
    checked_at = now.isoformat(timespec="seconds")
    current_month = now.strftime("%Y%m")
    prior_december = f"{now.year - 1}12"
    fetcher = fetcher or request_report
    reports, candidates, errors = [], [], []
    for requested in (None, prior_december):
        label = "最新月报" if requested is None else f"{requested[:4]}年12月报"
        try:
            date, rows = parse_report(fetcher(requested), requested, current_month)
            reports.append(date)
            candidates.extend(rows)
        except Exception as exc:
            errors.append(f"{label}: {type(exc).__name__}: {str(exc)[:160]}")
    result = copy.deepcopy(previous)
    result.update({"schemaVersion": 1, "displayYear": now.year, "unit": "万户",
                   "scope": SCOPE, "sourceUrl": SOURCE_URL, "lastCheckedAt": checked_at})
    result["records"], changes = merge_records(previous["records"], candidates)
    known_dates = [row["reportMonth"] for row in result["records"]] + reports
    if previous.get("latestReportMonth"):
        known_dates.append(previous["latestReportMonth"])
    result["latestReportMonth"] = max(known_dates) if known_dates else None
    if reports:
        result["lastSuccessAt"] = checked_at
        details = (f"官方检查完成：新增{changes['added']}个月，校正{changes['corrected']}个月，"
                   f"核验{changes['verified']}个月")
        if changes["stale"]:
            details += f"；已保留{changes['stale']}个月的较新缓存"
        if errors:
            details += "；部分请求失败，未取得的月份保留原数据"
        result["check"] = {"status": "partial" if errors else "ok", "message": details}
    else:
        result["check"] = {"status": "error", "message": "官方检查失败，已保留全部历史数据"}
    if errors:
        result["check"]["errors"] = errors
    return result


def encode_json(payload):
    # Float conversion is only for JSON's numeric type at the final boundary.
    # Four-decimal, bounded values round-trip exactly as Decimal via JSON text.
    def encode_decimal(value):
        if isinstance(value, Decimal):
            return float(value)
        raise TypeError(f"Unsupported JSON type: {type(value).__name__}")
    return json.dumps(payload, ensure_ascii=False, indent=2,
                      allow_nan=False, default=encode_decimal) + "\n"


def refresh(output=OUTPUT, now=None, fetcher=None):
    output = Path(output)
    previous = json.loads(output.read_text(encoding="utf-8"), parse_float=Decimal)
    result = refresh_data(previous, now, fetcher)
    serialized = encode_json(result)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=output.parent,
                                         prefix=".account_openings-", suffix=".tmp", delete=False) as file:
            temporary = Path(file.name)
            file.write(serialized)
        os.replace(temporary, output)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    print(result["check"]["message"])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    try:
        refresh(args.output)
    except (OSError, ValueError, TypeError) as exc:
        print(f"开户数缓存未修改: {exc}")
        return 1
    # A provider outage is recorded in JSON and must still be committed by CI.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
