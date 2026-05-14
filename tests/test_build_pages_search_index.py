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
        "sources": {
            "s3_tests": {
                "repo": "https://github.com/ceph/s3-tests.git",
                "ref": "main",
                "commit": "abc123def456",
            },
            "mint": {
                "repo": "https://github.com/minio/mint.git",
                "ref": "master",
                "commit": "mint123",
            },
        },
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
        self.assertEqual("python", latest["sourceLanguage"])
        self.assertEqual("s3tests/functional/test_s3.py", latest["sourcePath"])
        self.assertEqual("test_bucket_policy_access_denied", latest["sourceSymbol"])
        self.assertEqual("abc123def456", latest["sourceRef"])
        self.assertEqual("https://github.com/ceph/s3-tests.git", latest["sourceRepo"])

    def test_partitioned_search_index_manifest_keeps_rows_out_of_bootstrap_file(self) -> None:
        payload = build_pages.build_search_index(
            [
                run("2026-04-01T07-22-59Z", "2026-04-01T07:22:59Z", "old AccessDenied"),
                run("2026-04-02T07-22-59Z", "2026-04-02T07:22:59Z", "new AccessDenied"),
                run("2026-04-03T07-22-59Z", "2026-04-03T07:22:59Z", "latest AccessDenied"),
            ]
        )

        manifest, shards = build_pages.partition_search_index_payload(payload, row_chunk_size=2)

        self.assertEqual(2, manifest["schema_version"])
        self.assertTrue(manifest["partitioned"])
        self.assertEqual(payload["generated_at"], manifest["generated_at"])
        self.assertEqual(payload["index_id"], manifest["index_id"])
        self.assertEqual(3, manifest["row_count"])
        self.assertNotIn("rows", manifest)
        self.assertEqual(["search/rows-000.json", "search/rows-001.json"], manifest["partitions"]["rows"])
        self.assertEqual([1, 2], [row["id"] for row in shards["search/rows-000.json"]["rows"]])
        self.assertEqual([3], [row["id"] for row in shards["search/rows-001.json"]["rows"]])


class IndexPartitionBuildTests(unittest.TestCase):
    def test_partitioned_index_manifest_points_to_parallel_shards(self) -> None:
        payload = {
            "generated_at": "2026-04-02T07:22:59Z",
            "rate_formula": "compatibility_rate = passed / eligible",
            "suite_order": ["s3_tests", "mint"],
            "runs": [{"id": f"run-{index}"} for index in range(5)],
            "charts": {
                "overall": {"s3_tests": [{"run_id": "run-0"}]},
                "features": {
                    "s3_tests": {"bucket": [{"run_id": "run-0"}]},
                    "mint": {"core": [{"run_id": "run-0"}]},
                },
            },
        }

        manifest, shards = build_pages.partition_index_payload(payload, run_chunk_size=2)

        self.assertEqual(2, manifest["schema_version"])
        self.assertTrue(manifest["partitioned"])
        self.assertNotIn("runs", manifest)
        self.assertNotIn("charts", manifest)
        self.assertEqual(
            ["index/runs-000.json", "index/runs-001.json", "index/runs-002.json"],
            manifest["partitions"]["runs"],
        )
        self.assertEqual("index/charts-overall.json", manifest["partitions"]["charts_overall"])
        self.assertEqual(
            {
                "s3_tests": "index/charts-features-s3_tests.json",
                "mint": "index/charts-features-mint.json",
            },
            manifest["partitions"]["charts_features"],
        )
        self.assertEqual([{"id": "run-0"}, {"id": "run-1"}], shards["index/runs-000.json"]["runs"])
        self.assertEqual([{"id": "run-4"}], shards["index/runs-002.json"]["runs"])
        self.assertEqual(payload["charts"]["overall"], shards["index/charts-overall.json"]["overall"])
        self.assertEqual(
            payload["charts"]["features"]["s3_tests"],
            shards["index/charts-features-s3_tests.json"]["features"],
        )


if __name__ == "__main__":
    unittest.main()
