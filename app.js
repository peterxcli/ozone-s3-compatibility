const { createApp } = Vue;

const COLORS = ["#0d7fab", "#ff8a3d", "#0f9d71", "#7a62ff", "#d2493a", "#0097a7", "#9c6b00", "#d81b60"];
const DEFAULT_S3_TESTS_ARGS = "s3tests/functional";
const DEFAULT_MINT_MODE = "core";
const DEFAULT_OZONE_DATANODES = "1";
const HISTORY_BATCH_SIZE = 8;
const CASE_BATCH_SIZE = 60;

function chartLabels(points) {
  return points.map((point) => point.started_at);
}

function chartLabel(value) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatPercent(rate) {
  if (rate === null || rate === undefined) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function suiteLabel(key) {
  return key === "s3_tests" ? "s3-tests" : "mint";
}

function statusClass(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
}

function runId(run) {
  return run.run_id || run.id || "";
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function archivedRunAnchorId(run, index = 0) {
  const parts = [runId(run), run.started_at].map(slugify).filter(Boolean);
  return `archived-run-${parts.join("-") || index + 1}`;
}

function executionForRun(run) {
  if (!run.execution || Object.keys(run.execution).length === 0) {
    return null;
  }

  const mintTargets = Array.isArray(run.execution.mint_targets)
    ? run.execution.mint_targets.filter(Boolean)
    : String(run.execution.mint_targets || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

  return {
    s3_tests_args: run.execution.s3_tests_args || DEFAULT_S3_TESTS_ARGS,
    mint_mode: run.execution.mint_mode || DEFAULT_MINT_MODE,
    mint_targets: mintTargets,
    ozone_datanodes: String(run.execution.ozone_datanodes || DEFAULT_OZONE_DATANODES),
  };
}

function runScope(run) {
  const execution = executionForRun(run);
  if (!execution) {
    return { kind: "unknown", label: "Run inputs unavailable" };
  }

  if (execution.s3_tests_args !== DEFAULT_S3_TESTS_ARGS || execution.mint_targets.length > 0) {
    return { kind: "subset", label: "Subset run" };
  }

  return { kind: "full", label: "Full nightly" };
}

function deltaForSuite(runs, suiteKey) {
  if (runs.length < 2) return null;

  const latest = runs[0]?.suites?.[suiteKey]?.summary?.compatibility_rate;
  for (let i = 1; i < runs.length; i += 1) {
    const previous = runs[i]?.suites?.[suiteKey]?.summary?.compatibility_rate;
    if (latest !== null && latest !== undefined && previous !== null && previous !== undefined) {
      return latest - previous;
    }
  }

  return null;
}

function topFeatureNames(index, suiteKey) {
  const latest = index?.runs?.[0]?.suites?.[suiteKey]?.feature_summaries || [];
  return latest
    .filter((item) => item.summary.eligible > 0)
    .slice(0, 8)
    .map((item) => item.name);
}

function featureLabels(index, suiteKey, featureNames) {
  const seen = new Set();
  featureNames.forEach((featureName) => {
    (index?.charts?.features?.[suiteKey]?.[featureName] || []).forEach((point) => {
      seen.add(point.started_at);
    });
  });
  return Array.from(seen).sort();
}

function featureValues(labels, points) {
  const byDate = new Map(points.map((point) => [point.started_at, point]));
  return labels.map((label) => {
    const point = byDate.get(label);
    if (!point || point.rate === null || point.rate === undefined) {
      return null;
    }
    return Number((point.rate * 100).toFixed(2));
  });
}

async function fetchJson(path, errorMessage) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(errorMessage);
  }
  return response.json();
}

async function fetchRun(file) {
  return fetchJson(file, `Failed to fetch ${file}`);
}

function scrollElementIntoView(element) {
  const stickyNav = document.querySelector(".sticky-nav");
  const offset = (stickyNav?.offsetHeight || 0) + 24;
  const top = window.scrollY + element.getBoundingClientRect().top - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function orderedSuitesFromRun(run, suiteOrder) {
  return (suiteOrder || [])
    .filter((suiteKey) => run?.suites?.[suiteKey])
    .map((suiteKey) => ({ key: suiteKey, suite: run.suites[suiteKey] }));
}

const SuiteCard = {
  name: "SuiteCard",
  props: {
    suite: {
      type: Object,
      required: true,
    },
    openByDefault: {
      type: Boolean,
      default: true,
    },
  },
  data() {
    return {
      isOpen: this.openByDefault,
      caseDisplayCount: CASE_BATCH_SIZE,
    };
  },
  computed: {
    cases() {
      return this.suite.cases || this.suite.non_passing_cases || [];
    },
    shownCases() {
      return this.cases.slice(0, this.caseDisplayCount);
    },
    hasMoreCases() {
      return this.caseDisplayCount < this.cases.length;
    },
    caseNote() {
      return this.suite.included_case_strategy === "non_passing_only"
        ? "Archived case details are stored for non-passing s3-tests cases only to keep the history lightweight."
        : "Showing all stored cases for this suite.";
    },
    failedOrErrored() {
      return (this.suite.summary?.failed || 0) + (this.suite.summary?.errored || 0);
    },
    statusLabel() {
      return String(this.suite.status || "unknown").replace(/_/g, " ");
    },
  },
  methods: {
    formatPercent,
    statusClass,
    loadMoreCases() {
      this.caseDisplayCount = Math.min(this.cases.length, this.caseDisplayCount + CASE_BATCH_SIZE);
    },
  },
  template: `
    <details class="suite-card suite-toggle" :open="isOpen" @toggle="isOpen = $event.target.open">
      <summary class="suite-summary">
        <div class="suite-head">
          <div>
            <p class="eyebrow">{{ suite.label }}</p>
            <h3>{{ statusLabel }}</h3>
          </div>
          <div class="suite-summary-side">
            <span class="pill">{{ formatPercent(suite.summary.compatibility_rate) }}</span>
            <span class="pill">{{ suite.summary.eligible }} eligible</span>
            <span class="status-pill" :class="statusClass(suite.status)">{{ statusLabel }}</span>
            <span class="panel-toggle-chip suite-toggle-chip">Details</span>
          </div>
        </div>
      </summary>
      <div class="suite-body">
        <div class="metrics">
          <div class="metric">
            <span class="metric-label">Compatibility</span>
            <span class="metric-value">{{ formatPercent(suite.summary.compatibility_rate) }}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Eligible</span>
            <span class="metric-value">{{ suite.summary.eligible }}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Passed</span>
            <span class="metric-value">{{ suite.summary.passed }}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Failed + Error</span>
            <span class="metric-value">{{ failedOrErrored }}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Skipped</span>
            <span class="metric-value">{{ suite.summary.skipped }}</span>
          </div>
        </div>

        <div v-if="!(suite.feature_summaries || []).length" class="loader">No feature summary was generated for this suite.</div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Feature</th>
                <th>Rate</th>
                <th>Eligible</th>
                <th>Passed</th>
                <th>Failed + Error</th>
                <th>Skipped</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="feature in suite.feature_summaries" :key="feature.name">
                <td>{{ feature.label }}</td>
                <td>{{ formatPercent(feature.summary.compatibility_rate) }}</td>
                <td>{{ feature.summary.eligible }}</td>
                <td>{{ feature.summary.passed }}</td>
                <td>{{ feature.summary.failed + feature.summary.errored }}</td>
                <td>{{ feature.summary.skipped }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!cases.length" class="loader">No case-level details were stored for this suite.</div>
        <div v-else class="cases-card">
          <div class="suite-head">
            <div>
              <h3>Case Detail</h3>
              <p class="subtle">{{ caseNote }}</p>
            </div>
            <div class="history-summary-status">
              <p class="subtle">{{ shownCases.length }}<span v-if="cases.length > shownCases.length"> / {{ cases.length }}</span> shown</p>
              <button v-if="hasMoreCases" class="inline-button" type="button" @click.stop="loadMoreCases">
                Load {{ Math.min(${CASE_BATCH_SIZE}, cases.length - shownCases.length) }} more
              </button>
            </div>
          </div>
          <div class="case-list">
            <article v-for="entry in shownCases" :key="entry.name + ':' + entry.status" class="case-item">
              <div class="case-item-head">
                <div>
                  <h5>{{ entry.name }}</h5>
                  <div v-if="(entry.features || []).length" class="feature-tags">
                    <span v-for="feature in entry.features" :key="feature" class="feature-tag">{{ feature.replace(/_/g, " ") }}</span>
                  </div>
                </div>
                <span class="status-pill" :class="statusClass(entry.status)">{{ String(entry.status || "unknown").replace(/_/g, " ") }}</span>
              </div>
              <div class="case-meta subtle mono">
                <span v-if="entry.classname">{{ entry.classname }}</span>
                <span v-if="entry.duration_ms !== null && entry.duration_ms !== undefined">{{ entry.duration_ms }} ms</span>
              </div>
              <div v-if="entry.message" class="callout">{{ entry.message }}</div>
            </article>
          </div>
        </div>
      </div>
    </details>
  `,
};

const RunDetails = {
  name: "RunDetails",
  components: {
    SuiteCard,
  },
  props: {
    run: {
      type: Object,
      required: true,
    },
    suiteOrder: {
      type: Array,
      default: () => [],
    },
    defaultSuiteOpen: {
      type: Boolean,
      default: true,
    },
  },
  computed: {
    orderedSuites() {
      return orderedSuitesFromRun(this.run, this.suiteOrder);
    },
    execution() {
      return executionForRun(this.run);
    },
    scopeInfo() {
      return runScope(this.run);
    },
    ozoneCommit() {
      return this.run.sources?.ozone?.short_commit || "unknown";
    },
    s3TestsCommit() {
      return this.run.sources?.s3_tests?.short_commit || "unknown";
    },
    mintCommit() {
      return this.run.sources?.mint?.short_commit || "unknown";
    },
    showS3SelectorChip() {
      return this.execution && this.execution.s3_tests_args !== DEFAULT_S3_TESTS_ARGS;
    },
    showMintTargetsChip() {
      return this.execution && this.execution.mint_targets.length > 0;
    },
    showMintModeChip() {
      return this.execution && this.execution.mint_mode !== DEFAULT_MINT_MODE;
    },
    showDatanodesChip() {
      return this.execution && this.execution.ozone_datanodes !== DEFAULT_OZONE_DATANODES;
    },
  },
  methods: {
    formatDate,
  },
  template: `
    <div class="run-shell">
      <div class="run-toolbar">
        <span class="meta-chip mono">{{ formatDate(run.started_at) }}</span>
        <span class="meta-chip mono">Ozone {{ ozoneCommit }}</span>
        <span class="meta-chip mono">s3-tests {{ s3TestsCommit }}</span>
        <span class="meta-chip mono">mint {{ mintCommit }}</span>
        <a v-if="run.workflow_run_url" class="meta-chip" :href="run.workflow_run_url">GitHub Actions run</a>
      </div>

      <div class="run-meta">
        <span class="pill scope-pill" :class="scopeInfo.kind">{{ scopeInfo.label }}</span>
        <span v-if="showS3SelectorChip" class="meta-chip mono">s3-tests selector: {{ execution.s3_tests_args }}</span>
        <span v-if="showMintTargetsChip" class="meta-chip mono">mint targets: {{ execution.mint_targets.join(" ") }}</span>
        <span v-if="showMintModeChip" class="meta-chip">Mint mode: {{ execution.mint_mode }}</span>
        <span v-if="showDatanodesChip" class="meta-chip">{{ execution.ozone_datanodes }} datanodes</span>
      </div>

      <div class="suite-grid">
        <SuiteCard
          v-for="entry in orderedSuites"
          :key="entry.key"
          :suite="entry.suite"
          :open-by-default="defaultSuiteOpen"
        />
      </div>
    </div>
  `,
};

const HistoryItem = {
  name: "HistoryItem",
  components: {
    RunDetails,
  },
  props: {
    summary: {
      type: Object,
      required: true,
    },
    runIndex: {
      type: Number,
      required: true,
    },
    suiteOrder: {
      type: Array,
      default: () => [],
    },
    runData: {
      type: Object,
      default: null,
    },
    loading: {
      type: Boolean,
      default: false,
    },
    error: {
      type: String,
      default: "",
    },
    expanded: {
      type: Boolean,
      default: false,
    },
  },
  emits: ["toggle", "retry"],
  computed: {
    anchorId() {
      return archivedRunAnchorId(this.summary, this.runIndex);
    },
    suiteSummaries() {
      return orderedSuitesFromRun(this.summary, this.suiteOrder);
    },
    scopeInfo() {
      return runScope(this.summary);
    },
    statusLabel() {
      return String(this.summary.status || "unknown").replace(/_/g, " ");
    },
  },
  methods: {
    archivedRunAnchorId,
    formatDate,
    formatPercent,
    runId,
    statusClass,
    suiteLabel,
    handleToggle(event) {
      this.$emit("toggle", { summary: this.summary, open: event.target.open });
    },
    retry() {
      this.$emit("retry", this.summary);
    },
  },
  template: `
    <details :id="anchorId" class="history-item section-anchor" :open="expanded" @toggle="handleToggle">
      <summary class="history-summary">
        <div class="history-summary-head">
          <div>
            <p class="eyebrow">Run {{ runId(summary) }}</p>
            <h3>{{ formatDate(summary.started_at) }}</h3>
          </div>
          <div class="history-summary-status">
            <span class="pill scope-pill" :class="scopeInfo.kind">{{ scopeInfo.label }}</span>
            <span class="status-pill" :class="statusClass(summary.status)">{{ statusLabel }}</span>
          </div>
        </div>
        <div class="suite-summary-strip">
          <div v-for="entry in suiteSummaries" :key="entry.key" class="suite-summary-chip">
            <h4>{{ suiteLabel(entry.key) }}</h4>
            <div class="metric-row">
              <span class="status-pill" :class="statusClass(entry.suite.status)">{{ String(entry.suite.status || "unknown").replace(/_/g, " ") }}</span>
              <span class="pill">{{ formatPercent(entry.suite.summary.compatibility_rate) }}</span>
              <span class="pill">{{ entry.suite.summary.eligible }} eligible</span>
            </div>
          </div>
        </div>
      </summary>

      <div class="history-body">
        <div v-if="loading" class="loader history-detail-state">Loading run detail…</div>
        <div v-else-if="error" class="loader history-detail-state">
          {{ error }}
          <button class="inline-button" type="button" @click.stop="retry">Retry</button>
        </div>
        <RunDetails
          v-else-if="runData"
          :run="runData"
          :suite-order="suiteOrder"
          :default-suite-open="false"
        />
        <div v-else class="loader history-detail-state">Open this run to load its full detail.</div>
      </div>
    </details>
  `,
};

createApp({
  components: {
    HistoryItem,
    RunDetails,
  },
  data() {
    return {
      loading: true,
      errorMessage: "",
      index: null,
      latestRun: null,
      latestRunLoading: false,
      latestRunError: "",
      selectedFeatureSuite: "",
      trendPanelOpen: false,
      archivedMenuOpen: false,
      historyBatchSize: HISTORY_BATCH_SIZE,
      visibleArchivedCount: HISTORY_BATCH_SIZE,
      expandedHistory: {},
      runDetailsById: {},
      runLoading: {},
      runErrors: {},
      overallChart: null,
      featureChart: null,
      historyObserver: null,
      pendingNavigationTarget: "",
    };
  },
  computed: {
    hasRuns() {
      return Boolean(this.index?.runs?.length);
    },
    latestSummary() {
      return this.index?.runs?.[0] || null;
    },
    latestScope() {
      return this.latestSummary ? runScope(this.latestSummary) : { kind: "unknown", label: "Run inputs unavailable" };
    },
    archivedSummaries() {
      return this.index?.runs?.slice(1) || [];
    },
    visibleArchivedSummaries() {
      return this.archivedSummaries.slice(0, this.visibleArchivedCount);
    },
    canLoadMoreHistory() {
      return this.visibleArchivedCount < this.archivedSummaries.length;
    },
    suiteOrder() {
      return this.index?.suite_order || [];
    },
    availableFeatureSuites() {
      return this.suiteOrder.filter((suiteKey) => (this.index?.charts?.overall?.[suiteKey] || []).length > 0);
    },
    selectedFeatureSuiteResolved() {
      if (this.availableFeatureSuites.includes(this.selectedFeatureSuite)) {
        return this.selectedFeatureSuite;
      }
      return this.availableFeatureSuites[0] || "s3_tests";
    },
    trendPanelLabel() {
      return this.trendPanelOpen ? "Hide charts" : "Show charts";
    },
    summaryCards() {
      const latest = this.latestSummary;
      if (!latest) return [];

      return this.suiteOrder
        .map((suiteKey) => {
          const suite = latest.suites?.[suiteKey];
          if (!suite) return null;

          const delta = deltaForSuite(this.index.runs, suiteKey);
          return {
            key: suiteKey,
            label: suite.label,
            eligible: suite.summary.eligible,
            rate: suite.summary.compatibility_rate,
            passed: suite.summary.passed,
            failedOrErrored: suite.summary.failed + suite.summary.errored,
            skipped: suite.summary.skipped,
            delta,
          };
        })
        .filter(Boolean);
    },
  },
  watch: {
    index(newIndex) {
      if (!newIndex) return;
      this.selectedFeatureSuite = this.availableFeatureSuites[0] || "s3_tests";
      this.$nextTick(() => {
        this.setupHistoryObserver();
      });
    },
    trendPanelOpen(open) {
      if (!open) return;
      this.$nextTick(() => {
        this.ensureCharts();
      });
    },
    selectedFeatureSuite() {
      if (!this.trendPanelOpen) return;
      this.$nextTick(() => {
        this.renderFeatureChart();
      });
    },
    visibleArchivedCount() {
      this.$nextTick(() => {
        this.setupHistoryObserver();
      });
    },
  },
  methods: {
    archivedRunAnchorId,
    formatDate,
    formatPercent,
    runId,
    runScope,
    statusClass,
    suiteLabel,
    deltaClass(delta) {
      if (delta === null) return "flat";
      return delta >= 0 ? "good" : "bad";
    },
    deltaText(delta) {
      if (delta === null) return "No previous data";
      return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts vs previous`;
    },
    isHistoryExpanded(summaryId) {
      return Boolean(this.expandedHistory[summaryId]);
    },
    historyRun(summaryId) {
      return this.runDetailsById[summaryId] || null;
    },
    historyRunLoading(summaryId) {
      return Boolean(this.runLoading[summaryId]);
    },
    historyRunError(summaryId) {
      return this.runErrors[summaryId] || "";
    },
    async bootstrap() {
      try {
        this.index = await fetchJson("./data/index.json", "Failed to load report index");
        this.loading = false;

        if (!this.hasRuns) {
          return;
        }

        const latestPromise = this.loadLatestRun();

        await this.$nextTick();
        this.setupHistoryObserver();

        const target = this.pendingNavigationTarget || window.location.hash.slice(1);
        if (target) {
          await this.navigateToSection(target, { expandArchived: true });
        }

        await latestPromise;
      } catch (error) {
        this.errorMessage = error.message;
        this.loading = false;
      }
    },
    async loadLatestRun() {
      if (!this.latestSummary) return;

      this.latestRunLoading = true;
      this.latestRunError = "";
      try {
        this.latestRun = await fetchRun(this.latestSummary.file);
      } catch (error) {
        this.latestRunError = error.message;
      } finally {
        this.latestRunLoading = false;
      }
    },
    async ensureHistoryRunLoaded(summary) {
      if (!summary || this.runDetailsById[summary.id] || this.runLoading[summary.id]) {
        return;
      }

      this.runErrors[summary.id] = "";
      this.runLoading[summary.id] = true;

      try {
        this.runDetailsById[summary.id] = await fetchRun(summary.file);
      } catch (error) {
        this.runErrors[summary.id] = error.message;
      } finally {
        this.runLoading[summary.id] = false;
      }
    },
    ensureHistoryVisible(summary) {
      const archivedIndex = this.archivedSummaries.findIndex((item) => item.id === summary.id);
      if (archivedIndex === -1) return;

      const requiredCount = archivedIndex + 1;
      if (this.visibleArchivedCount < requiredCount) {
        this.visibleArchivedCount = requiredCount;
      }
    },
    findArchivedSummary(targetId) {
      const archivedIndex = this.archivedSummaries.findIndex(
        (summary, runIndex) => archivedRunAnchorId(summary, runIndex) === targetId
      );

      if (archivedIndex === -1) {
        return null;
      }

      return {
        index: archivedIndex,
        summary: this.archivedSummaries[archivedIndex],
      };
    },
    loadMoreHistory() {
      if (!this.canLoadMoreHistory) return;
      this.visibleArchivedCount = Math.min(this.archivedSummaries.length, this.visibleArchivedCount + this.historyBatchSize);
    },
    async handleHistoryToggle({ summary, open }) {
      this.expandedHistory[summary.id] = open;
      if (open) {
        await this.ensureHistoryRunLoaded(summary);
      }
    },
    retryHistoryLoad(summary) {
      this.ensureHistoryRunLoaded(summary);
    },
    toggleArchivedMenu() {
      this.archivedMenuOpen = !this.archivedMenuOpen;
    },
    closeArchivedMenu() {
      this.archivedMenuOpen = false;
    },
    async handleStickyNavigation(targetId, options = {}) {
      this.closeArchivedMenu();
      await this.navigateToSection(targetId, options);
    },
    async navigateToSection(targetId, options = {}) {
      if (!targetId) return;

      if (this.loading || !this.index) {
        this.pendingNavigationTarget = targetId;
        return;
      }

      const { expandArchived = false } = options;
      let loadPromise = null;

      if (targetId === "trend-panel-section") {
        this.trendPanelOpen = true;
      }

      const archivedTarget = this.findArchivedSummary(targetId);
      if (archivedTarget) {
        this.ensureHistoryVisible(archivedTarget.summary);
        if (expandArchived) {
          this.expandedHistory[archivedTarget.summary.id] = true;
          loadPromise = this.ensureHistoryRunLoaded(archivedTarget.summary);
        }
      }

      await this.$nextTick();

      if (targetId === "trend-panel-section") {
        this.ensureCharts();
      }

      const target = document.getElementById(targetId);
      if (target) {
        scrollElementIntoView(target);
        window.history.replaceState(null, "", `#${targetId}`);
        this.pendingNavigationTarget = "";
      } else {
        this.pendingNavigationTarget = targetId;
      }

      if (loadPromise) {
        await loadPromise;
      }
    },
    handleDocumentClick(event) {
      const dropdown = this.$refs.archivedDropdown;
      if (dropdown && !dropdown.contains(event.target)) {
        this.closeArchivedMenu();
      }
    },
    handleDocumentFocus(event) {
      const dropdown = this.$refs.archivedDropdown;
      if (dropdown && !dropdown.contains(event.target)) {
        this.closeArchivedMenu();
      }
    },
    handleDocumentKeydown(event) {
      if (event.key === "Escape") {
        this.closeArchivedMenu();
      }
    },
    handleHashChange() {
      const target = window.location.hash.slice(1);
      if (target) {
        this.navigateToSection(target, { expandArchived: true });
      }
    },
    handleWindowResize() {
      this.overallChart?.resize();
      this.featureChart?.resize();
    },
    handleTrendToggle(event) {
      this.trendPanelOpen = event.target.open;
      if (this.trendPanelOpen) {
        this.$nextTick(() => {
          this.ensureCharts();
        });
      }
    },
    setupHistoryObserver() {
      this.destroyHistoryObserver();

      if (!("IntersectionObserver" in window) || !this.canLoadMoreHistory || !this.$refs.historySentinel) {
        return;
      }

      this.historyObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            this.loadMoreHistory();
          }
        },
        {
          rootMargin: "360px 0px",
        }
      );

      this.historyObserver.observe(this.$refs.historySentinel);
    },
    destroyHistoryObserver() {
      if (this.historyObserver) {
        this.historyObserver.disconnect();
        this.historyObserver = null;
      }
    },
    destroyCharts() {
      if (this.overallChart) {
        this.overallChart.destroy();
        this.overallChart = null;
      }

      if (this.featureChart) {
        this.featureChart.destroy();
        this.featureChart = null;
      }
    },
    ensureCharts() {
      if (!this.trendPanelOpen || !this.index || !this.$refs.overallChart || !this.$refs.featureChart || !window.Chart) {
        return;
      }

      this.renderOverallChart();
      this.renderFeatureChart();
    },
    renderOverallChart() {
      if (!this.$refs.overallChart || !window.Chart) return;

      if (this.overallChart) {
        this.overallChart.destroy();
      }

      const firstSuiteWithData = this.suiteOrder.find((suiteKey) => (this.index?.charts?.overall?.[suiteKey] || []).length > 0);
      const labels = chartLabels(this.index?.charts?.overall?.[firstSuiteWithData] || []);
      const datasets = this.suiteOrder
        .filter((suiteKey) => (this.index?.charts?.overall?.[suiteKey] || []).length > 0)
        .map((suiteKey, idx) => ({
          label: suiteLabel(suiteKey),
          data: (this.index?.charts?.overall?.[suiteKey] || []).map((point) =>
            point.rate === null || point.rate === undefined ? null : Number((point.rate * 100).toFixed(2))
          ),
          borderColor: COLORS[idx % COLORS.length],
          backgroundColor: COLORS[idx % COLORS.length],
          spanGaps: true,
          tension: 0.25,
          pointRadius: 3,
          borderWidth: 2,
        }));

      this.overallChart = new Chart(this.$refs.overallChart, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              grid: { color: "rgba(18, 38, 63, 0.06)" },
              ticks: {
                callback(value) {
                  return chartLabel(this.getLabelForValue(value));
                },
              },
            },
            y: {
              suggestedMin: 0,
              suggestedMax: 100,
              ticks: {
                callback(value) {
                  return `${value}%`;
                },
              },
              grid: { color: "rgba(18, 38, 63, 0.06)" },
            },
          },
          plugins: {
            legend: { display: true, position: "bottom" },
            tooltip: {
              callbacks: {
                title(items) {
                  return chartLabel(labels[items[0].dataIndex]);
                },
                label(context) {
                  return `${context.dataset.label}: ${context.parsed.y?.toFixed(1) ?? "—"}%`;
                },
              },
            },
          },
        },
      });
    },
    renderFeatureChart() {
      if (!this.$refs.featureChart || !window.Chart) return;

      if (this.featureChart) {
        this.featureChart.destroy();
      }

      const suiteKey = this.selectedFeatureSuiteResolved;
      const featureNames = topFeatureNames(this.index, suiteKey);
      const labels = featureLabels(this.index, suiteKey, featureNames);
      const datasets = featureNames.map((featureName, idx) => ({
        label: featureName.replace(/_/g, " "),
        data: featureValues(labels, this.index?.charts?.features?.[suiteKey]?.[featureName] || []),
        borderColor: COLORS[idx % COLORS.length],
        backgroundColor: COLORS[idx % COLORS.length],
        spanGaps: true,
        tension: 0.2,
        pointRadius: 2.5,
        borderWidth: 2,
      }));

      this.featureChart = new Chart(this.$refs.featureChart, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              grid: { color: "rgba(18, 38, 63, 0.06)" },
              ticks: {
                callback(value) {
                  return chartLabel(this.getLabelForValue(value));
                },
              },
            },
            y: {
              suggestedMin: 0,
              suggestedMax: 100,
              ticks: {
                callback(value) {
                  return `${value}%`;
                },
              },
              grid: { color: "rgba(18, 38, 63, 0.06)" },
            },
          },
          plugins: {
            legend: { display: true, position: "bottom" },
            tooltip: {
              callbacks: {
                title(items) {
                  return chartLabel(labels[items[0].dataIndex]);
                },
              },
            },
          },
        },
      });
    },
  },
  mounted() {
    document.addEventListener("click", this.handleDocumentClick);
    document.addEventListener("focusin", this.handleDocumentFocus);
    document.addEventListener("keydown", this.handleDocumentKeydown);
    window.addEventListener("hashchange", this.handleHashChange);
    window.addEventListener("resize", this.handleWindowResize);
    this.bootstrap();
  },
  beforeUnmount() {
    document.removeEventListener("click", this.handleDocumentClick);
    document.removeEventListener("focusin", this.handleDocumentFocus);
    document.removeEventListener("keydown", this.handleDocumentKeydown);
    window.removeEventListener("hashchange", this.handleHashChange);
    window.removeEventListener("resize", this.handleWindowResize);
    this.destroyHistoryObserver();
    this.destroyCharts();
  },
  template: `
    <div>
      <nav v-if="!loading && !errorMessage && hasRuns" class="sticky-nav" aria-label="Section navigation">
        <a class="sticky-link" href="#latest-run-section" @click.prevent="handleStickyNavigation('latest-run-section')">Latest Run</a>
        <a class="sticky-link" href="#trend-panel-section" @click.prevent="handleStickyNavigation('trend-panel-section')">Topline Trends</a>

        <div ref="archivedDropdown" class="sticky-dropdown" :class="{ open: archivedMenuOpen }">
          <button
            id="archived-run-toggle"
            class="sticky-link sticky-link-button"
            type="button"
            :aria-expanded="String(archivedMenuOpen)"
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

      <template v-else>
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
              <p class="subtle">{{ card.passed }} passed, {{ card.failedOrErrored }} failed/error, {{ card.skipped }} skipped</p>
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
            <RunDetails
              v-else-if="latestRun"
              :run="latestRun"
              :suite-order="suiteOrder"
              :default-suite-open="true"
            />
          </div>
        </section>

        <section id="trend-panel-section" class="panel section-anchor">
          <details id="trend-panel" class="panel-toggle" :open="trendPanelOpen" @toggle="handleTrendToggle">
            <summary class="panel-header panel-summary">
              <div>
                <p class="eyebrow">Topline Trends</p>
                <h2>Compatibility Over Time</h2>
              </div>
              <div class="panel-summary-side">
                <p class="panel-note">Rate is calculated as pass / (pass + fail + error).</p>
                <span class="panel-toggle-chip">{{ trendPanelLabel }}</span>
              </div>
            </summary>
            <div class="chart-grid">
              <article class="chart-card">
                <div class="chart-head">
                  <h3>Overall Suite Rate</h3>
                  <p>Daily compatibility trend for each suite.</p>
                </div>
                <canvas ref="overallChart" id="overall-chart" height="140"></canvas>
              </article>

              <article class="chart-card">
                <div class="chart-head">
                  <div>
                    <h3>Feature Trend</h3>
                    <p>Top features from the latest run, grouped by suite.</p>
                  </div>
                  <div class="tabs">
                    <button
                      v-for="suiteKey in availableFeatureSuites"
                      :key="suiteKey"
                      class="tab"
                      :class="{ active: selectedFeatureSuiteResolved === suiteKey }"
                      type="button"
                      @click="selectedFeatureSuite = suiteKey"
                    >
                      {{ suiteLabel(suiteKey) }}
                    </button>
                  </div>
                </div>
                <canvas ref="featureChart" id="feature-chart" height="140"></canvas>
              </article>
            </div>
          </details>
        </section>

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
    </div>
  `,
}).mount("#app");
