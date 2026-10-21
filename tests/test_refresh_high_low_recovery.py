import datetime as dt
import importlib.util
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

    def test_workflow_has_one_morning_repair_and_only_universe_cache(self):
        source = (Path(__file__).resolve().parents[1] / '.github/workflows/refresh-high-low-52w.yml').read_text()
        self.assertIn("cron: '15 0 * * 1-5'", source)
        self.assertIn("cron: '15 7,8 * * 1-5'", source)
        self.assertIn('high-low-52w-cache/universe-*.json', source)
        self.assertNotIn('high-low-52w-cache/**', source)

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
                patch.object(m, 'complete_cached_snapshots', side_effect=[False, True]) as existing, \
                patch.object(m, 'parallel_map') as collect:
            m.refresh_history(Path(temp))
        self.assertEqual([c.args[0] for c in existing.call_args_list], ['2026-10-21', '2026-10-20'])
        collect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
