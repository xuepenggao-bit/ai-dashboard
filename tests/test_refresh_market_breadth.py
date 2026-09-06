import datetime as dt
import importlib.util
import pathlib
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).parents[1] / '.github' / 'scripts' / 'refresh_market_breadth.py'
SPEC = importlib.util.spec_from_file_location('refresh_market_breadth', SCRIPT)
BREADTH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BREADTH)


class RecentBreadthDaysTests(unittest.TestCase):
    def setUp(self):
        self.rows = {'2026-08-21': {'date': '2026-08-21', 'up': 2407, 'down': 2626}}

    def test_includes_today_immediately_after_close(self):
        now = dt.datetime(2026, 8, 24, 15, 1, tzinfo=BREADTH.BEIJING_TZ)
        self.assertEqual(BREADTH._recent_missing_days(self.rows, now), [dt.date(2026, 8, 24)])

    def test_excludes_today_before_close(self):
        now = dt.datetime(2026, 8, 24, 14, 59, tzinfo=BREADTH.BEIJING_TZ)
        self.assertEqual(BREADTH._recent_missing_days(self.rows, now), [])

    def test_skips_weekends(self):
        now = dt.datetime(2026, 8, 23, 16, 0, tzinfo=BREADTH.BEIJING_TZ)
        self.assertEqual(BREADTH._recent_missing_days(self.rows, now), [])


class LimitMoveTests(unittest.TestCase):
    def test_main_board_limit(self):
        self.assertTrue(BREADTH._is_limit_close('600000', '浦发银行', 11.00, 10.0, 1))
        self.assertTrue(BREADTH._is_limit_close('000001', '平安银行', 9.00, -10.0, -1))
        self.assertFalse(BREADTH._is_limit_close('600000', '浦发银行', 10.92, 9.2, 1))

    def test_registration_boards_use_twenty_percent(self):
        self.assertTrue(BREADTH._is_limit_close('300750', '宁德时代', 12.00, 20.0, 1))
        self.assertTrue(BREADTH._is_limit_close('689009', '九号公司', 8.00, -20.0, -1))
        self.assertFalse(BREADTH._is_limit_close('300750', '宁德时代', 11.00, 10.0, 1))

    def test_risk_warning_limit_rate_depends_on_board(self):
        self.assertTrue(BREADTH._is_limit_close('600001', '*ST示例', 10.50, 5.0, 1))
        self.assertTrue(BREADTH._is_limit_close('300001', '*ST创业', 12.00, 20.0, 1))

    def test_unrestricted_new_listings_are_excluded(self):
        self.assertFalse(BREADTH._is_limit_close('301001', 'N示例', 12.00, 20.0, 1))
        self.assertFalse(BREADTH._is_limit_close('301002', 'C示例', 8.00, -20.0, -1))

    def test_low_price_tick_rounding(self):
        change=(2.45/2.23-1)*100
        self.assertTrue(BREADTH._is_limit_close('600002', '低价示例', 2.45, change, 1))

    def test_beijing_market_is_excluded(self):
        self.assertFalse(BREADTH._is_limit_close('920001', '北交示例', 13.00, 30.0, 1))

    def test_official_merge_preserves_existing_limit_counts(self):
        rows = {
            '2026-08-21': {
                'date': '2026-08-21', 'up': 1, 'down': 2,
                    'limitUp': 88, 'limitDown': 6, 'limitSource': 'eastmoney_daily_limit_rule_total',
            }
        }
        BREADTH._merge_official_rows(
            rows,
            {'2026-08-21': {'date': '2026-08-21', 'up': 2407, 'down': 2626}},
        )
        self.assertEqual(rows['2026-08-21']['up'], 2407)
        self.assertEqual(rows['2026-08-21']['limitUp'], 88)
        self.assertEqual(rows['2026-08-21']['limitDown'], 6)

    def test_intraday_limit_point_requires_matching_source_date(self):
        payload = {
            'data': {
                'trends': [
                    '2026-09-03 15:00,46,16,51,19',
                ]
            }
        }
        with mock.patch.object(BREADTH, '_get_json', return_value=payload):
            result = BREADTH._official_intraday_limit_counts(dt.date(2026, 9, 3))
            stale = BREADTH._official_intraday_limit_counts(dt.date(2026, 9, 2))
        self.assertEqual(result['limitUp'], 46)
        self.assertEqual(result['limitDown'], 16)
        self.assertEqual(result['limitSource'], 'eastmoney_hs_minute_close')
        self.assertEqual(result['limitAsOf'], '2026-09-03 15:00')
        self.assertIsNone(stale)

    def test_preclose_intraday_point_is_not_persisted(self):
        payload = {'data': {'trends': ['2026-09-03 14:59,45,15,50,18']}}
        with mock.patch.object(BREADTH, '_get_json', return_value=payload):
            self.assertIsNone(BREADTH._official_intraday_limit_counts(dt.date(2026, 9, 3)))

    def test_today_reconstruction_is_upgraded_to_closing_point(self):
        row = {
            'date': '2026-09-03', 'up': 1805, 'down': 3275,
            'limitUp': 40, 'limitDown': 12, 'limitSource': 'eastmoney_daily_limit_rule_total',
        }
        official = {
            'limitUp': 46, 'limitDown': 16, 'limitSource': 'eastmoney_hs_minute_close',
            'limitAsOf': '2026-09-03 15:00',
        }
        with mock.patch.object(BREADTH, '_official_intraday_limit_counts', return_value=official), \
             mock.patch.object(BREADTH, '_computed_day') as computed:
            result = BREADTH._enrich_limit_row(row, dt.date(2026, 9, 3))
        self.assertEqual(result['limitUp'], 46)
        self.assertEqual(result['limitDown'], 16)
        self.assertEqual(result['limitSource'], 'eastmoney_hs_minute_close')
        computed.assert_not_called()

    def test_valid_total_scope_row_is_not_queried_again(self):
        row = {
            'date': '2026-09-02', 'up': 2200, 'down': 2800,
            'limitUp': 49, 'limitDown': 8, 'limitSource': 'eastmoney_daily_limit_rule_total',
        }
        with mock.patch.object(BREADTH, '_computed_day') as computed:
            result = BREADTH._enrich_limit_row(row, dt.date(2026, 9, 3))
        self.assertIs(result, row)
        computed.assert_not_called()

    def test_invalid_persisted_limit_counts_are_cleared(self):
        row=BREADTH._normalize_existing_row({
            'date':'2026-09-02','up':2200,'down':2800,'flat':100,
            'limitUp':-1,'limitDown':3000,'limitSource':'eastmoney_daily_limit_rule_total',
        })
        self.assertIsNotNone(row)
        self.assertNotIn('limitUp',row)
        self.assertNotIn('limitDown',row)
        self.assertNotIn('limitSource',row)

    def test_invalid_persisted_breadth_row_is_rejected(self):
        self.assertIsNone(BREADTH._normalize_existing_row({
            'date':'not-a-date','up':2200,'down':2800,
        }))
        self.assertIsNone(BREADTH._normalize_existing_row({
            'date':'2026-09-02','up':'NaN','down':2800,
        }))

    def test_truncated_daily_table_is_rejected(self):
        payload = {
            'result': {
                'data': [
                    {
                        'SECUCODE': f'{i:06d}.SZ',
                        'SECURITY_NAME_ABBR': '测试',
                        'CLOSE_PRICE': 10,
                        'CHANGE_RATE': 1,
                    }
                    for i in range(1500)
                ]
            }
        }
        with mock.patch.object(BREADTH, '_get_json', return_value=payload):
            self.assertIsNone(BREADTH._computed_day(dt.date(2026, 9, 2)))

    def test_official_month_rejects_partial_market_snapshot(self):
        payload = [
            {'time': '2026-09-02 00:00:00', 'up': 800, 'down': 900},
            {'time': '2026-09-03 00:00:00', 'up': 1804, 'down': 3275},
        ]
        with mock.patch.object(BREADTH, '_get_json', return_value=payload):
            rows = BREADTH._official_month()
        self.assertNotIn('2026-09-02', rows)
        self.assertIn('2026-09-03', rows)


if __name__ == '__main__':
    unittest.main()
