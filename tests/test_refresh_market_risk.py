import datetime as dt
from copy import deepcopy
import importlib.util
import json
import math
from pathlib import Path
import statistics
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / '.github/scripts/refresh_market_risk.py'
if not PATH.exists():
    PATH = Path('/private/tmp/environment-risk-refresh_market_risk.py')
spec = importlib.util.spec_from_file_location('market_risk', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = dt.datetime(2026, 10, 14, 16, 50, tzinfo=m.TZ)


def bars(count=200, last='2026-10-14'):
    end, dates = dt.date.fromisoformat(last), []
    while len(dates) < count:
        if end.weekday() < 5:
            dates.append(end.isoformat())
        end -= dt.timedelta(days=1)
    result = []
    for i, date in enumerate(reversed(dates)):
        close = 100 + i * .1 + math.sin(i / 3)
        result.append({'date': date, 'close': close, 'high': close + 2, 'low': close - 2, 'volume': 1000})
    return result


def tencent(rows, symbol='sh000985', stamp='20261014161500'):
    q = [''] * 40
    q[2], q[3], q[30], q[33], q[34] = symbol[2:], rows[-1]['close'], stamp, rows[-1]['high'], rows[-1]['low']
    return {'code': 0, 'data': {symbol: {'day': [[r['date'], r['close'], r['close'], r['high'], r['low'], r['volume']] for r in rows], 'qt': {symbol: q}}}}


class MarketRiskTests(unittest.TestCase):
    def test_rv20_matches_independent_sample_standard_deviation(self):
        returns = [.01, -.012, .004, .008, -.009] * 4
        closes = [100.0]
        for value in returns:
            closes.append(closes[-1] * math.exp(value))
        expected = statistics.stdev(returns) * math.sqrt(252) * 100
        self.assertAlmostEqual(m.rv20(closes), expected, places=11)
        population = statistics.pstdev(returns) * math.sqrt(252) * 100
        self.assertNotAlmostEqual(m.rv20(closes), population, places=5)

    def test_twenty_returns_require_twenty_one_prices(self):
        for length in (0, 1, 20, 22):
            with self.assertRaisesRegex(ValueError, '21 closes'):
                m.rv20([100] * length)
        self.assertEqual(m.rv20([100] * 21), 0)

    def test_high_window_is_sixty_sessions_including_today(self):
        rows = bars(61)
        for row in rows:
            row.update(close=100, high=110, low=90)
        rows[0]['high'] = 200
        rows[1]['high'] = 150
        self.assertEqual(m.observation(rows, 59)['peak60'], 200)
        self.assertEqual(m.observation(rows, 60)['peak60'], 150)
        rows[-1]['high'] = 175
        self.assertEqual(m.observation(rows, 60)['peak60'], 175)

    def test_drawdown_uses_daily_high_not_close_and_is_not_mdd(self):
        rows = bars(60)
        for row in rows:
            row.update(close=100, high=110, low=90)
        rows[5].update(close=150, high=200, low=145)
        rows[6].update(close=50, high=60, low=45)
        rows[-1].update(close=160, high=165, low=150)
        result = m.observation(rows, 59)
        self.assertEqual(result['peak60'], 200)
        self.assertEqual(result['drawdown60'], -20)
        self.assertNotEqual(result['drawdown60'], (50 / 200 - 1) * 100)

    def test_no_lookahead_and_zero_drawdown_at_new_high(self):
        rows = bars(61)
        rows[-1].update(close=1000, high=1000, low=900)
        self.assertLess(m.observation(rows, 59)['peak60'], 1000)
        self.assertEqual(m.observation(rows, 60)['drawdown60'], 0)

    def test_series_last_sixty_and_raw_price_precision_retained(self):
        rows = bars(200)
        rows[-1]['close'] = 119.123456789
        payload = m.build_payload(rows, NOW)
        self.assertEqual(len(payload['series']), 60)
        self.assertEqual(len(payload['bars']), 200)
        self.assertEqual(payload['series'][0]['date'], rows[-60]['date'])
        self.assertEqual(payload['bars'][-1]['close'], 119.123456789)
        self.assertEqual(payload['series'][-1]['close'], 119.1235)
        self.assertEqual(payload['series'][-1]['asOf'], '15:00')
        self.assertEqual(payload['series'][-1]['status'], 'close')
        m.validate_payload(payload, NOW)

    def test_insufficient_warmup_never_creates_partial_history(self):
        with self.assertRaisesRegex(ValueError, '119'):
            m.build_payload(bars(118), NOW)
        self.assertEqual(len(m.build_payload(bars(119), NOW)['series']), 60)

    def test_current_intraday_removed_and_not_fabricated_over_weekend(self):
        rows = bars()
        noon = NOW.replace(hour=12)
        payload = m.build_payload(rows, noon)
        self.assertEqual(payload['series'][-1]['date'], '2026-10-13')
        self.assertEqual(len(payload['bars']), 199)
        friday = bars(last='2026-10-09')
        saturday = dt.datetime(2026, 10, 10, 16, tzinfo=m.TZ)
        payload = m.build_payload(friday, saturday)
        self.assertEqual(payload['series'][-1]['date'], '2026-10-09')

    def test_tencent_rejects_code_and_adjusted_only_response(self):
        raw = tencent(bars())
        self.assertEqual(len(m.parse_tencent(raw, now=NOW)), 200)
        bad = deepcopy(raw)
        bad['data']['sh000985']['qt']['sh000985'][2] = '000300'
        with self.assertRaisesRegex(ValueError, 'code'):
            m.parse_tencent(bad, now=NOW)
        bad = deepcopy(raw)
        bad['data']['sh000985']['qfqday'] = bad['data']['sh000985'].pop('day')
        with self.assertRaisesRegex(ValueError, 'unadjusted'):
            m.parse_tencent(bad, now=NOW)

    def test_stale_intraday_quote_does_not_certify_today_close(self):
        raw = tencent(bars(), stamp='20261014145900')
        self.assertEqual(m.parse_tencent(raw, now=NOW)[-1]['date'], '2026-10-13')
        raw['data']['sh000985'].pop('qt')
        self.assertEqual(m.parse_tencent(raw, now=NOW)[-1]['date'], '2026-10-13')
        raw = tencent(bars())
        raw['data']['sh000985']['qt']['sh000985'][3] = 10000
        with self.assertRaisesRegex(ValueError, 'disagree'):
            m.parse_tencent(raw, now=NOW)

    def test_future_duplicate_unsorted_missing_and_weekend_dates(self):
        alterations = [
            lambda rows: rows[-1].update(date='2026-10-15'),
            lambda rows: rows[-1].update(date=rows[-2]['date']),
            lambda rows: rows.reverse(),
            lambda rows: rows[-1].pop('date'),
            lambda rows: rows[-1].update(date='2026-10-11'),
            lambda rows: rows[-1].update(date='20261014'),
        ]
        for alter in alterations:
            rows = bars()
            alter(rows)
            with self.subTest(alter=alter), self.assertRaises(ValueError):
                m.validate_bars(rows, NOW)

    def test_prices_volume_and_ohlc_full_validation(self):
        invalid = [(key, value) for key in ('close', 'high', 'low', 'volume') for value in (0, -1, float('nan'), float('inf'), True, None)]
        invalid += [('high', 1), ('low', 10000), ('open', 10000)]
        for key, value in invalid:
            rows = bars()
            rows[-1][key] = value
            with self.subTest(key=key, value=value), self.assertRaises((ValueError, TypeError)):
                m.validate_bars(rows, NOW)

    def test_reference_calendar_rejects_missing_holiday_and_stale_dates(self):
        reference = bars()
        m.validate_calendar(reference, reference)
        missing = deepcopy(reference)
        missing.pop(100)
        with self.assertRaisesRegex(ValueError, 'missing or non-trading'):
            m.validate_calendar(missing, reference)
        with self.assertRaisesRegex(ValueError, 'latest'):
            m.validate_calendar(reference[:-1], reference)
        # Even a weekday holiday is rejected by the independent benchmark.
        holiday = deepcopy(reference)
        reference.pop(100)
        with self.assertRaisesRegex(ValueError, 'non-trading'):
            m.validate_calendar(holiday, reference)

    def test_eastmoney_requires_code_market_and_completed_timestamp(self):
        rows = bars()
        raw = {'data': {'code': '000985', 'market': 1, 'klines': [','.join(map(str, (r['date'], r['close'], r['close'], r['high'], r['low'], r['volume']))) for r in rows]}}
        q = {'data': {'f57': '000985', 'f59': 6, 'f86': int(NOW.timestamp()), 'f43': rows[-1]['close'] * 10 ** 6,
                      'f44': rows[-1]['high'] * 10 ** 6, 'f45': rows[-1]['low'] * 10 ** 6}}
        self.assertEqual(len(m.parse_eastmoney(raw, now=NOW, quote=q)), 200)
        for bad in ({'data': {**raw['data'], 'code': '000300'}}, {'data': {**raw['data'], 'market': 0}}):
            with self.assertRaisesRegex(ValueError, 'code or market'):
                m.parse_eastmoney(bad, now=NOW, quote=q)
        with self.assertRaisesRegex(ValueError, 'timestamp'):
            m.parse_eastmoney(raw, now=NOW)
        q['data']['f86'] = int(NOW.replace(hour=14).timestamp())
        self.assertEqual(m.parse_eastmoney(raw, now=NOW, quote=q)[-1]['date'], '2026-10-13')

    def test_snapshot_ties_metrics_to_raw_prices_and_timestamp(self):
        payload = m.build_payload(bars(), NOW)
        changes = [
            lambda p: p.update(schemaVersion=True),
            lambda p: p.update(index={'code': '000300', 'name': '沪深300'}),
            lambda p: p.update(updatedAt='2026-10-15T16:00:00+08:00'),
            lambda p: p.update(updatedAt='2026-10-14T12:00:00+08:00'),
            lambda p: p['series'][-1].update(rv20=99),
            lambda p: p['series'][-1].update(drawdown60=1),
            lambda p: p['series'][-1].update(status='live'),
            lambda p: p['series'][-1].update(asOf='12:00'),
            lambda p: p['series'][-1].update(close=float('nan')),
            lambda p: p['series'].reverse(),
        ]
        for change in changes:
            bad = deepcopy(payload)
            change(bad)
            with self.subTest(change=change), self.assertRaises(ValueError):
                m.validate_payload(bad, NOW)

    def test_fetch_failure_and_regression_preserve_exact_valid_file(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'risk.json'
            raw = json.dumps(m.build_payload(bars(), NOW), ensure_ascii=False)
            output.write_text(raw)
            with patch.object(m, 'fetch_bars', side_effect=RuntimeError('network failed')):
                with self.assertRaises(RuntimeError):
                    m.refresh(output, NOW)
            self.assertEqual(output.read_text(), raw)
            old = bars(last='2026-10-13')
            with patch.object(m, 'fetch_bars', side_effect=[(old, 'test', 'url'), (old, 'test', 'url')]):
                with self.assertRaisesRegex(ValueError, 'regression'):
                    m.refresh(output, NOW)
            self.assertEqual(output.read_text(), raw)

    def test_source_fallback_and_atomic_success(self):
        raw = tencent(bars())
        with patch.object(m, 'get_json', side_effect=[RuntimeError('first source failed'), raw]) as getter:
            fetched, source, url = m.fetch_bars(NOW)
            self.assertEqual(len(fetched), 200)
            self.assertIn('proxy.finance.qq.com', url)
            self.assertEqual(getter.call_count, 2)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'risk.json'
            rows = bars()
            with patch.object(m, 'fetch_bars', side_effect=[(rows, 'test', 'url'), (rows, 'test', 'url')]):
                payload = m.refresh(output, NOW)
            self.assertEqual(json.loads(output.read_text()), payload)
            self.assertFalse(output.with_suffix('.json.tmp').exists())

    def test_eastmoney_fallback_when_both_tencent_hosts_fail(self):
        rows = bars(last='2026-10-13')
        raw = {'data': {'code': '000985', 'market': 1, 'klines': [','.join(map(str, (r['date'], r['close'], r['close'], r['high'], r['low'], r['volume']))) for r in rows]}}
        with patch.object(m, 'get_json', side_effect=[RuntimeError('primary'), RuntimeError('proxy'), raw]) as getter:
            fetched, source, url = m.fetch_bars(NOW)
            self.assertEqual(fetched[-1]['date'], '2026-10-13')
            self.assertEqual(len(fetched), 200)
            self.assertEqual(source, '东方财富未复权日线')
            self.assertIn('fqt=0', url)
            self.assertEqual(getter.call_count, 3)

    def test_future_source_quote_and_boolean_source_status_rejected(self):
        raw = tencent(bars(), stamp='20261015150000')
        with self.assertRaisesRegex(ValueError, 'future quote'):
            m.parse_tencent(raw, now=NOW)
        raw = tencent(bars())
        raw['code'] = False
        with self.assertRaisesRegex(ValueError, 'request failed'):
            m.parse_tencent(raw, now=NOW)


if __name__ == '__main__':
    unittest.main()
