#!/usr/bin/env python3
"""Refresh hyperscaler cloud revenue, Capex guidance and frontier-AI ARR milestones.

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
import math
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
            r"(?i)capital expenditures?|capex|capital spending|annualized recurring revenue|revenue run[- ]rate|google cloud.{0,50}revenue|aws.{0,35}(?:net )?sales|microsoft cloud revenue",
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
        cloud_windows = []
        for match in re.finditer(
            r"(?i)google cloud.{0,50}revenue|aws.{0,35}(?:net )?sales|microsoft cloud revenue",
            text,
        ):
            cloud_windows.append(
                text[max(0, match.start() - 260) : match.end() + 900]
            )
        selected_windows = cloud_windows[:3]
        selected_windows.extend(window for _, window in windows[:4])
        body = (
            " … ".join(selected_windows)[:6400]
            if selected_windows
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
_CAPEX_RANGE_RE = re.compile(
    r"(?<![\d.])\$?\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*"
    r"(billion|bn|million|mn)?\s*(to|through|[-–—]|and)\s*"
    r"\$?\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*(billion|bn|million|mn)\b", re.I
)


def _capex_statement(text, anchor):
    """Bind one amount to its own statement, not a distant annual outlook.

    Decimal points are not sentence boundaries. Contrasts introduce a separate
    prior guide/actual and must not supply the current guidance's year or verb.
    """
    boundaries = [0, len(text)]
    for match in re.finditer(
        r"(?<!\d)[.!?;](?!\d)\s*|\b(?:compared with|compared to|versus|whereas)\b|"
        r",\s*(?:and|but|while)\s+(?=(?:we|our|for|in|the company)\b)", text, re.I
    ):
        boundaries.extend((match.start(), match.end()))
    return max(value for value in boundaries if value <= anchor), min(
        value for value in boundaries if value > anchor
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
            statement_start, statement_end = _capex_statement(text, capex_match.start())
            window_start = max(statement_start, capex_match.start() - 260)
            window_end = min(statement_end, capex_match.end() + 300)
            window = text[window_start:window_end]
            relative_capex = capex_match.start() - window_start
            # This field is specifically CY2026. A fiscal year, quarter, nine
            # months, or next-year plan cannot become that annual guide merely
            # because the release title/publication date contains "2026".
            if re.search(r"\bfiscal\b|\bFY\s*(?:20)?\d{2}\b", window, re.I):
                continue
            if re.search(r"\bQ[1-4]\b|\bquarter(?:s|ly)?\b|\b(?:three|six|nine|3|6|9)[- ]months?\b|\b[369]M\b|"
                         r"\bfirst half\b|\byear[- ]to[- ]date\b|\bYTD\b", window, re.I):
                continue
            years = set(re.findall(r"\b20\d{2}\b", window))
            current_year = source_date.startswith("2026-") and bool(re.search(
                r"\b(?:this|current)[- ]year(?:['’]s)?\b|\bfor the year\b", window, re.I
            ))
            if (years and years != {"2026"}) or ("2026" not in years and not current_year):
                continue
            # Microsoft normally discusses fiscal-year investment. Without an
            # explicit calendar-year label, do not silently rename FY as CY.
            if key == "microsoft" and not re.search(r"\b(?:calendar(?: year)?|CY)\s*2026\b", window, re.I):
                continue
            if not is_official:
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
            # Accept both "$185 to $190 billion" and "$185 billion to
            # $190 billion". A lone unit must apply to both endpoints.
            range_values = None
            range_matches = sorted(_CAPEX_RANGE_RE.finditer(window), key=lambda item:
                min(abs(item.start() - relative_capex), abs(item.end() - relative_capex)))
            for interval in range_matches:
                left_value, left_unit, connector, right_value, right_unit = interval.groups()
                if connector.lower() == "and" and not re.search(r"\bbetween\s*$", window[max(0, interval.start()-20):interval.start()], re.I):
                    continue
                left_unit = (left_unit or right_unit).lower()
                right_unit = right_unit.lower()
                lo = float(left_value) * (10 if left_unit in ("billion", "bn") else .01)
                hi = float(right_value) * (10 if right_unit in ("billion", "bn") else .01)
                if minimum <= lo <= hi <= maximum:
                    range_values = (lo, hi, interval.start(), interval.end())
                    break
            if range_values:
                low, high, selected_start, selected_end = range_values
                guidance_type = "range"
            else:
                # The closest monetary value to the Capex phrase is normally
                # the current point guidance; this avoids selecting a prior
                # estimate mentioned later in the same quote.
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
            # "Capex was $X ... we expect demand to grow" still reports an
            # actual, even if its sentence happens to contain a forward verb.
            if relative_capex_end <= selected_start:
                amount_bridge = window[relative_capex_end:selected_start].lower()
                if re.search(r"\b(?:was|were|totaled|totalled|amounted|reached)\b", amount_bridge) and not re.search(
                    r"\b(?:expected|planned|estimated|forecast|guidance|outlook)\b", amount_bridge
                ):
                    continue
            local_forward = bool(
                re.search(
                    r"\bexpect|\bplan|\bguidance|\bwill\s+(?:be|total|amount|reach|spend|invest)|"
                    r"\boutlook|\bforecast",
                    focus,
                )
            )
            if not local_forward:
                continue
            if re.search(
                r"\blast year|\bprior\b|\bprevious\b|\bpreviously\b|\bearlier\b|\bactual",
                focus,
            ):
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
                    r"\bwill\s+(?:be|total|amount|reach|spend|invest)",
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


CLOUD_REVENUE_KEYS = ("alphabet", "amazon", "microsoft")
_CLOUD_REVENUE_PATTERNS = {
    "alphabet": (
        re.compile(
            r"Google Cloud.{0,260}?revenues?.{0,100}?\bto\s+\$?([0-9]{1,3}(?:\.[0-9]+)?)\s*billion",
            re.I,
        ),
        re.compile(
            r"Google Cloud.{0,120}?revenue(?:s)?\s+(?:was|of)\s+\$?([0-9]{1,3}(?:\.[0-9]+)?)\s*billion",
            re.I,
        ),
    ),
    "amazon": (
        re.compile(
            r"AWS(?:\s+segment)?\s+(?:net\s+)?sales.{0,180}?\bto\s+\$?([0-9]{1,3}(?:\.[0-9]+)?)\s*billion",
            re.I,
        ),
        re.compile(
            r"AWS.{0,100}?annualized revenue run rate.{0,40}?\$?([0-9]{1,3}(?:\.[0-9]+)?)\s*billion",
            re.I,
        ),
    ),
    "microsoft": (
        re.compile(
            r"Microsoft Cloud revenue(?:\s+(?:was|of))?\s+\$?([0-9]{1,3}(?:\.[0-9]+)?)\s*billion",
            re.I,
        ),
    ),
}


def _calendar_quarter(text, source_date):
    """Return the calendar quarter represented by an earnings release."""
    match = re.search(
        r"(?:quarter|three months) ended\s+(March|June|September|December)\s+\d{1,2},\s*(20\d{2})",
        text or "",
        re.I,
    )
    month_to_quarter = {"march": 1, "june": 2, "september": 3, "december": 4}
    if match:
        return f"{match.group(2)} Q{month_to_quarter[match.group(1).lower()]}"
    try:
        published = datetime.date.fromisoformat(source_date)
    except (TypeError, ValueError):
        return ""
    # Large U.S. cloud vendors normally publish calendar-quarter results in
    # January, April, July and October. This fallback is used only when the
    # page/snippet omitted the explicit quarter-end date.
    if published.month in (1, 2):
        return f"{published.year - 1} Q4"
    if published.month in (4, 5):
        return f"{published.year} Q1"
    if published.month in (7, 8):
        return f"{published.year} Q2"
    if published.month in (10, 11):
        return f"{published.year} Q3"
    return ""


def _cloud_revenue_candidate(key, cfg, results):
    """Extract the newest explicit quarterly cloud-revenue disclosure."""
    candidates = []
    for result in results:
        url = str(result.get("url") or "")
        if not _host_allowed(url, cfg["hosts"]):
            continue
        source_date = _extract_date(
            result.get("date"), result.get("title"), result.get("body"), url
        )
        if not source_date:
            continue
        text = _clean_text(f"{result.get('title', '')}. {result.get('body', '')}")
        for pattern in _CLOUD_REVENUE_PATTERNS[key]:
            match = pattern.search(text)
            if not match:
                continue
            value_b = float(match.group(1))
            # Cloud quarterly revenue is currently between $5B and $100B.
            if not 5 <= value_b <= 100:
                continue
            quarter = _calendar_quarter(text, source_date)
            if not quarter:
                continue
            local = text[max(0, match.start() - 140) : match.end() + 140]
            yoy_match = re.search(
                r"(?:increased|grew|growth(?:\s+of)?)\s+(?:by\s+)?([0-9]{1,3}(?:\.[0-9]+)?)%",
                local,
                re.I,
            )
            candidates.append(
                {
                    "quarter": quarter,
                    "revenue_b": round(value_b, 3),
                    "latest_yoy_pct": (
                        round(float(yoy_match.group(1)), 1) if yoy_match else None
                    ),
                    "source_label": cfg["source_label"].replace("业绩披露", "财报"),
                    "source_date": source_date,
                    "source_url": url,
                }
            )
            break
    if not candidates:
        return {}
    candidates.sort(key=lambda item: item["source_date"], reverse=True)
    return candidates[0]


def _quarter_sort_key(label):
    match = re.fullmatch(r"(20\d{2}) Q([1-4])", str(label or ""))
    return (int(match.group(1)), int(match.group(2))) if match else (0, 0)


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
            statement_start, statement_end = _arr_statement(text, term.start())
            window_start = max(statement_start, term.start() - 190)
            window = text[window_start:min(statement_end, term.end() + 190)]
            window_lower = window.lower()
            if _arr_is_forecast(window):
                continue
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
            money = [item for item in _MONEY_RE.finditer(window)
                     if not re.search(r"\bnot\s*\$?\s*$|\b(?:previously|earlier)\s+(?:reported|indicated|signaled|estimated)(?:\s+(?:at|as))?\s*\$?\s*$", window[max(0, item.start()-60):item.start()], re.I)]
            if not money:
                continue
            relative = term.start() - window_start
            # In a correction, the old amount may be closer to the ARR phrase
            # than the corrected one. Prefer an explicit "corrected to" anchor.
            corrected = [item for item in money if re.search(
                r"\b(?:corrected|revised|restated)\s+(?:down\s+|up\s+)?to\s*\$?\s*$",
                window[max(0, item.start()-55):item.start()], re.I)]
            nearest = min(
                corrected or money,
                key=lambda item: min(
                    abs(item.start() - relative), abs(item.end() - relative)
                ),
            )
            value = _money_yi(nearest)
            minimum, maximum = cfg["bounds"]
            if not (minimum <= value <= maximum):
                continue
            metric_period = _arr_effective_period(window, source_date)
            if not metric_period:
                continue
            host = (urlparse(url).hostname or "").lower().removeprefix("www.")
            candidates.append(
                {
                    "company": cfg["name"],
                    "summary": f"最新公开披露的年化收入运行率约为${value / 10:g}B。",
                    "numeric": True,
                    "arr_yi": round(value, 1),
                    "metric_period": _arr_effective_period(window, source_date),
                    "basis": _arr_basis(window),
                    "correction": bool(re.search(r"correct(?:ed|ion|s).{0,100}(?:revenue|run[- ]rate|arr)|(?:revenue|run[- ]rate|arr).{0,100}correct(?:ed|ion|s)", window, re.I)),
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


def _update_capex_totals(base, companies):
    """Refresh scale totals without reviving a known incomparable YoY claim."""
    if not all(key in companies for key in COMPANIES):
        return False
    lows = [_number(companies[key].get("guidance_low_yi")) for key in COMPANIES]
    highs = [_number(companies[key].get("guidance_high_yi")) for key in COMPANIES]
    if any(value is None or not math.isfinite(value) for value in lows + highs):
        return False
    if any(low <= 0 or high < low for low, high in zip(lows, highs)):
        return False
    low_total, high_total = round(sum(lows), 1), round(sum(highs), 1)
    mid_total = round((low_total + high_total) / 2, 1)
    base.update({"hyperscaler_capex_2026e_low_yi": low_total,
                 "hyperscaler_capex_2026e_mid_yi": mid_total,
                 "hyperscaler_capex_2026e_high_yi": high_total,
                 "hyperscaler_capex_2026e_yi": mid_total})
    actuals = [_number(companies[key].get("actual_2025_yi")) for key in COMPANIES]
    actuals_valid = all(value is not None and math.isfinite(value) and value > 0 for value in actuals)
    if actuals_valid:
        base["hyperscaler_capex_2025a_yi"] = round(sum(actuals), 1)
    comparable = base.get("comparison_comparable") is not False and all(
        companies[key].get("comparison_comparable") is not False for key in COMPANIES
    )
    # A later headline-number refresh cannot erase a reviewed accounting-basis
    # warning (e.g. lease classification) or silently calculate a mixed YoY.
    if not comparable:
        base["comparison_comparable"] = False
        if not str(base.get("comparison_note") or "").strip():
            base["comparison_note"] = "公司披露口径或租赁分类不一致；合计仅作规模观察，不作严格同比。"
    base["hyperscaler_yoy_pct"] = round((mid_total / sum(actuals) - 1) * 100, 1) if comparable and actuals_valid else None
    return True


def _last_numeric(values):
    for value in reversed(values or []):
        number = _number(value)
        if number is not None:
            return number
    return None


def _arr_is_forecast(text):
    return bool(re.search(
        r"\bexpect(?:s|ed|ing)?\b|\bforecast(?:s|ed)?\b|\bproject(?:s|ed|ing)?\b|"
        r"\btarget(?:s|ed|ing)?\b|\baim(?:s|ed|ing)?\b|\bcould\b|\bwould\b|"
        r"\bwill\s+(?:reach|hit|exceed|rise|grow|be)\b|\bon track\b",
        text, re.I))


def _arr_statement(text, anchor):
    """Sentence isolation including sentences ending in a year/amount.
    Only an actual decimal point (digits on both sides) is exempt."""
    boundaries = [0, len(text)]
    for match in re.finditer(r"(?:[!?;]|\.(?!\d)|(?<!\d)\.)\s*", text):
        boundaries.extend((match.start(), match.end()))
    return max(v for v in boundaries if v <= anchor), min(v for v in boundaries if v > anchor)


def _arr_effective_period(text, source_date):
    """Use an explicitly reported month; otherwise label the disclosure month.
    Month-only wording is not promoted into an exact measurement date."""
    try:
        source_year, source_month = map(int, source_date[:7].split("-"))
    except (ValueError, TypeError):
        return ""
    months = {name.lower(): index for index, name in enumerate([
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"], 1)}
    names = "|".join(months)
    explicit = re.search(r"\b("+names+r")\s+(20\d{2})\b", text, re.I)
    if explicit:
        month, year = months[explicit.group(1).lower()], int(explicit.group(2))
        return f"{year:04d}-{month:02d}" if (year, month) <= (source_year, source_month) else ""
    implicit = re.search(r"\b(?:as of|at the end of|by the end of|by end of|end of|in|during|through|for)\s+("+names+r")\b", text, re.I)
    if implicit:
        month = months[implicit.group(1).lower()]
        year = source_year - (month > source_month)
        return f"{year:04d}-{month:02d}"
    return source_date[:7]


def _arr_basis(text):
    if re.search(r"\bgross\b", text, re.I):
        return "gross_annualized_revenue_run_rate"
    if re.search(r"\bnet\s+(?:annualized|revenue)\b", text, re.I):
        return "net_annualized_revenue_run_rate"
    return "annualized_revenue_run_rate"


def _arr_numeric_rejection(base, key, candidate):
    """Date and metric consistency, never a higher-amount-only acceptance rule."""
    value, date = _number(candidate.get("arr_yi")), _valid_date(candidate.get("source_date"))
    if value is None:
        return ""
    if not math.isfinite(value) or value <= 0 or not date or not _specific_article_url(candidate.get("source_url") or ""):
        return "numeric milestone requires a dated direct source"
    if candidate.get("disclosure_type") == "forecast":
        return "forecast is not a realized numeric milestone"
    previous_event = (base.get("arr_latest_events") or {}).get(key) or {}
    previous_source = (base.get("arr_sources") or {}).get(key) or {}
    known = [x for x in [previous_event, previous_source] if _number(x.get("arr_yi")) is not None]
    latest = max(known, key=lambda x: _valid_date(x.get("source_date")), default={})
    previous_date = _valid_date(latest.get("source_date"))
    if previous_date and date < previous_date:
        return "older numeric milestone source"
    period = str(candidate.get("metric_period") or date[:7])
    previous_period = str(latest.get("metric_period") or previous_date[:7])
    if not re.fullmatch(r"20\d{2}-(?:0[1-9]|1[0-2])", period) or period > date[:7]:
        return "invalid or future numeric measurement period"
    if previous_period and period < previous_period:
        return "older numeric measurement period requires historical review"
    previous_basis, basis = latest.get("basis"), candidate.get("basis")
    explicit_bases = {"gross_annualized_revenue_run_rate", "net_annualized_revenue_run_rate"}
    # Legacy JSON used free-form explanatory prose in this field. It cannot
    # lock out all future updates, nor does generic ARR wording establish a
    # gross-to-net accounting change. Reject explicit contradictory concepts.
    if previous_basis in explicit_bases and basis in explicit_bases and previous_basis != basis and not candidate.get("correction"):
        return "run-rate accounting basis changed without a reviewed correction"
    previous_value = _number(latest.get("arr_yi"))
    if previous_date == date and previous_value is not None and value != previous_value and not candidate.get("correction"):
        return "same-date conflicting numeric milestone requires correction evidence"
    return ""


def _upsert_arr_value(base, key, source_date, value, metric_period="", correction=False):
    labels = base.setdefault("arr_labels", [])
    openai = base.setdefault("arr_openai", [])
    anthropic = base.setdefault("arr_anthropic", [])
    while len(openai) < len(labels):
        openai.append(None)
    while len(anthropic) < len(labels):
        anthropic.append(None)
    label = metric_period if re.fullmatch(r"20\d{2}-\d{2}", str(metric_period)) else source_date[:7]
    if not re.fullmatch(r"20\d{2}-\d{2}", label) or _number(value) is None or value <= 0:
        return False
    saved = (base.get("arr_sources") or {}).get(key) or {}
    if _valid_date(saved.get("source_date")) > source_date:
        return False
    if label not in labels:
        labels.append(label); openai.append(None); anthropic.append(None)
    index = labels.index(label)
    series = openai if key == "openai" else anthropic
    current = _number(series[index])
    if current == round(value, 1):
        return False
    # Main validation establishes a dated, same-basis disclosure. A lower real
    # amount or same-period correction is valid and must not be hidden.
    series[index] = round(value, 1)
    def chronological(label):
        match = re.match(r"(20\d{2})(?:-(\d{2})|末)", str(label))
        return (int(match.group(1)), int(match.group(2) or 12)) if match else (0, 0)
    order = sorted(range(len(labels)), key=lambda i: chronological(labels[i]))
    base["arr_labels"] = [labels[i] for i in order]
    base["arr_openai"] = [openai[i] for i in order]
    base["arr_anthropic"] = [anthropic[i] for i in order]
    return True



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
    saved_cloud = (base.get("cloud_revenue") or {}).get("companies") or {}
    cloud_results = {}
    for key in CLOUD_REVENUE_KEYS:
        cfg = COMPANIES[key]
        merged = list(capex_results.get(key) or [])
        seen = {item.get("url") for item in merged}
        saved_url = str((saved_cloud.get(key) or {}).get("source_url") or "")
        if saved_url:
            direct = fetch_page_result(saved_url, cfg["hosts"])
            if direct:
                _merge_results(merged, seen, [direct])
        cloud_results[key] = merged
    arr_results = {
        key: latest_arr_results(key, cfg) for key, cfg in ARR_COMPANIES.items()
    }
    scan_succeeded = (
        any(capex_results.values())
        or any(cloud_results.values())
        or any(arr_results.values())
    )
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
            _update_capex_totals(base, current)
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

    if any(cloud_results.values()):
        cloud_extracted = {
            key: _cloud_revenue_candidate(key, COMPANIES[key], cloud_results.get(key, []))
            for key in CLOUD_REVENUE_KEYS
        }
        cloud = base.setdefault("cloud_revenue", {})
        cloud.setdefault("unit", "USD billion")
        quarters = cloud.setdefault("quarters", [])
        companies = cloud.setdefault("companies", {})
        pending = cloud.get("pending_quarters") or {}
        display_names = {
            "alphabet": "Google Cloud",
            "amazon": "Amazon Web Services",
            "microsoft": "Microsoft Cloud",
        }
        metrics = {
            "alphabet": "Google Cloud segment revenue",
            "amazon": "AWS segment net sales",
            "microsoft": "Microsoft Cloud revenue",
        }
        for key in CLOUD_REVENUE_KEYS:
            candidate = cloud_extracted.get(key) or {}
            quarter = str(candidate.get("quarter") or "")
            source_date = _valid_date(candidate.get("source_date"))
            source_url = str(candidate.get("source_url") or "")
            value_b = _number(candidate.get("revenue_b"))
            if (
                not quarter
                or value_b is None
                or not source_date
                or not _host_allowed(source_url, COMPANIES[key]["hosts"])
            ):
                print(f"  [Cloud:{key}] no valid new quarterly disclosure")
                continue
            item = companies.setdefault(
                key,
                {
                    "display_name": display_names[key],
                    "metric": metrics[key],
                    "revenue_b": [],
                },
            )
            previous_date = _valid_date(item.get("source_date"))
            if previous_date and source_date < previous_date:
                print(f"  [Cloud:{key}] older disclosure {source_date}; preserving {previous_date}")
                continue
            if quarter in quarters:
                # Preserve the more precise saved table value for an existing
                # quarter; rounded headlines (for example $24.8B) must not
                # overwrite exact supplemental-table data ($24.768B).
                if candidate.get("latest_yoy_pct") is not None and item.get("latest_yoy_pct") is None:
                    item["latest_yoy_pct"] = candidate["latest_yoy_pct"]
                    changed = True
                print(f"  [Cloud:{key}] {quarter} verified; precise snapshot preserved")
                continue
            record = {
                "revenue_b": round(value_b, 3),
                "latest_yoy_pct": candidate.get("latest_yoy_pct"),
                "source_label": candidate.get("source_label"),
                "source_date": source_date,
                "source_url": source_url,
            }
            if pending.setdefault(quarter, {}).get(key) != record:
                pending[quarter][key] = record
                changed = True
                print(f"  [Cloud:{key}] staged {quarter} revenue ${value_b:g}B")

        for quarter in sorted(list(pending), key=_quarter_sort_key):
            staged = pending.get(quarter) or {}
            if not all(key in staged for key in CLOUD_REVENUE_KEYS):
                continue
            if quarters and _quarter_sort_key(quarter) <= _quarter_sort_key(quarters[-1]):
                del pending[quarter]
                changed = True
                continue
            quarters.append(quarter)
            for key in CLOUD_REVENUE_KEYS:
                item = companies[key]
                item.setdefault("revenue_b", []).append(staged[key]["revenue_b"])
                item.update(
                    {
                        "display_name": display_names[key],
                        "metric": metrics[key],
                        "latest_yoy_pct": staged[key].get("latest_yoy_pct"),
                        "source_label": staged[key].get("source_label"),
                        "source_date": staged[key]["source_date"],
                        "source_url": staged[key]["source_url"],
                    }
                )
            while len(quarters) > 4:
                quarters.pop(0)
                for key in CLOUD_REVENUE_KEYS:
                    companies[key]["revenue_b"].pop(0)
            del pending[quarter]
            changed = True
            print(f"  [Cloud] finalized complete {quarter} three-company comparison")

        if pending:
            cloud["pending_quarters"] = pending
        else:
            cloud.pop("pending_quarters", None)
        source_dates = [
            _valid_date((companies.get(key) or {}).get("source_date"))
            for key in CLOUD_REVENUE_KEYS
        ]
        source_dates = [value for value in source_dates if value]
        if source_dates:
            cloud["as_of"] = max(source_dates)

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

            numeric_rejection = _arr_numeric_rejection(base, key, candidate)
            if numeric_rejection:
                print(f"  [ARR:{key}] rejected: {numeric_rejection}")
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
                for field in ("metric_period", "basis", "correction"):
                    if candidate.get(field) is not None:
                        event[field] = candidate[field]
            if event != previous_event:
                events[key] = event
                changed = True
                print(f"  [ARR:{key}] accepted latest event from {url}")
            else:
                print(f"  [ARR:{key}] latest event verified unchanged")

            if value is not None and _upsert_arr_value(base, key, source_date, value,
                                                     candidate.get("metric_period", ""),
                                                     candidate.get("correction", False)):
                sources[key] = {
                    "source_label": source_label,
                    "source_date": source_date,
                    "source_url": url,
                    "arr_yi": round(value, 1),
                    "metric_period": candidate.get("metric_period") or source_date[:7],
                    "basis": candidate.get("basis") or "annualized_revenue_run_rate",
                    "correction": bool(candidate.get("correction")),
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
    base["scanner_method"] = "local-evidence-v2"
    base["note"] = (
        "GitHub Actions每3小时自动扫描三大云业务季度收入和四家公司Capex；"
        "优先采用公司官方投资者关系披露，业绩会仅在官方文字稿不可得时采用"
        "AP/Reuters/CNBC直接报道"
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
