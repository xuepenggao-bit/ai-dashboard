import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[1] / ".github/scripts/broker_hk_source.py"
SPEC = importlib.util.spec_from_file_location("broker_hk_source", PATH)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def tr(year, profit, broker, date, eps="9999"):
    return f'<tr class="evenRow"><td>{year}</td><td>{profit}</td><td>{eps}</td><td>0</td><td>{broker}</td><td>买入</td><td>700</td><td>&nbsp;</td><td>{date}</td></tr>'


def page(rows, currency="人民币", title="00700 腾讯控股 TENCENT - 盈利预测"):
    return f'''<html><head><title>{title}</title></head><body>
    <table><tr><td>财政年度</td><td>纯利/(亏损)<br>(百万元{currency})</td><td>最高</td></tr>{tr(2026,"888888","not a broker","30/10/2026")}</table>
    <div>盈利预测概览</div><table><tr><td>财政年度</td><td>纯利/(亏损)<br>(百万元{currency})</td><td>每股盈利*<br>(分)</td><td>每股派息*</td><td>证券商</td><td>评级</td><td colspan="2">目标价</td><td>更新日期</td></tr>{rows}</table>
    </body></html>'''


class SourceTests(unittest.TestCase):
    def parse(self, raw, **kwargs):
        return m.parse_hk_forecasts(raw, "00700", 2026, "2026-11-04", **kwargs)

    def test_original_profit_units_not_eps_or_consensus_and_dates_sort(self):
        rows = self.parse(page(tr(2026, "221,651.00", "美银", "08/10/2026") + tr(2026, "220,297.00", "花旗", "26/10/2026")))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["broker"], "花旗")
        self.assertEqual(rows[0]["currency"], "CNY")
        self.assertAlmostEqual(rows[0]["profitYi"], 2202.97)
        self.assertEqual(rows[0]["forecastYear"], 2026)
        self.assertEqual(rows[0]["sourceType"], "provider_broker_detail")
        self.assertEqual(rows[0]["dateType"], "provider_updated_at")

    def test_future_dates_other_years_and_missing_amounts_are_not_inputs(self):
        rows = self.parse(page(tr(2027,"100","A","01/11/2026")+tr(2026,"100","A","05/11/2026")+tr(2026,"--","A","01/11/2026")+tr(2026,"0","B","01/11/2026")))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["profitYi"], 0)

    def test_explicit_loss_and_currency_are_preserved(self):
        rows = self.parse(page(tr(2026,"(1,200.50)","Broker","01/11/2026"), "美元"))
        self.assertEqual(rows[0]["currency"], "USD")
        self.assertAlmostEqual(rows[0]["profitYi"], -12.005)
        self.assertEqual(self.parse(page(tr(2026,"5","Broker","01/11/2026"), "未知币种")), [])

    def test_page_identity_is_required_not_the_requested_url_alone(self):
        for title in ["01801 信达生物", "Just a moment...", "腾讯控股"]:
            with self.subTest(title=title), self.assertRaises(ValueError):
                self.parse(page(tr(2026,"5","Broker","01/11/2026"), title=title))

    def test_duplicate_rows_do_not_double_count_and_conflicts_are_excluded(self):
        a = tr(2026,"100","Broker","01/11/2026")
        self.assertEqual(len(self.parse(page(a+a))), 1)
        self.assertEqual(self.parse(page(a+tr(2026,"200","Broker","01/11/2026"))), [])

    def test_nested_layout_tables_do_not_leak_aggregate_values(self):
        raw = page(tr(2026,"100","Broker","01/11/2026"))
        wrapped = '<title>00700 腾讯控股</title><table><tr><td>'+raw+'</td></tr></table>'
        self.assertEqual(len(self.parse(wrapped)), 1)

    def test_parser_keeps_all_forecasts_for_the_callers_latest_five_policy(self):
        rows = ''.join(tr(2026,str(i),f"Broker{i}",f"{i:02}/10/2026") for i in range(1,8))
        parsed = self.parse(page(rows))
        self.assertEqual(len(parsed), 7)
        self.assertEqual(parsed[0]["publishedAt"], "2026-10-07")

    def test_url_validates_ticker_without_inventing_a_share_matches(self):
        self.assertTrue(m.hk_url("01801").endswith("code=1801"))
        for code in ["", "HK00700", "0", "123456", "700&foo=1"]:
            with self.assertRaises(ValueError):
                m.hk_url(code)


if __name__ == "__main__":
    unittest.main()
