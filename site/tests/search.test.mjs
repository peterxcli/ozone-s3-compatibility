import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "ozone-s3-compatibility-search-test-"));
const require = createRequire(import.meta.url);
const tscBin = path.join(siteRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

rmSync(outDir, { recursive: true, force: true });
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
    "src/lib/search.ts",
  ],
  { cwd: siteRoot, stdio: "inherit" }
);

const { searchRunCases } = require(path.join(outDir, "search.js"));

function summary(id, startedAt, file = `data/runs/${id}.json`) {
  return {
    id,
    status: "completed",
    started_at: startedAt,
    finished_at: startedAt,
    workflow_run_url: "",
    execution: null,
    file,
    sources: {
      ozone: { repo: "ozone", short_commit: "ozone123" },
      s3_tests: { repo: "s3-tests", short_commit: "s3tests123" },
      mint: { repo: "mint", short_commit: "mint123" },
    },
    suites: {
      s3_tests: {
        label: "s3-tests",
        status: "completed",
        summary: { compatibility_rate: 0.5, eligible: 2, passed: 1, failed: 1, errored: 0, skipped: 0 },
        feature_summaries: [],
      },
      mint: {
        label: "mint",
        status: "completed",
        summary: { compatibility_rate: 1, eligible: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
        feature_summaries: [],
      },
    },
  };
}

function fullRun(id, startedAt) {
  const runSummary = summary(id, startedAt);
  return {
    ...runSummary,
    run_id: id,
    suites: {
      s3_tests: {
        ...runSummary.suites.s3_tests,
        included_case_strategy: "non_passing_only",
        non_passing_cases: [
          {
            name: "test_bucket_policy_access_denied",
            classname: "s3tests.functional.test_s3",
            status: "fail",
            features: ["policy"],
            duration_ms: 42,
            message: "ClientError: AccessDenied for bucket policy",
          },
          {
            name: "test_multipart_upload_checksum",
            classname: "s3tests.functional.test_headers",
            status: "error",
            features: ["headers"],
            duration_ms: 100,
            message: "Checksum mismatch in trailer",
          },
          {
            name: "test_v4_signature_streaming",
            classname: "s3tests.functional.test_headers",
            status: "fail",
            features: ["headers"],
            duration_ms: 84,
            message: "",
            detail: "Traceback: SignatureDoesNotMatch while validating signed chunks",
          },
        ],
      },
      mint: {
        ...runSummary.suites.mint,
        included_case_strategy: "all",
        cases: [
          {
            name: "minio-js_presigned_get",
            classname: "minio-js",
            status: "pass",
            features: ["presigned"],
            duration_ms: 15,
            message: "",
          },
        ],
      },
    },
  };
}

const olderRun = fullRun("2026-04-01T07-22-59Z", "2026-04-01T07:22:59Z");
const latestRun = fullRun("2026-04-02T07-22-59Z", "2026-04-02T07:22:59Z");
const searchableRuns = [
  { summary: summary(olderRun.run_id, olderRun.started_at), run: olderRun, isLatestRun: false },
  { summary: summary(latestRun.run_id, latestRun.started_at), run: latestRun, isLatestRun: true },
];

test("matches case-insensitive full text across test names and error messages", () => {
  const results = searchRunCases(searchableRuns, "accessdenied policy");

  assert.equal(results.length, 2);
  assert.deepEqual(
    {
      testName: results[0].testName,
      suiteKey: results[0].suiteKey,
      suiteLabel: results[0].suiteLabel,
      message: results[0].message,
      isLatestRun: results[0].isLatestRun,
    },
    {
      testName: "test_bucket_policy_access_denied",
      suiteKey: "s3_tests",
      suiteLabel: "s3-tests",
      message: "ClientError: AccessDenied for bucket policy",
      isLatestRun: true,
    }
  );
  assert(results[0].matchedFields.includes("test name"));
  assert(results[0].matchedFields.includes("error message"));
});

test("matches suite and run metadata and labels the latest run", () => {
  const results = searchRunCases(searchableRuns, "mint 2026-04-02");

  assert.equal(results.length, 1);
  assert.deepEqual(
    {
      testName: results[0].testName,
      suiteKey: results[0].suiteKey,
      suiteLabel: results[0].suiteLabel,
      runId: results[0].runId,
      runStartedAt: results[0].runStartedAt,
      isLatestRun: results[0].isLatestRun,
    },
    {
      testName: "minio-js_presigned_get",
      suiteKey: "mint",
      suiteLabel: "mint",
      runId: latestRun.run_id,
      runStartedAt: latestRun.started_at,
      isLatestRun: true,
    }
  );
  assert(results[0].matchedFields.includes("suite"));
  assert(results[0].matchedFields.includes("run"));
});

test("prioritizes more recent matching runs before older matching runs", () => {
  const results = searchRunCases(searchableRuns, "checksum");

  assert.deepEqual(
    results.map((result) => result.runId),
    [latestRun.run_id, olderRun.run_id]
  );
});

test("matches stored failure detail text when the short message is empty", () => {
  const results = searchRunCases(searchableRuns, "signaturedoesnotmatch chunks");

  assert.equal(results.length, 2);
  assert.equal(results[0].testName, "test_v4_signature_streaming");
  assert.equal(results[0].detail, "Traceback: SignatureDoesNotMatch while validating signed chunks");
  assert(results[0].matchedFields.includes("error message"));
});

test("can narrow matches to a selected suite", () => {
  const results = searchRunCases(
    [{ summary: summary(latestRun.run_id, latestRun.started_at), run: latestRun, isLatestRun: true }],
    "presigned",
    "s3_tests"
  );

  assert.equal(results.length, 0);
});
