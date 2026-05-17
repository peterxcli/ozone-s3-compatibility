import { Index, IndexedDB } from "flexsearch";
import type { Id } from "flexsearch";
import type { IndexPayload, RunSummary } from "./types";

const PARQUET_SEARCH_QUERY_CONCURRENCY = 6;

export interface SearchIndexRow {
  id: number;
  caseId?: string;
  suiteKey: string;
  suiteLabel: string;
  testName: string;
  classname: string;
  status: string;
  features: string[];
  message: string;
  detail: string;
  runId: string;
  runStartedAt: string;
  runFinishedAt?: string;
  runFile: string;
  isLatestRun: boolean;
  runOrdinal: number;
  sourceLanguage?: string;
  sourcePath?: string;
  sourceSymbol?: string;
  sourceRef?: string;
  sourceRepo?: string;
  sourceSnippet?: string;
  searchText: string;
}

export interface SearchIndexPayload {
  schema_version: number;
  generated_at: string;
  index_id: string;
  row_count: number;
  rows: SearchIndexRow[];
}

export interface PartitionedSearchIndexManifest {
  schema_version: number;
  partitioned: true;
  generated_at: string;
  index_id: string;
  row_count: number;
  partitions: {
    rows: string[];
  };
}

export interface SearchIndexRowsShard {
  rows: SearchIndexRow[];
}

export type SearchIndexBootstrapPayload = SearchIndexPayload | PartitionedSearchIndexManifest;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );

  return results;
}

export interface SearchResult {
  id: string;
  caseId?: string;
  suiteKey: string;
  suiteLabel: string;
  testName: string;
  classname?: string;
  status: string;
  features: string[];
  message: string;
  detail: string;
  runId: string;
  runStartedAt: string;
  runFinishedAt?: string;
  runFile: string;
  isLatestRun: boolean;
  sourceLanguage?: string;
  sourcePath?: string;
  sourceSymbol?: string;
  sourceRef?: string;
  sourceRepo?: string;
  sourceSnippet?: string;
  matchedFields: string[];
  score: number;
}

export interface SearchOptions {
  dedupe?: boolean;
}

export type SearchIndexLoadPhase =
  | "scheduled"
  | "downloading"
  | "opening-cache"
  | "checking-cache"
  | "indexing"
  | "saving-cache"
  | "ready"
  | "error";

export interface SearchIndexLoadProgress {
  phase: SearchIndexLoadPhase;
  indexedRows: number;
  totalRows: number;
  persistent: boolean;
  fromCache: boolean;
}

export interface SearchSessionOptions {
  onProgress?: (progress: SearchIndexLoadProgress) => void;
  progressBatchSize?: number;
}

export interface SearchSession {
  persistent: boolean;
  search: (query: string, suiteFilter?: string, limit?: number, options?: SearchOptions) => Promise<SearchResult[]>;
}

export interface SearchParquetQueryClient {
  queryRows<T extends Record<string, unknown>>(filePath: string, sql: string): Promise<T[]>;
}

export interface ParquetSearchRow extends Record<string, unknown> {
  run_id?: unknown;
  suite_key?: unknown;
  case_id?: unknown;
  status?: unknown;
  features?: unknown;
  test_name?: unknown;
  classname?: unknown;
  message?: unknown;
  detail_preview?: unknown;
  source_path?: unknown;
  source_symbol?: unknown;
  search_text?: unknown;
}

export interface NormalizeParquetSearchInput {
  generated_at?: string;
  runs: RunSummary[];
  rowsByRunId: Record<string, ParquetSearchRow[]>;
}

interface ParquetCaseDetailRow extends Record<string, unknown> {
  case_id?: unknown;
  name?: unknown;
  classname?: unknown;
  status?: unknown;
  duration_ms?: unknown;
  features?: unknown;
  message?: unknown;
  detail?: unknown;
  source_repo?: unknown;
  source_ref?: unknown;
  source_path?: unknown;
  source_symbol?: unknown;
}

interface SearchToken {
  text: string;
  compact: string;
}

interface SearchField {
  label: string;
  value: string;
  weight: number;
  normalized: string;
  compact: string;
}

interface RankedSearchResult extends SearchResult {
  runOrdinal: number;
  flexRank: number;
}

interface SearchDedupeInfo {
  key: string;
}

type SearchIndex = {
  add: (id: number, content: string) => unknown;
  search: (query: string, options?: { limit?: number }) => Id[] | Promise<Id[]>;
  contain: (id: number) => boolean | Promise<boolean>;
  clear: () => unknown;
  mount?: (storage: unknown) => Promise<void>;
  commit?: () => Promise<void>;
};

const SEARCH_DB_NAME = "ozone-s3-compatibility-search";
const SEARCH_STORAGE_KEY = "ozone-s3-compatibility-search-index-id";
const PARQUET_FILE_REF = "__PARQUET_FILE__";
const FIELD_ORDER = ["test name", "error message", "suite", "run", "source", "class", "feature", "status"];
const FIELD_WEIGHTS: Record<string, number> = {
  "test name": 80,
  "error message": 50,
  suite: 40,
  run: 30,
  source: 24,
  class: 15,
  feature: 10,
  status: 6,
};

const FLEXSEARCH_OPTIONS = {
  tokenize: "forward" as const,
  resolution: 9,
  cache: 100,
};
const DEFAULT_PROGRESS_BATCH_SIZE = 500;

async function fetchSearchJson<T>(path: string, errorMessage: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(errorMessage);
  }
  return (await response.json()) as T;
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function asStringArray(value: unknown): string[] {
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

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function suiteFileStem(suiteKey: string): string {
  return suiteKey.replace(/_/g, "-");
}

function parquetDetailPath(summary: Pick<RunSummary, "file" | "parquet_detail_base_url">, relativePath: string): string {
  const basePath = (summary.parquet_detail_base_url || summary.file.replace(/\.json$/, "/")).replace(/\/?$/, "/");
  return `${basePath}${relativePath}`;
}

function runIdForSummary(summary: Pick<RunSummary, "id" | "run_id">): string {
  return asString(summary.run_id || summary.id);
}

function sourceRef(summary: RunSummary, suiteKey: string): string {
  const source = summary.sources?.[suiteKey];
  const commit = asString(source?.commit);
  if (commit && commit !== "unknown") {
    return commit;
  }
  return asString(source?.ref);
}

function sourceRepo(summary: RunSummary, suiteKey: string): string {
  return asString(summary.sources?.[suiteKey]?.repo);
}

function sourceLanguage(suiteKey: string): string {
  if (suiteKey === "s3_tests") {
    return "python";
  }
  return suiteKey === "mint" ? "shell" : "text";
}

function fallbackSourceSnippet(suiteKey: string, suiteLabel: string, testName: string, classname: string): string {
  if (suiteKey === "mint") {
    return [
      "# Mint test case",
      classname ? `target=${classname}` : "",
      testName ? `function=${testName}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return `# ${suiteLabel} test case\n${testName}`.trim();
}

function isPartitionedSearchIndexPayload(
  payload: SearchIndexBootstrapPayload,
): payload is PartitionedSearchIndexManifest {
  return Boolean("partitioned" in payload && payload.partitioned && "partitions" in payload);
}

function resolveSearchIndexPartitionPath(indexPath: string, partitionPath: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(partitionPath) || partitionPath.startsWith("/")) {
    return partitionPath;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(indexPath)) {
    return new URL(partitionPath, indexPath).toString();
  }

  const queryStart = indexPath.search(/[?#]/);
  const pathWithoutQuery = queryStart === -1 ? indexPath : indexPath.slice(0, queryStart);
  const lastSlash = pathWithoutQuery.lastIndexOf("/");
  const basePath = lastSlash === -1 ? "" : indexPath.slice(0, lastSlash + 1);
  return `${basePath}${partitionPath}`;
}

export async function fetchSearchIndexPayload(indexPath: string): Promise<SearchIndexPayload> {
  const payload = await fetchSearchJson<SearchIndexBootstrapPayload>(indexPath, "Failed to load search index");
  if (!isPartitionedSearchIndexPayload(payload)) {
    return payload;
  }

  const rowShards = await Promise.all(
    payload.partitions.rows.map((path) =>
      fetchSearchJson<SearchIndexRowsShard>(
        resolveSearchIndexPartitionPath(indexPath, path),
        `Failed to load search index shard ${path}`,
      )
    )
  );
  const rows = rowShards.flatMap((shard) => shard.rows || []);

  return {
    schema_version: 1,
    generated_at: payload.generated_at,
    index_id: payload.index_id,
    row_count: payload.row_count || rows.length,
    rows,
  };
}

function parquetSearchSql(orderBy = ""): string {
  const orderClause = orderBy ? ` ORDER BY ${orderBy}` : "";
  return `SELECT * FROM read_parquet(${PARQUET_FILE_REF})${orderClause}`;
}

function caseDetailSql(caseId: string): string {
  return `SELECT * FROM read_parquet(${PARQUET_FILE_REF}) WHERE case_id = ${sqlString(caseId)} LIMIT 1`;
}

function parquetSearchText(row: SearchIndexRow, parquetSearchTextValue: unknown): string {
  return [
    asString(parquetSearchTextValue),
    row.suiteLabel,
    row.runId,
    row.runStartedAt,
    row.runFinishedAt,
    row.runFile,
    row.sourcePath,
    row.sourceSymbol,
    row.sourceRepo,
    row.sourceRef,
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeParquetSearchRow(
  row: ParquetSearchRow,
  summary: RunSummary,
  runOrdinal: number,
  rowId: number,
): SearchIndexRow {
  const runId = asString(row.run_id || runIdForSummary(summary));
  const suiteKey = asString(row.suite_key);
  const suiteLabel = asString(summary.suites?.[suiteKey]?.label || suiteKey.replace(/_/g, "-"));
  const testName = asString(row.test_name);
  const classname = asString(row.classname);
  const normalized: SearchIndexRow = {
    id: rowId,
    caseId: asString(row.case_id) || undefined,
    suiteKey,
    suiteLabel,
    testName,
    classname,
    status: asString(row.status || "unknown"),
    features: asStringArray(row.features),
    message: asString(row.message),
    detail: asString(row.detail_preview),
    runId,
    runStartedAt: asString(summary.started_at),
    runFinishedAt: asString(summary.finished_at || summary.started_at),
    runFile: asString(summary.file || `data/runs/${runId}.json`),
    isLatestRun: runOrdinal === 0,
    runOrdinal,
    sourceLanguage: sourceLanguage(suiteKey),
    sourcePath: asString(row.source_path),
    sourceSymbol: asString(row.source_symbol),
    sourceRef: sourceRef(summary, suiteKey),
    sourceRepo: sourceRepo(summary, suiteKey),
    sourceSnippet: suiteKey === "s3_tests" ? "" : fallbackSourceSnippet(suiteKey, suiteLabel, testName, classname),
    searchText: "",
  };
  normalized.searchText = parquetSearchText(normalized, row.search_text);
  return normalized;
}

export function normalizeParquetSearchIndex(input: NormalizeParquetSearchInput): SearchIndexPayload {
  const rows: SearchIndexRow[] = [];
  input.runs.forEach((summary, runOrdinal) => {
    const runId = runIdForSummary(summary);
    (input.rowsByRunId[runId] || []).forEach((row) => {
      rows.push(normalizeParquetSearchRow(row, summary, runOrdinal, rows.length + 1));
    });
  });

  const generatedAt =
    input.generated_at ||
    asString(input.runs[0]?.finished_at || input.runs[0]?.started_at);
  const digest = digestParts(
    rows.map((row) =>
      [
        row.runId,
        row.suiteKey,
        row.caseId || "",
        row.status,
        row.message,
        row.detail,
        row.searchText,
      ].join("\0")
    )
  );

  return {
    schema_version: 1,
    generated_at: generatedAt,
    index_id: `parquet-search-${generatedAt}-${rows.length}-${digest}`,
    row_count: rows.length,
    rows,
  };
}

export async function fetchParquetSearchIndexPayload(
  index: IndexPayload,
  client: SearchParquetQueryClient,
): Promise<SearchIndexPayload> {
  const rowSets = await mapWithConcurrency(index.runs, PARQUET_SEARCH_QUERY_CONCURRENCY, (summary) =>
    client.queryRows<ParquetSearchRow>(
      parquetDetailPath(summary, "search-rows.parquet"),
      parquetSearchSql("suite_key, classname, test_name"),
    ),
  );
  const rowsByRunId: Record<string, ParquetSearchRow[]> = {};
  index.runs.forEach((summary, index) => {
    rowsByRunId[runIdForSummary(summary)] = rowSets[index] || [];
  });

  return normalizeParquetSearchIndex({
    generated_at: index.generated_at,
    runs: index.runs,
    rowsByRunId,
  });
}

function normalizeText(value: string | null | undefined): string {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "");
}

function comparableText(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function comparableContentText(value: string | null | undefined): string {
  return comparableText(value)
    .replace(/0x[0-9a-f]+/g, "0x...")
    .replace(/\b([\w./-]+\.[a-z0-9]+):\d+/g, "$1:<line>");
}

function digestParts(parts: string[]): string {
  const content = parts.map((part) => `${part.length}:${part}`).join("|");
  let hash = 2166136261;

  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${content.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function searchTokens(query: string): SearchToken[] {
  return normalizeText(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => ({ text, compact: compactText(text) }));
}

function rowIdentityDigest(row: SearchIndexRow): string {
  const suiteKey = comparableText(row.suiteKey);
  const sourcePath = comparableText(row.sourcePath);
  const sourceSymbol = comparableText(row.sourceSymbol);

  if (sourcePath || sourceSymbol) {
    return digestParts(["source", suiteKey, sourcePath, sourceSymbol]);
  }

  return digestParts(["case", suiteKey, comparableText(row.classname), comparableText(row.testName)]);
}

function rowContentDigest(row: SearchIndexRow): string {
  const features = (row.features || []).map((feature) => comparableContentText(feature)).sort().join(" ");
  return digestParts([
    comparableContentText(row.status),
    features,
    comparableContentText(row.message),
    comparableContentText(row.detail),
    comparableContentText(row.sourceSnippet),
  ]);
}

function rowDedupeInfo(row: SearchIndexRow): SearchDedupeInfo {
  return {
    key: `${rowIdentityDigest(row)}:${rowContentDigest(row)}`,
  };
}

function makeField(label: string, value: string | null | undefined): SearchField {
  const normalized = normalizeText(value);
  return {
    label,
    value: String(value || ""),
    weight: FIELD_WEIGHTS[label] || 1,
    normalized,
    compact: compactText(normalized),
  };
}

function fieldMatchesToken(field: SearchField, token: SearchToken): boolean {
  if (/^\d{1,2}$/.test(token.text)) {
    return field.normalized.split(" ").includes(token.text);
  }
  return field.normalized.includes(token.text) || field.compact.includes(token.compact);
}

function rowFields(row: SearchIndexRow): SearchField[] {
  return [
    makeField("test name", row.testName),
    makeField("error message", `${row.message || ""} ${row.detail || ""}`),
    makeField("suite", `${row.suiteKey} ${row.suiteLabel}`),
    makeField("run", `${row.runId} ${row.runStartedAt} ${row.runFinishedAt || ""} ${row.runFile}`),
    makeField("source", `${row.sourcePath || ""} ${row.sourceSymbol || ""}`),
    makeField("class", row.classname),
    makeField("feature", (row.features || []).join(" ")),
    makeField("status", row.status),
  ];
}

function uniqueMatchedFields(fields: SearchField[], tokens: SearchToken[]): string[] {
  const matches = new Set<string>();
  fields.forEach((field) => {
    if (tokens.some((token) => fieldMatchesToken(field, token))) {
      matches.add(field.label);
    }
  });
  return FIELD_ORDER.filter((label) => matches.has(label));
}

function scoreMatch(fields: SearchField[], tokens: SearchToken[]): number {
  return fields.reduce((score, field) => {
    const tokenMatches = tokens.filter((token) => fieldMatchesToken(field, token)).length;
    if (!tokenMatches) return score;
    return score + field.weight + tokenMatches;
  }, 0);
}

function searchResultForRow(row: SearchIndexRow, tokens: SearchToken[], flexRank: number): RankedSearchResult {
  const fields = rowFields(row);
  return {
    id: String(row.id),
    caseId: row.caseId,
    suiteKey: row.suiteKey,
    suiteLabel: row.suiteLabel,
    testName: row.testName,
    classname: row.classname,
    status: row.status,
    features: row.features || [],
    message: row.message || "",
    detail: row.detail || "",
    runId: row.runId,
    runStartedAt: row.runStartedAt,
    runFinishedAt: row.runFinishedAt,
    runFile: row.runFile,
    isLatestRun: row.isLatestRun,
    sourceLanguage: row.sourceLanguage,
    sourcePath: row.sourcePath,
    sourceSymbol: row.sourceSymbol,
    sourceRef: row.sourceRef,
    sourceRepo: row.sourceRepo,
    sourceSnippet: row.sourceSnippet,
    matchedFields: uniqueMatchedFields(fields, tokens),
    score: scoreMatch(fields, tokens),
    runOrdinal: row.runOrdinal,
    flexRank,
  };
}

function summaryForSearchResult(
  result: Pick<SearchResult, "runId" | "runFile">,
  index: Pick<IndexPayload, "runs">,
): RunSummary | null {
  return index.runs.find((summary) => runIdForSummary(summary) === result.runId || summary.file === result.runFile) || null;
}

function hydratedSourceSnippet(result: SearchResult, row: ParquetCaseDetailRow): string {
  if (result.suiteKey === "s3_tests") {
    return "";
  }
  return (
    result.sourceSnippet ||
    fallbackSourceSnippet(
      result.suiteKey,
      result.suiteLabel,
      asString(row.name || result.testName),
      asString(row.classname || result.classname),
    )
  );
}

export async function hydrateParquetSearchResultDetail(
  result: SearchResult,
  index: Pick<IndexPayload, "runs">,
  client: SearchParquetQueryClient,
): Promise<SearchResult> {
  const caseId = asString(result.caseId);
  if (!caseId) {
    return result;
  }

  const summary = summaryForSearchResult(result, index);
  if (!summary) {
    return result;
  }

  const rows = await client.queryRows<ParquetCaseDetailRow>(
    parquetDetailPath(summary, `cases-${suiteFileStem(result.suiteKey)}.parquet`),
    caseDetailSql(caseId),
  );
  const row = rows[0];
  if (!row) {
    return result;
  }

  return {
    ...result,
    testName: asString(row.name || result.testName),
    classname: asString(row.classname || result.classname),
    status: asString(row.status || result.status || "unknown"),
    features: asStringArray(row.features).length ? asStringArray(row.features) : result.features,
    message: asString(row.message || result.message),
    detail: asString(row.detail || result.detail),
    sourceRepo: asString(row.source_repo || result.sourceRepo),
    sourceRef: asString(row.source_ref || result.sourceRef),
    sourcePath: asString(row.source_path || result.sourcePath),
    sourceSymbol: asString(row.source_symbol || result.sourceSymbol),
    sourceLanguage: result.sourceLanguage || sourceLanguage(result.suiteKey),
    sourceSnippet: hydratedSourceSnippet(result, row),
  };
}

function rowsById(payload: SearchIndexPayload): Map<number, SearchIndexRow> {
  return new Map(payload.rows.map((row) => [row.id, row]));
}

function dedupeInfoById(payload: SearchIndexPayload): Map<number, SearchDedupeInfo> {
  return new Map(payload.rows.map((row) => [row.id, rowDedupeInfo(row)]));
}

function removeDuplicateHistory(
  results: RankedSearchResult[],
  dedupeById: Map<number, SearchDedupeInfo>,
): RankedSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = dedupeById.get(Number(result.id))?.key;
    if (!key) {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function progressBatchSize(options: SearchSessionOptions): number {
  const batchSize = Number(options.progressBatchSize || DEFAULT_PROGRESS_BATCH_SIZE);
  return Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : DEFAULT_PROGRESS_BATCH_SIZE;
}

function reportProgress(options: SearchSessionOptions, progress: SearchIndexLoadProgress): void {
  options.onProgress?.(progress);
}

async function yieldToBrowser(): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

async function addRowsToIndex(
  index: SearchIndex,
  rows: SearchIndexRow[],
  options: SearchSessionOptions,
  persistent: boolean,
): Promise<void> {
  const batchSize = progressBatchSize(options);
  const shouldReportProgress = Boolean(options.onProgress);

  if (!rows.length) {
    reportProgress(options, {
      phase: "indexing",
      indexedRows: 0,
      totalRows: 0,
      persistent,
      fromCache: false,
    });
    return;
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    await Promise.resolve(index.add(row.id, row.searchText));

    const indexedRows = rowIndex + 1;
    if (indexedRows % batchSize === 0 || indexedRows === rows.length) {
      reportProgress(options, {
        phase: "indexing",
        indexedRows,
        totalRows: rows.length,
        persistent,
        fromCache: false,
      });
      if (shouldReportProgress) {
        await yieldToBrowser();
      }
    }
  }
}

function safeGetStoredIndexId(): string {
  try {
    return window.localStorage.getItem(SEARCH_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function safeSetStoredIndexId(indexId: string): void {
  try {
    window.localStorage.setItem(SEARCH_STORAGE_KEY, indexId);
  } catch {
    // Search still works without localStorage; it just hydrates again when needed.
  }
}

function browserSupportsIndexedDB(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

async function hydratePersistentIndex(
  index: SearchIndex,
  payload: SearchIndexPayload,
  options: SearchSessionOptions,
): Promise<void> {
  const firstRowId = payload.rows[0]?.id;
  const storedIndexId = safeGetStoredIndexId();
  reportProgress(options, {
    phase: "checking-cache",
    indexedRows: 0,
    totalRows: payload.rows.length,
    persistent: true,
    fromCache: false,
  });
  const hasFirstRow = firstRowId === undefined ? true : await Promise.resolve(index.contain(firstRowId));

  if (storedIndexId === payload.index_id && hasFirstRow) {
    reportProgress(options, {
      phase: "ready",
      indexedRows: payload.rows.length,
      totalRows: payload.rows.length,
      persistent: true,
      fromCache: true,
    });
    return;
  }

  await Promise.resolve(index.clear());
  await addRowsToIndex(index, payload.rows, options, true);
  reportProgress(options, {
    phase: "saving-cache",
    indexedRows: payload.rows.length,
    totalRows: payload.rows.length,
    persistent: true,
    fromCache: false,
  });
  await index.commit?.();
  safeSetStoredIndexId(payload.index_id);
  reportProgress(options, {
    phase: "ready",
    indexedRows: payload.rows.length,
    totalRows: payload.rows.length,
    persistent: true,
    fromCache: false,
  });
}

function createSearchSession(payload: SearchIndexPayload, index: SearchIndex, persistent: boolean): SearchSession {
  const byId = rowsById(payload);
  const rowDedupeById = dedupeInfoById(payload);

  return {
    persistent,
    async search(query: string, suiteFilter = "all", limit = 120, options: SearchOptions = {}): Promise<SearchResult[]> {
      const tokens = searchTokens(query);
      if (!tokens.length) {
        return [];
      }

      const ids = await Promise.resolve(index.search(query, { limit: payload.rows.length }));
      const ranked: RankedSearchResult[] = [];

      ids.forEach((id, flexRank) => {
        const row = byId.get(Number(id));
        if (!row || (suiteFilter !== "all" && row.suiteKey !== suiteFilter)) {
          return;
        }
        ranked.push(searchResultForRow(row, tokens, flexRank));
      });

      const sorted = ranked.sort((left, right) => {
        if (left.runOrdinal !== right.runOrdinal) {
          return left.runOrdinal - right.runOrdinal;
        }
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.flexRank !== right.flexRank) {
          return left.flexRank - right.flexRank;
        }
        if (left.suiteLabel !== right.suiteLabel) {
          return left.suiteLabel.localeCompare(right.suiteLabel);
        }
        return left.testName.localeCompare(right.testName);
      });

      const visible = options.dedupe === false ? sorted : removeDuplicateHistory(sorted, rowDedupeById);

      return visible
        .slice(0, limit)
        .map(({ runOrdinal: _runOrdinal, flexRank: _flexRank, ...result }) => result);
    },
  };
}

export async function createInMemorySearchSession(
  payload: SearchIndexPayload,
  options: SearchSessionOptions = {},
): Promise<SearchSession> {
  const index = new Index(FLEXSEARCH_OPTIONS) as unknown as SearchIndex;
  await addRowsToIndex(index, payload.rows, options, false);
  reportProgress(options, {
    phase: "ready",
    indexedRows: payload.rows.length,
    totalRows: payload.rows.length,
    persistent: false,
    fromCache: false,
  });
  return createSearchSession(payload, index, false);
}

export async function createPersistentSearchSession(
  payload: SearchIndexPayload,
  options: SearchSessionOptions = {},
): Promise<SearchSession> {
  if (!browserSupportsIndexedDB()) {
    return createInMemorySearchSession(payload, options);
  }

  try {
    const index = new Index({ ...FLEXSEARCH_OPTIONS, commit: false }) as unknown as SearchIndex;

    reportProgress(options, {
      phase: "opening-cache",
      indexedRows: 0,
      totalRows: payload.rows.length,
      persistent: true,
      fromCache: false,
    });
    await index.mount?.(new IndexedDB(SEARCH_DB_NAME));
    await hydratePersistentIndex(index, payload, options);
    return createSearchSession(payload, index, true);
  } catch (error) {
    console.warn("Falling back to in-memory search index after IndexedDB setup failed.", error);
    return createInMemorySearchSession(payload, options);
  }
}
