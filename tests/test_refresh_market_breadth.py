import datetime as dt
import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / '.github' / 'scripts' / 'refresh_market_breadth.py'
SPEC = importlib.util.spec_from_file_location('refresh_market_breadth', SCRIPT)
BREADTH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BREADTH)


class RecentBreadthDaysTests(unittest.TestCase):
    def setUp(self):
        self.rows = {'2026-08-21': {'date': '2026-08-21', 'up': 2407, 'down': 2626}}

    def test_includes_today_immediately_after_close(self):
        now = dt.datetime(2026, 8, 24, 15, 1, tzinfo=BREADTH.BEIJING_TZ)
        self.assertEqual(BREADTH._recent_missing_days(self.rows, now), [dt.date(2026, 8, 24)])

    def test_excludes_today_before_close(self):
        now = dt.datetime(2026, 8, 24, 14, 59, tzinfo=BREADTH.BEIJING_TZ)
        self.assertEqual(BREADTH._recent_missing_days(self.rows, now), [])

    def test_skips_weekends(self):
        now = dt.datetime(2026, 8, 23, 16, 0, tzinfo=BREADTH.BEIJING_TZ)
        self.assertEqual(BREADTH._recent_missing_days(self.rows, now), [])


if __name__ == '__main__':
    unittest.main()
