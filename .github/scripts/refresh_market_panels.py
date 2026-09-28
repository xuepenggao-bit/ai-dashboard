#!/usr/bin/env python3
"""Keep complete, last-good A-share breadth and money-flow panel snapshots.

These are independent of the user's browser. Failed, partial and overnight-zero
responses never erase a lunch/closing snapshot. quoteTs is exclusively a source
timestamp (Eastmoney f124); observedAt is only the time this collector read it.
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
OUTPUT = ROOT / "data" / "market_panels.json"
HOSTS = ("push2.eastmoney.com", "push2delay.eastmoney.com")
# Same official clist data, via the data site's own public H5 controller. This
# remains available when push2 closes connections on some networks.
H5_LIST_URL = "https://emdatah5.eastmoney.com/dc/ZJLX/getZDYLBData"
SOURCE = "东方财富"
BREADTH_POOL = "m:0+t:6+f:!2,m:0+t:80+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2"
# Keep the dashboard's established top-20 universe, independently of breadth.
FLOW_POOL = "m:0+t:6,m:0+t:13,m:0+t:80,m:1+t:2,m:1+t:23"
BUCKETS = ((950, 100000), (500, 949), (100, 499), (1, 99), (0, 0),
           (-99, -1), (-499, -100), (-949, -500), (-100000, -950))
HEADERS = {
    "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
    "Accept": "application/json, text/plain, */*",
}


def number(value):
    if value is None or isinstance(value, bool) or str(value).strip() in ("", "-", "--"):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def timestamp(value, now_ms):
    stamp = number(value)
    if stamp is None or stamp <= 0:
        return 0
    stamp = int(stamp * 1000 if stamp < 10_000_000_000 else stamp)
    return stamp if 946684800000 <= stamp <= now_ms + 300000 else 0


def metadata(rows, now_ms):
    # The aggregate contains rows fetched over several seconds. Label its latest
    # real provider quote, never pretend observedAt is an exact session close.
    stamp = max((timestamp(row.get("f124"), now_ms) for row in rows), default=0)
    return {"quoteTs": stamp, "observedAt": now_ms, "source": SOURCE,
            "timeBasis": "provider" if stamp else "observed"}


def normalize_diff(payload):
    if not isinstance(payload, dict) or payload.get("rc", 0) != 0:
        raise ValueError("source error")
    data = payload.get("data") or {}
    rows = data.get("diff")
    if isinstance(rows, dict):
        rows = list(rows.values())
    if not isinstance(rows, list) or not rows or not all(isinstance(row, dict) for row in rows):
        raise ValueError("empty source rows")
    total = number(data.get("total"))
    if total is None or total <= 0 or total != int(total):
        raise ValueError("invalid source total")
    return int(total), rows


def security_key(row):
    code = str(row.get("f12") or "")
    market = number(row.get("f13"))
    if not re.fullmatch(r"\d{6}", code) or market not in (0, 1):
        raise ValueError("invalid stock identity")
    return int(market), code


def assemble_pages(pages, expected_total, page_size=100):
    expected_pages = math.ceil(expected_total / page_size)
    if set(pages) != set(range(1, expected_pages + 1)):
        raise ValueError("incomplete breadth pages")
    all_rows, seen = [], set()
    for page in sorted(pages):
        total, rows = normalize_diff(pages[page])
        if total != expected_total or len(rows) != min(page_size, expected_total - (page - 1) * page_size):
            raise ValueError("inconsistent or truncated breadth page")
        for row in rows:
            key = security_key(row)
            if key in seen:
                raise ValueError("duplicate breadth stock")
            seen.add(key)
            all_rows.append(row)
    return all_rows


def make_breadth(rows, total, now_ms):
    if len(rows) != total or total < 500:
        raise ValueError("incomplete breadth universe")
    counts = [0] * len(BUCKETS)
    for row in rows:
        # fltt=2 gives percentages, while the established bins use basis points.
        pct = number(row.get("f3"))
        if pct is None:
            continue
        value = int(round(pct * 100))
        for index, (low, high) in enumerate(BUCKETS):
            if low <= value <= high:
                counts[index] += 1
                break
    result = {"counts": counts, "total": total, **metadata(rows, now_ms)}
    if not valid_panel("breadth", result, now_ms):
        raise ValueError("empty, all-flat or incomplete breadth quotes")
    return result


def make_flow(rows, direction, now_ms):
    if direction not in ("inflow", "outflow") or len(rows) != 20:
        raise ValueError("incomplete flow top 20")
    normalized, seen = [], set()
    for row in rows:
        key = security_key(row)
        name = str(row.get("f14") or "").strip()
        pct, flow = number(row.get("f3")), number(row.get("f62"))
        if key in seen or not name or pct is None or flow is None or (flow <= 0 if direction == "inflow" else flow >= 0):
            raise ValueError("invalid, duplicate or reset flow row")
        seen.add(key)
        normalized.append({"f12": key[1], "f13": key[0], "f14": name,
                           "f3": pct, "f62": flow, "f184": number(row.get("f184"))})
    normalized.sort(key=lambda row: row["f62"], reverse=direction == "inflow")
    return {"rows": normalized, **metadata(rows, now_ms)}


def valid_panel(key, panel, now_ms):
    if not isinstance(panel, dict):
        return False
    observed, quoted = number(panel.get("observedAt")), number(panel.get("quoteTs"))
    if observed is None or not 946684800000 <= observed <= now_ms + 300000:
        return False
    if quoted is None or quoted < 0 or (quoted and timestamp(quoted, now_ms) != quoted):
        return False
    if key == "breadth":
        counts, total = panel.get("counts"), number(panel.get("total"))
        if not isinstance(counts, list) or len(counts) != 9 or any(isinstance(x, bool) or not isinstance(x, int) or x < 0 for x in counts):
            return False
        return (total is not None and total >= 500 and total == int(total)
                and total * .9 <= sum(counts) <= total and sum(counts) - counts[4] >= 50)
    if key not in ("inflow", "outflow"):
        return False
    try:
        make_flow(panel.get("rows") or [], key, now_ms)
        return True
    except (ValueError, TypeError):
        return False


def merge_panel(key, old, candidate, now_ms):
    old = old if valid_panel(key, old, now_ms) else None
    if not valid_panel(key, candidate, now_ms):
        return old
    if old:
        old_quote, new_quote = old["quoteTs"], candidate["quoteTs"]
        # An untimed response cannot displace a known, dated market snapshot.
        if old_quote and (not new_quote or new_quote < old_quote):
            return old
        if new_quote == old_quote and candidate["observedAt"] <= old["observedAt"]:
            return old
        # A later read can confirm the same 11:30/15:00 provider timestamp after
        # the settlement grace period. Preserve quoteTs and advance observedAt;
        # the frontend must not mistake that confirmation for a new market tick.
    return candidate


def request_json(host, params):
    url = "https://" + host + "/api/qt/clist/get?" + urlencode({**params, "_": int(time.time() * 1000)})
    with urlopen(Request(url, headers=HEADERS), timeout=8) as response:
        return json.loads(response.read(2_000_000))


def request_any(params):
    last_error = None
    try:
        url = H5_LIST_URL + "?" + urlencode({**params, "fltt": 2, "_": int(time.time() * 1000)})
        with urlopen(Request(url, headers={**HEADERS, "Referer": "https://emdatah5.eastmoney.com/dc/zjlx/index"}), timeout=8) as response:
            payload = json.loads(response.read(2_000_000))
        normalize_diff(payload)
        return payload
    except Exception as exc:
        last_error = exc
    for host in HOSTS:
        try:
            payload = request_json(host, params)
            normalize_diff(payload)
            return payload
        except Exception as exc:
            last_error = exc
    raise RuntimeError(str(last_error))


def fetch_breadth(now_ms):
    params = {"np": 1, "invt": 2, "fltt": 2, "fid": "f12", "po": 0,
              "fields": "f3,f12,f13,f124", "fs": BREADTH_POOL, "pz": 100}
    first = request_any({**params, "pn": 1})
    total, _ = normalize_diff(first)
    if total < 500 or total > 15000:
        raise ValueError("unexpected A-share universe size")
    pages = {1: first}
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        pending = {executor.submit(request_any, {**params, "pn": page}): page
                   for page in range(2, math.ceil(total / 100) + 1)}
        for future in concurrent.futures.as_completed(pending):
            pages[pending[future]] = future.result()
    return make_breadth(assemble_pages(pages, total), total, now_ms)


def fetch_flow(direction, now_ms):
    payload = request_any({"fid": "f62", "po": 1 if direction == "inflow" else 0,
                           "pz": 20, "pn": 1, "np": 1, "fltt": 2, "invt": 2,
                           "ut": "bd1d9ddb04089700cf9c27f6f7426281",
                           "fields": "f12,f13,f14,f3,f62,f184,f124", "fs": FLOW_POOL})
    _, rows = normalize_diff(payload)
    return make_flow(rows, direction, now_ms)


def refresh(previous, now_ms):
    result = {"schema_version": 1}
    candidates = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        pending = {executor.submit(fetch_breadth, now_ms): "breadth",
                   executor.submit(fetch_flow, "inflow", now_ms): "inflow",
                   executor.submit(fetch_flow, "outflow", now_ms): "outflow"}
        for future in concurrent.futures.as_completed(pending):
            key = pending[future]
            try:
                candidates[key] = future.result()
            except Exception as exc:
                print(f"::warning::{key}: keep last valid snapshot ({exc})")
    for key in ("breadth", "inflow", "outflow"):
        panel = merge_panel(key, previous.get(key), candidates.get(key), now_ms)
        if panel:
            result[key] = panel
    if len(result) == 1:
        raise RuntimeError("No valid panel snapshot; refusing to publish blank data")
    changed = any(result.get(key) != previous.get(key) for key in ("breadth", "inflow", "outflow"))
    result["updated_at"] = (dt.datetime.fromtimestamp(now_ms / 1000, dt.timezone.utc).isoformat()
                            if changed else previous.get("updated_at"))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    previous = {}
    if args.output.exists():
        try:
            previous = json.loads(args.output.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            pass
    result = refresh(previous if isinstance(previous, dict) else {}, int(time.time() * 1000))
    if result != previous:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(args.output)
    print("Published valid panels: " + ", ".join(key for key in ("breadth", "inflow", "outflow") if key in result))


if __name__ == "__main__":
    main()
