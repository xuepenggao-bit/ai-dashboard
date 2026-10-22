import datetime as dt
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ma_breadth', Path(__file__).resolve().parents[1] / '.github/scripts/refresh_high_low_52w.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def bar(date, close=10, volume=1):
    return {'date': date, 'close': close, 'high': close + 1, 'low': close - 1, 'volume': volume}


def bars(count=150, last='2026-10-13', close=10):
    end = dt.date.fromisoformat(last)
    return [bar((end - dt.timedelta(days=count - 1 - i)).isoformat(), close) for i in range(count)]


def valid_ma_snapshots():
    latest = '2026-10-13'
    prices = {'sh600001': bars(180)}
    dates = [row['date'] for row in prices['sh600001']][-60:]
    universes = {date: {'sh600001': 'name'} for date in dates}
    updated = '2026-10-13T15:15:00+08:00'
    history = {'schemaVersion': 1, 'windows': [20, 60, 120], 'updatedAt': updated,
               'source': m.SOURCE, 'methodology': m.MA_METHOD,
               'series': m.build_ma_series(dates, universes, prices)}
    baseline = m.build_ma_baseline(latest, universes[latest], prices, updated)
    return history, baseline


class MovingAverageBreadthTests(unittest.TestCase):
    def test_mean_includes_current_close_and_is_strict(self):
        rows = bars(20)
        self.assertEqual(m.ma_observation(rows, '2026-10-13', 20), (True, False))
        rows[-1]['close'] = 11
        self.assertEqual(m.ma_observation(rows, '2026-10-13', 20), (True, True))
        rows[-1]['close'] = 9
        self.assertEqual(m.ma_observation(rows, '2026-10-13', 20), (True, False))

    def test_short_windows_missing_bar_and_suspension_are_ineligible(self):
        rows = bars(59)
        self.assertEqual(m.ma_observation(rows, '2026-10-13', 60), (False, False))
        self.assertEqual(m.ma_observation(rows, '2026-10-14', 20), (False, False))
        rows[-1]['volume'] = 0
        self.assertEqual(m.ma_observation(rows, '2026-10-13', 20), (False, False))

    def test_positive_finite_current_close_but_negative_history_allowed(self):
        rows = bars(20, close=-2)
        rows[-1]['close'] = 1
        self.assertEqual(m.ma_observation(rows, '2026-10-13', 20), (True, True))
        for value in (0, -1, float('nan'), float('inf')):
            rows[-1]['close'] = value
            self.assertEqual(m.ma_observation(rows, '2026-10-13', 20), (False, False))

    def test_percentages_use_each_window_eligible_denominator(self):
        prices = {'sh600001': bars(), 'sh600002': bars(), 'sh600003': bars(20), 'sh600004': bars()}
        prices['sh600001'][-1]['close'] = 12
        prices['sh600003'][-1]['close'] = 12
        prices['sh600004'][-1]['volume'] = 0
        universe = dict.fromkeys(prices, 'name')
        row = m.build_ma_series(['2026-10-13'], {'2026-10-13': universe}, prices)[0]
        self.assertEqual(row['universe'], 4)
        self.assertEqual(row['windows']['20'], {'above': 2, 'eligible': 3, 'pct': 66.6667})
        self.assertEqual(row['windows']['60'], {'above': 1, 'eligible': 2, 'pct': 50.0})
        self.assertEqual(row['windows']['120'], {'above': 1, 'eligible': 2, 'pct': 50.0})
        self.assertEqual(row['asOf'], '15:00')
        self.assertEqual(row['status'], 'close')

    def test_zero_eligible_is_unknown_not_a_zero_percent(self):
        result = m.build_ma_series(['2026-10-13'], {'2026-10-13': {'sz301999': 'new'}}, {'sz301999': bars(1)})
        self.assertEqual(result[0]['windows']['20'], {'above': 0, 'eligible': 0, 'pct': None})

    def test_point_in_time_membership_and_incomplete_requests(self):
        prices = {'sh600001': bars(), 'sz301999': bars(1)}
        universes = {'2026-10-12': {'sh600001': 'old'}, '2026-10-13': dict.fromkeys(prices, 'name')}
        result = m.build_ma_series(list(universes), universes, prices)
        self.assertEqual([row['universe'] for row in result], [1, 2])
        self.assertEqual([row['windows']['20']['eligible'] for row in result], [1, 1])
        for bad in ({'sh600001': prices['sh600001']}, {'sh600001': prices['sh600001'], 'sz301999': []}):
            with self.assertRaisesRegex(ValueError, 'Incomplete'):
                m.build_ma_series(list(universes), universes, bad)

    def test_latest_n_minus_one_prices_are_the_next_session_baseline(self):
        rows = bars(120)
        for i, row in enumerate(rows):
            row['close'] = i + 1
        payload = m.build_ma_baseline('2026-10-13', {'sh600001': 'name'}, {'sh600001': rows}, 'stamp')
        stock = payload['stocks'][0]
        self.assertEqual(payload['windows'], [20, 60, 120])
        self.assertEqual(stock['close'], 120)
        self.assertEqual(stock['priorSums']['20'], sum(range(102, 121)))
        self.assertEqual(stock['priorSums']['60'], sum(range(62, 121)))
        self.assertEqual(stock['priorSums']['120'], sum(range(2, 121)))
        self.assertEqual(stock['lastDate'], '2026-10-13')

    def test_baseline_ignores_live_and_future_bars(self):
        rows = bars(20) + [bar('2026-10-14', 100), bar('2026-10-15', 999)]
        stock = m.build_ma_baseline('2026-10-13', {'sh600001': 'name'}, {'sh600001': rows}, 'stamp')['stocks'][0]
        self.assertEqual(stock['lastDate'], '2026-10-13')
        self.assertEqual(stock['close'], 10)
        self.assertEqual(stock['priorSums'], {'20': 190.0, '60': None, '120': None})
        self.assertEqual(m.ma_observation(rows, '2026-10-13', 20), (True, False))

    def test_baseline_short_histories_and_invalid_latest_close(self):
        row = m.build_ma_baseline('2026-10-13', {'sz301999': 'new'}, {'sz301999': bars(1)}, 'stamp')['stocks'][0]
        self.assertEqual(row['priorSums'], {'20': None, '60': None, '120': None})
        for invalid in (0, -1, float('nan'), float('inf')):
            with self.assertRaisesRegex(ValueError, 'invalid latest'):
                m.build_ma_baseline('2026-10-13', {'sh600001': 'name'}, {'sh600001': bars(20, close=invalid)}, 'stamp')

    def test_history_keeps_last_sixty_sessions(self):
        rows = bars(190)
        dates = [row['date'] for row in rows][-65:]
        result = m.build_ma_series(dates, {date: {'sh600001': 'name'} for date in dates}, {'sh600001': rows})
        self.assertEqual(len(result), 60)
        self.assertEqual(result[0]['date'], dates[-60])

    def test_closed_day_missing_ma_snapshot_cannot_skip_build(self):
        with tempfile.TemporaryDirectory() as temp:
            paths = {name: Path(temp) / (name + '.json') for name in ('OUTPUT', 'BASELINE', 'MA_OUTPUT', 'MA_BASELINE')}
            with patch.multiple(m, **paths), patch.object(m, 'load_universe', return_value={'sh600001': 'name'}):
                paths['OUTPUT'].write_text(json.dumps({'series': [{'date': '2026-10-13', 'universe': 1}] * 60}))
                paths['BASELINE'].write_text(json.dumps({'asOfDate': '2026-10-13', 'validThrough': '2026-11-03', 'stocks': [{'code': 'sh600001'}]}))
                self.assertFalse(m.complete_cached_snapshots('2026-10-13'))
                ma_row = {'date': '2026-10-13', 'universe': 1, 'windows': dict.fromkeys(('20', '60', '120'), {})}
                paths['MA_OUTPUT'].write_text(json.dumps({'windows': [20, 60, 120], 'series': [ma_row] * 60}))
                paths['MA_BASELINE'].write_text(json.dumps({'windows': [20, 60, 120], 'asOfDate': '2026-10-13', 'stocks': [{}]}))
                self.assertFalse(m.complete_cached_snapshots('2026-10-13'))
                history, baseline = valid_ma_snapshots()
                paths['MA_OUTPUT'].write_text(json.dumps(history))
                paths['MA_BASELINE'].write_text(json.dumps(baseline))
                now = dt.datetime(2026, 10, 14, 12, tzinfo=m.TZ)
                self.assertTrue(m.complete_cached_snapshots('2026-10-13', now))
                history['series'][10]['windows']['20']['pct'] = 99
                paths['MA_OUTPUT'].write_text(json.dumps(history))
                self.assertFalse(m.complete_cached_snapshots('2026-10-13', now))

    def test_history_validation_rejects_corrupt_counts_dates_and_timestamps(self):
        history, _ = valid_ma_snapshots()
        now = dt.datetime(2026, 10, 14, 12, tzinfo=m.TZ)
        self.assertIs(m.validate_ma_history(history, '2026-10-13', now), history)
        alterations = [
            lambda p: p.update(schemaVersion=True),
            lambda p: p.update(updatedAt='2026-10-15T15:00:00+08:00'),
            lambda p: p.update(updatedAt='2026-10-13T15:00:00'),
            lambda p: p['series'][0].update(date=p['series'][1]['date']),
            lambda p: p['series'].reverse(),
            lambda p: p['series'][-1].update(date='2026-10-12'),
            lambda p: p['series'][0].update(asOf='16:00'),
            lambda p: p['series'][0].update(status='live'),
            lambda p: p['series'][0].update(universe=-1),
            lambda p: p['series'][0]['windows']['20'].update(above=-1),
            lambda p: p['series'][0]['windows']['20'].update(above=True),
            lambda p: p['series'][0]['windows']['20'].update(above=2),
            lambda p: p['series'][0]['windows']['20'].update(eligible=2),
            lambda p: p['series'][0]['windows']['20'].update(eligible=0, pct=0),
            lambda p: p['series'][0]['windows']['20'].update(pct=float('nan')),
            lambda p: p['series'][0]['windows']['20'].update(pct=1),
        ]
        for alter in alterations:
            payload = deepcopy(history)
            alter(payload)
            with self.subTest(alteration=alter), self.assertRaises(ValueError):
                m.validate_ma_history(payload, '2026-10-13', now)
        with self.assertRaisesRegex(ValueError, 'Future'):
            m.validate_ma_history(history, '2026-10-15', now)

    def test_history_percentage_validation_accepts_rounding_only(self):
        history, _ = valid_ma_snapshots()
        now = dt.datetime(2026, 10, 14, 12, tzinfo=m.TZ)
        history['series'][0]['universe'] = 3
        history['series'][0]['windows']['20'].update(above=1, eligible=3, pct=33.3333)
        m.validate_ma_history(history, '2026-10-13', now)
        history['series'][0]['windows']['20']['pct'] = 33.3334
        m.validate_ma_history(history, '2026-10-13', now)
        history['series'][0]['windows']['20']['pct'] = 33.3335
        with self.assertRaises(ValueError):
            m.validate_ma_history(history, '2026-10-13', now)

    def test_baseline_validation_rejects_invalid_vintage_codes_and_sums(self):
        _, baseline = valid_ma_snapshots()
        now = dt.datetime(2026, 10, 14, 12, tzinfo=m.TZ)
        self.assertIs(m.validate_ma_baseline(baseline, '2026-10-13', 1, now), baseline)
        alterations = [
            lambda p: p.update(schemaVersion=2),
            lambda p: p.update(updatedAt='2026-10-15T15:00:00+08:00'),
            lambda p: p.update(asOfDate='2026-10-14'),
            lambda p: p['stocks'].append(deepcopy(p['stocks'][0])),
            lambda p: p['stocks'][0].update(code='sh510300'),
            lambda p: p['stocks'][0].update(lastDate='2026-10-14'),
            lambda p: p['stocks'][0].update(lastDate='20261013'),
            lambda p: p['stocks'][0].update(close=0),
            lambda p: p['stocks'][0].update(close=True),
            lambda p: p['stocks'][0].update(close=float('inf')),
            lambda p: p['stocks'][0]['priorSums'].update({'20': float('nan')}),
            lambda p: p['stocks'][0]['priorSums'].pop('120'),
            lambda p: p['stocks'][0]['priorSums'].update({'20': '190'}),
        ]
        for alter in alterations:
            payload = deepcopy(baseline)
            alter(payload)
            with self.subTest(alteration=alter), self.assertRaises(ValueError):
                m.validate_ma_baseline(payload, '2026-10-13', 1, now)
        duplicate = deepcopy(baseline)
        duplicate['stocks'].append(deepcopy(duplicate['stocks'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            m.validate_ma_baseline(duplicate, '2026-10-13', 2, now)
        baseline['stocks'][0]['priorSums']['20'] = -19
        baseline['stocks'][0]['priorSums']['120'] = None
        m.validate_ma_baseline(baseline, '2026-10-13', 1, now)

    def test_refresh_filters_uncompleted_bars_for_both_baselines(self):
        class FixedDateTime(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 14, 12, 0, tzinfo=m.TZ)

        history = bars(500)
        prices = {'sh600001': history + [bar('2026-10-14', 100), bar('2026-10-15', 999)]}
        index = bars(60) + [bar('2026-10-14'), bar('2026-10-15')]
        dates = [row['date'] for row in index[:60]]
        universes = {date: {'sh600001': 'name'} for date in dates}
        old_series = [{'date': date, 'high': 0, 'low': 0, 'eligible': 1, 'universe': 1} for date in dates]
        with tempfile.TemporaryDirectory() as temp:
            paths = {name: Path(temp) / (name + '.json') for name in ('OUTPUT', 'BASELINE', 'MA_OUTPUT', 'MA_BASELINE')}
            with patch.multiple(m, **paths), patch.object(m.dt, 'datetime', FixedDateTime), \
                    patch.object(m, 'fetch_bars', return_value=index), \
                    patch.object(m, 'parallel_map', side_effect=[universes, prices]), \
                    patch.object(m, 'build_series', return_value=old_series) as high_low:
                m.refresh_history(Path(temp) / 'cache')
            supplied = high_low.call_args.args[2]['sh600001']
            self.assertEqual(supplied[-1]['date'], '2026-10-13')
            for name in ('BASELINE', 'MA_BASELINE'):
                payload = json.loads(paths[name].read_text())
                self.assertEqual(payload['asOfDate'], '2026-10-13')
                self.assertEqual(payload['stocks'][0]['lastDate'], '2026-10-13')
                self.assertEqual(payload['stocks'][0]['close'], 10)
            ma = json.loads(paths['MA_OUTPUT'].read_text())
            self.assertEqual(ma['series'][-1]['date'], '2026-10-13')
            self.assertEqual(len(ma['series']), 60)


if __name__ == '__main__':
    unittest.main()

