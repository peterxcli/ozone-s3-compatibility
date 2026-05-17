import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "ozone-s3-compatibility-parquet-report-test-"));
const require = createRequire(import.meta.url);
const tscBin = path.join(siteRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));
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
    "src/lib/parquetReport.ts",
  ],
  { cwd: siteRoot, stdio: "inherit" },
);
writeFileSync(path.join(outDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
symlinkSync(path.join(siteRoot, "node_modules"), path.join(outDir, "node_modules"), "junction");

const {
  fetchParquetLogLines,
  isParquetReportEnabled,
  normalizeParquetIndex,
  normalizeParquetRun,
  resolveParquetDataPath,
} = require(path.join(outDir, "parquetReport.js"));

const sources = {
  ozone: {
    repo: "https://github.com/apache/ozone.git",
    ref: "master",
    commit: "ozoneabcdef123456",
    short_commit: "ozoneabcdef1",
  },
  s3_tests: {
    repo: "https://github.com/ceph/s3-tests.git",
    ref: "main",
    commit: "s3abcdef123456",
    short_commit: "s3abcdef123",
  },
  mint: {
    repo: "https://github.com/minio/mint.git",
    ref: "master",
    commit: "mintabcdef123456",
    short_commit: "mintabcdef1",
  },
};

const execution = {
  s3_tests_args: "s3tests/functional",
  mint_mode: "core",
  mint_targets: ["awscli"],
  ozone_datanodes: "1",
};

function catalogRow(runId, startedAt, rates = {}) {
  return {
    run_id: runId,
    started_at: startedAt,
    finished_at: startedAt,
    status: "completed",
    workflow_run_url: `https://github.example/runs/${runId}`,
    ozone_repo: sources.ozone.repo,
    ozone_ref: sources.ozone.ref,
    ozone_commit: sources.ozone.commit,
    s3_tests_commit: sources.s3_tests.commit,
    mint_commit: sources.mint.commit,
    s3_tests_rate: rates.s3Tests ?? 0.5,
    mint_rate: rates.mint ?? 1,
    detail_base_url: `runs/${runId}/`,
    execution_json: JSON.stringify(execution),
    sources_json: JSON.stringify(sources),
    schema_version: 1,
  };
}

function suiteRow(runId, suiteKey, label, rate, passed, failed = 0, errored = 0, skipped = 0) {
  const eligible = passed + failed + errored;
  return {
    run_id: runId,
    suite_key: suiteKey,
    label,
    status: "completed",
    exit_code: failed || errored ? 1 : 0,
    total: eligible + skipped,
    passed,
    failed,
    errored,
    skipped,
    eligible,
    compatibility_rate: rate,
    included_case_strategy: "all",
  };
}

function featureRow(runId, suiteKey, name, rate, passed, failed = 0) {
  return {
    run_id: runId,
    suite_key: suiteKey,
    name,
    label: name,
    total: passed + failed,
    passed,
    failed,
    errored: 0,
    skipped: 0,
    eligible: passed + failed,
    compatibility_rate: rate,
  };
}

test("enables the Parquet data path only through an explicit flag", () => {
  assert.equal(isParquetReportEnabled("?data=parquet", ""), true);
  assert.equal(isParquetReportEnabled("?reportData=parquet", ""), true);
  assert.equal(isParquetReportEnabled("", "parquet"), true);
  assert.equal(isParquetReportEnabled("?data=json", "parquet"), false);
  assert.equal(isParquetReportEnabled("?data=parquet", "json"), true);
  assert.equal(isParquetReportEnabled("", ""), false);
});

test("resolves Parquet data files relative to the report data directory", () => {
  assert.equal(resolveParquetDataPath("./data/index.json", "catalog/runs.parquet"), "./data/catalog/runs.parquet");
  assert.equal(resolveParquetDataPath("data/index.json", "runs/run-a/suites.parquet"), "data/runs/run-a/suites.parquet");
  assert.equal(
    resolveParquetDataPath("https://example.test/report/data/index.json?cache=1", "catalog/runs.parquet"),
    "https://example.test/report/data/catalog/runs.parquet",
  );
});

test("fetches remote Parquet catalog details relative to the configured data base", async () => {
  const requests = [];
  const client = {
    async queryRows(filePath) {
      requests.push(filePath);
      if (filePath.endsWith("/catalog/runs.parquet")) {
        return [catalogRow("run-new", "2026-05-17T02:15:00.000Z")];
      }
      if (filePath.endsWith("/suites.parquet")) {
        return [suiteRow("run-new", "s3_tests", "s3-tests", 0.5, 1, 1)];
      }
      if (filePath.endsWith("/features.parquet")) {
        return [featureRow("run-new", "s3_tests", "policy", 0.5, 1, 1)];
      }
      return [];
    },
  };

  const { fetchParquetIndexPayload } = require(path.join(outDir, "parquetReport.js"));
  const payload = await fetchParquetIndexPayload("https://storage.example/reports/data/index.json", client);

  assert.deepEqual(requests, [
    "https://storage.example/reports/data/catalog/runs.parquet",
    "https://storage.example/reports/data/runs/run-new/suites.parquet",
    "https://storage.example/reports/data/runs/run-new/features.parquet",
  ]);
  assert.equal(payload.runs[0].parquet_detail_base_url, "https://storage.example/reports/data/runs/run-new/");
});

test("limits concurrent Parquet detail queries while loading archived runs", async () => {
  let activeQueries = 0;
  let maxActiveQueries = 0;
  const runIds = Array.from({ length: 12 }, (_, index) => `run-${String(index).padStart(2, "0")}`);
  const client = {
    async queryRows(filePath) {
      if (filePath.endsWith("/catalog/runs.parquet")) {
        return runIds.map((runId, index) => catalogRow(runId, `2026-05-${String(17 - index).padStart(2, "0")}T02:15:00.000Z`));
      }

      activeQueries += 1;
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeQueries -= 1;

      const runId = filePath.split("/runs/")[1]?.split("/")[0] || "unknown";
      if (filePath.endsWith("/suites.parquet")) {
        return [suiteRow(runId, "s3_tests", "s3-tests", 0.5, 1, 1)];
      }
      if (filePath.endsWith("/features.parquet")) {
        return [featureRow(runId, "s3_tests", "policy", 0.5, 1, 1)];
      }
      return [];
    },
  };

  const { fetchParquetIndexPayload } = require(path.join(outDir, "parquetReport.js"));
  const payload = await fetchParquetIndexPayload("./data/index.json", client);

  assert.equal(payload.runs.length, 12);
  assert.ok(maxActiveQueries <= 6, `expected at most 6 active detail queries, saw ${maxActiveQueries}`);
});

test("normalizes Parquet catalog, suite, and feature rows to the existing index shape", () => {
  const index = normalizeParquetIndex({
    catalogRows: [
      catalogRow("run-old", "2026-05-16T02:15:00.000Z", { s3Tests: 0.25, mint: 1 }),
      catalogRow("run-new", "2026-05-17T02:15:00.000Z", { s3Tests: 0.5, mint: 1 }),
    ],
    suiteRows: [
      suiteRow("run-old", "s3_tests", "s3-tests", 0.25, 1, 3),
      suiteRow("run-new", "s3_tests", "s3-tests", 0.5, 2, 2),
      suiteRow("run-new", "mint", "mint", 1, 1),
    ],
    featureRows: [
      featureRow("run-old", "s3_tests", "policy", 0, 0, 1),
      featureRow("run-new", "s3_tests", "policy", 0.5, 1, 1),
    ],
  });

  assert.deepEqual(index.suite_order, ["s3_tests", "mint"]);
  assert.equal(index.generated_at, "2026-05-17T02:15:00.000Z");
  assert.deepEqual(index.runs.map((run) => run.id), ["run-new", "run-old"]);
  assert.equal(index.runs[0].file, "data/runs/run-new.json");
  assert.equal(index.runs[0].parquet_detail_base_url, "data/runs/run-new/");
  assert.deepEqual(index.runs[0].execution, execution);
  assert.equal(index.runs[0].sources.ozone.short_commit, "ozoneabcdef1");
  assert.deepEqual(index.charts.overall.s3_tests.map((point) => point.run_id), ["run-old", "run-new"]);
  assert.equal(index.charts.features.s3_tests.policy[1].rate, 0.5);
});

test("normalizes Parquet run detail rows to the existing full-run shape", () => {
  const summary = normalizeParquetIndex({
    catalogRows: [catalogRow("run-new", "2026-05-17T02:15:00.000Z")],
    suiteRows: [suiteRow("run-new", "s3_tests", "s3-tests", 0.5, 1, 1)],
    featureRows: [featureRow("run-new", "s3_tests", "policy", 0.5, 1, 1)],
  }).runs[0];

  const run = normalizeParquetRun({
    summary,
    metadataRows: [
      {
        run_id: "run-new",
        started_at: "2026-05-17T02:15:00.000Z",
        finished_at: "2026-05-17T02:35:00.000Z",
        status: "completed",
        rate_formula: "compatibility_rate = passed / eligible",
        workflow_run_url: "https://github.example/runs/1",
        orchestration_json: JSON.stringify({ build_exit_code: 0 }),
        execution_json: JSON.stringify(execution),
        sources_json: JSON.stringify(sources),
        schema_version: 1,
      },
    ],
    suiteRows: [suiteRow("run-new", "s3_tests", "s3-tests", 0.5, 1, 1)],
    featureRows: [featureRow("run-new", "s3_tests", "policy", 0.5, 1, 1)],
    logFileRows: [
      {
        run_id: "run-new",
        log_source: "pytest",
        log_file: "s3-tests/pytest.log",
        path: "runs/run-new/logs-pytest.parquet",
        line_count: 2,
      },
    ],
    caseRowsBySuite: {
      s3_tests: [
        {
          run_id: "run-new",
          suite_key: "s3_tests",
          case_id: "s3_tests:test_bucket_policy_access_denied",
          name: "test_bucket_policy_access_denied",
          name_base: "test_bucket_policy_access_denied",
          classname: "s3tests.functional.test_s3",
          status: "fail",
          duration_ms: 25,
          features: ["policy"],
          message: "AccessDenied",
          detail: "full traceback",
          source_repo: sources.s3_tests.repo,
          source_ref: sources.s3_tests.commit,
          source_path: "s3tests/functional/test_s3.py",
          source_symbol: "test_bucket_policy_access_denied",
          log_refs: [],
        },
      ],
    },
  });

  assert.equal(run.run_id, "run-new");
  assert.equal(run.finished_at, "2026-05-17T02:35:00.000Z");
  assert.deepEqual(run.execution, execution);
  assert.deepEqual(run.orchestration, { build_exit_code: 0 });
  assert.equal(run.sources.s3_tests.repo, sources.s3_tests.repo);
  assert.equal(run.suites.s3_tests.included_case_strategy, "all");
  assert.deepEqual(run.suites.s3_tests.feature_summaries[0].summary, {
    compatibility_rate: 0.5,
    eligible: 2,
    passed: 1,
    failed: 1,
    errored: 0,
    skipped: 0,
  });
  assert.equal(run.suites.s3_tests.cases[0].message, "AccessDenied");
  assert.equal(run.suites.s3_tests.cases[0].detail, "full traceback");
  assert.deepEqual(run.log_files, [
    {
      run_id: "run-new",
      log_source: "pytest",
      log_file: "s3-tests/pytest.log",
      path: "runs/run-new/logs-pytest.parquet",
      line_count: 2,
    },
  ]);
});

test("normalizes Arrow vector list values from Parquet case feature columns", () => {
  const summary = normalizeParquetIndex({
    catalogRows: [catalogRow("run-new", "2026-05-17T02:15:00.000Z")],
    suiteRows: [suiteRow("run-new", "s3_tests", "s3-tests", 0, 0, 1)],
    featureRows: [featureRow("run-new", "s3_tests", "abac_test", 0, 0, 1)],
  }).runs[0];

  const run = normalizeParquetRun({
    summary,
    metadataRows: [
      {
        run_id: "run-new",
        started_at: "2026-05-17T02:15:00.000Z",
        finished_at: "2026-05-17T02:35:00.000Z",
        status: "completed",
        execution_json: JSON.stringify(execution),
        sources_json: JSON.stringify(sources),
      },
    ],
    suiteRows: [suiteRow("run-new", "s3_tests", "s3-tests", 0, 0, 1)],
    featureRows: [featureRow("run-new", "s3_tests", "abac_test", 0, 0, 1)],
    caseRowsBySuite: {
      s3_tests: [
        {
          run_id: "run-new",
          suite_key: "s3_tests",
          case_id: "s3_tests:test_abac",
          name: "test_abac",
          classname: "s3tests.functional.test_abac",
          status: "fail",
          features: { toArray: () => ["abac_test"] },
          message: "AccessDenied",
          detail: "full traceback",
        },
      ],
    },
  });

  assert.deepEqual(run.suites.s3_tests.cases[0].features, ["abac_test"]);
});

test("fetches Parquet log lines from a selected log file", async () => {
  const queries = [];
  const client = {
    async queryRows(filePath, sql) {
      queries.push({ filePath, sql });
      return [
        { line_number: 1, raw_line: "first line", level: null, message: "first line" },
        { line_number: 2, raw_line: "ERROR failed request", level: "ERROR", message: "ERROR failed request" },
      ];
    },
  };

  const lines = await fetchParquetLogLines(
    {
      id: "run-new",
      run_id: "run-new",
      file: "data/runs/run-new.json",
      parquet_detail_base_url: "data/runs/run-new/",
    },
    {
      run_id: "run-new",
      log_source: "pytest",
      log_file: "s3-tests/pytest.log",
      path: "runs/run-new/logs-pytest.parquet",
      line_count: 2,
    },
    client,
  );

  assert.deepEqual(queries, [
    {
      filePath: "data/runs/run-new/logs-pytest.parquet",
      sql: "SELECT * FROM read_parquet(__PARQUET_FILE__) ORDER BY line_number LIMIT 2000",
    },
  ]);
  assert.deepEqual(
    lines.map((line) => ({ line_number: line.line_number, raw_line: line.raw_line, level: line.level })),
    [
      { line_number: 1, raw_line: "first line", level: "" },
      { line_number: 2, raw_line: "ERROR failed request", level: "ERROR" },
    ],
  );
});
