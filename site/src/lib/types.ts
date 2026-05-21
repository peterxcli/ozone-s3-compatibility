export interface BenchmarkRunSummary {
  id: string;
  run_id: string;
  started_at: string;
  finished_at: string;
  status: string;
  workflow_run_url: string;
  warp_commit: string;
  provider_count: number;
  profile_count: number;
  result_count: number;
  detail_base_url: string;
  warp: Record<string, unknown>;
  runner: Record<string, unknown>;
}

export interface BenchmarkIndex {
  generated_at: string;
  runs: BenchmarkRunSummary[];
}

export interface BenchmarkProvider {
  run_id?: string;
  provider: string;
  label: string;
  image?: string;
  image_tag?: string;
  image_digest?: string;
  endpoint?: string;
  adapter_status?: string;
  startup_seconds?: number;
  log_file?: string;
}

export interface BenchmarkProfile {
  run_id?: string;
  profile_id: string;
  workload: string;
  operation?: string;
  object_size?: string;
  concurrency?: number;
  prefix_mode?: string;
  duration_seconds?: number;
}

export interface BenchmarkResult {
  run_id?: string;
  provider: string;
  profile_id: string;
  workload: string;
  operation: string;
  status?: string;
  exit_code?: number;
  throughput_mib_per_sec?: number | null;
  ops_per_sec?: number | null;
  objects_per_sec?: number | null;
  errors?: number;
  duration_seconds?: number;
  benchdata?: string;
  analyze_out?: string;
  analyze_text?: string;
}

export interface BenchmarkTimeseriesPoint {
  run_id?: string;
  provider: string;
  profile_id: string;
  workload: string;
  operation: string;
  segment_index: number;
  host?: string;
  duration_seconds?: number;
  bytes?: number;
  ops_ended?: number;
  errors?: number;
  mb_per_sec?: number | null;
  ops_per_sec?: number | null;
  objects_per_sec?: number | null;
  start_time?: string;
  end_time?: string;
}

export interface BenchmarkCommand {
  run_id?: string;
  provider: string;
  profile_id: string;
  command: string[];
  exit_code: number;
}

export interface BenchmarkArtifact {
  run_id?: string;
  provider: string;
  profile_id: string;
  kind: string;
  path: string;
}

export interface BenchmarkLogFile {
  run_id?: string;
  provider: string;
  log_source: string;
  log_file: string;
  path: string;
  line_count?: number;
}

export interface BenchmarkLogLine {
  run_id?: string;
  provider?: string;
  log_source?: string;
  log_file?: string;
  line_number: number;
  level?: string;
  message?: string;
  raw_line?: string;
}

export interface BenchmarkRun {
  schema_version: number;
  run_id: string;
  started_at: string;
  finished_at: string;
  status: string;
  workflow_run_url: string;
  warp: Record<string, unknown>;
  runner: Record<string, unknown>;
  providers: BenchmarkProvider[];
  profiles: BenchmarkProfile[];
  results: BenchmarkResult[];
  timeseries: BenchmarkTimeseriesPoint[];
  commands: BenchmarkCommand[];
  log_files: BenchmarkLogFile[];
  logs: BenchmarkLogLine[];
  artifacts: BenchmarkArtifact[];
}

export type BenchmarkMetricKey = "throughput_mib_per_sec" | "ops_per_sec" | "objects_per_sec";
