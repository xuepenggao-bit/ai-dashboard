import datetime as dt
import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).parents[1] / '.github' / 'scripts' / 'refresh_major_indices.py'
SPEC = importlib.util.spec_from_file_location('refresh_major_indices', SCRIPT)
IND = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IND)
NOW = IND.quote_timestamp('2026-09-23 16:00:00')


class MajorIndicesTests(unittest.TestCase):
    def quote(self, label='台湾加权', **changes):
        row = IND.make_quote(IND.BY_LABEL[label], 20000, 1, None, NOW - 60000, 'em', NOW)
        row.update(changes)
        return row

    def test_timestamp_is_explicit_beijing(self):
        stamp = IND.quote_timestamp('20260923153000')
        self.assertEqual(stamp, IND.quote_timestamp('2026-09-23 15:30'))
        self.assertEqual(dt.datetime.fromtimestamp(stamp / 1000, dt.timezone.utc).hour, 7)

    def test_all_15_labels_and_no_duplicate_ids(self):
        self.assertEqual(len(IND.INDICES), 15)
        self.assertEqual(len(IND.BY_LABEL), 15)

    def test_tencent_realtime_hk_exact_symbol_and_time(self):
        fields = [''] * 34
        fields[2], fields[3], fields[4] = 'HSI', '24900', '25000'
        fields[30], fields[31], fields[32] = '20260923155900', '-100', '-0.4'
        rows = IND.parse_tencent('v_r_hkHSI="' + '~'.join(fields) + '";', NOW)
        self.assertEqual(rows[0]['src'], 'tc_rt')
        self.assertEqual(rows[0]['price'], 24900)
        fields[2] = 'WRONG'
        self.assertEqual(IND.parse_tencent('v_r_hkHSI="' + '~'.join(fields) + '";', NOW), [])

    def test_minute_uses_last_nonempty_price(self):
        raw = {'data': {'code': 'TWII', 'preClose': 20000, 'trends': [
            '2026-09-23 13:29,0,20200', '2026-09-23 13:30,0,0']}}
        rows = IND.parse_em_minutes(IND.BY_LABEL['台湾加权'], raw, NOW)
        self.assertAlmostEqual(rows[0]['pct'], 1)
        self.assertEqual(rows[0]['price'], 20200)
        self.assertEqual(rows[0]['quoteTs'], IND.quote_timestamp('2026-09-23 13:29'))

    def test_futures_use_previous_settlement(self):
        raw = {'data': {'code': 'NQ00Y', 'preClose': 100, 'preSettlement': 200,
                        'trends': ['2026-09-23 15:59,0,202']}}
        rows = IND.parse_em_minutes(IND.BY_LABEL['纳指期指'], raw, NOW)
        self.assertAlmostEqual(rows[0]['pct'], 1)

    def test_missing_close_wrong_symbol_and_missing_timestamp_rejected(self):
        config = IND.BY_LABEL['台湾加权']
        self.assertEqual(IND.parse_em_minutes(config, {'data': {'code': 'KOSPI200', 'preClose': 1}}, NOW), [])
        self.assertEqual(IND.parse_em_minutes(config, {'data': {'code': 'TWII', 'trends': ['2026-09-23 13:30,0,20']}}, NOW), [])
        self.assertIsNone(IND.make_quote(config, 20000, 0, 0, None, 'em', NOW))

    def test_zero_percentage_is_valid_but_zero_price_is_not(self):
        config = IND.BY_LABEL['台湾加权']
        self.assertIsNotNone(IND.make_quote(config, 20000, 0, 0, NOW, 'em', NOW))
        self.assertIsNone(IND.make_quote(config, 0, 0, 0, NOW, 'em', NOW))
        self.assertIsNone(IND.make_quote(config, 20000, '-', None, NOW, 'em', NOW))

    def test_failures_retain_previous_and_never_move_backwards(self):
        previous = self.quote()
        rows = IND.merge_quotes({'台湾加权': previous}, [], NOW)
        self.assertEqual(rows['台湾加权'], previous)
        older = self.quote(price=19999, quoteTs=NOW - 120000)
        self.assertEqual(IND.merge_quotes(rows, [older], NOW)['台湾加权']['price'], 20000)

    def test_direct_wins_at_same_time_and_future_is_rejected(self):
        minute = self.quote(src='em_minute')
        direct = self.quote(price=20100)
        rows = IND.merge_quotes({'台湾加权': minute}, [direct], NOW)
        self.assertEqual(rows['台湾加权']['src'], 'em')
        future = self.quote(price=20200, quoteTs=NOW + 360000)
        self.assertEqual(IND.merge_quotes(rows, [future], NOW), rows)

    def test_hk_inconsistent_close_and_abrupt_jump_rejected(self):
        prev = self.quote('恒生指数', price=25000, pct=0)
        wrong = self.quote('恒生指数', price=27500, pct=10, quoteTs=NOW)
        rows = IND.merge_quotes({'恒生指数': prev}, [wrong], NOW)
        self.assertEqual(rows['恒生指数']['price'], 25000)
        wrong = self.quote('恒生指数', price=25100, pct=4, quoteTs=NOW)
        self.assertEqual(IND.merge_quotes(rows, [wrong], NOW), rows)

    def test_old_stored_data_is_kept_but_not_newly_ingested(self):
        old = self.quote(quoteTs=NOW - 30 * 86400000)
        self.assertEqual(IND.merge_quotes({'台湾加权': old}, [], NOW)['台湾加权'], old)
        self.assertEqual(IND.merge_quotes({}, [old], NOW), {})


if __name__ == '__main__':
    unittest.main()
