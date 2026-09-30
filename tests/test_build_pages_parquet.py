from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_pages  # noqa: E402
import parquet_run  # noqa: E402
from tests.test_parquet_run import sample_run  # noqa: E402


class BuildPagesParquetTests(unittest.TestCase):
    def test_build_pages_writes_parquet_dataset_next_to_json_data(self) -> None:
        run = sample_run()
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            site_dist = root / "site-dist"
            site_dist.mkdir()
            for name in ["index.html", "app.js", "styles.css", "social-preview.svg", "social-preview.png", "CNAME"]:
                (site_dist / name).write_text(name, encoding="utf-8")
            run_json = root / "run.json"
            run_json.write_text(json.dumps(run), encoding="utf-8")

            with mock.patch.object(build_pages, "built_site_dir", return_value=site_dist):
                with mock.patch.object(
                    sys,
                    "argv",
                    ["build_pages.py", "--output-dir", str(root / "pages"), "--new-run", str(run_json)],
                ):
                    build_pages.main()

            self.assertTrue((root / "pages" / "data" / "catalog" / "runs.parquet").exists())
            self.assertTrue((root / "pages" / "data" / "catalog" / "files.parquet").exists())
            self.assertTrue((root / "pages" / "data" / "search" / "cases.parquet").exists())
            self.assertFalse((root / "pages" / "data" / "search-index.json").exists())
            self.assertFalse((root / "pages" / "data" / "runs" / run["run_id"] / "search-rows.parquet").exists())

    def test_build_pages_parquet_mode_omits_json_and_reads_existing_parquet_runs(self) -> None:
        old_run = sample_run()
        old_run["run_id"] = "2026-05-16T02-15-00Z"
        old_run["id"] = old_run["run_id"]
        old_run["started_at"] = "2026-05-16T02:15:00Z"
        old_run["finished_at"] = "2026-05-16T02:35:00Z"
        new_run = sample_run()

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            site_dist = root / "site-dist"
            site_dist.mkdir()
            for name in ["index.html", "app.js", "styles.css", "social-preview.svg", "social-preview.png", "CNAME"]:
                (site_dist / name).write_text(name, encoding="utf-8")

            old_raw_root = root / "old-raw"
            old_log = old_raw_root / "s3-tests" / "pytest.log"
            old_log.parent.mkdir(parents=True)
            old_log.write_text("old log line\n", encoding="utf-8")
            existing_data = root / "existing" / "data"
            parquet_run.write_pages_parquet_dataset([old_run], existing_data, {old_run["run_id"]: old_raw_root})
            # Published by earlier builds; must not survive a republish.
            (existing_data / "runs" / old_run["run_id"] / "search-rows.parquet").write_bytes(b"PAR1")

            run_json = root / "run.json"
            run_json.write_text(json.dumps(new_run), encoding="utf-8")

            with mock.patch.object(build_pages, "built_site_dir", return_value=site_dist):
                with mock.patch.object(
                    sys,
                    "argv",
                    [
                        "build_pages.py",
                        "--output-dir",
                        str(root / "pages"),
                        "--new-run",
                        str(run_json),
                        "--existing-runs-dir",
                        str(existing_data / "runs"),
                        "--data-format",
                        "parquet",
                    ],
                ):
                    build_pages.main()

            pages_data = root / "pages" / "data"
            self.assertFalse((pages_data / "index.json").exists())
            self.assertFalse((pages_data / "index").exists())
            self.assertEqual(["cases.parquet"], sorted(path.name for path in (pages_data / "search").iterdir()))
            self.assertFalse((pages_data / "runs" / f"{new_run['run_id']}.json").exists())
            self.assertFalse((pages_data / "runs" / f"{old_run['run_id']}.json").exists())
            self.assertTrue((pages_data / "runs" / old_run["run_id"] / "logs-pytest.parquet").exists())
            self.assertFalse((pages_data / "runs" / old_run["run_id"] / "search-rows.parquet").exists())

            catalog = pq.read_table(pages_data / "catalog" / "runs.parquet").to_pylist()
            self.assertEqual([new_run["run_id"], old_run["run_id"]], [row["run_id"] for row in catalog])

    def test_build_pages_keeps_log_index_of_published_run_passed_as_new_run(self) -> None:
        run = sample_run()
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            site_dist = root / "site-dist"
            site_dist.mkdir()
            (site_dist / "index.html").write_text("index.html", encoding="utf-8")

            raw_root = root / "raw"
            log_path = raw_root / "s3-tests" / "pytest.log"
            log_path.parent.mkdir(parents=True)
            log_path.write_text("first line\nERROR failed request\n", encoding="utf-8")
            published_data = root / "pages-repo" / "data"
            parquet_run.write_pages_parquet_dataset([run], published_data, {run["run_id"]: raw_root})
            published_run_dir = published_data / "runs" / run["run_id"]
            published_log_files = pq.read_table(published_run_dir / "log-files.parquet").to_pylist()

            # The Pages UI refresh republishes the newest published run directory as the new run.
            with mock.patch.object(build_pages, "built_site_dir", return_value=site_dist):
                with mock.patch.object(
                    sys,
                    "argv",
                    [
                        "build_pages.py",
                        "--output-dir",
                        str(root / "pages"),
                        "--new-run",
                        str(published_run_dir),
                        "--existing-runs-dir",
                        str(published_data / "runs"),
                        "--data-format",
                        "parquet",
                    ],
                ):
                    build_pages.main()

            pages_data = root / "pages" / "data"
            log_files = pq.read_table(pages_data / "runs" / run["run_id"] / "log-files.parquet").to_pylist()
            self.assertEqual(1, len(published_log_files))
            self.assertEqual(published_log_files, log_files)

            files = pq.read_table(pages_data / "catalog" / "files.parquet").to_pylist()
            self.assertEqual(
                [(run["run_id"], f"runs/{run['run_id']}/logs-pytest.parquet", "pytest", 2)],
                [(row["run_id"], row["path"], row["log_source"], row["row_count"]) for row in files if row["kind"] == "logs"],
            )

    def test_raw_root_for_run_path_skips_published_parquet_runs(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            nightly_run = root / "nightly-run"
            (nightly_run / "raw").mkdir(parents=True)
            raw_artifact = root / "raw-artifact"
            (raw_artifact / "s3-tests").mkdir(parents=True)
            published_run = root / "published-run"
            published_run.mkdir()
            (published_run / "metadata.parquet").write_bytes(b"PAR1")

            self.assertEqual(nightly_run / "raw", build_pages.raw_root_for_run_path(nightly_run))
            self.assertEqual(raw_artifact, build_pages.raw_root_for_run_path(raw_artifact))
            self.assertIsNone(build_pages.raw_root_for_run_path(published_run))
            self.assertIsNone(build_pages.raw_root_for_run_path(root / "run.json"))


if __name__ == "__main__":
    unittest.main()
