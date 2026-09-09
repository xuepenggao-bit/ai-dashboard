#!/usr/bin/env python3
"""Refresh Reuters finance headlines and Substack Finance recent posts.

Only public headline metadata is stored: original title, Chinese title, link,
publication and time.
The browser reads the committed JSON from the same GitHub Pages origin, so it
never needs to connect directly to Reuters or Substack.

Output: data/global_finance_news.json
"""

from __future__ import annotations

import datetime as dt
import email.utils
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
from typing import Any, Iterable
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "data" / "global_finance_news.json"
LIMIT = 5
TRANSLATE_BATCH_URL = "https://clients5.google.com/translate_a/t"
MYMEMORY_URL = "https://api.mymemory.translated.net/get"
TRANSLATE_BATCH_SIZE = 5
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)


def _request(
    url: str,
    *,
    accept: str,
    referer: str,
    attempts: int = 3,
    timeout: int = 35,
) -> bytes:
    last_error: Exception | None = None
    headers = {
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": referer,
        "Cache-Control": "no-cache",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }
    for attempt in range(attempts):
        try:
            with urlopen(Request(url, headers=headers), timeout=timeout) as response:
                return response.read()
        except Exception as exc:  # pragma: no cover - network-dependent retry
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last_error}")


def _get_json(
    url: str,
    *,
    referer: str,
    attempts: int = 3,
    timeout: int = 35,
) -> Any:
    raw = _request(
        url,
        accept="application/json, text/plain, */*",
        referer=referer,
        attempts=attempts,
        timeout=timeout,
    )
    return json.loads(raw.decode("utf-8"))


def _to_epoch(value: Any) -> int:
    if value in (None, ""):
        return 0
    if isinstance(value, (int, float)):
        number = float(value)
        return int(number / 1000 if number > 10_000_000_000 else number)
    text = str(value).strip()
    if not text:
        return 0
    try:
        number = float(text)
        return int(number / 1000 if number > 10_000_000_000 else number)
    except ValueError:
        pass
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return int(parsed.timestamp())
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(text)
        return int(parsed.timestamp())
    except (TypeError, ValueError):
        return 0


def _clean_text(value: Any) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _has_han(value: Any) -> bool:
    return bool(re.search(r"[\u3400-\u9fff]", _clean_text(value)))


def _usable_translation(original: Any, translated: Any) -> str:
    source = _clean_text(original)
    target = _clean_text(translated)
    if not source or not target:
        return ""
    if _has_han(source):
        return source
    if target.casefold() == source.casefold() or not _has_han(target):
        return ""
    return target[:240]


def _bad_reuters_title(title: str) -> bool:
    return bool(
        re.search(
            r"Stock Price\s*&\s*Latest News|^About\s+.+\b(?:ETF|Fund)\b|^[A-Z0-9.]{1,12}\s+-\s*\|",
            _clean_text(title),
            re.I,
        )
    )


def _is_reuters_finance_title(title: str) -> bool:
    """Keep the broad RSS fallback inside markets, finance and investing."""
    return bool(
        re.search(
            r"\b(?:markets?|stocks?|shares?|wall\s+st(?:reet)?|dow|nasdaq|s&p|"
            r"banks?|banking|finance|financial|investors?|investment|funds?|hedge|"
            r"private\s+equity|venture|ipo|deals?|merger|takeover|acquisition|"
            r"earnings|revenue|profit|inflation|fed|central\s+bank|"
            r"bonds?|treasury|yields?|dollar|currenc(?:y|ies)|euro|yen|yuan|pound|"
            r"forex|commodit(?:y|ies)|bitcoin|crypto|debt|credit|"
            r"loans?|mortgage|insurance|assets?|wealth|breakingviews|morning\s+bid|"
            r"trading\s+day|futures)\b",
            _clean_text(title),
            re.I,
        )
    )


def _clean_items(items: Iterable[dict], limit: int = LIMIT) -> list[dict]:
    cleaned: list[dict] = []
    seen: set[str] = set()
    for item in sorted(items, key=lambda row: int(row.get("ts") or 0), reverse=True):
        title = _clean_text(item.get("title"))
        url = str(item.get("url") or "").strip()
        key = re.sub(r"[^a-z0-9]+", "", title.lower())
        if len(title) < 8 or not url.startswith("http") or not key or key in seen:
            continue
        seen.add(key)
        row = {
            "title": title[:240],
            "url": url,
            "publisher": _clean_text(item.get("publisher"))[:80],
            "ts": int(item.get("ts") or 0),
        }
        title_zh = _usable_translation(
            title,
            item.get("titleZh") or item.get("title_zh") or (title if _has_han(title) else ""),
        )
        if title_zh:
            row["titleZh"] = title_zh
        cleaned.append(row)
        if len(cleaned) >= limit:
            break
    return cleaned


def _google_translation_text(value: Any) -> str:
    """Normalize the two response shapes used by the Chrome translate API."""
    if isinstance(value, str):
        return _clean_text(value)
    if isinstance(value, list):
        if value and isinstance(value[0], str):
            return _clean_text(value[0])
        for child in value:
            text = _google_translation_text(child)
            if text:
                return text
    return ""


def _google_translate_batch(titles: list[str]) -> list[str]:
    if not titles:
        return []
    params: list[tuple[str, str]] = [
        ("client", "dict-chrome-ex"),
        ("sl", "auto"),
        ("tl", "zh-CN"),
    ]
    params.extend(("q", title) for title in titles)
    raw = _request(
        TRANSLATE_BATCH_URL + "?" + urlencode(params),
        accept="application/json, text/plain, */*",
        referer="https://translate.google.com/",
        attempts=2,
        timeout=12,
    )
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, list) or len(payload) != len(titles):
        raise RuntimeError("Google translation returned an unexpected batch shape")
    return [_google_translation_text(row) for row in payload]


def _mymemory_translate(title: str) -> str:
    payload = _get_json(
        MYMEMORY_URL + "?" + urlencode({"q": title, "langpair": "en|zh-CN"}),
        referer="https://mymemory.translated.net/",
        attempts=2,
        timeout=15,
    )
    status = int(payload.get("responseStatus") or 0) if isinstance(payload, dict) else 0
    translated = ((payload.get("responseData") or {}).get("translatedText")) if isinstance(payload, dict) else ""
    if status != 200:
        raise RuntimeError(f"MyMemory translation HTTP {status}")
    return _clean_text(translated)


def _translation_cache(previous: dict) -> dict[str, str]:
    cache: dict[str, str] = {}
    for key in ("reuters", "substack"):
        rows = previous.get(key) if isinstance(previous.get(key), list) else []
        for row in rows:
            if not isinstance(row, dict):
                continue
            title = _clean_text(row.get("title"))
            translated = _usable_translation(
                title,
                row.get("titleZh") or row.get("title_zh") or (title if _has_han(title) else ""),
            )
            if title and translated:
                cache[title] = translated
    return cache


def _apply_title_translations(output: dict, previous: dict) -> dict:
    """Attach titleZh to every headline, reusing old translations first."""
    cache = _translation_cache(previous)
    pending: list[str] = []
    for key in ("reuters", "substack"):
        for item in output.get(key) or []:
            title = _clean_text(item.get("title"))
            if _has_han(title):
                cache[title] = title
            elif title not in cache and title not in pending:
                pending.append(title)

    providers: set[str] = set()
    translated_now = 0
    for offset in range(0, len(pending), TRANSLATE_BATCH_SIZE):
        batch = pending[offset : offset + TRANSLATE_BATCH_SIZE]
        google_results: list[str] = [""] * len(batch)
        try:
            google_results = _google_translate_batch(batch)
        except Exception as exc:
            print(f"Google batch translation unavailable: {exc}")
        for title, candidate in zip(batch, google_results):
            translated = _usable_translation(title, candidate)
            if translated:
                cache[title] = translated
                providers.add("Google Translate")
                translated_now += 1
                continue
            try:
                translated = _usable_translation(title, _mymemory_translate(title))
            except Exception as exc:
                print(f"MyMemory translation unavailable for {title[:60]!r}: {exc}")
                translated = ""
            if translated:
                cache[title] = translated
                providers.add("MyMemory")
                translated_now += 1

    total = 0
    translated_total = 0
    for key in ("reuters", "substack"):
        for item in output.get(key) or []:
            total += 1
            translated = cache.get(_clean_text(item.get("title")), "")
            if translated:
                item["titleZh"] = translated
                translated_total += 1
            else:
                item.pop("titleZh", None)
                item.pop("title_zh", None)
    return {
        "status": "fresh" if translated_total == total else "partial",
        "translated": translated_total,
        "total": total,
        "translatedNow": translated_now,
        "providers": sorted(providers),
    }


def _reuters_api() -> list[dict]:
    """Collect several Reuters market desks, then globally sort by publish time.

    The Finance landing page can go quiet for a day while Stocks, Currencies or
    general Markets continues publishing.  Reading only /business/finance made
    a healthy feed look stale, so all relevant official sections compete for
    the five newest slots.
    """
    items: list[dict] = []
    sections = (
        ("/markets", "https://www.reuters.com/markets/"),
        ("/business/finance", "https://www.reuters.com/business/finance/"),
        ("/markets/stocks", "https://www.reuters.com/markets/stocks/"),
        ("/markets/currencies", "https://www.reuters.com/markets/currencies/"),
        ("/markets/rates-bonds", "https://www.reuters.com/markets/rates-bonds/"),
    )
    errors: list[str] = []
    for section_id, referer in sections:
        query = {
            "section_id": section_id,
            "size": 30,
            "website": "reuters",
            "fetch_type": "section",
        }
        endpoint = (
            "https://www.reuters.com/pf/api/v3/content/fetch/"
            "articles-by-section-alias-or-id-v1?"
            + urlencode({"query": json.dumps(query, separators=(",", ":"))})
        )
        try:
            payload = _get_json(endpoint, referer=referer)
        except Exception as exc:
            errors.append(f"{section_id}: {exc}")
            continue
        stories = ((payload.get("arcResult") or {}).get("articles") or []) if isinstance(payload, dict) else []
        if not stories and isinstance(payload, dict):
            stories = ((payload.get("result") or {}).get("articles") or [])
        for story in stories:
            if not isinstance(story, dict):
                continue
            canonical = str(story.get("canonical_url") or story.get("website_url") or "")
            items.append(
                {
                    "title": story.get("title") or story.get("headline"),
                    "url": urljoin("https://www.reuters.com", canonical),
                    "publisher": "Reuters",
                    "ts": _to_epoch(story.get("published_time") or story.get("display_time")),
                }
            )
    result = _clean_items(item for item in items if not _bad_reuters_title(item.get("title", "")))
    if not result:
        raise RuntimeError("Reuters market APIs returned no usable articles: " + " | ".join(errors))
    return result


def _reuters_google_rss() -> list[dict]:
    """Fallback index when Reuters temporarily blocks its own section API."""
    items = []
    # First two searches intentionally use a one-day window.  The longer
    # windows only fill remaining slots on weekends or unusually quiet days;
    # _clean_items performs the final global newest-first sort.
    queries = [
        'Reuters (markets OR stocks OR bonds OR currencies OR commodities) when:1d -"Stock Price & Latest News"',
        'Reuters (finance OR banks OR deals OR earnings OR economy) when:1d -"Stock Price & Latest News"',
        'site:reuters.com/markets when:3d -"Stock Price & Latest News" -"About"',
        'site:reuters.com/business/finance when:3d -"Stock Price & Latest News" -"About"',
        'Reuters (stock market OR Wall Street OR investors OR earnings) when:7d -"Stock Price & Latest News"',
        'Reuters (banks OR bonds OR dollar OR oil OR gold OR deals) when:7d -"Stock Price & Latest News"',
    ]
    for query in queries:
        url = "https://news.google.com/rss/search?" + urlencode(
            {"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"}
        )
        raw = _request(url, accept="application/rss+xml, application/xml, text/xml, */*", referer="https://news.google.com/")
        root = ET.fromstring(raw)
        for node in root.findall(".//item"):
            title = _clean_text(node.findtext("title"))
            source = _clean_text(node.findtext("source"))
            if source.lower() != "reuters" and not title.lower().endswith(" - reuters"):
                continue
            title = re.sub(r"\s+-\s+Reuters$", "", title, flags=re.I)
            if _bad_reuters_title(title) or not _is_reuters_finance_title(title):
                continue
            items.append(
                {
                    "title": title,
                    "url": _clean_text(node.findtext("link")),
                    "publisher": "Reuters",
                    "ts": _to_epoch(node.findtext("pubDate")),
                }
            )
    result = _clean_items(items)
    if not result:
        raise RuntimeError("Reuters Google News fallback returned no usable articles")
    return result


def fetch_reuters() -> tuple[list[dict], str]:
    # Merge both discovery paths even when the official section API succeeds:
    # Google News often indexes a newly published Reuters story before the
    # section landing page updates.  Five items are chosen only after merging.
    items: list[dict] = []
    labels: list[str] = []
    errors: list[str] = []
    try:
        items.extend(_reuters_api())
        labels.append("Reuters Markets")
    except Exception as exc:
        print(f"Reuters direct API unavailable: {exc}")
        errors.append(str(exc))
    try:
        items.extend(_reuters_google_rss())
        labels.append("Google News index")
    except Exception as exc:
        print(f"Reuters Google News index unavailable: {exc}")
        errors.append(str(exc))
    result = _clean_items(items)
    if not result:
        raise RuntimeError(" | ".join(errors) or "Reuters returned no usable articles")
    return result, "Reuters latest via " + " + ".join(labels)


def _publication_name(item: dict, post: dict) -> str:
    candidates = [
        item.get("publication"),
        post.get("publication"),
        (item.get("context") or {}).get("publication") if isinstance(item.get("context"), dict) else None,
    ]
    for candidate in candidates:
        if isinstance(candidate, dict):
            name = candidate.get("name") or candidate.get("publication_name")
            if name:
                return _clean_text(name)
    if item.get("name") and item is not post:
        return _clean_text(item.get("name"))
    byline = post.get("publishedBylines") or post.get("bylines") or []
    if isinstance(byline, list) and byline and isinstance(byline[0], dict):
        return _clean_text(byline[0].get("name"))
    return "Substack"


def _post_item(post: dict, container: dict | None = None) -> dict | None:
    if not isinstance(post, dict):
        return None
    url = str(post.get("canonical_url") or post.get("canonicalUrl") or post.get("post_url") or post.get("url") or "")
    title = post.get("title") or post.get("headline") or post.get("social_title")
    if "/p/" not in url or not title:
        return None
    outer = container or {}
    return {
        "title": title,
        "url": url,
        "publisher": _publication_name(outer, post),
        "ts": _to_epoch(
            post.get("post_date")
            or post.get("published_at")
            or post.get("publishedAt")
            or post.get("date")
            or post.get("publication_date")
        ),
    }


def _substack_explore_api() -> list[dict]:
    # Finance is Substack's public category id 153.  The response contains
    # both Notes and posts; only post entities are retained below.
    endpoint = "https://substack.com/api/v1/search/explore/web?" + urlencode(
        {"tab": "153", "type": "category"}
    )
    payload = _get_json(endpoint, referer="https://substack.com/explore/category/finance")
    # The endpoint has returned both {items:[...]} and tuple-like arrays in
    # different Substack revisions.  Recursing the response keeps both shapes
    # working while _post_item excludes Notes/comments and non-post modules.
    items = list(_walk_posts(payload))
    result = _clean_items(items)
    if not result:
        raise RuntimeError("Substack Explore API returned no post entities")
    return result


def _substack_category_public() -> list[dict]:
    """Rebuild Finance Recent from recent_posts on the public category API."""
    items: list[dict] = []
    for page in (0, 1):
        endpoint = "https://substack.com/api/v1/category/public/153/all?" + urlencode({"page": page})
        payload = _get_json(endpoint, referer="https://substack.com/explore/category/finance")
        items.extend(_walk_posts(payload))
    result = _clean_items(items)
    if not result:
        raise RuntimeError("Substack public Finance category returned no recent_posts")
    return result


class _JsonScriptParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._capture = False
        self._parts: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        props = {key.lower(): value or "" for key, value in attrs}
        script_type = props.get("type", "").lower()
        script_id = props.get("id", "")
        self._capture = script_type in {"application/json", "application/ld+json"} or script_id == "__NEXT_DATA__"
        self._parts = []

    def handle_data(self, data: str) -> None:
        if self._capture:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self._capture:
            text = "".join(self._parts).strip()
            if text:
                self.scripts.append(text)
            self._capture = False
            self._parts = []


def _walk_posts(value: Any, container: dict | None = None) -> Iterable[dict]:
    if isinstance(value, dict):
        post = _post_item(value, container or value)
        if post:
            yield post
        nested = value.get("post")
        if isinstance(nested, dict):
            item = _post_item(nested, value)
            if item:
                yield item
        for child in value.values():
            yield from _walk_posts(child, value)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_posts(child, container)


def _substack_page_json() -> list[dict]:
    raw = _request(
        "https://substack.com/explore/category/finance",
        accept="text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        referer="https://substack.com/explore",
    )
    parser = _JsonScriptParser()
    parser.feed(raw.decode("utf-8", errors="replace"))
    items: list[dict] = []
    for script in parser.scripts:
        try:
            payload = json.loads(script)
        except (TypeError, ValueError):
            continue
        items.extend(_walk_posts(payload))
    result = _clean_items(items)
    if not result:
        raise RuntimeError("Substack Finance page contained no usable post metadata")
    return result


def _substack_google_rss() -> list[dict]:
    """Last-resort Recent index for networks on which Substack returns 403."""
    queries = [
        "site:substack.com/p (markets OR investing OR stocks) when:3d",
        "site:substack.com/p (finance OR economy OR macro) when:3d",
    ]
    items: list[dict] = []
    for query in queries:
        url = "https://news.google.com/rss/search?" + urlencode(
            {"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"}
        )
        raw = _request(url, accept="application/rss+xml, application/xml, text/xml, */*", referer="https://news.google.com/")
        root = ET.fromstring(raw)
        for node in root.findall(".//item"):
            title = _clean_text(node.findtext("title"))
            publisher = _clean_text(node.findtext("source")) or "Substack"
            if publisher and title.lower().endswith((" - " + publisher).lower()):
                title = title[: -(len(publisher) + 3)].rstrip()
            items.append(
                {
                    "title": title,
                    "url": _clean_text(node.findtext("link")),
                    "publisher": publisher,
                    "ts": _to_epoch(node.findtext("pubDate")),
                }
            )
    result = _clean_items(items)
    if not result:
        raise RuntimeError("Substack Google News fallback returned no recent finance posts")
    return result


def fetch_substack() -> tuple[list[dict], str]:
    errors: list[str] = []
    try:
        return _substack_explore_api(), "Substack Finance Recent"
    except Exception as exc:
        print(f"Substack Explore API unavailable: {exc}")
        errors.append(f"Explore API: {exc}")
    try:
        return _substack_category_public(), "Substack Finance Recent"
    except Exception as exc:
        print(f"Substack public category unavailable: {exc}")
        errors.append(f"Category API: {exc}")
    try:
        return _substack_page_json(), "Substack Finance page"
    except Exception as exc:
        errors.append(f"Finance page: {exc}")
    try:
        return _substack_google_rss(), "Substack Finance Recent via Google News index"
    except Exception as exc:
        errors.append(f"Google index: {exc}")
        raise RuntimeError(" | ".join(errors)) from exc


def _load_existing() -> dict:
    try:
        payload = json.loads(OUTPUT.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def refresh() -> dict:
    previous = _load_existing()
    now = dt.datetime.now(dt.timezone.utc)
    previous_reuters = _clean_items(previous.get("reuters") if isinstance(previous.get("reuters"), list) else [])
    previous_reuters = [item for item in previous_reuters if not _bad_reuters_title(item.get("title", ""))]
    previous_substack = _clean_items(previous.get("substack") if isinstance(previous.get("substack"), list) else [])
    output: dict[str, Any] = {
        "updatedAt": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "sources": {},
        "reuters": previous_reuters,
        "substack": previous_substack,
    }
    fresh = 0
    for key, fetcher in (("reuters", fetch_reuters), ("substack", fetch_substack)):
        try:
            items, label = fetcher()
            output[key] = items
            output["sources"][key] = {"label": label, "status": "fresh", "count": len(items)}
            fresh += 1
            print(f"{key}: refreshed {len(items)} items from {label}")
        except Exception as exc:
            cached = output[key]
            output["sources"][key] = {
                "label": (previous.get("sources") or {}).get(key, {}).get("label", key.title()),
                "status": "cached" if cached else "unavailable",
                "count": len(cached),
                "error": str(exc)[:240],
            }
            print(f"{key}: refresh failed; kept {len(cached)} cached items ({exc})")

    if fresh == 0 and not output["reuters"] and not output["substack"]:
        raise RuntimeError("both English finance sources failed and no cache exists")
    output["translation"] = _apply_title_translations(output, previous)
    print(
        "Chinese titles: "
        f"{output['translation']['translated']}/{output['translation']['total']} "
        f"({', '.join(output['translation']['providers']) or 'cache'})"
    )
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output


if __name__ == "__main__":
    result = refresh()
    print(
        "saved global finance news: "
        f"Reuters={len(result['reuters'])}, Substack={len(result['substack'])}"
    )
