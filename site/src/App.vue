<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import HistoryItem from "./components/HistoryItem.vue";
import RunDetails from "./components/RunDetails.vue";
import TrendPanel from "./components/TrendPanel.vue";
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
} from "./lib/report";
import type { FullRun, HistoryTogglePayload, IndexPayload, RunSummary } from "./lib/types";

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

    const target = pendingNavigationTarget.value || window.location.hash.slice(1);
    if (target) {
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
    window.history.replaceState(null, "", `#${targetId}`);
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
    closeArchivedMenu();
  }
}

function handleHashChange(): void {
  const target = window.location.hash.slice(1);
  if (target) {
    void navigateToSection(target, { expandArchived: true });
  }
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
  window.addEventListener("resize", handleWindowResize);
  void bootstrap();
});

onBeforeUnmount(() => {
  document.removeEventListener("click", handleDocumentClick);
  document.removeEventListener("focusin", handleDocumentFocus);
  document.removeEventListener("keydown", handleDocumentKeydown);
  window.removeEventListener("hashchange", handleHashChange);
  window.removeEventListener("resize", handleWindowResize);
  destroyHistoryObserver();
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
  </div>
</template>
