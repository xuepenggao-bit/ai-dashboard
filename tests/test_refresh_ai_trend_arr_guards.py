"""Synthetic ARR regressions. These fixture amounts are not market evidence."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
import tempfile
from unittest import mock

SCRIPT = Path(__file__).with_name("refresh_ai_trend.py")
if not SCRIPT.exists():
    SCRIPT = Path(__file__).resolve().parents[1] / ".github" / "scripts" / "refresh_ai_trend.py"
SPEC = importlib.util.spec_from_file_location("refresh_ai_trend_arr_guards", SCRIPT)
m = importlib.util.module_from_spec(SPEC)
with mock.patch.dict(sys.modules, {"requests": types.SimpleNamespace()}):
    SPEC.loader.exec_module(m)


def result(text, date="2026-10-08", url="https://www.reuters.com/technology/reviewed-run-rate/"):
    return {"title": "OpenAI update", "body": text, "date": date, "url": url}


def candidate(value=500, date="2026-10-08", **extra):
    return {"arr_yi": value, "source_date": date, "source_url": "https://www.reuters.com/technology/reviewed-run-rate/",
            "metric_period": "2026-09", "basis": "gross_annualized_revenue_run_rate", **extra}


class ArrExtractionTests(unittest.TestCase):
    def test_current_reported_amount_and_explicit_period_are_bound(self):
        c = m._arr_candidate("openai", m.ARR_COMPANIES["openai"], [result("OpenAI's gross annualized revenue at the end of September 2026 reached $50 billion.")])
        self.assertEqual(c["arr_yi"], 500)
        self.assertEqual(c["metric_period"], "2026-09")
        self.assertEqual(c["basis"], "gross_annualized_revenue_run_rate")

    def test_predicted_arr_is_not_realized(self):
        for text in ["OpenAI expects annualized revenue to reach $100 billion by the end of 2026.",
                     "OpenAI targets ARR of $100 billion in December 2026.",
                     "OpenAI annualized revenue could reach $100 billion.",
                     "OpenAI is on track for annualized revenue of $100 billion."]:
            with self.subTest(text=text):
                self.assertEqual(m._arr_candidate("openai", m.ARR_COMPANIES["openai"], [result(text)]), {})

    def test_realized_and_forecast_in_separate_sentences_do_not_mix(self):
        c = m._arr_candidate("openai", m.ARR_COMPANIES["openai"], [result("OpenAI annualized revenue reached $50 billion in September 2026. OpenAI expects annualized revenue of $100 billion by December 2026.")])
        self.assertEqual(c["arr_yi"], 500)
        self.assertEqual(c["metric_period"], "2026-09")

    def test_correction_excludes_not_amount(self):
        c = m._arr_candidate("openai", m.ARR_COMPANIES["openai"], [result("OpenAI gross annualized revenue for September 2026 was corrected to $50 billion, not $70 billion.")])
        self.assertEqual(c["arr_yi"], 500)
        self.assertTrue(c["correction"])

    def test_explicit_corrected_to_amount_overrides_nearer_old_amount(self):
        c = m._arr_candidate("openai", m.ARR_COMPANIES["openai"], [result("OpenAI's gross $70 billion annualized revenue figure for September 2026 was corrected to $50 billion.")])
        self.assertEqual(c["arr_yi"], 500)
        self.assertTrue(c["correction"])

    def test_wrong_entity_and_untrusted_url_are_rejected(self):
        self.assertEqual(m._arr_candidate("openai", m.ARR_COMPANIES["openai"], [result("AWS annualized revenue reached $100 billion; OpenAI is a customer.")]), {})
        self.assertEqual(m._arr_candidate("openai", m.ARR_COMPANIES["openai"], [result("OpenAI ARR reached $50 billion.", url="https://untrusted.example/story")]), {})


class ArrAcceptanceTests(unittest.TestCase):
    def base(self):
        return {"arr_latest_events": {"openai": {"source_date": "2026-09-29", "arr_yi": 700, "basis": "gross_annualized_revenue_run_rate"}},
                "arr_sources": {"openai": {"source_date": "2026-09-29", "arr_yi": 700, "basis": "gross_annualized_revenue_run_rate"}}}

    def test_newer_same_basis_lower_value_is_allowed(self):
        self.assertEqual(m._arr_numeric_rejection(self.base(), "openai", candidate(500)), "")

    def test_missing_date_or_direct_source_is_not_an_authorized_decline(self):
        for change in [{"source_date": ""}, {"source_url": "https://reuters.com/"}, {"arr_yi": 0}]:
            self.assertTrue(m._arr_numeric_rejection(self.base(), "openai", candidate(**change)))

    def test_older_amount_and_same_date_conflict_are_rejected(self):
        self.assertIn("older", m._arr_numeric_rejection(self.base(), "openai", candidate(date="2026-09-01")))
        self.assertIn("same-date", m._arr_numeric_rejection(self.base(), "openai", candidate(date="2026-09-29")))
        self.assertEqual(m._arr_numeric_rejection(self.base(), "openai", candidate(date="2026-09-29", correction=True)), "")

    def test_changed_accounting_basis_needs_explicit_correction(self):
        self.assertIn("basis", m._arr_numeric_rejection(self.base(), "openai", candidate(basis="net_annualized_revenue_run_rate")))

    def test_legacy_basis_prose_does_not_freeze_dated_future_updates(self):
        base = self.base()
        for point in [base["arr_latest_events"]["openai"], base["arr_sources"]["openai"]]:
            point["basis"] = "公开披露的年化收入运行率，非实际年度营收"
        self.assertEqual(m._arr_numeric_rejection(base, "openai", candidate(basis="annualized_revenue_run_rate")), "")

    def test_newer_story_about_older_measurement_is_not_a_new_milestone(self):
        base = self.base()
        for point in [base["arr_latest_events"]["openai"], base["arr_sources"]["openai"]]:
            point["metric_period"] = "2026-09"
        self.assertIn("older numeric measurement", m._arr_numeric_rejection(base, "openai", candidate(metric_period="2026-08")))

    def test_future_or_invalid_measurement_and_forecast_are_rejected(self):
        for change in [{"metric_period": "2026-11"}, {"metric_period": "2026-99"},
                       {"disclosure_type": "forecast"}, {"arr_yi": float("nan")}]:
            with self.subTest(change=change):
                self.assertTrue(m._arr_numeric_rejection(self.base(), "openai", candidate(**change)))


class ArrUpsertTests(unittest.TestCase):
    def base(self):
        return {"arr_labels": ["2025末", "2026-09"], "arr_openai": [214, 700], "arr_anthropic": [90, None],
                "arr_sources": {"openai": {"source_date": "2026-09-29", "arr_yi": 700}}}

    def test_same_period_correction_replaces_september_without_false_october_fall(self):
        base = self.base()
        self.assertTrue(m._upsert_arr_value(base, "openai", "2026-10-08", 500, "2026-09", True))
        self.assertEqual(base["arr_labels"], ["2025末", "2026-09"])
        self.assertEqual(base["arr_openai"], [214, 500])

    def test_same_month_new_disclosure_can_lower_amount(self):
        base = self.base()
        self.assertTrue(m._upsert_arr_value(base, "openai", "2026-09-30", 650, "2026-09"))
        self.assertEqual(base["arr_openai"][-1], 650)

    def test_real_later_month_decline_is_not_suppressed(self):
        base = self.base()
        self.assertTrue(m._upsert_arr_value(base, "openai", "2026-10-30", 600, "2026-10"))
        self.assertEqual(base["arr_openai"], [214, 700, 600])

    def test_stale_direct_upsert_does_not_overwrite_source_date_guard(self):
        base = self.base()
        self.assertFalse(m._upsert_arr_value(base, "openai", "2026-09-01", 900, "2026-09"))
        self.assertEqual(base["arr_openai"][-1], 700)


class ArrMainIntegrationTests(unittest.TestCase):
    def test_reviewed_same_period_correction_passes_full_main_guard(self):
        before = {"arr_labels": ["2026-09"], "arr_openai": [700], "arr_anthropic": [None],
                  "arr_latest_events": {"openai": {"numeric": True, "source_date": "2026-09-29", "arr_yi": 700, "basis": "gross_annualized_revenue_run_rate"}},
                  "arr_sources": {"openai": {"source_date": "2026-09-29", "arr_yi": 700, "basis": "gross_annualized_revenue_run_rate"}}}
        article = result("OpenAI gross annualized revenue for September 2026 was corrected to $50 billion, not $70 billion.")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "ai_trend.json"
            output.write_text(json.dumps(before), encoding="utf-8")
            with mock.patch.object(m, "OUT", str(output)), mock.patch.object(m, "latest_capex_results", return_value=[]), \
                 mock.patch.object(m, "latest_arr_results", side_effect=lambda key, cfg: [article] if key == "openai" else []):
                m.main()
            after = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(after["arr_labels"], ["2026-09"])
        self.assertEqual(after["arr_openai"], [500])
        self.assertEqual(after["arr_latest_events"]["openai"]["metric_period"], "2026-09")
        self.assertEqual(after["arr_sources"]["openai"]["source_date"], "2026-10-08")
        self.assertTrue(after["arr_sources"]["openai"]["correction"])


if __name__ == "__main__":
    unittest.main()

