import datetime as dt
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hl52', Path(__file__).resolve().parents[1] / '.github/scripts/refresh_high_low_52w.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def bar(date, high=10, low=5, volume=1):
    return {'date': date, 'high': high, 'low': low, 'close': (high + low) / 2, 'volume': volume}


class HighLow52Tests(unittest.TestCase):
    def test_codes(self):
        for code in ('600001.SH', '688001.SH', '689009.SH', '000001.SZ', '301001.SZ'):
            self.assertTrue(m.valid_code(code))
        for code in ('920001.BJ', '000001.SH', '399001.SZ', '510300.SH', '600001.SZ', '200001.SZ'):
            self.assertFalse(m.valid_code(code))

    def test_exact_calendar_window(self):
        date = '2026-09-30'
        start = (dt.date.fromisoformat(date) - dt.timedelta(days=364)).isoformat()
        before = (dt.date.fromisoformat(start) - dt.timedelta(days=1)).isoformat()
        rows = [bar(before, 1000, -10), bar(start, 10, 5), bar(date, 10, 5)]
        self.assertEqual(m.classify(rows, date), (True, True, True))
        rows[1] = bar(start, 11, 4)
        self.assertEqual(m.classify(rows, date), (True, False, False))

    def test_new_ipo_and_suspension_not_counted(self):
        self.assertEqual(m.classify([bar('2026-09-01'), bar('2026-09-30', 50, 1)], '2026-09-30'), (False, False, False))
        self.assertEqual(m.classify([bar('2025-01-01'), bar('2026-09-30', 50, 1, 0)], '2026-09-30'), (True, False, False))
        self.assertEqual(m.classify([bar('2025-01-01'), bar('2026-09-29')], '2026-09-30'), (True, False, False))

    def test_complete_point_in_time_universe(self):
        codes = {f'sh{600000+i}': 'name' for i in range(4000)}
        prices = {code: [bar('2025-01-01'), bar('2026-09-28', 20, 1), bar('2026-09-29'), bar('2026-09-30')] for code in codes}
        universes = {'2026-09-29': codes, '2026-09-30': {**codes, 'sz301999': 'IPO'}}
        prices['sz301999'] = [bar('2026-09-30', 500, .5)]
        rows = m.build_series(list(universes), universes, prices)
        self.assertEqual([r['universe'] for r in rows], [4000, 4001])
        self.assertEqual([r['eligible'] for r in rows], [4000, 4000])
        self.assertEqual([r['high'] for r in rows], [0, 0])
        self.assertEqual([r['low'] for r in rows], [0, 0])
        del prices['sz301999']
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            m.build_series(list(universes), universes, prices)

    def test_frontend_queue_equals_exact_window(self):
        latest = dt.date(2026, 9, 30)
        bars = [bar((latest-dt.timedelta(days=500-i)).isoformat(), 10+(i*7)%31, 5+(i*3)%13) for i in range(501)]
        start = (latest-dt.timedelta(days=364)).isoformat()
        through = (latest+dt.timedelta(days=21)).isoformat()
        for key in ('high', 'low'):
            q = m.extrema_queue(bars, key, start, through)
            for offset in range(1, 22):
                cutoff = (latest+dt.timedelta(days=offset-364)).isoformat()
                expected = (max if key == 'high' else min)(b[key] for b in bars if b['date']>=cutoff)
                self.assertEqual(next(p[1] for p in q if p[0]>=cutoff), expected)

    def test_parse_and_backup(self):
        p = {'code': 0, 'data': {'sh600000': {'qfqday': [['2026-09-30', '7', '8', '10', '5', '100']]}}}
        self.assertEqual(m.parse_bars(p, 'sh600000')[0]['high'], 10)
        with patch.object(m, 'get_json', side_effect=[RuntimeError('primary failed'), p]) as get:
            self.assertEqual(m.fetch_bars('sh600000')[0]['low'], 5)
            self.assertIn('proxy.finance.qq.com', get.call_args.args[0])
        p['data']['sh600000']['qfqday'][0][3] = 'nan'
        with self.assertRaises(ValueError):
            m.parse_bars(p, 'sh600000')


if __name__ == '__main__':
    unittest.main()
