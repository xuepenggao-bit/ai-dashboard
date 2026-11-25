import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / '.github' / 'scripts' / 'refresh_finance_news.py'
SPEC = importlib.util.spec_from_file_location('refresh_finance_news', SCRIPT)
NEWS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NEWS)
NOW = NEWS.epoch('2026-11-25T12:30:00+08:00')


def article(title='最新财经新闻', timestamp=NOW - 60, url='https://example.com/news/1', **extra):
    return {'title': title, 'ts': timestamp, 'url': url, 'publisher': '新闻来源', 'provider': '东方财富', **extra}


class FinanceNewsTests(unittest.TestCase):
    def test_publication_timestamps_are_explicit_and_cross_platform(self):
        for value in ('2026-11-25 12:30:00', '2026/11/25 12:30', '2026-11-25T12:30:00+08:00',
                      '2026-11-25T04:30:00Z', NOW, str(NOW), NOW * 1000, str(NOW * 1000)):
            self.assertEqual(NEWS.epoch(value), NOW)
        for value in (None, '', 'not-a-date', True, float('nan'), float('inf')):
            self.assertEqual(NEWS.epoch(value), 0)

    def test_bad_dates_titles_and_unsafe_urls_are_rejected(self):
        for changes in ({'ts': None}, {'ts': NOW + 1}, {'ts': 100}, {'title': '短'},
                        {'url': 'javascript:alert(1)'}, {'url': 'data:text/html,x'},
                        {'url': 'https://user:password@example.com/'}, {'url': 'https://example.com/\nnews'}):
            self.assertIsNone(NEWS.normalize_item(article(**changes), NOW))
        self.assertEqual(NEWS.safe_url('http://finance.eastmoney.com/a/1.html#part'),
                         'https://finance.eastmoney.com/a/1.html')

    def test_wscn_deduplicates_cross_channel_items_and_keeps_publication_time(self):
        raw = {'code': 20000, 'data': {'items': [
            {'title': '<b>最新财经新闻</b>', 'uri': 'https://wallstreetcn.com/articles/1', 'display_time': NOW - 10},
            {'title': '最新财经新闻', 'uri': 'https://wallstreetcn.com/articles/1', 'display_time': NOW - 10},
            {'title': '另外一篇财经新闻', 'uri': 'https://wallstreetcn.com/articles/2', 'display_time': NOW - 100},
            {'title': '不可凭抓取时间代替', 'uri': 'https://wallstreetcn.com/articles/3'},
        ]}}
        items = NEWS.parse_wscn(raw, NOW)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]['ts'], NOW - 10)
        self.assertEqual(items[0]['provider'], '华尔街见闻')

    def test_eastmoney_pins_cannot_fake_a_newer_publication_date(self):
        raw = {'code': '1', 'data': {'list': [
            {'title': '旧文重新置顶新闻', 'uniqueUrl': 'http://finance.eastmoney.com/a/1.html',
             'showTime': '2026-11-25 08:40:14', 'realSort': NOW},
            {'title': '午间最新财经新闻', 'url': 'https://finance.eastmoney.com/a/2.html',
             'showTime': '2026-11-25 12:20:00', 'mediaName': '媒体甲'},
        ]}}
        items = NEWS.parse_eastmoney(raw, NOW)
        self.assertEqual(items[0]['title'], '午间最新财经新闻')
        self.assertEqual(items[1]['ts'], NEWS.epoch('2026-11-25T08:40:14+08:00'))
        self.assertEqual(items[0]['publisher'], '媒体甲')

    def test_invalid_response_codes_are_not_success(self):
        for parser, payload in ((NEWS.parse_wscn, {'code': 500}),
                                (NEWS.parse_eastmoney, {'code': '0', 'data': {'list': []}}),
                                (NEWS.parse_wscn, {'code': 20000, 'data': {'items': {}}})):
            with self.assertRaises(ValueError):
                parser(payload, NOW)

    def test_newest_five_across_sources_and_cache_not_fastest_source(self):
        old = {'items': [article('缓存中最新的一篇', NOW - 5, 'https://example.com/cached')]}
        results = [
            {'source': '先返回旧源', 'items': [article('旧来源新闻' + str(i), NOW - 200 - i, 'https://example.com/old' + str(i)) for i in range(6)]},
            {'source': '慢但更新来源', 'items': [article('最新来源新闻' + str(i), NOW - 10 - i, 'https://example.com/new' + str(i)) for i in range(6)]},
        ]
        result = NEWS.build_snapshot(old, results, NOW)
        self.assertEqual(len(result['items']), 5)
        self.assertEqual(result['items'][0]['title'], '缓存中最新的一篇')
        self.assertEqual(result['items'][1]['title'], '最新来源新闻0')
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['latestPublishedAt'], NEWS.iso(NOW - 5))
        self.assertEqual(result['checkedAt'], NEWS.iso(NOW))

    def test_newer_duplicate_title_wins_and_empty_source_is_partial(self):
        results = [{'source': 'A', 'items': [article()]}, {'source': 'B', 'items': []}]
        previous = {'items': [article(timestamp=NOW - 100, url='https://example.com/older')]}
        result = NEWS.build_snapshot(previous, results, NOW)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(len(result['items']), 1)
        self.assertEqual(result['items'][0]['ts'], NOW - 60)

    def test_outage_retains_original_success_time_and_does_not_claim_live_news(self):
        previous = {'updatedAt': NEWS.iso(NOW - 86400), 'items': [article(timestamp=NOW - 86400)]}
        result = NEWS.build_snapshot(previous, [{'source': 'A', 'items': [], 'error': 'unreachable'},
                                                 {'source': 'B', 'items': []}], NOW)
        self.assertEqual(result['status'], 'retained')
        self.assertEqual(result['updatedAt'], previous['updatedAt'])
        self.assertEqual(result['items'], previous['items'])
        self.assertEqual(result['freshness'], 'stale')
        self.assertNotEqual(result['checkedAt'], result['latestPublishedAt'])
        with self.assertRaises(RuntimeError):
            NEWS.build_snapshot({}, [{'source': 'A', 'items': []}], NOW)

    def test_request_parameters_include_required_trace_and_large_article_window(self):
        calls = []
        def respond(url, referer):
            calls.append(url)
            return {'code': '1', 'data': {'list': [{'title': '今日财经新闻', 'url': 'https://example.com/1', 'showTime': '2026-11-25 12:20:00'}]}}
        with patch.object(NEWS, 'request_json', side_effect=respond):
            NEWS.fetch_eastmoney(NOW)
        self.assertIn('req_trace=', calls[0])
        self.assertIn('page_size=30', calls[0])

    def test_wscn_alternate_official_host_falls_back_safely(self):
        calls = []
        def respond(url, referer):
            calls.append(url)
            if len(calls) == 1:
                raise RuntimeError('alternate host offline')
            return {'code': 20000, 'data': {'items': [{'title': '最新财经文章', 'uri': 'https://example.com/1', 'display_time': NOW - 60}]}}
        with patch.object(NEWS, 'request_json', side_effect=respond):
            self.assertEqual(len(NEWS.fetch_wscn(NOW)), 1)
        self.assertIn('api-one-wscn.awtmt.com', calls[0])
        self.assertIn('api-one.wallstcn.com', calls[1])
        self.assertIn('limit=30', calls[1])

    def test_failed_cold_start_never_overwrites_file_and_warm_outage_is_atomic(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'finance_news.json'
            with self.assertRaises(RuntimeError):
                NEWS.refresh(output, now=NOW, results=[{'source': 'A', 'items': []}])
            self.assertFalse(output.exists())
            NEWS.refresh(output, now=NOW, results=[{'source': 'A', 'items': [article()]}])
            previous = json.loads(output.read_text())
            NEWS.refresh(output, now=NOW + 300, results=[{'source': 'A', 'items': []}])
            result = json.loads(output.read_text())
            self.assertEqual(result['items'], previous['items'])
            self.assertEqual(result['updatedAt'], previous['updatedAt'])
            self.assertEqual(result['status'], 'retained')
            self.assertFalse(output.with_name(output.name + '.tmp').exists())


if __name__ == '__main__':
    unittest.main()
