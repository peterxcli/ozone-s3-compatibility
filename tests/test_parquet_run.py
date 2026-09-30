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

            catalog_suites = pq.read_table(root / "data" / "catalog" / "suites.parquet").to_pylist()
            self.assertEqual(["mint", "s3_tests"], sorted(row["suite_key"] for row in catalog_suites))
            self.assertEqual({run["run_id"]}, {row["run_id"] for row in catalog_suites})

            catalog_features = pq.read_table(root / "data" / "catalog" / "features.parquet").to_pylist()
            self.assertEqual(["policy"], [row["name"] for row in catalog_features])
            self.assertEqual(run["run_id"], catalog_features[0]["run_id"])
            self.assertEqual("s3_tests", catalog_features[0]["suite_key"])

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

            self.assertFalse((root / "data" / "runs" / run["run_id"] / "search-rows.parquet").exists())
            search_cases = pq.read_table(root / "data" / "search" / "cases.parquet").to_pylist()
            search_by_case = {row["case_id"]: row for row in search_cases}
            self.assertEqual(
                ["mint:awscli_bucket_list", "s3_tests:test_bucket_policy_access_denied"],
                sorted(search_by_case),
            )
            self.assertIn(" accessdenied ", search_by_case["s3_tests:test_bucket_policy_access_denied"]["search_text"])
            self.assertIn("search/cases.parquet", file_paths)

            logs = pq.read_table(root / "data" / "runs" / run["run_id"] / "logs-pytest.parquet").to_pylist()
            self.assertEqual(["first line", "ERROR failed request"], [row["raw_line"] for row in logs])
            self.assertEqual([1, 2], [row["line_number"] for row in logs])
            self.assertEqual("ERROR", logs[1]["level"])


def run_with_case(run_id: str, started_at: str, **case_fields: str) -> dict:
    run = sample_run()
    run["run_id"] = run_id
    run["started_at"] = started_at
    run["finished_at"] = started_at
    run["suites"]["s3_tests"]["non_passing_cases"][0].update(case_fields)
    return run


class SearchCaseTests(unittest.TestCase):
    def test_repeated_failures_collapse_to_the_newest_run(self) -> None:
        runs = [
            run_with_case("run-1", "2026-05-15T02:15:00Z", detail="at 0x7f00 in client.py:10"),
            run_with_case("run-3", "2026-05-17T02:15:00Z", detail="at 0x7fff in client.py:12"),
            run_with_case("run-2", "2026-05-16T02:15:00Z", detail="at 0x7f10 in client.py:11"),
        ]

        rows = parquet_run.build_search_case_rows(runs)

        s3_rows = [row for row in rows if row["suite_key"] == "s3_tests"]
        self.assertEqual(1, len(s3_rows))
        self.assertEqual("run-3", s3_rows[0]["latest_run_id"])
        self.assertEqual(0, s3_rows[0]["latest_run_ordinal"])
        self.assertEqual(["run-3", "run-2", "run-1"], s3_rows[0]["run_ids"])
        self.assertEqual(3, s3_rows[0]["run_count"])
        self.assertEqual("at 0x7fff in client.py:12", s3_rows[0]["detail_preview"])

    def test_changed_failures_keep_separate_history_rows(self) -> None:
        runs = [
            run_with_case("run-1", "2026-05-15T02:15:00Z", message="NoSuchBucket"),
            run_with_case("run-2", "2026-05-16T02:15:00Z", message="AccessDenied"),
        ]

        rows = parquet_run.build_search_case_rows(runs)

        s3_rows = sorted(
            (row for row in rows if row["suite_key"] == "s3_tests"),
            key=lambda row: row["latest_run_ordinal"],
        )
        self.assertEqual(["AccessDenied", "NoSuchBucket"], [row["message"] for row in s3_rows])
        self.assertEqual([["run-2"], ["run-1"]], [row["run_ids"] for row in s3_rows])
        self.assertEqual([0, 1], [row["latest_run_ordinal"] for row in s3_rows])

    def test_parametrized_cases_keep_their_own_rows(self) -> None:
        run = sample_run()
        failure = run["suites"]["s3_tests"]["non_passing_cases"][0]
        run["suites"]["s3_tests"]["non_passing_cases"] = [
            {**failure, "name": "test_multipart_checksum[sha256]"},
            {**failure, "name": "test_multipart_checksum[crc32]"},
        ]

        rows = parquet_run.build_search_case_rows([run])

        s3_rows = {row["test_name"]: row for row in rows if row["suite_key"] == "s3_tests"}
        self.assertEqual(["test_multipart_checksum[crc32]", "test_multipart_checksum[sha256]"], sorted(s3_rows))
        self.assertIn(" crc32 ", s3_rows["test_multipart_checksum[crc32]"]["search_text"])
        self.assertNotIn(" crc32 ", s3_rows["test_multipart_checksum[sha256]"]["search_text"])

    def test_search_text_holds_split_and_joined_lowercase_words(self) -> None:
        rows = parquet_run.build_search_case_rows([sample_run()])

        search_text = next(row for row in rows if row["suite_key"] == "s3_tests")["search_text"]
        self.assertTrue(search_text.startswith(" ") and search_text.endswith(" "))
        words = search_text.split()
        self.assertEqual(sorted(set(words)), words)
        for word in ["accessdenied", "access", "denied", "test", "bucket", "policy", "s3tests", "s3", "tests"]:
            self.assertIn(word, words)
        self.assertNotIn("AccessDenied", search_text)

    def test_search_cases_file_is_laid_out_for_pruning(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "search" / "cases.parquet"

            parquet_run.write_search_cases(path, parquet_run.build_search_case_rows([sample_run()]))

            metadata = pq.ParquetFile(path).metadata
            self.assertEqual(2, metadata.num_row_groups)
            suites = []
            for index in range(metadata.num_row_groups):
                row_group = metadata.row_group(index)
                columns = {row_group.column(column).path_in_schema: row_group.column(column) for column in range(row_group.num_columns)}
                suites.append(columns["suite_key"].statistics.min)
                self.assertEqual("BROTLI", columns["search_text"].compression)
                self.assertTrue(columns["detail_preview"].has_offset_index)
                self.assertNotIn("RLE_DICTIONARY", columns["detail_preview"].encodings)
                self.assertIn("RLE_DICTIONARY", columns["status"].encodings)
            self.assertEqual(["mint", "s3_tests"], suites)

    def test_empty_search_cases_file_keeps_its_schema(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "cases.parquet"

            parquet_run.write_search_cases(path, [])

            table = pq.read_table(path)
            self.assertEqual(0, table.num_rows)
            self.assertEqual(parquet_run.SEARCH_CASES_SCHEMA, table.schema)


if __name__ == "__main__":
    unittest.main()
