<script setup lang="ts">
import { computed, reactive, ref } from "vue";

import { CASE_BATCH_SIZE, formatPercent, statusClass } from "../lib/report";
import type { FeatureSummaryRecord, StoredCaseEntry, SuiteRecord } from "../lib/types";

interface FeaturePanel {
  key: string;
  label: string;
  summary: FeatureSummaryRecord["summary"];
  entries: StoredCaseEntry[];
}

const props = withDefaults(
  defineProps<{
    suiteKey: string;
    suite: SuiteRecord;
    openByDefault?: boolean;
  }>(),
  {
    openByDefault: true,
  }
);

const isOpen = ref<boolean>(props.openByDefault);
const featureCaseDisplayCount = reactive<Record<string, number>>({});

const cases = computed<StoredCaseEntry[]>(() => props.suite.cases || props.suite.non_passing_cases || []);
const failedOrErrored = computed<number>(() => (props.suite.summary?.failed || 0) + (props.suite.summary?.errored || 0));
const statusLabel = computed<string>(() => String(props.suite.status || "unknown").replace(/_/g, " "));
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

        <details v-for="panel in featurePanels" :key="panel.key" class="feature-overview-item">
          <summary class="feature-overview-summary">
            <span class="feature-cell feature-cell-name">
              <span class="feature-title">{{ panel.label }}</span>
              <span class="subtle feature-stored-label">{{ storedDetailLabel(panel) }}</span>
            </span>
            <span class="feature-cell">{{ formatPercent(panel.summary.compatibility_rate) }}</span>
            <span class="feature-cell">{{ panel.summary.eligible }}</span>
            <span class="feature-cell">{{ panel.summary.passed }}</span>
            <span class="feature-cell">{{ panel.summary.failed + panel.summary.errored }}</span>
            <span class="feature-cell">{{ panel.summary.skipped }}</span>
          </summary>

          <div class="feature-overview-body">
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
