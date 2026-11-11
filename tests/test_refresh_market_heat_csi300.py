import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / '.github/scripts'
sys.path.insert(0, str(SCRIPTS))
import refresh_market_heat_csi300 as C


NOW = dt.datetime(2026, 11, 11, 16, tzinfo=C.risk.TZ)


def bars():
    dates = [NOW.date() - dt.timedelta(days=i) for i in range(190, -1, -1)]
    return [{'date': d.isoformat(), 'close': 4000 + i / 100}
            for i, d in enumerate(dates) if d.weekday() < 5]


def dates(rows):
    return [row['date'] for row in rows]


class BenchmarkTests(unittest.TestCase):
    def test_completed_unadjusted_points_fit_fixed_history_bound(self):
        rows = bars()
        result = C.make_snapshot(rows, NOW, 'test', 'https://example.com', dates(rows[-60:]))
        self.assertEqual(result['symbol'], '000300')
        self.assertEqual(result['series'], rows[-C.LIMIT:])
        self.assertIsNone(C.validate(result, NOW))

    def test_same_day_waits_until_after_close_buffer(self):
        rows = bars()
        early = NOW.replace(hour=15, minute=9)
        required = dates(rows[-61:-1])
        p = C.make_snapshot(rows, early, 'test', 'https://example.com', required)
        self.assertEqual(p['series'][-1]['date'], rows[-2]['date'])
        with self.assertRaisesRegex(ValueError, 'not cover'):
            C.make_snapshot(rows, early, 'test', '', dates(rows[-60:]))

    def test_rejects_wrong_symbol_duplicate_nonpositive_and_future_data(self):
        rows = bars()
        p = C.make_snapshot(rows, NOW, 'test', '', dates(rows[-60:]))
        for invalid in [
            {**p, 'symbol': '000001'},
            {**p, 'series': p['series'][:-1] + [p['series'][-2]]},
            {**p, 'series': p['series'][:-1] + [dict(p['series'][-1], close=0)]},
            {**p, 'series': p['series'][:-1] + [dict(p['series'][-1], close=True)]},
            {**p, 'series': p['series'][:-1] + [dict(p['series'][-1], date='2026-11-12')]},
            {**p, 'updatedAt': NOW.replace(hour=14).isoformat()},
        ]:
            with self.subTest(invalid=invalid['series'][-1]):
                with self.assertRaises(ValueError):
                    C.validate(invalid, NOW)

    def test_refresh_keeps_existing_file_on_gaps_outage_and_unchanged_series(self):
        rows = bars()
        with tempfile.TemporaryDirectory() as tmp:
            heat = Path(tmp) / 'market_heat.json'
            output = Path(tmp) / 'market_heat_csi300.json'
            heat.write_text(json.dumps({'series': rows[-60:]}), encoding='utf-8')
            with patch.object(C.risk, 'fetch_bars', return_value=(rows, 'test', '')) as fetch:
                initial = C.refresh(output, heat, NOW)
                fetch.assert_called_once_with(NOW, code='sh000300')
                saved = output.read_bytes()
                self.assertEqual(C.refresh(output, heat, NOW + dt.timedelta(minutes=10)), initial)
                self.assertEqual(output.read_bytes(), saved)
            with patch.object(C.risk, 'fetch_bars', return_value=(rows[:-3] + rows[-2:], 'test', '')):
                with self.assertRaisesRegex(ValueError, 'not cover'):
                    C.refresh(output, heat, NOW)
                self.assertEqual(output.read_bytes(), saved)
            with patch.object(C.risk, 'fetch_bars', side_effect=RuntimeError('provider outage')):
                with self.assertRaisesRegex(RuntimeError, 'provider outage'):
                    C.refresh(output, heat, NOW)
                self.assertEqual(output.read_bytes(), saved)

    def test_old_window_cannot_disappear_when_recent_heat_dates_still_overlap(self):
        rows = bars()
        required = dates(rows[-60:])
        original = C.make_snapshot(rows, NOW, 'test', '', required)
        with self.assertRaisesRegex(ValueError, 'previously published history'):
            C.make_snapshot(rows[:-80] + rows[-79:], NOW, 'test', '', required, original)


if __name__ == '__main__':
    unittest.main()
