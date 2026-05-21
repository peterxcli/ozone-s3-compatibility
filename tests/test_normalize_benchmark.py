import csv
import json
from pathlib import Path

from scripts.normalize_benchmark import normalize_benchmark_run


def write_timeseries(path: Path) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "index",
                "op",
                "host",
                "duration_s",
                "objects_per_op",
                "bytes",
                "full_ops",
                "partial_ops",
                "ops_started",
                "ops_ended",
                "errors",
                "mb_per_sec",
                "ops_ended_per_sec",
                "objs_per_sec",
                "start_time",
                "end_time",
            ],
        )
        writer.writeheader()
        writer.writerow(
            {
                "index": "0",
                "op": "PUT",
                "host": "",
                "duration_s": "1",
                "objects_per_op": "1",
                "bytes": "1048576",
                "full_ops": "4",
                "partial_ops": "0",
                "ops_started": "4",
                "ops_ended": "4",
                "errors": "0",
                "mb_per_sec": "1.0",
                "ops_ended_per_sec": "4.0",
                "objs_per_sec": "4.0",
                "start_time": "2026-05-21T00:00:00Z",
                "end_time": "2026-05-21T00:00:01Z",
            }
        )
        writer.writerow(
            {
                "index": "1",
                "op": "PUT",
                "host": "",
                "duration_s": "1",
                "objects_per_op": "1",
                "bytes": "2097152",
                "full_ops": "8",
                "partial_ops": "0",
                "ops_started": "8",
                "ops_ended": "8",
                "errors": "1",
                "mb_per_sec": "2.0",
                "ops_ended_per_sec": "8.0",
                "objs_per_sec": "8.0",
                "start_time": "2026-05-21T00:00:01Z",
                "end_time": "2026-05-21T00:00:02Z",
            }
        )


def test_normalize_benchmark_run_builds_results_and_timeseries(tmp_path: Path) -> None:
    provider_dir = tmp_path / "rustfs"
    provider_dir.mkdir()
    write_timeseries(provider_dir / "put-small-c01-prefix-timeseries.csv")
    (provider_dir / "metadata.json").write_text(
        json.dumps(
            {
                "provider": "rustfs",
                "label": "RustFS",
                "image": "rustfs/rustfs",
                "image_tag": "latest",
                "image_digest": "sha256:abc",
                "endpoint": "127.0.0.1:9000",
                "adapter_status": "completed",
                "profiles": [
                    {
                        "profile_id": "put-small-c01-prefix",
                        "workload": "put",
                        "operation": "PUT",
                        "object_size": "128KiB",
                        "concurrency": 1,
                        "prefix_mode": "prefix",
                        "duration_seconds": 30,
                        "command": ["warp", "put"],
                        "exit_code": 0,
                        "benchdata": "put.csv.zst",
                        "analyze_out": "put-small-c01-prefix-timeseries.csv",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    run = normalize_benchmark_run(
        provider_dirs=[provider_dir],
        run_id="2026-05-21T00-00-02Z",
        started_at="2026-05-21T00:00:00Z",
        finished_at="2026-05-21T00:00:02Z",
        workflow_run_url="https://github.example/runs/1",
        warp={"repo": "https://github.com/minio/warp", "commit": "abc123", "version": "warp version"},
        runner={"os": "Linux", "cpu_count": 4, "memory": "16 GB", "disk": "100 GB"},
    )

    assert run["status"] == "completed"
    assert run["providers"][0]["provider"] == "rustfs"
    assert run["results"][0]["throughput_mib_per_sec"] == 1.5
    assert run["results"][0]["ops_per_sec"] == 6.0
    assert run["results"][0]["errors"] == 1
    assert len(run["timeseries"]) == 2
    assert run["commands"][0]["command"] == ["warp", "put"]
