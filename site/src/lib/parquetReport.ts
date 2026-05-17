import type {
  ExecutionInput,
  FeatureChartPoint,
  FeatureSummaryRecord,
  FullRun,
  IndexPayload,
  LogFileRecord,
  LogLineRecord,
  OverallChartPoint,
  RunSummary,
  SourcesMap,
  StoredCaseEntry,
  SuiteRecord,
  SummaryMetrics,
} from "./types";

export const PARQUET_FILE_REF = "__PARQUET_FILE__";
export const REPORT_RATE_FORMULA =
  "compatibility_rate = passed / (passed + failed + errored); skipped and NA are excluded";

export interface ParquetQueryClient {
  queryRows<T extends Record<string, unknown>>(filePath: string, sql: string): Promise<T[]>;
}

export interface ParquetCatalogRunRow extends Record<string, unknown> {
  run_id?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  status?: unknown;
  workflow_run_url?: unknown;
  ozone_repo?: unknown;
  ozone_ref?: unknown;
  ozone_commit?: unknown;
  s3_tests_commit?: unknown;
  mint_commit?: unknown;
  detail_base_url?: unknown;
  execution_json?: unknown;
  sources_json?: unknown;
  schema_version?: unknown;
}

export interface ParquetMetadataRow extends Record<string, unknown> {
  run_id?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  status?: unknown;
  rate_formula?: unknown;
  workflow_run_url?: unknown;
  orchestration_json?: unknown;
  execution_json?: unknown;
  sources_json?: unknown;
  schema_version?: unknown;
}

export interface ParquetSuiteRow extends Record<string, unknown> {
  run_id?: unknown;
  suite_key?: unknown;
  label?: unknown;
  status?: unknown;
  exit_code?: unknown;
  passed?: unknown;
  failed?: unknown;
  errored?: unknown;
  skipped?: unknown;
  eligible?: unknown;
  compatibility_rate?: unknown;
  included_case_strategy?: unknown;
}

export interface ParquetFeatureRow extends Record<string, unknown> {
  run_id?: unknown;
  suite_key?: unknown;
  name?: unknown;
  label?: unknown;
  passed?: unknown;
  failed?: unknown;
  errored?: unknown;
  skipped?: unknown;
  eligible?: unknown;
  compatibility_rate?: unknown;
}

export interface ParquetCaseRow extends Record<string, unknown> {
  name?: unknown;
  classname?: unknown;
  status?: unknown;
  duration_ms?: unknown;
  features?: unknown;
  message?: unknown;
  detail?: unknown;
}

export interface ParquetLogFileRow extends Record<string, unknown> {
  run_id?: unknown;
  log_source?: unknown;
  log_file?: unknown;
  path?: unknown;
  line_count?: unknown;
}

export interface ParquetLogLineRow extends Record<string, unknown> {
  run_id?: unknown;
  log_source?: unknown;
  log_file?: unknown;
  line_number?: unknown;
  timestamp?: unknown;
  level?: unknown;
  case_id?: unknown;
  component?: unknown;
  thread?: unknown;
  logger?: unknown;
  message?: unknown;
  raw_line?: unknown;
  event_id?: unknown;
  exception_class?: unknown;
  stacktrace_id?: unknown;
}

export interface NormalizeParquetIndexInput {
  catalogRows: ParquetCatalogRunRow[];
  suiteRows: ParquetSuiteRow[];
  featureRows: ParquetFeatureRow[];
}

export interface NormalizeParquetRunInput {
  summary: RunSummary;
  metadataRows: ParquetMetadataRow[];
  suiteRows: ParquetSuiteRow[];
  featureRows: ParquetFeatureRow[];
  logFileRows?: ParquetLogFileRow[];
  caseRowsBySuite: Record<string, ParquetCaseRow[]>;
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function asOptionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text ? text : undefined;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullableRate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampString(value: unknown): string {
  if (!value) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    let epoch = Number(value);
    if (!Number.isFinite(epoch)) {
      return "";
    }
    if (Math.abs(epoch) > 8.64e15) {
      epoch /= 1_000_000;
    } else if (Math.abs(epoch) > 10_000_000_000_000) {
      epoch /= 1_000;
    }
    const date = new Date(epoch);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  if (typeof value === "object" && "valueOf" in value && typeof value.valueOf === "function") {
    const primitive = value.valueOf();
    if (primitive !== value) {
      return timestampString(primitive);
    }
  }
  const text = asString(value);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function parseJsonObject<T extends Record<string, unknown>>(value: unknown, fallback: T): T {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as T;
  }
  const text = asString(value).trim();
  if (!text) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function shortCommit(value: string): string {
  return value && value !== "unknown" ? value.slice(0, 12) : value || "unknown";
}

function normalizeSourceRecord(value: Record<string, unknown> | undefined): SourcesMap[string] {
  const commit = asString(value?.commit || "unknown");
  const ref = asString(value?.ref || "unknown");
  return {
    repo: asString(value?.repo || ""),
    ref,
    commit,
    short_commit: asString(value?.short_commit || shortCommit(commit || ref)),
  };
}

function sourcesFromRow(row: ParquetCatalogRunRow | ParquetMetadataRow | undefined): SourcesMap {
  const parsedSources = parseJsonObject<Record<string, Record<string, unknown>>>(row?.sources_json, {});
  return {
    ozone: normalizeSourceRecord(
      parsedSources.ozone || {
        repo: row?.ozone_repo,
        ref: row?.ozone_ref,
        commit: row?.ozone_commit,
      },
    ),
    s3_tests: normalizeSourceRecord(
      parsedSources.s3_tests || {
        commit: row && "s3_tests_commit" in row ? row.s3_tests_commit : undefined,
      },
    ),
    mint: normalizeSourceRecord(
      parsedSources.mint || {
        commit: row && "mint_commit" in row ? row.mint_commit : undefined,
      },
    ),
  };
}

function executionFromRow(row: ParquetCatalogRunRow | ParquetMetadataRow | undefined): ExecutionInput | null {
  const execution = parseJsonObject<ExecutionInput>(row?.execution_json, {});
  return Object.keys(execution).length ? execution : null;
}

function summaryFromRow(row: Pick<ParquetSuiteRow | ParquetFeatureRow, "compatibility_rate"> & Record<string, unknown>): SummaryMetrics {
  return {
    compatibility_rate: asNullableRate(row.compatibility_rate),
    eligible: asNumber(row.eligible),
    passed: asNumber(row.passed),
    failed: asNumber(row.failed),
    errored: asNumber(row.errored),
    skipped: asNumber(row.skipped),
  };
}

function featureSummaryFromRow(row: ParquetFeatureRow): FeatureSummaryRecord {
  const name = asString(row.name);
  return {
    name,
    label: asString(row.label || name),
    summary: summaryFromRow(row),
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareFeatureRowsByImpact(left: ParquetFeatureRow, right: ParquetFeatureRow): number {
  const eligibleDelta = asNumber(right.eligible) - asNumber(left.eligible);
  if (eligibleDelta !== 0) {
    return eligibleDelta;
  }

  const leftRate = asNullableRate(left.compatibility_rate) ?? -1;
  const rightRate = asNullableRate(right.compatibility_rate) ?? -1;
  const rateDelta = leftRate - rightRate;
  if (rateDelta !== 0) {
    return rateDelta;
  }

  return compareText(asString(left.name), asString(right.name));
}

function caseFeatures(value: unknown): string[] {
  let entries: unknown[] | null = null;
  if (Array.isArray(value)) {
    entries = value;
  } else if (value && typeof value === "object" && "toArray" in value && typeof value.toArray === "function") {
    entries = (value.toArray as () => unknown[])();
  } else if (value && typeof value === "object" && Symbol.iterator in value) {
    entries = Array.from(value as Iterable<unknown>);
  }

  if (!entries) {
    return [];
  }
  return entries.map((entry) => asString(entry)).filter(Boolean);
}

function caseFromRow(row: ParquetCaseRow): StoredCaseEntry {
  return {
    name: asString(row.name),
    status: asString(row.status || "unknown"),
    classname: asString(row.classname),
    duration_ms: row.duration_ms === null || row.duration_ms === undefined ? null : asNumber(row.duration_ms),
    features: caseFeatures(row.features),
    message: asString(row.message),
    detail: asString(row.detail),
  };
}

function logFileFromRow(row: ParquetLogFileRow): LogFileRecord {
  return {
    run_id: asString(row.run_id),
    log_source: asString(row.log_source),
    log_file: asString(row.log_file),
    path: asString(row.path),
    line_count: asNumber(row.line_count),
  };
}

function logLineFromRow(row: ParquetLogLineRow): LogLineRecord {
  return {
    run_id: asOptionalString(row.run_id),
    log_source: asOptionalString(row.log_source),
    log_file: asOptionalString(row.log_file),
    line_number: asNumber(row.line_number),
    timestamp: timestampString(row.timestamp),
    level: asString(row.level),
    case_id: asOptionalString(row.case_id),
    component: asOptionalString(row.component),
    thread: asOptionalString(row.thread),
    logger: asOptionalString(row.logger),
    message: asOptionalString(row.message),
    raw_line: asString(row.raw_line),
    event_id: asOptionalString(row.event_id),
    exception_class: asOptionalString(row.exception_class),
    stacktrace_id: asOptionalString(row.stacktrace_id),
  };
}

function suiteFromRows(
  suiteRow: ParquetSuiteRow,
  featureRows: ParquetFeatureRow[],
  caseRows: ParquetCaseRow[] | null = null,
): SuiteRecord {
  const suite: SuiteRecord = {
    label: asString(suiteRow.label || suiteRow.suite_key),
    status: asString(suiteRow.status || "unknown"),
    summary: summaryFromRow(suiteRow),
    feature_summaries: [...featureRows].sort(compareFeatureRowsByImpact).map(featureSummaryFromRow),
  };
  const includedCaseStrategy = asOptionalString(suiteRow.included_case_strategy);
  if (includedCaseStrategy) {
    suite.included_case_strategy = includedCaseStrategy;
  }
  if (suiteRow.exit_code !== null && suiteRow.exit_code !== undefined) {
    suite.exit_code = asNumber(suiteRow.exit_code);
  }
  if (caseRows) {
    const cases = caseRows.map(caseFromRow);
    if (includedCaseStrategy === "non_passing_only") {
      suite.non_passing_cases = cases;
    } else {
      suite.cases = cases;
    }
  }
  return suite;
}

function groupBy<T>(rows: T[], keyForRow: (row: T) => string): Record<string, T[]> {
  return rows.reduce<Record<string, T[]>>((groups, row) => {
    const key = keyForRow(row);
    if (!key) {
      return groups;
    }
    groups[key] = groups[key] || [];
    groups[key].push(row);
    return groups;
  }, {});
}

function suiteOrderFromRows(suiteRows: ParquetSuiteRow[]): string[] {
  const suiteKeys = Array.from(new Set(suiteRows.map((row) => asString(row.suite_key)).filter(Boolean)));
  const preferred = ["s3_tests", "mint"].filter((suiteKey) => suiteKeys.includes(suiteKey));
  const remaining = suiteKeys.filter((suiteKey) => !preferred.includes(suiteKey)).sort();
  return [...preferred, ...remaining];
}

function detailBaseUrl(row: ParquetCatalogRunRow): string {
  const runId = asString(row.run_id);
  return asString(row.detail_base_url || `runs/${runId}/`).replace(/^\/+/, "");
}

function parquetDetailBaseUrl(row: ParquetCatalogRunRow): string {
  const detail = detailBaseUrl(row).replace(/\/?$/, "/");
  return detail.startsWith("data/") ? detail : `data/${detail}`;
}

function resolvedParquetDetailBaseUrl(indexPath: string, row: ParquetCatalogRunRow): string {
  return resolveParquetDataPath(indexPath, detailBaseUrl(row).replace(/\/?$/, "/"));
}

function jsonRunFile(row: ParquetCatalogRunRow): string {
  return `data/runs/${asString(row.run_id)}.json`;
}

function suiteMapForRun(
  runId: string,
  suiteRowsByRun: Record<string, ParquetSuiteRow[]>,
  featureRowsByRunSuite: Record<string, ParquetFeatureRow[]>,
  caseRowsBySuite: Record<string, ParquetCaseRow[]> | null = null,
): Record<string, SuiteRecord> {
  const suites: Record<string, SuiteRecord> = {};
  (suiteRowsByRun[runId] || []).forEach((suiteRow) => {
    const suiteKey = asString(suiteRow.suite_key);
    if (!suiteKey) {
      return;
    }
    const featureRows = featureRowsByRunSuite[`${runId}\0${suiteKey}`] || [];
    suites[suiteKey] = suiteFromRows(suiteRow, featureRows, caseRowsBySuite?.[suiteKey] || null);
  });
  return suites;
}

export function isParquetReportEnabled(search = "", envValue = ""): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const requestedFormat = params.get("data") || params.get("reportData");
  if (requestedFormat) {
    return requestedFormat.toLowerCase() === "parquet";
  }
  return envValue.toLowerCase() === "parquet";
}

export function resolveParquetDataPath(indexPath: string, relativePath: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(relativePath) || relativePath.startsWith("/")) {
    return relativePath;
  }

  const queryStart = indexPath.search(/[?#]/);
  const pathWithoutQuery = queryStart === -1 ? indexPath : indexPath.slice(0, queryStart);
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathWithoutQuery)) {
    const baseUrl = new URL(".", pathWithoutQuery);
    return new URL(relativePath, baseUrl).toString();
  }

  const lastSlash = pathWithoutQuery.lastIndexOf("/");
  const basePath = lastSlash === -1 ? "" : pathWithoutQuery.slice(0, lastSlash + 1);
  return `${basePath}${relativePath}`;
}

export function normalizeParquetIndex(input: NormalizeParquetIndexInput): IndexPayload {
  const suiteRowsByRun = groupBy(input.suiteRows, (row) => asString(row.run_id));
  const featureRowsByRunSuite = groupBy(input.featureRows, (row) => `${asString(row.run_id)}\0${asString(row.suite_key)}`);
  const suiteOrder = suiteOrderFromRows(input.suiteRows);
  const sortedCatalogRows = [...input.catalogRows].sort((left, right) =>
    timestampString(right.started_at).localeCompare(timestampString(left.started_at)),
  );

  const runs: RunSummary[] = sortedCatalogRows.map((row) => {
    const runId = asString(row.run_id);
    return {
      id: runId,
      run_id: runId,
      status: asString(row.status || "unknown"),
      started_at: timestampString(row.started_at),
      finished_at: timestampString(row.finished_at),
      workflow_run_url: asString(row.workflow_run_url),
      execution: executionFromRow(row),
      file: jsonRunFile(row),
      parquet_detail_base_url: parquetDetailBaseUrl(row),
      sources: sourcesFromRow(row),
      suites: suiteMapForRun(runId, suiteRowsByRun, featureRowsByRunSuite),
    };
  });

  const overall: Record<string, OverallChartPoint[]> = {};
  const features: Record<string, Record<string, FeatureChartPoint[]>> = {};
  [...sortedCatalogRows].reverse().forEach((row) => {
    const runId = asString(row.run_id);
    const startedAt = timestampString(row.started_at);
    (suiteRowsByRun[runId] || []).forEach((suiteRow) => {
      const suiteKey = asString(suiteRow.suite_key);
      overall[suiteKey] = overall[suiteKey] || [];
      overall[suiteKey].push({
        run_id: runId,
        started_at: startedAt,
        rate: asNullableRate(suiteRow.compatibility_rate),
        eligible: asNumber(suiteRow.eligible),
      });
    });
    input.featureRows
      .filter((featureRow) => asString(featureRow.run_id) === runId)
      .forEach((featureRow) => {
        const suiteKey = asString(featureRow.suite_key);
        const featureName = asString(featureRow.name);
        features[suiteKey] = features[suiteKey] || {};
        features[suiteKey][featureName] = features[suiteKey][featureName] || [];
        features[suiteKey][featureName].push({
          run_id: runId,
          started_at: startedAt,
          rate: asNullableRate(featureRow.compatibility_rate),
          eligible: asNumber(featureRow.eligible),
          passed: asNumber(featureRow.passed),
          failed: asNumber(featureRow.failed),
          errored: asNumber(featureRow.errored),
          skipped: asNumber(featureRow.skipped),
        });
      });
  });

  return {
    generated_at: runs[0]?.finished_at || runs[0]?.started_at || "",
    rate_formula: REPORT_RATE_FORMULA,
    suite_order: suiteOrder,
    runs,
    charts: {
      overall,
      features,
    },
  };
}

export function normalizeParquetRun(input: NormalizeParquetRunInput): FullRun {
  const metadata = input.metadataRows[0] || {};
  const runId = asString(metadata.run_id || input.summary.run_id || input.summary.id);
  const suiteRowsByRun = groupBy(input.suiteRows, (row) => asString(row.run_id || runId));
  const featureRowsByRunSuite = groupBy(input.featureRows, (row) => `${asString(row.run_id || runId)}\0${asString(row.suite_key)}`);
  const orchestration = parseJsonObject<Record<string, unknown>>(metadata.orchestration_json, {});

  return {
    schema_version: asNumber(metadata.schema_version, 1),
    run_id: runId,
    id: runId,
    started_at: timestampString(metadata.started_at) || input.summary.started_at,
    finished_at: timestampString(metadata.finished_at) || input.summary.finished_at,
    status: asString(metadata.status || input.summary.status || "unknown"),
    rate_formula: asString(metadata.rate_formula || REPORT_RATE_FORMULA),
    workflow_run_url: asString(metadata.workflow_run_url || input.summary.workflow_run_url),
    orchestration,
    execution: executionFromRow(metadata) || input.summary.execution || null,
    sources: sourcesFromRow(metadata) || input.summary.sources,
    suites: suiteMapForRun(runId, suiteRowsByRun, featureRowsByRunSuite, input.caseRowsBySuite),
    log_files: (input.logFileRows || []).map(logFileFromRow),
  };
}

function selectAllParquetSql(orderBy = ""): string {
  const orderClause = orderBy ? ` ORDER BY ${orderBy}` : "";
  return `SELECT * FROM read_parquet(${PARQUET_FILE_REF})${orderClause}`;
}

function suiteFileStem(suiteKey: string): string {
  return suiteKey.replace(/_/g, "-");
}

function detailPath(summary: RunSummary, relativePath: string): string {
  const basePath = (summary.parquet_detail_base_url || summary.file.replace(/\.json$/, "/")).replace(/\/?$/, "/");
  return `${basePath}${relativePath}`;
}

function dataRelativePath(summary: RunSummary, relativePath: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(relativePath) || relativePath.startsWith("/") || relativePath.startsWith("data/")) {
    return relativePath;
  }
  const runPrefix = `runs/${summary.run_id || summary.id}/`;
  if (relativePath.startsWith(runPrefix)) {
    const detailBase = (summary.parquet_detail_base_url || `data/${runPrefix}`).replace(/\/?$/, "/");
    return `${detailBase}${relativePath.slice(runPrefix.length)}`;
  }
  return `data/${relativePath}`;
}

function logLinesSql(limit: number): string {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 2000;
  return `SELECT * FROM read_parquet(${PARQUET_FILE_REF}) ORDER BY line_number LIMIT ${safeLimit}`;
}

export async function fetchParquetIndexPayload(indexPath: string, client: ParquetQueryClient): Promise<IndexPayload> {
  const [catalogRows, suiteRows, featureRows] = await Promise.all([
    client.queryRows<ParquetCatalogRunRow>(
      resolveParquetDataPath(indexPath, "catalog/runs.parquet"),
      selectAllParquetSql("started_at DESC"),
    ),
    client.queryRows<ParquetSuiteRow>(
      resolveParquetDataPath(indexPath, "catalog/suites.parquet"),
      selectAllParquetSql("run_id, suite_key"),
    ),
    client.queryRows<ParquetFeatureRow>(
      resolveParquetDataPath(indexPath, "catalog/features.parquet"),
      selectAllParquetSql("run_id, suite_key, name"),
    ),
  ]);
  const detailPathByRunId = new Map(catalogRows.map((row) => [asString(row.run_id), resolvedParquetDetailBaseUrl(indexPath, row)]));

  const payload = normalizeParquetIndex({
    catalogRows,
    suiteRows,
    featureRows,
  });
  payload.runs = payload.runs.map((run) => ({
    ...run,
    parquet_detail_base_url: detailPathByRunId.get(run.run_id || run.id) || run.parquet_detail_base_url,
  }));
  return payload;
}

export async function fetchParquetRunPayload(summary: RunSummary, client: ParquetQueryClient): Promise<FullRun> {
  const [metadataRows, suiteRows, featureRows] = await Promise.all([
    client.queryRows<ParquetMetadataRow>(detailPath(summary, "metadata.parquet"), selectAllParquetSql()),
    client.queryRows<ParquetSuiteRow>(detailPath(summary, "suites.parquet"), selectAllParquetSql("suite_key")),
    client.queryRows<ParquetFeatureRow>(detailPath(summary, "features.parquet"), selectAllParquetSql("suite_key, name")),
  ]);
  let logFileRows: ParquetLogFileRow[] = [];
  try {
    logFileRows = await client.queryRows<ParquetLogFileRow>(
      detailPath(summary, "log-files.parquet"),
      selectAllParquetSql("log_source, log_file"),
    );
  } catch {
    logFileRows = [];
  }
  const caseRowsBySuite: Record<string, ParquetCaseRow[]> = {};
  await Promise.all(
    suiteRows.map(async (suiteRow) => {
      const suiteKey = asString(suiteRow.suite_key);
      if (!suiteKey) {
        return;
      }
      caseRowsBySuite[suiteKey] = await client.queryRows<ParquetCaseRow>(
        detailPath(summary, `cases-${suiteFileStem(suiteKey)}.parquet`),
        selectAllParquetSql("classname, name"),
      );
    }),
  );

  return normalizeParquetRun({
    summary,
    metadataRows,
    suiteRows,
    featureRows,
    logFileRows,
    caseRowsBySuite,
  });
}

export async function fetchParquetLogLines(
  summary: RunSummary,
  logFile: LogFileRecord,
  client: ParquetQueryClient,
  limit = 2000,
): Promise<LogLineRecord[]> {
  const filePath = dataRelativePath(summary, logFile.path || `runs/${summary.run_id || summary.id}/logs-${logFile.log_source}.parquet`);
  const rows = await client.queryRows<ParquetLogLineRow>(filePath, logLinesSql(limit));
  return rows.map(logLineFromRow);
}
