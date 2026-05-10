<script setup lang="ts">
import { computed } from "vue";

import RunDetails from "./RunDetails.vue";
import {
  archivedRunAnchorId,
  formatDate,
  formatPercent,
  orderedSuitesFromRun,
  runId,
  runScope,
  statusClass,
  summarizeFeatureComparisons,
  suiteLabel,
} from "../lib/report";
import type {
  FeatureComparisonSummary,
  FullRun,
  HistoryTogglePayload,
  OrderedSuiteEntry,
  RunLike,
  RunSummary,
} from "../lib/types";

interface SuiteSummaryEntry extends OrderedSuiteEntry {
  featureMovement: FeatureComparisonSummary;
}

const props = withDefaults(
  defineProps<{
    summary: RunSummary;
    runIndex: number;
    suiteOrder?: string[];
    runData?: FullRun | null;
    previousRun?: RunLike | null;
    loading?: boolean;
    error?: string;
    expanded?: boolean;
  }>(),
  {
    suiteOrder: () => [],
    runData: null,
    previousRun: null,
    loading: false,
    error: "",
    expanded: false,
  }
);

const emit = defineEmits<{
  toggle: [payload: HistoryTogglePayload];
  retry: [summary: RunSummary];
}>();

const anchorId = computed(() => archivedRunAnchorId(props.summary, props.runIndex));
const suiteSummaries = computed<SuiteSummaryEntry[]>(() =>
  orderedSuitesFromRun(props.summary, props.suiteOrder).map((entry) => ({
    ...entry,
    featureMovement: featureMovementForSuite(entry),
  }))
);
const scopeInfo = computed(() => runScope(props.summary));
const statusLabel = computed(() => String(props.summary.status || "unknown").replace(/_/g, " "));

function featureMovementForSuite(entry: OrderedSuiteEntry): FeatureComparisonSummary {
  return summarizeFeatureComparisons(entry.suite, props.previousRun?.suites?.[entry.key] || null);
}

function featureCountText(count: number, state: "improved" | "degraded"): string {
  return `${count} feature${count === 1 ? "" : "s"} ${state}`;
}

function handleToggle(event: Event): void {
  const target = event.target as HTMLDetailsElement | null;
  if (!target) return;
  emit("toggle", { summary: props.summary, open: target.open });
}

function retry(): void {
  emit("retry", props.summary);
}
</script>

<template>
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
            <span class="status-pill" :class="statusClass(entry.suite.status)">
              {{ String(entry.suite.status || "unknown").replace(/_/g, " ") }}
            </span>
            <span class="pill">{{ formatPercent(entry.suite.summary.compatibility_rate) }}</span>
            <span class="pill">{{ entry.suite.summary.eligible }} eligible</span>
          </div>
          <div v-if="entry.featureMovement.comparable" class="feature-rollup history-feature-rollup">
            <span class="feature-rollup-chip improved">
              {{ featureCountText(entry.featureMovement.improved, "improved") }}
            </span>
            <span class="feature-rollup-chip regressed">
              {{ featureCountText(entry.featureMovement.regressed, "degraded") }}
            </span>
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
        :previous-run="previousRun"
        :suite-order="suiteOrder"
        :default-suite-open="false"
      />
      <div v-else class="loader history-detail-state">Open this run to load its full detail.</div>
    </div>
  </details>
</template>
