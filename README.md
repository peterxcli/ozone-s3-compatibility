# Ozone S3 Compatibility

Runs Apache Ozone against `ceph/s3-tests` and `minio/mint`, normalizes the results, and publishes a GitHub Pages compatibility report.

Published report: <https://ozone.s3.peterxcli.dev/>

The report includes suite trends, feature summaries, archived run details, shareable test-case search, on-demand source snippets, log views, and an embedded Parquet file inspector for the published data set.

https://github.com/user-attachments/assets/bf2decf9-bb98-48da-bcbf-e2a2951806f9

## Workflows

- `.github/workflows/nightly.yml`
  - Scheduled daily at `02:15 UTC`.
  - Builds the Pages frontend, builds Ozone, starts the packaged compose cluster, runs `s3-tests` and Mint, writes `out/run/run.json`, rebuilds Pages with Parquet report data, and uploads the run artifacts.
  - Scheduled runs publish to `gh-pages`; manual runs publish only when `publish_pages: true`.

- `.github/workflows/refresh-pages-ui.yml`
  - Runs on every push to `main` and by manual dispatch.
  - Rebuilds the Vue frontend and vendored Parquet viewer runtime, then refreshes published UI assets on `gh-pages` while preserving existing run history.

- `.github/workflows/ozone-pr-s3-compatibility.yml`
  - Runs from `repository_dispatch` or manual input for an Ozone PR.
  - Tests the PR head, compares the result with the latest published main run, writes a step summary, optionally comments back on the Ozone PR, and uploads artifacts. It does not publish PR data to Pages.

## Layout

- `scripts/run-nightly.sh`: local orchestration entrypoint.
- `scripts/nightly/`: clone, build, cluster, test, and normalization steps.
- `scripts/normalize_run.py`: converts raw `s3-tests` and Mint output into run JSON.
- `scripts/parquet_run.py`: writes and reads the Parquet run data set used by the report.
- `scripts/build_pages.py`: builds the report catalog, per-run Parquet files, social preview assets, and static Pages output.
- `scripts/build_parquet_viewer.sh`: rebuilds the vendored Parquet viewer runtime under `site/public/`.
- `scripts/build_case_search.sh`: rebuilds the DataFusion test-case search engine under `site/src/generated/case-search/`.
- `scripts/compare_runs.py`: writes PR-vs-main comparison markdown.
- `scripts/generate_s3_tests_failure_audit.py`: generates the grouped `s3-tests` failure audit in `docs/s3-tests-failure-audit/`.
- `site/`: Vue 3 + Vite report frontend.
- `site/tests/`: Node test coverage for report UI and frontend data helpers.
- `tests/`: Python test coverage for Pages output, Parquet data, custom-domain publishing, and PR comparison comments.
- `parquet-viewer/`: vendored Dioxus/WASM Parquet viewer source used by the embedded inspector.
- `case-search/`: Rust crate that compiles DataFusion to WebAssembly for test-case search over HTTP range requests.
- `docs/`: PR comment bot setup, HDDS-12716 compatibility mapping, and generated failure-audit documentation.
- `.github/act/`: local `act` runner image and sample event.
- `out/`, `run/`, `.work/`: generated local state.

## Local Development

Initialize submodules and install dependencies:

```bash
git submodule update --init --recursive
uv sync --locked
npm --prefix site ci
```

Run the focused checks:

```bash
PYTHONPATH=. uv run --with pytest pytest tests
npm --prefix site test
npm --prefix site run typecheck
npm --prefix site run build
```

Rebuild the embedded Parquet viewer runtime after changing `parquet-viewer/`:

```bash
cargo install dioxus-cli --version 0.7.3 --locked
npm --prefix site run build:parquet-viewer
```

Rebuild the test-case search engine after changing `case-search/` (the CLI version must match the `wasm-bindgen` crate in `case-search/Cargo.lock`):

```bash
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npm --prefix site run build:case-search
cargo test --manifest-path case-search/Cargo.toml
```

Run a narrow local compatibility smoke test:

```bash
git submodule update --init --recursive

export OZONE_REPO=/path/to/apache/ozone
export S3_TESTS_ARGS='s3tests/functional/test_s3.py::test_bucket_list_empty'
export MINT_TARGETS='healthcheck awscli'
export OUTPUT_ROOT="$PWD/out/run"

bash scripts/run-nightly.sh
VITE_REPORT_DATA_FORMAT=parquet npm --prefix site run build:all
uv run python scripts/build_pages.py --output-dir out/pages --new-run out/run --data-format parquet
```

Serve `out/pages` with any static file server.

## Report Data

Published Pages data is Parquet by default. The app loads `data/catalog/runs.parquet` first, then fetches per-run Parquet files for metadata, suites, cases, log files, and logs on demand through DuckDB-Wasm. The report also ships `data/catalog/files.parquet`, which powers the embedded file browser and lineage view for the published data set.

Test-case search runs SQL in the browser with DataFusion compiled to WebAssembly (`case-search/`) against a single file, `data/search/cases.parquet`. The file holds one row per distinct test failure across all runs (repeated history collapses into one row with the runs it appeared in), with one row group per suite and page indexes. DataFusion reads it with HTTP range requests and pushes the search filter into the Parquet scan, so a search fetches only the footer, the `search_text` column, and the pages that hold matches. Fetched byte ranges stay in memory for the rest of the page session, and a republished file is detected by its ETag.

The default workflows host those Parquet files on the same `gh-pages` site as the static UI. For non-Git hosting, build the frontend with `VITE_REPORT_DATA_BASE_URL=https://.../data/` or open the report with `?dataBaseUrl=https://.../data/`; remote hosts must allow browser CORS reads.

## Local Workflow Run

```bash
git submodule update --init --recursive
./scripts/build-act-runner.sh

act workflow_dispatch \
  -W .github/workflows/nightly.yml \
  -e .github/act/nightly-event.json \
  --secret GITHUB_TOKEN="$(gh auth token)"
```

The sample `act` event keeps publishing disabled. Enable `publish_pages` only when you intend to push `gh-pages`.

## Failure Audit

The generated audit in `docs/s3-tests-failure-audit/` groups failed `s3-tests` cases by implementation area, links each case to the exact upstream test source, records relevant markers, and attaches Ozone source evidence from the inspected run.

Regenerate it from a run JSON and the matching `s3-tests` checkout:

```bash
uv run python scripts/generate_s3_tests_failure_audit.py \
  --run-json /path/to/run.json \
  --s3-tests-dir s3-tests \
  --output-dir docs/s3-tests-failure-audit
```

## Useful Knobs

- `OZONE_REPO`, `OZONE_REF`: Ozone source and ref.
- `S3_TESTS_SOURCE`, `S3_TESTS_ARGS`, `S3_TESTS_MARK_EXPR`, `S3_TESTS_INCLUDE_ALL_CASES`: `s3-tests` source, selector, marker filter, and whether to include passing `s3-tests` cases in the normalized run.
- `MINT_SOURCE`, `MINT_MODE`, `MINT_TARGETS`, `MINT_BUILD_TARGETS`: Mint source and target selection.
- `MINT_TIMEOUT_SECONDS`: timeout for each Mint invocation.
- `OZONE_DATANODES`: compose cluster datanode count.
- `OUTPUT_ROOT`, `WORK_DIR`: generated output locations.

Defaults are tuned for GitHub-hosted runners. The default `s3-tests` marker expression excludes `fails_on_aws` and `auth_aws2`.

## GitHub Setup

1. Enable GitHub Pages from the `gh-pages` branch root.
2. Allow workflow `contents: write` permissions.
3. For Ozone PR comments, configure a forwarder that sends `repository_dispatch` to this repo. See `docs/ozone-pr-comment-bot.md`.
4. If posting comments back to Ozone PRs, provide `OZONE_PR_COMMENT_TOKEN`.

## Compatibility Rate

```text
compatibility_rate = passed / (passed + failed + errored)
```

Skipped and `NA` cases are tracked but excluded from the rate.
