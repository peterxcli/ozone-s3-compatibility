<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import HistoryItem from "./components/HistoryItem.vue";
import EmbeddedParquetViewer from "./components/EmbeddedParquetViewer.vue";
import ParquetFileBrowser from "./components/ParquetFileBrowser.vue";
import RunDetails from "./components/RunDetails.vue";
import TrendPanel from "./components/TrendPanel.vue";
import {
  extractPythonSnippet,
  githubBlobUrl,
  githubRawUrl,
  highlightCode,
} from "./lib/sourceSnippet";
import {
  SEARCH_SECTION_HASH,
  caseIdentityForResult,
  parseSharedCaseIdentity,
  parseSearchShareState,
  resultMatchesSharedCase,
  runDetailCaseUrlFromState,
  searchUrlFromState,
} from "./lib/shareState";
import {
  archivedRunAnchorId,
  deltaForSuite,
  fetchReportIndex,
  fetchReportRun,
  formatDate,
  formatPercent,
  orderedSuitesFromRun,
  runScope,
  scrollElementIntoView,
  statusClass,
  summarizeFeatureComparisons,
  suiteLabel,
} from "./lib/report";
import { fetchParquetLogLines, isParquetReportEnabled } from "./lib/parquetReport";
import { fetchParquetFileLineage } from "./lib/parquetFiles";
import { storedCaseSearchResult } from "./lib/caseResult";
import {
  createPersistentSearchSession,
  fetchParquetSearchIndexPayload,
  fetchSearchIndexPayload,
  hydrateParquetSearchResultDetail,
} from "./lib/search";
import { highlightSearchMatch } from "./lib/searchHighlight";
import type {
  FeatureComparisonSummary,
  FullRun,
  HistoryTogglePayload,
  IndexPayload,
  LogFileRecord,
  LogLineRecord,
  OrderedSuiteEntry,
  RunLike,
  RunSummary,
  StoredCaseEntry,
  SuiteRecord,
} from "./lib/types";
import type { ParquetFileRecord, ParquetFileTreeNode } from "./lib/parquetFiles";
import type { ParquetQueryClient } from "./lib/parquetReport";
import type { ReportDataFetchOptions } from "./lib/report";
import type { SearchIndexLoadProgress, SearchIndexPayload, SearchResult, SearchSession } from "./lib/search";
import type { SharedCaseIdentity } from "./lib/shareState";
import type { ParquetCacheMode } from "./lib/duckdbParquetQueryClient";

interface SummaryCard {
  key: string;
  label: string;
  eligible: number;
  rate: number | null;
  passed: number;
  failedOrErrored: number;
  skipped: number;
  delta: number | null;
  featureMovement: FeatureComparisonSummary;
}

interface SuiteSummaryEntry extends OrderedSuiteEntry {
  featureMovement: FeatureComparisonSummary;
}

interface NavigationOptions {
  expandArchived?: boolean;
}

interface TrendPanelExposed {
  renderCharts: () => void;
  resizeCharts: () => void;
}

interface CaseSnippetState {
  loading: boolean;
  text: string;
  language: string;
  sourceUrl: string;
  error: string;
  startLine: number | null;
}

interface SelectedLogState {
  summary: RunSummary;
  logFile: LogFileRecord;
}

const SEARCH_RESULT_LIMIT = 120;

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const loading = ref<boolean>(true);
const errorMessage = ref<string>("");
const index = ref<IndexPayload | null>(null);
const latestRun = ref<FullRun | null>(null);
const latestRunLoading = ref<boolean>(false);
const latestRunError = ref<string>("");
const trendPanelOpen = ref<boolean>(false);
const archivedMenuOpen = ref<boolean>(false);
const pendingNavigationTarget = ref<string>("");
const searchQuery = ref<string>("");
const searchSuiteFilter = ref<string>("all");
const searchIndexPayload = ref<SearchIndexPayload | null>(null);
const searchSession = ref<SearchSession | null>(null);
const searchResults = ref<SearchResult[]>([]);
const searchLoading = ref<boolean>(false);
const searchIndexProgress = ref<SearchIndexLoadProgress | null>(null);
const searchError = ref<string>("");
const selectedSearchResult = ref<SearchResult | null>(null);
const selectedSearchResultOrigin = ref<"search" | "run-detail">("search");
const selectedLog = ref<SelectedLogState | null>(null);
const selectedLogLines = ref<LogLineRecord[]>([]);
const selectedLogLoading = ref<boolean>(false);
const selectedLogError = ref<string>("");
const parquetFiles = ref<ParquetFileRecord[]>([]);
const parquetFileGraph = ref<ParquetFileTreeNode[]>([]);
const parquetFilesLoading = ref<boolean>(false);
const parquetFilesError = ref<string>("");
const selectedParquetFile = ref<ParquetFileRecord | null>(null);
const parquetInspectorOpen = ref<boolean>(false);
const caseSnippet = reactive<CaseSnippetState>({
  loading: false,
  text: "",
  language: "text",
  sourceUrl: "",
  error: "",
  startLine: null,
});
let searchRequestSequence = 0;
let snippetRequestSequence = 0;
let logRequestSequence = 0;
let applyingSharedUrlState = false;
let searchSessionPromise: Promise<SearchSession | null> | null = null;
const parquetReportEnabled = isParquetReportEnabled(
  window.location.search,
  import.meta.env.VITE_REPORT_DATA_FORMAT || "",
);
const reportDataBaseUrl = normalizedReportDataBaseUrl(
  new URLSearchParams(window.location.search).get("dataBaseUrl") ||
    import.meta.env.VITE_REPORT_DATA_BASE_URL ||
    "./data/",
);
const parquetCacheMode = normalizedParquetCacheMode(
  new URLSearchParams(window.location.search).get("cacheFs") ||
    new URLSearchParams(window.location.search).get("duckdbCache") ||
    import.meta.env.VITE_DUCKDB_CACHE_MODE ||
    "direct",
);
const reportIndexPath = `${reportDataBaseUrl}index.json`;
let parquetClientPromise: Promise<ParquetQueryClient | null> | null = null;

const expandedHistory = reactive<Record<string, boolean>>({});
const runDetailsById = reactive<Record<string, FullRun | undefined>>({});
const runLoading = reactive<Record<string, boolean>>({});
const runErrors = reactive<Record<string, string>>({});

const archivedDropdown = ref<HTMLElement | null>(null);
const trendPanelRef = ref<TrendPanelExposed | null>(null);
const caseModalBackdrop = ref<HTMLElement | null>(null);

let modalTouchY = 0;

const hasRuns = computed(() => Boolean(index.value?.runs?.length));
const latestSummary = computed<RunSummary | null>(() => index.value?.runs?.[0] || null);
const latestScope = computed(() =>
  latestSummary.value ? runScope(latestSummary.value) : { kind: "unknown", label: "Run inputs unavailable" }
);
const archivedSummaries = computed<RunSummary[]>(() => index.value?.runs?.slice(1) || []);
const suiteOrder = computed<string[]>(() => index.value?.suite_order || []);
const trimmedSearchQuery = computed<string>(() => searchQuery.value.trim());
const searchActive = computed<boolean>(() => trimmedSearchQuery.value.length > 0);
const searchIndexLoaded = computed<boolean>(() => Boolean(searchSession.value));
const searchIndexProgressVisible = computed<boolean>(() => {
  const progress = searchIndexProgress.value;
  return Boolean(progress && progress.phase !== "ready" && progress.phase !== "error");
});
const searchIndexProgressPercent = computed<number | null>(() => {
  const progress = searchIndexProgress.value;
  if (!progress || progress.totalRows <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((progress.indexedRows / progress.totalRows) * 100)));
});
const searchIndexProgressText = computed<string>(() => {
  const progress = searchIndexProgress.value;
  const rowCount = progress?.totalRows || searchIndexPayload.value?.row_count || 0;
  const totalRows = rowCount.toLocaleString();
  const indexedRows = (progress?.indexedRows || 0).toLocaleString();

  if (!progress) {
    return searchIndexLoaded.value && searchIndexPayload.value
      ? `${searchIndexPayload.value.row_count.toLocaleString()} cases indexed ${
          searchSession.value?.persistent ? "in IndexedDB" : "in memory"
        }`
      : "Search index loads when you search.";
  }

  if (progress.phase === "scheduled") {
    return "Search index load scheduled.";
  }
  if (progress.phase === "downloading") {
    return "Downloading search index.";
  }
  if (progress.phase === "opening-cache") {
    return "Opening browser search cache.";
  }
  if (progress.phase === "checking-cache") {
    return "Checking browser search cache.";
  }
  if (progress.phase === "indexing") {
    const location = progress.persistent ? "into IndexedDB" : "in memory";
    return `Indexing ${indexedRows} of ${totalRows} cases ${location}.`;
  }
  if (progress.phase === "saving-cache") {
    return `Saving ${totalRows} indexed cases to browser cache.`;
  }
  if (progress.phase === "ready") {
    if (progress.fromCache) {
      return `${totalRows} cases ready from IndexedDB cache.`;
    }
    return `${totalRows} cases indexed ${progress.persistent ? "in IndexedDB" : "in memory"}.`;
  }

  return "Search index load failed.";
});
const searchResultSummary = computed<string>(() => {
  const count = searchResults.value.length;
  const suffix = count === SEARCH_RESULT_LIMIT ? " shown" : "";
  return `${count} match${count === 1 ? "" : "es"}${suffix}`;
});
const highlightedSearchSnippet = computed<string>(() => highlightCode(caseSnippet.text, caseSnippet.language));
const selectedSearchPermalink = computed<string>(() =>
  selectedSearchResult.value ? permalinkForSelectedResult(selectedSearchResult.value) : ""
);
const selectedSearchFields = computed<{ label: string; value: string }[]>(() => {
  const result = selectedSearchResult.value;
  if (!result) return [];

  return [
    { label: "Suite", value: result.suiteLabel },
    { label: "Status", value: String(result.status || "unknown").replace(/_/g, " ") },
    { label: "Run ID", value: result.runId },
    { label: "Started", value: formatDate(result.runStartedAt) },
    { label: "Finished", value: result.runFinishedAt ? formatDate(result.runFinishedAt) : "" },
    { label: "Class", value: result.classname || "" },
    { label: "Source path", value: result.sourcePath || "" },
    { label: "Source symbol", value: result.sourceSymbol || "" },
    { label: "Source ref", value: result.sourceRef || "" },
    { label: "Matched fields", value: (result.matchedFields || []).join(", ") },
    { label: "Features", value: (result.features || []).map((feature) => feature.replace(/_/g, " ")).join(", ") },
  ].filter((field) => field.value);
});
const selectedLogText = computed<string>(() => selectedLogLines.value.map((line) => line.raw_line).join("\n"));
const parquetFilesNote = computed<string>(() => {
  if (!parquetReportEnabled) {
    return "Available when Parquet report data is enabled.";
  }
  if (parquetFilesLoading.value) {
    return "Loading published Parquet manifest.";
  }
  if (parquetFilesError.value) {
    return "Manifest load failed.";
  }
  return `${parquetFiles.value.length.toLocaleString()} published Parquet files`;
});

const summaryCards = computed<SummaryCard[]>(() => {
  const latest = latestSummary.value;
  const currentIndex = index.value;
  if (!latest || !currentIndex) return [];

  const cards: SummaryCard[] = [];
  suiteOrder.value.forEach((suiteKey) => {
    const suite = latest.suites?.[suiteKey];
    if (!suite) return;
    const previousSuite = currentIndex.runs[1]?.suites?.[suiteKey] || null;

    cards.push({
      key: suiteKey,
      label: suite.label,
      eligible: suite.summary.eligible,
      rate: suite.summary.compatibility_rate,
      passed: suite.summary.passed,
      failedOrErrored: suite.summary.failed + suite.summary.errored,
      skipped: suite.summary.skipped,
      delta: deltaForSuite(currentIndex.runs, suiteKey),
      featureMovement: summarizeFeatureComparisons(suite, previousSuite),
    });
  });

  return cards;
});

const latestSuiteSummaries = computed<SuiteSummaryEntry[]>(() => {
  const latest = latestSummary.value;
  if (!latest) return [];

  return orderedSuitesFromRun(latest, suiteOrder.value).map((entry) => ({
    ...entry,
    featureMovement: summarizeFeatureComparisons(entry.suite, index.value?.runs?.[1]?.suites?.[entry.key] || null),
  }));
});

watch([trimmedSearchQuery, searchSuiteFilter], () => {
  if (!applyingSharedUrlState) {
    syncSearchUrl();
  }
  void refreshSearchResults();
});

function deltaClass(delta: number | null): string {
  if (delta === null) return "flat";
  return delta >= 0 ? "good" : "bad";
}

function deltaText(delta: number | null): string {
  if (delta === null) return "No previous data";
  return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts vs previous`;
}

function featureCountText(count: number, state: "improved" | "degraded"): string {
  return `${count} feature${count === 1 ? "" : "s"} ${state}`;
}

function highlightSearchResultText(value: string | null | undefined): string {
  return highlightSearchMatch(value, trimmedSearchQuery.value);
}

function normalizedReportDataBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "./data/";
  }
  return trimmed.replace(/\/?$/, "/");
}

function normalizedParquetCacheMode(value: string | null | undefined): ParquetCacheMode {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (normalized === "auto" || normalized === "on_disk" || normalized === "in_mem") {
    return normalized;
  }
  return "direct";
}

function historyRun(summaryId: string): FullRun | null {
  return runDetailsById[summaryId] || null;
}

function previousSummaryForRunOrdinal(runOrdinal: number): RunSummary | null {
  return index.value?.runs?.[runOrdinal + 1] || null;
}

function comparisonRunForRunOrdinal(runOrdinal: number): RunLike | null {
  const previousSummary = previousSummaryForRunOrdinal(runOrdinal);
  if (!previousSummary) {
    return null;
  }
  return runDetailsById[previousSummary.id] || previousSummary;
}

function historyRunLoading(summaryId: string): boolean {
  return Boolean(runLoading[summaryId]);
}

function historyRunError(summaryId: string): string {
  return runErrors[summaryId] || "";
}

function isHistoryExpanded(summaryId: string): boolean {
  return Boolean(expandedHistory[summaryId]);
}

async function bootstrap(): Promise<void> {
  try {
    const fetchOptions = await reportDataOptions();
    index.value = await fetchReportIndex(reportIndexPath, fetchOptions);
    loading.value = false;
    void loadParquetFiles();

    if (!hasRuns.value) {
      return;
    }

    await nextTick();
    const searchStateApplied = await applySearchUrlState();
    const runDetailStateApplied = searchStateApplied ? false : await applyRunDetailUrlState();

    const target = pendingNavigationTarget.value || window.location.hash.slice(1);
    if (target && !runDetailStateApplied && (!searchStateApplied || target !== SEARCH_SECTION_HASH.slice(1))) {
      await nextTick();
      await navigateToSection(target, { expandArchived: true });
    }
  } catch (error) {
    errorMessage.value = errorMessageOf(error);
    loading.value = false;
  }
}

async function loadLatestRun(): Promise<void> {
  if (!latestSummary.value) return;
  if (latestRun.value || latestRunLoading.value) return;

  latestRunLoading.value = true;
  latestRunError.value = "";
  try {
    latestRun.value = await fetchReportRun(latestSummary.value, await reportDataOptions());
  } catch (error) {
    latestRunError.value = errorMessageOf(error);
  } finally {
    latestRunLoading.value = false;
  }
}

async function ensureHistoryRunLoaded(summary: RunSummary): Promise<void> {
  if (!summary || runDetailsById[summary.id] || runLoading[summary.id]) {
    return;
  }

  runErrors[summary.id] = "";
  runLoading[summary.id] = true;

  try {
    runDetailsById[summary.id] = await fetchReportRun(summary, await reportDataOptions());
  } catch (error) {
    runErrors[summary.id] = errorMessageOf(error);
  } finally {
    runLoading[summary.id] = false;
  }
}

async function reportDataOptions(): Promise<ReportDataFetchOptions> {
  if (!parquetReportEnabled) {
    return { parquet: false, parquetClient: null };
  }
  if (!parquetClientPromise) {
    parquetClientPromise = import("./lib/duckdbParquetQueryClient")
      .then((module) => module.createDuckDbParquetQueryClient({ cacheMode: parquetCacheMode }))
      .catch(() => null);
  }
  return {
    parquet: true,
    parquetClient: await parquetClientPromise,
  };
}

async function ensureSearchSession(): Promise<SearchSession | null> {
  if (searchSession.value) {
    return searchSession.value;
  }
  if (searchSessionPromise) {
    return searchSessionPromise;
  }

  searchSessionPromise = (async () => {
    searchLoading.value = true;
    searchError.value = "";

    try {
      searchIndexProgress.value = {
        phase: "downloading",
        indexedRows: 0,
        totalRows: searchIndexPayload.value?.row_count || 0,
        persistent: true,
        fromCache: false,
      };
      const payload =
        searchIndexPayload.value ||
        (await fetchReportSearchIndexPayload());
      searchIndexPayload.value = payload;
      searchSession.value = await createPersistentSearchSession(payload, {
        onProgress: (progress) => {
          searchIndexProgress.value = progress;
        },
      });
      return searchSession.value;
    } catch (error) {
      searchError.value = errorMessageOf(error);
      searchIndexProgress.value = {
        phase: "error",
        indexedRows: 0,
        totalRows: searchIndexPayload.value?.row_count || 0,
        persistent: true,
        fromCache: false,
      };
      return null;
    } finally {
      searchLoading.value = false;
      searchSessionPromise = null;
    }
  })();

  return searchSessionPromise;
}

async function fetchReportSearchIndexPayload(): Promise<SearchIndexPayload> {
  const currentIndex = index.value;
  const fetchOptions = await reportDataOptions();

  if (fetchOptions.parquet && fetchOptions.parquetClient && currentIndex) {
    try {
      return await fetchParquetSearchIndexPayload(
        currentIndex,
        fetchOptions.parquetClient,
        `${reportDataBaseUrl}search/index.parquet`,
      );
    } catch (error) {
      console.warn("Falling back to JSON search index after Parquet search load failed.", error);
    }
  }

  return fetchSearchIndexPayload(`${reportDataBaseUrl}search-index.json`);
}

async function loadParquetFiles(): Promise<void> {
  if (!parquetReportEnabled || parquetFilesLoading.value) {
    return;
  }

  parquetFilesLoading.value = true;
  parquetFilesError.value = "";
  try {
    const fetchOptions = await reportDataOptions();
    if (!fetchOptions.parquet || !fetchOptions.parquetClient) {
      throw new Error("Parquet file browsing requires Parquet report data.");
    }
    const lineage = await fetchParquetFileLineage(reportDataBaseUrl, fetchOptions.parquetClient);
    parquetFiles.value = lineage.files;
    parquetFileGraph.value = lineage.graph;
    if (selectedParquetFile.value && !parquetFiles.value.some((file) => file.path === selectedParquetFile.value?.path)) {
      selectedParquetFile.value = null;
      parquetInspectorOpen.value = false;
      unlockPageScrollIfNoModal();
    }
  } catch (error) {
    parquetFiles.value = [];
    parquetFileGraph.value = [];
    parquetFilesError.value = errorMessageOf(error);
    selectedParquetFile.value = null;
    parquetInspectorOpen.value = false;
    unlockPageScrollIfNoModal();
  } finally {
    parquetFilesLoading.value = false;
  }
}

function openParquetInspector(): void {
  if (!selectedParquetFile.value) {
    return;
  }
  parquetInspectorOpen.value = true;
  lockPageScroll();
}

function closeParquetInspector(): void {
  parquetInspectorOpen.value = false;
  unlockPageScrollIfNoModal();
}

function selectParquetFile(file: ParquetFileRecord): void {
  selectedParquetFile.value = file;
  openParquetInspector();
}

async function refreshSearchResults(): Promise<void> {
  const requestId = ++searchRequestSequence;
  const query = trimmedSearchQuery.value;
  const suiteFilter = searchSuiteFilter.value;

  if (!query) {
    searchResults.value = [];
    return;
  }

  const session = await ensureSearchSession();
  if (
    requestId !== searchRequestSequence ||
    query !== trimmedSearchQuery.value ||
    suiteFilter !== searchSuiteFilter.value
  ) {
    return;
  }
  if (!session) {
    searchResults.value = [];
    return;
  }

  searchLoading.value = true;
  searchError.value = "";
  try {
    const results = await session.search(query, suiteFilter, SEARCH_RESULT_LIMIT);
    if (
      requestId === searchRequestSequence &&
      query === trimmedSearchQuery.value &&
      suiteFilter === searchSuiteFilter.value
    ) {
      searchResults.value = results;
    }
  } catch (error) {
    if (
      requestId === searchRequestSequence &&
      query === trimmedSearchQuery.value &&
      suiteFilter === searchSuiteFilter.value
    ) {
      searchResults.value = [];
      searchError.value = errorMessageOf(error);
    }
  } finally {
    if (requestId === searchRequestSequence) {
      searchLoading.value = false;
    }
  }
}

function clearSearch(): void {
  if (selectedSearchResult.value) {
    closeSearchResultModal({ syncUrl: false });
  }
  searchQuery.value = "";
  searchSuiteFilter.value = "all";
  searchResults.value = [];
  syncSearchUrl(null);
}

function retrySearchLoad(): void {
  searchSession.value = null;
  searchSessionPromise = null;
  searchError.value = "";
  void refreshSearchResults();
}

function currentRelativeUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function normalizedSuiteFilter(value: string): string {
  return value === "all" || suiteOrder.value.includes(value) ? value : "all";
}

function searchUrlForResult(
  result: SearchResult,
  options: { includeCurrentSearch?: boolean } = {},
): string {
  const { includeCurrentSearch = true } = options;
  return searchUrlFromState(
    {
      query: includeCurrentSearch ? trimmedSearchQuery.value : "",
      suiteFilter: includeCurrentSearch ? searchSuiteFilter.value : "all",
      selectedCase: caseIdentityForResult(result),
    },
    window.location.href,
  );
}

function runDetailHashForResult(result: SearchResult): string {
  const runIndex = index.value?.runs.findIndex(
    (summary) => summary.id === result.runId || summary.run_id === result.runId || summary.file === result.runFile
  );
  if (runIndex === 0) {
    return "latest-run-section";
  }
  if (runIndex !== undefined && runIndex > 0 && index.value) {
    return archivedRunAnchorId(index.value.runs[runIndex], runIndex - 1);
  }
  return window.location.hash.slice(1) || "latest-run-section";
}

function runDetailCaseUrlForResult(result: SearchResult): string {
  return runDetailCaseUrlFromState(
    {
      selectedCase: caseIdentityForResult(result),
      hash: runDetailHashForResult(result),
    },
    window.location.href,
  );
}

function permalinkForSelectedResult(result: SearchResult): string {
  if (selectedSearchResultOrigin.value === "run-detail") {
    return runDetailCaseUrlForResult(result);
  }
  return searchUrlForResult(result, { includeCurrentSearch: true });
}

function syncSearchUrl(result: SearchResult | null = selectedSearchResult.value, mode: "replace" | "push" = "replace"): void {
  if (applyingSharedUrlState) {
    return;
  }

  const nextUrl = searchUrlFromState(
    {
      query: trimmedSearchQuery.value,
      suiteFilter: searchSuiteFilter.value,
      selectedCase: result ? caseIdentityForResult(result) : null,
    },
    window.location.href,
  );

  if (nextUrl === currentRelativeUrl()) {
    return;
  }

  if (mode === "push") {
    window.history.pushState(null, "", nextUrl);
    return;
  }
  window.history.replaceState(null, "", nextUrl);
}

async function openSharedSearchCase(selectedCase: SharedCaseIdentity): Promise<void> {
  const session = await ensureSearchSession();
  if (!session) {
    return;
  }

  const candidates = await session.search(
    selectedCase.testName,
    selectedCase.suiteKey || "all",
    Math.max(SEARCH_RESULT_LIMIT, 500),
    { dedupe: false },
  );
  const result = candidates.find((candidate) => resultMatchesSharedCase(candidate, selectedCase));
  if (!result) {
    searchError.value = `Could not find shared test case ${selectedCase.testName} in run ${selectedCase.runId}.`;
    return;
  }

  openSearchResultModal(result, { syncUrl: false });
}

function isSearchUrlState(shareState = parseSearchShareState(window.location.href)): boolean {
  const hash = window.location.hash;
  return Boolean(shareState.query || (shareState.selectedCase && hash === SEARCH_SECTION_HASH));
}

async function applySearchUrlState(): Promise<boolean> {
  const shareState = parseSearchShareState(window.location.href);

  if (!isSearchUrlState(shareState)) {
    if (selectedSearchResult.value) {
      closeSearchResultModal({ syncUrl: false });
    }
    return false;
  }

  applyingSharedUrlState = true;
  searchQuery.value = shareState.query;
  searchSuiteFilter.value = normalizedSuiteFilter(shareState.suiteFilter);
  applyingSharedUrlState = false;

  await refreshSearchResults();
  await navigateToSection(SEARCH_SECTION_HASH.slice(1));

  if (shareState.selectedCase) {
    await openSharedSearchCase(shareState.selectedCase);
  } else if (selectedSearchResult.value) {
    closeSearchResultModal({ syncUrl: false });
  }

  return true;
}

function findSummaryByRunId(runId: string): { runIndex: number; summary: RunSummary } | null {
  const runIndex = index.value?.runs.findIndex((summary) => summary.id === runId || summary.run_id === runId) ?? -1;
  if (!index.value || runIndex < 0) {
    return null;
  }
  return { runIndex, summary: index.value.runs[runIndex] };
}

async function loadRunForSharedCase(summary: RunSummary, runIndex: number): Promise<FullRun | null> {
  if (runIndex === 0) {
    await loadLatestRun();
    return latestRun.value;
  }

  expandedHistory[summary.id] = true;
  await ensureHistoryRunLoaded(summary);
  return runDetailsById[summary.id] || null;
}

function storedCasesForSuite(suite: SuiteRecord): StoredCaseEntry[] {
  return suite.cases || suite.non_passing_cases || [];
}

function findRunDetailCaseResult(
  run: FullRun,
  summary: RunSummary,
  selectedCase: SharedCaseIdentity,
  runIndex: number,
): SearchResult | null {
  const suiteKeys = selectedCase.suiteKey ? [selectedCase.suiteKey] : Object.keys(run.suites || {});

  for (const suiteKey of suiteKeys) {
    const suite = run.suites?.[suiteKey];
    if (!suite) {
      continue;
    }
    for (const caseEntry of storedCasesForSuite(suite)) {
      const result = storedCaseSearchResult({
        run,
        suiteKey,
        suite,
        caseEntry,
        runFile: summary.file,
        isLatestRun: runIndex === 0,
      });
      if (resultMatchesSharedCase(result, selectedCase)) {
        return result;
      }
    }
  }

  return null;
}

async function applyRunDetailUrlState(): Promise<boolean> {
  const selectedCase = parseSharedCaseIdentity(window.location.href);
  if (!selectedCase) {
    return false;
  }

  const target = findSummaryByRunId(selectedCase.runId);
  if (!target) {
    return false;
  }

  const run = await loadRunForSharedCase(target.summary, target.runIndex);
  if (!run) {
    return false;
  }

  const result = findRunDetailCaseResult(run, target.summary, selectedCase, target.runIndex);
  if (!result) {
    runErrors[target.summary.id] = `Could not find shared test case ${selectedCase.testName} in run ${selectedCase.runId}.`;
    return false;
  }

  await navigateToSection(window.location.hash.slice(1) || runDetailHashForResult(result), { expandArchived: true });
  openSearchResultModal(result, { syncUrl: false, origin: "run-detail" });
  return true;
}

function lockPageScroll(): void {
  if (document.body.classList.contains("modal-open")) {
    return;
  }
  document.body.classList.add("modal-open");
}

function unlockPageScroll(): void {
  if (!document.body.classList.contains("modal-open")) {
    return;
  }
  document.body.classList.remove("modal-open");
}

function unlockPageScrollIfNoModal(): void {
  if (selectedSearchResult.value || selectedLog.value || parquetInspectorOpen.value) {
    return;
  }
  unlockPageScroll();
}

function canScrollElementInDirection(element: HTMLElement, deltaY: number): boolean {
  const maxScrollTop = element.scrollHeight - element.clientHeight;
  if (maxScrollTop <= 1) {
    return false;
  }
  if (deltaY < 0) {
    return element.scrollTop > 0;
  }
  if (deltaY > 0) {
    return element.scrollTop < maxScrollTop - 1;
  }
  return false;
}

function isScrollableModalElement(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return (overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight + 1;
}

function modalElementFromEventTarget(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) {
    return target;
  }
  if (target instanceof Node && target.parentElement instanceof HTMLElement) {
    return target.parentElement;
  }
  return null;
}

function canScrollInsideModal(backdrop: HTMLElement | null, target: EventTarget | null, deltaY: number): boolean {
  if (!backdrop || deltaY === 0) {
    return false;
  }

  let element = modalElementFromEventTarget(target);
  if (!element || !backdrop.contains(element)) {
    element = backdrop;
  }

  while (element && backdrop.contains(element)) {
    if (isScrollableModalElement(element) && canScrollElementInDirection(element, deltaY)) {
      return true;
    }
    if (element === backdrop) {
      break;
    }
    element = element.parentElement;
  }

  return false;
}

function preventModalBoundaryOverscroll(event: Event, deltaY: number): void {
  const backdrop = event.currentTarget instanceof HTMLElement ? event.currentTarget : caseModalBackdrop.value;
  if (deltaY === 0 || canScrollInsideModal(backdrop, event.target, deltaY)) {
    return;
  }
  if (event.cancelable) {
    event.preventDefault();
  }
}

function handleModalBackdropWheel(event: WheelEvent): void {
  preventModalBoundaryOverscroll(event, event.deltaY);
}

function handleModalBackdropTouchStart(event: TouchEvent): void {
  modalTouchY = event.touches[0]?.clientY ?? 0;
}

function handleModalBackdropTouchMove(event: TouchEvent): void {
  if (event.touches.length !== 1) {
    return;
  }
  const nextTouchY = event.touches[0]?.clientY ?? modalTouchY;
  const deltaY = modalTouchY - nextTouchY;
  modalTouchY = nextTouchY;
  preventModalBoundaryOverscroll(event, deltaY);
}

function fallbackSnippetForResult(result: SearchResult): string {
  if (result.sourceSnippet) {
    return result.sourceSnippet;
  }

  const lines = [
    result.sourcePath ? `# Source file: ${result.sourcePath}` : "",
    result.sourceSymbol ? `# Test symbol: ${result.sourceSymbol}` : "",
    result.message ? `# Message: ${result.message}` : "",
    !result.sourcePath && result.testName ? result.testName : "",
  ];
  return lines.filter(Boolean).join("\n") || "Source snippet unavailable.";
}

function resetCaseSnippet(result: SearchResult | null = null): void {
  caseSnippet.loading = false;
  caseSnippet.text = result ? fallbackSnippetForResult(result) : "";
  caseSnippet.language = result?.sourceLanguage || "text";
  caseSnippet.sourceUrl = "";
  caseSnippet.error = "";
  caseSnippet.startLine = null;
}

async function loadSearchResultSnippet(result: SearchResult, requestId: number): Promise<void> {
  resetCaseSnippet(result);

  const rawUrl =
    result.sourceRepo && result.sourceRef && result.sourcePath
      ? githubRawUrl(result.sourceRepo, result.sourceRef, result.sourcePath)
      : null;

  if (!rawUrl) {
    return;
  }

  caseSnippet.loading = true;
  caseSnippet.sourceUrl = githubBlobUrl(result.sourceRepo || "", result.sourceRef || "", result.sourcePath || "") || rawUrl;

  try {
    const response = await fetch(rawUrl);
    if (!response.ok) {
      throw new Error(`Source fetch failed with HTTP ${response.status}`);
    }

    const source = await response.text();
    const extracted =
      result.sourceLanguage === "python" && result.sourceSymbol
        ? extractPythonSnippet(source, result.sourceSymbol)
        : { text: source.split(/\r?\n/).slice(0, 80).join("\n"), startLine: 1 };

    if (requestId !== snippetRequestSequence || selectedSearchResult.value?.id !== result.id) {
      return;
    }

    caseSnippet.text = extracted.text || fallbackSnippetForResult(result);
    caseSnippet.startLine = extracted.startLine;
    caseSnippet.sourceUrl =
      githubBlobUrl(result.sourceRepo || "", result.sourceRef || "", result.sourcePath || "", extracted.startLine) ||
      rawUrl;
  } catch (error) {
    if (requestId !== snippetRequestSequence || selectedSearchResult.value?.id !== result.id) {
      return;
    }
    caseSnippet.error = errorMessageOf(error);
    caseSnippet.text = fallbackSnippetForResult(result);
  } finally {
    if (requestId === snippetRequestSequence && selectedSearchResult.value?.id === result.id) {
      caseSnippet.loading = false;
    }
  }
}

async function hydrateSelectedSearchResultDetail(result: SearchResult, requestId: number): Promise<void> {
  const currentIndex = index.value;
  if (!result.caseId || !currentIndex) {
    return;
  }

  const fetchOptions = await reportDataOptions();
  if (!fetchOptions.parquet || !fetchOptions.parquetClient) {
    return;
  }

  try {
    const hydrated = await hydrateParquetSearchResultDetail(result, currentIndex, fetchOptions.parquetClient);
    if (requestId === snippetRequestSequence && selectedSearchResult.value?.id === result.id) {
      selectedSearchResult.value = {
        ...selectedSearchResult.value,
        ...hydrated,
      };
    }
  } catch (error) {
    console.warn("Could not hydrate Parquet case detail.", error);
  }
}

function openSearchResultModal(
  result: SearchResult,
  options: { syncUrl?: boolean; origin?: "search" | "run-detail" } = {},
): void {
  const { syncUrl = true, origin = "search" } = options;
  lockPageScroll();
  selectedSearchResultOrigin.value = origin;
  selectedSearchResult.value = result;
  const requestId = ++snippetRequestSequence;
  void hydrateSelectedSearchResultDetail(result, requestId);
  void loadSearchResultSnippet(result, requestId);
  if (syncUrl) {
    syncSearchUrl(result, "push");
  }
}

function closeSearchResultModal(options: { syncUrl?: boolean } = {}): void {
  const { syncUrl = true } = options;
  selectedSearchResult.value = null;
  selectedSearchResultOrigin.value = "search";
  snippetRequestSequence += 1;
  resetCaseSnippet();
  unlockPageScrollIfNoModal();
  if (syncUrl) {
    syncSearchUrl(null);
  }
}

function openRunDetailCaseModal(result: SearchResult): void {
  openSearchResultModal(result, { syncUrl: false, origin: "run-detail" });
}

function closeLogModal(): void {
  selectedLog.value = null;
  selectedLogLines.value = [];
  selectedLogLoading.value = false;
  selectedLogError.value = "";
  logRequestSequence += 1;
  unlockPageScrollIfNoModal();
}

async function openRunLogModal(summary: RunSummary, logFile: LogFileRecord): Promise<void> {
  const requestId = ++logRequestSequence;
  selectedLog.value = { summary, logFile };
  selectedLogLines.value = [];
  selectedLogError.value = "";
  selectedLogLoading.value = true;
  lockPageScroll();

  const fetchOptions = await reportDataOptions();
  if (!fetchOptions.parquet || !fetchOptions.parquetClient) {
    if (requestId === logRequestSequence) {
      selectedLogError.value = "Log detail is available when Parquet report data is enabled.";
      selectedLogLoading.value = false;
    }
    return;
  }

  try {
    const lines = await fetchParquetLogLines(summary, logFile, fetchOptions.parquetClient);
    if (requestId === logRequestSequence) {
      selectedLogLines.value = lines;
    }
  } catch (error) {
    if (requestId === logRequestSequence) {
      selectedLogError.value = errorMessageOf(error);
    }
  } finally {
    if (requestId === logRequestSequence) {
      selectedLogLoading.value = false;
    }
  }
}

function openLatestRunLogModal(logFile: LogFileRecord): void {
  const summary = latestSummary.value;
  if (!summary) {
    return;
  }
  void openRunLogModal(summary, logFile);
}

async function openSelectedSearchRun(): Promise<void> {
  const result = selectedSearchResult.value;
  if (!result) {
    return;
  }
  closeSearchResultModal();
  await openSearchResult(result);
}

async function openSearchResult(result: SearchResult): Promise<void> {
  const runIndex = index.value?.runs.findIndex(
    (summary) => summary.id === result.runId || summary.file === result.runFile
  );
  if (runIndex === undefined || runIndex < 0 || !index.value) {
    return;
  }

  if (runIndex === 0) {
    await loadLatestRun();
    await navigateToSection("latest-run-section");
    return;
  }

  const archivedIndex = runIndex - 1;
  const summary = index.value.runs[runIndex];
  await navigateToSection(archivedRunAnchorId(summary, archivedIndex), { expandArchived: true });
}

function ensureHistoryVisible(summary: RunSummary): void {
  const archivedIndex = archivedSummaries.value.findIndex((item) => item.id === summary.id);
  if (archivedIndex === -1) return;
}

function findArchivedSummary(targetId: string): { index: number; summary: RunSummary } | null {
  const archivedIndex = archivedSummaries.value.findIndex(
    (summary, runIndex) => archivedRunAnchorId(summary, runIndex) === targetId
  );

  if (archivedIndex === -1) {
    return null;
  }

  return {
    index: archivedIndex,
    summary: archivedSummaries.value[archivedIndex],
  };
}

async function handleHistoryToggle({ summary, open }: HistoryTogglePayload): Promise<void> {
  expandedHistory[summary.id] = open;
  if (open) {
    await ensureHistoryRunLoaded(summary);
  }
}

function retryHistoryLoad(summary: RunSummary): void {
  ensureHistoryRunLoaded(summary);
}

function toggleArchivedMenu(): void {
  archivedMenuOpen.value = !archivedMenuOpen.value;
}

function closeArchivedMenu(): void {
  archivedMenuOpen.value = false;
}

async function handleStickyNavigation(targetId: string, options: NavigationOptions = {}): Promise<void> {
  closeArchivedMenu();
  await navigateToSection(targetId, options);
}

async function navigateToSection(targetId: string, options: NavigationOptions = {}): Promise<void> {
  if (!targetId) return;

  if (loading.value || !index.value) {
    pendingNavigationTarget.value = targetId;
    return;
  }

  const { expandArchived = false } = options;
  let loadPromise: Promise<void> | null = null;

  if (targetId === "trend-panel-section") {
    trendPanelOpen.value = true;
  }

  const archivedTarget = findArchivedSummary(targetId);
  if (archivedTarget) {
    ensureHistoryVisible(archivedTarget.summary);
    if (expandArchived) {
      expandedHistory[archivedTarget.summary.id] = true;
      loadPromise = ensureHistoryRunLoaded(archivedTarget.summary);
    }
  }

  await nextTick();

  if (targetId === "trend-panel-section") {
    trendPanelRef.value?.renderCharts();
  }

  const target = document.getElementById(targetId);
  if (target) {
    scrollElementIntoView(target);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${targetId}`);
    pendingNavigationTarget.value = "";
  } else {
    pendingNavigationTarget.value = targetId;
  }

  if (loadPromise) {
    await loadPromise;
  }
}

function handleDocumentClick(event: MouseEvent): void {
  if (archivedDropdown.value && event.target instanceof Node && !archivedDropdown.value.contains(event.target)) {
    closeArchivedMenu();
  }
}

function handleDocumentFocus(event: FocusEvent): void {
  if (archivedDropdown.value && event.target instanceof Node && !archivedDropdown.value.contains(event.target)) {
    closeArchivedMenu();
  }
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    if (selectedLog.value) {
      closeLogModal();
      return;
    }
    if (selectedSearchResult.value) {
      closeSearchResultModal();
      return;
    }
    if (parquetInspectorOpen.value) {
      closeParquetInspector();
      return;
    }
    closeArchivedMenu();
  }
}

function handleHashChange(): void {
  const target = window.location.hash.slice(1);
  if (target) {
    void navigateToSection(target, { expandArchived: true });
  }
}

function handleWindowPopstate(): void {
  void (async () => {
    const searchStateApplied = await applySearchUrlState();
    if (!searchStateApplied) {
      await applyRunDetailUrlState();
    }
  })();
}

function handleWindowResize(): void {
  trendPanelRef.value?.resizeCharts();
}

onMounted(() => {
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("focusin", handleDocumentFocus);
  document.addEventListener("keydown", handleDocumentKeydown);
  window.addEventListener("hashchange", handleHashChange);
  window.addEventListener("popstate", handleWindowPopstate);
  window.addEventListener("resize", handleWindowResize);
  void bootstrap();
});

onBeforeUnmount(() => {
  document.removeEventListener("click", handleDocumentClick);
  document.removeEventListener("focusin", handleDocumentFocus);
  document.removeEventListener("keydown", handleDocumentKeydown);
  window.removeEventListener("hashchange", handleHashChange);
  window.removeEventListener("popstate", handleWindowPopstate);
  window.removeEventListener("resize", handleWindowResize);
  if (selectedLog.value) {
    closeLogModal();
  }
  unlockPageScroll();
});
</script>

<template>
  <div>
    <div class="backdrop"></div>
    <main class="shell" v-cloak>
      <nav v-if="!loading && !errorMessage && hasRuns" class="sticky-nav" aria-label="Section navigation">
        <a class="sticky-link" href="#latest-run-section" @click.prevent="handleStickyNavigation('latest-run-section')">
          Latest Run
        </a>
        <a class="sticky-link" href="#search-section" @click.prevent="handleStickyNavigation('search-section')">
          Search
        </a>
        <a class="sticky-link" href="#parquet-files-section" @click.prevent="handleStickyNavigation('parquet-files-section')">
          Parquet Files
        </a>
        <a class="sticky-link" href="#trend-panel-section" @click.prevent="handleStickyNavigation('trend-panel-section')">
          Topline Trends
        </a>

        <div ref="archivedDropdown" class="sticky-dropdown" :class="{ open: archivedMenuOpen }">
          <button
            id="archived-run-toggle"
            class="sticky-link sticky-link-button"
            type="button"
            :aria-expanded="archivedMenuOpen"
            aria-controls="archived-run-menu"
            @click.stop="toggleArchivedMenu"
          >
            Archived Runs
          </button>
          <div
            v-if="archivedMenuOpen"
            id="archived-run-menu"
            class="sticky-dropdown-panel"
            role="menu"
            aria-label="Archived runs"
          >
            <div class="sticky-dropdown-list">
              <span v-if="!archivedSummaries.length" class="sticky-dropdown-empty">No archived runs yet.</span>
              <a
                v-for="(summary, runIndex) in archivedSummaries"
                :key="summary.id"
                class="sticky-dropdown-link"
                :href="'#' + archivedRunAnchorId(summary, runIndex)"
                role="menuitem"
                @click.prevent="handleStickyNavigation(archivedRunAnchorId(summary, runIndex), { expandArchived: true })"
              >
                {{ formatDate(summary.started_at) }}
              </a>
            </div>
          </div>
        </div>

        <a class="sticky-link repo-link" href="https://github.com/peterxcli/ozone-s3-compatibility" aria-label="GitHub repository">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              d="M12 1.5a10.5 10.5 0 0 0-3.32 20.46c.53.1.72-.23.72-.51v-1.79c-2.95.64-3.57-1.25-3.57-1.25-.48-1.21-1.18-1.54-1.18-1.54-.97-.66.07-.65.07-.65 1.07.08 1.64 1.1 1.64 1.1.95 1.63 2.49 1.16 3.1.89.1-.69.37-1.16.67-1.43-2.36-.27-4.84-1.18-4.84-5.25 0-1.16.41-2.1 1.1-2.84-.12-.27-.48-1.36.1-2.84 0 0 .9-.29 2.95 1.08a10.2 10.2 0 0 1 5.38 0c2.04-1.37 2.94-1.08 2.94-1.08.59 1.48.23 2.57.12 2.84.68.74 1.1 1.68 1.1 2.84 0 4.08-2.49 4.98-4.86 5.24.38.32.72.96.72 1.94v2.88c0 .29.19.62.73.51A10.5 10.5 0 0 0 12 1.5Z"
            />
          </svg>
        </a>
      </nav>

      <section v-if="loading" class="panel">
        <div class="loader">Loading report…</div>
      </section>

      <section v-else-if="errorMessage" class="panel">
        <div class="loader">{{ errorMessage }}</div>
      </section>

      <section v-else-if="!hasRuns" class="panel">
        <div class="loader empty-state">No runs found yet.</div>
      </section>

      <template v-else-if="latestSummary && index">
        <section class="hero">
          <div class="hero-copy">
            <p class="eyebrow">Nightly GitHub Pages Report</p>
            <h1>Apache Ozone S3 Compatibility</h1>
            <p class="hero-text">
              Tracks daily compatibility against <code>ceph/s3-tests</code> and <code>minio/mint</code>,
              starting from a fresh Ozone build and packaged compose cluster.
            </p>
            <div class="hero-meta">
              <span class="meta-chip mono">{{ formatDate(latestSummary.started_at) }}</span>
              <span class="meta-chip mono">Ozone {{ latestSummary.sources?.ozone?.short_commit || "unknown" }}</span>
              <span class="pill scope-pill" :class="latestScope.kind">{{ latestScope.label }}</span>
              <span class="meta-chip">{{ String(latestSummary.status || "unknown").replace(/_/g, " ") }}</span>
              <a v-if="latestSummary.workflow_run_url" class="meta-chip" :href="latestSummary.workflow_run_url">GitHub Actions run</a>
            </div>
          </div>

          <div class="summary-cards">
            <article v-for="card in summaryCards" :key="card.key" class="summary-card">
              <p class="eyebrow">{{ card.label }}</p>
              <h3>{{ card.eligible }} eligible cases</h3>
              <p class="big-number">{{ formatPercent(card.rate) }}</p>
              <p class="subtle">
                {{ card.passed }} passed, {{ card.failedOrErrored }} failed/error, {{ card.skipped }} skipped
              </p>
              <p class="delta" :class="deltaClass(card.delta)">{{ deltaText(card.delta) }}</p>
              <div v-if="card.featureMovement.comparable" class="feature-rollup run-feature-rollup">
                <span class="feature-rollup-chip improved">
                  {{ featureCountText(card.featureMovement.improved, "improved") }}
                </span>
                <span class="feature-rollup-chip regressed">
                  {{ featureCountText(card.featureMovement.regressed, "degraded") }}
                </span>
              </div>
            </article>
          </div>
        </section>

        <section id="search-section" class="panel search-panel section-anchor">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Search</p>
              <h2>Test Case Search</h2>
            </div>
            <p class="panel-note">
              {{ searchIndexProgressText }}
            </p>
          </div>

          <div
            v-if="searchIndexProgressVisible"
            class="search-index-progress"
            role="status"
            aria-live="polite"
          >
            <div class="search-index-progress-head">
              <span>{{ searchIndexProgressText }}</span>
              <span v-if="searchIndexProgressPercent !== null" class="mono">
                {{ searchIndexProgressPercent }}%
              </span>
            </div>
            <div
              class="search-index-progress-track"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="searchIndexProgressPercent ?? undefined"
            >
              <div
                class="search-index-progress-fill"
                :class="{ indeterminate: searchIndexProgressPercent === null }"
                :style="{ width: `${searchIndexProgressPercent ?? 22}%` }"
              ></div>
            </div>
          </div>

          <div class="search-controls">
            <label class="search-input-wrap">
              <span class="visually-hidden">Search test cases</span>
              <input
                v-model="searchQuery"
                class="search-input"
                type="search"
                placeholder="Search suite, test name, run, or error message"
                autocomplete="off"
              />
            </label>
            <label class="search-suite-filter">
              <span class="visually-hidden">Suite filter</span>
              <select v-model="searchSuiteFilter">
                <option value="all">All suites</option>
                <option v-for="suiteKey in suiteOrder" :key="suiteKey" :value="suiteKey">
                  {{ suiteLabel(suiteKey) }}
                </option>
              </select>
            </label>
            <button v-if="searchActive" class="inline-button" type="button" @click="clearSearch">Clear</button>
          </div>

          <div v-if="!searchActive" class="loader empty-state">
            Search stored cases by suite, test name, run id, run date, or failure text.
          </div>
          <div v-else-if="searchLoading" class="loader">{{ searchIndexProgressText }}</div>
          <div v-else-if="searchError" class="loader history-detail-state">
            {{ searchError }}
            <button class="inline-button" type="button" @click="retrySearchLoad">Retry</button>
          </div>
          <div v-else class="search-results">
            <div class="search-results-head">
              <span class="pill">{{ searchResultSummary }}</span>
              <span v-if="searchResults.length === SEARCH_RESULT_LIMIT" class="subtle">
                Refine the query to narrow the result set.
              </span>
            </div>

            <div v-if="!searchResults.length" class="loader empty-state">No stored cases match this search.</div>
            <article
              v-for="result in searchResults"
              :key="result.id"
              class="search-result"
              role="button"
              tabindex="0"
              @click="openSearchResultModal(result)"
              @keydown.enter.prevent="openSearchResultModal(result)"
              @keydown.space.prevent="openSearchResultModal(result)"
            >
              <div class="search-result-head">
                <div>
                  <h3 v-html="highlightSearchResultText(result.testName)"></h3>
                  <div class="case-meta subtle mono">
                    <span v-if="result.classname" v-html="highlightSearchResultText(result.classname)"></span>
                    <span v-html="highlightSearchResultText(result.runId)"></span>
                  </div>
                </div>
                <span
                  class="status-pill"
                  :class="statusClass(result.status)"
                  v-html="highlightSearchResultText(String(result.status || 'unknown').replace(/_/g, ' '))"
                ></span>
              </div>

              <div class="search-result-meta">
                <span v-if="result.isLatestRun" class="pill latest-run-pill">Latest run</span>
                <span class="meta-chip" v-html="highlightSearchResultText(result.suiteLabel)"></span>
                <span class="meta-chip mono" v-html="highlightSearchResultText(formatDate(result.runStartedAt))"></span>
                <span v-for="field in result.matchedFields" :key="field" class="pill matched-field-pill">
                  {{ field }}
                </span>
              </div>

              <div v-if="(result.features || []).length" class="feature-tags">
                <span
                  v-for="feature in result.features"
                  :key="feature"
                  class="feature-tag"
                  v-html="highlightSearchResultText(feature.replace(/_/g, ' '))"
                ></span>
              </div>
              <div
                v-if="result.message || result.detail"
                class="callout"
                v-html="highlightSearchResultText(result.message || result.detail)"
              ></div>
            </article>
          </div>
        </section>

        <section id="parquet-files-section" class="panel parquet-files-panel section-anchor">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Parquet Files</p>
              <h2>Data File Inspector</h2>
            </div>
            <p class="panel-note">{{ parquetFilesNote }}</p>
          </div>

          <div v-if="!parquetReportEnabled" class="loader empty-state">
            Parquet file inspection is available when this report is loaded with Parquet data.
          </div>
          <div v-else class="parquet-files-layout">
            <ParquetFileBrowser
              :files="parquetFiles"
              :graph="parquetFileGraph"
              :loading="parquetFilesLoading"
              :error="parquetFilesError"
              :selected-path="selectedParquetFile?.path || ''"
              @select="selectParquetFile"
              @retry="loadParquetFiles"
            />
          </div>
        </section>

        <section id="latest-run-section" class="panel section-anchor">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Latest Run</p>
              <h2>Current Report</h2>
            </div>
            <p class="panel-note">Run scope is shown with each report so subset publishes are easy to spot.</p>
          </div>
          <div v-if="latestSuiteSummaries.length" class="suite-summary-strip latest-summary-strip">
            <div v-for="entry in latestSuiteSummaries" :key="entry.key" class="suite-summary-chip">
              <h4>{{ suiteLabel(entry.key) }}</h4>
              <div class="metric-row">
                <span class="status-pill" :class="statusClass(entry.suite.status)">
                  {{ String(entry.suite.status || "unknown").replace(/_/g, " ") }}
                </span>
                <span class="pill">{{ formatPercent(entry.suite.summary.compatibility_rate) }}</span>
                <span class="pill">{{ entry.suite.summary.eligible }} eligible</span>
              </div>
              <div v-if="entry.featureMovement.comparable" class="feature-rollup latest-feature-rollup">
                <span class="feature-rollup-chip improved">
                  {{ featureCountText(entry.featureMovement.improved, "improved") }}
                </span>
                <span class="feature-rollup-chip regressed">
                  {{ featureCountText(entry.featureMovement.regressed, "degraded") }}
                </span>
              </div>
            </div>
          </div>
          <div class="run-details" :class="{ loading: latestRunLoading && !latestRun }">
            <div v-if="latestRunLoading && !latestRun" class="loader">Loading latest run…</div>
            <div v-else-if="latestRunError" class="loader">
              <span>{{ latestRunError }}</span>
              <button class="inline-button" type="button" @click="loadLatestRun">Retry</button>
            </div>
            <RunDetails
              v-else-if="latestRun"
              :run="latestRun"
              :run-file="latestSummary.file"
              :previous-run="comparisonRunForRunOrdinal(0)"
              :suite-order="suiteOrder"
              :default-suite-open="true"
              :is-latest-run="true"
              case-permalink-hash="latest-run-section"
              @open-case="openRunDetailCaseModal"
              @open-log="openLatestRunLogModal"
            />
            <div v-else class="loader">
              <button class="inline-button" type="button" @click="loadLatestRun">Load current report detail</button>
            </div>
          </div>
        </section>

        <TrendPanel ref="trendPanelRef" :index="index" :open="trendPanelOpen" @update:open="trendPanelOpen = $event" />

        <section id="history-section" class="panel section-anchor">
          <div class="panel-header">
            <div>
              <p class="eyebrow">History</p>
              <h2>Archived Runs</h2>
            </div>
            <p class="panel-note">Run summaries render first, and full run detail is fetched only when a run is opened.</p>
          </div>

          <div class="history-list">
            <div v-if="!archivedSummaries.length" class="loader empty-state">No archived runs are available yet.</div>

            <HistoryItem
              v-for="(summary, runIndex) in archivedSummaries"
              :key="summary.id"
              :summary="summary"
              :run-index="runIndex"
              :suite-order="suiteOrder"
              :run-data="historyRun(summary.id)"
              :previous-run="comparisonRunForRunOrdinal(runIndex + 1)"
              :loading="historyRunLoading(summary.id)"
              :error="historyRunError(summary.id)"
              :expanded="isHistoryExpanded(summary.id)"
              @toggle="handleHistoryToggle"
              @retry="retryHistoryLoad"
              @open-case="openRunDetailCaseModal"
              @open-log="openRunLogModal"
            />
          </div>
        </section>
      </template>
    </main>

    <div
      v-if="selectedSearchResult"
      ref="caseModalBackdrop"
      class="case-modal-backdrop"
      aria-label="Close test case details"
      @click.self="() => closeSearchResultModal()"
      @wheel="handleModalBackdropWheel"
      @touchstart="handleModalBackdropTouchStart"
      @touchmove="handleModalBackdropTouchMove"
    >
      <section
        class="case-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="`${selectedSearchResult.testName} test case details`"
      >
        <button class="case-modal-close" type="button" aria-label="Close test case details" @click="() => closeSearchResultModal()">
          &times;
        </button>

        <div class="case-modal-header">
          <div>
            <p class="eyebrow">{{ selectedSearchResult.suiteLabel }}</p>
            <h2>{{ selectedSearchResult.testName }}</h2>
            <p v-if="selectedSearchResult.classname" class="subtle mono">{{ selectedSearchResult.classname }}</p>
          </div>
          <span class="status-pill" :class="statusClass(selectedSearchResult.status)">
            {{ String(selectedSearchResult.status || "unknown").replace(/_/g, " ") }}
          </span>
        </div>

        <div class="case-modal-actions">
          <button class="inline-button" type="button" @click="openSelectedSearchRun">Open run</button>
          <a v-if="selectedSearchPermalink" class="inline-button" :href="selectedSearchPermalink">Permalink</a>
          <a v-if="caseSnippet.sourceUrl" class="inline-button" :href="caseSnippet.sourceUrl" target="_blank" rel="noreferrer">
            Source
          </a>
        </div>

        <dl class="case-modal-fields">
          <template v-for="field in selectedSearchFields" :key="field.label">
            <dt>{{ field.label }}</dt>
            <dd>{{ field.value }}</dd>
          </template>
        </dl>

        <section v-if="selectedSearchResult.message || selectedSearchResult.detail" class="case-modal-section">
          <h3>Failure Detail</h3>
          <div v-if="selectedSearchResult.message" class="callout">{{ selectedSearchResult.message }}</div>
          <pre v-if="selectedSearchResult.detail" class="case-detail-text">{{ selectedSearchResult.detail }}</pre>
        </section>

        <section class="case-modal-section">
          <div class="case-code-head">
            <h3>Test Code</h3>
            <span v-if="caseSnippet.loading" class="subtle">Loading source...</span>
            <span v-else-if="caseSnippet.error" class="subtle">Showing indexed fallback.</span>
            <span v-else-if="caseSnippet.startLine" class="subtle">Starts at line {{ caseSnippet.startLine }}</span>
          </div>
          <pre class="case-code"><code :class="`language-${caseSnippet.language}`" v-html="highlightedSearchSnippet"></code></pre>
        </section>
      </section>
    </div>

    <div
      v-show="selectedParquetFile && parquetInspectorOpen"
      class="case-modal-backdrop parquet-inspector-backdrop"
      aria-label="Close Parquet inspector"
      @click.self="closeParquetInspector"
      @wheel="handleModalBackdropWheel"
      @touchstart="handleModalBackdropTouchStart"
      @touchmove="handleModalBackdropTouchMove"
    >
      <section
        class="case-modal parquet-inspector-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="selectedParquetFile ? `${selectedParquetFile.name} Parquet inspector` : 'Parquet inspector'"
      >
        <button class="case-modal-close" type="button" aria-label="Close Parquet inspector" @click="closeParquetInspector">
          &times;
        </button>
        <EmbeddedParquetViewer :file="selectedParquetFile" />
      </section>
    </div>

    <div
      v-if="selectedLog"
      ref="caseModalBackdrop"
      class="case-modal-backdrop"
      aria-label="Close log details"
      @click.self="closeLogModal"
      @wheel="handleModalBackdropWheel"
      @touchstart="handleModalBackdropTouchStart"
      @touchmove="handleModalBackdropTouchMove"
    >
      <section
        class="case-modal log-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="`${selectedLog.logFile.log_source} log details`"
      >
        <button class="case-modal-close" type="button" aria-label="Close log details" @click="closeLogModal">
          &times;
        </button>

        <div class="case-modal-header">
          <div>
            <p class="eyebrow">Log Detail</p>
            <h2>{{ selectedLog.logFile.log_source }}</h2>
            <p class="subtle mono">{{ selectedLog.logFile.log_file }}</p>
          </div>
          <span class="pill">{{ selectedLog.logFile.line_count.toLocaleString() }} lines</span>
        </div>

        <section class="case-modal-section">
          <div v-if="selectedLogLoading" class="loader">Loading log lines...</div>
          <div v-else-if="selectedLogError" class="loader history-detail-state">{{ selectedLogError }}</div>
          <pre v-else class="case-detail-text log-detail-text">{{ selectedLogText }}</pre>
        </section>
      </section>
    </div>
  </div>
</template>
