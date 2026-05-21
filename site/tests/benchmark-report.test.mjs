import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "warp-benchmark-report-test-"));
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
    "src/lib/report.ts",
  ],
  { cwd: siteRoot, stdio: "inherit" },
);
writeFileSync(path.join(outDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
symlinkSync(path.join(siteRoot, "node_modules"), path.join(outDir, "node_modules"), "junction");

const {
  formatOps,
  formatThroughput,
  profilesForWorkload,
  providerResultsForProfile,
  workloadsFromResults,
} = require(path.join(outDir, "report.js"));
const { normalizeParquetIndex, normalizeParquetRun } = require(path.join(outDir, "parquetReport.js"));

const results = [
  {
    provider: "ozone",
    profile_id: "put-small-c01-prefix",
    workload: "put",
    operation: "PUT",
    throughput_mib_per_sec: 1.5,
    ops_per_sec: 6,
    errors: 0,
  },
  {
    provider: "rustfs",
    profile_id: "put-small-c01-prefix",
    workload: "put",
    operation: "PUT",
    throughput_mib_per_sec: 3,
    ops_per_sec: 10,
    errors: 0,
  },
  {
    provider: "rustfs",
    profile_id: "get-range-medium-c16-prefix",
    workload: "get-range",
    operation: "GET",
    throughput_mib_per_sec: 4,
    ops_per_sec: 8,
    errors: 0,
  },
];

test("formats benchmark metrics", () => {
  assert.equal(formatThroughput(1.5), "1.50 MiB/s");
  assert.equal(formatThroughput(null), "-");
  assert.equal(formatOps(6), "6.00 ops/s");
});

test("derives workload and profile selectors from results", () => {
  assert.deepEqual(workloadsFromResults(results), ["get-range", "put"]);
  assert.deepEqual(
    profilesForWorkload(
      [
        { profile_id: "put-small-c01-prefix", workload: "put", object_size: "128KiB", concurrency: 1, prefix_mode: "prefix" },
        { profile_id: "get-range-medium-c16-prefix", workload: "get-range", object_size: "1MiB", concurrency: 16, prefix_mode: "prefix" },
      ],
      "put",
    ).map((profile) => profile.profile_id),
    ["put-small-c01-prefix"],
  );
});

test("sorts provider results by selected metric descending", () => {
  assert.deepEqual(
    providerResultsForProfile(results, "put-small-c01-prefix", "throughput_mib_per_sec").map((row) => row.provider),
    ["rustfs", "ozone"],
  );
});

test("normalizes Parquet catalog and run rows", () => {
  const index = normalizeParquetIndex([
    {
      run_id: "run-1",
      started_at: "2026-05-21T00:00:00Z",
      finished_at: "2026-05-21T00:01:00Z",
      status: "completed",
      workflow_run_url: "https://example.test/run",
      warp_commit: "abc123",
      provider_count: 4,
      profile_count: 12,
      result_count: 48,
      detail_base_url: "runs/run-1/",
      warp_json: '{"commit":"abc123"}',
      runner_json: '{"os":"Linux"}',
      schema_version: 1,
    },
  ]);

  assert.equal(index.runs[0].id, "run-1");
  assert.equal(index.runs[0].provider_count, 4);

  const run = normalizeParquetRun({
    metadata: [
      {
        run_id: "run-1",
        started_at: "2026-05-21T00:00:00Z",
        finished_at: "2026-05-21T00:01:00Z",
        status: "completed",
        workflow_run_url: "https://example.test/run",
        warp_json: '{"commit":"abc123"}',
        runner_json: '{"os":"Linux"}',
        schema_version: 1,
      },
    ],
    providers: [{ run_id: "run-1", provider: "rustfs", label: "RustFS" }],
    profiles: [{ run_id: "run-1", profile_id: "put-small-c01-prefix", workload: "put" }],
    results,
    timeseries: [],
    commands: [{ run_id: "run-1", provider: "rustfs", profile_id: "put-small-c01-prefix", command_json: '["warp","put"]', exit_code: 0 }],
    logFiles: [],
    logs: [],
    artifacts: [],
  });

  assert.equal(run.warp.commit, "abc123");
  assert.deepEqual(run.commands[0].command, ["warp", "put"]);
});
