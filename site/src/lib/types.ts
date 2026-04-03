export interface SummaryMetrics {
  compatibility_rate: number | null;
  eligible: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
}

export interface FeatureSummaryRecord {
  name: string;
  label: string;
  summary: SummaryMetrics;
}

export interface StoredCaseEntry {
  name: string;
  status: string;
  features?: string[];
  classname?: string;
  duration_ms?: number | null;
  message?: string;
}

export interface SuiteRecord {
  label: string;
  status: string;
  summary: SummaryMetrics;
  feature_summaries: FeatureSummaryRecord[];
  included_case_strategy?: string;
  cases?: StoredCaseEntry[];
  non_passing_cases?: StoredCaseEntry[];
  exit_code?: number;
}

export interface SourceRecord {
  repo: string;
  ref?: string;
  commit?: string;
  short_commit?: string;
}

export interface SourcesMap {
  ozone: SourceRecord;
  s3_tests: SourceRecord;
  mint: SourceRecord;
  [key: string]: SourceRecord;
}

export interface ExecutionInput {
  s3_tests_args?: string;
  mint_mode?: string;
  mint_targets?: string[] | string;
  ozone_datanodes?: string | number;
  [key: string]: unknown;
}

export interface NormalizedExecution {
  s3_tests_args: string;
  mint_mode: string;
  mint_targets: string[];
  ozone_datanodes: string;
}

export interface RunSummary {
  id: string;
  run_id?: string;
  status: string;
  started_at: string;
  finished_at?: string;
  workflow_run_url?: string;
  execution?: ExecutionInput | null;
  file: string;
  sources: SourcesMap;
  suites: Record<string, SuiteRecord>;
}

export interface FullRun {
  schema_version?: number;
  run_id: string;
  id?: string;
  started_at: string;
  finished_at?: string;
  status: string;
  rate_formula?: string;
  workflow_run_url?: string;
  orchestration?: Record<string, unknown>;
  execution?: ExecutionInput | null;
  sources: SourcesMap;
  suites: Record<string, SuiteRecord>;
}

export type RunLike = RunSummary | FullRun;

export interface OverallChartPoint {
  run_id: string;
  started_at: string;
  rate: number | null;
  eligible: number;
}

export interface FeatureChartPoint extends OverallChartPoint {
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
}

export interface IndexPayload {
  generated_at: string;
  rate_formula: string;
  suite_order: string[];
  runs: RunSummary[];
  charts: {
    overall: Record<string, OverallChartPoint[]>;
    features: Record<string, Record<string, FeatureChartPoint[]>>;
  };
}

export interface OrderedSuiteEntry {
  key: string;
  suite: SuiteRecord;
}

export type RunScopeKind = "unknown" | "subset" | "full";

export interface RunScopeInfo {
  kind: RunScopeKind;
  label: string;
}

export interface HistoryTogglePayload {
  summary: RunSummary;
  open: boolean;
}
