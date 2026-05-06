import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "ozone-s3-compatibility-share-state-test-"));
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
    "src/lib/shareState.ts",
  ],
  { cwd: siteRoot, stdio: "inherit" },
);

const {
  caseIdentityForResult,
  parseSearchShareState,
  resultMatchesSharedCase,
  searchUrlFromState,
} = require(path.join(outDir, "shareState.js"));

test("serializes search query and suite filter into a shareable search URL", () => {
  const url = searchUrlFromState(
    { query: "AccessDenied bucket", suiteFilter: "s3_tests" },
    "https://example.test/ozone-s3-compatibility/?old=1#latest-run-section",
  );

  assert.equal(url, "/ozone-s3-compatibility/?old=1&q=AccessDenied+bucket&suite=s3_tests#search-section");
});

test("serializes and parses a selected test case permalink", () => {
  const selectedCase = {
    runId: "2026-05-06T06-46-57Z",
    suiteKey: "s3_tests",
    testName: "test_object_create_bad_expect_mismatch",
  };
  const url = searchUrlFromState(
    { query: "expect mismatch", suiteFilter: "all", selectedCase },
    "https://example.test/ozone-s3-compatibility/",
  );
  const parsed = parseSearchShareState(`https://example.test${url}`);

  assert.equal(parsed.query, "expect mismatch");
  assert.equal(parsed.suiteFilter, "all");
  assert.deepEqual(parsed.selectedCase, selectedCase);
});

test("matches selected case by run, suite, and test function or source symbol", () => {
  const result = {
    runId: "run-1",
    suiteKey: "s3_tests",
    testName: "test_bucket_policy_access_denied[param]",
    sourceSymbol: "test_bucket_policy_access_denied",
  };

  assert.deepEqual(caseIdentityForResult(result), {
    runId: "run-1",
    suiteKey: "s3_tests",
    testName: "test_bucket_policy_access_denied[param]",
  });
  assert.equal(
    resultMatchesSharedCase(result, {
      runId: "run-1",
      suiteKey: "s3_tests",
      testName: "test_bucket_policy_access_denied",
    }),
    true,
  );
});
