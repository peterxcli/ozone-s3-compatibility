import { PARQUET_FILE_REF, resolveParquetDataPath } from "./parquetReport";
import type { ParquetQueryClient } from "./parquetReport";

export interface ParquetFileCatalogRow extends Record<string, unknown> {
  run_id?: unknown;
  path?: unknown;
  kind?: unknown;
  suite_key?: unknown;
  log_source?: unknown;
  row_count?: unknown;
  byte_size?: unknown;
  content_hash?: unknown;
  schema_version?: unknown;
}

export interface ParquetCatalogRunLineageRow extends Record<string, unknown> {
  run_id?: unknown;
  started_at?: unknown;
  status?: unknown;
}

export interface ParquetCatalogSuiteLineageRow extends Record<string, unknown> {
  run_id?: unknown;
  suite_key?: unknown;
  label?: unknown;
  status?: unknown;
  compatibility_rate?: unknown;
}

export interface ParquetCatalogFeatureLineageRow extends Record<string, unknown> {
  run_id?: unknown;
  suite_key?: unknown;
  name?: unknown;
  label?: unknown;
  compatibility_rate?: unknown;
}

export interface ParquetFileRecord {
  runId: string;
  path: string;
  url: string;
  name: string;
  kind: string;
  suiteKey: string;
  logSource: string;
  rowCount: number | null;
  byteSize: number | null;
  contentHash: string;
  schemaVersion: number | null;
  synthetic: boolean;
}

export interface ParquetFileTreeNode {
  id: string;
  label: string;
  path: string;
  depth: number;
  kindLabel?: string;
  metaLabels?: string[];
  children: ParquetFileTreeNode[];
  file: ParquetFileRecord | null;
}

export interface ParquetCatalogLineageRows {
  runs: ParquetCatalogRunLineageRow[];
  suites: ParquetCatalogSuiteLineageRow[];
  features: ParquetCatalogFeatureLineageRow[];
}

export interface ParquetFileLineage {
  files: ParquetFileRecord[];
  graph: ParquetFileTreeNode[];
}

const CATALOG_FILES: Array<Pick<ParquetFileRecord, "path" | "kind">> = [
  { path: "catalog/files.parquet", kind: "catalog_manifest" },
  { path: "catalog/runs.parquet", kind: "catalog_runs" },
  { path: "catalog/suites.parquet", kind: "catalog_suites" },
  { path: "catalog/features.parquet", kind: "catalog_features" },
];

export const PARQUET_VIEWER_STANDALONE_PAGE = "./parquet-viewer.html";

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function timestampLabel(value: unknown): string {
  if (!value) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    let epoch = Number(value);
    if (!Number.isFinite(epoch)) {
      return "";
    }
    if (Math.abs(epoch) > 8.64e15) {
      epoch /= 1_000_000;
    } else if (Math.abs(epoch) > 10_000_000_000_000) {
      epoch /= 1_000;
    }
    const date = new Date(epoch);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  if (typeof value === "object" && "valueOf" in value && typeof value.valueOf === "function") {
    const primitive = value.valueOf();
    if (primitive !== value) {
      return timestampLabel(primitive);
    }
  }
  const text = asString(value);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asPercent(value: unknown): string {
  const number = asNumber(value);
  return number === null ? "" : `${(number * 100).toFixed(1)}%`;
}

function normalizeReportDataBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "./data/";
  }
  return trimmed.replace(/\/?$/, "/");
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) || path;
}

function comparePath(left: Pick<ParquetFileRecord, "path">, right: Pick<ParquetFileRecord, "path">): number {
  return left.path.localeCompare(right.path);
}

function suiteFileStem(suiteKey: string): string {
  return suiteKey.replace(/_/g, "-");
}

function fileUrl(dataBaseUrl: string, path: string): string {
  return resolveParquetDataPath(`${normalizeReportDataBaseUrl(dataBaseUrl)}index.json`, path);
}

function normalizeCatalogRow(row: ParquetFileCatalogRow, dataBaseUrl: string, synthetic = false): ParquetFileRecord {
  const path = asString(row.path).replace(/^\/+/, "");
  return {
    runId: asString(row.run_id),
    path,
    url: fileUrl(dataBaseUrl, path),
    name: fileName(path),
    kind: asString(row.kind || "parquet_file"),
    suiteKey: asString(row.suite_key),
    logSource: asString(row.log_source),
    rowCount: asNumber(row.row_count),
    byteSize: asNumber(row.byte_size),
    contentHash: asString(row.content_hash),
    schemaVersion: asNumber(row.schema_version),
    synthetic,
  };
}

export function normalizeParquetFileCatalogRows(
  rows: ParquetFileCatalogRow[],
  dataBaseUrl: string,
): ParquetFileRecord[] {
  const records = rows
    .map((row) => normalizeCatalogRow(row, dataBaseUrl))
    .filter((record) => record.path.endsWith(".parquet"));
  const paths = new Set(records.map((record) => record.path));

  CATALOG_FILES.forEach((entry) => {
    if (paths.has(entry.path)) {
      return;
    }
    records.push(
      normalizeCatalogRow(
        {
          run_id: "",
          path: entry.path,
          kind: entry.kind,
          suite_key: "",
          log_source: "",
          row_count: null,
          byte_size: null,
          content_hash: "",
          schema_version: null,
        },
        dataBaseUrl,
        true,
      ),
    );
  });

  return records.sort(comparePath);
}

export async function fetchParquetFileCatalog(
  dataBaseUrl: string,
  client: ParquetQueryClient,
): Promise<ParquetFileRecord[]> {
  const normalizedBaseUrl = normalizeReportDataBaseUrl(dataBaseUrl);
  const rows = await client.queryRows<ParquetFileCatalogRow>(
    `${normalizedBaseUrl}catalog/files.parquet`,
    `SELECT * FROM read_parquet(${PARQUET_FILE_REF}) ORDER BY path`,
  );
  return normalizeParquetFileCatalogRows(rows, normalizedBaseUrl);
}

function selectAllParquetSql(orderBy = ""): string {
  const orderClause = orderBy ? ` ORDER BY ${orderBy}` : "";
  return `SELECT * FROM read_parquet(${PARQUET_FILE_REF})${orderClause}`;
}

export async function fetchParquetFileLineage(dataBaseUrl: string, client: ParquetQueryClient): Promise<ParquetFileLineage> {
  const normalizedBaseUrl = normalizeReportDataBaseUrl(dataBaseUrl);
  const [fileRows, runRows, suiteRows, featureRows] = await Promise.all([
    client.queryRows<ParquetFileCatalogRow>(
      `${normalizedBaseUrl}catalog/files.parquet`,
      `SELECT * FROM read_parquet(${PARQUET_FILE_REF}) ORDER BY path`,
    ),
    client.queryRows<ParquetCatalogRunLineageRow>(
      `${normalizedBaseUrl}catalog/runs.parquet`,
      selectAllParquetSql("started_at DESC"),
    ),
    client.queryRows<ParquetCatalogSuiteLineageRow>(
      `${normalizedBaseUrl}catalog/suites.parquet`,
      selectAllParquetSql("run_id, suite_key"),
    ),
    client.queryRows<ParquetCatalogFeatureLineageRow>(
      `${normalizedBaseUrl}catalog/features.parquet`,
      selectAllParquetSql("run_id, suite_key, name"),
    ),
  ]);
  const files = normalizeParquetFileCatalogRows(fileRows, normalizedBaseUrl);
  return {
    files,
    graph: buildParquetCatalogLineageGraph(files, {
      runs: runRows,
      suites: suiteRows,
      features: featureRows,
    }),
  };
}

function sortTreeNodes(nodes: ParquetFileTreeNode[]): ParquetFileTreeNode[] {
  nodes.sort((left, right) => {
    if (left.file && !right.file) {
      return 1;
    }
    if (!left.file && right.file) {
      return -1;
    }
    return left.label.localeCompare(right.label);
  });
  nodes.forEach((node) => sortTreeNodes(node.children));
  return nodes;
}

export function buildParquetFileTree(files: ParquetFileRecord[]): ParquetFileTreeNode[] {
  const roots: ParquetFileTreeNode[] = [];
  const nodesByPath = new Map<string, ParquetFileTreeNode>();

  files.forEach((file) => {
    const segments = file.path.split("/").filter(Boolean);
    let parentChildren = roots;
    let currentPath = "";

    segments.forEach((segment, index) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isFile = index === segments.length - 1;
      let node = nodesByPath.get(currentPath);
      if (!node) {
        node = {
          id: currentPath,
          label: segment,
          path: currentPath,
          depth: index,
          children: [],
          file: null,
        };
        nodesByPath.set(currentPath, node);
        parentChildren.push(node);
      }
      if (isFile) {
        node.file = file;
      }
      parentChildren = node.children;
    });
  });

  return sortTreeNodes(roots);
}

function rowCountText(file: ParquetFileRecord): string {
  if (file.rowCount === null) {
    return "rows unknown";
  }
  return `${file.rowCount.toLocaleString()} row${file.rowCount === 1 ? "" : "s"}`;
}

function byteSizeText(file: ParquetFileRecord): string {
  if (file.byteSize === null) {
    return "size unknown";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = file.byteSize;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function fileMetaLabels(file: ParquetFileRecord): string[] {
  return [file.kind.replace(/_/g, " "), rowCountText(file), byteSizeText(file)].filter(Boolean);
}

function lineageNode(input: {
  id: string;
  label: string;
  path?: string;
  depth: number;
  kindLabel: string;
  metaLabels?: string[];
  file?: ParquetFileRecord | null;
  children?: ParquetFileTreeNode[];
}): ParquetFileTreeNode {
  return {
    id: input.id,
    label: input.label,
    path: input.path || input.id,
    depth: input.depth,
    kindLabel: input.kindLabel,
    metaLabels: input.metaLabels || [],
    children: input.children || [],
    file: input.file || null,
  };
}

function fileTargetNode(file: ParquetFileRecord, parentId: string, depth: number): ParquetFileTreeNode {
  return lineageNode({
    id: `${parentId} -> ${file.path}`,
    label: file.path,
    path: `${parentId} -> ${file.path}`,
    depth,
    kindLabel: "data file",
    metaLabels: fileMetaLabels(file),
    file,
  });
}

function uniqueFiles(files: ParquetFileRecord[]): ParquetFileRecord[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) {
      return false;
    }
    seen.add(file.path);
    return true;
  });
}

function filesForPaths(filesByPath: Map<string, ParquetFileRecord>, paths: string[]): ParquetFileRecord[] {
  return paths.map((path) => filesByPath.get(path)).filter((file): file is ParquetFileRecord => Boolean(file));
}

function sortedTargetNodes(files: ParquetFileRecord[], parentId: string): ParquetFileTreeNode[] {
  return uniqueFiles(files).sort(comparePath).map((file) => fileTargetNode(file, parentId, 2));
}

function catalogFileNode(file: ParquetFileRecord | undefined, path: string, children: ParquetFileTreeNode[]): ParquetFileTreeNode {
  return lineageNode({
    id: path,
    label: path,
    path,
    depth: 0,
    kindLabel: "catalog file",
    metaLabels: file ? fileMetaLabels(file) : [],
    file: file || null,
    children,
  });
}

function fallbackRunRows(files: ParquetFileRecord[]): ParquetCatalogRunLineageRow[] {
  const runIds = Array.from(new Set(files.map((file) => file.runId).filter(Boolean))).sort();
  return runIds.map((runId) => ({ run_id: runId }));
}

function fallbackSuiteRows(files: ParquetFileRecord[]): ParquetCatalogSuiteLineageRow[] {
  const suiteKeys = new Set<string>();
  files.forEach((file) => {
    if (file.runId && file.suiteKey) {
      suiteKeys.add(`${file.runId}\u0000${file.suiteKey}`);
    }
  });
  return Array.from(suiteKeys)
    .sort()
    .map((key) => {
      const [runId, suiteKey] = key.split("\u0000");
      return { run_id: runId, suite_key: suiteKey };
    });
}

export function buildParquetCatalogLineageGraph(
  files: ParquetFileRecord[],
  catalogRows: Partial<ParquetCatalogLineageRows> = {},
): ParquetFileTreeNode[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const runFiles = files.filter((file) => !file.path.startsWith("catalog/"));
  const catalogFileRows = runFiles
    .filter((file) => !file.synthetic)
    .sort(comparePath)
    .map((file) =>
      lineageNode({
        id: `catalog/files.parquet row ${file.path}`,
        label: file.path,
        depth: 1,
        kindLabel: "files row",
        metaLabels: [file.kind.replace(/_/g, " "), file.runId ? `run ${file.runId}` : "", rowCountText(file), byteSizeText(file)].filter(
          Boolean,
        ),
        children: [fileTargetNode(file, `catalog/files.parquet row ${file.path}`, 2)],
      }),
    );

  const runs = (catalogRows.runs && catalogRows.runs.length ? catalogRows.runs : fallbackRunRows(files)).slice();
  const runRows = runs.map((row) => {
    const runId = asString(row.run_id);
    const targets = runFiles.filter((file) => file.runId === runId);
    const metaLabels = [asString(row.status), timestampLabel(row.started_at)].filter(Boolean);
    return lineageNode({
      id: `catalog/runs.parquet row ${runId}`,
      label: runId || "unknown run",
      depth: 1,
      kindLabel: "run row",
      metaLabels,
      children: sortedTargetNodes(targets, `catalog/runs.parquet row ${runId}`),
    });
  });

  const suites = (catalogRows.suites && catalogRows.suites.length ? catalogRows.suites : fallbackSuiteRows(files)).slice();
  const suiteRows = suites.map((row) => {
    const runId = asString(row.run_id);
    const suiteKey = asString(row.suite_key);
    const suiteLabel = asString(row.label) || suiteKey;
    const casePath = suiteKey ? `runs/${runId}/cases-${suiteFileStem(suiteKey)}.parquet` : "";
    const targetFiles = filesForPaths(filesByPath, [`runs/${runId}/cases-${suiteFileStem(suiteKey)}.parquet`, `runs/${runId}/suites.parquet`]);
    const metaLabels = [asString(row.status), asPercent(row.compatibility_rate)].filter(Boolean);
    return lineageNode({
      id: `catalog/suites.parquet row ${runId} ${suiteKey}`,
      label: `${runId || "unknown run"} / ${suiteLabel || suiteKey || "unknown suite"}`,
      depth: 1,
      kindLabel: "suite row",
      metaLabels: casePath ? [...metaLabels, casePath.split("/").at(-1) || casePath] : metaLabels,
      children: sortedTargetNodes(targetFiles, `catalog/suites.parquet row ${runId} ${suiteKey}`),
    });
  });

  const features = (catalogRows.features || []).slice();
  const featureRows = features.map((row) => {
    const runId = asString(row.run_id);
    const suiteKey = asString(row.suite_key);
    const featureName = asString(row.label) || asString(row.name) || "unknown feature";
    const targetFiles = filesForPaths(filesByPath, [`runs/${runId}/features.parquet`]);
    return lineageNode({
      id: `catalog/features.parquet row ${runId} ${suiteKey} ${asString(row.name) || featureName}`,
      label: `${runId || "unknown run"} / ${suiteKey || "unknown suite"} / ${featureName}`,
      depth: 1,
      kindLabel: "feature row",
      metaLabels: [asPercent(row.compatibility_rate)].filter(Boolean),
      children: sortedTargetNodes(targetFiles, `catalog/features.parquet row ${runId} ${suiteKey} ${asString(row.name) || featureName}`),
    });
  });

  return CATALOG_FILES.map((entry) => {
    const file = filesByPath.get(entry.path);
    if (entry.path === "catalog/files.parquet") {
      return catalogFileNode(file, entry.path, catalogFileRows);
    }
    if (entry.path === "catalog/runs.parquet") {
      return catalogFileNode(file, entry.path, runRows);
    }
    if (entry.path === "catalog/suites.parquet") {
      return catalogFileNode(file, entry.path, suiteRows);
    }
    return catalogFileNode(file, entry.path, featureRows);
  });
}

export function absoluteParquetFileUrl(fileUrlValue: string, baseHref = globalThis.location?.href || "http://localhost/"): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(fileUrlValue)) {
    return fileUrlValue;
  }
  return new URL(fileUrlValue, baseHref).toString();
}

export function parquetViewerStandaloneUrl(fileUrlValue: string, pageUrl = PARQUET_VIEWER_STANDALONE_PAGE): string {
  const separator = pageUrl.includes("?") ? "&" : "?";
  return `${pageUrl}${separator}url=${encodeURIComponent(absoluteParquetFileUrl(fileUrlValue))}`;
}
