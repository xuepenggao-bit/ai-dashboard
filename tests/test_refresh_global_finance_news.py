import importlib.util
import json
import pathlib
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).parents[1] / '.github' / 'scripts' / 'refresh_global_finance_news.py'
SPEC = importlib.util.spec_from_file_location('refresh_global_finance_news', SCRIPT)
NEWS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NEWS)


class TranslationTests(unittest.TestCase):
    def test_clean_items_preserves_chinese_title(self):
        rows = NEWS._clean_items([{
            'title': 'Markets rise on rate-cut hopes',
            'titleZh': '降息预期推动市场上涨',
            'url': 'https://example.com/story',
            'publisher': 'Reuters',
            'ts': 100,
        }])
        self.assertEqual(rows[0]['titleZh'], '降息预期推动市场上涨')

    def test_google_batch_accepts_both_response_shapes(self):
        payload = json.dumps([['市场上涨', 'en'], '廉价资金时代结束']).encode()
        with mock.patch.object(NEWS, '_request', return_value=payload):
            translated = NEWS._google_translate_batch(['Markets rise', 'Cheap money ends'])
        self.assertEqual(translated, ['市场上涨', '廉价资金时代结束'])

    def test_reuses_cache_and_skips_already_chinese_title(self):
        previous = {'reuters': [{
            'title': 'Cached headline', 'titleZh': '缓存标题',
        }]}
        output = {
            'reuters': [{'title': 'Cached headline'}, {'title': 'New market story'}],
            'substack': [{'title': '已经是中文标题'}],
        }
        with mock.patch.object(NEWS, '_google_translate_batch', return_value=['新的市场消息']) as google:
            with mock.patch.object(NEWS, '_mymemory_translate') as mymemory:
                status = NEWS._apply_title_translations(output, previous)
        google.assert_called_once_with(['New market story'])
        mymemory.assert_not_called()
        self.assertEqual(output['reuters'][0]['titleZh'], '缓存标题')
        self.assertEqual(output['reuters'][1]['titleZh'], '新的市场消息')
        self.assertEqual(output['substack'][0]['titleZh'], '已经是中文标题')
        self.assertEqual(status['translated'], 3)

    def test_mymemory_fallback_keeps_feed_working(self):
        output = {'reuters': [{'title': 'Bond yields fall'}], 'substack': []}
        with mock.patch.object(NEWS, '_google_translate_batch', side_effect=RuntimeError('limited')):
            with mock.patch.object(NEWS, '_mymemory_translate', return_value='债券收益率下降'):
                status = NEWS._apply_title_translations(output, {})
        self.assertEqual(output['reuters'][0]['titleZh'], '债券收益率下降')
        self.assertEqual(status['status'], 'fresh')
        self.assertEqual(status['providers'], ['MyMemory'])

    def test_translation_failure_preserves_original_title(self):
        output = {'reuters': [{'title': 'Bond yields fall'}], 'substack': []}
        with mock.patch.object(NEWS, '_google_translate_batch', side_effect=RuntimeError('limited')):
            with mock.patch.object(NEWS, '_mymemory_translate', side_effect=RuntimeError('offline')):
                status = NEWS._apply_title_translations(output, {})
        self.assertEqual(output['reuters'][0]['title'], 'Bond yields fall')
        self.assertNotIn('titleZh', output['reuters'][0])
        self.assertEqual(status['status'], 'partial')


if __name__ == '__main__':
    unittest.main()
