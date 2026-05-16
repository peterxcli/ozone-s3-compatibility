import type { SearchResult } from "./search";
import type { RunLike, StoredCaseEntry, SuiteRecord } from "./types";

export interface StoredCaseSearchResultOptions {
  run: RunLike;
  suiteKey: string;
  suite: Pick<SuiteRecord, "label">;
  caseEntry: StoredCaseEntry;
  runFile?: string;
  isLatestRun?: boolean;
}

interface CaseSourceInfo {
  sourceLanguage: string;
  sourcePath: string;
  sourceSymbol: string;
  sourceRef: string;
  sourceRepo: string;
  sourceSnippet: string;
}

function runIdentifier(run: RunLike): string {
  const fullRunId = "run_id" in run ? run.run_id : "";
  return String(fullRunId || run.id || "");
}

function stripTestParams(name: string): string {
  return name.trim().split("[", 1)[0];
}

function s3SourcePath(classname: string): string {
  return classname ? `${classname.replace(/\./g, "/")}.py` : "";
}

function caseSourceRef(run: RunLike, suiteKey: string): string {
  const source = run.sources?.[suiteKey];
  const commit = String(source?.commit || "");
  if (commit && commit !== "unknown") {
    return commit;
  }
  return String(source?.ref || "");
}

function sourceRepo(run: RunLike, suiteKey: string): string {
  return String(run.sources?.[suiteKey]?.repo || "");
}

function fallbackSourceSnippet(suiteKey: string, suiteLabel: string, caseEntry: StoredCaseEntry): string {
  const testName = String(caseEntry.name || "").trim();
  const classname = String(caseEntry.classname || "").trim();
  if (suiteKey === "mint") {
    return [
      "# Mint test case",
      classname ? `target=${classname}` : "",
      testName ? `function=${testName}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return `# ${suiteLabel} test case\n${testName}`.trim();
}

function caseSourceInfo(
  run: RunLike,
  suiteKey: string,
  suiteLabel: string,
  caseEntry: StoredCaseEntry,
): CaseSourceInfo {
  const testName = String(caseEntry.name || "").trim();
  const classname = String(caseEntry.classname || "").trim();
  const sourceSymbol = stripTestParams(testName);

  if (suiteKey === "s3_tests") {
    return {
      sourceLanguage: "python",
      sourcePath: s3SourcePath(classname),
      sourceSymbol,
      sourceRef: caseSourceRef(run, suiteKey),
      sourceRepo: sourceRepo(run, suiteKey),
      sourceSnippet: "",
    };
  }

  return {
    sourceLanguage: suiteKey === "mint" ? "shell" : "text",
    sourcePath: "",
    sourceSymbol,
    sourceRef: caseSourceRef(run, suiteKey),
    sourceRepo: sourceRepo(run, suiteKey),
    sourceSnippet: fallbackSourceSnippet(suiteKey, suiteLabel, caseEntry),
  };
}

function resultId(parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

export function storedCaseSearchResult({
  run,
  suiteKey,
  suite,
  caseEntry,
  runFile,
  isLatestRun = false,
}: StoredCaseSearchResultOptions): SearchResult {
  const runId = runIdentifier(run);
  const suiteLabel = suite.label || suiteKey.replace(/_/g, "-");
  const testName = String(caseEntry.name || "");
  const classname = String(caseEntry.classname || "");
  const sourceInfo = caseSourceInfo(run, suiteKey, suiteLabel, caseEntry);

  return {
    id: resultId(["run-detail", runId, suiteKey, classname, testName, String(caseEntry.status || "unknown")]),
    suiteKey,
    suiteLabel,
    testName,
    classname,
    status: String(caseEntry.status || "unknown"),
    features: (caseEntry.features || []).filter(Boolean),
    message: String(caseEntry.message || ""),
    detail: String(caseEntry.detail || ""),
    runId,
    runStartedAt: String(run.started_at || ""),
    runFinishedAt: String(run.finished_at || run.started_at || ""),
    runFile: runFile || (runId ? `data/runs/${runId}.json` : ""),
    isLatestRun,
    matchedFields: [],
    score: 0,
    ...sourceInfo,
  };
}
