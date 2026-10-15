import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from datetime import date, timedelta
import json
import tempfile

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "environment-risk-refresh_etf_shares.py"
if not SOURCE.exists():
    SOURCE = ROOT.parent / ".github" / "scripts" / "refresh_etf_shares.py"
spec = importlib.util.spec_from_file_location("etf_shares", SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ETFSharesTest(unittest.TestCase):
    days = ["2026-09-30", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"]

    def test_dates(self):
        self.assertEqual(m.iso_date("20261013"), "2026-10-13")
        self.assertIsNone(m.iso_date("2026-02-30"))
        self.assertIsNone(m.iso_date("2026-1-2"))

    def test_wan_units(self):
        self.assertEqual(m.shares_from_wan("2,489,718.77"), 24897187700)
        self.assertEqual(m.shares_from_wan("1.2345"), 12345)
        self.assertIsNone(m.shares_from_wan("1.23456"))

    def test_invalid_numbers(self):
        for value in (None, True, "-", "--", "NaN", "Infinity", "-2", "0"):
            self.assertIsNone(m.shares_from_wan(value))

    def test_exact_share_date(self):
        payload = {"result": [{"SEC_CODE": "510300", "STAT_DATE": "2026-10-13", "TOT_VOL": "12"}]}
        self.assertEqual(m.parse_share_rows(payload, "2026-10-13")["510300"]["shares"], 120000)
        with self.assertRaises(ValueError):
            m.parse_share_rows(payload, "2026-10-12")

    def test_same_day_nav_estimation(self):
        obs = {"2026-10-12": {"shares": 1000000}, "2026-10-13": {"shares": 1050000}}
        navs = {"2026-10-13": {"nav": 4.3479, "navDate": "2026-10-13", "navSource": "official"}}
        row = m.make_series(obs, navs, self.days)[-1]
        self.assertEqual(row["deltaShares"], 50000)
        self.assertEqual(row["changePct"], 5)
        self.assertEqual(row["estimatedFlowYuan"], 217395)

    def test_no_flow_from_nav_increase(self):
        obs = {"2026-10-12": {"shares": 1000000}, "2026-10-13": {"shares": 1000000}}
        navs = {"2026-10-12": {"nav": 4, "navDate": "2026-10-12"},
                "2026-10-13": {"nav": 5, "navDate": "2026-10-13"}}
        row = m.make_series(obs, navs, self.days)[-1]
        self.assertEqual(row["deltaShares"], 0)
        self.assertEqual(row["estimatedFlowYuan"], 0)

    def test_negative_redemption(self):
        obs = {"2026-10-12": {"shares": 1000000}, "2026-10-13": {"shares": 900000}}
        row = m.make_series(obs, {"2026-10-13": {"nav": 4.3479, "navDate": "2026-10-13"}}, self.days)[-1]
        self.assertEqual(row["estimatedFlowYuan"], -434790)

    def test_missing_or_wrong_day_nav_is_not_zero(self):
        obs = {"2026-10-12": {"shares": 1000000}, "2026-10-13": {"shares": 1100000}}
        for navs in ({}, {"2026-10-13": {"nav": 4, "navDate": "2026-10-12"}},
                     {"2026-10-13": {"nav": 0, "navDate": "2026-10-13"}}):
            row = m.make_series(obs, navs, self.days)[-1]
            self.assertEqual(row["deltaShares"], 100000)
            self.assertIsNone(row["estimatedFlowYuan"])

    def test_holiday_is_still_consecutive(self):
        obs = {"2026-09-30": {"shares": 1000000}, "2026-10-08": {"shares": 1050000}}
        row = m.make_series(obs, {}, self.days)[-1]
        self.assertEqual(row["deltaShares"], 50000)

    def test_missing_trading_day_not_daily(self):
        obs = {"2026-10-09": {"shares": 1000000}, "2026-10-13": {"shares": 1100000}}
        row = m.make_series(obs, {}, self.days)[-1]
        self.assertEqual(row["metricStatus"], "nonconsecutive")
        self.assertIsNone(row["deltaShares"])

    def test_suspected_split_not_flow(self):
        obs = {"2026-10-12": {"shares": 1000000}, "2026-10-13": {"shares": 2000000}}
        row = m.make_series(obs, {"2026-10-13": {"nav": 2, "navDate": "2026-10-13"}}, self.days)[-1]
        self.assertEqual(row["metricStatus"], "split_review")
        self.assertIsNone(row["deltaShares"])
        self.assertIsNone(row["estimatedFlowYuan"])

    def test_named_action_blocks_estimate(self):
        obs = {"2026-10-12": {"shares": 1000000}, "2026-10-13": {"shares": 1100000}}
        row = m.make_series(obs, {}, self.days, {"actions": [{"title": "份额折算"}]})[-1]
        self.assertEqual(row["metricStatus"], "split_review")

    def test_pcf_nav_belongs_to_previous_trading_day(self):
        payload = {"result": [{"TRADE_CODE": "510300", "TRADING_DAY": "20261014",
            "PRE_TRADING_DAY": "20261013", "NAV": "￥4.3479"}]}
        result = m.parse_pcf_nav(payload, "510300")
        self.assertEqual(result["2026-10-13"]["nav"], 4.3479)
        self.assertNotIn("2026-10-14", result)
        self.assertEqual(m.parse_pcf_nav(payload, "510500"), {})

    def test_unit_nav_not_accumulated_nav(self):
        payload = {"Data": {"LSJZList": [{"FSRQ": "2026-10-13", "DWJZ": "4.3479", "LJJZ": "1.9393"}]}}
        result = m.parse_nav_rows(payload, "2026-10-09", "2026-10-13")
        self.assertEqual(result["2026-10-13"]["nav"], 4.3479)

    def test_nav_pagination_when_provider_caps_page_size(self):
        payloads = [{"Data": {"LSJZList": [{"FSRQ": day, "DWJZ": "4.0"}]}, "TotalCount": 3}
                    for day in ("2026-10-13", "2026-10-12", "2026-10-09")]
        with patch.object(m, "request_json", side_effect=payloads) as fetched, \
             patch.object(m, "sse_json", return_value={"result": []}):
            navs, warnings = m.fetch_nav("510300", "2026-10-09", "2026-10-13")
        self.assertEqual(len(navs), 3)
        self.assertEqual(fetched.call_count, 3)
        self.assertEqual(warnings, [])

    def cache_fixture(self):
        dates = []
        day = date(2026, 7, 1)
        while len(dates) < 61:
            if day.weekday() < 5:
                dates.append(day.isoformat())
            day += timedelta(days=1)
        old = {"schemaVersion": 1, "tradingDates": dates,
               "funds": [{**fund, "series": [{"date": day, "shares": 1000000 + index * 100}
                   for index, day in enumerate(dates)]} for fund in m.FUNDS]}
        return dates, old

    def test_valid_cache_rejects_malformed_or_missing_fund(self):
        _, old = self.cache_fixture()
        self.assertTrue(m.valid_cache(old))
        old["funds"][0]["series"][0]["shares"] = "bad"
        self.assertFalse(m.valid_cache(old))
        _, old = self.cache_fixture()
        old["funds"].pop()
        self.assertFalse(m.valid_cache(old))

    def test_incremental_only_refetches_prior_day(self):
        days, old = self.cache_fixture()
        def shares(day=""):
            day = day or days[-1]
            return {fund["code"]: {"date": day, "shares": 1000000 + days.index(day) * 100}
                    for fund in m.FUNDS}
        with patch.object(m, "fetch_calendar", return_value=days), \
             patch.object(m, "fetch_shares", side_effect=shares) as fetched, \
             patch.object(m, "fetch_nav", return_value=({}, [])), \
             patch.object(m, "check_disclosures", return_value={"actions": []}):
            result = m.refresh(old)
        self.assertEqual(fetched.call_count, 2)  # Latest + one prior-day revision check, not 61 dates.
        self.assertEqual(result["asOf"], days[-1])
        self.assertTrue(m.valid_cache(result))
        self.assertIsInstance(result["source"], str)
        self.assertIsInstance(result["methodology"], str)

    def test_regressed_source_does_not_overwrite_cache(self):
        days, old = self.cache_fixture()
        older = {fund["code"]: {"date": days[-2], "shares": 1000000} for fund in m.FUNDS}
        with patch.object(m, "fetch_calendar", return_value=days), \
             patch.object(m, "fetch_shares", return_value=older):
            with self.assertRaisesRegex(RuntimeError, "regressed"):
                m.refresh(old)

    def test_failed_refresh_keeps_file_byte_identical(self):
        _, old = self.cache_fixture()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "cache.json"
            text = json.dumps(old)
            output.write_text(text)
            with patch("sys.argv", ["refresh", "--output", str(output)]), \
                 patch.object(m, "refresh", side_effect=RuntimeError("network unavailable")):
                self.assertEqual(m.main(), 1)
            self.assertEqual(output.read_text(), text)


if __name__ == "__main__":
    unittest.main()
