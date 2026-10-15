import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve()
SCRIPT = HERE.parent / 'market-quality-refresh_market_quality.py'
if not SCRIPT.exists():
    SCRIPT = HERE.parents[1] / '.github/scripts/refresh_market_quality.py'
spec = importlib.util.spec_from_file_location('market_quality', SCRIPT)
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


def example():
    u = {'sh600001': {'name': 'A', 'close': 10, 'change': -2},
         'sz000001': {'name': 'B', 'close': 20, 'change': 0},
         'sz300001': {'name': 'C', 'close': 30, 'change': 6},
         'sh688001': {'name': 'D', 'close': 40, 'change': 10}}
    p = {code: [{'date': '2026-10-14', 'close': row['close'], 'amountYuan': (i + 1) * 10000000}]
         for i, (code, row) in enumerate(u.items())}
    return u, p


def valid_payload():
    days = []
    day = dt.date(2026, 10, 14)
    while len(days) < 60:
        if day.weekday() < 5:
            days.append(day.isoformat())
        day -= dt.timedelta(days=1)
    days.reverse()
    top = [{'code': f'sh600{i:03}', 'name': str(i), 'amountYuan': 1000000000} for i in range(20)]
    rows = [{'date': day, 'asOf': '15:00', 'status': 'close', 'universeCount': 5200,
             'eligibleCount': 5150, 'medianReturnPct': -.2, 'q25ReturnPct': -1,
             'q75ReturnPct': .5, 'totalAmountYuan': 1000000000000,
             'top20AmountYuan': 20000000000, 'top20SharePct': 2,
             'top20Count': 20, 'top20': copy.deepcopy(top)} for day in days]
    return {'schemaVersion': 1, 'scope': '沪深A股', 'updatedAt': '2026-10-15T09:00:00+08:00',
            'source': 'source', 'methodology': 'method', 'series': rows}


def missing_flat_fixture():
    universe, prices = example()
    prices['sz000001'] = [{'date': '2026-10-13', 'close': 20, 'amountYuan': 10000000}]
    independent = [
        {'date': '2026-10-12', 'close': 20, 'volume': 100000},
        {'date': '2026-10-13', 'close': 20, 'volume': 100000},
        {'date': '2026-10-14', 'close': 20, 'volume': 200000},
    ]
    return universe, prices, independent


class MarketQualityTests(unittest.TestCase):
    def test_scope_rejects_bj_bshare_index_etf(self):
        for code in ('bj920001', 'sh900901', 'sz200001', 'sh000001', 'sh510300', 'sz159919'):
            self.assertFalse(q.valid_symbol(code), code)
        for code in ('sh600519', 'sh688001', 'sz000001', 'sz300308', 'sz301001'):
            self.assertTrue(q.valid_symbol(code), code)

    def test_median_and_linear_quartiles(self):
        u, p = example()
        row = q.build_day('2026-10-14', u, p, minimum=1)
        self.assertEqual((row['medianReturnPct'], row['q25ReturnPct'], row['q75ReturnPct']), (3, -.5, 7))
        self.assertEqual(row['totalAmountYuan'], 100000000)

    def test_excludes_suspended_not_flat(self):
        u, p = example()
        p['sh600001'][0]['amountYuan'] = 0
        row = q.build_day('2026-10-14', u, p, minimum=1)
        self.assertEqual(row['eligibleCount'], 3)
        self.assertEqual(row['medianReturnPct'], 6)

    def test_traded_flat_is_retained(self):
        u, p = example()
        row = q.build_day('2026-10-14', u, p, minimum=1)
        self.assertEqual(row['eligibleCount'], 4)
        self.assertEqual(row['q25ReturnPct'], -.5)

    def test_partial_symbol_raises(self):
        u, p = example()
        del p['sz000001']
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            q.build_day('2026-10-14', u, p, minimum=1)

    def test_missing_bar_with_nonzero_source_return_is_not_suspension(self):
        u, p = example()
        p['sh600001'] = []
        with self.assertRaisesRegex(ValueError, 'amount bar is missing'):
            q.build_day('2026-10-14', u, p, minimum=1)

    def test_missing_zero_return_is_not_assumed_suspension(self):
        u, p, _ = missing_flat_fixture()
        with self.assertRaisesRegex(ValueError, 'independent nontrading verification'):
            q.build_day('2026-10-14', u, p, minimum=1)

    def test_omitted_flat_traded_session_is_recovered_with_actual_amount(self):
        u, p, independent = missing_flat_fixture()
        actual = [{'date': '2026-10-14', 'close': 20, 'amountYuan': 20000000}]
        with mock.patch.object(q, 'fetch_sina_volume_bars', return_value=independent), \
                mock.patch.object(q, 'fetch_eastmoney_amount_bars', return_value=actual):
            verified = q.reconcile_missing_sessions({'2026-10-14': u}, p, '2026-10-13', '2026-10-14')
        self.assertEqual(verified, set())
        row = q.build_day('2026-10-14', u, p, minimum=1, verified_nontrading=verified)
        self.assertEqual(row['eligibleCount'], 4)
        self.assertEqual(row['totalAmountYuan'], 100000000)
        self.assertEqual(row['medianReturnPct'], 3)

    def test_independently_absent_session_can_be_excluded(self):
        u, p, independent = missing_flat_fixture()
        with mock.patch.object(q, 'fetch_sina_volume_bars', return_value=independent[:-1]):
            verified = q.reconcile_missing_sessions({'2026-10-14': u}, p, '2026-10-13', '2026-10-14')
        self.assertEqual(verified, {('sz000001', '2026-10-14')})
        row = q.build_day('2026-10-14', u, p, minimum=1, verified_nontrading=verified)
        self.assertEqual(row['eligibleCount'], 3)

    def test_failed_secondary_cannot_prove_nontrading(self):
        u, p, _ = missing_flat_fixture()
        with mock.patch.object(q, 'fetch_sina_volume_bars', side_effect=RuntimeError('offline')):
            with self.assertRaisesRegex(RuntimeError, 'offline'):
                q.reconcile_missing_sessions({'2026-10-14': u}, p, '2026-10-13', '2026-10-14')

    def test_partial_secondary_missing_known_session_is_rejected(self):
        u, p, independent = missing_flat_fixture()
        independent.pop(1)
        with mock.patch.object(q, 'fetch_sina_volume_bars', return_value=independent):
            with self.assertRaisesRegex(ValueError, 'known traded session'):
                q.reconcile_missing_sessions({'2026-10-14': u}, p, '2026-10-13', '2026-10-14')

    def test_secondary_wrong_raw_close_is_rejected(self):
        u, p, independent = missing_flat_fixture()
        independent[1]['close'] = 21
        with mock.patch.object(q, 'fetch_sina_volume_bars', return_value=independent):
            with self.assertRaisesRegex(ValueError, 'raw close disagrees'):
                q.reconcile_missing_sessions({'2026-10-14': u}, p, '2026-10-13', '2026-10-14')

    def test_secondary_response_must_cover_start_before_accepting_absence(self):
        u, p, independent = missing_flat_fixture()
        with mock.patch.object(q, 'fetch_sina_volume_bars', return_value=independent[1:]):
            with self.assertRaisesRegex(ValueError, 'incomplete independent'):
                q.reconcile_missing_sessions({'2026-10-14': u}, p, '2026-10-13', '2026-10-14')

    def test_traded_missing_return_raises(self):
        u, p = example()
        u['sz000001']['change'] = None
        with self.assertRaisesRegex(ValueError, 'missing'):
            q.build_day('2026-10-14', u, p, minimum=1)

    def test_source_close_crosscheck(self):
        u, p = example()
        p['sz000001'][0]['close'] = 21
        with self.assertRaisesRegex(ValueError, 'disagrees'):
            q.build_day('2026-10-14', u, p, minimum=1)

    def test_top20_uses_amount_rank_and_full_denominator(self):
        u, p = {}, {}
        for i in range(25):
            code = f'sh600{i:03}'
            u[code] = {'name': str(i), 'close': 10, 'change': 1}
            p[code] = [{'date': '2026-10-14', 'close': 10, 'amountYuan': (i + 1) * 1000000}]
        row = q.build_day('2026-10-14', u, p, minimum=1)
        self.assertEqual(row['top20'][0]['code'], 'sh600024')
        self.assertEqual(row['top20Count'], 20)
        self.assertEqual(row['totalAmountYuan'], 325000000)
        self.assertEqual(row['top20AmountYuan'], 310000000)
        self.assertAlmostEqual(row['top20SharePct'], 100 * 310 / 325, places=5)

    def test_tencent_amount_unit(self):
        payload = {'code': 0, 'data': {'sh600001': {'day': [['2026-10-14', '10', '10.5', '11', '10', '1000', {}, '1', '105']]}}}
        rows = q.parse_tencent_bars(payload, 'sh600001')
        self.assertEqual(rows[0]['amountYuan'], 1050000)

    def test_tencent_wrong_amount_unit_rejected(self):
        payload = {'code': 0, 'data': {'sh600001': {'day': [['2026-10-14', '10', '10.5', '11', '10', '1000', {}, '1', '1050000']]}}}
        with self.assertRaisesRegex(ValueError, 'unit inconsistency'):
            q.parse_tencent_bars(payload, 'sh600001')

    def test_star_volume_uses_shares_amount_still_ten_thousand_yuan(self):
        payload = {'code': 0, 'data': {'sh688001': {'day': [['2026-10-14', '56.13', '52.97', '56.50', '52.53', '7459544', {}, '1.58', '40061.08']]}}}
        row = q.parse_tencent_bars(payload, 'sh688001')[0]
        self.assertEqual(row['amountYuan'], 400610800)

    def test_duplicate_date_rejected(self):
        bar = ['2026-10-14', '10', '10.5', '11', '10', '1000', {}, '1', '105']
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            q.parse_tencent_bars({'code': 0, 'data': {'sh600001': {'day': [bar, bar]}}}, 'sh600001')

    def test_fallback_is_already_yuan(self):
        payload = {'data': {'code': '600001', 'market': 1, 'klines': ['2026-10-14,10,10.5,11,10,1000,1050000,0,0']}}
        self.assertEqual(q.parse_eastmoney_bars(payload, 'sh600001')[0]['amountYuan'], 1050000)

    def test_valid_payload(self):
        self.assertEqual(len(q.validate_payload(valid_payload())['series']), 60)

    def test_wrong_ratio_rejected(self):
        payload = valid_payload()
        payload['series'][-1]['top20SharePct'] = 20
        with self.assertRaisesRegex(ValueError, 'ratio'):
            q.validate_payload(payload)

    def test_wrong_sum_rejected(self):
        payload = valid_payload()
        payload['series'][-1]['top20AmountYuan'] += 10000
        with self.assertRaisesRegex(ValueError, 'sums'):
            q.validate_payload(payload)

    def test_invalid_coverage_rejected(self):
        payload = valid_payload()
        payload['series'][-1]['eligibleCount'] = 0
        with self.assertRaisesRegex(ValueError, 'coverage'):
            q.validate_payload(payload)

    def test_unfinished_close_rejected(self):
        payload = valid_payload()
        payload['updatedAt'] = '2026-10-14T11:30:00+08:00'
        with self.assertRaisesRegex(ValueError, 'Unfinished'):
            q.validate_payload(payload)

    def test_failed_refresh_preserves_existing_json(self):
        with tempfile.TemporaryDirectory() as d:
            p, b = Path(d) / 'out.json', Path(d) / 'baseline.json'
            p.write_text(json.dumps(valid_payload()))
            b.write_text('original baseline')
            before = p.read_bytes()
            with mock.patch.object(q, 'fetch_calendar', side_effect=RuntimeError('offline')):
                with self.assertRaises(RuntimeError):
                    q.refresh(p, b, Path(d) / 'cache')
            self.assertEqual(p.read_bytes(), before)
            self.assertEqual(b.read_text(), 'original baseline')

    def test_source_date_regression_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'out.json'
            value = valid_payload()
            p.write_text(json.dumps(value))
            dates = [r['date'] for r in value['series']]
            dates[-1] = '2026-10-13'
            with mock.patch.object(q, 'fetch_calendar', return_value=dates):
                with self.assertRaisesRegex(ValueError, 'regression'):
                    q.refresh(p, Path(d) / 'b.json', Path(d) / 'cache')

    def test_failed_secondary_refresh_preserves_both_published_artifacts(self):
        with tempfile.TemporaryDirectory() as d:
            output, baseline = Path(d) / 'out.json', Path(d) / 'baseline.json'
            old = valid_payload()
            output.write_text(json.dumps(old))
            baseline.write_text('existing valid baseline')
            before = output.read_bytes()
            u, p, _ = missing_flat_fixture()
            dates = [r['date'] for r in old['series']]
            with mock.patch.object(q, 'fetch_calendar', return_value=dates), \
                    mock.patch.object(q, 'fetch_valuations', return_value=u), \
                    mock.patch.object(q, 'fetch_amount_bars', side_effect=lambda code, *_: p[code]), \
                    mock.patch.object(q, 'fetch_sina_volume_bars', side_effect=RuntimeError('secondary offline')):
                with self.assertRaisesRegex(RuntimeError, 'secondary offline'):
                    q.refresh(output, baseline, Path(d) / 'cache')
            self.assertEqual(output.read_bytes(), before)
            self.assertEqual(baseline.read_text(), 'existing valid baseline')


if __name__ == '__main__':
    unittest.main()
