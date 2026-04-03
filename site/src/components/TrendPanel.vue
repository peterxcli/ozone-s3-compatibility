<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Chart } from "chart.js/auto";

import {
  COLORS,
  chartLabel,
  chartLabels,
  featureLabels,
  featureValues,
  suiteLabel,
  topFeatureNames,
} from "../lib/report";
import type { IndexPayload } from "../lib/types";

const props = withDefaults(
  defineProps<{
    index: IndexPayload;
    open?: boolean;
  }>(),
  {
    open: false,
  }
);

const emit = defineEmits<{
  "update:open": [open: boolean];
}>();

const overallCanvas = ref<HTMLCanvasElement | null>(null);
const featureCanvas = ref<HTMLCanvasElement | null>(null);
const selectedFeatureSuite = ref<string>("");

let overallChart: Chart | null = null;
let featureChart: Chart | null = null;

const suiteOrder = computed(() => props.index?.suite_order || []);
const availableFeatureSuites = computed(() =>
  suiteOrder.value.filter((suiteKey) => (props.index?.charts?.overall?.[suiteKey] || []).length > 0)
);
const selectedFeatureSuiteResolved = computed(() => {
  if (availableFeatureSuites.value.includes(selectedFeatureSuite.value)) {
    return selectedFeatureSuite.value;
  }
  return availableFeatureSuites.value[0] || "s3_tests";
});
const trendPanelLabel = computed(() => (props.open ? "Hide charts" : "Show charts"));

watch(
  availableFeatureSuites,
  (suites: string[]) => {
    if (!selectedFeatureSuite.value && suites.length > 0) {
      selectedFeatureSuite.value = suites[0];
    }
  },
  { immediate: true }
);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    requestAnimationFrame(() => {
      renderCharts();
    });
  }
);

watch(selectedFeatureSuite, async () => {
  if (!props.open) return;
  await nextTick();
  requestAnimationFrame(() => {
    renderFeatureChart();
  });
});

watch(
  () => props.index,
  async () => {
    destroyCharts();
    if (!props.open) return;
    await nextTick();
    requestAnimationFrame(() => {
      renderCharts();
    });
  }
);

function destroyCharts(): void {
  if (overallChart) {
    overallChart.destroy();
    overallChart = null;
  }

  if (featureChart) {
    featureChart.destroy();
    featureChart = null;
  }
}

function renderOverallChart(): void {
  if (!overallCanvas.value) return;

  if (overallChart) {
    overallChart.destroy();
  }

  const firstSuiteWithData = suiteOrder.value.find((suiteKey) => (props.index.charts.overall[suiteKey] || []).length > 0);
  const labels = chartLabels(firstSuiteWithData ? props.index.charts.overall[firstSuiteWithData] || [] : []);
  const datasets = suiteOrder.value
    .filter((suiteKey) => (props.index.charts.overall[suiteKey] || []).length > 0)
    .map((suiteKey, idx) => ({
      label: suiteLabel(suiteKey),
      data: (props.index.charts.overall[suiteKey] || []).map((point) =>
        point.rate === null || point.rate === undefined ? null : Number((point.rate * 100).toFixed(2))
      ),
      borderColor: COLORS[idx % COLORS.length],
      backgroundColor: COLORS[idx % COLORS.length],
      spanGaps: true,
      tension: 0.25,
      pointRadius: 3,
      pointHitRadius: 14,
      pointHoverRadius: 6,
      borderWidth: 2,
    }));

  overallChart = new Chart(overallCanvas.value, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      hover: {
        mode: "index",
        intersect: false,
      },
      scales: {
        x: {
          grid: { color: "rgba(18, 38, 63, 0.06)" },
          ticks: {
            callback(value) {
              const numericValue = typeof value === "number" ? value : Number(value);
              return chartLabel(String(this.getLabelForValue(numericValue)));
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
}

function renderFeatureChart(): void {
  if (!featureCanvas.value) return;

  if (featureChart) {
    featureChart.destroy();
  }

  const suiteKey = selectedFeatureSuiteResolved.value;
  const featureNames = topFeatureNames(props.index, suiteKey);
  const labels = featureLabels(props.index, suiteKey, featureNames);
  const datasets = featureNames.map((featureName, idx) => ({
    label: featureName.replace(/_/g, " "),
    data: featureValues(labels, props.index.charts.features[suiteKey]?.[featureName] || []),
    borderColor: COLORS[idx % COLORS.length],
    backgroundColor: COLORS[idx % COLORS.length],
    spanGaps: true,
    tension: 0.2,
    pointRadius: 2.5,
    pointHitRadius: 14,
    pointHoverRadius: 6,
    borderWidth: 2,
  }));

  featureChart = new Chart(featureCanvas.value, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      hover: {
        mode: "index",
        intersect: false,
      },
      scales: {
        x: {
          grid: { color: "rgba(18, 38, 63, 0.06)" },
          ticks: {
            callback(value) {
              const numericValue = typeof value === "number" ? value : Number(value);
              return chartLabel(String(this.getLabelForValue(numericValue)));
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
}

function renderCharts(): void {
  if (!props.open) return;
  renderOverallChart();
  renderFeatureChart();
}

function handleToggle(event: Event): void {
  const target = event.target as HTMLDetailsElement | null;
  if (target) {
    emit("update:open", target.open);
  }
}

function resizeCharts(): void {
  overallChart?.resize();
  featureChart?.resize();
}

defineExpose({
  renderCharts,
  resizeCharts,
});

onBeforeUnmount(() => {
  destroyCharts();
});
</script>

<template>
  <section id="trend-panel-section" class="panel section-anchor">
    <details id="trend-panel" class="panel-toggle" :open="open" @toggle="handleToggle">
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
          <canvas ref="overallCanvas" id="overall-chart" height="140"></canvas>
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
          <canvas ref="featureCanvas" id="feature-chart" height="140"></canvas>
        </article>
      </div>
    </details>
  </section>
</template>
