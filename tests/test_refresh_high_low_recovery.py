import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse


spec = importlib.util.spec_from_file_location('hl52_recovery', Path(__file__).resolve().parents[1] / '.github/scripts/refresh_high_low_52w.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def em_payload(code='600000', market=1, rows=None):
    return {'rc': 0, 'data': {'code': code, 'market': market, 'klines': rows or [
        '2025-01-02,7,8,10,5,100', '2026-10-20,9,10,11,8,120',
    ]}}


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        m._DAILY_SOURCE_HEALTH.clear()
        m._REFRESH_DEADLINE = None

    def test_whole_symbol_eastmoney_fallback_after_tencent_failures(self):
        with patch.object(m, 'get_json', side_effect=[RuntimeError('Tencent unavailable'), RuntimeError('HTTP 501'), em_payload()]) as get:
            rows = m.fetch_bars('sh600000')
        self.assertEqual([(row['date'], row['close']) for row in rows], [('2025-01-02', 8), ('2026-10-20', 10)])
        params = parse_qs(urlparse(get.call_args.args[0]).query)
        self.assertEqual(params['fqt'], ['1'])
        self.assertEqual(params['secid'], ['1.600000'])
        self.assertNotEqual(params['beg'], ['0'])

    def test_bad_primary_history_is_not_partially_spliced(self):
        broken = {'code': 0, 'data': {'sh600000': {'qfqday': [
            ['2025-01-01', '99', '99', '100', '98', '10'],
            ['2026-10-20', '10', '10', 'nan', '9', '10'],
        ]}}}
        with patch.object(m, 'get_json', side_effect=[broken, RuntimeError('HTTP 501'), em_payload()]):
            rows = m.fetch_bars('sh600000')
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['date'], '2025-01-02')
        self.assertEqual(rows[0]['high'], 10)

    def test_fallback_rejects_symbol_market_duplicate_and_invalid_price(self):
        malformed = [em_payload('600001'), em_payload(market=0),
                     em_payload(rows=['2026-10-20,9,10,11,8,120'] * 2),
                     em_payload(rows=['2026-10-20,9,10,nan,8,120']),
                     em_payload(rows=['2026-10-20,9,10,11,8']), {'rc': 0, 'data': None}]
        for payload in malformed:
            with self.subTest(payload=payload), patch.object(m, 'get_json', return_value=payload):
                with self.assertRaises(ValueError):
                    m.fetch_eastmoney_bars('sh600000')

    def test_fallback_keeps_latest_500_valid_bars(self):
        start = dt.date(2024, 1, 1)
        data = [f'{start + dt.timedelta(days=i)},7,8,10,5,100' for i in range(510)]
        with patch.object(m, 'get_json', return_value=em_payload(rows=data)):
            result = m.fetch_eastmoney_bars('sh600000')
        self.assertEqual(len(result), 500)
        self.assertEqual(result[0]['date'], str(start + dt.timedelta(days=10)))

    def test_all_endpoint_errors_remain_diagnostic(self):
        with patch.object(m, 'get_json', side_effect=[RuntimeError('primary error'), RuntimeError('HTTP 501'), RuntimeError('backup error')]):
            with self.assertRaisesRegex(RuntimeError, 'primary error.*HTTP 501.*backup error'):
                m.fetch_bars('sh600000')

    def test_retry_only_failed_items_without_refetching_successes(self):
        calls = {'good': 0, 'retry': 0}
        def fetch(item):
            calls[item] += 1
            if item == 'retry' and calls[item] == 1:
                raise RuntimeError('temporary outage')
            return item + '-complete'
        with patch.object(m.time, 'sleep') as sleep:
            self.assertEqual(m.parallel_map(calls, fetch, workers=1), {'good': 'good-complete', 'retry': 'retry-complete'})
        self.assertEqual(calls, {'good': 1, 'retry': 2})
        sleep.assert_called_once_with(5)

    def test_retry_is_bounded_and_never_returns_partial_result(self):
        attempts = []
        def unavailable(item):
            attempts.append(item)
            if item == 'bad':
                raise RuntimeError('unavailable')
            return item
        with patch.object(m.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'incomplete: 1 failures'):
                m.parallel_map(['good', 'bad'], unavailable, workers=1, attempts=99)
        self.assertEqual(attempts.count('good'), 1)
        self.assertEqual(attempts.count('bad'), 3)
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [5, 15])

    def test_same_day_complete_close_skips_expensive_full_market_rebuild(self):
        class FixedDateTime(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 20, 16, 15, tzinfo=m.TZ)
        last = dt.date(2026, 10, 20)
        index = [{'date': str(last - dt.timedelta(days=59-i)), 'volume': 1} for i in range(60)]
        with tempfile.TemporaryDirectory() as temp, patch.object(m.dt, 'datetime', FixedDateTime), \
                patch.object(m, 'fetch_bars', return_value=index), \
                patch.object(m, 'complete_cached_snapshots', return_value=True), \
                patch.object(m, 'parallel_map') as collect:
            m.refresh_history(Path(temp))
        collect.assert_not_called()

    def test_failed_symbol_collection_does_not_write_any_output(self):
        index = [{'date': str(dt.date(2026, 9, 30) - dt.timedelta(days=59-i)), 'volume': 1} for i in range(60)]
        with tempfile.TemporaryDirectory() as temp:
            paths = {name: Path(temp) / (name + '.json') for name in ('OUTPUT', 'BASELINE', 'MA_OUTPUT', 'MA_BASELINE')}
            for path in paths.values():
                path.write_text('original snapshot')
            with patch.multiple(m, **paths), patch.object(m, 'fetch_bars', return_value=index), \
                    patch.object(m, 'parallel_map', side_effect=[{row['date']: {'sh600000': 'name'} for row in index}, RuntimeError('incomplete')]):
                with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                    m.refresh_history(Path(temp) / 'cache')
            self.assertTrue(all(path.read_text() == 'original snapshot' for path in paths.values()))

    def test_workflow_resumes_failed_collections_and_repairs_before_open(self):
        source = (Path(__file__).resolve().parents[1] / '.github/workflows/refresh-high-low-52w.yml').read_text()
        self.assertIn("cron: '15 23 * * 0-4'", source)
        self.assertIn("cron: '15 0 * * 1-5'", source)
        self.assertIn("cron: '15 7,8,12 * * 1-5'", source)
        self.assertIn('uses: actions/cache/restore@v4', source)
        self.assertIn('uses: actions/cache/save@v4', source)
        self.assertIn("if: always() && steps.history-cache.outcome == 'success'", source)
        self.assertIn('path: ${{ runner.temp }}/high-low-52w-cache\n', source)
        self.assertIn('--max-seconds 1500', source)

    def test_failed_run_keeps_successful_symbols_for_next_run(self):
        calls = {'good': 0, 'bad': 0}
        rows = [{'date': '2026-10-23', 'close': 8, 'high': 10, 'low': 5, 'volume': 1}]
        def load(code):
            calls[code] += 1
            if code == 'bad' and calls[code] == 1:
                raise RuntimeError('source interrupted')
            return rows
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            collect = lambda code: m.cached_bars(root, '2026-10-23', code, lambda: load(code))
            with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                m.parallel_map(calls, collect, workers=1, attempts=1)
            self.assertTrue((root / '2026-10-23/good.json').exists())
            self.assertFalse((root / '2026-10-23/bad.json').exists())
            resumed = m.parallel_map(calls, collect, workers=1, attempts=1)
            self.assertEqual(resumed, {'good': rows, 'bad': rows})
            self.assertEqual(calls, {'good': 1, 'bad': 2})

    def test_symbol_cache_never_crosses_completed_session_or_merges_vintages(self):
        old = [{'date': '2026-10-22', 'close': 8, 'high': 10, 'low': 5, 'volume': 1}]
        adjusted = [{'date': '2026-10-22', 'close': 4, 'high': 5, 'low': 2.5, 'volume': 1},
                    {'date': '2026-10-23', 'close': 4.5, 'high': 6, 'low': 4, 'volume': 1},
                    {'date': '2026-10-26', 'close': 5, 'high': 7, 'low': 4, 'volume': 1}]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            m.cached_bars(root, '2026-10-22', 'sh600000', lambda: old)
            result = m.cached_bars(root, '2026-10-23', 'sh600000', lambda: adjusted)
            self.assertEqual(result, adjusted[:2])
            self.assertEqual(result[0]['high'], 5, 'Keep the whole new adjusted history, not old bars')
            stored = json.loads((root / '2026-10-23/sh600000.json').read_text())
            self.assertEqual(stored['asOfDate'], '2026-10-23')
            self.assertEqual(stored['code'], 'sh600000')
            self.assertEqual(stored['bars'], adjusted[:2])

    def test_corrupt_or_wrong_symbol_cache_is_replaced_atomically(self):
        rows = [{'date': '2026-10-23', 'close': 8, 'high': 10, 'low': 5, 'volume': 1}]
        bad_caches = ['{interrupted', json.dumps(rows),
                      json.dumps({'schemaVersion': 1, 'asOfDate': '2026-10-22', 'code': 'sh600000', 'bars': rows}),
                      json.dumps({'schemaVersion': 1, 'asOfDate': '2026-10-23', 'code': 'sh600001', 'bars': rows}),
                      json.dumps({'schemaVersion': 1, 'asOfDate': '2026-10-23', 'code': 'sh600000',
                                  'bars': [{**rows[0], 'date': '2026-10-26'}]})]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / '2026-10-23/sh600000.json'
            target.parent.mkdir(parents=True)
            for raw in bad_caches:
                with self.subTest(raw=raw):
                    target.write_text(raw)
                    with patch.object(m, 'fetch_bars', return_value=rows) as fetch:
                        self.assertEqual(m.cached_bars(root, '2026-10-23', 'sh600000', lambda: m.fetch_bars('sh600000')), rows)
                    fetch.assert_called_once()
                    self.assertFalse(target.with_suffix('.tmp').exists())

    def test_repeated_source_failures_pause_endpoint_then_allow_probe(self):
        host = 'https://source.example/daily'
        with patch.object(m.time, 'monotonic', return_value=100):
            for _ in range(8):
                m.daily_source_result(host, False)
            self.assertFalse(m.daily_source_ready(host))
        with patch.object(m.time, 'monotonic', return_value=131):
            self.assertTrue(m.daily_source_ready(host))
            m.daily_source_result(host, True)
            self.assertNotIn(host, m._DAILY_SOURCE_HEALTH)

    def test_time_budget_stops_new_network_work_so_cache_can_be_saved(self):
        m._REFRESH_DEADLINE = 100
        with patch.object(m.time, 'monotonic', return_value=101), patch.object(m, 'urlopen') as network:
            with self.assertRaisesRegex(RuntimeError, 'caches retained'):
                m.get_json('https://source.example/daily')
        network.assert_not_called()
        m._REFRESH_DEADLINE = None

    def test_cache_cleanup_keeps_three_sessions_and_protects_other_entries(self):
        now = dt.datetime(2026, 10, 26, 12, tzinfo=m.TZ)
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as external:
            root = Path(temp)
            for date in ('2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26'):
                (root / date).mkdir()
                (root / date / 'sh600000.json').write_text('managed history')
            (root / 'universe-2026-10-20.json').write_text('roster')
            (root / '2026-10-99').mkdir()
            (root / '2026-10-27').mkdir()
            (root / 'notes').mkdir()
            (Path(external) / 'keep.txt').write_text('external data')
            (root / '2026-10-01').symlink_to(external, target_is_directory=True)
            m.prune_dated_history_caches(root, now=now)
            self.assertEqual(sorted(p.name for p in root.iterdir() if p.is_dir() and
                                    not p.is_symlink() and p.name <= '2026-10-26'),
                             ['2026-10-22', '2026-10-23', '2026-10-26'])
            for name in ('universe-2026-10-20.json', '2026-10-99', '2026-10-27', 'notes', '2026-10-01'):
                self.assertTrue((root / name).exists(), name)
            self.assertEqual((Path(external) / 'keep.txt').read_text(), 'external data')

    def test_main_cleans_cache_after_failed_collection_without_hiding_error(self):
        with tempfile.TemporaryDirectory() as temp, patch('sys.argv', ['refresh', '--cache-dir', temp]), \
                patch.object(m, 'refresh_history', side_effect=RuntimeError('source interrupted')), \
                patch.object(m, 'prune_dated_history_caches') as cleanup:
            with self.assertRaisesRegex(RuntimeError, 'source interrupted'):
                m.main()
        cleanup.assert_called_once_with(Path(temp))

    def test_unpublished_today_universe_falls_back_to_actual_previous_close(self):
        class FixedDateTime(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 21, 16, 15, tzinfo=m.TZ)
        last = dt.date(2026, 10, 21)
        index = [{'date': str(last - dt.timedelta(days=60-i)), 'volume': 1} for i in range(61)]
        with tempfile.TemporaryDirectory() as temp, patch.object(m.dt, 'datetime', FixedDateTime), \
                patch.object(m, 'fetch_bars', return_value=index), \
                patch.object(m, 'fetch_universe', side_effect=RuntimeError('not released')), \
                patch.object(m, 'OUTPUT', Path(temp) / 'missing.json'), \
                patch.object(m, 'complete_cached_snapshots', side_effect=[False, True]) as existing, \
                patch.object(m, 'parallel_map') as collect:
            m.refresh_history(Path(temp))
        self.assertEqual([c.args[0] for c in existing.call_args_list], ['2026-10-21', '2026-10-20'])
        collect.assert_not_called()


if __name__ == '__main__':
    unittest.main()

