from pathlib import Path

from scripts.benchmark_parquet import read_benchmark_dataset, write_benchmark_dataset


def sample_run() -> dict:
    return {
        "schema_version": 1,
        "run_id": "run-1",
        "started_at": "2026-05-21T00:00:00Z",
        "finished_at": "2026-05-21T00:00:02Z",
        "status": "completed",
        "workflow_run_url": "",
        "warp": {"repo": "https://github.com/minio/warp", "commit": "abc", "version": "warp"},
        "runner": {"os": "Linux", "cpu_count": 4},
        "providers": [
            {
                "provider": "rustfs",
                "label": "RustFS",
                "image": "rustfs/rustfs",
                "image_tag": "latest",
                "image_digest": "sha256:abc",
                "endpoint": "127.0.0.1:9000",
                "adapter_status": "completed",
            }
        ],
        "profiles": [
            {
                "profile_id": "put-small-c01-prefix",
                "workload": "put",
                "object_size": "128KiB",
                "concurrency": 1,
                "prefix_mode": "prefix",
                "duration_seconds": 30,
            }
        ],
        "results": [
            {
                "provider": "rustfs",
                "profile_id": "put-small-c01-prefix",
                "workload": "put",
                "operation": "PUT",
                "status": "completed",
                "exit_code": 0,
                "throughput_mib_per_sec": 1.5,
                "ops_per_sec": 6.0,
                "objects_per_sec": 6.0,
                "errors": 1,
                "duration_seconds": 2.0,
            }
        ],
        "timeseries": [
            {
                "provider": "rustfs",
                "profile_id": "put-small-c01-prefix",
                "workload": "put",
                "operation": "PUT",
                "segment_index": 0,
                "duration_seconds": 1.0,
                "bytes": 1048576,
                "ops_ended": 4,
                "errors": 0,
                "mb_per_sec": 1.0,
                "ops_per_sec": 4.0,
                "objects_per_sec": 4.0,
                "start_time": "2026-05-21T00:00:00Z",
                "end_time": "2026-05-21T00:00:01Z",
            }
        ],
        "commands": [{"provider": "rustfs", "profile_id": "put-small-c01-prefix", "command": ["warp", "put"], "exit_code": 0}],
        "log_files": [],
        "logs": [],
        "artifacts": [],
    }


def test_write_and_read_benchmark_dataset(tmp_path: Path) -> None:
    output_dir = tmp_path / "data"
    write_benchmark_dataset([sample_run()], output_dir)

    assert (output_dir / "catalog" / "runs.parquet").exists()
    assert (output_dir / "runs" / "run-1" / "results.parquet").exists()
    restored = read_benchmark_dataset(output_dir / "runs" / "run-1")

    assert restored["run_id"] == "run-1"
    assert restored["results"][0]["throughput_mib_per_sec"] == 1.5
    assert restored["timeseries"][0]["ops_per_sec"] == 4.0
