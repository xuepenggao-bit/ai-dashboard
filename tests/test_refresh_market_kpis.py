import datetime as dt
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('market_kpis', ROOT / '.github/scripts/refresh_market_kpis.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = dt.datetime(2026, 11, 5, 12, 20, tzinfo=m.TZ)


def dates(count=60, end='2026-11-05'):
    day, result = dt.date.fromisoformat(end), []
    while len(result) < count:
        if day.weekday() < 5:
            result.append(day.isoformat())
        day -= dt.timedelta(days=1)
    return list(reversed(result))


def quotes(stamp='20261105120500'):
    result = []
    caps = dict(zip(m.CAP_CODES, [624229.42, 385926.15, 155030.62, 138649.30]))
    for code in (*m.CAP_CODES, *m.PE_CODES):
        fields = [''] * 81
        fields[2], fields[30], fields[39], fields[45] = code[2:], stamp, '35.97', str(caps.get(code, 100000))
        result.append('v_' + code + '="' + '~'.join(fields) + '";')
    return '\n'.join(result)


def hk_payload(stamp='2026/11/05 11:59:59'):
    qt = [''] * 40
    qt[2], qt[30] = 'HSI', stamp
    return {'code': 0, 'data': {'hkHSI': {'day': [[day, '24000', '24500', '25000', '23500', '198382851968'] for day in dates()], 'qt': {'hkHSI': qt}}}}


def margin_payload():
    return {'success': True, 'code': 0, 'result': {'data': [{'DIM_DATE': day + ' 00:00:00', 'RZRQYE': 2300444676501} for day in reversed(dates(end='2026-11-04'))]}}


def snapshot(now=NOW):
    q = m.parse_tencent(quotes(), now)
    return {'schemaVersion': 1, 'checkedAt': now.isoformat(),
            'caps': {'quotes': q['caps']}, 'pe': {'quotes': q['pe']},
            'hkAmount': {'series': m.parse_hk_amount(hk_payload(), now)},
            'margin': {'series': m.parse_margin(margin_payload(), now)}}


class MarketKpiTests(unittest.TestCase):
    def test_tencent_caps_use_exact_field_45_already_in_cny_yi(self):
        result = m.parse_tencent(quotes(), NOW)
        self.assertEqual(len(result['caps']), 4)
        self.assertEqual(result['caps'][0]['totalCapYi'], 624229.42)
        self.assertEqual(result['caps'][0]['code'], 'sh000002')
        self.assertEqual(result['caps'][0]['quoteTs'], int(dt.datetime(2026, 11, 5, 12, 5, tzinfo=m.TZ).timestamp() * 1000))

    def test_pe_uses_exact_four_index_identities_and_field_39(self):
        result = m.parse_tencent(quotes(), NOW)
        self.assertEqual({q['code'] for q in result['pe']}, set(m.PE_CODES))
        self.assertEqual(result['pe'][0]['secucode'], '000001.SH')
        self.assertEqual(result['pe'][0]['pe'], 35.97)

    def test_wrong_quote_identity_or_future_stamp_cannot_publish(self):
        self.assertFalse(m.parse_tencent(quotes('20261106120500'), NOW)['caps'])
        self.assertFalse(m.parse_tencent(quotes('20261106120500'), NOW)['pe'])
        self.assertFalse(m.parse_tencent(quotes().replace('000002~', '000003~', 1), NOW)['caps'])
        self.assertFalse(m.parse_tencent(quotes('20261001120500'), NOW)['caps'])

    def test_one_invalid_cap_does_not_make_a_mixed_partial_board_total(self):
        value = m.parse_tencent(quotes(), NOW)['caps']
        value[0]['totalCapYi'] = 10
        with self.assertRaises(ValueError):
            m.validate_caps(value, NOW)
        with self.assertRaises(ValueError):
            m.validate_caps(value[:3], NOW)

    def test_mixed_dates_and_overlapping_cap_decomposition_rejected(self):
        value = m.parse_tencent(quotes(), NOW)['caps']
        value[0]['quoteTs'] -= 86400000
        with self.assertRaises(ValueError):
            m.validate_caps(value, NOW)
        value = m.parse_tencent(quotes(), NOW)['caps']
        value[0]['totalCapYi'] = value[3]['totalCapYi']
        with self.assertRaises(ValueError):
            m.validate_caps(value, NOW)

    def test_invalid_pe_does_not_erase_other_pe_or_atomic_caps(self):
        text = quotes()
        first = text.index('v_sh000001=')
        text = text[:first] + text[first:].replace('~35.97~', '~-~', 1)
        value = m.parse_tencent(text, NOW)
        self.assertEqual(len(value['pe']), 3)
        self.assertEqual(len(value['caps']), 4)

    def test_numeric_placeholders_booleans_nan_and_infinity_rejected(self):
        for value in [None, '', ' ', '-', True, False, 'NaN', float('inf')]:
            with self.assertRaises((ValueError, TypeError)):
                m.number(value)

    def test_hk_amount_uses_day_field_5_hkd_to_yi_not_volume_or_field_7(self):
        payload = hk_payload()
        for row in payload['data']['hkHSI']['day']:
            row.extend([123456, 9999999999999])
        rows = m.parse_hk_amount(payload, NOW)
        self.assertEqual(len(rows), 60)
        self.assertAlmostEqual(rows[-1]['amountYi'], 1983.82851968)
        self.assertEqual(rows[-1]['date'], '2026-11-05')
        self.assertEqual(rows[-1]['status'], 'live')
        self.assertEqual(rows[-1]['asOf'], '11:59')
        self.assertEqual(rows[-2]['status'], 'close')
        self.assertNotIn('asOf', rows[-2])

    def test_hk_today_requires_matching_actual_source_quote_date(self):
        for malformed in (None, [], '', {'code': 1}):
            with self.assertRaises(ValueError):
                m.parse_hk_amount(malformed, NOW)
        for stamp in ['2026/11/04 16:10:00', '2026/11/05 13:00:00', '', 'not-time']:
            with self.assertRaises(ValueError):
                m.parse_hk_amount(hk_payload(stamp), NOW)
        bad = hk_payload(); bad['data']['hkHSI']['qt']['hkHSI'][2] = 'HSTECH'
        with self.assertRaises(ValueError):
            m.parse_hk_amount(bad, NOW)

    def test_hk_zeros_duplicate_dates_and_future_days_rejected(self):
        for mutate in [lambda p: p['data']['hkHSI']['day'][-1].__setitem__(5, '0'),
                       lambda p: p['data']['hkHSI']['day'][-1].__setitem__(0, '2026-11-04'),
                       lambda p: p['data']['hkHSI']['day'][-1].__setitem__(0, '2026-11-06')]:
            payload = hk_payload(); mutate(payload)
            with self.assertRaises(ValueError):
                m.parse_hk_amount(payload, NOW)

    def test_margin_balance_is_exact_rzrqye_yuan_not_rzye_or_guessed_unit(self):
        payload = margin_payload()
        for row in payload['result']['data']:
            row['RZYE'] = 50000
        result = m.parse_margin(payload, NOW)
        self.assertEqual(len(result), 60)
        self.assertAlmostEqual(result[-1]['balanceYi'], 23004.44676501)
        self.assertEqual(result[-1]['date'], '2026-11-04')
        self.assertLess(result[0]['date'], result[-1]['date'])

    def test_margin_zero_unit_switch_duplicate_and_future_date_rejected(self):
        for value in [0, True, '-', 23004, float('nan')]:
            p = margin_payload(); p['result']['data'][0]['RZRQYE'] = value
            with self.assertRaises(ValueError):
                m.parse_margin(p, NOW)
        p = margin_payload(); p['result']['data'][0]['DIM_DATE'] = '2026-11-06 00:00:00'
        with self.assertRaises(ValueError):
            m.parse_margin(p, NOW)
        p = margin_payload(); p['result']['data'].append(deepcopy(p['result']['data'][0]))
        with self.assertRaises(ValueError):
            m.parse_margin(p, NOW)

    def test_new_check_time_cannot_replace_caps_or_pe_with_older_observation(self):
        old = m.parse_tencent(quotes(), NOW)
        incoming = m.parse_tencent(quotes('20261105110000'), NOW)
        for kind in ('caps', 'pe'):
            self.assertEqual(m.merge_observations(kind, old[kind], incoming[kind]), old[kind])

    def test_hk_time_regression_or_live_cannot_replace_verified_close(self):
        current = m.parse_hk_amount(hk_payload(), NOW)
        earlier = deepcopy(current); earlier[-1]['asOf'] = '10:30'; earlier[-1]['amountYi'] = 1
        self.assertEqual(m.merge_observations('hkAmount', current, earlier)[-1], current[-1])
        closed = deepcopy(current); closed[-1]['status'] = 'close'
        self.assertEqual(m.merge_observations('hkAmount', closed, current)[-1], closed[-1])

    def test_partial_outage_retains_other_valid_parts_and_their_source_times(self):
        old = snapshot()
        with patch.object(m, 'fetch_quotes', side_effect=RuntimeError('quote network')), \
                patch.object(m, 'fetch_hk_amount', side_effect=RuntimeError('HK network')), \
                patch.object(m, 'fetch_margin', return_value=m.parse_margin(margin_payload(), NOW)):
            result = m.refresh(old, NOW + dt.timedelta(minutes=5))
        self.assertEqual(result['caps']['quotes'], old['caps']['quotes'])
        self.assertEqual(result['pe']['quotes'], old['pe']['quotes'])
        self.assertEqual(result['hkAmount']['series'], old['hkAmount']['series'])
        self.assertEqual(result['caps']['status'], 'retained')
        self.assertEqual(result['margin']['status'], 'ok')
        self.assertNotEqual(result['checkedAt'], old['checkedAt'])

    def test_bad_old_parts_are_not_retained_as_zero_or_trusted_observations(self):
        old = snapshot(); old['caps']['quotes'][0]['totalCapYi'] = 0; old['hkAmount']['series'][-1]['amountYi'] = 0
        self.assertEqual(m.prior_part(old, 'caps', NOW), [])
        self.assertEqual(m.prior_part(old, 'hkAmount', NOW), [])

    def test_first_ever_all_sources_failure_raises_and_does_not_create_data(self):
        with patch.object(m, 'fetch_quotes', side_effect=RuntimeError('offline')), \
                patch.object(m, 'fetch_hk_amount', side_effect=RuntimeError('offline')), \
                patch.object(m, 'fetch_margin', side_effect=RuntimeError('offline')):
            with self.assertRaisesRegex(RuntimeError, 'existing snapshot retained'):
                m.refresh(None, NOW)

    def test_failed_run_never_overwrites_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'market_kpis.json'
            content = json.dumps(snapshot()); output.write_text(content)
            with patch('sys.argv', ['refresh_market_kpis.py', '--output', str(output)]), \
                    patch.object(m, 'refresh', side_effect=RuntimeError('all source checks failed')):
                self.assertEqual(m.main(), 1)
            self.assertEqual(output.read_text(), content)

    def test_workflow_no_new_secret_required_and_only_scoped_json_is_persisted(self):
        text = (ROOT / '.github/workflows/refresh-market-kpis.yml').read_text()
        self.assertIn('workflow_dispatch:', text)
        self.assertIn('contents: write', text)
        self.assertIn('git add data/market_kpis.json', text)
        self.assertIn('git pull --rebase origin main', text)
        self.assertNotIn('secrets.', text)
        self.assertNotIn('--force', text)


if __name__ == '__main__':
    unittest.main()
