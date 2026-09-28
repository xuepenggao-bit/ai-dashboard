import copy
import json
import datetime as dt
import importlib.util
import pathlib
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).parents[1] / '.github' / 'scripts' / 'refresh_market_panels.py'
SPEC = importlib.util.spec_from_file_location('refresh_market_panels', SCRIPT)
PANELS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PANELS)
NOW = int(dt.datetime(2026, 9, 28, 15, 10, tzinfo=dt.timezone(dt.timedelta(hours=8))).timestamp() * 1000)
CLOSE = NOW - 10 * 60 * 1000


def rows(count=1000, **changes):
    values = [9.5, 5, 1, .01, 0, -.01, -1, -5, -9.5]
    return [{"f12": str(i).zfill(6), "f13": 0, "f14": "测试股票" + str(i),
             "f3": values[i % 9], "f62": (i + 1) * 10000, "f184": 1.5,
             "f124": CLOSE // 1000, **changes} for i in range(count)]


def breadth():
    return PANELS.make_breadth(rows(), 1000, NOW)


def flow(direction='inflow'):
    return PANELS.make_flow(rows(20, f62=100000 if direction == 'inflow' else -100000), direction, NOW)


class MarketPanelTests(unittest.TestCase):
    def test_official_h5_gateway_preserves_percentage_units_and_pool(self):
        payload={'data':{'total':1000,'diff':rows(100)}}
        response=mock.MagicMock()
        response.__enter__.return_value.read.return_value=json.dumps(payload).encode()
        with mock.patch.object(PANELS,'urlopen',return_value=response) as opened:
            result=PANELS.request_any({'fs':PANELS.BREADTH_POOL,'fltt':2})
        self.assertEqual(result,payload)
        url=opened.call_args.args[0].full_url
        self.assertTrue(url.startswith(PANELS.H5_LIST_URL))
        self.assertIn('%2B',url)
        self.assertEqual(result['data']['diff'][0]['f3'],9.5)

    def test_h5_failure_falls_back_to_direct_source(self):
        payload={'data':{'total':1000,'diff':rows(100)}}
        with mock.patch.object(PANELS,'urlopen',side_effect=OSError('offline')), \
                mock.patch.object(PANELS,'request_json',return_value=payload) as direct:
            self.assertEqual(PANELS.request_any({'fltt':2}),payload)
        direct.assert_called_once()

    def test_timestamp_uses_provider_not_receipt(self):
        result = breadth()
        self.assertEqual(result['quoteTs'], CLOSE)
        self.assertEqual(result['observedAt'], NOW)
        self.assertEqual(result['timeBasis'], 'provider')

    def test_missing_and_future_timestamp_never_become_close_time(self):
        for value in (None, '-', 0, NOW + 3600000):
            result = PANELS.make_breadth(rows(f124=value), 1000, NOW)
            self.assertEqual(result['quoteTs'], 0)
            self.assertEqual(result['timeBasis'], 'observed')

    def test_distribution_uses_existing_nine_thresholds(self):
        result = breadth()
        self.assertEqual(result['counts'], [112, 111, 111, 111, 111, 111, 111, 111, 111])
        self.assertEqual(sum(result['counts']), result['total'])

    def test_missing_quote_is_not_counted_as_flat(self):
        source = rows()
        source[0]['f3'] = '-'
        result = PANELS.make_breadth(source, 1000, NOW)
        self.assertEqual(result['counts'][4], 111)
        self.assertEqual(sum(result['counts']), 999)

    def test_source_reset_all_flat_rejected(self):
        for value in (0, '-', None):
            with self.assertRaises(ValueError):
                PANELS.make_breadth(rows(f3=value), 1000, NOW)

    def test_partial_quotes_and_incomplete_universe_rejected(self):
        source = rows()
        for row in source[:500]:
            row['f3'] = '-'
        with self.assertRaises(ValueError):
            PANELS.make_breadth(source, 1000, NOW)
        with self.assertRaises(ValueError):
            PANELS.make_breadth(rows(999), 1000, NOW)

    def pages(self):
        source = rows()
        return {i + 1: {'data': {'total': 1000, 'diff': source[i * 100:(i + 1) * 100]}}
                for i in range(10)}

    def test_full_pages_accepted(self):
        self.assertEqual(len(PANELS.assemble_pages(self.pages(), 1000)), 1000)

    def test_missing_truncated_and_duplicate_pages_rejected(self):
        for mode in ('missing', 'truncated', 'duplicate', 'changed_total'):
            pages = self.pages()
            if mode == 'missing':
                del pages[5]
            elif mode == 'truncated':
                pages[5]['data']['diff'].pop()
            elif mode == 'duplicate':
                pages[5] = copy.deepcopy(pages[4])
            else:
                pages[5]['data']['total'] = 1001
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                PANELS.assemble_pages(pages, 1000)

    def test_object_diff_and_empty_response(self):
        total, diff = PANELS.normalize_diff({'data': {'total': 20, 'diff': {'0': rows(1)[0]}}})
        self.assertEqual(total, 20)
        self.assertEqual(len(diff), 1)
        for payload in ({}, {'rc': 1}, {'data': {'total': 20, 'diff': []}}):
            with self.assertRaises(ValueError):
                PANELS.normalize_diff(payload)

    def test_flow_sorted_and_negative_outflow_kept(self):
        result = PANELS.make_flow(rows(20), 'inflow', NOW)
        self.assertGreater(result['rows'][0]['f62'], result['rows'][-1]['f62'])
        source = rows(20)
        for row in source:
            row['f62'] *= -1
        result = PANELS.make_flow(source, 'outflow', NOW)
        self.assertLess(result['rows'][0]['f62'], result['rows'][-1]['f62'])
        self.assertEqual(result['quoteTs'], CLOSE)

    def test_empty_partial_zero_invalid_wrong_sign_flow_rejected(self):
        for direction in ('inflow', 'outflow'):
            good = rows(20, f62=100000 if direction == 'inflow' else -100000)
            for mode in ('empty', 'partial', 'zero', 'wrong_sign', 'duplicate', 'missing_pct', 'missing_name'):
                source = copy.deepcopy(good)
                if mode == 'empty':
                    source = []
                elif mode == 'partial':
                    source.pop()
                elif mode == 'zero':
                    source[0]['f62'] = 0
                elif mode == 'wrong_sign':
                    source[0]['f62'] *= -1
                elif mode == 'duplicate':
                    source[0] = source[1]
                elif mode == 'missing_pct':
                    source[0]['f3'] = '-'
                else:
                    source[0]['f14'] = ''
                with self.subTest(direction=direction, mode=mode), self.assertRaises(ValueError):
                    PANELS.make_flow(source, direction, NOW)

    def test_failures_keep_closing_panels(self):
        for key, old in (('breadth', breadth()), ('inflow', flow()), ('outflow', flow('outflow'))):
            self.assertEqual(PANELS.merge_panel(key, old, None, NOW), old)
            self.assertEqual(PANELS.merge_panel(key, old, {}, NOW), old)

    def test_older_and_untimed_cannot_replace_timed_panel(self):
        old = breadth()
        for stamp in (CLOSE - 60000, 0):
            candidate = {**old, 'quoteTs': stamp, 'observedAt': NOW + 60000}
            self.assertEqual(PANELS.merge_panel('breadth', old, candidate, NOW + 60000), old)

    def test_new_day_quote_can_replace_prior_close(self):
        old = breadth()
        candidate = {**old, 'quoteTs': CLOSE + 86400000, 'observedAt': NOW + 86400000}
        self.assertEqual(PANELS.merge_panel('breadth', old, candidate, NOW + 86400000), candidate)

    def test_repeated_close_read_confirms_without_changing_quote_time(self):
        old = breadth()
        candidate = {**old, 'observedAt': NOW + 60000}
        merged = PANELS.merge_panel('breadth', old, candidate, NOW + 60000)
        self.assertEqual(merged, candidate)
        self.assertEqual(merged['quoteTs'], CLOSE)

    def test_same_provider_time_corrected_values_can_update(self):
        old = breadth()
        candidate = copy.deepcopy(old)
        candidate['counts'][0] += 1
        candidate['counts'][1] -= 1
        candidate['observedAt'] += 60000
        self.assertEqual(PANELS.merge_panel('breadth', old, candidate, NOW + 60000), candidate)

    def test_invalid_stored_and_future_panels_rejected(self):
        for changes in ({'counts': [0] * 9}, {'quoteTs': NOW + 3600000}, {'observedAt': 0}):
            self.assertIsNone(PANELS.merge_panel('breadth', {**breadth(), **changes}, None, NOW))

    def test_one_failed_source_does_not_clear_other_panels(self):
        previous = {'schema_version': 1, 'breadth': breadth(), 'inflow': flow(),
                    'outflow': flow('outflow'), 'updated_at': 'original'}
        with mock.patch.object(PANELS, 'fetch_breadth', side_effect=RuntimeError('offline')), \
                mock.patch.object(PANELS, 'fetch_flow', side_effect=RuntimeError('offline')):
            self.assertEqual(PANELS.refresh(previous, NOW), previous)

    def test_no_sources_no_cache_refuses_blank_publication(self):
        with mock.patch.object(PANELS, 'fetch_breadth', side_effect=RuntimeError('offline')), \
                mock.patch.object(PANELS, 'fetch_flow', side_effect=RuntimeError('offline')):
            with self.assertRaises(RuntimeError):
                PANELS.refresh({}, NOW)


if __name__ == '__main__':
    unittest.main()
