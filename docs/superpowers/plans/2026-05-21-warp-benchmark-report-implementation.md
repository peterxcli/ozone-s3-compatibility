# Warp Benchmark Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compatibility report with a Warp benchmark report for RustFS, SeaweedFS, Ceph, and Ozone, using Docker provider adapters, a Warp submodule, Parquet data, and a workload-first Vue site.

**Architecture:** Python scripts own benchmark profile expansion, Warp command generation, provider artifact normalization, Parquet dataset writing, and static Pages assembly. GitHub Actions runs one provider per matrix job, aggregates uploaded artifacts, and publishes a fresh Pages root. The Vue app queries the generated benchmark Parquet files through the existing DuckDB-Wasm client pattern and renders workload/profile/provider comparisons.

**Tech Stack:** Python 3.11+, pyarrow, pytest, Bash, Docker Compose, Go-built MinIO Warp submodule, Vue 3, Vite, TypeScript, Chart.js, DuckDB-Wasm, Node test runner.

---

### Task 1: Benchmark Profile Model

**Files:**
- Create: `benchmark/profiles/extended.json`
- Create: `scripts/benchmark_profiles.py`
- Create: `tests/test_benchmark_profiles.py`

- [ ] **Step 1: Write failing tests for profile loading and command rendering**

```python
from pathlib import Path

from scripts.benchmark_profiles import load_profiles, render_warp_command


def test_load_profiles_expands_workload_dimensions():
    profiles = load_profiles(Path("benchmark/profiles/extended.json"))
    ids = {profile.profile_id for profile in profiles}

    assert "put-small-c01-prefix" in ids
    assert "get-range-medium-c16-prefix" in ids
    assert "multipart-put-large-c04-prefix" in ids
    assert all(profile.duration_seconds > 0 for profile in profiles)


def test_render_warp_command_includes_common_and_workload_flags():
    profile = next(
        profile
        for profile in load_profiles(Path("benchmark/profiles/extended.json"))
        if profile.profile_id == "get-range-medium-c16-prefix"
    )

    command = render_warp_command(
        warp_binary="./warp/warp",
        profile=profile,
        host="127.0.0.1:9000",
        access_key="minio",
        secret_key="minio123",
        bucket="warp-benchmark",
        benchdata_path="out/provider/get.csv.zst",
        analyze_out_path="out/provider/get-timeseries.csv",
    )

    assert command[:2] == ["./warp/warp", "get"]
    assert "--host=127.0.0.1:9000" in command
    assert "--access-key=minio" in command
    assert "--secret-key=minio123" in command
    assert "--bucket=warp-benchmark" in command
    assert "--obj.size=1MiB" in command
    assert "--concurrent=16" in command
    assert "--range" in command
    assert "--benchdata=out/provider/get.csv.zst" in command
    assert "--analyze.out=out/provider/get-timeseries.csv" in command
```

- [ ] **Step 2: Verify the tests fail**

Run: `PYTHONPATH=. uv run --with pytest pytest tests/test_benchmark_profiles.py -v`

Expected: FAIL because `scripts.benchmark_profiles` does not exist.

- [ ] **Step 3: Implement profile loading and command rendering**

Create a small dataclass-backed module that expands JSON dimensions into stable profile ids and renders Warp CLI arguments. Use JSON to avoid a new YAML dependency.

- [ ] **Step 4: Verify profile tests pass**

Run: `PYTHONPATH=. uv run --with pytest pytest tests/test_benchmark_profiles.py -v`

Expected: PASS.

### Task 2: Benchmark Normalization

**Files:**
- Create: `scripts/normalize_benchmark.py`
- Create: `tests/test_normalize_benchmark.py`

- [ ] **Step 1: Write failing tests for provider artifact normalization**

```python
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


def test_normalize_benchmark_run_builds_results_and_timeseries(tmp_path):
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
```

- [ ] **Step 2: Verify the tests fail**

Run: `PYTHONPATH=. uv run --with pytest pytest tests/test_normalize_benchmark.py -v`

Expected: FAIL because `scripts.normalize_benchmark` does not exist.

- [ ] **Step 3: Implement normalizer**

Read provider metadata and time-series CSV, calculate aggregate result rows, keep command rows, and build one normalized run dictionary.

- [ ] **Step 4: Verify normalizer tests pass**

Run: `PYTHONPATH=. uv run --with pytest pytest tests/test_normalize_benchmark.py -v`

Expected: PASS.

### Task 3: Benchmark Parquet Dataset

**Files:**
- Create: `scripts/benchmark_parquet.py`
- Create: `tests/test_benchmark_parquet.py`

- [ ] **Step 1: Write failing tests for Parquet writing and reading**

```python
from pathlib import Path

from scripts.benchmark_parquet import read_benchmark_dataset, write_benchmark_dataset


def sample_run():
    return {
        "schema_version": 1,
        "run_id": "run-1",
        "started_at": "2026-05-21T00:00:00Z",
        "finished_at": "2026-05-21T00:00:02Z",
        "status": "completed",
        "workflow_run_url": "",
        "warp": {"repo": "https://github.com/minio/warp", "commit": "abc", "version": "warp"},
        "runner": {"os": "Linux", "cpu_count": 4},
        "providers": [{"provider": "rustfs", "label": "RustFS", "image": "rustfs/rustfs", "image_tag": "latest", "image_digest": "sha256:abc", "endpoint": "127.0.0.1:9000", "adapter_status": "completed"}],
        "profiles": [{"profile_id": "put-small-c01-prefix", "workload": "put", "object_size": "128KiB", "concurrency": 1, "prefix_mode": "prefix", "duration_seconds": 30}],
        "results": [{"provider": "rustfs", "profile_id": "put-small-c01-prefix", "workload": "put", "operation": "PUT", "status": "completed", "exit_code": 0, "throughput_mib_per_sec": 1.5, "ops_per_sec": 6.0, "objects_per_sec": 6.0, "errors": 1, "duration_seconds": 2.0}],
        "timeseries": [{"provider": "rustfs", "profile_id": "put-small-c01-prefix", "workload": "put", "operation": "PUT", "segment_index": 0, "duration_seconds": 1.0, "bytes": 1048576, "ops_ended": 4, "errors": 0, "mb_per_sec": 1.0, "ops_per_sec": 4.0, "objects_per_sec": 4.0, "start_time": "2026-05-21T00:00:00Z", "end_time": "2026-05-21T00:00:01Z"}],
        "commands": [{"provider": "rustfs", "profile_id": "put-small-c01-prefix", "command": ["warp", "put"], "exit_code": 0}],
        "log_files": [],
        "logs": [],
        "artifacts": [],
    }


def test_write_and_read_benchmark_dataset(tmp_path):
    output_dir = tmp_path / "data"
    write_benchmark_dataset([sample_run()], output_dir)

    assert (output_dir / "catalog" / "runs.parquet").exists()
    assert (output_dir / "runs" / "run-1" / "results.parquet").exists()
    restored = read_benchmark_dataset(output_dir / "runs" / "run-1")

    assert restored["run_id"] == "run-1"
    assert restored["results"][0]["throughput_mib_per_sec"] == 1.5
    assert restored["timeseries"][0]["ops_per_sec"] == 4.0
```

- [ ] **Step 2: Verify the tests fail**

Run: `PYTHONPATH=. uv run --with pytest pytest tests/test_benchmark_parquet.py -v`

Expected: FAIL because `scripts.benchmark_parquet` does not exist.

- [ ] **Step 3: Implement Parquet schemas and readers**

Write catalog files plus per-run Parquet files for metadata, providers, profiles, results, timeseries, commands, logs, and file catalog rows.

- [ ] **Step 4: Verify Parquet tests pass**

Run: `PYTHONPATH=. uv run --with pytest pytest tests/test_benchmark_parquet.py -v`

Expected: PASS.

### Task 4: Pages Builder

**Files:**
- Replace: `scripts/build_pages.py`
- Create: `tests/test_benchmark_build_pages.py`

- [ ] **Step 1: Write failing Pages builder test**

```python
import json

from scripts.build_pages import main


def test_build_pages_writes_benchmark_parquet_and_static_assets(tmp_path):
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
```

- [ ] **Step 2: Verify the test fails**

Run: `PYTHONPATH=. uv run --with pytest pytest tests/test_benchmark_build_pages.py -v`

Expected: FAIL because current `build_pages.py` writes compatibility data.

- [ ] **Step 3: Replace Pages builder**

Implement a benchmark-focused builder that copies `site/dist` and `site/public`, writes Parquet data, writes a small JSON bootstrap manifest, and supports `--existing-runs-dir`.

- [ ] **Step 4: Verify builder tests pass**

Run: `PYTHONPATH=. uv run --with pytest pytest tests/test_benchmark_build_pages.py -v`

Expected: PASS.

### Task 5: Runner Scripts, Provider Adapters, and Workflow

**Files:**
- Create: `scripts/run-benchmark-provider.sh`
- Create: `scripts/benchmark/common.sh`
- Create: `scripts/benchmark/providers/rustfs.sh`
- Create: `scripts/benchmark/providers/seaweedfs.sh`
- Create: `scripts/benchmark/providers/ceph.sh`
- Create: `scripts/benchmark/providers/ozone.sh`
- Create: `.github/workflows/benchmark-nightly.yml`
- Remove: `.github/workflows/nightly.yml`
- Remove: `.github/workflows/ozone-pr-s3-compatibility.yml`
- Remove: `.github/workflows/refresh-pages-ui.yml`

- [ ] **Step 1: Create runner and adapter scripts**

Scripts must expose provider startup, readiness, metadata capture, benchmark execution, and cleanup. Keep provider-specific commands in adapters.

- [ ] **Step 2: Add benchmark workflow**

Use a provider matrix and an aggregate Pages job. Include `workflow_dispatch` inputs for provider/profile smoke runs.

- [ ] **Step 3: Verify shell syntax**

Run: `bash -n scripts/run-benchmark-provider.sh scripts/benchmark/common.sh scripts/benchmark/providers/*.sh`

Expected: PASS with no output.

### Task 6: Vue Benchmark Report

**Files:**
- Replace: `site/src/App.vue`
- Replace: `site/src/lib/types.ts`
- Replace: `site/src/lib/report.ts`
- Replace: `site/src/lib/parquetReport.ts`
- Replace: `site/src/styles.css`
- Remove compatibility-only UI/test files.
- Create: `site/tests/benchmark-report.test.mjs`

- [ ] **Step 1: Write failing Node tests for benchmark report helpers**

Test metric formatting, profile filtering, provider sorting, and Parquet row normalization in `site/tests/benchmark-report.test.mjs`.

- [ ] **Step 2: Verify test fails**

Run: `npm --prefix site test -- tests/benchmark-report.test.mjs`

Expected: FAIL because benchmark helper exports do not exist yet.

- [ ] **Step 3: Implement benchmark helpers and app**

Replace compatibility logic with workload-first benchmark data loading and rendering. Keep the existing DuckDB query client if useful.

- [ ] **Step 4: Verify site tests, typecheck, and build**

Run:

```bash
npm --prefix site test
npm --prefix site run typecheck
npm --prefix site run build
```

Expected: PASS.

### Task 7: Remove Compatibility Surface and Add Warp Submodule

**Files:**
- Remove: `s3-tests/`
- Remove: `mint/`
- Remove: compatibility scripts and tests
- Add: `warp/` submodule
- Modify: `.gitmodules`
- Modify: `README.md`

- [ ] **Step 1: Remove obsolete compatibility paths**

Use `git rm` for tracked paths and avoid touching unrelated untracked files. The dirty `s3-tests` diff is whitespace-only and belongs to the removed compatibility subtree.

- [ ] **Step 2: Add Warp submodule**

Run: `git submodule add https://github.com/minio/warp.git warp`

- [ ] **Step 3: Update README**

Document the benchmark workflow, local smoke run, Pages build, and no-push status.

- [ ] **Step 4: Verify repository status**

Run: `git status --short`

Expected: only intended benchmark replacement changes plus pre-existing unrelated untracked files.

### Task 8: Full Verification

**Files:** all changed files.

- [ ] **Step 1: Run Python tests**

Run: `PYTHONPATH=. uv run --with pytest pytest tests`

Expected: PASS.

- [ ] **Step 2: Run site tests and typecheck**

Run:

```bash
npm --prefix site test
npm --prefix site run typecheck
npm --prefix site run build
```

Expected: PASS.

- [ ] **Step 3: Run shell syntax checks**

Run: `bash -n scripts/run-benchmark-provider.sh scripts/benchmark/common.sh scripts/benchmark/providers/*.sh`

Expected: PASS.

- [ ] **Step 4: Build Pages from sample data**

Run the Pages builder against a small normalized fixture and verify `out/pages/index.html` plus benchmark Parquet files exist.

- [ ] **Step 5: Final audit**

Confirm no compatibility workflows remain, `warp/` is a submodule, benchmark workflow exists, and the site builds as a benchmark report.
