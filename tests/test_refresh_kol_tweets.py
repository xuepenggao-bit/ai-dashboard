import datetime
import importlib.util
import pathlib
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).parents[1] / '.github' / 'scripts' / 'refresh_kol_tweets.py'
SPEC = importlib.util.spec_from_file_location('refresh_kol_tweets', SCRIPT)
KOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(KOL)


class FakeTweet:
    def __init__(self, tweet_id='123', text='Breakout with controlled risk', hours=1,
                 in_reply_to=None, retweeted_tweet=None):
        self.id = tweet_id
        self.full_text = text
        self.created_at_datetime = (
            datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(hours=hours)
        )
        self.created_at = self.created_at_datetime.strftime('%a %b %d %H:%M:%S %z %Y')
        self.in_reply_to = in_reply_to
        self.retweeted_tweet = retweeted_tweet


class KolRefreshTests(unittest.TestCase):
    def setUp(self):
        self.account = {
            'handle': 'TheShortBear',
            'display_name': 'Lukas Froehlich',
        }

    def test_tweet_to_post_keeps_recent_original(self):
        post = KOL._tweet_to_post(FakeTweet(), self.account)
        self.assertEqual(post['source_type'], 'x-direct')
        self.assertEqual(post['handle'], 'TheShortBear')
        self.assertEqual(post['link'], 'https://x.com/TheShortBear/status/123')

    def test_tweet_to_post_drops_old_and_retweet_but_keeps_reply(self):
        self.assertIsNone(KOL._tweet_to_post(FakeTweet(hours=25), self.account))
        reply = KOL._tweet_to_post(
            FakeTweet(in_reply_to='456'), self.account
        )
        self.assertTrue(reply['is_reply'])
        self.assertIsNone(KOL._tweet_to_post(
            FakeTweet(retweeted_tweet=object()), self.account
        ))

    def test_trading_category_uses_news_only_for_missing_x_accounts(self):
        accounts = [
            self.account,
            {'handle': 'Tradestl', 'display_name': 'Phil Goedeker'},
        ]
        x_post = KOL._tweet_to_post(FakeTweet(), self.account)
        news_post = {
            'title': 'Recent interview',
            'desc': '',
            'link': 'https://example.com/interview',
            'source': 'Example',
            'source_type': 'news-rss',
            'pub_iso': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'handle': 'Tradestl',
            'display_name': 'Phil Goedeker',
        }
        with mock.patch.object(KOL, 'fetch_x_posts', return_value=[x_post]), \
             mock.patch.object(KOL, 'fetch_news_for_category', return_value=[news_post]) as news:
            posts = KOL.fetch_posts_for_category('交易策略', accounts)
        self.assertEqual({p['source_type'] for p in posts}, {'x-direct', 'news-rss'})
        self.assertEqual(news.call_args.args[1], [accounts[1]])

    def test_empty_category_has_explicit_status_instead_of_blank(self):
        self.assertEqual(KOL.build_local_summary('交易策略', []), '过去24小时暂无足够的新动态。')


if __name__ == '__main__':
    unittest.main()
