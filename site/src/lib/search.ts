import { Index, IndexedDB } from "flexsearch";
import type { Id } from "flexsearch";

export interface SearchIndexRow {
  id: number;
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

export interface SearchResult {
  id: string;
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

export interface SearchSession {
  persistent: boolean;
  search: (query: string, suiteFilter?: string, limit?: number, options?: SearchOptions) => Promise<SearchResult[]>;
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
  const features = (row.features || []).map((feature) => comparableText(feature)).sort().join(" ");
  return digestParts([
    comparableText(row.status),
    features,
    comparableText(row.message),
    comparableText(row.detail),
    comparableText(row.sourceSnippet),
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

function addRowsToIndex(index: SearchIndex, rows: SearchIndexRow[]): void {
  rows.forEach((row) => {
    index.add(row.id, row.searchText);
  });
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

async function hydratePersistentIndex(index: SearchIndex, payload: SearchIndexPayload): Promise<void> {
  const firstRowId = payload.rows[0]?.id;
  const storedIndexId = safeGetStoredIndexId();
  const hasFirstRow = firstRowId === undefined ? true : await Promise.resolve(index.contain(firstRowId));

  if (storedIndexId === payload.index_id && hasFirstRow) {
    return;
  }

  await Promise.resolve(index.clear());
  addRowsToIndex(index, payload.rows);
  await index.commit?.();
  safeSetStoredIndexId(payload.index_id);
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

export async function createInMemorySearchSession(payload: SearchIndexPayload): Promise<SearchSession> {
  const index = new Index(FLEXSEARCH_OPTIONS) as unknown as SearchIndex;
  addRowsToIndex(index, payload.rows);
  return createSearchSession(payload, index, false);
}

export async function createPersistentSearchSession(payload: SearchIndexPayload): Promise<SearchSession> {
  if (!browserSupportsIndexedDB()) {
    return createInMemorySearchSession(payload);
  }

  try {
    const index = new Index({ ...FLEXSEARCH_OPTIONS, commit: false }) as unknown as SearchIndex;

    await index.mount?.(new IndexedDB(SEARCH_DB_NAME));
    await hydratePersistentIndex(index, payload);
    return createSearchSession(payload, index, true);
  } catch (error) {
    console.warn("Falling back to in-memory search index after IndexedDB setup failed.", error);
    return createInMemorySearchSession(payload);
  }
}
