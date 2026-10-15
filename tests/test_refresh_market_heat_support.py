import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).with_name('market-heat-refresh_support.py')
if not SOURCE.exists():
    SOURCE = Path(__file__).resolve().parents[1] / '.github/scripts/refresh_market_heat_support.py'
spec = importlib.util.spec_from_file_location('heat_support', SOURCE)
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)


def sessions(n=150):
    result, d = [], dt.date(2026, 1, 1)
    while len(result) < n:
        if d.weekday() < 5:
            result.append(d.isoformat())
        d += dt.timedelta(days=1)
    return result


def fixture():
    dates = sessions()
    targets = dates[-61:-1]
    first, end = dates.index(targets[0]), dates.index(targets[-1])
    amount = [{'date': d, 'amountYuan': 1e12 + i * 1e8} for i, d in enumerate(dates[first - 20:end + 1])]
    margin = [{'date': d, 'balanceYuan': 2e12 + i * 1e8,
               'availableOn': S.next_session(d, dates)} for i, d in enumerate(dates[first - 30:end + 1])]
    funds = [{'code': c, 'label': c, 'series': [{'date': d, 'shares': 10_000_000_000 + i * 100_000,
                                               'availableOn': S.next_session(d, dates)}
                                              for i, d in enumerate(dates[first - 6:end + 1])]} for c in S.FUNDS]
    p = {'schemaVersion': 1, 'scope': '沪深A股', 'updatedAt': dates[-1] + 'T12:00:00+08:00',
         'calendar': dates, 'source': 'actual sources', 'methodology': 'lagged',
         'amountHistory': {'series': amount}, 'margin': {'series': margin}, 'etf': {'funds': funds}}
    quality = {'series': [{'date': r['date'], 'totalAmountYuan': r['amountYuan']} for r in amount[-60:]]}
    return p, quality, targets


class SupportTests(unittest.TestCase):
    def test_complete_real_warmup_window(self):
        p, _, targets = fixture()
        self.assertIs(S.validate_payload(p, targets), p)
        self.assertEqual(len(p['amountHistory']['series']), 80)
        self.assertEqual(len(p['margin']['series']), 90)
        self.assertEqual(len(p['etf']['funds'][0]['series']), 66)

    def test_amount_warmup_requires_actual_twenty_prior_sessions(self):
        p, _, targets = fixture()
        p['amountHistory']['series'][0]['date'] = p['calendar'][0]
        with self.assertRaisesRegex(ValueError, 'twenty-day'):
            S.validate_payload(p, targets)

    def test_incremental_reuses_all_published_totals_without_scan(self):
        p, q, _ = fixture()
        required = [r['date'] for r in p['amountHistory']['series']]
        with patch.object(S.Q, 'fetch_valuations', side_effect=AssertionError('unnecessary universe scan')), \
             patch.object(S.Q, 'fetch_amount_bars', side_effect=AssertionError('unnecessary full-market amount scan')):
            rows = S.warmup_amounts(required, q, p, '/nonexistent')
        self.assertEqual(rows, p['amountHistory']['series'])

    def test_last_sixty_amounts_preserve_quality_exactly(self):
        p, q, _ = fixture()
        q['series'][-1]['totalAmountYuan'] = 1_414_201_563_400
        required = [r['date'] for r in p['amountHistory']['series']]
        rows = S.warmup_amounts(required, q, p, '/nonexistent')
        self.assertEqual(rows[-1]['amountYuan'], 1_414_201_563_400)

    def test_margin_requires_both_exchanges_and_pure_financing(self):
        p, _, _ = fixture()
        required = [r['date'] for r in p['margin']['series']]
        seen = []
        def get(url):
            market = '007' if '007' in url else '001'
            seen.append(market)
            return {'success': True, 'result': {'data': [
                {'DIM_DATE': d, 'SCDM': market, 'RZYE': 1e12 if market == '007' else 1.1e12,
                 'RQYE': 1e10, 'RZRQYE': 1.01e12 if market == '007' else 1.11e12}
                for d in required]}}
        with patch.object(S.Q, 'get_json', side_effect=get):
            result = S.fetch_margin(required, p['calendar'])
        self.assertEqual(sorted(seen), ['001', '007'])
        self.assertEqual(result[-1]['balanceYuan'], 2.1e12)
        self.assertEqual(result[-1]['combinedBalanceYuan'], 2.12e12)
        self.assertGreater(result[-1]['availableOn'], result[-1]['date'])

    def test_margin_rejects_wrong_market_and_inconsistent_sum(self):
        dates = sessions(90)
        raw = [{'DIM_DATE': d, 'SCDM': '007', 'RZYE': 1e12, 'RQYE': 1e10, 'RZRQYE': 1.01e12} for d in dates]
        with self.assertRaisesRegex(ValueError, 'market'):
            S.parse_margin({'success': True, 'result': {'data': raw}}, '001')
        raw[-1]['RZRQYE'] = 9e12
        with self.assertRaisesRegex(ValueError, 'components'):
            S.parse_margin({'success': True, 'result': {'data': raw}}, '007')

    def test_etf_available_next_real_session_across_weekend(self):
        dates = ['2026-07-09', '2026-07-10', '2026-07-13']
        self.assertEqual(S.next_session('2026-07-10', dates), '2026-07-13')

    def test_etf_merges_core_without_network_or_fake_zero(self):
        p, _, _ = fixture()
        required = [r['date'] for r in p['etf']['funds'][0]['series']]
        with patch.object(S.E, 'fetch_shares', side_effect=AssertionError('unnecessary ETF history query')):
            result = S.etf_history(required, p['calendar'], p['etf'], None)
        self.assertEqual([r['shares'] for r in result[0]['series']],
                         [r['shares'] for r in p['etf']['funds'][0]['series']])
        self.assertEqual(len(result), 3)

    def test_etf_fetches_only_missing_dates_and_all_products(self):
        p, _, _ = fixture()
        required = [r['date'] for r in p['etf']['funds'][0]['series']]
        core = {'funds': [{**f, 'series': f['series'][4:]} for f in p['etf']['funds']]}
        expected = {d: {f['code']: next(r for r in f['series'] if r['date'] == d) for f in p['etf']['funds']}
                    for d in required[:4]}
        calls = []
        def fetch(d):
            calls.append(d)
            return expected[d]
        with patch.object(S.E, 'fetch_shares', side_effect=fetch):
            result = S.etf_history(required, p['calendar'], core, None)
        self.assertEqual(sorted(calls), required[:4])
        self.assertEqual(len(result[0]['series']), 66)

    def test_numeric_validation_rejects_boolean_nan_and_future_availability(self):
        for v in [True, float('nan'), float('inf'), 0, -1]:
            with self.assertRaises(ValueError):
                S.number(v)
        with self.assertRaisesRegex(ValueError, 'availability'):
            S.validate_rows([{'date': '2026-07-10', 'shares': 100, 'availableOn': '2026-07-10'}], 'shares')

    def test_source_failure_preserves_existing_artifact(self):
        p, q, targets = fixture()
        now = dt.datetime.fromisoformat(p['updatedAt'])
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            output = td / 'support.json'
            output.write_text(json.dumps(p))
            (td / 'market_quality.json').write_text(json.dumps(q))
            (td / 'etf_shares.json').write_text(json.dumps(p['etf']))
            original = output.read_bytes()
            with patch.object(S.Q, 'validate_payload', side_effect=lambda x: x), \
                 patch.object(S, 'calendar', return_value=(p['calendar'], p['calendar'][:-1])), \
                 patch.object(S, 'fetch_margin', side_effect=RuntimeError('source unreachable')):
                with self.assertRaisesRegex(RuntimeError, 'unreachable'):
                    S.refresh(td, td, output, now=now)
            self.assertEqual(output.read_bytes(), original)

    def test_stale_quality_fails_before_any_network_or_write(self):
        p, q, _ = fixture()
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            (td / 'market_quality.json').write_text(json.dumps(q))
            (td / 'etf_shares.json').write_text(json.dumps(p['etf']))
            output = td / 'support.json'
            output.write_text('previous artifact')
            with patch.object(S.Q, 'validate_payload', side_effect=lambda x: x), \
                 patch.object(S, 'calendar', return_value=(sessions(151), sessions(151))), \
                 patch.object(S, 'warmup_amounts', side_effect=AssertionError('should not start scan')):
                with self.assertRaisesRegex(ValueError, 'stale'):
                    S.refresh(td, td, output, now=dt.datetime.fromisoformat(p['updatedAt']))
            self.assertEqual(output.read_text(), 'previous artifact')

    def test_next_session_postclose_keeps_exact_previous_core_dates(self):
        p, q, targets = fixture()
        now = dt.datetime.fromisoformat(p['calendar'][-1] + 'T15:20:00+08:00')
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            output = td / 'support.json'
            output.write_text(json.dumps(p))
            (td / 'market_quality.json').write_text(json.dumps(q))
            (td / 'etf_shares.json').write_text(json.dumps(p['etf']))
            def margin(required, dates, optional_latest=None):
                # Source D is already closed, but its margin report is not
                # needed for the core's latest D-1 closing score.
                self.assertEqual(required[-1], p['calendar'][-3])
                return [{'date': d, 'balanceYuan': 2e12, 'availableOn': S.next_session(d, dates)}
                        for d in required]
            with patch.object(S.Q, 'validate_payload', side_effect=lambda x: x), \
                 patch.object(S, 'calendar', return_value=(p['calendar'], p['calendar'])), \
                 patch.object(S, 'fetch_margin', side_effect=margin), \
                 patch.object(S.E, 'fetch_shares', side_effect=AssertionError('must reuse disclosed shares')):
                result = S.refresh(td, td, output, now=now)
            self.assertEqual(result['amountHistory']['series'][-1]['date'], targets[-1])
            self.assertEqual(len(result['amountHistory']['series']), 80)

    def test_unpublished_current_margin_and_etf_are_not_required(self):
        p, q, targets = fixture()
        # The core ETF product still ends on D-1 while stock history closes D.
        core = {'funds': [{**f, 'series': f['series'][:-1]} for f in p['etf']['funds']]}
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            output = td / 'support.json'
            output.write_text(json.dumps(p))
            (td / 'market_quality.json').write_text(json.dumps(q))
            (td / 'etf_shares.json').write_text(json.dumps(core))
            def margin(required, dates, optional_latest=None):
                self.assertEqual(optional_latest, targets[-1])
                self.assertLess(required[-1], targets[-1])
                return [{'date': d, 'balanceYuan': 2e12, 'availableOn': S.next_session(d, dates)} for d in required]
            with patch.object(S.Q, 'validate_payload', side_effect=lambda x: x), \
                 patch.object(S, 'calendar', return_value=(p['calendar'], p['calendar'][:-1])), \
                 patch.object(S, 'fetch_margin', side_effect=margin), \
                 patch.object(S.E, 'fetch_shares', side_effect=AssertionError('unpublished date must not be queried')):
                result = S.refresh(td, td, output, now=dt.datetime.fromisoformat(p['updatedAt']))
            self.assertEqual(len(result['margin']['series']), 90)
            self.assertEqual(len(result['etf']['funds'][0]['series']), 65)
            self.assertLess(result['etf']['funds'][0]['series'][-1]['date'], targets[-1])


if __name__ == '__main__':
    unittest.main()
