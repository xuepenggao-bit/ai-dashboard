import datetime as dt
import importlib.util
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse


SCRIPT = Path(__file__).resolve().parents[1] / ".github" / "scripts" / "refresh_chain_monitor.py"
SPEC = importlib.util.spec_from_file_location("refresh_chain_monitor", SCRIPT)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
AS_OF = "2026-10-09"
NOW = dt.datetime(2026, 10, 9, 12, 30, tzinfo=m.BEIJING)


def row(date, revenue, profit, deducted=None, cash=None, code="000977", notice=None):
    if notice is None:
        notice = (dt.date.fromisoformat(date) + dt.timedelta(days=30)).isoformat()
    return {"SECURITY_CODE": code, "SECURITY_NAME_ABBR": "测试公司", "REPORT_DATE": date + " 00:00:00",
            "NOTICE_DATE": notice + " 00:00:00", "CURRENCY": "CNY", "TOTALOPERATEREVE": revenue,
            "PARENTNETPROFIT": profit, "KCFJCXSYJLR": profit if deducted is None else deducted,
            "NETCASH_OPERATE_PK": revenue / 10 if cash is None else cash}


def fixture(code="000977"):
    return [row("2026-06-30", 300, 60, 54, 15, code), row("2026-03-31", 100, 20, 18, 10, code),
            row("2025-12-31", 400, 80, 72, 40, code), row("2025-06-30", 200, 40, 36, 20, code),
            row("2025-03-31", 80, 16, 14.4, 8, code)]


def tencent(code="000977", price=10, cap=100, date="20261009120515", pe39="123.45"):
    fields = [""] * 90
    for index, value in {1: "测试", 2: code, 3: price, 4: 9.9, 30: date, 32: 1.01,
                         39: pe39, 44: 50, 45: cap, 46: 3.7, 53: 888}.items():
        fields[index] = str(value)
    return 'v_sz' + code + '="' + "~".join(fields) + '";'


def quote(date="2026-10-09", date_time="2026-10-09T12:05:00+08:00", price=10):
    return {"price": price, "capYi": 100, "changePct": 1, "pb": 3,
            "date": date, "dateTime": date_time, "source": "test",
            "peTtm": 20, "peTtmDate": "2026-10-08", "peTtmSource": "explicit PE_TTM"}


class FinancialsTests(unittest.TestCase):
    def test_universe_is_ten_groups_twenty_nine_unique_stocks(self):
        codes = [code for group in m.GROUPS for code in group["codes"]]
        self.assertEqual(len(m.GROUPS), 10)
        self.assertEqual(len(codes), 29)
        self.assertEqual(len(set(codes)), 29)
        self.assertNotIn("002075", codes)
        self.assertNotIn("600804", codes)

    def test_q2_is_difference_not_half_year_total(self):
        stock = m.build_financials("000977", fixture(), AS_OF)
        financials = stock["financials"]
        self.assertEqual(stock["reportPeriod"], "2026H1")
        self.assertEqual(stock["disclosureDate"], "2026-07-30")
        self.assertEqual(financials["current"]["revenue"], 300)
        self.assertEqual(financials["previous"]["revenue"], 200)
        self.assertEqual(financials["q2"]["revenue"], 200)
        self.assertEqual(financials["q2"]["previous"]["revenue"], 120)
        self.assertAlmostEqual(financials["q2"]["yoy"]["revenue"], 200 / 120 * 100 - 100)
        self.assertEqual(financials["q2VsQ1"]["revenue"], 100)
        self.assertEqual(financials["q2"]["operatingCashFlow"], 5)
        self.assertEqual(financials["ttm"]["revenue"], 500)
        self.assertEqual(financials["ttm"]["netProfit"], 100)
        self.assertEqual(financials["ttm"]["deductedProfit"], 90)
        self.assertEqual(financials["ttm"]["operatingCashFlow"], 35)

    def test_future_period_and_undisclosed_report_are_rejected(self):
        rows = fixture() + [row("2026-09-30", 999, 999, notice="2026-10-20"),
                            row("2026-12-31", 9999, 9999, notice="2026-10-08")]
        rows.append({**row("2026-09-30", 500, 100), "NOTICE_DATE": None})
        self.assertEqual(m.build_financials("000977", rows, AS_OF)["reportPeriod"], "2026H1")

    def test_latest_quarter_rolls_forward_when_q3_is_disclosed(self):
        rows = fixture() + [row("2026-09-30", 450, 120, 108, 35, notice="2026-10-20"),
                            row("2025-09-30", 310, 70, 60, 22, notice="2025-10-20")]
        stock = m.build_financials("000977", rows, "2026-11-01")
        latest = stock["financials"]["latestQuarter"]
        previous = stock["financials"]["previousQuarter"]
        self.assertEqual(stock["reportPeriod"], "20269M")
        self.assertEqual(latest["period"], "2026Q3")
        self.assertEqual(previous["period"], "2026Q2")
        self.assertEqual(latest["revenue"], 150)
        self.assertEqual(latest["previous"]["revenue"], 110)
        self.assertAlmostEqual(latest["yoy"]["revenue"], 40 / 110 * 100)

    def test_negative_and_zero_bases_are_visible(self):
        rows = [row("2026-06-30", 110, 10, 0, -10), row("2025-06-30", 100, -5, 0, -20)]
        financials = m.build_financials("000977", rows, AS_OF)["financials"]
        self.assertEqual(financials["previous"]["netProfit"], -5)
        self.assertEqual(financials["yoyBase"]["netProfit"], "negative")
        self.assertEqual(financials["yoy"]["netProfit"], 300)
        self.assertEqual(financials["yoyBase"]["deductedProfit"], "zero")
        self.assertIsNone(financials["yoy"]["deductedProfit"])
        self.assertIsNone(financials["ttm"]["netProfit"])

    def test_missing_metric_is_not_zero_or_backsolved(self):
        rows = fixture()
        rows[0]["KCFJCXSYJLR"] = None
        stock = m.build_financials("000977", rows, AS_OF)
        self.assertIsNone(stock["financials"]["current"]["deductedProfit"])
        self.assertIsNone(stock["financials"]["q2"]["deductedProfit"])
        self.assertEqual(stock["financialStatus"], "partial")

    def test_same_period_partial_refresh_keeps_prior_valid_metrics(self):
        prior = m.build_financials("000977", fixture(), AS_OF)["financials"]
        rows = fixture()
        rows[0]["KCFJCXSYJLR"] = None
        fresh = m.build_financials("000977", rows, AS_OF)["financials"]
        fresh["current"]["revenue"] = 999
        retained = m.keep_same_period_metrics(fresh, prior)
        self.assertEqual(fresh["current"]["revenue"], 300)
        self.assertEqual(fresh["current"]["deductedProfit"], 54)
        self.assertEqual(fresh["ttm"]["deductedProfit"], 90)
        self.assertIn("current.deductedProfit", retained)

    def test_wrong_issuer_and_currency_cannot_cross_contaminate(self):
        rows = fixture("300308")
        self.assertIsNone(m.build_financials("000977", rows, AS_OF))
        rows = [{**entry, "CURRENCY": "HKD"} for entry in fixture()]
        self.assertIsNone(m.build_financials("000977", rows, AS_OF))

    def test_annual_ttm_is_actual_annual_not_double_counted(self):
        stock = m.build_financials("000977", fixture()[2:], "2026-02-10")
        self.assertEqual(stock["reportPeriod"], "2025FY")
        self.assertEqual(stock["financials"]["ttm"]["revenue"], 400)

    def test_api_has_single_quoted_dates_and_paginated_report(self):
        params = parse_qs(urlparse(m.api_url(m.FIN_REPORT, ["000977", "300308"], AS_OF, 2)).query)
        self.assertIn("(NOTICE_DATE<='2026-10-09')", params["filter"][0])
        self.assertIn('(SECURITY_CODE in ("000977","300308"))', params["filter"][0])
        self.assertEqual(params["pageNumber"], ["2"])
        self.assertEqual(params["pageSize"], ["500"])


class QuoteTests(unittest.TestCase):
    def test_tencent_fields_timestamp_and_39_do_not_become_ttm(self):
        parsed = m.parse_tencent(tencent(), AS_OF, NOW)["000977"]
        self.assertEqual(parsed["capYi"], 100)
        self.assertEqual(parsed["providerPe39"], 123.45)
        self.assertEqual(parsed["providerPe53"], 888)
        self.assertIsNone(parsed["peTtm"])
        self.assertEqual(parsed["dateTime"], "2026-10-09T12:05:15+08:00")
        self.assertEqual(parsed["marketCapBasis"], "total_shares_at_A_price")

    def test_future_malformed_and_old_quotes_are_rejected(self):
        for stamp in ("20261010120515", "20261009130000", "20260101000000", "garbage"):
            self.assertEqual(m.parse_tencent(tencent(date=stamp), AS_OF, NOW), {})
        self.assertEqual(m.parse_tencent(tencent(price=0), AS_OF, NOW), {})

    def test_explicit_ttm_is_used_not_static_or_dynamic(self):
        rows = [{"SECURITY_CODE": "000977", "TRADE_DATE": "2026-10-08", "CLOSE_PRICE": 10,
                 "TOTAL_MARKET_CAP": 10e9, "PE_TTM": 30, "PE_LAR": 999, "PB_MRQ": 3, "CHANGE_RATE": 1}]
        parsed = m.parse_valuations(rows, AS_OF)["000977"]
        self.assertEqual(parsed["peTtm"], 30)
        self.assertEqual(parsed["capYi"], 100)
        self.assertIn("PE_TTM", parsed["peTtmSource"])

    def test_negative_ttm_has_no_positive_pe(self):
        result = m.combine_quotes(None, quote(), None, {"ttm": {"netProfit": -100}}, AS_OF)
        self.assertIsNone(result["peTtmCalculated"])

    def test_older_quote_does_not_replace_newer_saved_quote(self):
        old = quote(price=11)
        older = quote("2026-10-08", "2026-10-08T15:00:00+08:00", 10)
        result = m.combine_quotes(old, older, older, {"ttm": {"netProfit": 1e9}}, AS_OF)
        self.assertEqual(result["price"], 11)
        self.assertEqual(result["peTtmCalculated"], 10)

    def test_same_timestamp_fresh_field_correction_wins(self):
        old = quote()
        old["capYi"] = 80
        live = quote()
        live["capYi"] = 100
        result = m.combine_quotes(old, live, None, {"ttm": {"netProfit": 1e9}}, AS_OF)
        self.assertEqual(result["capYi"], 100)
        self.assertEqual(result["peTtmCalculated"], 10)


class RefreshTests(unittest.TestCase):
    def test_all_empty_refresh_refuses_empty_snapshot(self):
        with self.assertRaisesRegex(RuntimeError, "refusing"):
            m.refresh({}, AS_OF, NOW, lambda *args: ([], []), lambda *args: "")

    def test_failed_refresh_keeps_previous_and_marks_stale(self):
        prior_stock = m.build_financials("000977", fixture(), AS_OF)
        prior_stock["quote"] = quote()
        prior_stock["sources"] = [{"name": "saved", "url": "https://example.com/verified"}]
        prior = {"stocks": [prior_stock], "lastSuccessAt": "2026-10-08T15:00:00+08:00"}
        def failed(*args):
            raise RuntimeError("network unavailable")
        result = m.refresh(prior, AS_OF, NOW, failed, failed)
        saved = result["stocks"][0]
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["lastSuccessAt"], prior["lastSuccessAt"])
        self.assertEqual(saved["financials"]["current"]["revenue"], 300)
        self.assertEqual(saved["status"], "stale")
        self.assertIn("financial_refresh_failed_kept_previous", saved["errors"])
        self.assertEqual(saved["sources"][0]["url"], "https://example.com/verified")

    def test_older_financial_report_does_not_replace_saved_newer_period(self):
        prior_stock = m.build_financials("000977", fixture(), AS_OF)
        prior = {"stocks": [prior_stock]}
        def older(report, codes, cutoff):
            return (fixture()[1:], []) if report == m.FIN_REPORT else ([], [])
        result = m.refresh(prior, AS_OF, NOW, older, lambda *args: "")
        self.assertEqual(result["stocks"][0]["reportPeriod"], "2026H1")
        self.assertIn("financial_report_older_than_saved", result["stocks"][0]["errors"])

    def test_fresh_full_universe_schema_and_source_urls(self):
        def fetch(report, codes, cutoff):
            return ([entry for code in codes for entry in fixture(code)] if report == m.FIN_REPORT else [], [])
        result = m.refresh({}, AS_OF, NOW, fetch, lambda *args: "".join(tencent(code) for code in m.NAMES))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["coverage"]["freshFinancials"], 29)
        self.assertEqual(result["coverage"]["quotes"], 29)
        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["stocks"][0]["group"], "server")
        self.assertTrue(result["stocks"][0]["sources"][0]["url"].startswith(m.API))
        self.assertIsNone(result["stocks"][0]["quote"]["peTtm"])
        self.assertEqual(result["stocks"][0]["quote"]["peTtmCalculated"], 1e8)

    def test_research_is_dated_and_issuer_sources_take_priority(self):
        snapshot = {"asOf": AS_OF, "stocks": [{"group": "server", "name": "浪潮信息", "sources": [{"name": "provider", "url": "https://example.com/data"}]}]}
        research = {"asOf": AS_OF, "groups": [{"id": "server", "sources": [{"name": "浪潮信息半年报", "url": "https://example.com/filing.pdf"}]}]}
        m.attach_research(snapshot, research)
        self.assertEqual(snapshot["research"]["asOf"], AS_OF)
        self.assertEqual(snapshot["stocks"][0]["sources"][0]["evidence"], "issuer_filing")
        future = {"asOf": "2099-01-01", "groups": []}
        m.attach_research(snapshot, future)
        self.assertEqual(snapshot["research"]["asOf"], AS_OF)


if __name__ == "__main__":
    unittest.main()
