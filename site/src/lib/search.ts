import type { FullRun, RunSummary } from "./types";

export interface SearchableRun {
  summary: RunSummary;
  run: FullRun;
  isLatestRun: boolean;
}

export interface SearchResult {
  id: string;
  suiteKey: string;
  suiteLabel: string;
  testName: string;
  classname?: string;
  status: string;
  features: string[];
  message: string;
  detail: string;
  runId: string;
  runStartedAt: string;
  runFinishedAt?: string;
  runFile: string;
  isLatestRun: boolean;
  matchedFields: string[];
  score: number;
}

interface SearchToken {
  text: string;
  compact: string;
}

interface SearchField {
  label: string;
  value: string;
  weight: number;
  normalized: string;
  compact: string;
}

interface RankedSearchResult extends SearchResult {
  runSortTime: number;
}

const FIELD_ORDER = ["test name", "error message", "suite", "run", "class", "feature", "status"];
const FIELD_WEIGHTS: Record<string, number> = {
  "test name": 80,
  "error message": 50,
  suite: 40,
  run: 30,
  class: 15,
  feature: 10,
  status: 6,
};

function normalizeText(value: string | null | undefined): string {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "");
}

function searchTokens(query: string): SearchToken[] {
  return normalizeText(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => ({ text, compact: compactText(text) }));
}

function makeField(label: string, value: string | null | undefined): SearchField {
  const normalized = normalizeText(value);
  return {
    label,
    value: String(value || ""),
    weight: FIELD_WEIGHTS[label] || 1,
    normalized,
    compact: compactText(normalized),
  };
}

function fieldMatchesToken(field: SearchField, token: SearchToken): boolean {
  if (/^\d{1,2}$/.test(token.text)) {
    return field.normalized.split(" ").includes(token.text);
  }
  return field.normalized.includes(token.text) || field.compact.includes(token.compact);
}

function runIdentifier(summary: RunSummary, run: FullRun): string {
  return run.run_id || run.id || summary.id || "";
}

function runMetadata(summary: RunSummary, run: FullRun): string {
  return [
    runIdentifier(summary, run),
    summary.id,
    summary.file,
    summary.started_at,
    summary.finished_at,
    run.started_at,
    run.finished_at,
    summary.workflow_run_url,
    run.workflow_run_url,
  ]
    .filter(Boolean)
    .join(" ");
}

function uniqueMatchedFields(fields: SearchField[], tokens: SearchToken[]): string[] {
  const matches = new Set<string>();
  fields.forEach((field) => {
    if (tokens.some((token) => fieldMatchesToken(field, token))) {
      matches.add(field.label);
    }
  });
  return FIELD_ORDER.filter((label) => matches.has(label));
}

function scoreMatch(fields: SearchField[], tokens: SearchToken[]): number {
  return fields.reduce((score, field) => {
    const tokenMatches = tokens.filter((token) => fieldMatchesToken(field, token)).length;
    if (!tokenMatches) return score;
    return score + field.weight + tokenMatches;
  }, 0);
}

export function searchRunCases(
  runs: SearchableRun[],
  query: string,
  suiteFilter = "all",
  limit = 120
): SearchResult[] {
  const tokens = searchTokens(query);
  if (!tokens.length) {
    return [];
  }

  const results: RankedSearchResult[] = [];

  runs.forEach(({ summary, run, isLatestRun }) => {
    const runId = runIdentifier(summary, run);
    const runStartedAt = summary.started_at || run.started_at || "";
    const runFinishedAt = summary.finished_at || run.finished_at;
    const runSortTime = Date.parse(runStartedAt) || 0;
    const runField = makeField("run", runMetadata(summary, run));

    Object.entries(run.suites || {}).forEach(([suiteKey, suite]) => {
      if (suiteFilter !== "all" && suiteFilter !== suiteKey) {
        return;
      }

      const suiteLabel = suite.label || suiteKey;
      const suiteField = makeField("suite", `${suiteKey} ${suiteLabel}`);
      const storedCases = suite.cases || suite.non_passing_cases || [];

      storedCases.forEach((entry) => {
        const fields = [
          makeField("test name", entry.name),
          makeField("error message", `${entry.message || ""} ${entry.detail || ""}`),
          suiteField,
          runField,
          makeField("class", entry.classname),
          makeField("feature", (entry.features || []).join(" ")),
          makeField("status", entry.status),
        ];

        if (!tokens.every((token) => fields.some((field) => fieldMatchesToken(field, token)))) {
          return;
        }

        results.push({
          id: [runId, suiteKey, entry.classname || "", entry.name, entry.status].join(":"),
          suiteKey,
          suiteLabel,
          testName: entry.name,
          classname: entry.classname,
          status: entry.status,
          features: entry.features || [],
          message: entry.message || "",
          detail: entry.detail || "",
          runId,
          runStartedAt,
          runFinishedAt,
          runFile: summary.file,
          isLatestRun,
          matchedFields: uniqueMatchedFields(fields, tokens),
          score: scoreMatch(fields, tokens),
          runSortTime,
        });
      });
    });
  });

  return results
    .sort((left, right) => {
      if (right.runSortTime !== left.runSortTime) {
        return right.runSortTime - left.runSortTime;
      }
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.suiteLabel !== right.suiteLabel) {
        return left.suiteLabel.localeCompare(right.suiteLabel);
      }
      return left.testName.localeCompare(right.testName);
    })
    .slice(0, limit)
    .map(({ runSortTime: _runSortTime, ...result }) => result);
}
