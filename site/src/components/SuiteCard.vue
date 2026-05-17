<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import { storedCaseSearchResult } from "../lib/caseResult";
import {
  CASE_BATCH_SIZE,
  compareFeatureRateWithPrevious,
  compareFeatureWithPrevious,
  formatPercent,
  formatRateDelta,
  statusClass,
  summarizeFeatureComparisons,
} from "../lib/report";
import { caseIdentityForResult, runDetailCaseUrlFromState } from "../lib/shareState";
import type { SearchResult } from "../lib/search";
import type {
  CaseStatusChange,
  FeatureComparison,
  FeatureComparisonSummary,
  FeatureSummaryRecord,
  FullRun,
  StoredCaseEntry,
  SuiteRecord,
} from "../lib/types";

interface FeaturePanel {
  key: string;
  label: string;
  summary: FeatureSummaryRecord["summary"];
  entries: StoredCaseEntry[];
  comparison: FeatureComparison;
}

const CASE_CHANGE_PREVIEW_LIMIT = 12;

const props = withDefaults(
  defineProps<{
    run: FullRun;
    runFile?: string;
    suiteKey: string;
    suite: SuiteRecord;
    previousSuite?: SuiteRecord | null;
    openByDefault?: boolean;
    isLatestRun?: boolean;
    casePermalinkHash?: string;
  }>(),
  {
    runFile: "",
    previousSuite: null,
    openByDefault: true,
    isLatestRun: false,
    casePermalinkHash: "",
  }
);

const emit = defineEmits<{
  "open-case": [result: SearchResult];
}>();

const isOpen = ref<boolean>(props.openByDefault);
const featureCaseDisplayCount = reactive<Record<string, number>>({});
const featureCaseComparisons = reactive<Record<string, FeatureComparison | undefined>>({});
const openFeatureKeys = reactive<Record<string, boolean>>({});

const cases = computed<StoredCaseEntry[]>(() => props.suite.cases || props.suite.non_passing_cases || []);
const failedOrErrored = computed<number>(() => (props.suite.summary?.failed || 0) + (props.suite.summary?.errored || 0));
const statusLabel = computed<string>(() => String(props.suite.status || "unknown").replace(/_/g, " "));
const featureMovement = computed<FeatureComparisonSummary>(() =>
  summarizeFeatureComparisons(props.suite, props.previousSuite)
);
const canCompareStoredCaseChanges = computed<boolean>(() =>
  suiteHasCaseMetadata(props.suite) && suiteHasCaseMetadata(props.previousSuite)
);
const featurePanels = computed<FeaturePanel[]>(() => {
  const caseBuckets = new Map<string, StoredCaseEntry[]>();
  const unmatchedCases: StoredCaseEntry[] = [];

  cases.value.forEach((entry) => {
    const entryFeatures = (entry.features || []).filter(Boolean);
    if (!entryFeatures.length) {
      unmatchedCases.push(entry);
      return;
    }

    entryFeatures.forEach((feature) => {
      const bucket = caseBuckets.get(feature) || [];
      bucket.push(entry);
      caseBuckets.set(feature, bucket);
    });
  });

  const panels = (props.suite.feature_summaries || []).map((feature) => ({
    key: feature.name,
    label: feature.label,
    summary: feature.summary,
    entries: caseBuckets.get(feature.name) || [],
    comparison: compareFeatureRateWithPrevious(props.suite, props.previousSuite, feature.name),
  }));

  if (unmatchedCases.length) {
    panels.push({
      key: "__untagged__",
      label: "Other / untagged",
      summary: {
        compatibility_rate: null,
        eligible: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        skipped: 0,
      },
      entries: unmatchedCases,
      comparison: {
        previousRate: null,
        delta: null,
        direction: "unknown",
        nowPassing: [],
        noLongerPassing: [],
      },
    });
  }

  return panels;
});
const featureOverviewNote = computed<string>(() => {
  const storageNote =
    props.suite.included_case_strategy === "non_passing_only"
      ? "Only non-passing cases are archived for this suite."
      : "Stored cases include every archived run case for this suite.";

  return `Click a feature row to expand its stored run detail. ${storageNote}`;
});

watch(
  [() => props.suite, () => props.previousSuite],
  () => {
    Object.keys(featureCaseComparisons).forEach((key) => {
      delete featureCaseComparisons[key];
    });
    featurePanels.value.forEach((panel) => {
      if (openFeatureKeys[panel.key]) {
        ensureFeatureCaseComparison(panel);
      }
    });
  }
);

function visibleEntriesForFeature(panel: FeaturePanel): StoredCaseEntry[] {
  const limit = featureCaseDisplayCount[panel.key] || CASE_BATCH_SIZE;
  return panel.entries.slice(0, limit);
}

function hasMoreEntriesForFeature(panel: FeaturePanel): boolean {
  return visibleEntriesForFeature(panel).length < panel.entries.length;
}

function loadMoreEntriesForFeature(panel: FeaturePanel): void {
  const nextCount = (featureCaseDisplayCount[panel.key] || CASE_BATCH_SIZE) + CASE_BATCH_SIZE;
  featureCaseDisplayCount[panel.key] = Math.min(panel.entries.length, nextCount);
}

function storedDetailLabel(panel: FeaturePanel): string {
  if (!panel.entries.length) {
    return "No stored detail";
  }
  return `${panel.entries.length} stored case${panel.entries.length === 1 ? "" : "s"}`;
}

function emptyFeatureMessage(): string {
  if (props.suite.included_case_strategy === "non_passing_only") {
    return "No stored case detail for this feature. Passing cases are not archived in this suite.";
  }
  return "No stored case detail for this feature.";
}

function featureComparisonClass(comparison: FeatureComparison): Record<string, boolean> {
  return {
    "feature-trend-improved": comparison.direction === "improved",
    "feature-trend-regressed": comparison.direction === "regressed",
  };
}

function featureDeltaClass(comparison: FeatureComparison): string {
  return `feature-delta-${comparison.direction}`;
}

function suiteHasCaseMetadata(suite: SuiteRecord | null | undefined): boolean {
  return Boolean(Array.isArray(suite?.cases) || Array.isArray(suite?.non_passing_cases));
}

function featureComparisonForPanel(panel: FeaturePanel): FeatureComparison {
  return featureCaseComparisons[panel.key] || panel.comparison;
}

function ensureFeatureCaseComparison(panel: FeaturePanel): void {
  if (
    panel.key === "__untagged__" ||
    panel.comparison.delta === null ||
    !canCompareStoredCaseChanges.value ||
    featureCaseComparisons[panel.key]
  ) {
    return;
  }

  featureCaseComparisons[panel.key] = compareFeatureWithPrevious(props.suite, props.previousSuite, panel.key);
}

function hasCaseChanges(comparison: FeatureComparison): boolean {
  return Boolean(comparison.nowPassing.length || comparison.noLongerPassing.length);
}

function visibleCaseChanges(changes: CaseStatusChange[]): CaseStatusChange[] {
  return changes.slice(0, CASE_CHANGE_PREVIEW_LIMIT);
}

function hiddenCaseChangeCount(changes: CaseStatusChange[]): number {
  return Math.max(0, changes.length - CASE_CHANGE_PREVIEW_LIMIT);
}

function caseStatusLabel(status: string): string {
  return String(status || "unknown").replace(/_/g, " ");
}

function featureCountText(count: number, state: "improved" | "degraded"): string {
  return `${count} feature${count === 1 ? "" : "s"} ${state}`;
}

function caseResult(entry: StoredCaseEntry): SearchResult {
  return storedCaseSearchResult({
    run: props.run,
    suiteKey: props.suiteKey,
    suite: props.suite,
    caseEntry: entry,
    runFile: props.runFile,
    isLatestRun: props.isLatestRun,
  });
}

function openCaseDetails(entry: StoredCaseEntry): void {
  emit("open-case", caseResult(entry));
}

function casePermalink(entry: StoredCaseEntry): string {
  return runDetailCaseUrlFromState(
    {
      selectedCase: caseIdentityForResult(caseResult(entry)),
      hash: props.casePermalinkHash,
    },
    window.location.href,
  );
}

function handleToggle(event: Event): void {
  const target = event.target as HTMLDetailsElement | null;
  if (target) {
    isOpen.value = target.open;
  }
}

function handleFeatureToggle(panel: FeaturePanel, event: Event): void {
  const target = event.target as HTMLDetailsElement | null;
  openFeatureKeys[panel.key] = Boolean(target?.open);
  if (openFeatureKeys[panel.key]) {
    ensureFeatureCaseComparison(panel);
  }
}
</script>

<template>
  <details class="suite-card suite-toggle" :open="isOpen" @toggle="handleToggle">
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

      <div v-if="featureMovement.comparable" class="feature-rollup suite-feature-rollup">
        <span class="feature-rollup-chip improved">
          {{ featureCountText(featureMovement.improved, "improved") }}
        </span>
        <span class="feature-rollup-chip regressed">
          {{ featureCountText(featureMovement.regressed, "degraded") }}
        </span>
      </div>

      <div v-if="!(suite.feature_summaries || []).length" class="loader">No feature summary was generated for this suite.</div>
      <div v-else class="feature-overview">
        <div class="feature-overview-top">
          <h4>Feature Run Stats</h4>
          <p class="subtle">{{ featureOverviewNote }}</p>
        </div>

        <div class="feature-overview-header" role="presentation">
          <span>Feature</span>
          <span>Rate</span>
          <span>Eligible</span>
          <span>Passed</span>
          <span>Failed + Error</span>
          <span>Skipped</span>
        </div>

        <details
          v-for="panel in featurePanels"
          :key="panel.key"
          class="feature-overview-item"
          :class="featureComparisonClass(panel.comparison)"
          @toggle="handleFeatureToggle(panel, $event)"
        >
          <summary class="feature-overview-summary">
            <span class="feature-cell feature-cell-name">
              <span class="feature-title">{{ panel.label }}</span>
              <span class="subtle feature-stored-label">{{ storedDetailLabel(panel) }}</span>
            </span>
            <span class="feature-cell feature-rate-cell" data-label="Rate">
              <span>{{ formatPercent(panel.summary.compatibility_rate) }}</span>
              <span
                v-if="panel.comparison.delta !== null"
                class="feature-delta-chip"
                :class="featureDeltaClass(panel.comparison)"
              >
                {{ formatRateDelta(panel.comparison.delta) }}
              </span>
            </span>
            <span class="feature-cell" data-label="Eligible">{{ panel.summary.eligible }}</span>
            <span class="feature-cell" data-label="Passed">{{ panel.summary.passed }}</span>
            <span class="feature-cell" data-label="Failed + Error">{{ panel.summary.failed + panel.summary.errored }}</span>
            <span class="feature-cell" data-label="Skipped">{{ panel.summary.skipped }}</span>
          </summary>

          <div class="feature-overview-body">
            <div v-if="panel.comparison.delta !== null" class="feature-comparison-detail">
              <div v-if="featureComparisonForPanel(panel).nowPassing.length" class="case-change-group case-change-improved">
                <h5>Now passing vs previous</h5>
                <ul class="case-change-list">
                  <li v-for="entry in visibleCaseChanges(featureComparisonForPanel(panel).nowPassing)" :key="entry.key">
                    <span class="case-change-name">{{ entry.name }}</span>
                    <span v-if="entry.classname" class="subtle mono">{{ entry.classname }}</span>
                    <span class="case-change-transition">
                      {{ caseStatusLabel(entry.fromStatus) }} -> {{ caseStatusLabel(entry.toStatus) }}
                    </span>
                  </li>
                </ul>
                <p v-if="hiddenCaseChangeCount(featureComparisonForPanel(panel).nowPassing)" class="subtle">
                  {{ hiddenCaseChangeCount(featureComparisonForPanel(panel).nowPassing) }} more now passing.
                </p>
              </div>

              <div v-if="featureComparisonForPanel(panel).noLongerPassing.length" class="case-change-group case-change-regressed">
                <h5>No longer passing vs previous</h5>
                <ul class="case-change-list">
                  <li v-for="entry in visibleCaseChanges(featureComparisonForPanel(panel).noLongerPassing)" :key="entry.key">
                    <span class="case-change-name">{{ entry.name }}</span>
                    <span v-if="entry.classname" class="subtle mono">{{ entry.classname }}</span>
                    <span class="case-change-transition">
                      {{ caseStatusLabel(entry.fromStatus) }} -> {{ caseStatusLabel(entry.toStatus) }}
                    </span>
                  </li>
                </ul>
                <p v-if="hiddenCaseChangeCount(featureComparisonForPanel(panel).noLongerPassing)" class="subtle">
                  {{ hiddenCaseChangeCount(featureComparisonForPanel(panel).noLongerPassing) }} more no longer passing.
                </p>
              </div>

              <p v-if="!canCompareStoredCaseChanges" class="subtle feature-comparison-empty">
                Stored test status changes need full detail for both this run and the previous run.
              </p>
              <p v-else-if="!hasCaseChanges(featureComparisonForPanel(panel))" class="subtle feature-comparison-empty">
                No stored test status changes for this feature.
              </p>
            </div>

            <div v-if="!panel.entries.length" class="loader feature-detail-empty">
              {{ emptyFeatureMessage() }}
            </div>
            <div v-else class="case-list">
              <article v-for="entry in visibleEntriesForFeature(panel)" :key="entry.name + ':' + entry.status" class="case-item">
                <div class="case-item-head">
                  <div>
                    <h5>{{ entry.name }}</h5>
                    <div v-if="(entry.features || []).length" class="feature-tags">
                      <span v-for="feature in entry.features" :key="feature" class="feature-tag">
                        {{ feature.replace(/_/g, " ") }}
                      </span>
                    </div>
                  </div>
                  <span class="status-pill" :class="statusClass(entry.status)">
                    {{ String(entry.status || "unknown").replace(/_/g, " ") }}
                  </span>
                </div>
                <div class="case-item-actions">
                  <button class="inline-button" type="button" @click.stop="openCaseDetails(entry)">Details</button>
                  <a class="inline-button" :href="casePermalink(entry)" @click.stop>Permalink</a>
                </div>
                <div class="case-meta subtle mono">
                  <span v-if="entry.classname">{{ entry.classname }}</span>
                  <span v-if="entry.duration_ms !== null && entry.duration_ms !== undefined">{{ entry.duration_ms }} ms</span>
                </div>
                <div v-if="entry.message" class="callout">{{ entry.message }}</div>
              </article>

              <button
                v-if="hasMoreEntriesForFeature(panel)"
                class="inline-button feature-load-more"
                type="button"
                @click.stop="loadMoreEntriesForFeature(panel)"
              >
                Load {{ Math.min(CASE_BATCH_SIZE, panel.entries.length - visibleEntriesForFeature(panel).length) }} more
              </button>
            </div>
          </div>
        </details>
      </div>
    </div>
  </details>
</template>
