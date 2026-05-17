<script setup lang="ts">
import { computed } from "vue";

import SuiteCard from "./SuiteCard.vue";
import {
  DEFAULT_MINT_MODE,
  DEFAULT_OZONE_DATANODES,
  DEFAULT_S3_TESTS_ARGS,
  executionForRun,
  formatDate,
  orderedSuitesFromRun,
  runScope,
  summarizeFeatureComparisons,
  suiteLabel,
} from "../lib/report";
import type { SearchResult } from "../lib/search";
import type { FeatureComparisonSummary, FullRun, LogFileRecord, RunLike } from "../lib/types";

interface RunSuiteFeatureMovement {
  key: string;
  label: string;
  featureMovement: FeatureComparisonSummary;
}

const props = withDefaults(
  defineProps<{
    run: FullRun;
    runFile?: string;
    previousRun?: RunLike | null;
    suiteOrder?: string[];
    defaultSuiteOpen?: boolean;
    isLatestRun?: boolean;
    casePermalinkHash?: string;
  }>(),
  {
    runFile: "",
    previousRun: null,
    suiteOrder: () => [],
    defaultSuiteOpen: true,
    isLatestRun: false,
    casePermalinkHash: "",
  }
);

const emit = defineEmits<{
  "open-case": [result: SearchResult];
  "open-log": [logFile: LogFileRecord];
}>();

const orderedSuites = computed(() => orderedSuitesFromRun(props.run, props.suiteOrder));
const previousSuites = computed(() => props.previousRun?.suites || {});
const runFeatureMovements = computed<RunSuiteFeatureMovement[]>(() =>
  orderedSuites.value
    .map((entry) => ({
      key: entry.key,
      label: suiteLabel(entry.key),
      featureMovement: summarizeFeatureComparisons(entry.suite, previousSuites.value[entry.key] || null),
    }))
    .filter((entry) => entry.featureMovement.comparable > 0)
);
const execution = computed(() => executionForRun(props.run));
const scopeInfo = computed(() => runScope(props.run));
const ozoneCommit = computed(() => props.run.sources?.ozone?.short_commit || "unknown");
const s3TestsCommit = computed(() => props.run.sources?.s3_tests?.short_commit || "unknown");
const mintCommit = computed(() => props.run.sources?.mint?.short_commit || "unknown");
const logFiles = computed(() => props.run.log_files || []);

const showS3SelectorChip = computed(
  () => execution.value && execution.value.s3_tests_args !== DEFAULT_S3_TESTS_ARGS
);
const showMintTargetsChip = computed(() => execution.value && execution.value.mint_targets.length > 0);
const showMintModeChip = computed(() => execution.value && execution.value.mint_mode !== DEFAULT_MINT_MODE);
const showDatanodesChip = computed(
  () => execution.value && execution.value.ozone_datanodes !== DEFAULT_OZONE_DATANODES
);

function featureCountText(count: number, state: "improved" | "degraded"): string {
  return `${count} feature${count === 1 ? "" : "s"} ${state}`;
}

function openCase(result: SearchResult): void {
  emit("open-case", result);
}

function openLog(logFile: LogFileRecord): void {
  emit("open-log", logFile);
}
</script>

<template>
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
      <span v-if="showS3SelectorChip" class="meta-chip mono">s3-tests selector: {{ execution?.s3_tests_args }}</span>
      <span v-if="showMintTargetsChip" class="meta-chip mono">mint targets: {{ execution?.mint_targets.join(" ") }}</span>
      <span v-if="showMintModeChip" class="meta-chip">Mint mode: {{ execution?.mint_mode }}</span>
      <span v-if="showDatanodesChip" class="meta-chip">{{ execution?.ozone_datanodes }} datanodes</span>
    </div>

    <div v-if="runFeatureMovements.length" class="run-feature-summary">
      <div v-for="entry in runFeatureMovements" :key="entry.key" class="run-feature-summary-item">
        <span class="run-feature-summary-suite">{{ entry.label }}</span>
        <span class="feature-rollup-chip improved">
          {{ featureCountText(entry.featureMovement.improved, "improved") }}
        </span>
        <span class="feature-rollup-chip regressed">
          {{ featureCountText(entry.featureMovement.regressed, "degraded") }}
        </span>
      </div>
    </div>

    <section v-if="run.log_files?.length" class="run-log-list" aria-label="Run logs">
      <div class="run-log-head">
        <div>
          <p class="eyebrow">Logs</p>
          <h3>Run Logs</h3>
        </div>
        <span class="pill">{{ logFiles.length }} files</span>
      </div>
      <div class="run-log-buttons">
        <button
          v-for="logFile in logFiles"
          :key="`${logFile.log_source}:${logFile.log_file}`"
          class="run-log-button"
          type="button"
          @click="openLog(logFile)"
        >
          <span class="run-log-source">{{ logFile.log_source }}</span>
          <span class="run-log-path mono">{{ logFile.log_file }}</span>
          <span class="pill">{{ logFile.line_count.toLocaleString() }} lines</span>
        </button>
      </div>
    </section>

    <div class="suite-grid">
      <SuiteCard
        v-for="entry in orderedSuites"
        :key="entry.key"
        :run="run"
        :run-file="runFile"
        :suite-key="entry.key"
        :suite="entry.suite"
        :previous-suite="previousSuites[entry.key] || null"
        :open-by-default="defaultSuiteOpen"
        :is-latest-run="isLatestRun"
        :case-permalink-hash="casePermalinkHash"
        @open-case="openCase"
      />
    </div>
  </div>
</template>
