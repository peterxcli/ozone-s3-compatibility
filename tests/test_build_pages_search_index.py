from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_pages  # noqa: E402


def summary(passed: int, failed: int, errored: int = 0, skipped: int = 0) -> dict[str, int | float | None]:
    eligible = passed + failed + errored
    return {
        "total": eligible + skipped,
        "passed": passed,
        "failed": failed,
        "errored": errored,
        "skipped": skipped,
        "eligible": eligible,
        "compatibility_rate": round(passed / eligible, 4) if eligible else None,
    }


def run(run_id: str, started_at: str, message: str, detail: str = "") -> dict:
    return {
        "run_id": run_id,
        "started_at": started_at,
        "finished_at": started_at,
        "status": "completed",
        "workflow_run_url": "",
        "sources": {},
        "suites": {
            "s3_tests": {
                "label": "s3-tests",
                "status": "completed",
                "summary": summary(0, 1),
                "feature_summaries": [],
                "included_case_strategy": "non_passing_only",
                "non_passing_cases": [
                    {
                        "name": "test_bucket_policy_access_denied",
                        "classname": "s3tests.functional.test_s3",
                        "status": "fail",
                        "features": ["policy"],
                        "message": message,
                        "detail": detail,
                    }
                ],
            }
        },
    }


class SearchIndexBuildTests(unittest.TestCase):
    def test_search_index_rows_cover_cases_and_prioritize_latest_run(self) -> None:
        payload = build_pages.build_search_index(
            [
                run("2026-04-01T07-22-59Z", "2026-04-01T07:22:59Z", "old AccessDenied"),
                run(
                    "2026-04-02T07-22-59Z",
                    "2026-04-02T07:22:59Z",
                    "ClientError: AccessDenied for bucket policy",
                    "Traceback: SignatureDoesNotMatch while validating signed chunks",
                ),
            ]
        )

        self.assertEqual(1, payload["schema_version"])
        self.assertEqual("2026-04-02T07:22:59Z", payload["generated_at"])
        self.assertEqual(2, payload["row_count"])
        self.assertEqual([0, 1], [row["runOrdinal"] for row in payload["rows"]])
        self.assertEqual([True, False], [row["isLatestRun"] for row in payload["rows"]])

        latest = payload["rows"][0]
        self.assertEqual("s3_tests", latest["suiteKey"])
        self.assertEqual("s3-tests", latest["suiteLabel"])
        self.assertEqual("test_bucket_policy_access_denied", latest["testName"])
        self.assertEqual("data/runs/2026-04-02T07-22-59Z.json", latest["runFile"])
        self.assertIn("ClientError: AccessDenied", latest["searchText"])
        self.assertIn("Access Denied", latest["searchText"])
        self.assertIn("SignatureDoesNotMatch", latest["searchText"])
        self.assertIn("Signature Does Not Match", latest["searchText"])


if __name__ == "__main__":
    unittest.main()
