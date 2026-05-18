import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "ozone-s3-compatibility-parquet-files-test-"));
const require = createRequire(import.meta.url);
const tscBin = path.join(siteRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

function compileLibFiles(files) {
  execFileSync(
    tscBin,
    [
      "--target",
      "ES2022",
      "--module",
      "CommonJS",
      "--moduleResolution",
      "Node",
      "--lib",
      "ES2022,DOM",
      "--strict",
      "--skipLibCheck",
      "--rootDir",
      "src/lib",
      "--outDir",
      outDir,
      ...files,
    ],
    { cwd: siteRoot, stdio: "inherit" },
  );
  writeFileSync(path.join(outDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
  try {
    symlinkSync(path.join(siteRoot, "node_modules"), path.join(outDir, "node_modules"), "junction");
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

function compileParquetFiles() {
  compileLibFiles(["src/lib/parquetFiles.ts"]);
}

function compileGraphViewport() {
  compileLibFiles(["src/lib/graphViewport.ts"]);
}

test("loads the Parquet file catalog and adds the catalog files to the hierarchy", async () => {
  compileParquetFiles();
  const { buildParquetFileTree, fetchParquetFileCatalog } = require(path.join(outDir, "parquetFiles.js"));
  const requests = [];
  const client = {
    async queryRows(filePath, sql) {
      requests.push({ filePath, sql });
      return [
        {
          run_id: "run-a",
          path: "runs/run-a/metadata.parquet",
          kind: "metadata",
          suite_key: "",
          log_source: "",
          row_count: 1,
          byte_size: 1234,
          content_hash: "abc",
          schema_version: 1,
        },
        {
          run_id: "run-a",
          path: "runs/run-a/cases-s3-tests.parquet",
          kind: "cases",
          suite_key: "s3_tests",
          log_source: "",
          row_count: 2,
          byte_size: 2345,
          content_hash: "def",
          schema_version: 1,
        },
        {
          run_id: "",
          path: "search/index.parquet",
          kind: "search_index",
          suite_key: "",
          log_source: "",
          row_count: 3,
          byte_size: 3456,
          content_hash: "ghi",
          schema_version: 1,
        },
      ];
    },
  };

  const files = await fetchParquetFileCatalog("./data/", client);

  assert.deepEqual(requests, [
    {
      filePath: "./data/catalog/files.parquet",
      sql: "SELECT * FROM read_parquet(__PARQUET_FILE__) ORDER BY path",
    },
  ]);
  assert.equal(files.find((file) => file.path === "runs/run-a/metadata.parquet")?.url, "./data/runs/run-a/metadata.parquet");
  assert.ok(files.some((file) => file.path === "catalog/files.parquet" && file.synthetic));
  assert.ok(files.some((file) => file.path === "catalog/runs.parquet" && file.synthetic));

  const tree = buildParquetFileTree(files);
  assert.deepEqual(
    tree.map((node) => node.label),
    ["catalog", "runs", "search"],
  );
  const runsNode = tree.find((node) => node.label === "runs");
  const runNode = runsNode?.children.find((node) => node.label === "run-a");
  assert.deepEqual(
    runNode?.children.map((node) => node.label),
    ["cases-s3-tests.parquet", "metadata.parquet"],
  );
});

test("builds a catalog-first lineage graph from catalog rows to data files", () => {
  compileParquetFiles();
  const { buildParquetCatalogLineageGraph, normalizeParquetFileCatalogRows } = require(path.join(outDir, "parquetFiles.js"));
  const files = normalizeParquetFileCatalogRows(
    [
      {
        run_id: "run-a",
        path: "runs/run-a/metadata.parquet",
        kind: "metadata",
        suite_key: "",
        log_source: "",
        row_count: 1,
        byte_size: 1234,
        content_hash: "abc",
        schema_version: 1,
      },
      {
        run_id: "run-a",
        path: "runs/run-a/suites.parquet",
        kind: "suites",
        suite_key: "",
        log_source: "",
        row_count: 1,
        byte_size: 2234,
        content_hash: "suite",
        schema_version: 1,
      },
      {
        run_id: "run-a",
        path: "runs/run-a/features.parquet",
        kind: "features",
        suite_key: "",
        log_source: "",
        row_count: 1,
        byte_size: 3234,
        content_hash: "feature",
        schema_version: 1,
      },
      {
        run_id: "run-a",
        path: "runs/run-a/cases-s3-tests.parquet",
        kind: "cases",
        suite_key: "s3_tests",
        log_source: "",
        row_count: 2,
        byte_size: 2345,
        content_hash: "def",
        schema_version: 1,
      },
      {
        run_id: "",
        path: "search/index.parquet",
        kind: "search_index",
        suite_key: "",
        log_source: "",
        row_count: 3,
        byte_size: 3456,
        content_hash: "ghi",
        schema_version: 1,
      },
    ],
    "./data/",
  );

  const graph = buildParquetCatalogLineageGraph(files, {
    runs: [{ run_id: "run-a", status: "completed", started_at: 1778984100000 }],
    suites: [{ run_id: "run-a", suite_key: "s3_tests", label: "s3-tests", status: "completed" }],
    features: [{ run_id: "run-a", suite_key: "s3_tests", name: "bucket_listing", label: "Bucket listing" }],
  });

  assert.deepEqual(
    graph.map((node) => node.path),
    ["catalog/files.parquet", "catalog/runs.parquet", "catalog/suites.parquet", "catalog/features.parquet"],
  );
  const filesCatalog = graph.find((node) => node.path === "catalog/files.parquet");
  assert.equal(filesCatalog?.kindLabel, "catalog file");
  assert.ok(filesCatalog?.file);
  const manifestRow = filesCatalog?.children.find((node) => node.label === "runs/run-a/metadata.parquet");
  assert.equal(manifestRow?.kindLabel, "files row");
  assert.equal(manifestRow?.children[0]?.file?.path, "runs/run-a/metadata.parquet");

  const runRow = graph
    .find((node) => node.path === "catalog/runs.parquet")
    ?.children.find((node) => node.label === "run-a");
  assert.deepEqual(runRow?.metaLabels, ["completed", "2026-05-17T02:15:00.000Z"]);
  assert.deepEqual(
    runRow?.children.map((node) => node.file?.path),
    [
      "runs/run-a/cases-s3-tests.parquet",
      "runs/run-a/features.parquet",
      "runs/run-a/metadata.parquet",
      "runs/run-a/suites.parquet",
    ],
  );

  const suiteRow = graph
    .find((node) => node.path === "catalog/suites.parquet")
    ?.children.find((node) => node.label === "run-a / s3-tests");
  assert.deepEqual(
    suiteRow?.children.map((node) => node.file?.path),
    ["runs/run-a/cases-s3-tests.parquet", "runs/run-a/suites.parquet"],
  );

  const featureRow = graph
    .find((node) => node.path === "catalog/features.parquet")
    ?.children.find((node) => node.label === "run-a / s3_tests / Bucket listing");
  assert.deepEqual(
    featureRow?.children.map((node) => node.file?.path),
    ["runs/run-a/features.parquet"],
  );
});

test("loads catalog row lineage with the Parquet file graph", async () => {
  compileParquetFiles();
  const { fetchParquetFileLineage } = require(path.join(outDir, "parquetFiles.js"));
  const requests = [];
  const client = {
    async queryRows(filePath, sql) {
      requests.push({ filePath, sql });
      if (filePath.endsWith("catalog/files.parquet")) {
        return [
          {
            run_id: "run-a",
            path: "runs/run-a/metadata.parquet",
            kind: "metadata",
            suite_key: "",
            log_source: "",
            row_count: 1,
            byte_size: 1234,
            content_hash: "abc",
            schema_version: 1,
          },
        ];
      }
      if (filePath.endsWith("catalog/runs.parquet")) {
        return [{ run_id: "run-a", status: "completed", started_at: "2026-05-17T02:15:00Z" }];
      }
      if (filePath.endsWith("catalog/suites.parquet")) {
        return [{ run_id: "run-a", suite_key: "s3_tests", label: "s3-tests", status: "completed" }];
      }
      if (filePath.endsWith("catalog/features.parquet")) {
        return [{ run_id: "run-a", suite_key: "s3_tests", name: "bucket_listing", label: "Bucket listing" }];
      }
      return [];
    },
  };

  const lineage = await fetchParquetFileLineage("./data/", client);

  assert.deepEqual(
    requests.map((request) => request.filePath),
    [
      "./data/catalog/files.parquet",
      "./data/catalog/runs.parquet",
      "./data/catalog/suites.parquet",
      "./data/catalog/features.parquet",
    ],
  );
  assert.ok(lineage.files.some((file) => file.path === "runs/run-a/metadata.parquet"));
  assert.ok(lineage.graph.some((node) => node.path === "catalog/runs.parquet"));
});

test("groups dense same-level lineage nodes behind collapsed group cards", () => {
  compileParquetFiles();
  const { buildParquetCatalogLineageGraph, groupParquetLineageGraph, normalizeParquetFileCatalogRows } = require(
    path.join(outDir, "parquetFiles.js"),
  );
  const rows = Array.from({ length: 8 }, (_, index) => ({
    run_id: "run-a",
    path: `runs/run-a/cases-s3-tests-${index}.parquet`,
    kind: "cases",
    suite_key: "s3_tests",
    log_source: "",
    row_count: index + 1,
    byte_size: 1024 + index,
    content_hash: `case-${index}`,
    schema_version: 1,
  }));
  const files = normalizeParquetFileCatalogRows(rows, "./data/");
  const graph = buildParquetCatalogLineageGraph(files, {
    runs: [{ run_id: "run-a", status: "completed", started_at: "2026-05-17T02:15:00Z" }],
    suites: [{ run_id: "run-a", suite_key: "s3_tests", label: "s3-tests", status: "completed" }],
    features: [],
  });

  const grouped = groupParquetLineageGraph(graph, { threshold: 3 });
  const filesCatalog = grouped.find((node) => node.path === "catalog/files.parquet");
  const casesGroup = filesCatalog?.children.find((node) => node.kindLabel === "group" && node.label === "cases");

  assert.equal(casesGroup?.collapsedByDefault, true);
  assert.deepEqual(casesGroup?.metaLabels, ["8 items"]);
  assert.equal(casesGroup?.children.length, 8);
  assert.ok(casesGroup?.children.every((node) => node.kindLabel === "files row"));
});

test("fits an expanded lineage graph inside the visible canvas", () => {
  compileGraphViewport();
  const { fitContentToViewport } = require(path.join(outDir, "graphViewport.js"));

  const fitted = fitContentToViewport({
    viewportWidth: 900,
    viewportHeight: 420,
    contentWidth: 1600,
    contentHeight: 10000,
    minZoom: 0.02,
    maxZoom: 1.7,
    padding: 32,
  });

  assert.ok(fitted.zoom < 0.12);
  assert.ok(fitted.pan.x >= 32);
  assert.ok(fitted.pan.y >= 32);
  assert.ok(fitted.pan.x + 1600 * fitted.zoom <= 900 - 32 + 0.001);
  assert.ok(fitted.pan.y + 10000 * fitted.zoom <= 420 - 32 + 0.001);

  const hugeFitted = fitContentToViewport({
    viewportWidth: 900,
    viewportHeight: 420,
    contentWidth: 1600,
    contentHeight: 120000,
    minZoom: 0.001,
    maxZoom: 1.7,
    padding: 32,
  });

  assert.ok(hugeFitted.zoom < 0.005);
  assert.ok(hugeFitted.pan.x + 1600 * hugeFitted.zoom <= 900 - 32 + 0.001);
  assert.ok(hugeFitted.pan.y + 120000 * hugeFitted.zoom <= 420 - 32 + 0.001);
});

test("app source wires a Parquet Files section to an embedded non-iframe viewer", () => {
  const appSource = readFileSync(path.join(siteRoot, "src", "App.vue"), "utf8");
  const browserSource = readFileSync(path.join(siteRoot, "src", "components", "ParquetFileBrowser.vue"), "utf8");
  const viewerSource = readFileSync(path.join(siteRoot, "src", "components", "EmbeddedParquetViewer.vue"), "utf8");
  const standaloneSource = readFileSync(path.join(siteRoot, "public", "parquet-viewer.html"), "utf8");
  const standaloneLoaderSource = readFileSync(path.join(siteRoot, "public", "parquet-viewer-url-loader.js"), "utf8");

  assert.match(appSource, /ParquetFileBrowser/);
  assert.match(appSource, /fetchParquetFileLineage/);
  assert.match(appSource, /id="parquet-files-section"/);
  assert.match(browserSource, /defineEmits<\{[\s\S]*select: \[file: ParquetFileRecord\];[\s\S]*\}>/);
  assert.match(viewerSource, /PARQUET_VIEWER_SCRIPT/);
  assert.match(viewerSource, /restoreHostPageLocation/);
  assert.match(viewerSource, /downloadParquetFileForViewer/);
  assert.match(viewerSource, /submitFileToViewer/);
  assert.match(viewerSource, /DataTransfer/);
  assert.match(viewerSource, /dispatchEvent\(new Event\("change"/);
  assert.match(viewerSource, /captureHostPageState/);
  assert.match(viewerSource, /window\.scrollTo/);
  assert.match(standaloneSource, /__ozoneStandaloneParquetUrl/);
  assert.match(standaloneSource, /parquet-viewer-url-loader\.js/);
  assert.match(standaloneLoaderSource, /loadStandaloneParquetUrlAsFile/);
  assert.match(standaloneLoaderSource, /DataTransfer/);
  assert.match(standaloneLoaderSource, /dispatchEvent\(new Event\("change"/);
  assert.doesNotMatch(viewerSource, /<iframe/i);
});

test("Parquet files render as a left-to-right graph and open a persistent modal inspector", () => {
  const appSource = readFileSync(path.join(siteRoot, "src", "App.vue"), "utf8");
  const browserSource = readFileSync(path.join(siteRoot, "src", "components", "ParquetFileBrowser.vue"), "utf8");
  const canvasSource = readFileSync(path.join(siteRoot, "src", "components", "ParquetLineageCanvas.vue"), "utf8");
  const graphNodeSource = readFileSync(path.join(siteRoot, "src", "components", "ParquetGraphNode.vue"), "utf8");
  const stylesSource = readFileSync(path.join(siteRoot, "src", "styles.css"), "utf8");

  assert.match(browserSource, /ParquetLineageCanvas/);
  assert.match(browserSource, /groupParquetLineageGraph/);
  assert.match(canvasSource, /ParquetGraphNode/);
  assert.match(canvasSource, /parquet-lineage-toolbar/);
  assert.match(canvasSource, /@wheel\.prevent="handleWheel"/);
  assert.match(canvasSource, /zoomIn/);
  assert.match(canvasSource, /fitContentToViewport/);
  assert.match(canvasSource, /const fitMinZoom = 0\.001/);
  assert.match(canvasSource, /minZoom: fitMinZoom/);
  assert.match(canvasSource, /toFixed\(1\)/);
  assert.match(canvasSource, /ref="graphViewport"/);
  assert.match(canvasSource, /ref="graphContent"/);
  assert.match(canvasSource, /pointerdown/);
  assert.match(canvasSource, /dragActivationDistance/);
  assert.match(canvasSource, /@click\.capture="handleGraphClick"/);
  assert.match(canvasSource, /clearGraphTextSelection/);
  assert.match(stylesSource, /\.parquet-graph[\s\S]*user-select:\s*none/);
  assert.match(stylesSource, /\.parquet-graph-node[\s\S]*display:\s*flex/);
  assert.match(stylesSource, /\.parquet-graph-children[\s\S]*flex-direction:\s*column/);
  assert.match(stylesSource, /\.parquet-graph-node::before[\s\S]*border-top/);
  assert.match(browserSource, /graph: ParquetFileTreeNode\[\]/);
  assert.doesNotMatch(browserSource, /parquet-graph-card root/);
  assert.match(graphNodeSource, /class="parquet-graph-card"/);
  assert.match(graphNodeSource, /node\.kindLabel/);
  assert.match(graphNodeSource, /collapsedByDefault/);
  assert.match(appSource, /parquetInspectorOpen/);
  assert.match(appSource, /class="case-modal parquet-inspector-modal"/);
  assert.match(appSource, /v-show="selectedParquetFile && parquetInspectorOpen"/);
  const sectionStart = appSource.indexOf('<section id="parquet-files-section"');
  const trendStart = appSource.indexOf("<TrendPanel");
  const historyStart = appSource.indexOf('<section id="history-section"', sectionStart);
  assert.ok(trendStart > -1);
  assert.ok(sectionStart > trendStart);
  assert.ok(historyStart > sectionStart);
  const navTrendStart = appSource.indexOf("handleStickyNavigation('trend-panel-section')");
  const navParquetStart = appSource.indexOf("handleStickyNavigation('parquet-files-section')");
  const navArchivedStart = appSource.indexOf("Archived Runs", navParquetStart);
  assert.ok(navParquetStart > navTrendStart);
  assert.ok(navArchivedStart > navParquetStart);
  const sectionEnd = historyStart;
  const parquetSection = appSource.slice(sectionStart, sectionEnd);
  assert.doesNotMatch(parquetSection, /<EmbeddedParquetViewer/);
});
