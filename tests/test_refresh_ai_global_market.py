import copy
import datetime as dt
import importlib.util
from pathlib import Path
import unittest
from urllib.parse import parse_qs, urlparse


FILE = Path(__file__).resolve().parents[1] / '.github/scripts/refresh_ai_global_market.py'
spec = importlib.util.spec_from_file_location('global_market', FILE)
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
NOW = dt.datetime(2026, 11, 20, 11, 20, tzinfo=M.CN)


def series(n=100):
    date = dt.date(2026, 11, 19)
    dates = []
    while len(dates) < n:
        if date.weekday() < 5:
            dates.append(date.isoformat())
        date -= dt.timedelta(days=1)
    return [{'date': d, 'close': 100.0 + i} for i, d in enumerate(reversed(dates))]


def fetcher(url):
    parsed = urlparse(url)
    if 'gtimg' in parsed.hostname:
        code = parse_qs(parsed.query)['param'][0].split(',')[0]
        return {'code': 0, 'data': {code: {'day': [[r['date'], '100', str(r['close'])] for r in series()]}}}
    if 'naver' in parsed.hostname:
        code = parsed.path.split('/')[-1]
        return {'code': code, 'priceInfos': [{'localDate': r['date'].replace('-', ''), 'closePrice': r['close']} for r in series()]}
    code = parse_qs(parsed.query)['data_id'][0]
    return {'status': 200, 'data': [{'stock_id': code, **row} for row in series()]}


class ClosingDataTests(unittest.TestCase):
    def test_cutoff_uses_each_exchange_timezone_and_close_buffer(self):
        market = {m['id']: m for m in M.MARKETS}
        for value in market.values():
            self.assertEqual(M.close_cutoff(value, NOW), dt.date(2026, 11, 19))
        at_cn_close = NOW.replace(hour=15, minute=5)
        self.assertEqual(M.close_cutoff(market['cn'], at_cn_close), dt.date(2026, 11, 19))
        self.assertEqual(M.close_cutoff(market['tw'], at_cn_close), dt.date(2026, 11, 20))
        self.assertEqual(M.close_cutoff(market['kr'], at_cn_close), dt.date(2026, 11, 20))

    def test_security_parsers_require_explicit_matching_identity(self):
        cutoff = dt.date(2026, 11, 19)
        with self.assertRaises(ValueError):
            M.parse_tencent({'code': 0, 'data': {'usNVDA': {'day': []}}}, 'usNVDA.OQ', cutoff)
        with self.assertRaises(ValueError):
            M.parse_naver({'code': '.TWII', 'priceInfos': []}, '.INX', cutoff)
        with self.assertRaises(ValueError):
            M.parse_finmind({'status': 200, 'data': [{'stock_id': '2454', 'date': '2026-11-19', 'close': 100}]}, '2330', cutoff)

    def test_future_duplicate_weekend_missing_and_nonpositive_closes_rejected(self):
        cutoff = dt.date(2026, 11, 19)
        for change in [lambda r: r.append(r[-1]), lambda r: r[-1].update(date='2026-11-20'),
                       lambda r: r[-1].update(date='2026-11-22'), lambda r: r[-1].update(close=0),
                       lambda r: r[-1].update(close=None), lambda r: r[-1].update(close=float('nan')),
                       lambda r: r[-1].update(close=True)]:
            rows = series()
            change(rows)
            with self.assertRaises(ValueError):
                M.validate_series(rows, cutoff)
        self.assertEqual(len(M.validate_series(series(140), cutoff)), 120)

    def test_todays_intraday_provider_candle_is_excluded(self):
        rows = series() + [{'date': '2026-11-20', 'close': 9999}]
        raw = {'code': '005930', 'priceInfos': [{'localDate': r['date'].replace('-', ''), 'closePrice': r['close']} for r in rows]}
        parsed = M.parse_naver(raw, '005930', dt.date(2026, 11, 19))
        self.assertEqual(parsed[-1]['date'], '2026-11-19')
        self.assertNotEqual(parsed[-1]['close'], 9999)

    def test_four_markets_keep_fixed_samples_actual_currencies_and_common_dates(self):
        result = M.refresh(now=NOW, fetcher=fetcher)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual([m['id'] for m in result['markets']], ['us', 'kr', 'tw', 'cn'])
        self.assertEqual([m['currency'] for m in result['markets']], ['USD', 'KRW', 'TWD', 'CNY'])
        self.assertEqual([len(m['stocks']) for m in result['markets']], [5, 2, 3, 4])
        for market in result['markets']:
            self.assertEqual(market['asOf'], '2026-11-19')
            self.assertGreaterEqual(len(M.common_dates(market)), 61)
            for security in [market['benchmark'], *market['stocks']]:
                self.assertTrue(security['sourceUrl'].startswith('https://'))

    def test_one_missing_security_cannot_silently_shrink_a_sample(self):
        old = M.refresh(now=NOW, fetcher=fetcher)
        def missing(url):
            if 'data_id=2454' in url:
                raise OSError('feed outage')
            return fetcher(url)
        latest = M.refresh(old, NOW, missing)
        taiwan = latest['markets'][2]
        self.assertEqual(taiwan['status'], 'retained')
        self.assertEqual(taiwan['stocks'], old['markets'][2]['stocks'])
        self.assertEqual(latest['status'], 'partial')
        with self.assertRaises(ValueError):
            M.refresh(None, NOW, missing)

    def test_common_date_requirement_never_interpolates_missing_values(self):
        definition = M.MARKETS[0]
        parts = [M.fetch_security(s, definition, NOW, fetcher) for s in [definition['benchmark'], *definition['stocks']]]
        del parts[-1]['series'][-10]
        market = M.finish_market(definition, parts, NOW)
        self.assertEqual(market['commonSessions'], 99)
        self.assertNotIn(series()[-10]['date'], M.common_dates(market))
        parts[-1]['series'] = parts[-1]['series'][:60]
        with self.assertRaises(ValueError):
            M.finish_market(definition, parts, NOW)

    def test_invalid_old_sample_cannot_be_retained_just_because_it_was_published(self):
        old = M.refresh(now=NOW, fetcher=fetcher)
        self.assertTrue(M.valid_previous_market(old['markets'][2], M.MARKETS[2], NOW))
        corrupted = copy.deepcopy(old)
        corrupted['markets'][2]['stocks'][0]['series'][-1]['close'] = 0
        self.assertFalse(M.valid_previous_market(corrupted['markets'][2], M.MARKETS[2], NOW))
        def missing(url):
            if 'data_id=2454' in url:
                raise OSError('feed outage')
            return fetcher(url)
        with self.assertRaises(ValueError):
            M.refresh(corrupted, NOW, missing)
        clean = M.refresh(corrupted, NOW, fetcher)
        self.assertEqual(clean['status'], 'ok')


if __name__ == '__main__':
    unittest.main()
