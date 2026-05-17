# Ozone S3 Compatibility

Runs Apache Ozone against `ceph/s3-tests` and `minio/mint`, normalizes the results, and publishes a GitHub Pages compatibility report.

The report includes suite trends, feature summaries, archived run details, and shareable test-case search.

https://github.com/user-attachments/assets/bf2decf9-bb98-48da-bcbf-e2a2951806f9

## Workflows

- `.github/workflows/nightly.yml`
  - Scheduled daily at `02:15 UTC`.
  - Builds Ozone, starts the packaged compose cluster, runs `s3-tests` and Mint, writes `out/run/run.json`, rebuilds Pages, and publishes to `gh-pages` on scheduled runs.
  - Manual runs can publish by setting `publish_pages: true`.

- `.github/workflows/refresh-pages-ui.yml`
  - Runs on every push to `main` and by manual dispatch.
  - Rebuilds the Vue frontend and refreshes published UI assets on `gh-pages` while preserving existing run history.

- `.github/workflows/ozone-pr-s3-compatibility.yml`
  - Runs from `repository_dispatch` or manual input for an Ozone PR.
  - Compares the PR run with the latest published main run and uploads artifacts. It does not publish PR data to Pages.

## Layout

- `scripts/run-nightly.sh`: local orchestration entrypoint.
- `scripts/nightly/`: clone, build, cluster, test, and normalization steps.
- `scripts/normalize_run.py`: converts raw `s3-tests` and Mint output into run JSON.
- `scripts/build_pages.py`: builds Parquet report data, social preview assets, and static Pages output.
- `scripts/compare_runs.py`: writes PR-vs-main comparison markdown.
- `site/`: Vue 3 + Vite report frontend.
- `.github/act/`: local `act` runner image and sample event.
- `out/`, `run/`, `.work/`: generated local state.

## Local Development

Install frontend dependencies:

```bash
npm --prefix site ci
```

Install Python report data dependencies:

```bash
uv sync
```

Run frontend checks:

```bash
npm --prefix site test
npm --prefix site run build
```

Run a narrow local compatibility smoke test:

```bash
git submodule update --init --recursive

export OZONE_REPO=/path/to/apache/ozone
export S3_TESTS_ARGS='s3tests/functional/test_s3.py::test_bucket_list_empty'
export MINT_TARGETS='healthcheck awscli'
export OUTPUT_ROOT="$PWD/out/run"

bash scripts/run-nightly.sh
VITE_REPORT_DATA_FORMAT=parquet npm --prefix site run build
uv run python scripts/build_pages.py --output-dir out/pages --new-run out/run/run.json --data-format parquet
```

Serve `out/pages` with any static file server.

## Report Data

Published Pages data is Parquet by default. The app loads `data/catalog/runs.parquet` first, then fetches per-run Parquet files for suites, cases, search rows, and logs on demand through DuckDB-Wasm. The default workflows host those Parquet files on the same `gh-pages` site as the static UI. For non-Git hosting, build the frontend with `VITE_REPORT_DATA_BASE_URL=https://.../data/` or open the report with `?dataBaseUrl=https://.../data/`; remote hosts must allow browser CORS reads.

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

## Useful Knobs

- `OZONE_REPO`, `OZONE_REF`: Ozone source and ref.
- `S3_TESTS_SOURCE`, `S3_TESTS_ARGS`, `S3_TESTS_MARK_EXPR`: `s3-tests` source, selector, and marker filter.
- `MINT_SOURCE`, `MINT_MODE`, `MINT_TARGETS`, `MINT_BUILD_TARGETS`: Mint source and target selection.
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
