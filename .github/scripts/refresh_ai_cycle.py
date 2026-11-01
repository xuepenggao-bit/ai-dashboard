#!/usr/bin/env python3
"""Build dated AI-cycle observations from reviewed evidence and live AI-trend data.

This module does not assign a Perez phase: the browser recomputes the research
phase from the current observation set. No amount is a forecast unless type says
guidance. Currency unit is USD billion; missing values stay null/absent.
"""
from __future__ import annotations

import argparse
import calendar
import copy
import datetime as dt
import hashlib
import html
import json
import math
import re
from pathlib import Path
from urllib.parse import urljoin, urlparse

GROUPS = {"hyperscaler", "neocloud", "arr"}
TYPES = {"actual", "guidance", "run_rate"}
OFFICIAL = {
    "alphabet": ("abc.xyz", "q4cdn.com", "sec.gov"),
    "microsoft": ("microsoft.com", "sec.gov"),
    "amazon": ("ir.aboutamazon.com", "sec.gov"),
    "meta": ("investor.atmeta.com", "sec.gov"),
    "coreweave": ("investors.coreweave.com", "coreweave.com", "sec.gov"),
    "nebius": ("nebius.com", "sec.gov"),
    "openai": ("openai.com",),
    "anthropic": ("anthropic.com",),
}
MEDIA = ("reuters.com", "apnews.com", "cnbc.com", "bloomberg.com", "axios.com", "nytimes.com", "ft.com", "wsj.com")
CAPEX_BASIS = {
    "alphabet": "cash_ppe", "microsoft": "reported_capex_including_lease_commencement",
    "amazon": "cash_capex_net", "meta": "cash_ppe_plus_lease_principal",
    "coreweave": "capex_incurred", "nebius": "company_reported_capex",
}
NEO_CONFIG = {
    "coreweave": {"name": "CoreWeave", "landings": ["https://investors.coreweave.com/news/default.aspx", "https://www.coreweave.com/newsroom"], "bounds": (1, 200)},
    "nebius": {"name": "Nebius", "landings": ["https://nebius.com/newsroom", "https://nebius.com/investor-hub"], "bounds": (.1, 100)},
}


def number(value):
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def day(value):
    try:
        return dt.date.fromisoformat(str(value)[:10]).isoformat()
    except (ValueError, TypeError):
        return ""


def allowed(url, hosts):
    p = urlparse(str(url or ""))
    h = (p.hostname or "").lower()
    return p.scheme == "https" and any(h == host or h.endswith("." + host) for host in hosts)


def rank(source):
    return {"official": 3, "reliable_media": 2, "reviewed": 2}.get(source.get("rank") or source.get("kind"), 1)


def normalize_source(source):
    source = copy.deepcopy(source)
    source["id"] = str(source.get("id") or "")
    source["url"] = str(source.get("url") or "")
    source["date"] = day(source.get("date") or source.get("disclosedAt"))
    if not source["id"] or not source["date"] or not source["url"].startswith("https://"):
        raise ValueError("Source requires id, dated HTTPS URL")
    return source


def normalize_observation(observation, sources, as_of):
    o = copy.deepcopy(observation)
    if o.get("type") not in TYPES:
        raise ValueError("Only actual, guidance and run_rate observations are numeric inputs")
    if not str(o.get("period") or "").strip():
        raise ValueError("Observation requires an explicit period")
    o["effectiveDate"] = day(o.get("effectiveDate"))
    o["disclosedAt"] = day(o.get("disclosedAt"))
    if not o["effectiveDate"] or not o["disclosedAt"] or o["disclosedAt"] > as_of:
        raise ValueError("Missing or future disclosure date")
    # A guide's target period can end after today; a realized milestone cannot.
    if o["type"] != "guidance" and o["effectiveDate"] > as_of:
        raise ValueError("Future realized observation")
    if not str(o.get("basis") or "").strip():
        raise ValueError("Observation requires a metric definition/basis")
    source = sources.get(o.get("sourceId"))
    if not source or source["date"] > as_of:
        raise ValueError("Missing or future source")
    for key in ["valueUsdB", "lowUsdB", "highUsdB"]:
        o[key] = number(o.get(key))
    low, high, value = o["lowUsdB"], o["highUsdB"], o["valueUsdB"]
    if value is None and low is not None and high is not None:
        value = o["valueUsdB"] = (low + high) / 2
    if value is None or value <= 0:
        raise ValueError("Zero/missing/invalid amount is not an observation")
    if low is not None and high is not None and not (0 < low <= high):
        raise ValueError("Invalid range")
    if low is not None and value < low or high is not None and value > high:
        raise ValueError("Point is outside guidance range")
    o["basisKey"] = str(o.get("basisKey") or "default")
    return o


def observation_key(o):
    # One point per economic period and metric type; a correction replaces that
    # point rather than inventing a decline between its two publication dates.
    return str(o["period"]), o["type"]


def economic_payload(o):
    """A provider's wording/source-id is not a conflicting new measurement.
    Preserve reviewed annotations when the dated economic facts are identical.
    """
    return tuple(o.get(k) for k in (
        "period", "type", "valueUsdB", "lowUsdB", "highUsdB", "basisKey"
    ))


def merge_observations(old, incoming, sources, as_of, issues=None, superseded=None):
    issues = issues if issues is not None else []
    superseded = superseded if superseded is not None else []
    result = {}
    for raw in [*old, *incoming]:
        try:
            o = normalize_observation(raw, sources, as_of)
        except ValueError as exc:
            issues.append(str(exc))
            continue
        key, previous = observation_key(o), result.get(observation_key(o))
        if previous:
            if o["basisKey"] != previous["basisKey"] and not o.get("basisChange"):
                issues.append("Metric basis changed without review: " + str(key))
                continue
            if o["disclosedAt"] < previous["disclosedAt"]:
                continue
            if o["disclosedAt"] == previous["disclosedAt"] and rank(sources[o["sourceId"]]) < rank(sources[previous["sourceId"]]):
                continue
            if o["disclosedAt"] == previous["disclosedAt"] and economic_payload(o) == economic_payload(previous):
                # The reviewed point owns its source, correction notes and
                # accounting warnings; a second provider merely confirms it.
                continue
            if o["disclosedAt"] == previous["disclosedAt"] and o != previous and rank(sources[o["sourceId"]]) == rank(sources[previous["sourceId"]]) and not o.get("correction"):
                issues.append("Same-date conflicting observation retained for review: " + str(key))
                continue
            # Comparability warnings are reviewed facts, not temporary nulls.
            if previous.get("comparable") is False and not (o.get("comparable") is True and o.get("comparisonReviewed") is True):
                o["comparable"] = False
                o.setdefault("comparisonNote", previous.get("comparisonNote"))
            if o != previous and o["valueUsdB"] != previous["valueUsdB"]:
                superseded.append({"observation": previous, "replacedBySourceId": o["sourceId"], "correction": bool(o.get("correction"))})
        result[key] = o
    return sorted(result.values(), key=lambda o: (o["effectiveDate"], o["disclosedAt"], o["type"]))


def company_id(series):
    return str(series.get("companyId") or series.get("id", "").removeprefix("capex-").removeprefix("arr-"))


def new_source(company, label, url, date, suffix):
    if not allowed(url, OFFICIAL.get(company, ()) + MEDIA):
        raise ValueError("Untrusted source for " + company)
    ident = suffix + "-" + hashlib.sha256((url + date).encode()).hexdigest()[:12]
    return {"id": ident, "name": label, "url": url, "date": date, "rank": "official" if allowed(url, OFFICIAL.get(company, ())) else "reliable_media"}


def provider_updates(trend, series, as_of):
    """Translate only dated latest facts, never relabel a forecast or attach a
    latest source to every historical ARR point without provenance."""
    updates, sources, issues = [], [], []
    company, group = company_id(series), series["group"]
    if group == "hyperscaler":
        c = (trend.get("capex_companies") or {}).get(company) or {}
        disclosed = day(c.get("source_date"))
        period = str(c.get("period") or "")
        low, high = number(c.get("guidance_low_yi")), number(c.get("guidance_high_yi"))
        if not disclosed or disclosed > as_of or not re.fullmatch(r"CY20\d{2}", period) or low is None or high is None or not 0 < low <= high:
            return updates, sources, issues
        try:
            source = new_source(company, c.get("source_label") or company + " guidance", c.get("source_url") or "", disclosed, "capex")
        except ValueError as exc:
            return [], [], [str(exc)]
        sources.append(source)
        updates.append({"period": period, "effectiveDate": period[2:] + "-12-31", "disclosedAt": disclosed,
                        "valueUsdB": (low + high) / 20, "lowUsdB": low / 10, "highUsdB": high / 10,
                        "type": "guidance", "basis": c.get("basis_note") or series.get("basis") or "Company reported annual capital expenditures",
                        "basisKey": series.get("basisKey") or CAPEX_BASIS.get(company, "default"),
                        "comparable": c.get("comparison_comparable", True),
                        "comparisonNote": c.get("comparison_note"), "sourceId": source["id"]})
    elif group == "arr":
        event = (trend.get("arr_latest_events") or {}).get(company) or {}
        saved = (trend.get("arr_sources") or {}).get(company) or {}
        candidates = []
        if event.get("numeric") is True and event.get("disclosure_type") != "forecast" and number(event.get("arr_yi")) is not None:
            candidates.append(event)
        # The most recent news event can be a forecast; keep the latest numeric
        # milestone source instead of turning that forecast into a new amount.
        if saved.get("disclosure_type") != "forecast" and number(saved.get("arr_yi")) is not None:
            candidates.append(saved)
        for c in candidates:
            disclosed, value = day(c.get("source_date")), number(c.get("arr_yi"))
            if not disclosed or disclosed > as_of or not value or value <= 0:
                continue
            period = str(c.get("metric_period") or c.get("effective_period") or disclosed[:7])
            effective = day(c.get("effective_date"))
            date_metadata = {}
            if not effective and re.fullmatch(r"20\d{2}-\d{2}", period):
                # Prior-month reports use a labelled plotting anchor; the field
                # explicitly does not pretend that the exact measurement day
                # was disclosed. Otherwise use the known disclosure date.
                if period < disclosed[:7]:
                    year, month = map(int, period.split("-"))
                    effective = period + "-" + str(calendar.monthrange(year, month)[1])
                    date_metadata = {"effectiveDatePrecision": "month", "dateNote": "Month-end plotting anchor; source only identified the month."}
                else:
                    effective = disclosed
                    date_metadata = {"effectiveDatePrecision": "disclosed_as_of", "dateNote": "Milestone known as of disclosure date; exact measurement day not inferred."}
            if not effective:
                issues.append("ARR requires a monthly period or effective_date: " + company)
                continue
            try:
                source = new_source(company, c.get("source_label") or company + " run rate", c.get("source_url") or "", disclosed, "arr")
            except ValueError as exc:
                issues.append(str(exc)); continue
            sources.append(source)
            updates.append({"period": period, "effectiveDate": effective, "disclosedAt": disclosed, "valueUsdB": value / 10,
                            "type": "run_rate", "basis": c.get("basis") or series.get("basis") or "Annualized revenue run rate, not GAAP annual revenue or contracted ARR",
                            "basisKey": series.get("basisKey") or "annualized_revenue_run_rate", "sourceId": source["id"], **date_metadata,
                            **({"correction": True, "correctionNote": c.get("correction_note")} if c.get("correction") else {})})
    return updates, sources, issues


def plain_text(raw):
    raw = re.sub(r"(?is)<(?:script|style|noscript)\b[^>]*>.*?</(?:script|style|noscript)>", " ", raw)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"(?s)<[^>]+>", " ", raw))).strip()


def extract_date(raw, url=""):
    patterns = [r'"datePublished"\s*:\s*"(20\d{2}-\d{2}-\d{2})', r'(?:article:published_time|datePublished)[^>]{0,100}?content=["\'](20\d{2}-\d{2}-\d{2})', r'/(20\d{2})/(\d{2})/(\d{2})/']
    for pattern in patterns:
        match = re.search(pattern, raw + " " + url, re.I)
        if match:
            candidate = "-".join(match.groups())
            if day(candidate):
                return day(candidate)
    text = plain_text(raw)
    match = re.search(r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}\b", text, re.I)
    if match:
        try:
            return dt.datetime.strptime(match.group(0).title(), "%B %d, %Y").date().isoformat()
        except ValueError:
            pass
    return ""


MONEY = re.compile(r"\$?\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*(billion|bn|million|mn)\b", re.I)
RANGE = re.compile(r"\$?\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*(billion|bn|million|mn)?\s*(?:to|[-–—])\s*\$?\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*(billion|bn|million|mn)\b", re.I)


def extract_neocloud_guidance(company, raw, url, as_of):
    """Conservative full-year guide extraction. It deliberately rejects
    ambiguous quarterly, commitment and multiple-period sentences."""
    if company not in NEO_CONFIG or not allowed(url, OFFICIAL[company]):
        return None
    disclosed = extract_date(raw, url)
    if not disclosed or disclosed > as_of:
        return None
    year = as_of[:4]
    candidates = []
    for sentence in re.split(r"(?<!\d)[.!?;]\s+", plain_text(raw)):
        anchors = list(re.finditer(r"\b(?:cash\s+)?(?:capital expenditures?|capex|capital spending)\b", sentence, re.I))
        for anchor in anchors:
            window = sentence[max(0, anchor.start()-130):anchor.end()+220]
            # Both audited NeoCloud issuers have calendar fiscal years. An
            # explicit FY26/FY2026/full fiscal-year guide is annual, not a
            # quarterly actual; do not reuse Microsoft's FY/CY restriction.
            window = re.sub(r"\bFY\s*(?:20)?(\d{2})\b", lambda m: "20" + m.group(1), window, flags=re.I)
            if set(re.findall(r"\b20\d{2}\b", window)) != {year}:
                continue
            if re.search(r"\bQ[1-4]\b|\bquarter\b|\bYTD\b|\b(?:three|six|nine|3|6|9)[- ]months?|\b[369]M\b|\bfirst half\b", window, re.I):
                continue
            if re.search(r"\bbacklog\b|\bcommitments?\b|\bcontracted\b|\bprevious\b|\bprior\b|\blast year\b", window, re.I):
                continue
            if not re.search(r"\bexpect|\bplan|\bguidance|\boutlook|\bforecast|\bwill\s+(?:be|total|amount|reach)", window, re.I):
                continue
            # A realised statement with an unrelated future-demand phrase is
            # not a guide. Bound operators cannot become a fabricated point.
            if re.search(r"\b(?:capex|capital expenditures?)\s+(?:was|were|totaled|totalled|amounted)\b", window, re.I):
                continue
            if re.search(r"\b(?:over|under|more than|less than|at least|up to)\s*\$?\s*\d", window, re.I):
                continue
            to_b = lambda value, unit: float(value) * (1 if unit.lower() in ("billion", "bn") else .001)
            intervals = list(RANGE.finditer(window))
            relative = anchor.start()-max(0, anchor.start()-130)
            relative_end = relative + anchor.end() - anchor.start()
            distance = lambda m: max(relative-m.end(), m.start()-relative_end, 0)
            interval = min(intervals, key=distance) if intervals else None
            if interval:
                left, left_unit, right, right_unit = interval.groups()
                low, high = to_b(left, left_unit or right_unit), to_b(right, right_unit)
            else:
                money = list(MONEY.finditer(window))
                if not money:
                    continue
                value = min(money, key=distance)
                low = high = to_b(*value.groups())
            minimum, maximum = NEO_CONFIG[company]["bounds"]
            if not minimum <= low <= high <= maximum:
                continue
            basis_key = "cash_capex" if re.search(r"\bcash\s+(?:capital expenditures?|capex)\b", window, re.I) else CAPEX_BASIS[company]
            candidates.append({"period": "CY"+year, "effectiveDate": year+"-12-31", "disclosedAt": disclosed, "valueUsdB": (low+high)/2, "lowUsdB": low, "highUsdB": high, "type": "guidance", "basis": "Company-reported full-year capital expenditure guidance; not backlog or committed spend", "basisKey": basis_key, "evidence": window[:500]})
    if not candidates:
        return None
    return candidates[0]


def request_page(url, hosts):
    import requests
    response = requests.get(url, headers={"User-Agent": "Mozilla/5.0 AI-Cycle-Research/1.0"}, timeout=18)
    response.raise_for_status()
    if not allowed(response.url, hosts):
        raise ValueError("Redirect left issuer domain")
    if "pdf" in response.headers.get("Content-Type", "").lower():
        raise ValueError("PDF extraction requires reviewed evidence")
    return response.text, response.url


def scan_neocloud(company, series, as_of, fetch=request_page):
    """Discover current earnings links on issuer IR/news pages only. Failed or
    ambiguous parses preserve the saved observation; no search snippet values."""
    cfg = NEO_CONFIG.get(company)
    if not cfg:
        return [], [], ["No audited official scanner for " + company]
    hosts, urls, pages, issues = OFFICIAL[company], [], [], []
    for landing in cfg["landings"]:
        try:
            raw, final_url = fetch(landing, hosts)
            pages.append((raw, final_url))
            # HTML news lists and RSS both expose dated issuer links.
            links = re.findall(r'(?is)(?:href=["\']([^"\']+)["\']|<link[^>]*>(https?://[^<]+)</link>)', raw)
            for pair in links:
                url = urljoin(final_url, html.unescape(next(x for x in pair if x)))
                if allowed(url, hosts) and re.search(r"earnings|results|financial|quarter|20\d{2}.*(?:q[1-4]|capex)|press.release", url, re.I):
                    if url not in urls:
                        urls.append(url)
        except Exception as exc:
            issues.append(company + " discovery: " + str(exc)[:160])
    # Current IR discoveries precede the seed's historical fallback pages so
    # the bounded request budget cannot starve newly published earnings links.
    urls.extend(url for url in series.get("officialUrls") or [] if url not in urls)
    # Cap the network work because the workflow already scans four large CSPs.
    for url in urls[:5]:
        try:
            pages.append(fetch(url, hosts))
        except Exception as exc:
            issues.append(company + " page: " + str(exc)[:160])
    updates, sources = [], []
    for raw, url in pages:
        candidate = extract_neocloud_guidance(company, raw, url, as_of)
        if not candidate:
            continue
        source = new_source(company, cfg["name"] + " official Capex guidance", url, candidate["disclosedAt"], "neo")
        candidate["sourceId"] = source["id"]
        # Do not silently change a reviewed cash/incurred/lease basis.
        if series.get("basisKey") and candidate["basisKey"] != series["basisKey"]:
            issues.append(company + " scanner basis differs from reviewed seed")
            continue
        updates.append(candidate); sources.append(source)
    return updates, sources, issues


def build_cycle(seed, trend, previous=None, as_of=None, scanned=None, checked_at=None):
    as_of = day(as_of or dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date())
    if not as_of:
        raise ValueError("Invalid as-of date")
    previous, scanned = previous or {}, scanned or {}
    checked_at = checked_at or dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds")
    issues, superseded, sources = [], copy.deepcopy((previous.get("quality") or {}).get("supersededObservations") or []), {}
    for document in [previous, seed]:
        for source in document.get("sources") or []:
            try:
                s = normalize_source(source)
                if s["date"] <= as_of:
                    sources[s["id"]] = s
            except ValueError as exc:
                issues.append(str(exc))
    result_series = []
    old = {s["id"]: s for s in previous.get("series") or []}
    for raw in seed.get("series") or []:
        if raw.get("group") not in GROUPS or not raw.get("id"):
            raise ValueError("Series requires stable id and known group")
        series = copy.deepcopy(raw)
        updates, new_sources, warnings = provider_updates(trend, series, as_of)
        scan_updates, scan_sources, scan_issues = scanned.get(series["id"], ([], [], []))
        for source in [*new_sources, *scan_sources]:
            s = normalize_source(source); sources[s["id"]] = s
        issues.extend(warnings + scan_issues)
        prior = copy.deepcopy((old.get(series["id"]) or {}).get("observations") or [])
        incoming = copy.deepcopy([*(series.get("observations") or []), *updates, *scan_updates])
        # A series-level basis key identifies the same accounting concept even
        # when the human-readable explanatory sentence evolves.
        for o in [*prior, *incoming]:
            o.setdefault("basisKey", series.get("basisKey") or CAPEX_BASIS.get(company_id(series), "annualized_revenue_run_rate" if series["group"] == "arr" else "default"))
            if series.get("comparable") is False:
                o["comparable"] = False
                if series.get("comparisonNote"):
                    o.setdefault("comparisonNote", series["comparisonNote"])
        series["observations"] = merge_observations(prior, incoming, sources, as_of, issues, superseded)
        series["unit"] = "USD billion"
        series["latest"] = max(series["observations"], key=lambda o: (o["effectiveDate"], o["disclosedAt"])) if series["observations"] else None
        result_series.append(series)
    commercial = copy.deepcopy(seed.get("commercialEvidence") or {})
    if trend.get("cloud_revenue"):
        commercial["cloudRevenue"] = copy.deepcopy(trend["cloud_revenue"])
        commercial["cloudRevenueNote"] = "Company-defined cloud revenue, not pure AI revenue; Microsoft scope is broader than Azure."
    content = {"series": result_series, "commercialEvidence": commercial, "riskMetrics": copy.deepcopy(seed.get("riskMetrics") or [])}
    fingerprint = hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    unchanged = fingerprint == previous.get("evidenceVersion")
    return {"schemaVersion": 1, "asOf": as_of, "updatedAt": previous.get("updatedAt", checked_at) if unchanged else checked_at, "lastChecked": checked_at,
            "evidenceVersion": fingerprint, **content, "sources": list(sources.values()),
            "notes": copy.deepcopy(seed.get("notes") or []),
            "quality": {"issues": sorted(set(issues)), "supersededObservations": superseded[-50:], "hasNumericObservations": any(s["observations"] for s in result_series), "guidanceSeparatedFromActual": True, "missingIsZero": False, "phaseOwner": "browser_recomputed_research_model"}}


def load(path, fallback=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        if fallback is not None:
            return fallback
        raise


def main():
    root = Path(__file__).resolve().parents[2] if Path(__file__).parent.name == "scripts" else Path.cwd()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=Path, default=root / "data/ai_cycle_seed.json")
    parser.add_argument("--ai-trend", type=Path, default=root / "data/ai_trend.json")
    parser.add_argument("--previous", type=Path)
    parser.add_argument("--output", type=Path, default=root / "data/ai_cycle.json")
    parser.add_argument("--as-of", default=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date().isoformat())
    parser.add_argument("--scan-official", action="store_true")
    args = parser.parse_args()
    seed, trend, previous = load(args.seed), load(args.ai_trend, {}), load(args.previous or args.output, {})
    scanned = {}
    if args.scan_official:
        for series in seed.get("series") or []:
            if series.get("group") == "neocloud":
                scanned[series["id"]] = scan_neocloud(company_id(series), series, args.as_of)
    result = build_cycle(seed, trend, previous, args.as_of, scanned)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "series": len(result["series"]), "observations": sum(len(s["observations"]) for s in result["series"]), "issues": result["quality"]["issues"], "evidenceVersion": result["evidenceVersion"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

