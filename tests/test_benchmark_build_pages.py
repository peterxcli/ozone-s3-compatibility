import json
from pathlib import Path

from scripts.build_pages import main


def test_build_pages_writes_benchmark_parquet_and_static_assets(tmp_path: Path) -> None:
    run_json = tmp_path / "run.json"
    run_json.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "run_id": "run-1",
                "started_at": "2026-05-21T00:00:00Z",
                "finished_at": "2026-05-21T00:00:02Z",
                "status": "completed",
                "workflow_run_url": "",
                "warp": {"repo": "https://github.com/minio/warp", "commit": "abc", "version": "warp"},
                "runner": {"os": "Linux"},
                "providers": [],
                "profiles": [],
                "results": [],
                "timeseries": [],
                "commands": [],
                "log_files": [],
                "logs": [],
                "artifacts": [],
            }
        ),
        encoding="utf-8",
    )

    output_dir = tmp_path / "pages"
    main(["--output-dir", str(output_dir), "--new-run", str(run_json)])

    assert (output_dir / "index.html").exists()
    assert (output_dir / "data" / "catalog" / "runs.parquet").exists()
    assert (output_dir / "data" / "runs" / "run-1" / "metadata.parquet").exists()
