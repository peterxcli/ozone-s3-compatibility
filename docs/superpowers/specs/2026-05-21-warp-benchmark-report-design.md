# Warp Benchmark Report Design

## Summary

Replace the current Ozone S3 compatibility report with a Warp-based performance benchmark report for RustFS, SeaweedFS, Ceph, and Ozone. The new product uses the current report's strongest infrastructure patterns: static GitHub Pages output, Vue/Vite frontend, Parquet-first run data, DuckDB-Wasm browser queries, generated artifact catalogs, archived run details, and focused local smoke tests.

The compatibility product surface is removed from `main`. The new report owns the Pages root and publishes from a fresh generated output. Old deployment branches such as `gh-pages` are disposable and do not need migration.

## Goals

- Run nightly and manually triggered S3 performance benchmarks with MinIO Warp.
- Compare RustFS, SeaweedFS, Ceph, and Ozone as latest upstream Docker-based providers.
- Use one GitHub Actions matrix job per provider for isolation and parallelism.
- Publish a static workload-first benchmark report at the Pages root.
- Reuse the existing Parquet/report data-plane architecture instead of inventing a new static data format.
- Store enough metadata to make each result auditable: provider image digest, Warp commit, runner details, command lines, logs, and raw artifacts.

## Non-Goals

- Do not keep the compatibility report as an active site or workflow.
- Do not present compatibility rates, s3-tests cases, Mint cases, feature summaries, PR comparison comments, or test-source snippets.
- Do not provide an in-website "run benchmark" button in v1. Manual runs are triggered through GitHub Actions `workflow_dispatch`.
- Do not make historical provider version trends a primary v1 report surface. The report compares latest-vs-latest for the latest run, while retaining archived runs for inspection.
- Do not depend on Warp's live web UI as the published Pages site. GitHub Pages remains static.

## Source Decisions

- Add `https://github.com/minio/warp` as a pinned git submodule, expected at `warp/`.
- Build the Warp binary from the submodule checkout during CI so benchmark behavior is reproducible.
- Use Docker as the provider contract for all four systems.
- Resolve latest upstream provider images at runtime, pull them, and record exact tags and digests before benchmarking.
- Use current public container sources as the starting point:
  - RustFS: `rustfs/rustfs`
  - SeaweedFS: `chrislusf/seaweedfs`
  - Ceph: `quay.io/ceph/ceph` or `ceph/ceph`
  - Ozone: Apache Ozone Docker Compose / `apache/ozone`

## Workflow Architecture

The new active workflow is `benchmark-nightly.yml`.

```text
benchmark-nightly.yml
  benchmark:
    strategy.matrix.provider = [rustfs, seaweedfs, ceph, ozone]
    steps:
      checkout main with submodules
      set up Go, Python, Node, Docker Compose dependencies
      build ./warp/warp
      resolve latest provider Docker image tag and digest
      start provider adapter
      wait for S3 readiness
      run every benchmark profile
      save raw Warp data, analyze output, time-series CSV, logs, and metadata
      upload provider artifact

  aggregate-pages:
    needs: benchmark
    steps:
      download provider artifacts
      normalize one benchmark run
      write JSON and Parquet data
      build the Vue report
      publish a fresh Pages root
```

The matrix job isolates providers from each other. Providers do not share Docker state, ports, disk cache, CPU history, or failure state. The aggregate job is the only place where provider artifacts are combined.

The workflow supports:

- scheduled nightly runs
- `workflow_dispatch` manual runs
- smoke inputs to restrict providers and profiles for quick validation

## Provider Adapters

Provider startup is isolated behind shell adapters:

```text
scripts/benchmark/providers/rustfs.sh
scripts/benchmark/providers/seaweedfs.sh
scripts/benchmark/providers/ceph.sh
scripts/benchmark/providers/ozone.sh
```

Each adapter owns only:

- Docker Compose or `docker run` startup
- image resolution and digest capture when provider-specific handling is required
- endpoint, access key, secret key, TLS, and region exports
- readiness checks
- provider logs and metadata capture
- cleanup

Shared benchmark code owns:

- loading profile definitions
- rendering Warp commands
- running Warp
- collecting raw artifacts
- normalizing results
- writing benchmark JSON and Parquet

This keeps provider-specific setup out of the benchmark profiles.

## Benchmark Profiles

The nightly suite is extended by default. Every provider runs the same profile definitions.

Workloads:

- `put`
- `get`
- `mixed`
- `list`
- `stat`
- `delete`
- `multipart-put`
- range `get`

Dimensions:

- object size matrix: small, medium, large
- concurrency sweep: low, medium, high
- prefix pattern variants: per-thread prefixes and hot/single-prefix mode

Profile definitions live in repo-owned YAML or JSON files. The runner renders those profiles into explicit `warp` commands and records the final command line for every invocation.

The benchmark job target is 60 minutes per provider. If the full extended suite threatens that limit, profiles must be tuned in configuration rather than skipped silently.

## Fairness Rules

- Use one provider per matrix job.
- Use the same GitHub Actions runner type for all providers.
- Use the same Warp binary built from the same `warp/` submodule commit.
- Use the same profile definitions for every provider.
- Record exact provider image tag and digest for every run.
- Record runner OS, CPU count, memory, and disk details where available.
- Permit provider-specific Docker setup only inside adapters.
- Treat failures as benchmark results with status and logs, not as missing data.

## Warp UI and Artifacts

Warp has a local web UI package and rich raw output, but the published site remains static. V1 integrates Warp-native detail through artifacts and normalized data:

- raw `.csv.zst` benchmark data
- `warp analyze` text output
- `--analyze.out` time-series CSV
- command lines
- exit codes
- provider startup logs
- metadata JSON

The report includes per-benchmark artifact links and original command output. A future implementation may add an "Open Warp UI view" only if Warp exposes a static export or the integration is reviewed for licensing and deployment fit. The project should avoid copying Warp UI code into the Vue app unless the AGPL implications are intentionally accepted.

## Normalized Run Model

The new run schema is benchmark-specific.

Top-level JSON fields:

- `schema_version`
- `run_id`
- `started_at`
- `finished_at`
- `status`
- `workflow_run_url`
- `warp`
- `runner`
- `providers`
- `profiles`
- `results`
- `artifacts`

`warp` contains:

- source repo URL
- submodule commit
- binary version output

`runner` contains:

- OS
- CPU count and model where available
- memory where available
- disk information where available

`providers` contains one record per provider:

- provider key and label
- image name
- image tag
- image digest
- endpoint used by Warp
- adapter status
- startup duration
- readiness status
- logs/artifact references

`profiles` contains one record per workload profile:

- profile id
- workload
- object size
- concurrency
- prefix mode
- duration
- extra workload-specific settings

`results` contains one record per provider/profile/operation aggregate:

- provider
- profile id
- workload
- operation
- status
- exit code
- throughput MiB/s
- ops/sec
- object/sec
- p50/p90/p99 latency where available
- TTFB where available
- error count
- measured duration
- artifact references

## Parquet Dataset

The report data plane keeps the current Parquet-first pattern.

Catalog-level files:

- `data/catalog/runs.parquet`
- `data/catalog/files.parquet`

Per-run files:

- `metadata.parquet`
- `providers.parquet`
- `profiles.parquet`
- `results.parquet`
- `timeseries.parquet`
- `commands.parquet`
- `log_files.parquet`
- `logs.parquet`

`timeseries.parquet` is derived from Warp `--analyze.out` CSV and includes:

- run id
- provider
- profile id
- workload
- operation
- segment index
- duration seconds
- bytes
- full operations
- partial operations
- started operations
- ended operations
- errors
- MiB/s
- ops/sec
- objects/sec
- start time
- end time

`files.parquet` powers the artifact browser and lineage-style views, adapted from the existing report.

## Website Design

The Pages root becomes a workload-first benchmark UI using the "Workload Lab" direction.

Main views:

- Latest Workloads
- Profile Controls
- Provider Comparison
- Metric Panels
- Time Series
- Run Details
- Archive

Latest Workloads:

- tabs for supported workloads
- selected workload drives the rest of the page

Profile Controls:

- object size selector
- concurrency selector
- prefix mode selector
- profile status indicators when a provider failed or skipped that exact profile

Provider Comparison:

- RustFS, SeaweedFS, Ceph, and Ozone side by side
- throughput, ops/sec, latency, TTFB, errors, duration
- sorted table and charts for the selected workload/profile

Metric Panels:

- throughput MiB/s
- ops/sec
- p50/p90/p99 latency where available
- TTFB where available
- errors
- measured duration

Time Series:

- line charts from `timeseries.parquet`
- provider overlay for selected profile
- clear empty/error states

Run Details:

- exact Warp commands
- provider image tags and digests
- Warp commit and version output
- runner metadata
- startup logs
- raw artifact links

Archive:

- previous benchmark runs
- focused on inspection and artifact access
- not a v1 trend dashboard

Visual style stays dense, operational, and report-oriented. The UI should not become a marketing landing page.

## Removal and Migration

Remove active compatibility surface from `main`:

- `s3-tests/`
- `mint/`
- compatibility workflows
- compatibility PR-comment workflow
- compatibility refresh workflow if no longer applicable
- s3-tests and Mint patching scripts
- compatibility normalization
- compatibility comparison scripts
- compatibility-specific tests
- compatibility docs
- compatibility UI components, search, source snippets, suite cards, and feature trend logic

Retain or adapt infrastructure patterns:

- static Pages build flow
- Parquet writing and reading approach
- DuckDB-Wasm query client approach
- artifact file catalog approach
- Vue/Vite project structure
- local smoke-test conventions

Do not delete user work casually during implementation. Because the current worktree already has unrelated untracked and modified files, implementation must use an explicit removal plan and verify each target before deleting it.

## Testing Plan

Python tests:

- profile loading
- Warp command generation
- provider artifact normalization
- benchmark JSON schema construction
- Parquet writing and reading
- Pages output structure
- artifact catalog construction

Node/Vue tests:

- benchmark metric formatting
- workload/profile filtering
- provider comparison sorting
- artifact link rendering
- time-series payload handling
- empty and failed-provider states

Integration checks:

- local smoke command for one provider and one tiny profile
- workflow smoke path using `workflow_dispatch` inputs
- full nightly as the complete four-provider extended benchmark

Local validation should not require a full four-provider extended benchmark for every code change.

## Open Implementation Notes

- Provider "latest" resolution should be deterministic within a run and always store image digests.
- Ceph may need the most adapter work to expose an S3/RGW endpoint in a small runner-friendly Docker setup.
- Ozone should start from the Apache Docker Compose path rather than rebuilding source.
- Profile duration and object counts must be tuned after smoke measurements to fit the 60-minute provider budget.
- The repo name can remain unchanged for this implementation; a later rename can be handled separately.

## References

- MinIO Warp repository and README: https://github.com/minio/warp
- Warp CLI reference: https://docs.min.io/warp/reference/cli/
- Warp web UI Go package: https://pkg.go.dev/github.com/minio/warp/wui
- Apache Ozone Docker quick start: https://ozone.apache.org/docs/quick-start/installation/docker/
- RustFS Docker documentation: https://docs.rustfs.com/installation/docker/index.html
- SeaweedFS Docker image: https://hub.docker.com/r/chrislusf/seaweedfs/
- Ceph container image documentation: https://docs.ceph.com/en/quincy/install/containers/
