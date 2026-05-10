import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "ozone-s3-compatibility-report-test-"));
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
    "src/lib/report.ts",
  ],
  { cwd: siteRoot, stdio: "inherit" },
);
writeFileSync(path.join(outDir, "package.json"), '{"type":"commonjs"}\n', "utf8");

const {
  compareFeatureRateWithPrevious,
  compareFeatureWithPrevious,
  fetchIndex,
  formatRateDelta,
  summarizeFeatureComparisons,
} = require(path.join(outDir, "report.js"));

function summary(passed, failed, errored = 0, skipped = 0) {
  const eligible = passed + failed + errored;
  return {
    compatibility_rate: eligible ? passed / eligible : null,
    eligible,
    passed,
    failed,
    errored,
    skipped,
  };
}

function suite(featureSummary, cases, includedCaseStrategy = "all") {
  return {
    label: "s3-tests",
    status: "completed",
    summary: summary(0, 0),
    feature_summaries: [
      {
        name: "bucket",
        label: "bucket",
        summary: featureSummary,
      },
    ],
    included_case_strategy: includedCaseStrategy,
    cases: includedCaseStrategy === "all" ? cases : undefined,
    non_passing_cases: cases.filter((entry) => entry.status !== "pass"),
  };
}

function multiFeatureSuite(featureSummaries) {
  return {
    label: "s3-tests",
    status: "completed",
    summary: summary(0, 0),
    feature_summaries: featureSummaries.map(([name, featureSummary]) => ({
      name,
      label: name,
      summary: featureSummary,
    })),
    included_case_strategy: "all",
    cases: [],
  };
}

test("compares feature pass rate and status flips against the immediately older suite", () => {
  const current = suite(summary(3, 1), [
    { classname: "s3tests.functional.test_bucket", name: "test_fixed", status: "pass", features: ["bucket"] },
    { classname: "s3tests.functional.test_bucket", name: "test_still_passes", status: "pass", features: ["bucket"] },
    { classname: "s3tests.functional.test_bucket", name: "test_new_failure", status: "fail", features: ["bucket"] },
    { classname: "s3tests.functional.test_bucket", name: "test_new_pass", status: "pass", features: ["bucket"] },
  ]);
  const previous = suite(summary(2, 2), [
    { classname: "s3tests.functional.test_bucket", name: "test_fixed", status: "fail", features: ["bucket"] },
    { classname: "s3tests.functional.test_bucket", name: "test_still_passes", status: "pass", features: ["bucket"] },
    { classname: "s3tests.functional.test_bucket", name: "test_new_failure", status: "pass", features: ["bucket"] },
    { classname: "s3tests.functional.test_bucket", name: "test_new_pass", status: "pass", features: ["bucket"] },
  ]);

  const comparison = compareFeatureWithPrevious(current, previous, "bucket");

  assert.equal(comparison.direction, "improved");
  assert.equal(comparison.delta, 0.25);
  assert.deepEqual(
    comparison.nowPassing.map((entry) => `${entry.fromStatus}->${entry.toStatus}:${entry.name}`),
    ["fail->pass:test_fixed"],
  );
  assert.deepEqual(
    comparison.noLongerPassing.map((entry) => `${entry.fromStatus}->${entry.toStatus}:${entry.name}`),
    ["pass->fail:test_new_failure"],
  );
  assert.equal(formatRateDelta(comparison.delta), "+25.0 pts vs previous");
});

test("infers newly non-passing cases when the older suite only stores non-passing cases", () => {
  const current = suite(summary(1, 1), [
    { classname: "s3tests.functional.test_bucket", name: "test_regressed", status: "fail", features: ["bucket"] },
  ], "non_passing_only");
  const previous = suite(summary(2, 0), [], "non_passing_only");

  const comparison = compareFeatureWithPrevious(current, previous, "bucket");

  assert.equal(comparison.direction, "regressed");
  assert.equal(comparison.delta, -0.5);
  assert.deepEqual(
    comparison.noLongerPassing.map((entry) => `${entry.fromStatus}->${entry.toStatus}:${entry.name}`),
    ["pass->fail:test_regressed"],
  );
});

test("does not infer case flips from an index summary without stored case metadata", () => {
  const current = suite(summary(1, 1), [
    { classname: "s3tests.functional.test_bucket", name: "test_regressed", status: "fail", features: ["bucket"] },
  ]);
  const previousSummaryOnly = {
    label: "s3-tests",
    status: "completed",
    summary: summary(2, 0),
    feature_summaries: [
      {
        name: "bucket",
        label: "bucket",
        summary: summary(2, 0),
      },
    ],
  };

  const comparison = compareFeatureWithPrevious(current, previousSummaryOnly, "bucket");

  assert.equal(comparison.direction, "regressed");
  assert.equal(comparison.delta, -0.5);
  assert.deepEqual(comparison.nowPassing, []);
  assert.deepEqual(comparison.noLongerPassing, []);
});

test("compares feature pass rate without scanning stored test cases", () => {
  const current = suite(summary(3, 1), [
    { classname: "s3tests.functional.test_bucket", name: "test_fixed", status: "pass", features: ["bucket"] },
  ]);
  const previous = suite(summary(2, 2), [
    { classname: "s3tests.functional.test_bucket", name: "test_fixed", status: "fail", features: ["bucket"] },
  ]);

  const comparison = compareFeatureRateWithPrevious(current, previous, "bucket");

  assert.equal(comparison.direction, "improved");
  assert.equal(comparison.delta, 0.25);
  assert.deepEqual(comparison.nowPassing, []);
  assert.deepEqual(comparison.noLongerPassing, []);
});

test("summarizes feature-level movement against the immediately older suite", () => {
  const current = multiFeatureSuite([
    ["bucket", summary(3, 1)],
    ["object", summary(1, 3)],
    ["acl", summary(2, 2)],
    ["kms", summary(0, 0)],
  ]);
  const previous = multiFeatureSuite([
    ["bucket", summary(2, 2)],
    ["object", summary(2, 2)],
    ["acl", summary(2, 2)],
  ]);

  const movement = summarizeFeatureComparisons(current, previous);

  assert.deepEqual(movement, {
    improved: 1,
    regressed: 1,
    flat: 1,
    comparable: 3,
  });
});

test("loads partitioned index shards and reconstructs the existing index shape", async () => {
  const originalFetch = globalThis.fetch;
  const responses = new Map([
    [
      "./data/index.json",
      {
        schema_version: 2,
        partitioned: true,
        generated_at: "2026-04-02T07:22:59Z",
        rate_formula: "compatibility_rate = passed / eligible",
        suite_order: ["s3_tests"],
        partitions: {
          runs: ["index/runs-000.json", "index/runs-001.json"],
          charts_overall: "index/charts-overall.json",
          charts_features: {
            s3_tests: "index/charts-features-s3_tests.json",
          },
        },
      },
    ],
    ["./data/index/runs-000.json", { runs: [{ id: "run-2", started_at: "2026-04-02T07:22:59Z" }] }],
    ["./data/index/runs-001.json", { runs: [{ id: "run-1", started_at: "2026-04-01T07:22:59Z" }] }],
    ["./data/index/charts-overall.json", { overall: { s3_tests: [{ run_id: "run-1" }] } }],
    [
      "./data/index/charts-features-s3_tests.json",
      { suite: "s3_tests", features: { bucket: [{ run_id: "run-1" }] } },
    ],
  ]);
  const requests = [];

  globalThis.fetch = async (path, options) => {
    const key = String(path);
    requests.push({ path: key, cache: options?.cache });
    if (!responses.has(key)) {
      return { ok: false, json: async () => ({}) };
    }
    return { ok: true, json: async () => responses.get(key) };
  };

  try {
    const index = await fetchIndex("./data/index.json");

    assert.deepEqual(
      requests.map((entry) => entry.path),
      [
        "./data/index.json",
        "./data/index/runs-000.json",
        "./data/index/runs-001.json",
        "./data/index/charts-overall.json",
        "./data/index/charts-features-s3_tests.json",
      ],
    );
    assert.deepEqual(requests.map((entry) => entry.cache), ["no-store", "no-store", "no-store", "no-store", "no-store"]);
    assert.deepEqual(index.runs.map((entry) => entry.id), ["run-2", "run-1"]);
    assert.deepEqual(index.charts.overall.s3_tests, [{ run_id: "run-1" }]);
    assert.deepEqual(index.charts.features.s3_tests.bucket, [{ run_id: "run-1" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
