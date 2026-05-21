# Warp S3 Benchmark Report

Runs MinIO Warp against Docker-based RustFS, SeaweedFS, Ceph, and Apache Ozone targets, normalizes the results, and publishes a static GitHub Pages performance report.

The active report is workload-first: choose a Warp workload/profile, compare providers side by side, inspect time-series segments, and download raw Warp artifacts.

## Workflows

- `.github/workflows/benchmark-nightly.yml`
  - Scheduled daily at `02:15 UTC`.
  - Runs one matrix job per provider: `rustfs`, `seaweedfs`, `ceph`, and `ozone`.
  - Builds Warp from the `warp/` submodule.
  - Starts each provider through a Docker adapter under `scripts/benchmark/providers/`.
  - Runs the shared benchmark profiles from `benchmark/profiles/extended.json`.
  - Aggregates provider artifacts into `out/run/run.json`, writes Parquet report data, builds the Vue frontend, and publishes a fresh Pages root when publishing is enabled.
  - Manual `workflow_dispatch` supports optional provider filtering, a publish flag, and a profile suite selector. Manual runs default to `smoke`; scheduled runs use `extended`.

## Layout

- `warp/`: `minio/warp` submodule used to build the benchmark binary. Workflow runs refresh it from upstream before each benchmark; the committed pointer is only the bootstrap version.
- `benchmark/profiles/smoke.json`: short manual-dispatch profile suite.
- `benchmark/profiles/extended.json`: nightly workload/profile matrix.
- `scripts/run-benchmark-provider.sh`: runs one provider adapter and all configured profiles.
- `scripts/benchmark/common.sh`: shared Docker, image digest, readiness, and runner metadata helpers.
- `scripts/benchmark/providers/`: provider-specific Docker startup/readiness/cleanup adapters.
- `scripts/normalize_benchmark.py`: converts provider artifacts into normalized run JSON.
- `scripts/benchmark_parquet.py`: writes and reads the benchmark Parquet dataset.
- `scripts/build_pages.py`: builds the static Pages output.
- `site/`: Vue 3 + Vite benchmark report frontend.
- `site/tests/`: Node test coverage for benchmark report helpers.
- `tests/`: Python test coverage for profiles, normalization, Parquet data, and Pages output.
- `out/`, `run/`, `.work/`: generated local state.

## Local Development

Initialize dependencies:

```bash
git submodule update --init --recursive
uv sync --locked
npm --prefix site ci
```

Run focused checks:

```bash
PYTHONPATH=. uv run --with pytest pytest tests
npm --prefix site test
npm --prefix site run typecheck
npm --prefix site run build
bash -n scripts/run-benchmark-provider.sh scripts/benchmark/common.sh scripts/benchmark/providers/*.sh
```

## Local Benchmark Smoke

Build Warp:

```bash
go -C warp build -o warp .
```

Run one provider locally:

```bash
export PROVIDER=rustfs
export OUTPUT_ROOT="$PWD/out/providers/rustfs"
bash scripts/run-benchmark-provider.sh rustfs
```

Normalize a run:

```bash
uv run python scripts/normalize_benchmark.py \
  --provider-dir out/providers/rustfs \
  --out out/run/run.json \
  --run-id "$(date -u +%Y-%m-%dT%H-%M-%SZ)" \
  --started-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --finished-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --warp-repo https://github.com/minio/warp \
  --warp-commit "$(git -C warp rev-parse HEAD)" \
  --warp-version "$(./warp/warp --version 2>/dev/null || true)" \
  --runner-json '{"os":"local"}'
```

Build Pages:

```bash
npm --prefix site run build
uv run python scripts/build_pages.py --output-dir out/pages --new-run out/run/run.json
```

Serve `out/pages` with any static file server.

## Report Data

Published Pages data is Parquet. The app loads `data/catalog/runs.parquet`, then fetches per-run Parquet files for metadata, providers, profiles, results, time-series segments, commands, logs, and artifacts through DuckDB-Wasm.

The default workflow hosts Parquet files on the same Pages site as the static UI. For non-GitHub hosting, build the frontend with `VITE_REPORT_DATA_BASE_URL=https://.../data/` or open the report with `?dataBaseUrl=https://.../data/`; remote hosts must allow browser CORS reads.

## Provider Images

Nightly runs track latest upstream Docker images and record the exact image digest used in every run.

- RustFS: `rustfs/rustfs`
- SeaweedFS: `chrislusf/seaweedfs`
- Ceph: `quay.io/ceph/demo` for the single-node RGW adapter
- Ozone: Apache Ozone Docker Compose and `apache/ozone` images

## Security and Generated State

Do not commit local secrets, raw benchmark output, generated clones, or debug artifacts from `.work/`, `run/`, or `out/`. Provider credentials in scripts are local benchmark defaults only.
