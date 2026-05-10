import type {
  CaseStatusChange,
  FeatureComparison,
  FeatureComparisonSummary,
  FeatureChartPoint,
  FeatureComparisonDirection,
  FullRun,
  IndexPayload,
  NormalizedExecution,
  OrderedSuiteEntry,
  OverallChartPoint,
  RunLike,
  RunScopeInfo,
  RunSummary,
  StoredCaseEntry,
  SuiteRecord,
} from "./types";

export const COLORS = ["#0d7fab", "#ff8a3d", "#0f9d71", "#7a62ff", "#d2493a", "#0097a7", "#9c6b00", "#d81b60"];
export const DEFAULT_S3_TESTS_ARGS = "s3tests/functional";
export const DEFAULT_MINT_MODE = "core";
export const DEFAULT_OZONE_DATANODES = "1";
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

export function formatRateDelta(delta: number | null | undefined): string {
  if (delta === null || delta === undefined) return "No previous data";
  return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts vs previous`;
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

function normalizedCaseStatus(status: string | null | undefined): string {
  return statusClass(status) || "unknown";
}

function isPassingStatus(status: string | null | undefined): boolean {
  return normalizedCaseStatus(status) === "pass";
}

function caseKey(entry: Pick<StoredCaseEntry, "classname" | "name">): string {
  return `${entry.classname || ""}::${entry.name || ""}`;
}

function suiteCaseEntries(suite: SuiteRecord | null | undefined): StoredCaseEntry[] {
  if (!suite) return [];
  return suite.cases || suite.non_passing_cases || [];
}

function suiteStoresAllCases(suite: SuiteRecord | null | undefined): boolean {
  return Boolean(suite?.included_case_strategy === "all" && Array.isArray(suite.cases));
}

function missingCaseStatusForSuite(suite: SuiteRecord | null | undefined): "pass" | "not_run" | null {
  if (!suite) return null;
  if (suiteStoresAllCases(suite)) return "not_run";
  if (suite.included_case_strategy === "non_passing_only") return "pass";
  return null;
}

function caseMapForSuite(suite: SuiteRecord | null | undefined): Map<string, StoredCaseEntry> {
  return new Map(suiteCaseEntries(suite).map((entry) => [caseKey(entry), entry]));
}

function caseHasFeature(entry: StoredCaseEntry | undefined, featureName: string): boolean {
  return Boolean(entry?.features?.includes(featureName));
}

function displayCaseName(entry: StoredCaseEntry | undefined, key: string): string {
  if (entry?.name) return entry.name;
  return key.split("::").pop() || key;
}

function caseStatusFromMap(
  casesByKey: Map<string, StoredCaseEntry>,
  key: string,
  missingCaseStatus: "pass" | "not_run" | null,
): string | null {
  const entry = casesByKey.get(key);
  if (entry) {
    return normalizedCaseStatus(entry.status);
  }
  return missingCaseStatus;
}

function caseStatusChange(
  key: string,
  current: StoredCaseEntry | undefined,
  previous: StoredCaseEntry | undefined,
  fromStatus: string,
  toStatus: string,
): CaseStatusChange {
  const representative = current || previous;
  return {
    key,
    name: displayCaseName(representative, key),
    classname: representative?.classname || key.split("::")[0] || "",
    fromStatus,
    toStatus,
  };
}

function featureComparisonDirection(delta: number | null): FeatureComparisonDirection {
  if (delta === null) return "unknown";
  if (delta > 0) return "improved";
  if (delta < 0) return "regressed";
  return "flat";
}

function featureRate(suite: SuiteRecord | null | undefined, featureName: string): number | null {
  const feature = (suite?.feature_summaries || []).find((entry) => entry.name === featureName);
  return feature?.summary?.compatibility_rate ?? null;
}

export function compareFeatureWithPrevious(
  currentSuite: SuiteRecord,
  previousSuite: SuiteRecord | null | undefined,
  featureName: string,
): FeatureComparison {
  const currentRate = featureRate(currentSuite, featureName);
  const previousRate = featureRate(previousSuite, featureName);
  const delta = currentRate === null || previousRate === null ? null : currentRate - previousRate;
  const currentCases = caseMapForSuite(currentSuite);
  const previousCases = caseMapForSuite(previousSuite);
  const currentMissingCaseStatus = missingCaseStatusForSuite(currentSuite);
  const previousMissingCaseStatus = missingCaseStatusForSuite(previousSuite);
  const keys = new Set([...currentCases.keys(), ...previousCases.keys()]);
  const nowPassing: CaseStatusChange[] = [];
  const noLongerPassing: CaseStatusChange[] = [];

  Array.from(keys)
    .sort()
    .forEach((key) => {
      const current = currentCases.get(key);
      const previous = previousCases.get(key);
      if (!caseHasFeature(current, featureName) && !caseHasFeature(previous, featureName)) {
        return;
      }

      const currentStatus = caseStatusFromMap(currentCases, key, currentMissingCaseStatus);
      const previousStatus = caseStatusFromMap(previousCases, key, previousMissingCaseStatus);
      if (!currentStatus || !previousStatus || previousStatus === "not_run" || currentStatus === "not_run") {
        return;
      }

      if (isPassingStatus(currentStatus) && !isPassingStatus(previousStatus)) {
        nowPassing.push(caseStatusChange(key, current, previous, previousStatus, currentStatus));
      } else if (!isPassingStatus(currentStatus) && isPassingStatus(previousStatus)) {
        noLongerPassing.push(caseStatusChange(key, current, previous, previousStatus, currentStatus));
      }
    });

  return {
    previousRate,
    delta,
    direction: featureComparisonDirection(delta),
    nowPassing,
    noLongerPassing,
  };
}

export function summarizeFeatureComparisons(
  currentSuite: SuiteRecord | null | undefined,
  previousSuite: SuiteRecord | null | undefined,
): FeatureComparisonSummary {
  const summary: FeatureComparisonSummary = {
    improved: 0,
    regressed: 0,
    flat: 0,
    comparable: 0,
  };

  (currentSuite?.feature_summaries || []).forEach((feature) => {
    const currentRate = feature.summary?.compatibility_rate ?? null;
    const previousRate = featureRate(previousSuite, feature.name);
    const delta = currentRate === null || previousRate === null ? null : currentRate - previousRate;
    if (delta === null) {
      return;
    }

    summary.comparable += 1;
    const direction = featureComparisonDirection(delta);
    if (direction === "improved") {
      summary.improved += 1;
    } else if (direction === "regressed") {
      summary.regressed += 1;
    } else {
      summary.flat += 1;
    }
  });

  return summary;
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
  const response = await fetch(path, { cache: "no-store" });
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
