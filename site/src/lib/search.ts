import type { IndexPayload, RunSummary } from "./types";

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

export type SearchIndexLoadPhase = "loading-engine" | "opening-index" | "ready" | "error";

export interface SearchIndexLoadProgress {
  phase: SearchIndexLoadPhase;
  rowCount: number;
}

export interface CaseSearchFetchStats {
  requests: number;
  bytesFetched: number;
  cacheHits: number;
}

/** A DataFusion session that can read Parquet files over HTTP. */
export interface CaseSearchClient {
  registerParquet(table: string, url: string): Promise<void>;
  queryRows<T extends Record<string, unknown>>(sql: string): Promise<T[]>;
  stats(): CaseSearchFetchStats;
}

/** Creates a client whose HTTP requests use the given cache mode. */
export type CaseSearchClientFactory = (cache: RequestCache) => Promise<CaseSearchClient>;

/** The WebAssembly `CaseSearchEngine` class exported by `case-search/`. */
export interface CaseSearchEngineHandle {
  registerParquet(table: string, url: string): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  stats(): unknown;
}

export interface CaseSearchSessionOptions {
  index: Pick<IndexPayload, "runs">;
  /** Absolute URL of `data/search/cases.parquet`. */
  searchCasesUrl: string;
  createClient: CaseSearchClientFactory;
  onProgress?: (progress: SearchIndexLoadProgress) => void;
}

export interface SearchSession {
  /** Distinct searchable cases: one per test and failure, across all runs. */
  rowCount: number;
  search: (query: string, suiteFilter?: string, limit?: number) => Promise<SearchResult[]>;
  stats: () => CaseSearchFetchStats;
}

export interface SearchParquetQueryClient {
  queryRows<T extends Record<string, unknown>>(filePath: string, sql: string): Promise<T[]>;
}

export interface SearchCaseRow extends Record<string, unknown> {
  content_id?: unknown;
  suite_key?: unknown;
  case_id?: unknown;
  test_name?: unknown;
  classname?: unknown;
  status?: unknown;
  features?: unknown;
  message?: unknown;
  detail_preview?: unknown;
  source_path?: unknown;
  source_symbol?: unknown;
  run_id?: unknown;
  run_ordinal?: unknown;
  score?: unknown;
}

/** A query token that matches the metadata (id, dates, source commits) of some runs. */
export interface RunTokenMatch {
  token: string;
  runIds: string[];
}

export interface CaseSearchSqlInput {
  tokens: string[];
  suiteFilter?: string;
  limit: number;
  runTokens?: RunTokenMatch[];
  /** Every run id, newest first; run tokens are ignored without them. */
  runIds?: string[];
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
  normalized: string;
  compact: string;
}

export const SEARCH_CASES_TABLE = "search_cases";
export const STALE_SEARCH_INDEX_MESSAGE = "remote file changed while reading";
const PARQUET_FILE_REF = "__PARQUET_FILE__";
const MAX_QUERY_TOKENS = 12;
const FIELD_ORDER = ["test name", "error message", "suite", "run", "source", "class", "feature", "status"];

// Ranking weights per field. Run metadata is the same for every result in a
// run, and results are ordered by run first, so it never changes the order.
const SCORED_FIELDS: { weight: number; columns: string[] }[] = [
  { weight: 80, columns: ["test_name"] },
  { weight: 50, columns: ["message", "detail_preview"] },
  { weight: 40, columns: ["suite_key"] },
  { weight: 24, columns: ["source_path", "source_symbol"] },
  { weight: 15, columns: ["classname"] },
  { weight: 6, columns: ["status"] },
];

const RESULT_COLUMNS = [
  "content_id",
  "suite_key",
  "case_id",
  "test_name",
  "classname",
  "status",
  "features",
  "message",
  "detail_preview",
  "source_path",
  "source_symbol",
];

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

function sourceRef(summary: RunSummary | undefined, suiteKey: string): string {
  const source = summary?.sources?.[suiteKey];
  const commit = asString(source?.commit);
  if (commit && commit !== "unknown") {
    return commit;
  }
  return asString(source?.ref);
}

function sourceRepo(summary: RunSummary | undefined, suiteKey: string): string {
  return asString(summary?.sources?.[suiteKey]?.repo);
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

function isShortNumber(token: string): boolean {
  return /^\d{1,2}$/.test(token);
}

/** Lowercase alphanumeric query words, matching how `search_text` is built. */
export function searchQueryTokens(query: string): string[] {
  return Array.from(new Set(normalizeText(query).split(" ").filter(Boolean))).slice(0, MAX_QUERY_TOKENS);
}

function searchTokens(tokens: string[]): SearchToken[] {
  return tokens.map((text) => ({ text, compact: compactText(text) }));
}

function makeField(label: string, value: string | null | undefined): SearchField {
  const normalized = normalizeText(value);
  return { label, normalized, compact: compactText(normalized) };
}

function fieldMatchesToken(field: SearchField, token: SearchToken): boolean {
  if (isShortNumber(token.text)) {
    return field.normalized.split(" ").includes(token.text);
  }
  return field.normalized.includes(token.text) || field.compact.includes(token.compact);
}

function resultFields(result: SearchResult): SearchField[] {
  return [
    makeField("test name", result.testName),
    makeField("error message", `${result.message || ""} ${result.detail || ""}`),
    makeField("suite", `${result.suiteKey} ${result.suiteLabel}`),
    makeField("run", `${result.runId} ${result.runStartedAt} ${result.runFinishedAt || ""}`),
    makeField("source", `${result.sourcePath || ""} ${result.sourceSymbol || ""}`),
    makeField("class", result.classname),
    makeField("feature", (result.features || []).join(" ")),
    makeField("status", result.status),
  ];
}

function matchedFieldsForResult(result: SearchResult, tokens: SearchToken[]): string[] {
  const matches = new Set(
    resultFields(result)
      .filter((field) => tokens.some((token) => fieldMatchesToken(field, token)))
      .map((field) => field.label),
  );
  return FIELD_ORDER.filter((label) => matches.has(label));
}

function runSearchWords(summary: RunSummary): string[] {
  const commits = Object.keys(summary.sources || {}).map((suiteKey) => sourceRef(summary, suiteKey));
  return normalizeText([runIdForSummary(summary), summary.started_at, summary.finished_at, ...commits].join(" ")).split(" ");
}

/** Finds query tokens that name runs, such as a run id, date, or source commit. */
export function runTokenMatches(tokens: string[], runs: RunSummary[]): RunTokenMatch[] {
  const runWords = runs.map((summary) => ({ runId: runIdForSummary(summary), words: runSearchWords(summary) }));
  return tokens
    .map((token) => ({
      token,
      runIds: runWords
        .filter(({ words }) =>
          words.some((word) => (isShortNumber(token) ? word === token : word.startsWith(token))),
        )
        .map(({ runId }) => runId),
    }))
    .filter(({ runIds }) => runIds.length > 0);
}

/** `search_text` holds space-delimited words, so this is a word-prefix match. */
function tokenCondition(token: string): string {
  const pattern = isShortNumber(token) ? `% ${token} %` : `% ${token}%`;
  return `search_text LIKE ${sqlString(pattern)}`;
}

function scoreSql(tokens: string[]): string {
  return SCORED_FIELDS.map(({ weight, columns }) => {
    const matches = tokens.map(
      (token) => `(${columns.map((column) => `COALESCE(${column}, '') ILIKE ${sqlString(`%${token}%`)}`).join(" OR ")})`,
    );
    const counts = matches.map((match) => `CAST(${match} AS INT)`).join(" + ");
    return `(CASE WHEN ${matches.join(" OR ")} THEN ${weight} ELSE 0 END + ${counts})`;
  }).join(" + ");
}

function suiteCondition(suiteFilter = "all"): string[] {
  return suiteFilter && suiteFilter !== "all" ? [`suite_key = ${sqlString(suiteFilter)}`] : [];
}

function positiveLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
}

/**
 * Builds the DataFusion query. Filters on `search_text` are pushed into the
 * Parquet scan, so only pages holding matches are fetched for other columns.
 */
export function buildCaseSearchSql({ tokens, suiteFilter = "all", limit, runTokens = [], runIds = [] }: CaseSearchSqlInput): string {
  // A token naming every run is satisfied by any case, like "2026" in a date.
  // A token naming some runs is satisfied by the case text or by those runs.
  const knownRunTokens = runIds.length ? runTokens : [];
  const runTokenSet = new Set(knownRunTokens.map(({ token }) => token));
  const narrowingTokens = knownRunTokens.filter(({ runIds: matching }) => matching.length < runIds.length);
  const contentConditions = [
    ...suiteCondition(suiteFilter),
    ...tokens.filter((token) => !runTokenSet.has(token)).map(tokenCondition),
  ];
  const where = contentConditions.length ? `WHERE ${contentConditions.join(" AND ")}` : "";
  const score = scoreSql(tokens);
  const safeLimit = positiveLimit(limit);

  if (!narrowingTokens.length) {
    return [
      `SELECT ${RESULT_COLUMNS.join(", ")}, latest_run_id AS run_id, latest_run_ordinal AS run_ordinal, ${score} AS score`,
      `FROM ${SEARCH_CASES_TABLE}`,
      where,
      "ORDER BY run_ordinal, score DESC, suite_key, test_name, content_id",
      `LIMIT ${safeLimit}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Tokens that name runs may be satisfied by the case text or by the run a
  // case appeared in. Expand each case into its runs and keep the newest run
  // that satisfies every such token.
  const tokenFlags = narrowingTokens.map(({ token }, index) => `${tokenCondition(token)} AS token_${index}`);
  const occurrenceConditions = narrowingTokens.map(
    ({ runIds: matchingRunIds }, index) =>
      `(token_${index} OR occurrences.run_id IN (${matchingRunIds.map(sqlString).join(", ")}))`,
  );
  const runOrdinals = runIds.map((runId, ordinal) => `(${sqlString(runId)}, ${ordinal})`).join(", ");
  const tokenColumns = narrowingTokens.map((_, index) => `token_${index}`).join(", ");

  return [
    "WITH candidates AS (",
    `  SELECT ${RESULT_COLUMNS.join(", ")}, run_ids, ${score} AS score, ${tokenFlags.join(", ")}`,
    `  FROM ${SEARCH_CASES_TABLE}`,
    where ? `  ${where}` : "",
    "), occurrences AS (",
    `  SELECT content_id, unnest(run_ids) AS run_id, ${tokenColumns} FROM candidates`,
    "), matched AS (",
    "  SELECT occurrences.content_id, MIN(runs.run_ordinal) AS run_ordinal",
    `  FROM occurrences JOIN (VALUES ${runOrdinals}) AS runs(run_id, run_ordinal) ON occurrences.run_id = runs.run_id`,
    `  WHERE ${occurrenceConditions.join(" AND ")}`,
    "  GROUP BY occurrences.content_id",
    ")",
    `SELECT ${RESULT_COLUMNS.map((column) => `candidates.${column}`).join(", ")}, matched.run_ordinal, candidates.score`,
    "FROM candidates JOIN matched ON candidates.content_id = matched.content_id",
    "ORDER BY matched.run_ordinal, candidates.score DESC, candidates.suite_key, candidates.test_name, candidates.content_id",
    `LIMIT ${safeLimit}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Converts a search row into a displayable result. Rows carry either the run
 * id (newest occurrence) or the ordinal of a run in `runs` (run-token queries).
 */
export function searchResultFromRow(row: SearchCaseRow, runs: RunSummary[], tokens: string[]): SearchResult {
  const rowRunId = asString(row.run_id);
  const summary = rowRunId
    ? runs.find((candidate) => runIdForSummary(candidate) === rowRunId)
    : runs[Number(row.run_ordinal)];
  const runId = rowRunId || (summary ? runIdForSummary(summary) : "");
  const suiteKey = asString(row.suite_key);
  const suiteLabel = asString(summary?.suites?.[suiteKey]?.label || suiteFileStem(suiteKey));
  const testName = asString(row.test_name);
  const classname = asString(row.classname);

  const result: SearchResult = {
    id: `search:${asString(row.content_id)}`,
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
    runStartedAt: asString(summary?.started_at),
    runFinishedAt: asString(summary?.finished_at || summary?.started_at),
    runFile: asString(summary?.file || (runId ? `data/runs/${runId}.json` : "")),
    isLatestRun: Boolean(summary) && summary === runs[0],
    sourceLanguage: sourceLanguage(suiteKey),
    sourcePath: asString(row.source_path),
    sourceSymbol: asString(row.source_symbol),
    sourceRef: sourceRef(summary, suiteKey),
    sourceRepo: sourceRepo(summary, suiteKey),
    sourceSnippet: suiteKey === "s3_tests" ? "" : fallbackSourceSnippet(suiteKey, suiteLabel, testName, classname),
    matchedFields: [],
    score: Number(row.score) || 0,
  };
  result.matchedFields = matchedFieldsForResult(result, searchTokens(tokens));
  return result;
}

export function caseSearchClientFromEngine(engine: CaseSearchEngineHandle): CaseSearchClient {
  return {
    async registerParquet(table, url) {
      await engine.registerParquet(table, url);
    },
    async queryRows<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
      return JSON.parse(asString(await engine.query(sql))) as T[];
    },
    stats() {
      const stats = (engine.stats() || {}) as Partial<CaseSearchFetchStats>;
      return {
        requests: Number(stats.requests) || 0,
        bytesFetched: Number(stats.bytesFetched) || 0,
        cacheHits: Number(stats.cacheHits) || 0,
      };
    },
  };
}

function isStaleIndexError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes(STALE_SEARCH_INDEX_MESSAGE);
}

function reportProgress(options: CaseSearchSessionOptions, progress: SearchIndexLoadProgress): void {
  options.onProgress?.(progress);
}

/**
 * Opens the published search cases file in DataFusion. Nothing is downloaded
 * up front beyond the Parquet footer; each search fetches the byte ranges it
 * needs and keeps them in memory for later searches.
 */
export async function createCaseSearchSession(options: CaseSearchSessionOptions): Promise<SearchSession> {
  reportProgress(options, { phase: "loading-engine", rowCount: 0 });
  let client = await options.createClient("default");

  async function open(nextClient: CaseSearchClient): Promise<number> {
    await nextClient.registerParquet(SEARCH_CASES_TABLE, options.searchCasesUrl);
    const rows = await nextClient.queryRows<{ row_count?: unknown }>(
      `SELECT COUNT(*) AS row_count FROM ${SEARCH_CASES_TABLE}`,
    );
    return Number(rows[0]?.row_count) || 0;
  }

  // A republished file must not be mixed with bytes already cached from the
  // old one; start over with a fresh engine that bypasses the HTTP cache.
  async function withFreshIndexOnChange<T>(run: (current: CaseSearchClient) => Promise<T>): Promise<T> {
    try {
      return await run(client);
    } catch (error) {
      if (!isStaleIndexError(error)) {
        throw error;
      }
      client = await options.createClient("reload");
      session.rowCount = await open(client);
      return run(client);
    }
  }

  const session: SearchSession = {
    rowCount: 0,
    async search(query: string, suiteFilter = "all", limit = 120): Promise<SearchResult[]> {
      const tokens = searchQueryTokens(query);
      if (!tokens.length) {
        return [];
      }

      const runs = options.index.runs || [];
      const sql = buildCaseSearchSql({
        tokens,
        suiteFilter,
        limit,
        runTokens: runTokenMatches(tokens, runs),
        runIds: runs.map(runIdForSummary),
      });
      const rows = await withFreshIndexOnChange((current) => current.queryRows<SearchCaseRow>(sql));
      return rows.map((row) => searchResultFromRow(row, runs, tokens));
    },
    stats: () => client.stats(),
  };

  reportProgress(options, { phase: "opening-index", rowCount: 0 });
  session.rowCount = await withFreshIndexOnChange(open);
  reportProgress(options, { phase: "ready", rowCount: session.rowCount });
  return session;
}

// Parametrized tests share a case id; prefer the exact test that was shown.
function caseDetailSql(caseId: string, testName: string): string {
  return [
    `SELECT * FROM read_parquet(${PARQUET_FILE_REF})`,
    `WHERE case_id = ${sqlString(caseId)}`,
    `ORDER BY name = ${sqlString(testName)} DESC`,
    "LIMIT 1",
  ].join(" ");
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

/** Replaces the search preview with the full case detail from the run's case file. */
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
    caseDetailSql(caseId, result.testName),
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
