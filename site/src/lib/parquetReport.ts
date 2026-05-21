import type {
  BenchmarkArtifact,
  BenchmarkCommand,
  BenchmarkIndex,
  BenchmarkLogFile,
  BenchmarkLogLine,
  BenchmarkProvider,
  BenchmarkRun,
  BenchmarkRunSummary,
  BenchmarkProfile,
  BenchmarkResult,
  BenchmarkTimeseriesPoint,
} from "./types";

export const PARQUET_FILE_REF = "__PARQUET_FILE__";

export interface ParquetQueryClient {
  queryRows<T extends object>(filePath: string, sql: string): Promise<T[]>;
}

export interface ParquetCatalogRunRow {
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
  warp_json: string;
  runner_json: string;
  schema_version: number;
}

interface ParquetMetadataRow {
  run_id: string;
  started_at: string;
  finished_at: string;
  status: string;
  workflow_run_url: string;
  warp_json: string;
  runner_json: string;
  schema_version: number;
}

interface ParquetCommandRow extends Omit<BenchmarkCommand, "command"> {
  command_json: string;
}

export interface ParquetRunRows {
  metadata: ParquetMetadataRow[];
  providers: BenchmarkProvider[];
  profiles: BenchmarkProfile[];
  results: BenchmarkResult[];
  timeseries: BenchmarkTimeseriesPoint[];
  commands: ParquetCommandRow[];
  logFiles: BenchmarkLogFile[];
  logs: BenchmarkLogLine[];
  artifacts: BenchmarkArtifact[];
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function normalizeParquetIndex(rows: ParquetCatalogRunRow[]): BenchmarkIndex {
  const runs = rows
    .map<BenchmarkRunSummary>((row) => ({
      id: row.run_id,
      run_id: row.run_id,
      started_at: row.started_at,
      finished_at: row.finished_at,
      status: row.status,
      workflow_run_url: row.workflow_run_url,
      warp_commit: row.warp_commit,
      provider_count: Number(row.provider_count || 0),
      profile_count: Number(row.profile_count || 0),
      result_count: Number(row.result_count || 0),
      detail_base_url: row.detail_base_url,
      warp: parseJsonObject(row.warp_json),
      runner: parseJsonObject(row.runner_json),
    }))
    .sort((left, right) => right.started_at.localeCompare(left.started_at));

  return {
    generated_at: runs[0]?.finished_at || "",
    runs,
  };
}

export function normalizeParquetRun(rows: ParquetRunRows): BenchmarkRun {
  const metadata = rows.metadata[0];
  if (!metadata) {
    throw new Error("Benchmark run metadata is missing.");
  }

  return {
    schema_version: Number(metadata.schema_version || 1),
    run_id: metadata.run_id,
    started_at: metadata.started_at,
    finished_at: metadata.finished_at,
    status: metadata.status,
    workflow_run_url: metadata.workflow_run_url,
    warp: parseJsonObject(metadata.warp_json),
    runner: parseJsonObject(metadata.runner_json),
    providers: rows.providers,
    profiles: rows.profiles,
    results: rows.results,
    timeseries: rows.timeseries,
    commands: rows.commands.map((row) => ({
      run_id: row.run_id,
      provider: row.provider,
      profile_id: row.profile_id,
      command: parseJsonArray(row.command_json),
      exit_code: Number(row.exit_code || 0),
    })),
    log_files: rows.logFiles,
    logs: rows.logs,
    artifacts: rows.artifacts,
  };
}

export function resolveBenchmarkDataPath(baseUrl: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return path;
  }
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${normalizedBase}${path.replace(/^\.?\//, "")}`;
}

function selectAllSql(orderBy = ""): string {
  const order = orderBy ? ` ORDER BY ${orderBy}` : "";
  return `SELECT * FROM read_parquet(${PARQUET_FILE_REF})${order}`;
}

export async function fetchBenchmarkIndex(client: ParquetQueryClient, dataBaseUrl: string): Promise<BenchmarkIndex> {
  const rows = await client.queryRows<ParquetCatalogRunRow>(
    resolveBenchmarkDataPath(dataBaseUrl, "catalog/runs.parquet"),
    selectAllSql("started_at DESC"),
  );
  return normalizeParquetIndex(rows);
}

export async function fetchBenchmarkRun(
  client: ParquetQueryClient,
  dataBaseUrl: string,
  summary: Pick<BenchmarkRunSummary, "detail_base_url">,
): Promise<BenchmarkRun> {
  const base = summary.detail_base_url;
  const detailPath = (file: string) => resolveBenchmarkDataPath(dataBaseUrl, `${base}${file}`);
  const [metadata, providers, profiles, results, timeseries, commands, logFiles, logs, artifacts] = await Promise.all([
    client.queryRows<ParquetMetadataRow>(detailPath("metadata.parquet"), selectAllSql()),
    client.queryRows<BenchmarkProvider>(detailPath("providers.parquet"), selectAllSql("provider")),
    client.queryRows<BenchmarkProfile>(detailPath("profiles.parquet"), selectAllSql("workload, profile_id")),
    client.queryRows<BenchmarkResult>(detailPath("results.parquet"), selectAllSql("workload, profile_id, provider")),
    client.queryRows<BenchmarkTimeseriesPoint>(detailPath("timeseries.parquet"), selectAllSql("profile_id, provider, segment_index")),
    client.queryRows<ParquetCommandRow>(detailPath("commands.parquet"), selectAllSql("profile_id, provider")),
    client.queryRows<BenchmarkLogFile>(detailPath("log_files.parquet"), selectAllSql("provider, log_file")),
    client.queryRows<BenchmarkLogLine>(detailPath("logs.parquet"), selectAllSql("provider, log_file, line_number")),
    client.queryRows<BenchmarkArtifact>(detailPath("artifacts.parquet"), selectAllSql("profile_id, provider, kind")),
  ]);
  return normalizeParquetRun({ metadata, providers, profiles, results, timeseries, commands, logFiles, logs, artifacts });
}
