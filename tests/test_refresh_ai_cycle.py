"""Synthetic fixtures are parser/merge tests, not market evidence."""
import copy
import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).with_name("refresh_ai_cycle.py")
if not SCRIPT.exists():
    SCRIPT = Path(__file__).resolve().parents[1] / ".github" / "scripts" / "refresh_ai_cycle.py"
SPEC = importlib.util.spec_from_file_location("refresh_ai_cycle", SCRIPT)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


ASOF = "2026-11-01"
NOW = "2026-11-01T16:00:00+08:00"


def source(ident="new", date="2026-10-08", rank="official"):
    return {"id": ident, "name": ident, "date": date,
            "url": "https://openai.com/research/" + ident, "rank": rank}


def observation(value=50, date="2026-10-08", period="2026-09", ident="new", **extra):
    return {"period": period, "effectiveDate": period+"-30", "disclosedAt": date,
            "valueUsdB": value, "type": "run_rate", "basis": "gross annualized revenue",
            "basisKey": "gross_run_rate", "sourceId": ident, **extra}


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.sources = {"old": source("old", "2026-09-29"), "new": source()}

    def test_correction_replaces_same_economic_period_not_false_decline(self):
        superseded = []
        result = m.merge_observations([observation(70, "2026-09-29", ident="old")],
                                      [observation(50, correction=True)], self.sources,
                                      ASOF, superseded=superseded)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["valueUsdB"], 50)
        self.assertEqual(superseded[0]["observation"]["valueUsdB"], 70)
        self.assertTrue(superseded[0]["correction"])

    def test_older_larger_number_never_overwrites_newer_corrected_value(self):
        result = m.merge_observations([observation(50, correction=True)],
                                      [observation(70, "2026-09-29", ident="old")],
                                      self.sources, ASOF)
        self.assertEqual(result[0]["valueUsdB"], 50)

    def test_real_later_period_decline_is_preserved(self):
        later = observation(45, period="2026-10", date="2026-10-30")
        result = m.merge_observations([observation(50)], [later], self.sources, ASOF)
        self.assertEqual([r["valueUsdB"] for r in result], [50, 45])

    def test_future_missing_zero_and_forecast_are_not_realized_points(self):
        for extra in [{"valueUsdB": None}, {"valueUsdB": 0}, {"valueUsdB": float("nan")},
                      {"type": "forecast"}, {"disclosedAt": "2026-11-02"}, {"effectiveDate": "2026-11-02"}]:
            with self.subTest(extra=extra):
                self.assertEqual(m.merge_observations([], [{**observation(), **extra}], self.sources, ASOF), [])

    def test_future_target_is_legal_for_annual_guidance(self):
        guide = {**observation(), "type": "guidance", "period": "CY2026", "effectiveDate": "2026-12-31"}
        self.assertEqual(len(m.merge_observations([], [guide], self.sources, ASOF)), 1)

    def test_accounting_basis_change_needs_review(self):
        result = m.merge_observations([observation()], [{**observation(60), "basisKey": "net_run_rate"}], self.sources, ASOF)
        self.assertEqual(result[0]["valueUsdB"], 50)

    def test_same_date_weaker_or_conflicting_source_does_not_replace(self):
        sources = {**self.sources, "media": source("media", rank="reliable_media")}
        for other in [observation(70, ident="media"), observation(70)]:
            result = m.merge_observations([observation(50)], [other], sources, ASOF)
            self.assertEqual(result[0]["valueUsdB"], 50)

    def test_reviewed_comparability_warning_cannot_vanish(self):
        old = {**observation(), "comparable": False, "comparisonNote": "lease reclassification"}
        new = {**observation(60, date="2026-10-10"), "comparable": True}
        result = m.merge_observations([old], [new], self.sources, ASOF)
        self.assertIs(result[0]["comparable"], False)
        self.assertEqual(result[0]["comparisonNote"], "lease reclassification")

    def test_same_economic_point_preserves_reviewed_source_and_notes_without_warning(self):
        reviewed = {**observation(50), "correction": True, "correctionNote": "reviewed same-period revision"}
        sources = {**self.sources, "confirmation": source("confirmation")}
        duplicate = {**observation(50, ident="confirmation"), "basis": "provider's equivalent description"}
        issues = []
        result = m.merge_observations([reviewed], [duplicate], sources, ASOF, issues=issues)
        self.assertEqual(result[0]["sourceId"], "new")
        self.assertEqual(result[0]["correctionNote"], reviewed["correctionNote"])
        self.assertFalse(issues)


class ProviderTests(unittest.TestCase):
    def test_csp_usd_100million_converts_to_billions_and_not_aggregate_yoy(self):
        trend = {"comparison_comparable": False, "capex_companies": {
            "alphabet": {"period": "CY2026", "source_date": "2026-10-28", "guidance_low_yi": 1900,
                         "guidance_high_yi": 2000, "source_url": "https://abc.xyz/investor/test"}}}
        series = {"id": "capex-alphabet", "group": "hyperscaler", "basisKey": "cash_ppe"}
        updates, sources, _ = m.provider_updates(trend, series, ASOF)
        self.assertEqual(updates[0]["valueUsdB"], 195)
        self.assertEqual((updates[0]["lowUsdB"], updates[0]["highUsdB"]), (190, 200))
        self.assertIs(updates[0]["comparable"], True)
        self.assertEqual(sources[0]["rank"], "official")

    def test_arr_forecast_does_not_replace_dated_numeric_milestone(self):
        trend = {"arr_latest_events": {"anthropic": {"numeric": False, "disclosure_type": "forecast", "arr_yi": 1000}},
                 "arr_sources": {"anthropic": {"arr_yi": 650, "source_date": "2026-08-17", "metric_period": "2026-07",
                     "source_url": "https://www.cnbc.com/2026/08/17/anthropic-run-rate.html"}}}
        updates, _, _ = m.provider_updates(trend, {"id": "arr-anthropic", "group": "arr"}, ASOF)
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["valueUsdB"], 65)
        self.assertEqual(updates[0]["effectiveDate"], "2026-07-31")
        self.assertEqual(updates[0]["effectiveDatePrecision"], "month")

    def test_untrusted_or_future_provider_is_ignored(self):
        for change in [{"source_date": "2026-11-02"}, {"source_url": "https://evil.example/news"}]:
            item = {"numeric": True, "arr_yi": 500, "source_date": "2026-10-08", "source_url": "https://openai.com/news/milestone", **change}
            updates, _, _ = m.provider_updates({"arr_latest_events": {"openai": item}}, {"id": "arr-openai", "group": "arr"}, ASOF)
            self.assertFalse(updates)


class ScannerTests(unittest.TestCase):
    def extract(self, sentence, date="2026-10-29"):
        raw = '<script type="application/ld+json">{"datePublished":"'+date+'"}</script><p>'+sentence+'</p>'
        return m.extract_neocloud_guidance("coreweave", raw, "https://investors.coreweave.com/news/earnings", ASOF)

    def test_only_explicit_current_full_year_capex_guide_is_accepted(self):
        result = self.extract("We expect full-year 2026 capital expenditures of $35 to $40 billion.")
        self.assertEqual((result["lowUsdB"], result["highUsdB"]), (35, 40))
        self.assertEqual(result["type"], "guidance")

    def test_calendar_fiscal_year_neocloud_guides_are_not_microsoft_fiscal_mismatch(self):
        for wording in ["full fiscal year 2026", "FY2026", "FY26"]:
            with self.subTest(wording=wording):
                result = self.extract("We expect " + wording + " capital expenditures of $35 to $40 billion.")
                self.assertEqual((result["lowUsdB"], result["highUsdB"]), (35, 40))
        self.assertIsNone(self.extract("We expect FY2027 capital expenditures of $35 billion."))

    def test_capex_range_does_not_inherit_nearby_revenue_range(self):
        result = self.extract("We expect full-year 2026 revenue of $12 to $13 billion and capital expenditures of $35 to $40 billion.")
        self.assertEqual((result["lowUsdB"], result["highUsdB"]), (35, 40))

    def test_quarter_actual_backlog_commitments_and_wrong_year_rejected(self):
        for text in ["Q3 2026 capital expenditures were $10 billion.",
                     "We expect Q3 2026 capex of $10 billion.",
                     "We expect 2027 capital expenditures of $40 billion.",
                     "Our 2026 capex commitments will total $40 billion.",
                     "Our 2026 backlog will reach $40 billion alongside capex plans.",
                     "Capital expenditures were $35 billion in 2026 and we expect demand growth.",
                     "We expect 2026 capex of more than $35 billion.",
                     "Our previous 2026 capex guidance was $30 billion.",
                     "We expect capital expenditures of $35 billion."]:
            with self.subTest(text=text):
                self.assertIsNone(self.extract(text))

    def test_generic_publication_year_and_future_source_cannot_anchor_period(self):
        self.assertIsNone(self.extract("We expect capital expenditures of $35 billion.", date="2026-10-29"))
        self.assertIsNone(self.extract("We expect 2026 capex of $35 billion.", date="2026-11-02"))

    def test_scanner_discovers_official_earnings_and_rejects_external_link(self):
        def fetch(url, hosts):
            if "news/default.aspx" in url:
                return '<a href="/news/2026-q3-earnings">earnings</a><a href="https://bad.example/earnings">earnings</a>', url
            return '<meta property="article:published_time" content="2026-10-29"><p>We expect full-year 2026 capex of $35 to $40 billion.</p>', url
        updates, sources, issues = m.scan_neocloud("coreweave", {"basisKey": "capex_incurred"}, ASOF, fetch)
        self.assertTrue(updates)
        self.assertTrue(all(point["valueUsdB"] == 37.5 for point in updates))
        self.assertTrue(all("bad.example" not in s["url"] for s in sources))

    def test_scanner_failure_preserves_seed_and_reports_warning(self):
        def fetch(*_):
            raise TimeoutError("timeout")
        updates, _, issues = m.scan_neocloud("coreweave", {}, ASOF, fetch)
        self.assertEqual(updates, [])
        self.assertTrue(issues)

    def test_newly_discovered_official_link_precedes_historical_fallback_budget(self):
        requested = []
        def fetch(url, hosts):
            requested.append(url)
            if "news/default.aspx" in url:
                return '<a href="/news/2026-q3-earnings">earnings</a>', url
            return '<meta property="article:published_time" content="2026-10-29"><p>We expect full-year 2026 capex of $35 to $40 billion.</p>', url
        old = ["https://investors.coreweave.com/news/old-earnings-"+str(i) for i in range(6)]
        m.scan_neocloud("coreweave", {"basisKey": "capex_incurred", "officialUrls": old}, ASOF, fetch)
        self.assertIn("https://investors.coreweave.com/news/2026-q3-earnings", requested)


class BuildTests(unittest.TestCase):
    def seed(self):
        return {"series": [{"id": "arr-openai", "group": "arr", "basisKey": "gross_run_rate",
                            "observations": [observation(50, correction=True)]}], "sources": [source()]}

    def test_heartbeat_does_not_fake_new_evidence_and_inputs_are_immutable(self):
        seed = self.seed(); original = copy.deepcopy(seed)
        first = m.build_cycle(seed, {}, as_of=ASOF, checked_at=NOW)
        before = copy.deepcopy(first)
        second = m.build_cycle(seed, {}, first, as_of=ASOF, checked_at="2026-11-01T19:00:00+08:00")
        self.assertEqual(seed, original); self.assertEqual(first, before)
        self.assertEqual(first["evidenceVersion"], second["evidenceVersion"])
        self.assertEqual(first["updatedAt"], second["updatedAt"])
        self.assertNotEqual(first["lastChecked"], second["lastChecked"])

    def test_stale_provider_cannot_revive_corrected_milestone(self):
        trend = {"arr_latest_events": {"openai": {"numeric": True, "arr_yi": 700, "source_date": "2026-09-29",
                   "metric_period": "2026-09", "source_url": "https://www.reuters.com/technology/old-arr-report/"}}}
        result = m.build_cycle(self.seed(), trend, as_of=ASOF, checked_at=NOW)
        self.assertEqual(result["series"][0]["observations"][0]["valueUsdB"], 50)
        self.assertFalse(result["quality"]["missingIsZero"])

    def test_no_numeric_signal_is_not_synthetic_zero(self):
        result = m.build_cycle({"series": [{"id": "arr-openai", "group": "arr", "observations": []}], "sources": []}, {}, as_of=ASOF, checked_at=NOW)
        self.assertIsNone(result["series"][0]["latest"])
        self.assertFalse(result["quality"]["hasNumericObservations"])

    def test_series_comparability_warning_reaches_every_observation(self):
        seed = self.seed()
        seed["series"][0].update({"comparable": False, "comparisonNote": "cash history differs from reported guidance"})
        result = m.build_cycle(seed, {}, as_of=ASOF, checked_at=NOW)
        point = result["series"][0]["observations"][0]
        self.assertIs(point["comparable"], False)
        self.assertIn("cash history", point["comparisonNote"])

    def test_correction_audit_survives_later_unchanged_refresh(self):
        previous = {"series": [{"id": "arr-openai", "group": "arr", "observations": [observation(70, "2026-09-29", ident="old")]}], "sources": [source("old", "2026-09-29")]}
        first = m.build_cycle(self.seed(), {}, previous, ASOF, checked_at=NOW)
        second = m.build_cycle(self.seed(), {}, first, ASOF, checked_at=NOW)
        self.assertEqual(second["quality"]["supersededObservations"][0]["observation"]["valueUsdB"], 70)


if __name__ == "__main__":
    unittest.main()

