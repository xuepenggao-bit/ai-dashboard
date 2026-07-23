#!/usr/bin/env python3
"""Manually refresh four hyperscalers' latest official Capex guidance.

The workflow is deliberately workflow_dispatch-only. Search is restricted to
company investor-relations domains; GPT only structures the official snippets.
Unverified fields are ignored and the last valid snapshot is preserved.
"""

import datetime
import json
import os
import re
from urllib.parse import urlparse

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
        "bounds": (500, 3000),
        "source_label": "Alphabet 官方业绩披露",
    },
    "microsoft": {
        "name": "Microsoft",
        "query": "site:microsoft.com/en-us/investor latest earnings 2026 capital expenditures guidance",
        "hosts": ("microsoft.com",),
        "bounds": (500, 3000),
        "source_label": "Microsoft 官方业绩披露",
    },
    "amazon": {
        "name": "Amazon",
        "query": "site:ir.aboutamazon.com latest earnings 2026 capital expenditures guidance",
        "hosts": ("ir.aboutamazon.com",),
        "bounds": (500, 3000),
        "source_label": "Amazon 官方业绩披露",
    },
    "meta": {
        "name": "Meta",
        "query": "site:investor.atmeta.com latest earnings 2026 capital expenditures guidance range",
        "hosts": ("investor.atmeta.com",),
        "bounds": (300, 2500),
        "source_label": "Meta 官方业绩披露",
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


def ddg_search(query, hosts, n=8):
    """Return only official-domain DuckDuckGo results, including source URLs."""
    try:
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
                }
            )
        print(f'  [DDG] "{query[:64]}" -> {len(results)} official results')
        return results
    except Exception as exc:
        print(f'  [DDG] "{query[:64]}" failed: {exc}')
        return []


def latest_official_results(cfg):
    """Search several recency-aware variants and de-duplicate official URLs."""
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
    for query in queries:
        for item in ddg_search(query, cfg["hosts"], n=10):
            if item["url"] in seen:
                continue
            seen.add(item["url"])
            merged.append(item)
    return merged[:12]


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


def main():
    print("=== manual hyperscaler Capex refresh ===")
    try:
        with open(OUT, encoding="utf-8") as handle:
            base = json.load(handle)
    except Exception:
        base = {}

    search_results = {key: latest_official_results(cfg) for key, cfg in COMPANIES.items()}
    if not any(search_results.values()):
        print("No official search results; preserving the existing snapshot.")
        return
    if not GITHUB_TOKEN:
        print("GITHUB_TOKEN missing; preserving the existing snapshot.")
        return

    context_parts = []
    for key, results in search_results.items():
        cfg = COMPANIES[key]
        lines = [f"[{key} | {cfg['name']}]" ]
        for result in results:
            lines.append(
                f"- {result['title']}\n  URL: {result['url']}\n  SNIPPET: {result['body']}"
            )
        context_parts.append("\n".join(lines))
    context = "\n\n".join(context_parts)

    previous_dates = {
        key: ((base.get("capex_companies") or {}).get(key) or {}).get("source_date", "")
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

Return JSON only:
{{
  "companies": {{
    "alphabet": {{"guidance_low_yi": 0, "guidance_high_yi": 0, "guidance_type": "range|point", "actual_2025_yi": 0, "source_date": "YYYY-MM-DD", "source_url": "https://..."}},
    "microsoft": {{...}},
    "amazon": {{...}},
    "meta": {{...}}
  }}
}}

OFFICIAL RESULTS:
{context[:14000]}
""".strip()

    try:
        response = requests.post(
            "https://models.inference.ai.azure.com/chat/completions",
            headers={
                "Authorization": f"Bearer {GITHUB_TOKEN}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 1400,
                "temperature": 0,
            },
            timeout=60,
        )
        response.raise_for_status()
        raw = response.json()["choices"][0]["message"]["content"]
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        extracted = json.loads(match.group()) if match else {}
    except Exception as exc:
        print(f"AI extraction failed: {exc}; preserving the existing snapshot.")
        return

    current = base.setdefault("capex_companies", {})
    accepted = 0
    for key, cfg in COMPANIES.items():
        candidate = (extracted.get("companies") or {}).get(key) or {}
        low = _number(candidate.get("guidance_low_yi"))
        high = _number(candidate.get("guidance_high_yi"))
        url = str(candidate.get("source_url") or "")
        source_date = _valid_date(candidate.get("source_date"))
        previous_date = _valid_date((current.get(key) or {}).get("source_date"))
        minimum, maximum = cfg["bounds"]
        if (
            low is None
            or high is None
            or not (minimum <= low <= high <= maximum)
            or not _host_allowed(url, cfg["hosts"])
            or not source_date
            or (previous_date and source_date < previous_date)
        ):
            print(
                f"  [{key}] rejected/absent/stale "
                f"(candidate={source_date or 'no-date'}, saved={previous_date or 'none'}); "
                "keeping previous values"
            )
            continue

        item = dict(current.get(key) or {})
        item.update(
            {
                "display_name": cfg["name"],
                "guidance_low_yi": round(low, 1),
                "guidance_high_yi": round(high, 1),
                "guidance_type": "range" if high != low else "point",
                "period": "CY2026",
                "basis_note": (
                    "CY2026 · 公司正式指引区间"
                    if high != low
                    else "CY2026 · 点指引，未披露上下限"
                ),
                "source_label": cfg["source_label"],
                "source_date": source_date,
                "source_url": url,
            }
        )
        actual = _number(candidate.get("actual_2025_yi"))
        if actual is not None and minimum / 2 <= actual <= maximum:
            item["actual_2025_yi"] = round(actual, 1)
        current[key] = item
        accepted += 1
        print(f"  [{key}] accepted {low}-{high} from {url}")

    if not accepted:
        print("No company passed source and range validation; preserving snapshot.")
        return

    if not all(key in current for key in COMPANIES):
        print("Incomplete company set after merge; preserving snapshot.")
        return

    lows = [float(current[key]["guidance_low_yi"]) for key in COMPANIES]
    highs = [float(current[key]["guidance_high_yi"]) for key in COMPANIES]
    actuals = [_number(current[key].get("actual_2025_yi")) for key in COMPANIES]
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
        base["hyperscaler_yoy_pct"] = round((mid_total / actual_total - 1) * 100, 1)

    source_dates = [
        item.get("source_date", "") for item in current.values() if item.get("source_date")
    ]
    if source_dates:
        base["capex_as_of"] = max(source_dates)
    base["capex_unit"] = "USD 100 million"
    base["updated"] = now_ts()
    base["note"] = "手动触发更新；Capex仅采用四家公司官方投资者关系披露，点指引不扩写为区间"

    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(base, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
