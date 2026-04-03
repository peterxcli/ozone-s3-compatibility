import type {
  FeatureChartPoint,
  FullRun,
  IndexPayload,
  NormalizedExecution,
  OrderedSuiteEntry,
  OverallChartPoint,
  RunLike,
  RunScopeInfo,
  RunSummary,
} from "./types";

export const COLORS = ["#0d7fab", "#ff8a3d", "#0f9d71", "#7a62ff", "#d2493a", "#0097a7", "#9c6b00", "#d81b60"];
export const DEFAULT_S3_TESTS_ARGS = "s3tests/functional";
export const DEFAULT_MINT_MODE = "core";
export const DEFAULT_OZONE_DATANODES = "1";
export const HISTORY_BATCH_SIZE = 8;
export const CASE_BATCH_SIZE = 60;

export function chartLabels(points: Array<Pick<OverallChartPoint, "started_at">>): string[] {
  return points.map((point) => point.started_at);
}

export function chartLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatDate(value: string): string {
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

export function suiteLabel(key: string): string {
  return key === "s3_tests" ? "s3-tests" : "mint";
}

export function statusClass(status: string | null | undefined): string {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
}

export function runId(run: RunLike): string {
  return run.run_id || ("id" in run ? run.id : "") || "";
}

export function slugify(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function archivedRunAnchorId(run: RunLike, index = 0): string {
  const parts = [runId(run), run.started_at].map(slugify).filter(Boolean);
  return `archived-run-${parts.join("-") || index + 1}`;
}

export function executionForRun(run: Pick<RunLike, "execution">): NormalizedExecution | null {
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
    s3_tests_args: String(run.execution.s3_tests_args || DEFAULT_S3_TESTS_ARGS),
    mint_mode: String(run.execution.mint_mode || DEFAULT_MINT_MODE),
    mint_targets: mintTargets,
    ozone_datanodes: String(run.execution.ozone_datanodes || DEFAULT_OZONE_DATANODES),
  };
}

export function runScope(run: RunLike): RunScopeInfo {
  const execution = executionForRun(run);
  if (!execution) {
    return { kind: "unknown", label: "Run inputs unavailable" };
  }

  if (execution.s3_tests_args !== DEFAULT_S3_TESTS_ARGS || execution.mint_targets.length > 0) {
    return { kind: "subset", label: "Subset run" };
  }

  return { kind: "full", label: "Full nightly" };
}

export function deltaForSuite(runs: RunSummary[], suiteKey: string): number | null {
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

export function topFeatureNames(index: IndexPayload, suiteKey: string): string[] {
  const latest = index?.runs?.[0]?.suites?.[suiteKey]?.feature_summaries || [];
  return latest
    .filter((item) => item.summary.eligible > 0)
    .slice(0, 8)
    .map((item) => item.name);
}

export function featureLabels(index: IndexPayload, suiteKey: string, featureNames: string[]): string[] {
  const seen = new Set<string>();
  featureNames.forEach((featureName) => {
    (index?.charts?.features?.[suiteKey]?.[featureName] || []).forEach((point) => {
      seen.add(point.started_at);
    });
  });
  return Array.from(seen).sort();
}

export function featureValues(labels: string[], points: FeatureChartPoint[]): Array<number | null> {
  const byDate = new Map(points.map((point) => [point.started_at, point]));
  return labels.map((label) => {
    const point = byDate.get(label);
    if (!point || point.rate === null || point.rate === undefined) {
      return null;
    }
    return Number((point.rate * 100).toFixed(2));
  });
}

export async function fetchJson<T>(path: string, errorMessage: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(errorMessage);
  }
  return (await response.json()) as T;
}

export async function fetchRun(file: string): Promise<FullRun> {
  return fetchJson<FullRun>(file, `Failed to fetch ${file}`);
}

export function scrollElementIntoView(element: Element): void {
  const stickyNav = document.querySelector(".sticky-nav");
  const offset = (stickyNav instanceof HTMLElement ? stickyNav.offsetHeight : 0) + 24;
  const top = window.scrollY + element.getBoundingClientRect().top - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

export function orderedSuitesFromRun(run: RunLike, suiteOrder: string[]): OrderedSuiteEntry[] {
  return (suiteOrder || [])
    .filter((suiteKey) => run?.suites?.[suiteKey])
    .map((suiteKey) => ({ key: suiteKey, suite: run.suites[suiteKey] }));
}
