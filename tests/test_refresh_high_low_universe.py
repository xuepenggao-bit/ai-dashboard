import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('hl52_universe',ROOT/'.github/scripts/refresh_high_low_52w.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
NOW=dt.datetime(2026,10,22,10,tzinfo=m.TZ)
def symbols(n=5224):return {f'sh{600000+i}':str(i) for i in range(n)}
def ref(codes=None,exact=True):
    codes=set(symbols() if codes is None else codes)
    return {'date':'2026-10-21' if exact else '2026-10-20','codes':codes,'count':len(codes),'exact':exact}

class UniverseTests(unittest.TestCase):
    def test_same_day_partial_source_count_is_not_a_complete_roster(self):
        with self.assertRaisesRegex(ValueError,'439 missing'):
            m.validate_universe_scope('2026-10-21',symbols(4785),ref())
    def test_same_size_wrong_membership_is_rejected(self):
        data=symbols();data['sz000001']=data.pop('sh600000')
        with self.assertRaisesRegex(ValueError,'1 missing, 1 extra'):
            m.validate_universe_scope('2026-10-21',data,ref())
    def test_prior_day_reference_rejects_abrupt_scope_loss(self):
        with self.assertRaisesRegex(ValueError,'still incomplete'):
            m.validate_universe_scope('2026-10-21',symbols(4785),ref(exact=False))
        self.assertEqual(len(m.validate_universe_scope('2026-10-21',symbols(5225),ref(exact=False))),5225)
    def test_quality_reference_uses_real_universe_count_schema(self):
        baseline=json.loads((ROOT/'data/market_quality_baseline.json').read_text())
        actual=m.universe_reference(baseline['asOfDate'])
        self.assertTrue(actual['exact']);self.assertEqual(actual['count'],len(baseline['stocks']))
        self.assertEqual(actual['codes'],{s['code'] for s in baseline['stocks']})
    def test_recent_incomplete_cache_is_refetched_and_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache=Path(tmp);p=cache/'universe-2026-10-21.json';p.write_text(json.dumps(symbols(4785)))
            with patch.object(m,'universe_reference',return_value=ref()),patch.object(m,'fetch_universe',return_value=symbols()) as fetch:
                result=m.load_universe('2026-10-21',cache,now=NOW)
            fetch.assert_called_once();self.assertEqual(len(result),5224);self.assertEqual(len(json.loads(p.read_text())),5224)
    def test_partial_new_fetch_does_not_poison_existing_good_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache=Path(tmp);p=cache/'universe-2026-10-21.json';p.write_text(json.dumps(symbols()));before=p.read_bytes()
            with patch.object(m,'universe_reference',return_value=ref()),patch.object(m,'fetch_universe',return_value=symbols(4785)):
                with self.assertRaises(ValueError):m.load_universe('2026-10-21',cache,now=NOW)
            self.assertEqual(before,p.read_bytes())
    def test_older_valid_cache_is_reused_after_reference_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache=Path(tmp);p=cache/'universe-2026-10-09.json';p.write_text(json.dumps(symbols()))
            with patch.object(m,'universe_reference',return_value=ref()),patch.object(m,'fetch_universe') as fetch:
                self.assertEqual(len(m.load_universe('2026-10-09',cache,now=NOW)),5224)
            fetch.assert_not_called()
    def test_current_day_requires_an_independent_scope_reference(self):
        with patch.object(m,'universe_reference',return_value=None),patch.object(m,'fetch_universe',return_value=symbols()):
            with self.assertRaisesRegex(ValueError,'independent'):
                m.load_universe('2026-10-22',now=NOW)
    def test_same_day_partial_snapshot_cannot_short_circuit_even_if_structurally_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths={name:Path(tmp)/(name+'.json') for name in ('OUTPUT','BASELINE','MA_OUTPUT','MA_BASELINE')}
            codes=list(symbols(4785))
            content={'OUTPUT':{'series':[{'date':'2026-10-21','universe':4785}]*60},
                'BASELINE':{'asOfDate':'2026-10-21','validThrough':'2026-11-11','stocks':[{'code':c} for c in codes]},
                'MA_OUTPUT':{'series':[{'universe':4785}]},'MA_BASELINE':{'stocks':[{'code':c} for c in codes]}}
            for key,path in paths.items():path.write_text(json.dumps(content[key]))
            with patch.multiple(m,**paths),patch.object(m,'validate_ma_history'),patch.object(m,'validate_ma_baseline'),patch.object(m,'load_universe',return_value=symbols()) as load:
                self.assertFalse(m.complete_cached_snapshots('2026-10-21',NOW));load.assert_called_once()

if __name__=='__main__':unittest.main()
