import copy
from contextlib import redirect_stdout
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('hl52_shards', ROOT / '.github/scripts/refresh_high_low_52w.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
REAL_DATETIME = dt.datetime
NOW = REAL_DATETIME(2026, 10, 28, 12, 0, tzinfo=m.TZ)
LATEST = '2026-10-27'


class FixedDateTime(REAL_DATETIME):
    @classmethod
    def now(cls, tz=None):
        return NOW if tz is not None else NOW.replace(tzinfo=None)


def sessions(count=60, end=LATEST):
    result, day = [], dt.date.fromisoformat(end)
    while len(result) < count:
        if day.weekday() < 5:
            result.append(day.isoformat())
        day -= dt.timedelta(days=1)
    return list(reversed(result))


def codes(count=8):
    return [f'sh{600000 + i}' for i in range(count)]


def seal(plan):
    plan = copy.deepcopy(plan)
    plan.pop('planId', None)
    plan['planId'] = m.canonical_hash(plan)
    return plan


def plan_fixture(count=8, shard_count=6):
    dates, symbols = sessions(), codes(count)
    return seal({'schemaVersion': 1, 'kind': 'high-low-52w-plan',
                 'createdAt': (NOW - dt.timedelta(minutes=5)).isoformat(),
                 'dates': dates, 'latest': dates[-1], 'skip': False,
                 'shardCount': shard_count, 'universes': {date: symbols[:] for date in dates},
                 'symbols': symbols})


def simple_bars():
    return [{'date': '2025-01-02', 'close': 7, 'high': 10, 'low': 5, 'volume': 10},
            {'date': LATEST, 'close': 8, 'high': 11, 'low': 6, 'volume': 12}]


def long_bars(direction=1):
    rows = []
    for i, date in enumerate(sessions(480)):
        price = 20 + direction * i / 100
        rows.append({'date': date, 'close': price, 'high': price + .5,
                     'low': price - .5, 'volume': 10})
    return rows


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def output_paths(root):
    return {name: root / (name + '.json') for name in ('OUTPUT', 'BASELINE', 'MA_OUTPUT', 'MA_BASELINE')}


class ShardTests(unittest.TestCase):
    def setUp(self):
        m._REFRESH_DEADLINE = None
        m._DAILY_SOURCE_HEALTH.clear()
        # Frozen historical plans must never inspect the repository's advancing
        # published snapshots. Otherwise the production no-regression guard
        # correctly rejects this test's old plan and stops every scheduled run.
        fixture_dir = tempfile.TemporaryDirectory()
        self.addCleanup(fixture_dir.cleanup)
        self.fixture_root = Path(fixture_dir.name)
        fixture_paths = output_paths(self.fixture_root / 'outputs')
        fixture_paths.update(QUALITY_OUTPUT=self.fixture_root / 'quality.json',
                             QUALITY_BASELINE=self.fixture_root / 'quality-baseline.json')
        self.path_patch = patch.multiple(m, **fixture_paths)
        self.path_patch.start()
        self.addCleanup(self.path_patch.stop)
        self.time_patch = patch.object(m.dt, 'datetime', FixedDateTime)
        self.time_patch.start()
        self.addCleanup(self.time_patch.stop)
        self.output = io.StringIO()
        quiet = redirect_stdout(self.output)
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    def populated_parts(self, root, plan=None, bars_by_code=None):
        plan = plan or plan_fixture()
        plan_path, parts, cache = root / 'plan.json', root / 'parts', root / 'cache'
        write_json(plan_path, plan)
        def fetch(code):
            self.assertNotEqual(code, 'sh000001', 'collect phase must not refetch the calendar')
            return copy.deepcopy(bars_by_code[code] if bars_by_code else simple_bars())
        with patch.object(m, 'MIN_UNIVERSE', 2), patch.object(m, 'fetch_bars', side_effect=fetch), \
                patch.object(m, 'load_completed_calendar', side_effect=AssertionError('calendar refetched')):
            for index in range(plan['shardCount']):
                m.collect_shard(plan_path, parts, cache, index, plan['shardCount'], workers=1)
        return plan_path, parts, cache

    def test_production_floor_is_4000_and_real_size_plan_validates(self):
        self.assertEqual(m.MIN_UNIVERSE, 4000)
        plan = plan_fixture(4000)
        self.assertIs(m.validate_plan(plan, NOW), plan)
        parts = [plan['symbols'][i::6] for i in range(6)]
        self.assertTrue(all(600 <= len(part) < 900 for part in parts))
        self.assertEqual(sorted(code for part in parts for code in part), plan['symbols'])
        self.assertEqual(sum(map(len, parts)), len(set().union(*map(set, parts))))
        small = plan_fixture(3999)
        with self.assertRaisesRegex(ValueError, 'incomplete plan universe'):
            m.validate_plan(small, NOW)

    def test_plan_rejects_future_uncompleted_duplicate_and_unordered_sessions(self):
        cases = []
        for date in ('2026-10-28', '2099-01-01'):
            p = plan_fixture(); p['dates'][-1] = date; p['latest'] = date; cases.append(seal(p))
        p = plan_fixture(); p['dates'][-1] = p['dates'][-2]; p['latest'] = p['dates'][-1]; cases.append(seal(p))
        p = plan_fixture(); p['dates'][0], p['dates'][1] = p['dates'][1], p['dates'][0]; cases.append(seal(p))
        p = plan_fixture(); p['dates'].pop(0); cases.append(seal(p))
        with patch.object(m, 'MIN_UNIVERSE', 2):
            for p in cases:
                with self.subTest(last=p['latest']), self.assertRaises(ValueError):
                    m.validate_plan(p, NOW)

    def test_plan_rejects_missing_or_duplicate_members_and_wrong_exact_union(self):
        mutations = [lambda p: p['universes'].pop(p['dates'][0]),
                     lambda p: p['universes'][p['dates'][0]].append(p['symbols'][0]),
                     lambda p: p['universes'][p['dates'][0]].reverse(),
                     lambda p: p['universes'][p['dates'][0]].__setitem__(0, 'bj920001'),
                     lambda p: p['symbols'].pop(),
                     lambda p: p['symbols'].append('sz000001')]
        with patch.object(m, 'MIN_UNIVERSE', 2):
            for mutate in mutations:
                p = plan_fixture(); mutate(p)
                with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                    m.validate_plan(seal(p), NOW)

    def test_plan_hash_scope_target_and_age_are_checked(self):
        with patch.object(m, 'MIN_UNIVERSE', 2):
            p = plan_fixture(); p['latest'] = '2026-10-26'
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                m.validate_plan(p, NOW)
            p = seal(p)
            with self.assertRaisesRegex(ValueError, 'exact 60'):
                m.validate_plan(p, NOW)
            for age in (dt.timedelta(hours=37), -dt.timedelta(minutes=1)):
                p = plan_fixture(); p['createdAt'] = (NOW - age).isoformat()
                with self.assertRaisesRegex(ValueError, 'stale or future'):
                    m.validate_plan(seal(p), NOW)
            for value in (True, 0, 65):
                p = plan_fixture(); p['shardCount'] = value
                with self.assertRaisesRegex(ValueError, 'sharding'):
                    m.validate_plan(seal(p), NOW)

    def test_skip_plan_contains_no_hidden_collection_work(self):
        p = plan_fixture(); p.update(skip=True, universes={}, symbols=[]); p = seal(p)
        self.assertIs(m.validate_plan(p, NOW), p)
        bad = copy.deepcopy(p); bad['symbols'] = ['sh600000']
        with self.assertRaisesRegex(ValueError, 'skipped plan'):
            m.validate_plan(seal(bad), NOW)

    def test_collect_uses_fixed_disjoint_assignments_and_never_refetches_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); p = plan_fixture(); plan_path = root / 'plan.json'; write_json(plan_path, p)
            seen = []
            with patch.object(m, 'MIN_UNIVERSE', 2), \
                    patch.object(m, 'fetch_bars', side_effect=lambda code: seen.append(code) or simple_bars()), \
                    patch.object(m, 'load_completed_calendar', side_effect=AssertionError('must use shared plan')):
                for index in range(6):
                    manifest = m.collect_shard(plan_path, root / 'parts', root / 'cache', index, 6, workers=1)
                    self.assertEqual(manifest['expectedCodes'], p['symbols'][index::6])
                    self.assertEqual(manifest['codes'], manifest['expectedCodes'])
                    self.assertTrue(manifest['complete'])
                    self.assertEqual(set(manifest['fileHashes']), set(manifest['codes']))
            self.assertEqual(sorted(seen), p['symbols'])
            self.assertEqual(len(seen), len(set(seen)))
            self.assertNotIn('sh000001', seen)
            with patch.object(m, 'MIN_UNIVERSE', 2), self.assertRaisesRegex(ValueError, 'index/count'):
                m.collect_shard(plan_path, root / 'parts', root / 'cache', 6, 6)

    def test_failed_shard_exports_good_cache_but_is_not_publishable_and_can_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); p = plan_fixture(); plan_path = root / 'plan.json'; write_json(plan_path, p)
            assigned = p['symbols'][0::6]; counts = dict.fromkeys(assigned, 0); unavailable = [True]
            def fetch(code):
                counts[code] += 1
                if code == assigned[-1] and unavailable[0]:
                    raise RuntimeError('temporary provider outage')
                return simple_bars()
            with patch.object(m, 'MIN_UNIVERSE', 2), patch.object(m, 'fetch_bars', side_effect=fetch), patch.object(m.time, 'sleep'):
                with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                    m.collect_shard(plan_path, root / 'parts', root / 'cache', 0, 6, workers=1)
                partial = m.read_json(root / 'parts/manifest-0.json')
                self.assertFalse(partial['complete']); self.assertEqual(partial['codes'], assigned[:1])
                self.assertTrue((root / 'cache' / LATEST / (assigned[0] + '.json')).exists())
                self.assertTrue((root / 'parts/prices' / (assigned[0] + '.json')).exists())
                unavailable[0] = False
                complete = m.collect_shard(plan_path, root / 'parts', root / 'cache', 0, 6, workers=1)
                self.assertTrue(complete['complete']); self.assertEqual(complete['codes'], assigned)
            self.assertEqual(counts[assigned[0]], 1, 'successful whole history is not downloaded again')
            self.assertEqual(counts[assigned[-1]], 4, 'three bounded failures plus one successful resume')

    def test_complete_aggregate_passes_exact_shared_plan_and_prices_to_original_math(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); plan_path, parts, _ = self.populated_parts(root)
            with patch.object(m, 'MIN_UNIVERSE', 2), patch.object(m, 'publish_snapshots') as publish:
                m.publish_plan(plan_path, parts)
            dates, universes, prices, now = publish.call_args.args
            p = m.read_json(plan_path)
            self.assertEqual(dates, p['dates']); self.assertEqual(universes, p['universes'])
            self.assertEqual(set(prices), set(p['symbols'])); self.assertEqual(now, NOW)
            self.assertTrue(all(rows == simple_bars() for rows in prices.values()))

    def test_frozen_fixture_never_reads_advancing_repository_snapshots(self):
        for name in ('OUTPUT', 'BASELINE', 'MA_OUTPUT', 'MA_BASELINE', 'QUALITY_OUTPUT', 'QUALITY_BASELINE'):
            self.assertTrue(getattr(m, name).is_relative_to(self.fixture_root), name)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # A future published snapshot outside the fixture output directory
            # is deliberately irrelevant to this fixed-date mathematical test.
            write_json(root / 'live-data' / 'market_high_low_52w.json',
                       {'series': [{'date': '2030-12-31'}]})
            plan_path, parts, _ = self.populated_parts(root)
            with patch.object(m, 'MIN_UNIVERSE', 2), patch.object(m, 'publish_snapshots') as publish, \
                    patch.object(m, 'read_json', wraps=m.read_json) as read:
                m.publish_plan(plan_path, parts)
            publish.assert_called_once()
            self.assertTrue(all(not Path(call.args[0]).is_relative_to(ROOT / 'data')
                                for call in read.call_args_list))

    def test_partial_mixed_corrupt_or_extra_shards_preserve_every_existing_output(self):
        def manifest(parts, index=0):
            return m.read_json(parts / f'manifest-{index}.json')
        def change_manifest(parts, field, value):
            value_dict = manifest(parts); value_dict[field] = value; write_json(parts / 'manifest-0.json', value_dict)
        changes = [lambda p: (p / 'manifest-0.json').unlink(),
                   lambda p: change_manifest(p, 'complete', False),
                   lambda p: change_manifest(p, 'planId', 'another-plan'),
                   lambda p: change_manifest(p, 'latest', '2026-10-26'),
                   lambda p: change_manifest(p, 'shardIndex', 1),
                   lambda p: change_manifest(p, 'shardCount', 5),
                   lambda p: change_manifest(p, 'expectedCodes', ['sz000001']),
                   lambda p: change_manifest(p, 'codes', ['sz000001']),
                   lambda p: change_manifest(p, 'fileHashes', {}),
                   lambda p: (p / 'manifest-0.json').write_text('{broken'),
                   lambda p: (p / 'prices/sh600000.json').write_text('{broken'),
                   lambda p: (p / 'prices/sh600000.json').unlink(),
                   lambda p: write_json(p / 'prices/sz000001.json', {'extra': True})]
        for index, mutate in enumerate(changes):
            with self.subTest(case=index), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); plan_path, parts, _ = self.populated_parts(root); mutate(parts)
                paths = output_paths(root)
                for output in paths.values(): output.write_text('original verified snapshot')
                with patch.multiple(m, **paths), patch.object(m, 'MIN_UNIVERSE', 2), patch.object(m, 'publish_snapshots') as publish:
                    with self.assertRaises((ValueError, RuntimeError, TypeError)):
                        m.publish_plan(plan_path, parts)
                publish.assert_not_called()
                self.assertTrue(all(output.read_text() == 'original verified snapshot' for output in paths.values()))

    def test_price_record_code_target_and_content_hash_are_verified(self):
        for field, value in [('code', 'sz000001'), ('asOfDate', '2026-10-26'), ('bars', [{'invalid': True}])]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); plan_path, parts, _ = self.populated_parts(root)
                record_path = parts / 'prices/sh600000.json'; record = m.read_json(record_path)
                record[field] = value; write_json(record_path, record)
                with patch.object(m, 'MIN_UNIVERSE', 2), patch.object(m, 'publish_snapshots') as publish:
                    with self.assertRaisesRegex(ValueError, 'corrupted shard price'):
                        m.publish_plan(plan_path, parts)
                publish.assert_not_called()

    def test_complete_shard_merge_matches_unchanged_full_history_mathematics(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); plan = plan_fixture(count=4, shard_count=2)
            prices = {code: long_bars(1 if i % 2 else -1) for i, code in enumerate(plan['symbols'])}
            with patch.object(m, 'MIN_UNIVERSE', 2):
                expected_high_low = m.build_series(plan['dates'], plan['universes'], prices)
                expected_ma = m.build_ma_series(plan['dates'], plan['universes'], prices)
            plan_path, parts, _ = self.populated_parts(root, plan, prices)
            paths = output_paths(root)
            with patch.multiple(m, **paths), patch.object(m, 'MIN_UNIVERSE', 2):
                m.publish_plan(plan_path, parts)
            self.assertEqual(m.read_json(paths['OUTPUT'])['series'], expected_high_low)
            self.assertEqual(m.read_json(paths['MA_OUTPUT'])['series'], expected_ma)
            self.assertEqual(m.read_json(paths['BASELINE'])['asOfDate'], LATEST)
            self.assertEqual(m.read_json(paths['MA_BASELINE'])['asOfDate'], LATEST)
            self.assertEqual(len(m.read_json(paths['BASELINE'])['stocks']), 4)
            self.assertEqual(len(m.read_json(paths['MA_BASELINE'])['stocks']), 4)

    def test_plan_cannot_regress_a_newer_verified_output_date(self):
        for name in ('OUTPUT', 'BASELINE', 'MA_OUTPUT', 'MA_BASELINE'):
            with self.subTest(output=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); p = plan_fixture(); plan_path = root / 'plan.json'; write_json(plan_path, p)
                paths = output_paths(root)
                payload = ({'asOfDate': '2030-12-31'} if 'BASELINE' in name
                           else {'series': [{'date': '2030-12-31'}]})
                write_json(paths[name], payload)
                before = paths[name].read_bytes()
                with patch.multiple(m, **paths), patch.object(m, 'MIN_UNIVERSE', 2):
                    with self.assertRaisesRegex(RuntimeError, 'date regression'):
                        m.publish_plan(plan_path, root / 'missing-parts')
                self.assertEqual(paths[name].read_bytes(), before)

    def test_verified_calendar_recovers_without_guessing_a_new_trading_day(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); observed = NOW - dt.timedelta(hours=16)
            with patch.object(m, 'fetch_bars', return_value=[{'date': date, 'volume': 1} for date in sessions(70)]):
                initial = m.load_completed_calendar(root, observed)
            self.assertEqual(initial[-1], LATEST)
            with patch.object(m, 'fetch_bars', side_effect=RuntimeError('index transport down')):
                restored = m.load_completed_calendar(root, NOW)
            self.assertEqual(restored, initial)
            self.assertNotIn('2026-10-28', restored)

    def test_calendar_fallback_rejects_stale_future_tampered_or_unverified_previous_close(self):
        variants = [('stale', NOW - dt.timedelta(hours=37), sessions()),
                    ('future', NOW + dt.timedelta(minutes=1), sessions()),
                    ('preopen-yesterday', REAL_DATETIME(2026, 10, 27, 8, tzinfo=m.TZ), sessions(end='2026-10-26')),
                    ('wrong-close', REAL_DATETIME(2026, 10, 27, 18, tzinfo=m.TZ), sessions(end='2026-10-26'))]
        for label, observed, dates in variants:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); payload = {'schemaVersion': 1, 'observedAt': observed.isoformat(), 'dates': dates}
                payload['calendarId'] = m.canonical_hash(payload); write_json(root / 'verified-index-calendar.json', payload)
                with patch.object(m, 'fetch_bars', side_effect=RuntimeError('transport down')):
                    with self.assertRaisesRegex(RuntimeError, 'no current verified fallback'):
                        m.load_completed_calendar(root, NOW)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); payload = {'schemaVersion': 1, 'observedAt': (NOW - dt.timedelta(hours=1)).isoformat(), 'dates': sessions(), 'calendarId': 'tampered'}
            write_json(root / 'verified-index-calendar.json', payload)
            with patch.object(m, 'fetch_bars', side_effect=RuntimeError('transport down')):
                with self.assertRaisesRegex(RuntimeError, 'hash mismatch'):
                    m.load_completed_calendar(root, NOW)

    def test_create_plan_uses_one_verified_calendar_and_one_shared_universe_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); dates = sessions(); universe = dict.fromkeys(codes(), 'name')
            with patch.object(m, 'MIN_UNIVERSE', 2), patch.object(m, 'select_completed_sessions', return_value=(dates, False)) as select, \
                    patch.object(m, 'load_universe', return_value=universe) as load:
                p = m.create_plan(root / 'plan.json', root / 'cache', workers=1, shard_count=6)
            select.assert_called_once(); self.assertEqual(load.call_count, 60)
            self.assertEqual(p['dates'], dates); self.assertEqual(p['symbols'], codes())
            self.assertEqual(p['planId'], m.canonical_hash({k: v for k, v in p.items() if k != 'planId'}))
            self.assertEqual(m.read_json(root / 'plan.json'), p)


if __name__ == '__main__':
    unittest.main()
