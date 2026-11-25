#!/usr/bin/env python3
"""Collect the five newest Chinese financial articles without browser CORS.

Publication time is never replaced by collection time. Successful sources and
the last committed snapshot are merged, so a slower stale response cannot move
the news backwards. The browser reads this JSON from Pages and GitHub raw.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime as dt
import email.utils
import html
import json
import math
import os
from pathlib import Path
import re
import time
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path(os.environ.get("FINANCE_NEWS_OUTPUT", ROOT / "data" / "finance_news.json"))
CHINA = dt.timezone(dt.timedelta(hours=8))
LIMIT = 5
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"


def clean_text(value: Any) -> str:
    text = html.unescape(str(value or ""))
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", text)).strip()


def epoch(value: Any) -> int:
    """Epoch seconds/ms, ISO/RFC dates, or explicit Beijing calendar strings."""
    if isinstance(value, bool) or value is None:
        return 0
    text = str(value).strip()
    if not text:
        return 0
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        try:
            number = float(text)
            return int(number / 1000 if number > 10_000_000_000 else number) if math.isfinite(number) else 0
        except (ValueError, OverflowError):
            return 0
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        parsed = None
        for pattern in ("%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M"):
            try:
                parsed = dt.datetime.strptime(text, pattern)
                break
            except ValueError:
                pass
        if parsed is None:
            try:
                parsed = email.utils.parsedate_to_datetime(text)
            except (TypeError, ValueError):
                return 0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=CHINA)
    try:
        return int(parsed.timestamp())
    except (ValueError, OverflowError, OSError):
        return 0


def iso(timestamp: int) -> str:
    return dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def safe_url(value: Any) -> str:
    text = html.unescape(str(value or "")).strip()
    if not text or len(text) > 2048 or re.search(r"[\x00-\x20\\]", text):
        return ""
    try:
        parsed = urlsplit(text)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            return ""
        # Both providers sometimes return http article links; serve HTTPS only.
        return urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, ""))
    except ValueError:
        return ""


def normalize_item(raw: Any, now: int) -> dict | None:
    if not isinstance(raw, dict):
        return None
    title, url, timestamp = clean_text(raw.get("title")), safe_url(raw.get("url")), epoch(raw.get("ts"))
    # No missing/future publication dates or invented current-time headlines.
    if len(title) < 4 or not url or timestamp < 946684800 or timestamp > now:
        return None
    return {"title": title[:200], "url": url, "publisher": clean_text(raw.get("publisher"))[:80],
            "provider": clean_text(raw.get("provider"))[:40], "ts": timestamp}


def newest_items(items: list, now: int, limit: int = LIMIT) -> list[dict]:
    valid = [item for raw in items if (item := normalize_item(raw, now))]
    valid.sort(key=lambda item: item["ts"], reverse=True)
    titles, urls, result = set(), set(), []
    for item in valid:
        key = re.sub(r"[\W_]+", "", item["title"].casefold())
        if not key or key in titles or item["url"] in urls:
            continue
        titles.add(key)
        urls.add(item["url"])
        result.append(item)
        if len(result) >= limit:
            break
    return result


def parse_wscn(payload: Any, now: int) -> list[dict]:
    if not isinstance(payload, dict) or str(payload.get("code")) != "20000":
        raise ValueError("WSCN returned an unsuccessful response")
    rows = (payload.get("data") or {}).get("items")
    if not isinstance(rows, list):
        raise ValueError("WSCN article list is missing")
    items = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        author = row.get("author") if isinstance(row.get("author"), dict) else {}
        items.append({"title": row.get("title") or row.get("subtitle") or row.get("content_short"),
                      "url": row.get("uri"), "ts": row.get("display_time"),
                      "publisher": row.get("source_name") or author.get("display_name") or "华尔街见闻",
                      "provider": "华尔街见闻"})
    return newest_items(items, now, 30)


def parse_eastmoney(payload: Any, now: int) -> list[dict]:
    if not isinstance(payload, dict) or str(payload.get("code")) != "1":
        raise ValueError("Eastmoney returned an unsuccessful response")
    rows = (payload.get("data") or {}).get("list")
    if not isinstance(rows, list):
        raise ValueError("Eastmoney article list is missing")
    # realSort can reflect a pinned/re-promoted article. Only showTime is the
    # article's displayed publication date; do not treat the pin time as news.
    return newest_items([{"title": row.get("title"), "url": row.get("uniqueUrl") or row.get("url"),
                          "ts": row.get("showTime"), "publisher": row.get("mediaName") or "东方财富",
                          "provider": "东方财富"}
                         for row in rows if isinstance(row, dict)], now, 30)


def request_json(url: str, referer: str) -> dict:
    headers = {"User-Agent": UA, "Accept": "application/json, text/plain, */*", "Referer": referer,
               "Origin": "https://financial.qiwu.fun", "Cache-Control": "no-cache"}
    last = None
    for attempt in range(2):
        try:
            with urlopen(Request(url, headers=headers), timeout=10) as response:
                return json.loads(response.read(5_000_000).decode("utf-8"))
        except Exception as exc:
            last = exc
            if attempt == 0:
                time.sleep(0.4)
    raise RuntimeError(f"Source request failed: {type(last).__name__}")


def fetch_wscn(now: int) -> list[dict]:
    query = urlencode({"channel": "global-channel", "client": "pc", "limit": 30, "_": int(time.time() * 1000)})
    # The publisher's alternate official API hostname also works when the
    # wallstcn API hostname is unreachable in a particular network.
    for host in ("api-one-wscn.awtmt.com", "api-one.wallstcn.com"):
        try:
            items = parse_wscn(request_json(f"https://{host}/apiv1/content/articles?{query}", "https://wallstreetcn.com/"), now)
            if items:
                return items
        except Exception:
            continue
    raise RuntimeError("WSCN article endpoints unavailable or empty")


def fetch_eastmoney(now: int) -> list[dict]:
    stamp = int(time.time() * 1000)
    params = {"client": "web", "biz": "web_news", "column": 350, "order": 1, "needInteractData": 0,
              "page_index": 1, "page_size": 30, "req_trace": stamp, "fields": "", "types": "1,20", "_": stamp}
    items = parse_eastmoney(request_json("https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?" + urlencode(params),
                                        "https://finance.eastmoney.com/"), now)
    if not items:
        raise RuntimeError("Eastmoney article endpoint is empty")
    return items


def collect(now: int) -> list[dict]:
    results = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = {pool.submit(loader, now): name for name, loader in
                   (("华尔街见闻", fetch_wscn), ("东方财富", fetch_eastmoney))}
        for future in as_completed(pending):
            name = pending[future]
            try:
                results.append({"source": name, "items": future.result()})
            except Exception as exc:
                results.append({"source": name, "items": [], "error": str(exc)[:200]})
    return sorted(results, key=lambda result: result["source"])


def build_snapshot(previous: dict, results: list[dict], now: int) -> dict:
    previous = previous if isinstance(previous, dict) else {}
    old_items = previous.get("items") if isinstance(previous.get("items"), list) else []
    combined, successful, sources = list(old_items), 0, []
    for result in results:
        items = newest_items(result.get("items") or [], now, 30)
        if items:
            successful += 1
            combined.extend(items)
        source = {"name": clean_text(result.get("source")), "status": "ok" if items else "error", "count": len(items)}
        if items:
            source["latestPublishedAt"] = iso(items[0]["ts"])
        else:
            source["error"] = clean_text(result.get("error") or "No valid dated articles")[:200]
        sources.append(source)
    selected = newest_items(combined, now)
    if not selected:
        raise RuntimeError("No valid finance articles; existing file was not changed")
    old_success = epoch(previous.get("updatedAt"))
    updated = iso(now) if successful else iso(old_success if 0 < old_success <= now else selected[0]["ts"])
    return {"schemaVersion": 1, "updatedAt": updated, "checkedAt": iso(now),
            "status": "ok" if successful == len(results) and successful else "partial" if successful else "retained",
            "latestPublishedAt": iso(selected[0]["ts"]),
            "freshness": "fresh" if now - selected[0]["ts"] <= 6 * 3600 else "stale",
            "items": selected, "sources": sources}


def refresh(output: Path = OUTPUT, *, now: int | None = None, results: list[dict] | None = None) -> dict:
    output = Path(output)
    now = int(time.time()) if now is None else now
    try:
        previous = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = {}
    snapshot = build_snapshot(previous, collect(now) if results is None else results, now)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)
    return snapshot


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    snapshot = refresh(parser.parse_args().output)
    print(json.dumps({"status": snapshot["status"], "checkedAt": snapshot["checkedAt"],
                      "latestPublishedAt": snapshot["latestPublishedAt"], "count": len(snapshot["items"])}, ensure_ascii=False))
