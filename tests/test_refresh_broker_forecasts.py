"""Synthetic source-contract and selection tests; no market fixtures asserted."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / ".github/scripts/refresh_broker_forecasts.py"
SPEC = importlib.util.spec_from_file_location("refresh_broker_forecasts", SCRIPT)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
ASOF, CHECK = "2026-11-04", "2026-11-04T18:00:00+08:00"


def arow(value=10e8, date="2026-11-03", broker="1", **extra):
    return {"SECURITY_CODE": "300308", "SECUCODE": "300308.SZ", "PUBLISH_DATE": date,
            "ORG_CODE": broker, "ORG_NAME_ABBR": "机构"+broker, "RESEARCHER": "研究员",
            "YEAR1": 2025, "YEAR_MARK1": "A", "PARENT_NETPROFIT1": 999e8,
            "YEAR2": 2026, "YEAR_MARK2": "E", "PARENT_NETPROFIT2": value,
            "EPS2": 777, **extra}


def report(value=10, date="2026-11-03", broker="1", **extra):
    return {"id": "r-"+broker+date, "brokerCode": broker, "broker": "机构"+broker,
            "publishedAt": date, "forecastYear": 2026, "currency": "CNY", "profitYi": value,
            "url": "https://example.com/report", **extra}


def mapping():
    return {"schemaVersion": 1, "complete": True, "total": 1, "checkedAt": ASOF,
            "pairs": [{"hkCode": "03308", "aCode": "300308", "aMarket": "SZ"}]}


class ASourceTests(unittest.TestCase):
    def parse(self, rows):
        return m.parse_a_forecasts({"ycmx": rows}, "300308", 2026, ASOF)

    def test_exact_target_e_profit_not_eps_or_actual(self):
        r = self.parse([arow()])[0]
        self.assertEqual(r["profitYi"], 10)
        self.assertEqual(r["forecastYear"], 2026)
        self.assertEqual(r["metric"], "parent_net_profit")
        self.assertEqual(r["currency"], "CNY")
        self.assertIn("ProfitForecast/Index", r["url"])

    def test_target_year_can_be_in_another_slot(self):
        rows = self.parse([arow(YEAR2=2027, YEAR3=2026, YEAR_MARK3="E", PARENT_NETPROFIT3=12e8)])
        self.assertEqual(rows[0]["profitYi"], 12)

    def test_actual_wrong_year_and_ambiguous_year_are_excluded(self):
        for change in [{"YEAR_MARK2": "A"}, {"YEAR2": 2027}, {"YEAR3": 2026, "YEAR_MARK3": "E", "PARENT_NETPROFIT3": 12e8}]:
            self.assertEqual(self.parse([arow(**change)]), [])

    def test_profit_zero_and_loss_are_valid_but_missing_is_not_zero(self):
        self.assertEqual([r["profitYi"] for r in self.parse([arow(0), arow(-3e8, broker="2")])], [0, -3])
        for value in [None, "", True, float("nan"), float("inf")]:
            self.assertEqual(self.parse([arow(value)]), [])

    def test_identity_currency_future_and_aggregate_guards(self):
        for change in [{"SECURITY_CODE": "300476"}, {"SECUCODE": "300308.SH"}, {"CURRENCY_CODE": "USD"},
                       {"PUBLISH_DATE": "2026-11-05"}, {"ORG_CODE": "00000000"}, {"ORG_NAME_ABBR": "近六月平均"}]:
            self.assertEqual(self.parse([arow(**change)]), [])

    def test_missing_detail_table_is_source_failure_not_empty_success(self):
        for payload in [{}, {"jgyc": [arow()]}, {"ycmx": None}]:
            with self.assertRaises(ValueError):
                m.parse_a_forecasts(payload, "300308", 2026, ASOF)
        self.assertEqual(self.parse([]), [])

    def test_stable_report_id_does_not_depend_on_share_price_eps_or_order(self):
        first = self.parse([arow()])[0]
        second = self.parse([arow(EPS2=1, PE2=10)])[0]
        self.assertEqual(first["id"], second["id"])

    def test_empty_http200_then_bom_json_retries_with_cache_bust(self):
        responses = iter(["", "\ufeff" + json.dumps({"ycmx": [arow()]})])
        urls = []
        def fetch(url):
            urls.append(url)
            return next(responses)
        with patch.object(m.time, "sleep"):
            result = m.fetch_reports({"market": "A", "code": "300308"}, 2026, ASOF, fetch)
        self.assertEqual(len(result), 1)
        self.assertNotIn("&_=" , urls[0])
        self.assertIn("&_=" , urls[1])

    def test_missing_table_and_html_are_retried_but_empty_table_is_confirmed(self):
        replies = iter(["<html>temporary</html>", json.dumps({}), json.dumps({"ycmx": []})])
        with patch.object(m.time, "sleep") as pause:
            self.assertEqual(m.fetch_reports({"market": "A", "code": "300308"}, 2026, ASOF, lambda url: next(replies)), [])
        self.assertEqual(pause.call_count, 2)


class SelectionTests(unittest.TestCase):
    def test_latest_five_institutions_and_fewer_than_five(self):
        rows = [report(i, f"2026-11-{i:02d}", str(i)) for i in range(1, 5)]
        self.assertEqual(len(m.select_reports(rows, 2026, ASOF)), 4)
        rows += [report(5, broker="5"), report(6, broker="6"), report(7, broker="7")]
        chosen = m.select_reports(rows, 2026, ASOF)
        self.assertEqual(len(chosen), 5)
        self.assertEqual(chosen[0]["publishedAt"], "2026-11-04")

    def test_one_latest_per_broker_with_duplicate_id_removed(self):
        rows = [report(10, "2026-10-01"), report(20, "2026-11-03"), report(20, "2026-11-03")]
        chosen = m.select_reports(rows, 2026, ASOF)
        self.assertEqual(len(chosen), 1)
        self.assertEqual(chosen[0]["profitYi"], 20)

    def test_day_ties_preserve_provider_order_instead_of_inventing_time(self):
        rows = [report(30, broker="3"), report(10, broker="1")]
        self.assertEqual([r["profitYi"] for r in m.select_reports(rows, 2026, ASOF)], [30, 10])

    def test_different_currencies_never_share_a_mean(self):
        with self.assertRaisesRegex(ValueError, "Mixed"):
            m.select_reports([report(), report(broker="2", currency="HKD")], 2026, ASOF)

    def test_conflicting_same_report_identity_never_first_wins(self):
        base = report()
        for change in [{"profitYi": 11}, {"currency": "USD"}, {"forecastYear": 2025}]:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "Conflicting"):
                m.select_reports([base, {**base, **change}], 2026, ASOF)

    def test_no_reports_is_null_not_zero_and_full_precision_mean(self):
        item = {"market": "A", "code": "300308"}
        blank = m.summarize(item, [], 2026, ASOF, CHECK)
        self.assertIsNone(blank["meanProfitYi"])
        self.assertEqual(blank["status"], "no_reports")
        result = m.summarize(item, [report(1, broker="1"), report(2, broker="2"), report(2, broker="3")], 2026, ASOF, CHECK)
        self.assertEqual(result["meanProfitYi"], 5/3)


class MappingTests(unittest.TestCase):
    def test_unheld_a_counterpart_replaces_hk_and_deduplicates_universe(self):
        p = {"sectors": [{"stocks": [{"mkt": "HK", "code": "03308"}, {"mkt": "HK", "code": "00700"}, {"mkt": "SZ", "code": "300308"}]}]}
        sources, lookup = m.universe(p, m.parse_ah_map(mapping()))
        self.assertEqual(set(sources), {"A:300308", "HK:00700"})
        self.assertEqual(lookup["HK:03308"], "A:300308")

    def test_incomplete_mapping_cannot_silently_treat_hk_as_pure(self):
        for change in [{"complete": False}, {"total": 2}, {"pairs": []}]:
            with self.assertRaises(ValueError):
                m.parse_ah_map({**mapping(), **change})

    def test_wrong_market_or_duplicate_mapping_fails(self):
        bad = mapping(); bad["pairs"][0]["aMarket"] = "SH"
        with self.assertRaises(ValueError):
            m.parse_ah_map(bad)
        bad = mapping(); bad["pairs"] *= 2; bad["total"] = 2
        with self.assertRaises(ValueError):
            m.parse_ah_map(bad)


class RetentionAndBuildTests(unittest.TestCase):
    ITEM = {"market": "A", "code": "300308"}

    def test_transient_error_preserves_valid_same_year_value_and_date(self):
        old = m.summarize(self.ITEM, [report(7)], 2026, ASOF, CHECK)
        kept = m.summarize(self.ITEM, [], 2026, ASOF, "2026-11-04T19:00:00+08:00", old, "network failure")
        self.assertEqual(kept["meanProfitYi"], 7)
        self.assertTrue(kept["stale"])
        self.assertEqual(kept["status"], "source_error")
        self.assertEqual(kept["updatedAt"], CHECK)

    def test_prior_year_or_other_metric_value_is_not_carried_forward(self):
        old = m.summarize(self.ITEM, [report(7)], 2026, ASOF, CHECK)
        for change in [{"forecastYear": 2025}, {"metric": "deducted_profit"}, {"code": "300476"}]:
            kept = m.summarize(self.ITEM, [], 2026, ASOF, CHECK, {**old, **change}, "failure")
            self.assertIsNone(kept["meanProfitYi"])

    def test_confirmed_empty_replaces_old_value_instead_of_faking_forecast(self):
        old = m.summarize(self.ITEM, [report(7)], 2026, ASOF, CHECK)
        result = m.summarize(self.ITEM, [], 2026, ASOF, CHECK, old)
        self.assertIsNone(result["meanProfitYi"])
        self.assertEqual(result["status"], "no_reports")

    def test_hk_source_has_distinct_provider_profit_metric(self):
        result = m.summarize({"market": "HK", "code": "00700"}, [report(10, currency="HKD")], 2026, ASOF, CHECK)
        self.assertEqual(result["metric"], "net_profit")
        self.assertEqual(result["currency"], "HKD")

    def test_unchanged_inputs_move_check_time_not_evidence_update(self):
        p = {"sectors": [{"stocks": [{"mkt": "HK", "code": "03308"}]}]}
        raw = json.dumps({"ycmx": [arow()]})
        first = m.build_snapshot(p, mapping(), as_of=ASOF, checked_at=CHECK, fetch=lambda url: raw)
        later = "2026-11-04T19:00:00+08:00"
        second = m.build_snapshot(p, mapping(), first, ASOF, later, fetch=lambda url: raw)
        self.assertEqual(second["generatedAt"], CHECK)
        self.assertEqual(second["lastChecked"], later)
        self.assertEqual(second["stocks"]["A:300308"]["updatedAt"], CHECK)
        self.assertEqual(first["lookup"], {"HK:03308": "A:300308"})

    def test_one_stock_failure_does_not_prevent_other_stock_update(self):
        p = {"sectors": [{"stocks": [{"mkt": "HK", "code": "03308"}, {"mkt": "HK", "code": "00700"}]}]}
        def fetch(url):
            if "etnet" in url:
                raise RuntimeError("unreachable")
            return json.dumps({"ycmx": [arow()]})
        result = m.build_snapshot(p, mapping(), as_of=ASOF, checked_at=CHECK, fetch=fetch)
        self.assertEqual(result["stocks"]["A:300308"]["status"], "ok")
        self.assertEqual(result["stocks"]["HK:00700"]["status"], "source_error")

    def test_all_http200_invalid_responses_preserve_same_year_cached_value(self):
        p = {"sectors": [{"stocks": [{"mkt": "HK", "code": "03308"}]}]}
        first = m.build_snapshot(p, mapping(), as_of=ASOF, checked_at=CHECK, fetch=lambda url: json.dumps({"ycmx": [arow()]}))
        attempts = []
        def fetch(url):
            attempts.append(url)
            return "<html>temporary cache failure</html>"
        with patch.object(m.time, "sleep"):
            result = m.build_snapshot(p, mapping(), first, ASOF, "2026-11-04T19:00:00+08:00", fetch=fetch)
        entry = result["stocks"]["A:300308"]
        self.assertEqual(len(attempts), 3)
        self.assertEqual(entry["status"], "source_error")
        self.assertTrue(entry["stale"])
        self.assertEqual(entry["meanProfitYi"], 10)
        self.assertEqual(entry["updatedAt"], CHECK)


if __name__ == "__main__":
    unittest.main()
