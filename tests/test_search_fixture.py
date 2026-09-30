"""Keeps the Parquet fixture used by the Node search tests in sync with the writer.

`site/tests/search.test.mjs` runs the real DataFusion WebAssembly engine against
`site/tests/fixtures/search-cases.parquet`. Regenerate the fixture after changing
the search cases writer:

    UPDATE_SEARCH_FIXTURE=1 PYTHONPATH=. uv run --with pytest pytest tests/test_search_fixture.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import parquet_run  # noqa: E402

FIXTURE_DIR = ROOT / "site" / "tests" / "fixtures"
CASES_FIXTURE = FIXTURE_DIR / "search-cases.parquet"
RUNS_FIXTURE = FIXTURE_DIR / "search-runs.json"


def case(name: str, classname: str, status: str, message: str = "", detail: str = "", features: list[str] | None = None) -> dict:
    return {
        "name": name,
        "classname": classname,
        "status": status,
        "duration_ms": 10,
        "features": features or [],
        "message": message,
        "detail": detail,
    }


def fixture_run(day: int, s3_cases: list[dict], mint_cases: list[dict]) -> dict:
    run_id = f"2026-05-{day:02d}T02-15-00Z"
    return {
        "run_id": run_id,
        "id": run_id,
        "started_at": f"2026-05-{day:02d}T02:15:00Z",
        "finished_at": f"2026-05-{day:02d}T02:35:00Z",
        "status": "completed",
        "sources": {
            "s3_tests": {"repo": "https://github.com/ceph/s3-tests.git", "ref": "main", "commit": f"s3commit{day}"},
            "mint": {"repo": "https://github.com/minio/mint.git", "ref": "master", "commit": f"mintcommit{day}"},
        },
        "suites": {
            "s3_tests": {
                "label": "s3-tests",
                "status": "completed",
                "included_case_strategy": "non_passing_only",
                "non_passing_cases": s3_cases,
            },
            "mint": {
                "label": "mint",
                "status": "completed",
                "included_case_strategy": "all",
                "cases": mint_cases,
            },
        },
    }


def fixture_runs() -> list[dict]:
    functional = "s3tests.functional.test_s3"
    headers = "s3tests.functional.test_headers"

    # Addresses and line numbers change between runs without changing the failure.
    def access_denied(address: str, line: int) -> dict:
        return case(
            "test_bucket_policy_access_denied",
            functional,
            "fail",
            "ClientError: AccessDenied",
            f"<object at {address}> raised in client.py:{line}",
            ["policy"],
        )

    listing = case("test_list_objects_max_keys_12", functional, "fail", "IsTruncated mismatch", features=["listing"])
    many_keys = case("test_list_objects_many", functional, "fail", "expected 120 keys", features=["listing"])
    bucket_list = case("awscli_bucket_list", "awscli", "pass", features=["awscli"])
    return [
        fixture_run(
            15,
            [
                access_denied("0x7f00", 40),
                case("test_multipart_upload_checksum", headers, "error", "Checksum mismatch in trailer", features=["headers"]),
                listing,
                many_keys,
            ],
            [bucket_list],
        ),
        fixture_run(
            16,
            [
                access_denied("0x7f10", 41),
                case("test_multipart_upload_checksum", headers, "fail", "ChecksumSHA256 missing", features=["headers"]),
                listing,
                many_keys,
            ],
            [bucket_list],
        ),
        fixture_run(
            17,
            [
                access_denied("0x7fff", 42),
                case("test_multipart_upload_checksum", headers, "fail", "ChecksumSHA256 missing", features=["headers"]),
                case(
                    "test_v4_signature_streaming[chunked]",
                    headers,
                    "fail",
                    detail="SignatureDoesNotMatch while validating signed chunks",
                    features=["headers"],
                ),
                listing,
                many_keys,
            ],
            [bucket_list, case("setBucketPolicy(bucketName, bucketPolicy, cb)", "minio-js", "fail", features=["policy"])],
        ),
    ]


def run_summaries(runs: list[dict]) -> list[dict]:
    """The catalog run summaries the report index gives the frontend, newest first."""
    return [
        {
            "id": run["run_id"],
            "run_id": run["run_id"],
            "started_at": run["started_at"],
            "finished_at": run["finished_at"],
            "file": f"data/runs/{run['run_id']}.json",
            "parquet_detail_base_url": f"data/runs/{run['run_id']}/",
            "sources": run["sources"],
            "suites": {suite_key: {"label": suite["label"]} for suite_key, suite in run["suites"].items()},
        }
        for run in sorted(runs, key=lambda item: item["started_at"], reverse=True)
    ]


class SearchFixtureTests(unittest.TestCase):
    def test_node_search_fixture_matches_the_writer(self) -> None:
        runs = fixture_runs()
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "search-cases.parquet"
            parquet_run.write_search_cases(path, parquet_run.build_search_case_rows(runs))
            summaries = run_summaries(runs)

            if os.environ.get("UPDATE_SEARCH_FIXTURE"):
                FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, CASES_FIXTURE)
                RUNS_FIXTURE.write_text(json.dumps(summaries, indent=2) + "\n", encoding="utf-8")

            stale = "Search fixture is stale; regenerate it as described in tests/test_search_fixture.py."
            self.assertEqual(pq.read_schema(path), pq.read_schema(CASES_FIXTURE), stale)
            self.assertEqual(pq.read_table(path).to_pylist(), pq.read_table(CASES_FIXTURE).to_pylist(), stale)
            self.assertEqual(summaries, json.loads(RUNS_FIXTURE.read_text(encoding="utf-8")), stale)


if __name__ == "__main__":
    unittest.main()
