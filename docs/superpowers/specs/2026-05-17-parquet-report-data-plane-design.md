# Parquet Report Data Plane Design

## Context

The repository currently normalizes compatibility output into `run.json`, then builds GitHub Pages JSON payloads for run details, indexes, charts, and search. Local generated directories such as `out/` and `.work/` are ignored, but `run/` is not ignored today. The published Pages branch also accumulates generated run and search data over time.

We want to move the report data plane to Parquet so large case details, exception details, and logs remain compact, queryable, and lazily readable by the browser.

## Goals

- Use Parquet as the only published report data format for run data, case details, indexes, search rows, and logs.
- Keep browser startup small by loading only a compact catalog first.
- Fetch detailed Parquet files only when the user opens a run, case, exception detail, or log view.
- Preserve raw log fidelity by storing each original log line in Parquet with nullable parsed fields.
- Support browser-side SQL over Parquet through DuckDB-Wasm.
- Add a browser cache layer so repeated detail/log views do not repeatedly fetch the same remote Parquet blocks or files.
- Keep generated output out of the main branch and reduce growth pressure on published data storage.

## Non-Goals

- Do not build a backend service for querying logs.
- Do not keep JSON copies of run details or search indexes as a parallel published data format.
- Do not require users to install a browser extension or local tool.
- Do not solve unlimited historical retention on GitHub Pages alone. If full history and full logs must remain indefinitely available, the Parquet files should live in object storage or another non-Git artifact store.

## Published Layout

The app has a hardcoded boot catalog path and then discovers the remaining files from catalog Parquet files.

```text
data/
  catalog/
    runs.parquet
    files.parquet
    charts.parquet
    search-manifest.parquet
  runs/
    <run_id>/
      suites.parquet
      cases-s3-tests.parquet
      cases-mint.parquet
      features.parquet
      search-rows.parquet
      logs-pytest.parquet
      logs-mint-console.parquet
      logs-mint-json.parquet
      logs-ozone-s3g.parquet
      logs-ozone-om.parquet
      logs-ozone-scm.parquet
      log-files.parquet
```

Large log files may be split into chunked Parquet files:

```text
data/runs/<run_id>/logs-ozone-s3g-000.parquet
data/runs/<run_id>/logs-ozone-s3g-001.parquet
```

`files.parquet` records every detail file with path, row count, byte size, content hash, schema version, suite, source, and optional chunk range. The UI uses it as the routing table for detail fetches.

## Storage Location

The data layout is independent of where the files are hosted.

- Local preview: `out/pages/data/**`.
- GitHub Pages fallback: publish compact Parquet files under `gh-pages/data/**`.
- Preferred long-term mode: publish Parquet data files to object storage or stable release assets and keep only the static UI plus compact catalog pointers on GitHub Pages.

This matters because Parquet reduces file size but does not by itself stop Git history growth if every historical file is committed to `gh-pages`.

## Parquet Schemas

### Catalog Runs

`catalog/runs.parquet` is the initial run list.

Required columns:

```text
run_id: string
started_at: timestamp_ms_utc
finished_at: timestamp_ms_utc
status: string
workflow_run_url: string
ozone_repo: string
ozone_ref: string
ozone_commit: string
s3_tests_commit: string
mint_commit: string
s3_tests_rate: double
mint_rate: double
detail_base_url: string
schema_version: int32
```

### Cases

Case Parquet files contain full case detail without truncating failure messages.

Required columns:

```text
run_id: string
suite_key: string
case_id: string
name: string
name_base: string
classname: string
status: string
duration_ms: int64
features: list<string>
message: string
detail: string
source_repo: string
source_ref: string
source_path: string
source_symbol: string
log_refs: list<string>
```

`case_id` is stable within a run and is used to join cases, search rows, and log rows.

### Logs

Logs are stored line by line. Parsing enriches the rows, but the original line is always retained.

Required columns:

```text
run_id: string
log_source: string
log_file: string
line_number: int64
timestamp: timestamp_ms_utc nullable
level: string nullable
case_id: string nullable
component: string nullable
thread: string nullable
logger: string nullable
message: string
raw_line: string
event_id: string nullable
exception_class: string nullable
stacktrace_id: string nullable
```

The UI reconstructs exact log snippets by ordering rows by `line_number` and joining `raw_line` with newlines. Parsed fields are best-effort and must not replace `raw_line`.

### Search Rows

Search rows are also Parquet, not JSON. They are optimized for frontend search and modal routing.

Required columns:

```text
run_id: string
suite_key: string
case_id: string
status: string
features: list<string>
test_name: string
classname: string
message: string
detail_preview: string
source_path: string
source_symbol: string
search_text: string
```

`detail_preview` may be truncated for search display, while `cases-*.parquet` keeps the full detail.

## Compression and Encoding

- Use Zstandard compression for all Parquet files.
- Enable dictionary encoding for low-cardinality columns such as suite, status, feature, level, component, and log source.
- Sort case files by `status`, `suite_key`, and `case_id`.
- Sort log files by `line_number`, with optional secondary sort by timestamp when available.
- Target row groups that keep interactive reads practical. Initial target: 16-64 MB uncompressed per row group, adjusted after measurement.

## Frontend Read Path

The Vue app loads DuckDB-Wasm lazily:

1. Load the static app shell.
2. Initialize DuckDB-Wasm when report data is first needed.
3. Register `data/catalog/runs.parquet` and query the run catalog.
4. When the user opens a detail view, query only the relevant Parquet file.
5. For case detail, select by `run_id` and `case_id`.
6. For log detail, select by `run_id`, `log_source`, and either `case_id`, `stacktrace_id`, or a line window.

Example query shape:

```sql
SELECT line_number, raw_line
FROM read_parquet($log_file)
WHERE case_id = $case_id
ORDER BY line_number
LIMIT 1000;
```

If a log source is chunked, `files.parquet` tells the app which chunk files may contain the requested line range or case reference.

## Browser Cache Strategy

Create a `parquetDataClient` abstraction with three cache modes:

```text
auto
on_disk
in_mem
```

In `auto`, the app tries these strategies in order:

1. DuckDB `cache_httpfs` with on-disk caching, if the extension loads and works in DuckDB-Wasm.
2. DuckDB-Wasm OPFS-backed local files managed by our app.
3. Direct remote reads with DuckDB-Wasm's HTTP data protocol.

The app should expose a small cache status and clear-cache action for debugging.

Important browser constraints:

- DuckDB-Wasm has browser memory limits.
- Remote Parquet URLs must satisfy CORS if they are not same-origin.
- OPFS is origin-private and subject to browser quota and site-data clearing.
- The cache layer is an optimization. The report must still work without persistent cache.

## Pipeline Changes

Add a Parquet writer step after raw test execution:

```text
raw outputs -> normalized in-memory tables -> Parquet run dataset -> Pages/static publish
```

Expected script changes:

- Add `scripts/write_parquet_run.py` or extend `scripts/normalize_run.py` to write Parquet datasets.
- Update `scripts/build_pages.py` to build Parquet catalogs and copy Parquet run datasets.
- Keep compatibility comparison logic able to read Parquet run data.
- Add `run/` to `.gitignore`.
- Update workflows to install the Python Parquet dependency.

`pyarrow` is the preferred writer because it gives explicit schema control and mature Parquet/Zstandard support. DuckDB Python is acceptable for validation queries.

## Migration

Implement in phases:

1. Generate Parquet next to existing JSON in local output and compare row counts and summaries.
2. Teach the frontend to read the Parquet catalog and latest-run details behind a feature flag.
3. Move search and case modals to Parquet.
4. Move logs to line-structured Parquet.
5. Stop publishing JSON run/search data after parity checks pass.
6. Add optional external data base URL for non-Git Parquet hosting.

## Error Handling

- If DuckDB-Wasm fails to initialize, show the summary shell and a clear data-load error.
- If cache setup fails, continue with direct remote Parquet reads.
- If a detail Parquet file is missing, show the run and suite summary but mark the detail/log view unavailable.
- If a schema version is unsupported, fail that detail view with a schema mismatch message.
- If OPFS quota is exceeded, clear least recently used cached files and retry once.

## Testing

- Unit test Parquet writers for required columns, schema version, row counts, and summary totals.
- Round-trip generated Parquet through DuckDB locally.
- Compare existing JSON summary outputs against Parquet-derived summaries during migration.
- Add frontend tests for catalog loading, case detail lookup, log line window lookup, and cache fallback behavior.
- Run `npm --prefix site test` and `npm --prefix site run build`.
- Run a narrow nightly smoke test before switching the published data format.

## Open Risks

- `cache_httpfs` is a DuckDB community extension. Its browser/Wasm behavior must be proven in this app before depending on it.
- GitHub Pages is simplest for same-origin fetches, but storing all historical Parquet data in `gh-pages` still grows the branch.
- Browser storage quotas vary by browser and user settings.
- Full-text search over Parquet may need indexing or sharding if history grows large.
- Some raw logs may not map cleanly to `case_id`; those rows remain queryable by source and line range.

## Acceptance Criteria

- The published report can load run summaries from Parquet without `data/index.json`.
- Case detail and exception modals read full details from Parquet on demand.
- Log views read line-structured Parquet and can show exact original log lines.
- Reopening a previously viewed detail uses browser cache when available.
- The report still works when persistent cache is unavailable.
- The main branch ignores generated `run/`, `out/`, and `.work/` state.
- The implementation documents whether Parquet files are hosted on Pages, object storage, or another artifact store.
