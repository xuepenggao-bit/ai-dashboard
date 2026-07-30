#!/usr/bin/env python3
"""Refresh hyperscaler Capex guidance and frontier-AI ARR milestones.

GitHub Actions runs this scanner every three hours and also exposes a manual
trigger. Capex is restricted to company investor-relations domains. ARR may use
company disclosures or a small allowlist of reliable news sources because the
private companies often disclose milestones through interviews or reporting.
Unverified fields are ignored, qualitative ARR news is never converted into an
invented number, and the last valid numeric snapshot is preserved.
"""

import datetime
import html
import json
import os
import re
import xml.etree.ElementTree as ET
from urllib.parse import parse_qs, unquote, urlencode, urljoin, urlparse

import requests


GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
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


def now_ts():
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz8).strftime("%Y-%m-%d %H:%M")


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
        return {"title": title, "body": body, "url": final_url, "date": ""}
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


def _model_json(prompt, max_tokens):
    response = requests.post(
        "https://models.github.ai/inference/chat/completions",
        headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Content-Type": "application/json",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
        },
        json={
            "model": "openai/gpt-4.1",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0,
            "response_format": {"type": "json_object"},
        },
        timeout=60,
    )
    response.raise_for_status()
    raw = response.json()["choices"][0]["message"]["content"]
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    return json.loads(match.group()) if match else {}


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
        key: latest_official_results(
            cfg, str((saved_capex.get(key) or {}).get("source_url") or "")
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
    if not GITHUB_TOKEN:
        print("GITHUB_TOKEN missing; preserving the existing snapshot.")
        return

    changed = False
    capex_changed = False

    if any(capex_results.values()):
        context_parts = []
        for key, results in capex_results.items():
            cfg = COMPANIES[key]
            lines = [f"[{key} | {cfg['name']}]"]
            for result in results:
                lines.append(
                    f"- {result['title']}\n  PUBLISHED: {result['date']}\n"
                    f"  URL: {result['url']}\n  SNIPPET: {result['body'][:700]}"
                )
            context_parts.append("\n".join(lines))
        context = "\n\n".join(context_parts)

        previous_dates = {
            key: ((base.get("capex_companies") or {}).get(key) or {}).get(
                "source_date", ""
            )
            for key in COMPANIES
        }
        prompt = f"""
You are structuring capital-expenditure disclosures from official company investor-relations search results.
Today is {datetime.date.today().isoformat()}. Select the latest explicit full-year 2026 Capex guidance for each company.

Rules:
1. Use only a number explicitly stated in an official snippet and copy that snippet's official URL.
2. Compare publication/earnings dates and select the newest guidance, not the first search result.
3. Never return a source_date older than the saved date for that company: {json.dumps(previous_dates, ensure_ascii=False)}.
4. Unit is USD 100 million: $175B = 1750.
5. If management gives a range, output both endpoints and guidance_type "range".
6. If management says "about", "roughly", or gives one point, set low=high and guidance_type "point". Never invent a range.
7. actual_2025_yi is optional and must be an explicitly disclosed full-year actual Capex number.
8. Omit a company or field that cannot be verified. Do not use analyst estimates or news-media figures.
9. basis_note may briefly preserve a material accounting/classification explanation, but do not infer one.
10. Reject quarterly Capex actuals such as "Q4 Capex was $41B". The target is only a
    full-year or calendar-year 2026 guidance/expectation; if no such number is explicit,
    omit the company instead of returning a quarterly number.

Return JSON only:
{{
  "companies": {{
    "alphabet": {{"guidance_low_yi": 0, "guidance_high_yi": 0, "guidance_type": "range|point", "actual_2025_yi": 0, "basis_note": "", "source_date": "YYYY-MM-DD", "source_url": "https://..."}},
    "microsoft": {{...}},
    "amazon": {{...}},
    "meta": {{...}}
  }}
}}

OFFICIAL RESULTS:
{context[:14000]}
""".strip()

        try:
            extracted = _model_json(prompt, 1500)
        except Exception as exc:
            print(f"Capex extraction failed: {exc}; preserving Capex snapshot.")
            extracted = {}

        current = base.setdefault("capex_companies", {})
        for key, cfg in COMPANIES.items():
            candidate = (extracted.get("companies") or {}).get(key) or {}
            low = _number(candidate.get("guidance_low_yi"))
            high = _number(candidate.get("guidance_high_yi"))
            url = str(candidate.get("source_url") or "")
            source_date = _valid_date(candidate.get("source_date"))
            previous = dict(current.get(key) or {})
            previous_date = _valid_date(previous.get("source_date"))
            minimum, maximum = cfg["bounds"]
            # Models sometimes preserve the disclosure's $B unit despite the prompt.
            # Normalize only when both endpoints fit a plausible hyperscaler range.
            if (
                low is not None
                and high is not None
                and 30 <= low <= high <= 300
                and low < minimum
            ):
                low *= 10
                high *= 10
            rejection_reasons = []
            if low is None or high is None:
                rejection_reasons.append("missing guidance")
            elif not (minimum <= low <= high <= maximum):
                rejection_reasons.append(f"out of bounds {low}-{high}")
            if not _host_allowed(url, cfg["hosts"]):
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
                    "source_label": cfg["source_label"],
                    "source_date": source_date,
                    "source_url": url,
                }
            )
            actual = _number(candidate.get("actual_2025_yi"))
            if actual is not None and minimum / 2 <= actual <= maximum:
                item["actual_2025_yi"] = round(actual, 1)
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

    if any(arr_results.values()):
        arr_context_parts = []
        for key, results in arr_results.items():
            cfg = ARR_COMPANIES[key]
            lines = [f"[{key} | {cfg['name']}]"]
            for result in results:
                lines.append(
                    f"- {result['title']}\n  PUBLISHED: {result['date']}\n"
                    f"  URL: {result['url']}\n  SNIPPET: {result['body'][:600]}"
                )
            arr_context_parts.append("\n".join(lines))
        arr_context = "\n\n".join(arr_context_parts)
        previous_event_dates = {
            key: ((base.get("arr_latest_events") or {}).get(key) or {}).get(
                "source_date", ""
            )
            for key in ARR_COMPANIES
        }
        arr_prompt = f"""
You are structuring the latest ARR or annualized-revenue milestones for OpenAI and Anthropic.
Today is {datetime.date.today().isoformat()}.

Rules:
1. Select the newest reliable disclosure for each company and copy its source URL.
2. Do not return a source_date older than the saved event date:
   {json.dumps(previous_event_dates, ensure_ascii=False)}.
3. arr_yi is USD 100 million: $25B = 250. Include it only when the source explicitly
   states a numeric ARR, annualized revenue, or revenue run-rate for the company.
4. Never derive a number from a growth rate, monthly revenue, quarterly revenue,
   "higher than Q2", or another qualitative comparison.
5. A new qualitative ARR milestone is still useful: omit arr_yi and summarize the
   exact disclosed direction in <=120 Chinese characters without adding an inference.
6. Ignore forecasts, social posts, Reddit commentary, and numbers attributed only to
   anonymous speculation. News reporting of a company executive statement is allowed.
7. Omit a company when no newer relevant milestone is present.
8. Never use a company homepage or a generic research/about page as the source. The
   source must be the specific allowlisted article/result that contains the milestone.
9. Omit items that merely say no ARR or revenue number was disclosed; that is not a
   new milestone.

Return JSON only:
{{
  "companies": {{
    "openai": {{"summary": "", "source_label": "", "source_date": "YYYY-MM-DD", "source_url": "https://..."}},
    "anthropic": {{...}}
  }}
}}

ALLOWLISTED RESULTS:
{arr_context[:14000]}
""".strip()
        try:
            arr_extracted = _model_json(arr_prompt, 1200)
        except Exception as exc:
            print(f"ARR extraction failed: {exc}; preserving ARR snapshot.")
            arr_extracted = {}

        events = base.setdefault("arr_latest_events", {})
        sources = base.setdefault("arr_sources", {})
        for key, cfg in ARR_COMPANIES.items():
            candidate = (arr_extracted.get("companies") or {}).get(key) or {}
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
    heartbeat_due = str(base.get("last_checked") or "")[:10] != timestamp[:10]
    if changed:
        base["updated"] = timestamp
    if changed or heartbeat_due:
        base["last_checked"] = timestamp
        base["scan_interval_hours"] = 3
        base["note"] = (
            "GitHub Actions每3小时自动扫描；Capex仅采用四家公司官方投资者关系"
            "披露，ARR无明确金额时只记录事件、不反推数值"
        )
        base["arr_note"] = (
            "年化收入运行率公开里程碑（非传统合同ARR） · "
            "无明确金额的消息只记录事件，不反推数值 · 空值不补成下降趋势"
        )
        with open(OUT, "w", encoding="utf-8") as handle:
            json.dump(base, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print(f"Wrote {OUT} (changed={changed}, heartbeat={heartbeat_due})")
    else:
        print("No new data and today's successful-scan heartbeat already exists.")


if __name__ == "__main__":
    main()
