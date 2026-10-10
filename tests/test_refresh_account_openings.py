import copy
import datetime as dt
from decimal import Decimal
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / ".github" / "scripts" / "refresh_account_openings.py"
SPEC = importlib.util.spec_from_file_location("refresh_account_openings", SCRIPT)
OPENINGS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OPENINGS)
NOW = dt.datetime(2026, 10, 10, 8, 41, tzinfo=OPENINGS.BEIJING)


def official_report(date="202609", amounts=None):
    year, last_month = int(date[:4]), int(date[4:])
    amounts = amounts or {}
    rows = [{"TERM": f"{year}.{month:02d}", "MDATE": date,
             "A_PERSON": amounts.get(month, "100.1234") if month <= last_month else "0.0000",
             "A_ORG": "1.0000", "PERSON": "100.2234", "ORG": "1.0100",
             "B_PERSON": "0.1000", "B_ORG": "0.0100"} for month in range(1, 13)]
    rows.extend([{"TERM": f"{year}年合计", "MDATE": date, "A_PERSON": "9999.0000"},
                 {"TERM": "累计总户数", "MDATE": date, "A_PERSON": "99999.0000"}])
    return {"sqlId": OPENINGS.SQL_ID, "result": rows,
            "actionErrors": [], "fieldErrors": {}, "isPagination": "false"}


def seed():
    records = []
    for year, last_month, date in ((2025, 12, "202512"), (2026, 9, "202609")):
        for month in range(1, last_month + 1):
            value = 264.0340 if (year, month) == (2025, 8) else 100.1234
            records.append({"year": year, "month": month, "personalWan": value,
                            "source": "用户附件", "reportMonth": date})
    return {"schemaVersion": 1, "displayYear": 2026, "unit": "万户", "scope": OPENINGS.SCOPE,
            "sourceUrl": OPENINGS.SOURCE_URL, "seededFrom": "用户提供的上交所月度数据附件",
            "latestReportMonth": "202609", "lastCheckedAt": None, "lastSuccessAt": None,
            "check": {"status": "seed", "message": "附件初始数据"}, "records": records}


class AccountOpeningsTests(unittest.TestCase):
    def fetcher(self, date):
        return official_report(date or "202609", {8: "264.0364"} if date == "202512" else None)

    def test_official_fields_and_summaries_and_future_placeholders(self):
        date, rows = OPENINGS.parse_report(official_report(), current_month="202610")
        self.assertEqual(date, "202609")
        self.assertEqual([row["month"] for row in rows], list(range(1, 10)))
        self.assertEqual(rows[0]["personalWan"], Decimal("100.1234"))
        self.assertEqual(rows[0]["source"], OPENINGS.OFFICIAL_SOURCE)
        self.assertNotIn(Decimal("9999.0000"), [row["personalWan"] for row in rows])

    def test_strict_date_term_amount_and_table_validation(self):
        invalid_rows = [{"MDATE": "2026-09"}, {"MDATE": "202613"},
                        {"MDATE": 202609}, {"TERM": "2026.9"}, {"TERM": "2025.01"},
                        {"TERM": None}, {"A_PERSON": "0.0000"}, {"A_PERSON": "-1"},
                        {"A_PERSON": "NaN"}, {"A_PERSON": "Infinity"},
                        {"A_PERSON": "100.12345"}, {"A_PERSON": "1e2"},
                        {"A_PERSON": 100.1234}, {"A_PERSON": True}, {"A_PERSON": None}]
        for changes in invalid_rows:
            with self.subTest(changes=changes):
                payload = official_report()
                payload["result"][0].update(changes)
                with self.assertRaises(ValueError):
                    OPENINGS.parse_report(payload, current_month="202610")
        payload = official_report()
        payload["sqlId"] = "OTHER_TABLE"
        with self.assertRaises(ValueError):
            OPENINGS.parse_report(payload)

    def test_empty_partial_duplicate_and_mixed_date_reports_rejected(self):
        payloads = [{"sqlId": OPENINGS.SQL_ID, "result": []},
                    {"sqlId": OPENINGS.SQL_ID, "result": "not-a-list"},
                    {"sqlId": OPENINGS.SQL_ID, "result": [None]}]
        partial = official_report()
        partial["result"].pop(0)
        payloads.append(partial)
        duplicate = official_report()
        duplicate["result"].append(copy.deepcopy(duplicate["result"][0]))
        payloads.append(duplicate)
        mixed = official_report()
        mixed["result"][1]["MDATE"] = "202608"
        payloads.append(mixed)
        for payload in payloads:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    OPENINGS.parse_report(payload)

    def test_requested_or_future_report_date_rejected(self):
        with self.assertRaises(ValueError):
            OPENINGS.parse_report(official_report(), expected_month="202512")
        with self.assertRaises(ValueError):
            OPENINGS.parse_report(official_report("202611"), current_month="202610")

    def test_http_200_wrapped_error_and_non_json_rejected(self):
        for text in ('\n\n({"success":"false","error":"System Error"})',
                     '{"success":false}', '<html>Unavailable</html>', '[]'):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    OPENINGS.decode_response(text)
        parsed = OPENINGS.decode_response(json.dumps(official_report()))
        self.assertEqual(parsed["sqlId"], OPENINGS.SQL_ID)

    def test_same_report_official_correction_and_source_verification(self):
        previous = seed()
        result = OPENINGS.refresh_data(previous, NOW, self.fetcher)
        august = next(row for row in result["records"] if (row["year"], row["month"]) == (2025, 8))
        self.assertEqual(august["personalWan"], Decimal("264.0364"))
        self.assertEqual(august["reportMonth"], "202512")
        self.assertEqual(august["source"], OPENINGS.OFFICIAL_SOURCE)
        self.assertIn("校正1个月", result["check"]["message"])
        self.assertEqual(previous["records"][7]["personalWan"], 264.0340)
        self.assertEqual(result["seededFrom"], previous["seededFrom"])
        self.assertEqual(result["lastCheckedAt"], "2026-10-10T08:41:00+08:00")
        self.assertEqual(result["lastSuccessAt"], result["lastCheckedAt"])

    def test_stale_report_and_future_zero_do_not_overwrite_newer_seed(self):
        previous = seed()
        result = OPENINGS.refresh_data(previous, NOW,
            lambda date: official_report(date or "202608", {1: "99.0000"}))
        old_2026 = [row for row in previous["records"] if row["year"] == 2026]
        new_2026 = [row for row in result["records"] if row["year"] == 2026]
        self.assertEqual(new_2026, old_2026)
        self.assertEqual(result["latestReportMonth"], "202609")
        self.assertNotIn(10, [row["month"] for row in new_2026])
        self.assertIn("较新缓存", result["check"]["message"])

    def test_new_report_adds_only_finalized_months(self):
        result = OPENINGS.refresh_data(seed(), NOW,
            lambda date: official_report(date or "202610", {10: "200.9876"}))
        records = [row for row in result["records"] if row["year"] == 2026]
        self.assertEqual(len(records), 10)
        self.assertEqual(records[-1]["personalWan"], Decimal("200.9876"))
        self.assertEqual(result["latestReportMonth"], "202610")
        self.assertIn("新增1个月", result["check"]["message"])

    def test_full_failure_preserves_all_records_and_last_success(self):
        previous = seed()
        previous["lastSuccessAt"] = "2026-10-09T08:41:00+08:00"
        def fail(_):
            raise RuntimeError("network unavailable")
        result = OPENINGS.refresh_data(previous, NOW, fail)
        self.assertEqual(result["records"], previous["records"])
        self.assertEqual(result["latestReportMonth"], previous["latestReportMonth"])
        self.assertEqual(result["lastSuccessAt"], previous["lastSuccessAt"])
        self.assertEqual(result["check"]["status"], "error")
        self.assertEqual(len(result["check"]["errors"]), 2)
        self.assertIsNone(previous["lastCheckedAt"])

    def test_partial_failure_merges_good_report_and_keeps_failed_year(self):
        previous = seed()
        def fetch(date):
            if date:
                raise RuntimeError("prior report unavailable")
            return official_report("202610")
        result = OPENINGS.refresh_data(previous, NOW, fetch)
        self.assertEqual(result["check"]["status"], "partial")
        self.assertEqual([row for row in result["records"] if row["year"] == 2025],
                         [row for row in previous["records"] if row["year"] == 2025])
        self.assertEqual(len([row for row in result["records"] if row["year"] == 2026]), 10)

    def test_new_year_follows_beijing_time_and_preserves_history(self):
        # UTC is still December 31 while Beijing has entered January 1.
        now = dt.datetime(2026, 12, 31, 16, 1, tzinfo=dt.timezone.utc)
        calls = []
        def fetch(date):
            calls.append(date)
            return official_report(date or "202612")
        result = OPENINGS.refresh_data(seed(), now, fetch)
        self.assertEqual(result["displayYear"], 2027)
        self.assertEqual(calls, [None, "202612"])
        self.assertEqual(result["lastCheckedAt"], "2027-01-01T00:01:00+08:00")
        self.assertEqual({row["year"] for row in result["records"]}, {2025, 2026})

    def test_decimal_correction_and_json_roundtrip_are_exact(self):
        result = OPENINGS.refresh_data(seed(), NOW, self.fetcher)
        encoded = OPENINGS.encode_json(result)
        decoded = json.loads(encoded, parse_float=Decimal)
        august = next(row for row in decoded["records"] if (row["year"], row["month"]) == (2025, 8))
        self.assertEqual(august["personalWan"], Decimal("264.0364"))
        self.assertIn('"personalWan": 264.0364', encoded)
        self.assertNotIn('"personalWan": "', encoded)
        self.assertEqual(august["personalWan"] - Decimal("264.0340"), Decimal("0.0024"))

    def test_atomic_file_refresh_keeps_failed_data_and_no_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "account_openings.json"
            output.write_text(json.dumps(seed(), ensure_ascii=False), encoding="utf-8")
            def fail(_):
                raise ValueError("bad response")
            OPENINGS.refresh(output, NOW, fail)
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["check"]["status"], "error")
            self.assertEqual(payload["records"], seed()["records"])
            self.assertEqual(list(Path(directory).iterdir()), [output])

    def test_request_has_headers_timeout_and_explicit_prior_month(self):
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def read(self, limit):
                self.limit = limit
                return json.dumps(official_report("202512")).encode("utf-8")
        with patch.object(OPENINGS, "urlopen", return_value=Response()) as network:
            payload = OPENINGS.request_report("202512")
        request = network.call_args.args[0]
        self.assertIn("MDATE=202512", request.full_url)
        self.assertEqual(request.get_header("Referer"), OPENINGS.SOURCE_URL)
        self.assertTrue(request.get_header("User-agent").startswith("Mozilla/5.0"))
        self.assertEqual(network.call_args.kwargs["timeout"], 12)
        self.assertEqual(payload["result"][0]["MDATE"], "202512")

    def test_invalid_cache_and_naive_time_fail_before_network(self):
        invalid = seed()
        invalid["records"][0]["personalWan"] = 0
        for previous, now in ((invalid, NOW), (seed(), NOW.replace(tzinfo=None))):
            with patch.object(OPENINGS, "request_report") as network:
                with self.assertRaises(ValueError):
                    OPENINGS.refresh_data(previous, now)
                network.assert_not_called()


if __name__ == "__main__":
    unittest.main()
