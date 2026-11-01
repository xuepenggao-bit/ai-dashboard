"""Synthetic parser regressions; none of the fixture values are market evidence."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / ".github" / "scripts" / "refresh_ai_trend.py"
SPEC = importlib.util.spec_from_file_location("refresh_ai_trend_capex", SCRIPT)
m = importlib.util.module_from_spec(SPEC)
# Parser tests neither require a requests installation nor allow network reads.
with mock.patch.dict(sys.modules, {"requests": types.SimpleNamespace()}):
    SPEC.loader.exec_module(m)


def result(body, key="alphabet", date="2026-10-29", title="Company results"):
    hosts = {"alphabet": "abc.xyz", "microsoft": "microsoft.com",
             "amazon": "ir.aboutamazon.com", "meta": "investor.atmeta.com"}
    return {"title": title, "body": body, "date": date,
            "url": "https://" + hosts[key] + "/investor/earnings/" + date}


def extract(body, key="alphabet", **kwargs):
    return m._capex_candidate(key, m.COMPANIES[key], [result(body, key, **kwargs)])


class CapexPeriodBindingTests(unittest.TestCase):
    def test_quarter_actual_does_not_inherit_distant_full_year_guidance(self):
        item = extract("Capital expenditures in Q3 were $51.36 billion. "
                       "We now expect full-year 2026 capital expenditures of $185 to $190 billion.")
        self.assertEqual((item["guidance_low_yi"], item["guidance_high_yi"]), (1850, 1900))
        self.assertEqual(item["guidance_type"], "range")

    def test_quarter_actual_alone_is_not_annual_guidance(self):
        for text in ["Our 2026 Q3 capital expenditures were approximately $51.36 billion.",
                     "We expect Q3 2026 capex of $51.36 billion.",
                     "For the first nine months of 2026 capital spending was $141 billion.",
                     "We expect 2026 nine-month capex of $141 billion.",
                     "We expect 2026 9M capex of $141 billion.",
                     "We expect quarterly 2026 capex of $51.36 billion."]:
            with self.subTest(text=text):
                self.assertEqual(extract(text), {})

    def test_publication_year_in_title_is_not_the_guidance_period(self):
        self.assertEqual(extract("We expect capital expenditures of $185 billion.",
                                 title="2026 earnings release"), {})

    def test_prior_range_is_not_selected_instead_of_current_range(self):
        item = extract("We now expect full-year 2026 capex of $185 billion to $190 billion, "
                       "compared with our previous 2026 capex guidance of $175 billion to $180 billion.")
        self.assertEqual((item["guidance_low_yi"], item["guidance_high_yi"]), (1850, 1900))

    def test_prior_guidance_clause_alone_is_not_current_guidance(self):
        self.assertEqual(extract("Our previous 2026 capex guidance was $175 billion to $180 billion."), {})

    def test_range_units_both_endpoints_and_single_suffix(self):
        for written in ["$185 to $190 billion", "$185–190 billion", "$185 billion to $190 billion",
                        "$185 bn through $190 bn", "between $185 and $190 billion"]:
            with self.subTest(written=written):
                item = extract("We expect full-year 2026 capex of " + written + ".")
                self.assertEqual((item["guidance_low_yi"], item["guidance_high_yi"]), (1850, 1900))

    def test_current_publication_does_not_relabel_next_year_plan(self):
        self.assertEqual(extract("We expect calendar year 2027 capital expenditures of $220 billion."), {})
        self.assertEqual(extract("We expect next year capital expenditures of $220 billion.",
                                 title="2026 results"), {})

    def test_this_year_requires_source_publication_year_to_match(self):
        self.assertEqual(extract("We expect capex of $185 billion this year.")["guidance_high_yi"], 1850)
        self.assertEqual(extract("We expect capex of $185 billion this year.", date="2027-01-10"), {})

    def test_microsoft_fiscal_year_is_not_calendar_year(self):
        for text in ["We expect FY2027 capital expenditures of $200 billion.",
                     "We expect fiscal year 2026 capital expenditures of $200 billion.",
                     "We expect 2026 capital expenditures of $200 billion.",
                     "We expect capital expenditures of $200 billion this year."]:
            with self.subTest(text=text):
                self.assertEqual(extract(text, "microsoft"), {})
        actual = extract("We expect calendar year 2026 capex of $200 billion.", "microsoft")
        self.assertEqual(actual["guidance_high_yi"], 2000)
        self.assertEqual(extract("We expect FY26 capex of $185 billion for 2026."), {})

    def test_non_forward_annual_actual_is_not_guidance(self):
        self.assertEqual(extract("Capital expenditures in 2026 were approximately $185 billion."), {})
        self.assertEqual(extract("Capital expenditures were $51.36 billion in 2026 and we expect demand to grow this year."), {})

    def test_explicit_will_be_annual_guide_is_forward(self):
        item = extract("Capital expenditures for 2026 will be $185 billion.")
        self.assertEqual(item["guidance_high_yi"], 1850)

    def test_source_allowlist_and_latest_dated_valid_guide_are_preserved(self):
        old = result("We expect 2026 capex of $180 billion.", date="2026-07-20")
        new = result("We expect 2026 capex of $185 billion.", date="2026-10-29")
        invalid = {**new, "url": "https://untrusted.example.com/earnings"}
        item = m._capex_candidate("alphabet", m.COMPANIES["alphabet"], [old, invalid, new])
        self.assertEqual(item["source_date"], "2026-10-29")
        self.assertEqual(item["guidance_high_yi"], 1850)


class CapexComparabilityTests(unittest.TestCase):
    def companies(self):
        return {key: {"guidance_low_yi": 1000, "guidance_high_yi": 1200,
                      "actual_2025_yi": 500} for key in m.COMPANIES}

    def test_scale_totals_and_yoy_are_computed_for_comparable_periods(self):
        base = {}
        self.assertTrue(m._update_capex_totals(base, self.companies()))
        self.assertEqual(base["hyperscaler_capex_2026e_low_yi"], 4000)
        self.assertEqual(base["hyperscaler_capex_2026e_high_yi"], 4800)
        self.assertEqual(base["hyperscaler_capex_2026e_mid_yi"], 4400)
        self.assertEqual(base["hyperscaler_yoy_pct"], 120)

    def test_reviewed_incomparability_and_its_reason_survive_future_scans(self):
        base = {"comparison_comparable": False, "comparison_note": "Reviewed lease-basis change", "hyperscaler_yoy_pct": 99}
        self.assertTrue(m._update_capex_totals(base, self.companies()))
        self.assertIsNone(base["hyperscaler_yoy_pct"])
        self.assertEqual(base["comparison_note"], "Reviewed lease-basis change")
        self.assertEqual(base["hyperscaler_capex_2026e_mid_yi"], 4400)

    def test_one_company_incomparable_also_blocks_aggregate_yoy(self):
        companies = self.companies()
        companies["microsoft"]["comparison_comparable"] = False
        base = {"hyperscaler_yoy_pct": 99}
        m._update_capex_totals(base, companies)
        self.assertIsNone(base["hyperscaler_yoy_pct"])
        self.assertIs(base["comparison_comparable"], False)
        self.assertIn("口径", base["comparison_note"])

    def test_incomplete_actuals_cannot_reuse_an_old_aggregate_growth(self):
        companies = self.companies()
        companies["microsoft"]["actual_2025_yi"] = None
        base = {"hyperscaler_yoy_pct": 99}
        m._update_capex_totals(base, companies)
        self.assertIsNone(base["hyperscaler_yoy_pct"])

    def test_invalid_or_incomplete_guidance_does_not_mutate_saved_totals(self):
        for change in [None, float("nan"), -1]:
            with self.subTest(change=change):
                companies = self.companies()
                companies["meta"]["guidance_low_yi"] = change
                base = {"hyperscaler_capex_2026e_mid_yi": 7300}
                self.assertFalse(m._update_capex_totals(base, companies))
                self.assertEqual(base, {"hyperscaler_capex_2026e_mid_yi": 7300})


if __name__ == "__main__":
    unittest.main()
