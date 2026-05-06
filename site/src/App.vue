<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import HistoryItem from "./components/HistoryItem.vue";
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
  parseSearchShareState,
  resultMatchesSharedCase,
  searchUrlFromState,
} from "./lib/shareState";
import {
  HISTORY_BATCH_SIZE,
  archivedRunAnchorId,
  deltaForSuite,
  fetchJson,
  fetchRun,
  formatDate,
  formatPercent,
  runScope,
  scrollElementIntoView,
  statusClass,
  suiteLabel,
} from "./lib/report";
import { createPersistentSearchSession } from "./lib/search";
import type { FullRun, HistoryTogglePayload, IndexPayload, RunSummary } from "./lib/types";
import type { SearchIndexPayload, SearchResult, SearchSession } from "./lib/search";
import type { SharedCaseIdentity } from "./lib/shareState";

interface SummaryCard {
  key: string;
  label: string;
  eligible: number;
  rate: number | null;
  passed: number;
  failedOrErrored: number;
  skipped: number;
  delta: number | null;
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
const historyBatchSize = ref<number>(HISTORY_BATCH_SIZE);
const visibleArchivedCount = ref<number>(HISTORY_BATCH_SIZE);
const pendingNavigationTarget = ref<string>("");
const searchQuery = ref<string>("");
const searchSuiteFilter = ref<string>("all");
const searchIndexPayload = ref<SearchIndexPayload | null>(null);
const searchSession = ref<SearchSession | null>(null);
const searchResults = ref<SearchResult[]>([]);
const searchLoading = ref<boolean>(false);
const searchError = ref<string>("");
const selectedSearchResult = ref<SearchResult | null>(null);
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
let pageScrollYBeforeModal = 0;
let applyingSharedUrlState = false;
let searchSessionPromise: Promise<SearchSession | null> | null = null;
let searchPreloadScheduled = false;
let searchPreloadTimer: number | null = null;
let searchPreloadIdleHandle: number | null = null;

const expandedHistory = reactive<Record<string, boolean>>({});
const runDetailsById = reactive<Record<string, FullRun | undefined>>({});
const runLoading = reactive<Record<string, boolean>>({});
const runErrors = reactive<Record<string, string>>({});

const archivedDropdown = ref<HTMLElement | null>(null);
const historySentinel = ref<HTMLElement | null>(null);
const trendPanelRef = ref<TrendPanelExposed | null>(null);

let historyObserver: IntersectionObserver | null = null;

const hasRuns = computed(() => Boolean(index.value?.runs?.length));
const latestSummary = computed<RunSummary | null>(() => index.value?.runs?.[0] || null);
const latestScope = computed(() =>
  latestSummary.value ? runScope(latestSummary.value) : { kind: "unknown", label: "Run inputs unavailable" }
);
const archivedSummaries = computed<RunSummary[]>(() => index.value?.runs?.slice(1) || []);
const visibleArchivedSummaries = computed<RunSummary[]>(() => archivedSummaries.value.slice(0, visibleArchivedCount.value));
const canLoadMoreHistory = computed(() => visibleArchivedCount.value < archivedSummaries.value.length);
const suiteOrder = computed<string[]>(() => index.value?.suite_order || []);
const trimmedSearchQuery = computed<string>(() => searchQuery.value.trim());
const searchActive = computed<boolean>(() => trimmedSearchQuery.value.length > 0);
const searchIndexLoaded = computed<boolean>(() => Boolean(searchSession.value));
const searchResultSummary = computed<string>(() => {
  const count = searchResults.value.length;
  const suffix = count === SEARCH_RESULT_LIMIT ? " shown" : "";
  return `${count} match${count === 1 ? "" : "es"}${suffix}`;
});
const highlightedSearchSnippet = computed<string>(() => highlightCode(caseSnippet.text, caseSnippet.language));
const selectedSearchPermalink = computed<string>(() =>
  selectedSearchResult.value ? searchUrlForResult(selectedSearchResult.value) : ""
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

const summaryCards = computed<SummaryCard[]>(() => {
  const latest = latestSummary.value;
  const currentIndex = index.value;
  if (!latest || !currentIndex) return [];

  const cards: SummaryCard[] = [];
  suiteOrder.value.forEach((suiteKey) => {
    const suite = latest.suites?.[suiteKey];
    if (!suite) return;

    cards.push({
      key: suiteKey,
      label: suite.label,
      eligible: suite.summary.eligible,
      rate: suite.summary.compatibility_rate,
      passed: suite.summary.passed,
      failedOrErrored: suite.summary.failed + suite.summary.errored,
      skipped: suite.summary.skipped,
      delta: deltaForSuite(currentIndex.runs, suiteKey),
    });
  });

  return cards;
});

watch(
  [visibleArchivedCount, canLoadMoreHistory],
  async () => {
    await nextTick();
    setupHistoryObserver();
  }
);

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

function historyRun(summaryId: string): FullRun | null {
  return runDetailsById[summaryId] || null;
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
    index.value = await fetchJson<IndexPayload>("./data/index.json", "Failed to load report index");
    loading.value = false;

    if (!hasRuns.value) {
      return;
    }

    const latestPromise = loadLatestRun();

    await nextTick();
    setupHistoryObserver();
    scheduleSearchSessionPreload();
    const searchStateApplied = await applySearchUrlState();

    const target = pendingNavigationTarget.value || window.location.hash.slice(1);
    if (target && (!searchStateApplied || target !== SEARCH_SECTION_HASH.slice(1))) {
      await navigateToSection(target, { expandArchived: true });
    }

    await latestPromise;
  } catch (error) {
    errorMessage.value = errorMessageOf(error);
    loading.value = false;
  }
}

async function loadLatestRun(): Promise<void> {
  if (!latestSummary.value) return;

  latestRunLoading.value = true;
  latestRunError.value = "";
  try {
    latestRun.value = await fetchRun(latestSummary.value.file);
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
    runDetailsById[summary.id] = await fetchRun(summary.file);
  } catch (error) {
    runErrors[summary.id] = errorMessageOf(error);
  } finally {
    runLoading[summary.id] = false;
  }
}

function scheduleSearchSessionPreload(): void {
  if (searchPreloadScheduled || searchSession.value || searchSessionPromise) {
    return;
  }

  searchPreloadScheduled = true;
  const preload = () => {
    searchPreloadTimer = null;
    searchPreloadIdleHandle = null;
    void ensureSearchSession();
  };

  if ("requestIdleCallback" in window) {
    searchPreloadIdleHandle = window.requestIdleCallback(preload, { timeout: 2000 });
    return;
  }

  searchPreloadTimer = globalThis.setTimeout(preload, 250);
}

function cancelSearchSessionPreload(): void {
  if (searchPreloadIdleHandle !== null && "cancelIdleCallback" in window) {
    window.cancelIdleCallback(searchPreloadIdleHandle);
  }
  if (searchPreloadTimer !== null) {
    window.clearTimeout(searchPreloadTimer);
  }
  searchPreloadIdleHandle = null;
  searchPreloadTimer = null;
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
      const payload =
        searchIndexPayload.value ||
        (await fetchJson<SearchIndexPayload>("./data/search-index.json", "Failed to load search index"));
      searchIndexPayload.value = payload;
      searchSession.value = await createPersistentSearchSession(payload);
      return searchSession.value;
    } catch (error) {
      searchError.value = errorMessageOf(error);
      return null;
    } finally {
      searchLoading.value = false;
      searchSessionPromise = null;
    }
  })();

  return searchSessionPromise;
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

function searchUrlForResult(result: SearchResult): string {
  return searchUrlFromState(
    {
      query: trimmedSearchQuery.value,
      suiteFilter: searchSuiteFilter.value,
      selectedCase: caseIdentityForResult(result),
    },
    window.location.href,
  );
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
  );
  const result = candidates.find((candidate) => resultMatchesSharedCase(candidate, selectedCase));
  if (!result) {
    searchError.value = `Could not find shared test case ${selectedCase.testName} in run ${selectedCase.runId}.`;
    return;
  }

  openSearchResultModal(result, { syncUrl: false });
}

async function applySearchUrlState(): Promise<boolean> {
  const shareState = parseSearchShareState(window.location.href);
  const sharedQuery = shareState.query || shareState.selectedCase?.testName || "";
  const hasSharedSearchState = Boolean(sharedQuery || shareState.selectedCase);

  if (!hasSharedSearchState) {
    if (selectedSearchResult.value) {
      closeSearchResultModal({ syncUrl: false });
    }
    return false;
  }

  applyingSharedUrlState = true;
  searchQuery.value = sharedQuery;
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

function lockPageScroll(): void {
  if (document.body.classList.contains("modal-open")) {
    return;
  }
  pageScrollYBeforeModal = window.scrollY;
  document.body.style.top = `-${pageScrollYBeforeModal}px`;
  document.body.classList.add("modal-open");
}

function unlockPageScroll(): void {
  if (!document.body.classList.contains("modal-open")) {
    return;
  }
  document.body.classList.remove("modal-open");
  document.body.style.top = "";
  window.scrollTo(0, pageScrollYBeforeModal);
  pageScrollYBeforeModal = 0;
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

function openSearchResultModal(result: SearchResult, options: { syncUrl?: boolean } = {}): void {
  const { syncUrl = true } = options;
  lockPageScroll();
  selectedSearchResult.value = result;
  const requestId = ++snippetRequestSequence;
  void loadSearchResultSnippet(result, requestId);
  if (syncUrl) {
    syncSearchUrl(result, "push");
  }
}

function closeSearchResultModal(options: { syncUrl?: boolean } = {}): void {
  const { syncUrl = true } = options;
  selectedSearchResult.value = null;
  snippetRequestSequence += 1;
  resetCaseSnippet();
  unlockPageScroll();
  if (syncUrl) {
    syncSearchUrl(null);
  }
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

  const requiredCount = archivedIndex + 1;
  if (visibleArchivedCount.value < requiredCount) {
    visibleArchivedCount.value = requiredCount;
  }
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

function loadMoreHistory(): void {
  if (!canLoadMoreHistory.value) return;
  visibleArchivedCount.value = Math.min(
    archivedSummaries.value.length,
    visibleArchivedCount.value + historyBatchSize.value
  );
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
    if (selectedSearchResult.value) {
      closeSearchResultModal();
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
  void applySearchUrlState();
}

function handleWindowResize(): void {
  trendPanelRef.value?.resizeCharts();
}

function destroyHistoryObserver(): void {
  if (historyObserver) {
    historyObserver.disconnect();
    historyObserver = null;
  }
}

function setupHistoryObserver(): void {
  destroyHistoryObserver();

  if (!("IntersectionObserver" in window) || !canLoadMoreHistory.value || !historySentinel.value) {
    return;
  }

  historyObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreHistory();
      }
    },
    {
      rootMargin: "360px 0px",
    }
  );

  historyObserver.observe(historySentinel.value);
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
  cancelSearchSessionPreload();
  destroyHistoryObserver();
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
              {{
                searchIndexLoaded && searchIndexPayload
                  ? `${searchIndexPayload.row_count} cases indexed ${searchSession?.persistent ? "in IndexedDB" : "in memory"}`
                  : "Persistent browser search loads in the background."
              }}
            </p>
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
          <div v-else-if="searchLoading" class="loader">Loading persistent search index…</div>
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
                  <h3>{{ result.testName }}</h3>
                  <div class="case-meta subtle mono">
                    <span v-if="result.classname">{{ result.classname }}</span>
                    <span>{{ result.runId }}</span>
                  </div>
                </div>
                <span class="status-pill" :class="statusClass(result.status)">
                  {{ String(result.status || "unknown").replace(/_/g, " ") }}
                </span>
              </div>

              <div class="search-result-meta">
                <span class="meta-chip">{{ result.suiteLabel }}</span>
                <span class="meta-chip mono">{{ formatDate(result.runStartedAt) }}</span>
                <span v-if="result.isLatestRun" class="pill latest-run-pill">Latest run</span>
                <span v-for="field in result.matchedFields" :key="field" class="pill matched-field-pill">
                  {{ field }}
                </span>
              </div>

              <div v-if="(result.features || []).length" class="feature-tags">
                <span v-for="feature in result.features" :key="feature" class="feature-tag">
                  {{ feature.replace(/_/g, " ") }}
                </span>
              </div>
              <div v-if="result.message || result.detail" class="callout">{{ result.message || result.detail }}</div>
            </article>
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
          <div class="run-details" :class="{ loading: latestRunLoading && !latestRun }">
            <div v-if="latestRunLoading && !latestRun" class="loader">Loading latest run…</div>
            <div v-else-if="latestRunError" class="loader">{{ latestRunError }}</div>
            <RunDetails v-else-if="latestRun" :run="latestRun" :suite-order="suiteOrder" :default-suite-open="true" />
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
              v-for="(summary, runIndex) in visibleArchivedSummaries"
              :key="summary.id"
              :summary="summary"
              :run-index="runIndex"
              :suite-order="suiteOrder"
              :run-data="historyRun(summary.id)"
              :loading="historyRunLoading(summary.id)"
              :error="historyRunError(summary.id)"
              :expanded="isHistoryExpanded(summary.id)"
              @toggle="handleHistoryToggle"
              @retry="retryHistoryLoad"
            />

            <div v-if="canLoadMoreHistory" class="history-load-more">
              <div ref="historySentinel" class="history-sentinel" aria-hidden="true"></div>
              <button class="load-more-button" type="button" @click="loadMoreHistory">
                Load {{ Math.min(historyBatchSize, archivedSummaries.length - visibleArchivedCount) }} more runs
              </button>
              <p class="subtle">Showing {{ visibleArchivedSummaries.length }} of {{ archivedSummaries.length }} archived runs.</p>
            </div>
          </div>
        </section>
      </template>
    </main>

    <div
      v-if="selectedSearchResult"
      class="case-modal-backdrop"
      aria-label="Close test case details"
      @click.self="() => closeSearchResultModal()"
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
  </div>
</template>
