#!/usr/bin/env python3
"""Refresh hyperscaler Capex guidance and frontier-AI ARR milestones.

GitHub Actions runs this scanner every three hours and also exposes a manual trigger.
Capex prefers company investor-relations domains; when a number is disclosed
only on an earnings call, a narrow allowlist of direct call reporting is used.
ARR may use company disclosures or a small allowlist of reliable news sources
because private companies often disclose milestones through reporting.
Unverified fields are ignored, qualitative ARR news is never converted into an
invented number, and the last valid numeric snapshot is preserved. Extraction
is deterministic and local because GitHub Models was retired on 2026-07-30.
"""

import datetime
import html
import json
import os
import re
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qs, unquote, urlencode, urljoin, urlparse

import requests


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(SCRIPT_DIR, "..", ".."))
OUT = os.path.join(REPO_ROOT, "data", "ai_trend.json")

COMPANIES = {
    "alphabet": {
        "name": "Alphabet / Google",
        "query": "site:abc.xyz/investor latest earnings 2026 capital expenditures guidance range",
        "hosts": ("abc.xyz",),
        "landing_urls": ("https://abc.xyz/investor/",),
        "bounds": (500, 3000),
        "source_label": "Alphabet 官方业绩披露",
    },
    "microsoft": {
        "name": "Microsoft",
        "query": "site:microsoft.com/en-us/investor latest earnings 2026 capital expenditures guidance",
        "hosts": ("microsoft.com",),
        "landing_urls": ("https://www.microsoft.com/en-us/investor/events",),
        "bounds": (500, 3000),
        "source_label": "Microsoft 官方业绩披露",
    },
    "amazon": {
        "name": "Amazon",
        "query": "site:ir.aboutamazon.com latest earnings 2026 capital expenditures guidance",
        "hosts": ("ir.aboutamazon.com",),
        "landing_urls": ("https://ir.aboutamazon.com/quarterly-results/default.aspx",),
        # Amazon sometimes gives the full-year Capex total only on the call.
        # AP's company hub exposes those call reports without relying on a
        # search engine having indexed the article yet.
        "trusted_landing_urls": ("https://apnews.com/hub/amazon-com-inc",),
        "bounds": (500, 3000),
        "source_label": "Amazon 官方业绩披露",
    },
    "meta": {
        "name": "Meta",
        "query": "site:investor.atmeta.com latest earnings 2026 capital expenditures guidance range",
        "hosts": ("investor.atmeta.com",),
        "landing_urls": ("https://investor.atmeta.com/financials/default.aspx",),
        "bounds": (300, 2500),
        "source_label": "Meta 官方业绩披露",
    },
}

ARR_COMPANIES = {
    "openai": {
        "name": "OpenAI",
        "hosts": (
            "openai.com",
            "cnbc.com",
            "reuters.com",
            "bloomberg.com",
            "axios.com",
            "nytimes.com",
            "ft.com",
            "wsj.com",
        ),
        "bounds": (1, 2000),
    },
    "anthropic": {
        "name": "Anthropic",
        "hosts": (
            "anthropic.com",
            "cnbc.com",
            "reuters.com",
            "bloomberg.com",
            "axios.com",
            "nytimes.com",
            "ft.com",
            "wsj.com",
        ),
        "bounds": (1, 2000),
    },
}

# Some companies publish a written Capex number in the release; others disclose
# it only on the earnings call. In the latter case, accept a narrow set of
# reputable outlets that directly quote/report the call, while keeping official
# investor-relations pages as the preferred source.
TRUSTED_CAPEX_HOSTS = ("apnews.com", "reuters.com", "cnbc.com")
TRUSTED_CAPEX_LABELS = {
    "apnews.com": "AP · Amazon业绩会",
    "reuters.com": "Reuters · 公司业绩会",
    "cnbc.com": "CNBC · 公司业绩会",
}


def now_ts():
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz8).strftime("%Y-%m-%d %H:%M:%S")


def _extract_date(*values):
    """Return YYYY-MM-DD from RSS, metadata, page text or a dated URL."""
    joined = " ".join(str(value or "") for value in values)
    # ISO timestamps continue with "T", so a trailing word boundary would miss
    # values such as 2026-07-30T20:26:37Z.
    match = re.search(
        r"(?<!\d)(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?=$|[T\s])",
        joined,
    )
    if match:
        year, month, day = (int(part) for part in match.groups())
        try:
            return datetime.date(year, month, day).isoformat()
        except ValueError:
            pass
    for pattern in (
        r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(20\d{2})\b",
        r"\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b",
    ):
        match = re.search(pattern, joined, re.I)
        if not match:
            continue
        for fmt in ("%B %d, %Y", "%d %B %Y"):
            try:
                return datetime.datetime.strptime(match.group(0), fmt).date().isoformat()
            except ValueError:
                continue
    for value in values:
        try:
            parsed = parsedate_to_datetime(str(value or ""))
            if parsed:
                return parsed.date().isoformat()
        except (TypeError, ValueError, OverflowError):
            continue
    return ""


def _host_allowed(url, hosts):
    try:
        host = (urlparse(url).hostname or "").lower()
        return any(host == h or host.endswith("." + h) for h in hosts)
    except Exception:
        return False


def _normalized_source_url(url):
    try:
        parsed = urlparse(url)
        return (
            parsed.scheme.lower(),
            (parsed.hostname or "").lower(),
            re.sub(r"/+$", "", parsed.path or ""),
        )
    except Exception:
        return ("", "", "")


def _specific_article_url(url):
    scheme, host, path = _normalized_source_url(url)
    return scheme == "https" and bool(host) and path not in ("", "/index.html")


def ddg_search(query, hosts, n=8):
    """Return only official-domain DuckDuckGo results, including source URLs."""
    try:
        try:
            from ddgs import DDGS
        except ImportError:
            # Backward compatible with the package name already used by the workflow.
            from duckduckgo_search import DDGS

        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=n))
        results = []
        for item in raw:
            url = item.get("href") or item.get("url") or ""
            if not _host_allowed(url, hosts):
                continue
            results.append(
                {
                    "title": str(item.get("title") or "")[:240],
                    "body": str(item.get("body") or "")[:1200],
                    "url": url,
                    "date": str(item.get("date") or item.get("published") or "")[:40],
                }
            )
        print(f'  [DDG] "{query[:64]}" -> {len(results)} official results')
        return results
    except Exception as exc:
        print(f'  [DDG] "{query[:64]}" failed: {exc}')
        return []


def _clean_text(value):
    value = re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", value or "")
    value = re.sub(r"(?s)<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def _direct_url(value):
    """Extract a direct destination from a search-engine redirect when present."""
    try:
        parsed = urlparse(value)
        query = parse_qs(parsed.query)
        for key in ("url", "u", "target"):
            if query.get(key):
                return unquote(query[key][0])
    except Exception:
        pass
    return value


def bing_rss_search(query, hosts, n=8):
    """Use Bing's RSS endpoint as an independent search fallback."""
    url = "https://www.bing.com/search?" + urlencode(
        {"q": query, "format": "rss", "setlang": "en-US"}
    )
    try:
        response = requests.get(
            url,
            headers={"User-Agent": "Mozilla/5.0 AITrendMonitor/1.0"},
            timeout=25,
        )
        response.raise_for_status()
        root = ET.fromstring(response.content)
        results = []
        for item in root.findall(".//item"):
            link = _direct_url(item.findtext("link") or "")
            if not _host_allowed(link, hosts):
                continue
            results.append(
                {
                    "title": _clean_text(item.findtext("title") or "")[:240],
                    "body": _clean_text(item.findtext("description") or "")[:1200],
                    "url": link,
                    "date": str(item.findtext("pubDate") or "")[:40],
                }
            )
            if len(results) >= n:
                break
        print(f'  [Bing RSS] "{query[:58]}" -> {len(results)} allowlisted results')
        return results
    except Exception as exc:
        print(f'  [Bing RSS] "{query[:58]}" failed: {exc}')
        return []


def fetch_page_result(url, hosts):
    """Fetch one allowlisted page and keep text around Capex/ARR evidence."""
    if not _host_allowed(url, hosts):
        return None
    try:
        response = requests.get(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 AITrendMonitor/1.0",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
            },
            timeout=25,
        )
        response.raise_for_status()
        final_url = response.url
        if not _host_allowed(final_url, hosts):
            return None
        raw = response.text
        title_match = re.search(r"(?is)<title[^>]*>(.*?)</title>", raw)
        title = _clean_text(title_match.group(1) if title_match else final_url)[:240]
        text = _clean_text(raw)
        date_meta = ""
        for pattern in (
            r'(?is)"datePublished"\s*:\s*"([^"]+)"',
            r"(?is)(?:article:published_time|datePublished)[^>]{0,160}?content=[\"']([^\"']+)",
            r"(?is)<time[^>]+datetime=[\"']([^\"']+)",
        ):
            date_match = re.search(pattern, raw)
            if date_match:
                date_meta = date_match.group(1)
                break
        windows = []
        for match in re.finditer(
            r"(?i)capital expenditures?|capex|capital spending|annualized recurring revenue|revenue run[- ]rate",
            text,
        ):
            window = text[max(0, match.start() - 420) : match.end() + 1100]
            lower = window.lower()
            score = sum(
                weight
                for pattern, weight in (
                    (r"full[- ]year|calendar year|cy ?2026", 6),
                    (r"guidance|outlook|expect|forecast|approximately|range", 5),
                    (r"2026", 3),
                    (r"quarter|q[1-4]|three months", -4),
                    (r"cash paid|actual", -2),
                )
                if re.search(pattern, lower)
            )
            windows.append((score, window))
        windows.sort(key=lambda item: item[0], reverse=True)
        body = (
            " … ".join(window for _, window in windows[:4])[:3200]
            if windows
            else text[:1400]
        )
        return {
            "title": title,
            "body": body,
            "url": final_url,
            "date": _extract_date(date_meta, final_url, text[:500]),
        }
    except Exception as exc:
        print(f"  [Direct] {url[:88]} failed: {exc}")
        return None


def discover_official_urls(cfg):
    """Discover recent earnings links directly from each company's IR landing page."""
    discovered = []
    current_year = str(datetime.date.today().year)
    for landing in cfg.get("landing_urls", ()):
        if not _host_allowed(landing, cfg["hosts"]):
            continue
        try:
            response = requests.get(
                landing,
                headers={"User-Agent": "Mozilla/5.0 AITrendMonitor/1.0"},
                timeout=25,
            )
            response.raise_for_status()
            for href in re.findall(r"""(?i)href\s*=\s*["']([^"'#]+)""", response.text):
                candidate = urljoin(response.url, html.unescape(href))
                if not _host_allowed(candidate, cfg["hosts"]):
                    continue
                if "{" in candidate or "%7b" in candidate.lower():
                    continue
                if not re.search(
                    r"(?i)earnings|quarter|results|financial|event|press-release|news-release",
                    candidate,
                ):
                    continue
                discovered.append(candidate)
        except Exception as exc:
            print(f"  [Landing] {landing} failed: {exc}")
    # New-year links first, then preserve landing-page order.
    return sorted(
        dict.fromkeys(discovered),
        key=lambda value: (current_year not in value, value),
    )[:4]


def discover_trusted_results(key, cfg):
    """Crawl configured trusted company hubs for fresh call-report articles."""
    results = []
    seen = set()
    company_path_terms = {
        "alphabet": ("alphabet", "google"),
        "microsoft": ("microsoft",),
        "amazon": ("amazon", "aws"),
        "meta": ("meta",),
    }.get(key, (key,))
    for landing in cfg.get("trusted_landing_urls", ()):
        if not _host_allowed(landing, TRUSTED_CAPEX_HOSTS):
            continue
        try:
            response = requests.get(
                landing,
                headers={"User-Agent": "Mozilla/5.0 AITrendMonitor/1.0"},
                timeout=25,
            )
            response.raise_for_status()
            candidates = []
            for href in re.findall(r'''(?i)href\s*=\s*["']([^"'#]+)''', response.text):
                candidate = urljoin(response.url, html.unescape(href))
                if candidate in seen or not _host_allowed(
                    candidate, TRUSTED_CAPEX_HOSTS
                ):
                    continue
                # Trusted hub pages contain hundreds of navigation links. Only
                # fetch article-shaped links; company binding and Capex guards
                # still decide whether any number is accepted.
                path = (urlparse(candidate).path or "").lower()
                if "/article/" not in path or not any(
                    term in path for term in company_path_terms
                ):
                    continue
                seen.add(candidate)
                candidates.append(candidate)
            for candidate in candidates[:12]:
                result = fetch_page_result(candidate, TRUSTED_CAPEX_HOSTS)
                if result:
                    results.append(result)
        except Exception as exc:
            print(f"  [Trusted landing] {landing} failed: {exc}")
    print(f"  [Trusted landing] {cfg['name']} -> {len(results)} article results")
    return results


def _merge_results(target, seen, items):
    for item in items:
        url = item.get("url") or ""
        if not url or url in seen:
            continue
        seen.add(url)
        target.append(item)


def latest_official_results(cfg, saved_source_url=""):
    """Combine direct IR discovery with two independent web-search paths."""
    today = datetime.date.today()
    quarter = (today.month - 1) // 3 + 1
    host = cfg["hosts"][0]
    queries = [
        cfg["query"],
        f"site:{host} {today.year} Q{quarter} earnings call full year {today.year} CapEx guidance",
        f"site:{host} latest {today.year} earnings transcript capital expenditures guidance",
    ]
    merged = []
    seen = set()
    direct_urls = [saved_source_url, *cfg.get("landing_urls", ())]
    direct_urls.extend(discover_official_urls(cfg))
    for url in direct_urls:
        if not url or url in seen:
            continue
        result = fetch_page_result(url, cfg["hosts"])
        if result:
            _merge_results(merged, seen, [result])
    for query in queries:
        _merge_results(merged, seen, bing_rss_search(query, cfg["hosts"], n=8))
        _merge_results(merged, seen, ddg_search(query, cfg["hosts"], n=8))
    print(f"  [Capex] {cfg['name']} -> {len(merged)} verified candidates")
    # Keep the prompt balanced: every company must fit in the extraction context.
    return merged[:5]


def latest_capex_results(key, cfg, saved_source_url=""):
    """Combine official evidence with tightly allowlisted earnings-call reports."""
    merged = latest_official_results(cfg, saved_source_url)
    seen = {item.get("url") for item in merged}
    name = cfg["name"].split("/")[0].strip()
    year = datetime.date.today().year
    media_hosts = cfg["hosts"] + TRUSTED_CAPEX_HOSTS
    queries = [
        f'"{name}" {year} "cash CapEx" guidance earnings call',
        f'"{name}" {year} capital spending total latest earnings',
        f'"{name}" raises {year} capital expenditures guidance',
    ]
    media = []
    _merge_results(media, seen, discover_trusted_results(key, cfg))
    for query in queries:
        _merge_results(media, seen, bing_rss_search(query, media_hosts, n=8))
        _merge_results(media, seen, ddg_search(query, media_hosts, n=8))
    # Expand the freshest snippets into page evidence where the site permits it.
    for item in media[:6]:
        expanded = fetch_page_result(item.get("url") or "", media_hosts)
        if expanded:
            if not expanded.get("date"):
                expanded["date"] = _extract_date(
                    item.get("date"), item.get("body"), item.get("url")
                )
            merged.append(expanded)
        else:
            item["date"] = _extract_date(
                item.get("date"), item.get("body"), item.get("url")
            )
            merged.append(item)
    print(f"  [Capex evidence] {key} -> {len(merged)} candidates")
    return merged[:11]


_MONEY_RE = re.compile(
    r"\$?\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*(billion|bn|million|mn)\b", re.I
)
_CAPEX_RE = re.compile(
    r"\b(?:cash\s+)?(?:capital expenditures?|capex|capital spending)\b", re.I
)


def _money_yi(match):
    value = float(match.group(1))
    unit = match.group(2).lower()
    return value * 10 if unit in ("billion", "bn") else value / 100


def _capex_candidate(key, cfg, results):
    """Extract the newest explicit full-year Capex guidance without an LLM."""
    minimum, maximum = cfg["bounds"]
    candidates = []
    allowed_hosts = cfg["hosts"] + TRUSTED_CAPEX_HOSTS
    for result in results:
        url = str(result.get("url") or "")
        if not _host_allowed(url, allowed_hosts):
            continue
        is_official = _host_allowed(url, cfg["hosts"])
        source_date = _extract_date(
            result.get("date"), result.get("title"), result.get("body"), url
        )
        if not source_date:
            continue
        text = _clean_text(
            f"{result.get('title', '')}. {result.get('body', '')}"
        )
        lower = text.lower()
        for capex_match in _CAPEX_RE.finditer(lower):
            window_start = max(0, capex_match.start() - 260)
            window_end = min(len(text), capex_match.end() + 300)
            window = text[window_start:window_end]
            # Call reports commonly say "this year" instead of repeating the
            # calendar year. The source date has already been verified above,
            # so that wording safely binds the guidance to its publication year.
            source_year = source_date[:4]
            period_window = text[
                max(0, capex_match.start() - 650) : min(
                    len(text), capex_match.end() + 650
                )
            ]
            if source_year not in period_window and not re.search(
                r"\b(?:this|current|full)[- ]year(?:['’]s)?\b|\bfor the year\b",
                period_window,
                re.I,
            ):
                continue
            if not is_official:
                relative_capex = capex_match.start() - window_start
                entities = []
                for entity_key, pattern in (
                    ("alphabet", r"\balphabet\b|\bgoogle\b"),
                    ("microsoft", r"\bmicrosoft\b"),
                    ("amazon", r"\bamazon\b|\baws\b"),
                    ("meta", r"\bmeta\b"),
                ):
                    for entity_match in re.finditer(pattern, window, re.I):
                        entities.append(
                            (
                                min(
                                    abs(entity_match.start() - relative_capex),
                                    abs(entity_match.end() - relative_capex),
                                ),
                                entity_key,
                            )
                        )
                if not entities or min(entities)[1] != key:
                    continue
            money = list(_MONEY_RE.finditer(window))
            if not money:
                continue
            # Prefer a genuine written range when two adjacent monetary values
            # are joined by "to", "through", a dash, or "between ... and".
            range_values = None
            for left, right in zip(money, money[1:]):
                between = window[left.end():right.start()].lower()
                if len(between) <= 55 and re.search(
                    r"\b(?:to|through|and)\b|[-–—]", between
                ):
                    lo, hi = _money_yi(left), _money_yi(right)
                    if minimum <= lo <= hi <= maximum:
                        range_values = (lo, hi)
                        break
            if range_values:
                low, high = range_values
                guidance_type = "range"
                selected_start, selected_end = left.start(), right.end()
            else:
                # The closest monetary value to the Capex phrase is normally
                # the current point guidance; this avoids selecting a prior
                # estimate mentioned later in the same quote.
                relative_capex = capex_match.start() - window_start
                nearest = min(
                    money,
                    key=lambda item: min(
                        abs(item.start() - relative_capex),
                        abs(item.end() - relative_capex),
                    ),
                )
                low = high = _money_yi(nearest)
                guidance_type = "point"
                if not (minimum <= low <= maximum):
                    continue
                selected_start, selected_end = nearest.start(), nearest.end()
            # A report often contrasts the new plan with last year's actual or
            # a previous plan in the same paragraph. Bind the monetary value to
            # its nearest Capex phrase and reject locally historical wording.
            relative_capex_end = capex_match.end() - window_start
            focus_start = max(0, min(relative_capex, selected_start) - 40)
            focus_end = min(
                len(window), max(relative_capex_end, selected_end) + 80
            )
            focus = window[focus_start:focus_end].lower()
            local_forward = bool(
                re.search(
                    r"\bexpect|\bplan|\bguidance|\bwill\s+(?:spend|invest)|"
                    r"\bapproximately|\babout|\broughly|\bthis year",
                    focus,
                )
            )
            if re.search(
                r"\blast year|\bprior year|\bprevious year|\ball of last year|\bactual",
                focus,
            ) and not local_forward:
                continue
            evidence = window.lower()
            forward_score = sum(
                bool(re.search(pattern, evidence))
                for pattern in (
                    r"\bexpect",
                    r"\bbelieve",
                    r"\bplan",
                    r"\bguidance",
                    r"\bapproximately|\babout|\broughly",
                    r"\bwill\s+(?:spend|invest)",
                    r"\bfull[- ]year|\bcalendar year",
                )
            )
            if not forward_score:
                continue
            host = (urlparse(url).hostname or "").lower().removeprefix("www.")
            basis = (
                "CY2026 · 公司正式Capex指引"
                if is_official
                else "CY2026 · 公司业绩会指引（可信媒体转述）"
            )
            if key == "amazon" and high >= 2200 and "memory" in evidence:
                basis = "CY2026 · 现金Capex约$220B；内存成本上升推动较此前指引上调"
            candidates.append(
                {
                    "guidance_low_yi": round(low, 1),
                    "guidance_high_yi": round(high, 1),
                    "guidance_type": guidance_type,
                    "basis_note": basis,
                    "source_date": source_date,
                    "source_url": url,
                    "source_label": (
                        cfg["source_label"]
                        if is_official
                        else TRUSTED_CAPEX_LABELS.get(host, host)
                    ),
                    "_score": forward_score + (4 if local_forward else 0) + (3 if is_official else 0),
                }
            )
    if not candidates:
        return {}
    candidates.sort(
        key=lambda item: (item["source_date"], item["_score"]), reverse=True
    )
    chosen = dict(candidates[0])
    chosen.pop("_score", None)
    return chosen


def latest_arr_results(key, cfg):
    """Search recent company and reliable-media ARR disclosures."""
    today = datetime.date.today()
    name = cfg["name"]
    queries = [
        f'"{name}" "annualized recurring revenue" latest {today.year}',
        f'"{name}" ARR revenue run rate latest {today.year}',
        f'"{name}" CFO annualized revenue latest',
        f'site:{cfg["hosts"][0]} {name} revenue ARR {today.year}',
    ]
    merged = []
    seen = set()
    for query in queries:
        _merge_results(merged, seen, bing_rss_search(query, cfg["hosts"], n=8))
        _merge_results(merged, seen, ddg_search(query, cfg["hosts"], n=8))
    print(f"  [ARR] {key} -> {len(merged)} allowlisted results")
    return merged[:5]


def _arr_candidate(key, cfg, results):
    """Extract only explicit ARR/annualized-revenue numbers from source snippets."""
    candidates = []
    for result in results:
        url = str(result.get("url") or "")
        if not _host_allowed(url, cfg["hosts"]) or not _specific_article_url(url):
            continue
        source_date = _extract_date(
            result.get("date"), result.get("title"), result.get("body"), url
        )
        if not source_date:
            continue
        text = _clean_text(
            f"{result.get('title', '')}. {result.get('body', '')}"
        )
        lower = text.lower()
        terms = list(
            re.finditer(
                r"\barr\b|annualized recurring revenue|annualized revenue|revenue run[- ]rate",
                lower,
            )
        )
        for term in terms:
            window_start = max(0, term.start() - 190)
            window = text[window_start:term.end() + 190]
            window_lower = window.lower()
            target = cfg["name"].lower()
            entities = []
            for entity in ("openai", "anthropic", "aws", "amazon", "microsoft", "google", "meta"):
                for match in re.finditer(rf"\b{re.escape(entity)}\b", window_lower):
                    entities.append(
                        (
                            min(
                                abs(match.start() - (term.start() - window_start)),
                                abs(match.end() - (term.start() - window_start)),
                            ),
                            entity,
                        )
                    )
            # Bind the number to the company nearest the ARR phrase. This avoids
            # assigning AWS's run rate to OpenAI merely because both appear in
            # the same article snippet.
            if not entities or min(entities)[1] != target:
                continue
            money = list(_MONEY_RE.finditer(window))
            if not money:
                continue
            relative = term.start() - window_start
            nearest = min(
                money,
                key=lambda item: min(
                    abs(item.start() - relative), abs(item.end() - relative)
                ),
            )
            value = _money_yi(nearest)
            minimum, maximum = cfg["bounds"]
            if not (minimum <= value <= maximum):
                continue
            host = (urlparse(url).hostname or "").lower().removeprefix("www.")
            candidates.append(
                {
                    "company": cfg["name"],
                    "summary": f"最新公开披露的年化收入运行率约为${value / 10:g}B。",
                    "numeric": True,
                    "arr_yi": round(value, 1),
                    "source_label": host,
                    "source_date": source_date,
                    "source_url": url,
                }
            )
    if not candidates:
        return {}
    candidates.sort(key=lambda item: item["source_date"], reverse=True)
    return candidates[0]


def _number(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _valid_date(value):
    value = str(value or "")
    return value if re.fullmatch(r"20\d{2}-\d{2}-\d{2}", value) else ""


def _last_numeric(values):
    for value in reversed(values or []):
        number = _number(value)
        if number is not None:
            return number
    return None


def _upsert_arr_value(base, key, source_date, value):
    labels = base.setdefault("arr_labels", [])
    openai = base.setdefault("arr_openai", [])
    anthropic = base.setdefault("arr_anthropic", [])
    while len(openai) < len(labels):
        openai.append(None)
    while len(anthropic) < len(labels):
        anthropic.append(None)
    label = source_date[:7]
    if label not in labels:
        labels.append(label)
        openai.append(None)
        anthropic.append(None)
    index = labels.index(label)
    series = openai if key == "openai" else anthropic
    current = _number(series[index])
    if current is None or value > current:
        series[index] = round(value, 1)
        return True
    return False


def main():
    print("=== scheduled AI trend refresh ===")
    try:
        with open(OUT, encoding="utf-8") as handle:
            base = json.load(handle)
    except Exception:
        base = {}

    saved_capex = base.get("capex_companies") or {}
    capex_results = {
        key: latest_capex_results(
            key,
            cfg,
            str((saved_capex.get(key) or {}).get("source_url") or ""),
        )
        for key, cfg in COMPANIES.items()
    }
    arr_results = {
        key: latest_arr_results(key, cfg) for key, cfg in ARR_COMPANIES.items()
    }
    scan_succeeded = any(capex_results.values()) or any(arr_results.values())
    if not scan_succeeded:
        print("No allowlisted search results; preserving snapshot and last-checked time.")
        return

    changed = False
    capex_changed = False

    if any(capex_results.values()):
        extracted = {
            key: _capex_candidate(key, cfg, capex_results.get(key, []))
            for key, cfg in COMPANIES.items()
        }

        current = base.setdefault("capex_companies", {})
        for key, cfg in COMPANIES.items():
            candidate = extracted.get(key) or {}
            low = _number(candidate.get("guidance_low_yi"))
            high = _number(candidate.get("guidance_high_yi"))
            url = str(candidate.get("source_url") or "")
            source_date = _valid_date(candidate.get("source_date"))
            previous = dict(current.get(key) or {})
            previous_date = _valid_date(previous.get("source_date"))
            minimum, maximum = cfg["bounds"]
            rejection_reasons = []
            if low is None or high is None:
                rejection_reasons.append("missing guidance")
            elif not (minimum <= low <= high <= maximum):
                rejection_reasons.append(f"out of bounds {low}-{high}")
            if not _host_allowed(url, cfg["hosts"] + TRUSTED_CAPEX_HOSTS):
                rejection_reasons.append(
                    f"source domain {(urlparse(url).hostname or 'missing')}"
                )
            if not source_date:
                rejection_reasons.append("missing source date")
            elif previous_date and source_date < previous_date:
                rejection_reasons.append("older source date")
            if rejection_reasons:
                print(
                    f"  [{key}] rejected "
                    f"(candidate={source_date or 'no-date'}, "
                    f"saved={previous_date or 'none'}; "
                    f"reason={'; '.join(rejection_reasons)}); keeping previous values"
                )
                continue

            core_unchanged = (
                _number(previous.get("guidance_low_yi")) == low
                and _number(previous.get("guidance_high_yi")) == high
                and previous_date == source_date
            )
            if core_unchanged:
                print(f"  [{key}] latest guidance verified unchanged")
                continue

            default_basis = (
                "CY2026 · 公司正式指引区间"
                if high != low
                else "CY2026 · 点指引，未披露上下限"
            )
            basis_note = str(candidate.get("basis_note") or "").strip()[:180]
            item = dict(previous)
            item.update(
                {
                    "display_name": cfg["name"],
                    "guidance_low_yi": round(low, 1),
                    "guidance_high_yi": round(high, 1),
                    "guidance_type": "range" if high != low else "point",
                    "period": "CY2026",
                    "basis_note": basis_note or default_basis,
                    "source_label": candidate.get("source_label") or cfg["source_label"],
                    "source_date": source_date,
                    "source_url": url,
                }
            )
            current[key] = item
            changed = capex_changed = True
            print(f"  [{key}] updated to {low}-{high} from {url}")

        if capex_changed and all(key in current for key in COMPANIES):
            lows = [float(current[key]["guidance_low_yi"]) for key in COMPANIES]
            highs = [float(current[key]["guidance_high_yi"]) for key in COMPANIES]
            actuals = [
                _number(current[key].get("actual_2025_yi")) for key in COMPANIES
            ]
            low_total = round(sum(lows), 1)
            high_total = round(sum(highs), 1)
            mid_total = round((low_total + high_total) / 2, 1)
            base["hyperscaler_capex_2026e_low_yi"] = low_total
            base["hyperscaler_capex_2026e_mid_yi"] = mid_total
            base["hyperscaler_capex_2026e_high_yi"] = high_total
            base["hyperscaler_capex_2026e_yi"] = mid_total
            if all(value is not None for value in actuals):
                actual_total = round(sum(actuals), 1)
                base["hyperscaler_capex_2025a_yi"] = actual_total
                base["hyperscaler_yoy_pct"] = round(
                    (mid_total / actual_total - 1) * 100, 1
                )
            source_dates = [
                item.get("source_date", "")
                for item in current.values()
                if item.get("source_date")
            ]
            if source_dates:
                base["capex_as_of"] = max(source_dates)
            base["capex_unit"] = "USD 100 million"
            base["hyperscaler_detail"] = " · ".join(
                f"{key.upper()} "
                + (
                    f"${item['guidance_low_yi'] / 10:g}–{item['guidance_high_yi'] / 10:g}B"
                    if item["guidance_low_yi"] != item["guidance_high_yi"]
                    else f"~${item['guidance_high_yi'] / 10:g}B"
                )
                for key, item in current.items()
                if key in COMPANIES
            )
            amazon = current.get("amazon") or {}
            meta = current.get("meta") or {}
            base["amazon_capex_2026e_yi"] = amazon.get("guidance_high_yi")
            base["meta_capex_low_yi"] = meta.get("guidance_low_yi")
            base["meta_capex_high_yi"] = meta.get("guidance_high_yi")

    if any(arr_results.values()):
        arr_extracted = {
            key: _arr_candidate(key, cfg, arr_results.get(key, []))
            for key, cfg in ARR_COMPANIES.items()
        }

        events = base.setdefault("arr_latest_events", {})
        sources = base.setdefault("arr_sources", {})
        for key, cfg in ARR_COMPANIES.items():
            candidate = arr_extracted.get(key) or {}
            summary = re.sub(r"\s+", " ", str(candidate.get("summary") or "")).strip()
            summary = summary[:240]
            url = str(candidate.get("source_url") or "")
            source_date = _valid_date(candidate.get("source_date"))
            previous_event = dict(events.get(key) or {})
            previous_date = _valid_date(previous_event.get("source_date"))
            value = _number(candidate.get("arr_yi"))
            if value is not None and value <= 0:
                value = None
            minimum, maximum = cfg["bounds"]
            scanned_urls = {
                _normalized_source_url(item.get("url") or "")
                for item in arr_results.get(key, [])
            }
            rejection_reasons = []
            if not summary:
                rejection_reasons.append("missing summary")
            elif re.search(
                r"(?i)未披露.{0,18}(arr|收入|营收|金额)|没有披露|no (?:new )?.{0,12}(arr|revenue).{0,12}disclos|not disclos",
                summary,
            ):
                rejection_reasons.append("no new milestone")
            if not source_date:
                rejection_reasons.append("missing source date")
            elif previous_date and source_date < previous_date:
                rejection_reasons.append("older source date")
            if not _host_allowed(url, cfg["hosts"]):
                rejection_reasons.append(
                    f"source domain {(urlparse(url).hostname or 'missing')}"
                )
            elif not _specific_article_url(url):
                rejection_reasons.append("generic source page")
            elif _normalized_source_url(url) not in scanned_urls:
                rejection_reasons.append("source not present in scan results")
            if (
                previous_event
                and previous_date
                and source_date == previous_date
                and _normalized_source_url(url)
                != _normalized_source_url(previous_event.get("source_url") or "")
                and value is None
            ):
                rejection_reasons.append("same-date event already preserved")
            if value is not None and not (minimum <= value <= maximum):
                rejection_reasons.append(f"out of bounds {value}")
            if rejection_reasons:
                print(
                    f"  [ARR:{key}] rejected "
                    f"(candidate={source_date or 'no-date'}, "
                    f"saved={previous_date or 'none'}; "
                    f"reason={'; '.join(rejection_reasons)})"
                )
                continue

            last_value = _last_numeric(
                base.get("arr_openai") if key == "openai" else base.get("arr_anthropic")
            )
            if value is not None and last_value is not None and value < last_value:
                print(
                    f"  [ARR:{key}] numeric value {value} is below saved "
                    f"milestone {last_value}; rejecting"
                )
                continue

            source_label = (
                re.sub(r"\s+", " ", str(candidate.get("source_label") or "")).strip()[:60]
                or (urlparse(url).hostname or "").replace("www.", "")
            )
            event = {
                "company": cfg["name"],
                "summary": summary,
                "numeric": value is not None,
                "source_label": source_label,
                "source_date": source_date,
                "source_url": url,
            }
            if value is not None:
                event["arr_yi"] = round(value, 1)
            if event != previous_event:
                events[key] = event
                changed = True
                print(f"  [ARR:{key}] accepted latest event from {url}")
            else:
                print(f"  [ARR:{key}] latest event verified unchanged")

            if value is not None and _upsert_arr_value(base, key, source_date, value):
                sources[key] = {
                    "source_label": source_label,
                    "source_date": source_date,
                    "source_url": url,
                }
                changed = True
            valid_event_dates = [
                item.get("source_date", "")
                for item in events.values()
                if item.get("source_date")
            ]
            if valid_event_dates:
                base["arr_as_of"] = max(valid_event_dates)

    timestamp = now_ts()
    if changed:
        base["updated"] = timestamp
    # Every successful scan advances last_checked. The browser uses this field
    # to decide whether opening the macro tab should dispatch an immediate scan.
    base["last_checked"] = timestamp
    base["scan_interval_hours"] = 3
    base["scanner_method"] = "local-evidence-v1"
    base["note"] = (
        "GitHub Actions每3小时自动扫描；优先采用四家公司官方投资者关系披露，"
        "业绩会仅在官方文字稿不可得时采用AP/Reuters/CNBC直接报道"
    )
    base["arr_note"] = (
        "年化收入运行率公开里程碑（非传统合同ARR） · "
        "仅提取来源明确给出的金额，不从增速或定性表述反推数值"
    )
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(base, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"Wrote {OUT} (changed={changed}; scan heartbeat advanced)")


if __name__ == "__main__":
    main()
