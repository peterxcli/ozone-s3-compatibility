<script setup lang="ts">
import { computed, ref } from "vue";

import { CASE_BATCH_SIZE, formatPercent, statusClass } from "../lib/report";
import type { StoredCaseEntry, SuiteRecord } from "../lib/types";

const props = withDefaults(
  defineProps<{
    suite: SuiteRecord;
    openByDefault?: boolean;
  }>(),
  {
    openByDefault: true,
  }
);

const isOpen = ref<boolean>(props.openByDefault);
const caseDisplayCount = ref<number>(CASE_BATCH_SIZE);

const cases = computed<StoredCaseEntry[]>(() => props.suite.cases || props.suite.non_passing_cases || []);
const shownCases = computed<StoredCaseEntry[]>(() => cases.value.slice(0, caseDisplayCount.value));
const hasMoreCases = computed<boolean>(() => caseDisplayCount.value < cases.value.length);
const caseNote = computed<string>(() =>
  props.suite.included_case_strategy === "non_passing_only"
    ? "Archived case details are stored for non-passing s3-tests cases only to keep the history lightweight."
    : "Showing all stored cases for this suite."
);
const failedOrErrored = computed<number>(() => (props.suite.summary?.failed || 0) + (props.suite.summary?.errored || 0));
const statusLabel = computed<string>(() => String(props.suite.status || "unknown").replace(/_/g, " "));

function loadMoreCases(): void {
  caseDisplayCount.value = Math.min(cases.value.length, caseDisplayCount.value + CASE_BATCH_SIZE);
}

function handleToggle(event: Event): void {
  const target = event.target as HTMLDetailsElement | null;
  if (target) {
    isOpen.value = target.open;
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
            <p class="subtle">
              {{ shownCases.length }}
              <span v-if="cases.length > shownCases.length"> / {{ cases.length }}</span>
              shown
            </p>
            <button v-if="hasMoreCases" class="inline-button" type="button" @click.stop="loadMoreCases">
              Load {{ Math.min(CASE_BATCH_SIZE, cases.length - caseDisplayCount) }} more
            </button>
          </div>
        </div>

        <div class="case-list">
          <article v-for="entry in shownCases" :key="entry.name + ':' + entry.status" class="case-item">
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
</template>
