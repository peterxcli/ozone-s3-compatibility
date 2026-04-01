const COLORS = ["#0d7fab", "#ff8a3d", "#0f9d71", "#7a62ff", "#d2493a", "#0097a7", "#9c6b00", "#d81b60"];

let overallChart;
let featureChart;
let chartsReady = false;

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

function text(value) {
  return value ?? "";
}

function suiteLabel(key) {
  return key === "s3_tests" ? "s3-tests" : "mint";
}

function statusClass(status) {
  return String(status || "").replace(/[^a-z_]+/g, "_");
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

function renderHero(index) {
  const latest = index.runs[0];
  const heroMeta = document.getElementById("hero-meta");
  const summaryCards = document.getElementById("summary-cards");

  heroMeta.innerHTML = `
    <span class="meta-chip mono">${formatDate(latest.started_at)}</span>
    <span class="meta-chip mono">Ozone ${latest.sources.ozone.short_commit}</span>
    <span class="meta-chip">${latest.status.replace(/_/g, " ")}</span>
    ${latest.workflow_run_url ? `<a class="meta-chip" href="${latest.workflow_run_url}">GitHub Actions run</a>` : ""}
  `;

  summaryCards.innerHTML = index.suite_order
    .map((suiteKey) => {
      const suite = latest.suites[suiteKey];
      if (!suite) return "";
      const delta = deltaForSuite(index.runs, suiteKey);
      const deltaClass = delta === null ? "flat" : delta >= 0 ? "good" : "bad";
      const deltaText =
        delta === null ? "No previous data" : `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts vs previous`;
      return `
        <article class="summary-card">
          <p class="eyebrow">${suite.label}</p>
          <h3>${suite.summary.eligible} eligible cases</h3>
          <p class="big-number">${formatPercent(suite.summary.compatibility_rate)}</p>
          <p class="subtle">
            ${suite.summary.passed} passed, ${suite.summary.failed + suite.summary.errored} failed/error,
            ${suite.summary.skipped} skipped
          </p>
          <p class="delta ${deltaClass}">${deltaText}</p>
        </article>
      `;
    })
    .join("");
}

function buildOverallChart(index) {
  const context = document.getElementById("overall-chart");
  const labels = chartLabels(index.charts.overall[index.suite_order.find((key) => (index.charts.overall[key] || []).length > 0)] || []);
  const datasets = index.suite_order
    .filter((suiteKey) => (index.charts.overall[suiteKey] || []).length > 0)
    .map((suiteKey, idx) => ({
      label: suiteLabel(suiteKey),
      data: index.charts.overall[suiteKey].map((point) =>
        point.rate === null || point.rate === undefined ? null : Number((point.rate * 100).toFixed(2))
      ),
      borderColor: COLORS[idx % COLORS.length],
      backgroundColor: COLORS[idx % COLORS.length],
      spanGaps: true,
      tension: 0.25,
      pointRadius: 3,
      borderWidth: 2,
    }));

  overallChart = new Chart(context, {
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
}

function featureLabels(index, suiteKey, featureNames) {
  const seen = new Set();
  featureNames.forEach((featureName) => {
    (index.charts.features[suiteKey]?.[featureName] || []).forEach((point) => {
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

function renderFeatureChart(index, suiteKey) {
  const featureNames = topFeatureNames(index, suiteKey);
  const seriesByFeature = index.charts.features[suiteKey] || {};
  const labels = featureLabels(index, suiteKey, featureNames);
  const datasets = featureNames.map((featureName, idx) => ({
    label: featureName.replace(/_/g, " "),
    data: featureValues(labels, seriesByFeature[featureName] || []),
    borderColor: COLORS[idx % COLORS.length],
    backgroundColor: COLORS[idx % COLORS.length],
    spanGaps: true,
    tension: 0.2,
    pointRadius: 2.5,
    borderWidth: 2,
  }));

  if (featureChart) {
    featureChart.destroy();
  }

  featureChart = new Chart(document.getElementById("feature-chart"), {
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
}

function topFeatureNames(index, suiteKey) {
  const latest = index.runs[0]?.suites?.[suiteKey]?.feature_summaries || [];
  return latest
    .filter((item) => item.summary.eligible > 0)
    .slice(0, 8)
    .map((item) => item.name);
}

function buildFeatureTabs(index) {
  const tabs = document.getElementById("feature-suite-tabs");
  const availableSuites = index.suite_order.filter((suiteKey) => (index.charts.overall[suiteKey] || []).length > 0);
  const latestAvailable = availableSuites[0] || "s3_tests";

  tabs.innerHTML = availableSuites
    .map(
      (suiteKey) =>
        `<button class="tab ${suiteKey === latestAvailable ? "active" : ""}" data-suite="${suiteKey}">${suiteLabel(suiteKey)}</button>`
    )
    .join("");

  tabs.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      tabs.querySelectorAll(".tab").forEach((node) => node.classList.remove("active"));
      button.classList.add("active");
      renderFeatureChart(index, button.dataset.suite);
    });
  });

  renderFeatureChart(index, latestAvailable);
}

function updateTrendPanelLabel() {
  const label = document.getElementById("trend-panel-label");
  const panel = document.getElementById("trend-panel");
  if (!label || !panel) return;
  label.textContent = panel.open ? label.dataset.openLabel : label.dataset.closedLabel;
}

function ensureCharts(index) {
  if (chartsReady) {
    overallChart?.resize();
    featureChart?.resize();
    return;
  }
  buildOverallChart(index);
  buildFeatureTabs(index);
  chartsReady = true;
}

function setupTrendPanel(index) {
  const panel = document.getElementById("trend-panel");
  if (!panel) return;

  updateTrendPanelLabel();

  const renderCharts = () => {
    window.requestAnimationFrame(() => {
      ensureCharts(index);
    });
  };

  if (panel.open) {
    renderCharts();
  }

  panel.addEventListener("toggle", () => {
    updateTrendPanelLabel();
    if (panel.open) {
      renderCharts();
    }
  });
}

function renderMetrics(summary) {
  return `
    <div class="metrics">
      <div class="metric"><span class="metric-label">Compatibility</span><span class="metric-value">${formatPercent(summary.compatibility_rate)}</span></div>
      <div class="metric"><span class="metric-label">Eligible</span><span class="metric-value">${summary.eligible}</span></div>
      <div class="metric"><span class="metric-label">Passed</span><span class="metric-value">${summary.passed}</span></div>
      <div class="metric"><span class="metric-label">Failed + Error</span><span class="metric-value">${summary.failed + summary.errored}</span></div>
      <div class="metric"><span class="metric-label">Skipped</span><span class="metric-value">${summary.skipped}</span></div>
    </div>
  `;
}

function renderFeatureTable(featureSummaries) {
  if (!featureSummaries.length) {
    return `<div class="loader">No feature summary was generated for this suite.</div>`;
  }
  return `
    <div class="table-wrap">
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
          ${featureSummaries
            .map(
              (feature) => `
                <tr>
                  <td>${feature.label}</td>
                  <td>${formatPercent(feature.summary.compatibility_rate)}</td>
                  <td>${feature.summary.eligible}</td>
                  <td>${feature.summary.passed}</td>
                  <td>${feature.summary.failed + feature.summary.errored}</td>
                  <td>${feature.summary.skipped}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderCases(suite) {
  const cases = suite.cases || suite.non_passing_cases || [];
  if (!cases.length) {
    return `<div class="loader">No case-level details were stored for this suite.</div>`;
  }

  const shownCases = cases.slice(0, 200);
  const note =
    suite.included_case_strategy === "non_passing_only"
      ? "Archived case details are stored for non-passing s3-tests cases only to keep the history lightweight."
      : "Showing all stored cases for this suite.";

  return `
    <div class="cases-card">
      <div class="suite-head">
        <div>
          <h3>Case Detail</h3>
          <p class="subtle">${note}</p>
        </div>
        <p class="subtle">${shownCases.length}${cases.length > shownCases.length ? ` / ${cases.length}` : ""} shown</p>
      </div>
      <div class="case-list">
        ${shownCases
          .map(
            (entry) => `
              <article class="case-item">
                <div class="case-item-head">
                  <div>
                    <h5>${text(entry.name)}</h5>
                    <div class="feature-tags">
                      ${(entry.features || [])
                        .map((feature) => `<span class="feature-tag">${feature.replace(/_/g, " ")}</span>`)
                        .join("")}
                    </div>
                  </div>
                  <span class="status-pill ${statusClass(entry.status)}">${entry.status.replace(/_/g, " ")}</span>
                </div>
                <div class="case-meta subtle mono">
                  ${text(entry.classname || "")}
                  ${entry.duration_ms ? `• ${entry.duration_ms} ms` : ""}
                </div>
                ${entry.message ? `<div class="callout">${text(entry.message)}</div>` : ""}
              </article>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderSuiteCard(suite) {
  return `
    <article class="suite-card">
      <div class="suite-head">
        <div>
          <p class="eyebrow">${suite.label}</p>
          <h3>${suite.status.replace(/_/g, " ")}</h3>
        </div>
        <span class="status-pill ${statusClass(suite.status)}">${suite.status.replace(/_/g, " ")}</span>
      </div>
      ${renderMetrics(suite.summary)}
      ${renderFeatureTable(suite.feature_summaries || [])}
      ${renderCases(suite)}
    </article>
  `;
}

function renderRunDetails(run) {
  const suiteMarkup = Object.values(run.suites || {})
    .map((suite) => renderSuiteCard(suite))
    .join("");

  const actionLink = run.workflow_run_url ? `<a href="${run.workflow_run_url}">GitHub Actions run</a>` : "";

  return `
    <div class="run-shell">
      <div class="run-toolbar">
        <span class="meta-chip mono">${formatDate(run.started_at)}</span>
        <span class="meta-chip mono">Ozone ${run.sources.ozone.short_commit}</span>
        <span class="meta-chip mono">s3-tests ${run.sources.s3_tests.short_commit}</span>
        <span class="meta-chip mono">mint ${run.sources.mint.short_commit}</span>
        ${actionLink ? `<span class="meta-chip">${actionLink}</span>` : ""}
      </div>
      <div class="suite-grid">${suiteMarkup}</div>
    </div>
  `;
}

async function fetchRun(file) {
  const response = await fetch(file);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${file}`);
  }
  return response.json();
}

async function renderLatest(index) {
  const latestContainer = document.getElementById("latest-run");
  const latest = index.runs[0];
  const fullRun = await fetchRun(latest.file);
  latestContainer.classList.remove("loading");
  latestContainer.innerHTML = renderRunDetails(fullRun);
}

function renderHistory(index) {
  const list = document.getElementById("history-list");
  list.classList.remove("loading");
  list.innerHTML = index.runs
    .map((run) => {
      const suiteStrips = Object.entries(run.suites)
        .map(
          ([suiteKey, suite]) => `
            <div class="suite-summary-chip">
              <h4>${suiteLabel(suiteKey)}</h4>
              <div class="metric-row">
                <span class="status-pill ${statusClass(suite.status)}">${suite.status.replace(/_/g, " ")}</span>
                <span class="pill">${formatPercent(suite.summary.compatibility_rate)}</span>
                <span class="pill">${suite.summary.eligible} eligible</span>
              </div>
            </div>
          `
        )
        .join("");

      return `
        <details class="history-item" data-run-file="${run.file}">
          <summary>
            <div class="history-summary">
              <div class="history-summary-head">
                <div>
                  <p class="eyebrow">Run ${run.id}</p>
                  <h3>${formatDate(run.started_at)}</h3>
                </div>
                <span class="status-pill ${statusClass(run.status)}">${run.status.replace(/_/g, " ")}</span>
              </div>
              <div class="suite-summary-strip">${suiteStrips}</div>
            </div>
          </summary>
          <div class="history-body">
            <div class="loader">Loading run details…</div>
          </div>
        </details>
      `;
    })
    .join("");

  list.querySelectorAll(".history-item").forEach((details) => {
    details.addEventListener("toggle", async () => {
      if (!details.open || details.dataset.loaded === "true") {
        return;
      }
      const body = details.querySelector(".history-body");
      try {
        const run = await fetchRun(details.dataset.runFile);
        body.innerHTML = renderRunDetails(run);
        details.dataset.loaded = "true";
      } catch (error) {
        body.innerHTML = `<div class="loader">${error.message}</div>`;
      }
    });
  });
}

async function main() {
  const response = await fetch("./data/index.json");
  if (!response.ok) {
    throw new Error("Failed to load report index");
  }

  const index = await response.json();
  if (!index.runs?.length) {
    document.getElementById("latest-run").innerHTML = `<div class="empty-state">No runs found yet.</div>`;
    document.getElementById("history-list").innerHTML = `<div class="empty-state">No archived runs are available yet.</div>`;
    return;
  }

  renderHero(index);
  setupTrendPanel(index);
  await renderLatest(index);
  renderHistory(index);
}

main().catch((error) => {
  document.getElementById("latest-run").innerHTML = `<div class="loader">${error.message}</div>`;
  document.getElementById("history-list").innerHTML = `<div class="loader">${error.message}</div>`;
});
