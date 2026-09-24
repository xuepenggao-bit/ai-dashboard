#!/usr/bin/env python3
"""Maintain real, timestamped index quotes independently of each browser.

The frontend reads this small public JSON and keeps the last good quote when a
provider is unavailable. A failed request never removes a quote or creates zero
prices. All API identifiers below match the dashboard's major-index panel.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import math
import re
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "data" / "major_indices.json"
BEIJING = dt.timezone(dt.timedelta(hours=8))
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://quote.eastmoney.com/",
}
INDICES = [
    {"label": "上证指数", "region": "a", "code": "000001", "secid": "1.000001", "tc": "sh000001"},
    {"label": "深证成指", "region": "a", "code": "399001", "secid": "0.399001", "tc": "sz399001"},
    {"label": "创业板指", "region": "a", "code": "399006", "secid": "0.399006", "tc": "sz399006"},
    {"label": "科创 50", "region": "a", "code": "000688", "secid": "1.000688", "tc": "sh000688"},
    {"label": "中证全指", "region": "a", "code": "000985", "secid": "1.000985", "tc": "sh000985"},
    {"label": "A股平均股价", "region": "a", "code": "800005", "secid": "47.800005"},
    {"label": "恒生指数", "region": "hk", "code": "HSI", "secid": "100.HSI", "tc": "r_hkHSI"},
    {"label": "恒生科技", "region": "hk", "code": "HSTECH", "secid": "124.HSTECH", "tc": "r_hkHSTECH"},
    {"label": "A/H溢价", "region": "ah", "code": "HSAHP", "secid": "100.HSAHP", "altCodes": ["HSCAHPI"]},
    {"label": "韩国KOSPI200", "region": "intl", "code": "KOSPI200", "secid": "100.KOSPI200"},
    {"label": "台湾加权", "region": "intl", "code": "TWII", "secid": "100.TWII"},
    {"label": "A50期指", "region": "fut", "code": "CN00Y", "secid": "104.CN00Y", "altCodes": ["CN00"]},
    {"label": "纳指期指", "region": "fut", "code": "NQ00Y", "secid": "103.NQ00Y", "altCodes": ["NQ00"]},
    {"label": "美国10年期", "region": "rate", "code": "US10Y", "secid": "171.US10Y"},
    {"label": "美元兑人民币", "region": "fx", "code": "USDCNH", "secid": "133.USDCNH"},
]
BY_LABEL = {item["label"]: item for item in INDICES}
PRIORITY = {"tc_rt": 4, "em": 4, "tc": 3, "em_minute": 2, "em_daily": 1}


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def quote_timestamp(value):
    """Provider calendar strings use Beijing time, including overseas indices."""
    text = str(value or "").strip()
    for fmt in ("%Y%m%d%H%M%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return int(dt.datetime.strptime(text, fmt).replace(tzinfo=BEIJING).timestamp() * 1000)
        except ValueError:
            pass
    value = number(value)
    if value is None:
        return 0
    return int(value * 1000 if value < 10_000_000_000 else value)


def matches_code(config, code):
    return str(code).upper() in {str(item).upper() for item in [config["code"], *config.get("altCodes", [])]}


def make_quote(config, price, pct, delta, timestamp, source, now_ms):
    row = {"label": config["label"], "region": config["region"], "price": number(price),
           "pct": number(pct), "delta": number(delta), "quoteTs": quote_timestamp(timestamp),
           "src": source, "ts": now_ms}
    if row["delta"] is None and row["price"] and row["pct"] is not None and row["pct"] > -100:
        row["delta"] = row["price"] - row["price"] / (1 + row["pct"] / 100)
    return row if valid_quote(row, now_ms, max_age_days=14) else None


def valid_quote(row, now_ms, max_age_days=None):
    if not isinstance(row, dict) or row.get("label") not in BY_LABEL:
        return False
    price, pct, timestamp = number(row.get("price")), number(row.get("pct")), number(row.get("quoteTs"))
    if price is None or price <= 0 or pct is None or timestamp is None or timestamp <= 0 or timestamp > now_ms + 300_000:
        return False
    if row.get("region") != BY_LABEL[row["label"]]["region"]:
        return False
    if max_age_days is not None and now_ms - timestamp > max_age_days * 86_400_000:
        return False
    if abs(pct) > (100 if row["region"] == "rate" else 30):
        return False
    limits = {"恒生指数": (5000, 60000), "恒生科技": (500, 30000), "A/H溢价": (50, 400),
              "美国10年期": (0.001, 30), "美元兑人民币": (3, 15)}
    low, high = limits.get(row["label"], (0, float("inf")))
    return low < price < high


def merge_quotes(previous, candidates, now_ms):
    merged = {label: dict(row) for label, row in previous.items()
              if valid_quote(row, now_ms) and label == row["label"]}
    # Process in chronological order; same-time direct quotes beat minute data.
    for row in sorted((row for row in candidates if row), key=lambda row: (row.get("quoteTs", 0), PRIORITY.get(row.get("src"), 0))):
        if not valid_quote(row, now_ms, max_age_days=14):
            continue
        old = merged.get(row["label"])
        if old:
            age = row["quoteTs"] - old["quoteTs"]
            if age < 0 or (age == 0 and PRIORITY.get(row.get("src"), 0) <= PRIORITY.get(old.get("src"), 0)):
                continue
            if row["region"] in ("hk", "ah"):
                same_day = dt.datetime.fromtimestamp(row["quoteTs"] / 1000, BEIJING).date() == dt.datetime.fromtimestamp(old["quoteTs"] / 1000, BEIJING).date()
                if same_day and age <= 300_000 and abs(row["price"] / old["price"] - 1) > 0.04:
                    continue
                if same_day:
                    base = row["price"] / (1 + row["pct"] / 100)
                    old_base = old["price"] / (1 + old["pct"] / 100)
                    if abs(base / old_base - 1) > 0.008:
                        continue
        merged[row["label"]] = dict(row)
    return {item["label"]: merged[item["label"]] for item in INDICES if item["label"] in merged}


def request_text(url, encoding="utf-8"):
    error = None
    for attempt in range(2):
        try:
            with urlopen(Request(url, headers=HEADERS), timeout=9) as response:
                return response.read(5_000_000).decode(encoding, errors="replace")
        except Exception as exc:
            error = exc
            if attempt == 0:
                time.sleep(0.3)
    raise RuntimeError(str(error))


def request_json(host, path, params):
    params = {**params, "_": int(time.time() * 1000)}
    return json.loads(request_text(f"https://{host}{path}?{urlencode(params)}"))


def parse_tencent(text, now_ms):
    result = []
    for config in INDICES:
        if "tc" not in config:
            continue
        match = re.search(r'v_' + re.escape(config["tc"]) + r'="([^"]+)"', text)
        if not match:
            continue
        fields = match[1].split("~")
        if len(fields) < 33 or not matches_code(config, fields[2]):
            continue
        pct = number(fields[32])
        price, previous = number(fields[3]), number(fields[4])
        if pct is None and price is not None and previous and previous > 0:
            pct = (price / previous - 1) * 100
        quote = make_quote(config, price, pct, fields[31], fields[30],
                           "tc_rt" if config["tc"].startswith("r_hk") else "tc", now_ms)
        if quote:
            result.append(quote)
    return result


def fetch_tencent(now_ms):
    codes = ",".join(item["tc"] for item in INDICES if "tc" in item)
    return parse_tencent(request_text(f"https://qt.gtimg.cn/q={codes}&_={now_ms}", "gb18030"), now_ms)


def parse_em_list(payload, now_ms):
    diff = (payload.get("data") or {}).get("diff") or []
    if isinstance(diff, dict):
        diff = list(diff.values())
    rows = []
    for raw in diff:
        for config in INDICES:
            if not matches_code(config, raw.get("f12")):
                continue
            row = make_quote(config, raw.get("f2"), raw.get("f3"), raw.get("f4"),
                             raw.get("f124") or raw.get("f86"), "em", now_ms)
            if row:
                rows.append(row)
    return rows


def fetch_em_list(host, now_ms):
    return parse_em_list(request_json(host, "/api/qt/ulist.np/get", {
        "secids": ",".join(item["secid"] for item in INDICES), "fltt": 2, "invt": 2,
        "fields": "f12,f14,f2,f3,f4,f86,f124",
    }), now_ms)


def parse_em_stock(config, payload, now_ms):
    raw = payload.get("data") or {}
    if not matches_code(config, raw.get("f57")):
        return []
    row = make_quote(config, raw.get("f43"), raw.get("f170"), raw.get("f169"),
                     raw.get("f86") or raw.get("f124"), "em", now_ms)
    return [row] if row else []


def fetch_em_stock(config, now_ms):
    for host in ("push2.eastmoney.com", "push2delay.eastmoney.com"):
        try:
            rows = parse_em_stock(config, request_json(host, "/api/qt/stock/get", {
                "secid": config["secid"], "fltt": 2, "invt": 2,
                "fields": "f43,f57,f58,f86,f124,f169,f170",
            }), now_ms)
            if rows:
                return rows
        except Exception:
            continue
    return []


def parse_em_minutes(config, payload, now_ms):
    raw = payload.get("data") or {}
    if not matches_code(config, raw.get("code")):
        return []
    previous = number(raw.get("preSettlement")) if config["region"] == "fut" else None
    previous = previous if previous and previous > 0 else number(raw.get("preClose"))
    if previous is None or previous <= 0:
        return []
    for raw_point in reversed(raw.get("trends") or []):
        fields = str(raw_point).split(",")
        if len(fields) < 3:
            continue
        price = number(fields[2])
        if price is None or price <= 0:
            continue
        row = make_quote(config, price, (price / previous - 1) * 100,
                         price - previous, fields[0], "em_minute", now_ms)
        if row:
            return [row]
    return []


def fetch_em_minutes(config, now_ms):
    return parse_em_minutes(config, request_json("push2his.eastmoney.com", "/api/qt/stock/trends2/get", {
        "secid": config["secid"], "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58", "ndays": 1, "iscr": 0, "iscca": 0,
    }), now_ms)


def refresh(output=OUTPUT):
    now_ms = int(time.time() * 1000)
    try:
        previous = json.loads(output.read_text(encoding="utf-8")).get("quotes", {})
    except (OSError, ValueError, TypeError):
        previous = {}
    candidates = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        tasks = [pool.submit(fetch_tencent, now_ms)]
        tasks.extend(pool.submit(fetch_em_list, host, now_ms) for host in ("push2.eastmoney.com", "push2delay.eastmoney.com"))
        tasks.extend(pool.submit(fetch_em_minutes, config, now_ms) for config in INDICES)
        tasks.extend(pool.submit(fetch_em_stock, config, now_ms) for config in INDICES if "tc" not in config)
        for future in concurrent.futures.as_completed(tasks):
            try:
                candidates.extend(future.result())
            except Exception as exc:
                print(f"Source unavailable; retaining last valid quote: {exc}")
    if not candidates:
        raise RuntimeError("All index providers failed; existing snapshot was not changed")
    merged = merge_quotes(previous, candidates, now_ms)
    payload = {"updated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "quotes": merged}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for label, row in merged.items():
        when = dt.datetime.fromtimestamp(row["quoteTs"] / 1000, BEIJING).isoformat()
        print(f"{label}: {row['price']} / {row['pct']:+.3f}% / {when} / {row['src']}")
    missing = [item["label"] for item in INDICES if item["label"] not in merged]
    print(f"Saved {len(merged)}/{len(INDICES)} real quotes to {output}")
    if missing:
        print("WARNING: no verified quote available for " + ", ".join(missing))
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    refresh(parser.parse_args().output)
