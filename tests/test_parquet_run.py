from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import parquet_run  # noqa: E402


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


def sample_run() -> dict:
    return {
        "schema_version": 1,
        "run_id": "2026-05-17T02-15-00Z",
        "started_at": "2026-05-17T02:15:00Z",
        "finished_at": "2026-05-17T02:35:00Z",
        "status": "completed",
        "workflow_run_url": "https://github.example/runs/1",
        "execution": {
            "s3_tests_args": "s3tests/functional",
            "mint_mode": "core",
            "mint_targets": ["awscli"],
            "ozone_datanodes": "1",
        },
        "sources": {
            "ozone": {
                "repo": "https://github.com/apache/ozone.git",
                "ref": "master",
                "commit": "ozoneabcdef123456",
                "short_commit": "ozoneabcdef1",
            },
            "s3_tests": {
                "repo": "https://github.com/ceph/s3-tests.git",
                "ref": "main",
                "commit": "s3abcdef123456",
                "short_commit": "s3abcdef123",
            },
            "mint": {
                "repo": "https://github.com/minio/mint.git",
                "ref": "master",
                "commit": "mintabcdef123456",
                "short_commit": "mintabcdef1",
            },
        },
        "suites": {
            "s3_tests": {
                "key": "s3_tests",
                "label": "s3-tests",
                "status": "completed",
                "exit_code": 1,
                "summary": summary(1, 1),
                "feature_summaries": [
                    {
                        "name": "policy",
                        "label": "policy",
                        "summary": summary(0, 1),
                        "examples": [
                            {
                                "name": "test_bucket_policy_access_denied",
                                "status": "fail",
                                "message": "AccessDenied",
                            }
                        ],
                    }
                ],
                "included_case_strategy": "non_passing_only",
                "non_passing_cases": [
                    {
                        "name": "test_bucket_policy_access_denied",
                        "classname": "s3tests.functional.test_s3",
                        "features": ["policy"],
                        "status": "fail",
                        "duration_ms": 25,
                        "message": "AccessDenied",
                        "detail": "full traceback",
                    }
                ],
            },
            "mint": {
                "key": "mint",
                "label": "mint",
                "status": "completed",
                "exit_code": 0,
                "summary": summary(1, 0),
                "feature_summaries": [],
                "included_case_strategy": "all",
                "target_execution": {
                    "executed_target_count": 1,
                    "successful_target_count": 1,
                    "target_runs": [{"name": "awscli", "status": "pass", "duration_label": "1s"}],
                },
                "cases": [
                    {
                        "name": "awscli_bucket_list",
                        "classname": "awscli",
                        "features": ["awscli"],
                        "status": "pass",
                        "duration_ms": 10,
                        "message": "",
                        "detail": "",
                    }
                ],
            },
        },
    }


class ParquetRunWriterTests(unittest.TestCase):
    def test_write_pages_parquet_dataset_sorts_catalog_latest_first(self) -> None:
        older_run = sample_run()
        older_run["run_id"] = "2026-05-16T02-15-00Z"
        older_run["started_at"] = "2026-05-16T02:15:00Z"
        older_run["finished_at"] = "2026-05-16T02:35:00Z"

        newer_run = sample_run()
        newer_run["run_id"] = "2026-05-17T02-15-00Z"
        newer_run["started_at"] = "2026-05-17T02:15:00Z"
        newer_run["finished_at"] = "2026-05-17T02:35:00Z"

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)

            parquet_run.write_pages_parquet_dataset([older_run, newer_run], root / "data")

            runs = pq.read_table(root / "data" / "catalog" / "runs.parquet").to_pylist()
            self.assertEqual(
                ["2026-05-17T02-15-00Z", "2026-05-16T02-15-00Z"],
                [row["run_id"] for row in runs],
            )

    def test_write_pages_parquet_dataset_writes_catalog_cases_search_and_logs(self) -> None:
        run = sample_run()
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            raw_root = root / "raw"
            log_path = raw_root / "s3-tests" / "pytest.log"
            log_path.parent.mkdir(parents=True)
            log_path.write_text("first line\nERROR failed request\n", encoding="utf-8")

            parquet_run.write_pages_parquet_dataset([run], root / "data", {run["run_id"]: raw_root})

            runs = pq.read_table(root / "data" / "catalog" / "runs.parquet").to_pylist()
            self.assertEqual(run["run_id"], runs[0]["run_id"])
            self.assertEqual(0.5, runs[0]["s3_tests_rate"])
            self.assertEqual(1.0, runs[0]["mint_rate"])
            self.assertIn('"s3_tests_args": "s3tests/functional"', runs[0]["execution_json"])
            self.assertIn('"short_commit": "ozoneabcdef1"', runs[0]["sources_json"])

            files = pq.read_table(root / "data" / "catalog" / "files.parquet").to_pylist()
            file_paths = {row["path"] for row in files}
            self.assertIn(f"runs/{run['run_id']}/metadata.parquet", file_paths)
            self.assertIn(f"runs/{run['run_id']}/cases-s3-tests.parquet", file_paths)
            self.assertIn(f"runs/{run['run_id']}/logs-pytest.parquet", file_paths)

            metadata = pq.read_table(root / "data" / "runs" / run["run_id"] / "metadata.parquet").to_pylist()
            self.assertEqual(run["run_id"], metadata[0]["run_id"])
            self.assertIn('"mint_targets": ["awscli"]', metadata[0]["execution_json"])
            self.assertIn('"repo": "https://github.com/apache/ozone.git"', metadata[0]["sources_json"])

            suites = pq.read_table(root / "data" / "runs" / run["run_id"] / "suites.parquet").to_pylist()
            self.assertEqual(["mint", "s3_tests"], sorted(row["suite_key"] for row in suites))

            cases = pq.read_table(root / "data" / "runs" / run["run_id"] / "cases-s3-tests.parquet").to_pylist()
            self.assertEqual("s3_tests:test_bucket_policy_access_denied", cases[0]["case_id"])
            self.assertEqual("full traceback", cases[0]["detail"])
            self.assertEqual(["policy"], cases[0]["features"])

            search_rows = pq.read_table(root / "data" / "runs" / run["run_id"] / "search-rows.parquet").to_pylist()
            search_by_case = {row["case_id"]: row for row in search_rows}
            self.assertIn("AccessDenied", search_by_case["s3_tests:test_bucket_policy_access_denied"]["search_text"])
            self.assertIn("Access Denied", search_by_case["s3_tests:test_bucket_policy_access_denied"]["search_text"])

            logs = pq.read_table(root / "data" / "runs" / run["run_id"] / "logs-pytest.parquet").to_pylist()
            self.assertEqual(["first line", "ERROR failed request"], [row["raw_line"] for row in logs])
            self.assertEqual([1, 2], [row["line_number"] for row in logs])
            self.assertEqual("ERROR", logs[1]["level"])


if __name__ == "__main__":
    unittest.main()
