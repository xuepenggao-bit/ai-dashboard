import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).parents[1] / '.github' / 'scripts' / 'refresh_watchlist_news.py'
SPEC = importlib.util.spec_from_file_location('refresh_watchlist_news', SCRIPT)
NEWS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NEWS)


class WatchlistNewsTests(unittest.TestCase):
    def test_portfolio_stocks_combines_duplicate_listings(self):
        payload = {'sectors': [
            {'stocks': [{'name': '兆易创新', 'code': '603986', 'mkt': 'SH'}]},
            {'stocks': [{'name': '兆易创新', 'code': '03986', 'mkt': 'HK'}]},
        ]}
        self.assertEqual(NEWS._portfolio_stocks(payload), [{
            'name': '兆易创新', 'codes': ['603986', '03986'], 'markets': ['SH', 'HK'],
        }])

    def test_parse_jsonp(self):
        payload = NEWS._parse_jsonp('jQuery_watchlist({"code":0,"result":{"x":1}});')
        self.assertEqual(payload['result']['x'], 1)

    def test_eastmoney_rows_accept_exact_title_or_summary_match(self):
        response = {'result': {'cmsArticleWebOld': [
            {'title': '江波龙发布最新公告', 'content': '', 'url': 'http://finance.eastmoney.com/a/1.html',
             'mediaName': '东方财富', 'date': '2026-09-09 12:30:00'},
            {'title': '存储行业最新消息', 'content': '公司回应中明确提及江波龙', 'url': 'https://example.com/2',
             'mediaName': '东方财富', 'date': '2026-09-09 12:31:00'},
            {'title': '无关市场消息', 'content': '没有自选股名称', 'url': 'https://example.com/3',
             'mediaName': '东方财富', 'date': '2026-09-09 12:32:00'},
        ]}}
        with mock.patch.object(NEWS, '_request_text', return_value='cb('+json.dumps(response, ensure_ascii=False)+')'):
            rows = NEWS._eastmoney_stock_news({'name': '江波龙', 'codes': ['301308'], 'markets': ['SZ']})
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['stockName'], '江波龙')
        self.assertEqual(rows[0]['provider'], '东方财富')

    def test_latest_feed_matches_holdings_before_search_indexing(self):
        response = {'data': {'list': [
            {'title': '存储龙头发布午间更新', 'summary': '江波龙回应最新业务进展',
             'uniqueUrl': 'http://finance.eastmoney.com/a/live.html',
             'mediaName': '证券时报', 'showTime': '2026-09-10 13:42:00'},
            {'title': '无关公司盘中异动', 'summary': '市场快讯',
             'uniqueUrl': 'https://stock.eastmoney.com/a/other.html',
             'mediaName': '东方财富', 'showTime': '2026-09-10 13:43:00'},
        ]}}
        stocks = [{'name': '江波龙', 'codes': ['301308'], 'markets': ['SZ']}]
        with mock.patch.object(NEWS, '_request_text', return_value=json.dumps(response)):
            rows = NEWS._eastmoney_latest_news(stocks)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['stockName'], '江波龙')
        self.assertEqual(rows[0]['provider'], '东方财富实时流')
        self.assertTrue(rows[0]['url'].startswith('https://'))

    def test_clean_items_returns_latest_unique_five(self):
        items = [{
            'title': f'股票资讯 {i}', 'url': f'https://example.com/{i}', 'publisher': '来源',
            'ts': i, 'stockName': f'测试股{i}', 'stockCodes': ['000001'], 'provider': '东方财富',
        } for i in range(7)]
        items.append(dict(items[-1]))
        rows = NEWS._clean_items(items)
        self.assertEqual(len(rows), 5)
        self.assertEqual([row['ts'] for row in rows], [6, 5, 4, 3, 2])

    def test_partial_live_result_does_not_mix_in_old_cache_rows(self):
        portfolio = {'sectors': [{'stocks': [
            {'name': '测试股份', 'code': '000001', 'mkt': 'SZ'},
        ]}]}
        previous = {'items': [{
            'title': f'旧缓存 {index}', 'url': f'https://example.com/old-{index}',
            'publisher': '旧来源', 'ts': 100 - index, 'stockName': '测试股份',
            'stockCodes': ['000001'], 'provider': '东方财富',
        } for index in range(5)]}
        fresh = {
            'title': '刚刚发布的公司新闻', 'url': 'https://example.com/fresh',
            'publisher': '实时来源', 'ts': 999, 'stockName': '测试股份',
            'stockCodes': ['000001'], 'provider': '东方财富实时流',
        }
        with tempfile.TemporaryDirectory() as directory:
            portfolio_path = pathlib.Path(directory) / 'portfolio.json'
            output_path = pathlib.Path(directory) / 'watchlist_news.json'
            portfolio_path.write_text(json.dumps(portfolio), encoding='utf-8')
            output_path.write_text(json.dumps(previous), encoding='utf-8')
            with mock.patch.object(NEWS, 'PORTFOLIO', portfolio_path), \
                 mock.patch.object(NEWS, 'OUTPUT', output_path), \
                 mock.patch.object(NEWS, '_eastmoney_latest_news', return_value=[fresh]), \
                 mock.patch.object(NEWS, '_eastmoney_stock_news', return_value=[]), \
                 mock.patch.object(NEWS, '_google_news_fallback', return_value=[]):
                payload = NEWS.refresh()
        self.assertEqual(payload['count'], 1)
        self.assertEqual([item['title'] for item in payload['items']], ['刚刚发布的公司新闻'])

    def test_clean_items_upgrades_eastmoney_links_to_https(self):
        rows = NEWS._clean_items([{
            'title': '测试股票最新资讯',
            'url': 'http://finance.eastmoney.com/a/123.html',
            'publisher': '东方财富', 'ts': 1, 'stockName': '测试股票',
            'stockCodes': ['000001'], 'provider': '东方财富',
        }])
        self.assertEqual(rows[0]['url'], 'https://finance.eastmoney.com/a/123.html')

    def test_clean_items_collapses_duplicate_company_event(self):
        common = {
            'publisher': '来源', 'stockName': '宁德时代',
            'stockCodes': ['300750'], 'provider': '东方财富',
        }
        rows = NEWS._clean_items([
            dict(common, title='员工如厕被拒失控裸奔？宁德时代辟谣：已报警',
                 url='https://example.com/a', ts=2),
            dict(common, title='网传员工如厕受限引发裸奔，宁德时代澄清并报警',
                 url='https://example.com/b', ts=1),
        ])
        self.assertEqual(len(rows), 1)

    def test_time_without_timezone_is_china_time(self):
        epoch = NEWS._to_epoch('2026-09-09 15:00:00')
        self.assertEqual(epoch, 1788937200)


if __name__ == '__main__':
    unittest.main()
