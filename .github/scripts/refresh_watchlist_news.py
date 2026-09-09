#!/usr/bin/env python3
"""Refresh the five newest articles related to the current portfolio.

Eastmoney per-stock search is the primary source. Google News is only used to
fill a short result set, and the previous committed cache is retained when all
live sources are temporarily unavailable.

Output: data/watchlist_news.json
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime as dt
import email.utils
import html
import json
import os
from pathlib import Path
import re
import time
from typing import Any, Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[2]
PORTFOLIO = Path(os.environ.get("PORTFOLIO_PATH", ROOT / "portfolio.json"))
OUTPUT = Path(os.environ.get("WATCHLIST_NEWS_OUTPUT", ROOT / "data" / "watchlist_news.json"))
LIMIT = 5
PER_STOCK_LIMIT = 8
EASTMONEY_SEARCH = "https://search-api-web.eastmoney.com/search/jsonp"
GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
CHINA_TZ = dt.timezone(dt.timedelta(hours=8))


def _clean_text(value: Any) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _request_text(
    url: str,
    *,
    referer: str,
    attempts: int = 2,
    timeout: int = 18,
) -> str:
    last_error: Exception | None = None
    headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, application/rss+xml, application/xml, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        "Referer": referer,
        "Cache-Control": "no-cache",
    }
    for attempt in range(attempts):
        try:
            with urlopen(Request(url, headers=headers), timeout=timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except Exception as exc:  # pragma: no cover - network-dependent retry
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last_error}")


def _parse_jsonp(value: str) -> dict:
    start = value.find("{")
    end = value.rfind("}")
    if start < 0 or end < start:
        raise ValueError("Eastmoney returned invalid JSONP")
    payload = json.loads(value[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError("Eastmoney returned an invalid payload")
    return payload


def _to_epoch(value: Any) -> int:
    if value in (None, ""):
        return 0
    if isinstance(value, (int, float)):
        number = float(value)
        return int(number / 1000 if number > 10_000_000_000 else number)
    text = str(value).strip()
    try:
        number = float(text)
        return int(number / 1000 if number > 10_000_000_000 else number)
    except ValueError:
        pass
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return int(dt.datetime.strptime(text, pattern).replace(tzinfo=CHINA_TZ).timestamp())
        except ValueError:
            pass
    try:
        parsed = email.utils.parsedate_to_datetime(text)
        return int(parsed.timestamp())
    except (TypeError, ValueError):
        return 0


def _portfolio_stocks(payload: dict) -> list[dict]:
    """Return one search entry per company, combining duplicate A/H listings."""
    stocks: dict[str, dict] = {}
    for sector in payload.get("sectors") or []:
        if not isinstance(sector, dict):
            continue
        for row in sector.get("stocks") or []:
            if not isinstance(row, dict):
                continue
            name = _clean_text(row.get("name"))
            code = _clean_text(row.get("code"))
            market = _clean_text(row.get("mkt")).upper()
            if not name:
                continue
            key = name.casefold()
            stock = stocks.setdefault(key, {"name": name, "codes": [], "markets": []})
            if code and code not in stock["codes"]:
                stock["codes"].append(code)
            if market and market not in stock["markets"]:
                stock["markets"].append(market)
    return sorted(stocks.values(), key=lambda row: row["name"])


def _eastmoney_stock_news(stock: dict) -> list[dict]:
    name = stock["name"]
    query = {
        "uid": "",
        "keyword": name,
        "type": ["cmsArticleWebOld"],
        "client": "web",
        "clientType": "web",
        "clientVersion": "curr",
        "param": {
            "cmsArticleWebOld": {
                "searchScope": "default",
                "sort": "time",
                "pageIndex": 1,
                "pageSize": PER_STOCK_LIMIT,
                "preTag": "",
                "postTag": "",
            }
        },
    }
    url = EASTMONEY_SEARCH + "?" + urlencode(
        {
            "cb": "jQuery_watchlist",
            "param": json.dumps(query, ensure_ascii=False, separators=(",", ":")),
            "_": int(time.time() * 1000),
        }
    )
    payload = _parse_jsonp(
        _request_text(url, referer="https://so.eastmoney.com/", attempts=2, timeout=16)
    )
    rows = ((payload.get("result") or {}).get("cmsArticleWebOld") or [])
    if isinstance(rows, dict):
        rows = rows.get("list") or []
    items: list[dict] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = _clean_text(row.get("title"))
        # The search endpoint occasionally returns a broad article that only
        # mentions the company deep in its body. A watchlist headline should be
        # directly about the stock, so require its name/code in the headline.
        if name not in title and not any(code and code in title for code in stock["codes"]):
            continue
        article_url = str(row.get("url") or "").strip()
        if article_url.startswith("http://") and ".eastmoney.com/" in article_url:
            article_url = "https://" + article_url[len("http://") :]
        items.append(
            {
                "title": title[:180],
                "url": article_url,
                "publisher": _clean_text(row.get("mediaName"))[:60] or "东方财富",
                "ts": _to_epoch(row.get("date")),
                "stockName": name,
                "stockCodes": stock["codes"],
                "provider": "东方财富",
            }
        )
    return items


def _google_news_fallback(stocks: list[dict]) -> list[dict]:
    """Fetch a small fallback set in chunks and keep only portfolio matches."""
    items: list[dict] = []
    for start in range(0, len(stocks), 6):
        chunk = stocks[start : start + 6]
        query = "(" + " OR ".join('\"{}\"'.format(stock["name"]) for stock in chunk) + ") when:7d"
        url = GOOGLE_NEWS_RSS + "?" + urlencode(
            {"q": query, "hl": "zh-CN", "gl": "CN", "ceid": "CN:zh-Hans"}
        )
        try:
            root = ET.fromstring(
                _request_text(url, referer="https://news.google.com/", attempts=2, timeout=18)
            )
        except Exception as exc:  # pragma: no cover - live fallback only
            print(f"Google News fallback chunk failed: {exc}")
            continue
        for node in root.findall(".//item"):
            title = _clean_text(node.findtext("title"))
            description = _clean_text(node.findtext("description"))
            stock = next(
                (entry for entry in chunk if entry["name"] in f"{title} {description}"),
                None,
            )
            if not stock:
                continue
            source_node = node.find("source")
            publisher = _clean_text(source_node.text if source_node is not None else "")
            items.append(
                {
                    "title": title[:180],
                    "url": str(node.findtext("link") or "").strip(),
                    "publisher": publisher[:60] or "Google News",
                    "ts": _to_epoch(node.findtext("pubDate")),
                    "stockName": stock["name"],
                    "stockCodes": stock["codes"],
                    "provider": "Google News",
                }
            )
    return items


def _item_key(item: dict) -> str:
    title = _clean_text(item.get("title")).casefold()
    return re.sub(r"[^0-9a-z\u3400-\u9fff]+", "", title)


def _same_event(left: dict, right: dict) -> bool:
    """Collapse near-identical coverage of one company event."""
    left_stock = _clean_text(left.get("stockName"))
    right_stock = _clean_text(right.get("stockName"))
    if not left_stock or left_stock != right_stock:
        return False

    def bigrams(item: dict) -> set[str]:
        text = _item_key(item).replace(
            re.sub(r"[^0-9a-z\u3400-\u9fff]+", "", left_stock.casefold()),
            "",
        )
        return {text[index : index + 2] for index in range(max(0, len(text) - 1))}

    a, b = bigrams(left), bigrams(right)
    if not a or not b:
        return False
    shared = len(a & b)
    return shared >= 3 and shared / min(len(a), len(b)) >= 0.24


def _clean_items(items: Iterable[dict], limit: int = LIMIT) -> list[dict]:
    cleaned: list[dict] = []
    seen_titles: set[str] = set()
    seen_urls: set[str] = set()
    for item in sorted(items, key=lambda row: int(row.get("ts") or 0), reverse=True):
        title = _clean_text(item.get("title"))
        url = str(item.get("url") or "").strip()
        if url.startswith("http://") and "eastmoney.com/" in url:
            url = "https://" + url[len("http://") :]
        key = _item_key(item)
        if len(title) < 4 or not url.startswith("http") or not key:
            continue
        if key in seen_titles or url in seen_urls:
            continue
        if any(_same_event(item, kept) for kept in cleaned):
            continue
        seen_titles.add(key)
        seen_urls.add(url)
        cleaned.append(
            {
                "title": title[:180],
                "url": url,
                "publisher": _clean_text(item.get("publisher"))[:60],
                "ts": int(item.get("ts") or 0),
                "stockName": _clean_text(item.get("stockName"))[:40],
                "stockCodes": [
                    _clean_text(code)[:12] for code in (item.get("stockCodes") or []) if _clean_text(code)
                ],
                "provider": _clean_text(item.get("provider"))[:40],
            }
        )
        if len(cleaned) >= limit:
            break
    return cleaned


def _load_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _content_signature(items: list[dict]) -> list[tuple[str, str, int]]:
    return [
        (_item_key(item), str(item.get("url") or ""), int(item.get("ts") or 0))
        for item in items
    ]


def refresh() -> dict:
    portfolio = _load_json(PORTFOLIO)
    previous = _load_json(OUTPUT)
    stocks = _portfolio_stocks(portfolio)
    if not stocks:
        raise RuntimeError("portfolio.json contains no stocks")

    eastmoney_items: list[dict] = []
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = {pool.submit(_eastmoney_stock_news, stock): stock for stock in stocks}
        for future in as_completed(jobs):
            stock = jobs[future]
            try:
                eastmoney_items.extend(future.result())
            except Exception as exc:  # pragma: no cover - network-dependent
                errors.append(f"{stock['name']}: {exc}")

    live_items = _clean_items(eastmoney_items, LIMIT)
    fallback_items: list[dict] = []
    if len(live_items) < LIMIT:
        fallback_items = _google_news_fallback(stocks)
        live_items = _clean_items([*eastmoney_items, *fallback_items], LIMIT)

    previous_items = _clean_items(previous.get("items") or [], LIMIT)
    items = live_items if len(live_items) >= LIMIT else _clean_items([*live_items, *previous_items], LIMIT)
    if not items:
        raise RuntimeError("all watchlist news sources failed and no previous cache exists")

    # Avoid creating a Git commit every 15 minutes when the visible five rows
    # did not change. In that case, leave the existing JSON byte-for-byte intact.
    if _content_signature(items) == _content_signature(previous.get("items") or []):
        print("No new watchlist headlines; keeping the existing cache.")
        return previous

    providers = sorted({item["provider"] for item in items if item.get("provider")})
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    payload = {
        "updatedAt": now.isoformat().replace("+00:00", "Z"),
        "status": "fresh" if len(live_items) >= LIMIT else "partial",
        "watchlistCount": len(stocks),
        "count": len(items),
        "providers": providers,
        "eastmoneyArticlesScanned": len(eastmoney_items),
        "fallbackArticlesScanned": len(fallback_items),
        "failedStocks": len(errors),
        "items": items,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {len(items)} watchlist headlines for {len(stocks)} companies "
        f"({len(eastmoney_items)} Eastmoney rows, {len(errors)} failed searches)."
    )
    if errors:
        print("Failed Eastmoney searches: " + " | ".join(errors[:6]))
    return payload


if __name__ == "__main__":
    refresh()
