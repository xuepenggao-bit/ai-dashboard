import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve()
SOURCE = HERE.parents[1] / '.github/scripts/refresh_market_calendar.py'
if not SOURCE.exists():
    SOURCE = Path('/private/tmp/market-session-refresh_calendar.py')
SPEC = importlib.util.spec_from_file_location('calendar_updater', SOURCE)
calendar = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = calendar
SPEC.loader.exec_module(calendar)


def sse_fixture(year=2026):
    periods = [('元旦', '1月1日（星期四）至1月3日（星期六）'),
               ('春节', '2月15日（星期日）至2月23日（星期一）'),
               ('清明节', '4月4日（星期六）至4月6日（星期一）'),
               ('劳动节', '5月1日（星期五）至5月5日（星期二）'),
               ('端午节', '6月19日（星期五）至6月21日（星期日）'),
               ('中秋节', '9月25日（星期五）至9月27日（星期日）'),
               ('国庆节', '10月1日（星期四）至10月7日（星期三）')]
    return f'<strong>{year}年休市安排</strong><table><tbody>' + ''.join(
        f'<tr><td>{label}：</td><td>{period}休市，次日起开市。另外，10月10日（星期六）为周末休市。</td></tr>'
        for label, period in periods) + '</tbody></table>'


def hk_fixture(year=2026, full=True):
    dates = ['01-01', '02-17', '02-18', '02-19', '04-03', '04-06', '04-07', '05-01', '05-25', '06-19', '07-01', '10-01', '10-19', '12-25']
    if year == 2027:
        dates = ['01-01', '02-08', '02-09', '03-26', '03-29', '04-05', '05-13', '06-09', '07-01', '09-16', '10-01', '10-08', '12-27']
    events = [{'startdate': f'{year}-{d}', 'enddate': f'{year}-{d}', 'name': 'Official holiday',
               'description': 'Hong Kong Market is closed', 'holidayIcon': 'HongKongPublicHolidays'} for d in dates]
    for d in ['02-16', '12-24', '12-31'] if year == 2026 else ['02-05', '12-24', '12-31']:
        events.append({'startdate': f'{year}-{d}', 'enddate': f'{year}-{d}',
                       'name': 'Half-Day Trading Day - Afternoon Session is Closed on Christmas\'s Eve',
                       'activityIcon': 'SecuritiesandDerivatives'})
    # Stock Connect-only and Mainland holidays must NEVER contaminate HK cash.
    events.append({'startdate': f'{year}-10-02', 'enddate': f'{year}-10-02', 'name': 'National Day',
                   'description': 'Southbound - Trading is Closed', 'holidayIcon': 'StockConnect'})
    events.append({'startdate': f'{year}-10-05', 'enddate': f'{year}-10-05', 'name': 'National Day',
                   'description': 'Northbound Swap Connect is closed', 'holidayIcon': 'MainlandPublicHolidays'})
    payload = json.dumps({'monthly': events}).replace("'", '\\u0027')
    endmonth = 11 if full else 9
    return f"var calendarDataSource = '{payload}'; var calendarDataSourceRanage = [new Date({year}, 0, 1, 0, 0, 0), new Date({year}, {endmonth}, 31, 23, 59, 59)];"


def seed():
    _, a = calendar.parse_sse(sse_fixture())
    return {'schemaVersion': 1, 'updatedAt': '2026-10-01T00:00:00+08:00', 'markets': {
        'A': {'years': {'2026': a}}, 'HK': {'years': {'2026': calendar.parse_hkex(hk_fixture(), 2026)}}}}


class CalendarTests(unittest.TestCase):
    def test_sse_exact_2026(self):
        year, record = calendar.parse_sse(sse_fixture())
        self.assertEqual(year, 2026)
        self.assertEqual(len(record['holidays']), 19)
        self.assertIn('2026-02-23', record['holidays'])
        self.assertNotIn('2026-10-19', record['holidays'])
        self.assertNotIn('2026-10-10', record['holidays'])
        self.assertEqual(record['halfDays'], [])

    def test_sse_accepts_same_month_abbreviation(self):
        _, record = calendar.parse_sse(sse_fixture().replace('至1月3日', '至3日'))
        self.assertIn('2026-01-02', record['holidays'])

    def test_sse_rejects_partial_annual_table(self):
        with self.assertRaises(ValueError):
            calendar.parse_sse(sse_fixture().replace('<td>国庆节：</td>', '<td>其他：</td>'))

    def test_sse_rejects_partial_notice(self):
        with self.assertRaises(ValueError):
            calendar.parse_sse('<h1>关于2026年国庆休市安排</h1><p>10月1日至7日休市</p>')

    def test_hk_2026_holiday_separation_and_half_days(self):
        record = calendar.parse_hkex(hk_fixture(), 2026)
        self.assertEqual(len(record['holidays']), 14)
        self.assertIn('2026-10-19', record['holidays'])
        self.assertNotIn('2026-10-02', record['holidays'])
        self.assertNotIn('2026-10-05', record['holidays'])
        self.assertEqual(record['halfDays'], [{'date': '2026-02-16', 'closeMinute': 730}, {'date': '2026-12-24', 'closeMinute': 730}, {'date': '2026-12-31', 'closeMinute': 730}])

    def test_hk_complete_2027(self):
        record = calendar.parse_hkex(hk_fixture(2027), 2027)
        self.assertEqual(len(record['holidays']), 13)
        self.assertIn('2027-12-27', record['holidays'])
        self.assertEqual(len(record['halfDays']), 3)

    def test_hk_rejects_partial_loaded_range(self):
        with self.assertRaises(ValueError):
            calendar.parse_hkex(hk_fixture(full=False), 2026)

    def test_hk_rejects_christmas_missing_even_if_range_claims_full(self):
        raw = hk_fixture().replace('2026-12-25', '2026-11-20')
        with self.assertRaises(ValueError):
            calendar.parse_hkex(raw, 2026)

    def test_hk_does_not_eval_javascript(self):
        with self.assertRaises((ValueError, json.JSONDecodeError)):
            calendar.parse_hkex("var calendarDataSource = 'process.exit(0)';" + hk_fixture().split(';', 1)[1], 2026)

    def test_source_allowlist(self):
        with self.assertRaises(ValueError):
            calendar.parse_hkex(hk_fixture(), 2026, 'https://example.com/calendar')

    def test_failures_preserve_all_verified_years_and_timestamp(self):
        original = seed()
        def unavailable(url):
            raise TimeoutError('timeout')
        result, errors = calendar.refresh(original, 2026, unavailable)
        self.assertEqual(result, original)
        self.assertEqual(len(errors), 3)

    def test_incomplete_next_year_not_promoted(self):
        original = seed()
        def loader(url):
            if url == calendar.SSE_URL:
                return sse_fixture()
            return hk_fixture(2027, full=False) if '2027-' in url else hk_fixture()
        result, errors = calendar.refresh(original, 2026, loader)
        self.assertNotIn('2027', result['markets']['HK']['years'])
        self.assertEqual(len(errors), 1)

    def test_live_sources_add_verified_next_year_without_mutating_input(self):
        original = seed()
        before = copy.deepcopy(original)
        def loader(url):
            return sse_fixture() if url == calendar.SSE_URL else hk_fixture(2027 if '2027-' in url else 2026)
        result, errors = calendar.refresh(original, 2026, loader)
        self.assertEqual(original, before)
        self.assertEqual(errors, [])
        self.assertTrue(result['markets']['HK']['years']['2027']['verified'])
        self.assertIn('sourceUrls', result['markets']['A']['years']['2026'])


if __name__ == '__main__':
    unittest.main()
