import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / '.github/scripts/refresh_market_quality_close.py'
spec = importlib.util.spec_from_file_location('quality_close', SCRIPT)
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)
NOW = dt.datetime(2026, 10, 15, 15, 5, tzinfo=q.TZ)


def quote(stamp=None, **changes):
    result = {'price': 11, 'previous': 10, 'volume': 100, 'amountYuan': 1000000,
              'returnPct': 10, 'stamp': stamp or NOW.replace(minute=0)}
    result.update(changes)
    return result


def fixture(count=4001):
    stocks = [{'code': f'sh60{i:04}', 'name': str(i), 'lastDate': '2026-10-14', 'close': 10}
              for i in range(count)]
    baseline = {'schemaVersion': 1, 'scope': '沪深A股', 'asOfDate': '2026-10-14', 'stocks': stocks}
    quotes = {s['code']: quote() for s in stocks}
    return baseline, quotes


def history():
    days, day = [], dt.date(2026, 10, 14)
    while len(days) < 60:
        if day.weekday() < 5:
            days.append(day.isoformat())
        day -= dt.timedelta(days=1)
    top = [{'code': f'sh600{i:03}', 'name': str(i), 'amountYuan': 1000000} for i in range(20)]
    rows = [{'date': day, 'asOf': '15:00', 'status': 'close', 'universeCount': 4001,
             'eligibleCount': 4001, 'medianReturnPct': 0, 'q25ReturnPct': -1,
             'q75ReturnPct': 1, 'totalAmountYuan': 1000000000,
             'top20AmountYuan': 20000000, 'top20SharePct': 2,
             'top20Count': 20, 'top20': copy.deepcopy(top)} for day in reversed(days)]
    return {'schemaVersion': 1, 'scope': '沪深A股', 'updatedAt': '2026-10-14T20:00:00+08:00',
            'source': 'official', 'methodology': 'official method', 'series': rows}


def raw_quote(code='sh600001', stamp='20261015150000', amount='123.45'):
    fields = [''] * 50
    for index, value in {2: code[2:], 3: '11', 4: '10', 6: '100', 30: stamp, 32: '10', 37: amount}.items():
        fields[index] = value
    return f'v_{code}="' + '~'.join(fields) + '";'


class QualityCloseTests(unittest.TestCase):
    def test_parser_converts_source_ten_thousand_yuan(self):
        rows = q.parse_quotes(raw_quote(), ['sh600001'])
        self.assertEqual(rows['sh600001']['amountYuan'], 1234500)
        self.assertEqual(rows['sh600001']['stamp'].hour, 15)

    def test_parser_rejects_missing_duplicate_wrong_identity_and_bad_stamp(self):
        for text in ('', raw_quote() + raw_quote(), raw_quote().replace('~600001~', '~600002~'),
                     raw_quote(stamp='20261015250000')):
            with self.subTest(text=text[:40]), self.assertRaises(ValueError):
                q.parse_quotes(text, ['sh600001'])

    def test_source_return_and_exact_amount_share(self):
        baseline, quotes = fixture()
        quotes['sh600000'] = quote(price=9, returnPct=-10, amountYuan=2000000)
        result = q.build_close_day(baseline, quotes, NOW)
        self.assertEqual(result['medianReturnPct'], 10)
        self.assertEqual(result['totalAmountYuan'], 4002000000)
        self.assertEqual(result['top20AmountYuan'], 21000000)
        self.assertAlmostEqual(result['top20SharePct'], 100 * 21 / 4002, places=6)
        self.assertTrue(result['provisional'])
        self.assertEqual(result['universeAsOf'], '2026-10-14')
        self.assertEqual((result['status'], result['asOf']), ('close', '15:00'))

    def test_zero_volume_and_amount_excluded_not_missing_or_old_quotes(self):
        baseline, quotes = fixture()
        quotes['sh600000'] = quote(volume=0, amountYuan=0, stamp=NOW.replace(hour=9, minute=25))
        self.assertEqual(q.build_close_day(baseline, quotes, NOW)['eligibleCount'], 4000)
        quotes['sh600000']['stamp'] -= dt.timedelta(days=1)
        with self.assertRaisesRegex(ValueError, 'current day'):
            q.build_close_day(baseline, quotes, NOW)
        del quotes['sh600000']
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            q.build_close_day(baseline, quotes, NOW)

    def test_stale_intraday_and_future_quotes_cannot_be_closing_data(self):
        baseline, quotes = fixture()
        for stamp in (NOW.replace(hour=14, minute=59), NOW + dt.timedelta(seconds=1),
                      NOW - dt.timedelta(days=1)):
            quotes['sh600000'] = quote(stamp=stamp)
            with self.subTest(stamp=stamp), self.assertRaises(ValueError):
                q.build_close_day(baseline, quotes, NOW)
        quotes['sh600000'] = quote(stamp=NOW.replace(minute=1))
        self.assertEqual(q.build_close_day(baseline, quotes, NOW)['eligibleCount'], 4001)

    def test_bad_return_and_inconsistent_volume_amount_rejected(self):
        baseline, quotes = fixture()
        for changes in ({'returnPct': 9.9}, {'volume': 0}, {'amountYuan': 0}, {'amountYuan': -1},
                        {'previous': 0}, {'returnPct': float('nan')}):
            quotes['sh600000'] = quote(**changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                q.build_close_day(baseline, quotes, NOW)

    def test_roster_max_20_calendar_days_allows_long_holiday(self):
        baseline, _ = fixture()
        for age in (0, 12, 20):
            day = (NOW.date() - dt.timedelta(days=age)).isoformat()
            baseline['asOfDate'] = day
            for stock in baseline['stocks']:
                stock['lastDate'] = day
            self.assertIs(q.validate_baseline(baseline, NOW), baseline)
        baseline['asOfDate'] = (NOW.date() - dt.timedelta(days=21)).isoformat()
        with self.assertRaisesRegex(ValueError, 'stale'):
            q.validate_baseline(baseline, NOW)

    def test_roster_rejects_wrong_scope_duplicate_and_non_ashare(self):
        for mode in ('scope', 'duplicate', 'bshare'):
            baseline, _ = fixture()
            if mode == 'scope':
                baseline['scope'] = '沪深京A股'
            else:
                baseline['stocks'][0]['code'] = baseline['stocks'][1]['code'] if mode == 'duplicate' else 'sh900901'
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                q.validate_baseline(baseline, NOW)

    def test_both_indices_confirm_close_holiday_does_not(self):
        indices = {code: quote() for code in q.INDICES}
        self.assertTrue(q.market_closed(indices, NOW))
        with self.assertRaises(ValueError):
            q.market_closed({code:quote(volume=0,amountYuan=0) for code in q.INDICES},NOW)
        indices['sh000001']['stamp'] -= dt.timedelta(days=1)
        self.assertFalse(q.market_closed(indices, NOW))
        indices['sh000001'] = quote(stamp=NOW.replace(hour=14, minute=59))
        with self.assertRaisesRegex(ValueError, '15:00'):
            q.market_closed(indices, NOW)
        del indices['sh000001']
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            q.market_closed(indices, NOW)

    def test_collect_complete_bounded_batches_and_failed_batch_raises(self):
        codes = [f'sh60{i:04}' for i in range(161)]
        seen = []
        def fake(batch):
            seen.append(len(batch))
            return {code: quote() for code in batch}
        with mock.patch.object(q, 'fetch_quotes', side_effect=fake):
            self.assertEqual(set(q.collect_quotes(codes, workers=12)), set(codes))
        self.assertEqual(sorted(seen), [1, 80, 80])
        with mock.patch.object(q, 'fetch_quotes', side_effect=RuntimeError('offline')):
            with self.assertRaisesRegex(RuntimeError, 'offline'):
                q.collect_quotes(codes)

    def test_refresh_1500_preserves_59_days_and_writes_only_separate_artifact(self):
        baseline, quotes = fixture()
        just_closed = NOW.replace(minute=0)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            base, official, out = root / 'baseline.json', root / 'official.json', root / 'close.json'
            base.write_text(json.dumps(baseline))
            official.write_text(json.dumps(history()))
            before = (base.read_bytes(), official.read_bytes())
            with mock.patch.object(q, 'fetch_quotes', return_value={c: quote() for c in q.INDICES}), \
                    mock.patch.object(q, 'collect_quotes', return_value=quotes):
                result = q.refresh(out, base, official, now=just_closed)
            self.assertEqual(len(result['series']), 60)
            self.assertEqual(result['series'][:-1], history()['series'][1:])
            self.assertEqual(result['series'][-1]['date'], '2026-10-15')
            self.assertEqual(json.loads(out.read_text()), result)
            self.assertEqual(before, (base.read_bytes(), official.read_bytes()))
            q.validate_close_payload(result, just_closed)

    def test_failed_partial_scan_retains_previous_valid_file(self):
        baseline, quotes = fixture()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            base, official, out = root / 'baseline.json', root / 'official.json', root / 'close.json'
            base.write_text(json.dumps(baseline))
            official.write_text(json.dumps(history()))
            out.write_text(json.dumps(history()))
            before = out.read_bytes()
            del quotes['sh600000']
            with mock.patch.object(q, 'fetch_quotes', return_value={c: quote() for c in q.INDICES}), \
                    mock.patch.object(q, 'collect_quotes', return_value=quotes):
                with self.assertRaisesRegex(ValueError, 'Incomplete'):
                    q.refresh(out, base, official, now=NOW)
            self.assertEqual(before, out.read_bytes())

    def test_before_close_and_weekend_skip_without_fetching(self):
        with mock.patch.object(q, 'fetch_quotes') as fetch:
            for now in (NOW.replace(hour=14, minute=59), NOW + dt.timedelta(days=2)):
                self.assertIsNone(q.refresh('no-output', 'no-baseline', 'no-history', now=now))
            fetch.assert_not_called()

    def test_calibrated_today_skips_snapshot(self):
        data = history()
        data['series'][-1]['date'] = '2026-10-15'
        data['updatedAt'] = '2026-10-15T20:00:00+08:00'
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'official.json'
            path.write_text(json.dumps(data))
            with mock.patch.object(q, 'fetch_quotes') as fetch:
                self.assertIsNone(q.refresh(Path(temp) / 'out.json', 'unused', path, now=NOW.replace(hour=20)))
                fetch.assert_not_called()

    def test_workflow_fast_job_has_separate_concurrency_and_no_slow_dependency(self):
        workflow = (SCRIPT.parent.parent / 'workflows/refresh-market-quality.yml').read_text()
        self.assertIn("cron: '5,15,25 7 * * 1-5'", workflow)
        self.assertIn('group: refresh-market-quality-close', workflow)
        self.assertIn('group: refresh-market-quality\n', workflow)
        self.assertNotIn('needs:', workflow)


if __name__ == '__main__':
    unittest.main()
