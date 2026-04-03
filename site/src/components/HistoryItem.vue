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
  suiteLabel,
} from "../lib/report";
import type { FullRun, HistoryTogglePayload, RunSummary } from "../lib/types";

const props = withDefaults(
  defineProps<{
    summary: RunSummary;
    runIndex: number;
    suiteOrder?: string[];
    runData?: FullRun | null;
    loading?: boolean;
    error?: string;
    expanded?: boolean;
  }>(),
  {
    suiteOrder: () => [],
    runData: null,
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
const suiteSummaries = computed(() => orderedSuitesFromRun(props.summary, props.suiteOrder));
const scopeInfo = computed(() => runScope(props.summary));
const statusLabel = computed(() => String(props.summary.status || "unknown").replace(/_/g, " "));

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
        </div>
      </div>
    </summary>

    <div class="history-body">
      <div v-if="loading" class="loader history-detail-state">Loading run detail…</div>
      <div v-else-if="error" class="loader history-detail-state">
        {{ error }}
        <button class="inline-button" type="button" @click.stop="retry">Retry</button>
      </div>
      <RunDetails v-else-if="runData" :run="runData" :suite-order="suiteOrder" :default-suite-open="false" />
      <div v-else class="loader history-detail-state">Open this run to load its full detail.</div>
    </div>
  </details>
</template>
