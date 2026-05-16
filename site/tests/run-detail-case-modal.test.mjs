import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "ozone-s3-compatibility-case-result-test-"));
const require = createRequire(import.meta.url);
const tscBin = path.join(siteRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

function compileCaseResult() {
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
      "src/lib/caseResult.ts",
    ],
    { cwd: siteRoot, stdio: "inherit" },
  );
}

test("normalizes a run detail stored case into the modal result shape", () => {
  compileCaseResult();
  const { storedCaseSearchResult } = require(path.join(outDir, "caseResult.js"));
  const result = storedCaseSearchResult({
    run: {
      run_id: "2026-05-06T06-46-57Z",
      started_at: "2026-05-06T06:46:57Z",
      finished_at: "2026-05-06T07:01:00Z",
      status: "completed",
      sources: {
        ozone: { repo: "https://github.com/apache/ozone", commit: "abc" },
        s3_tests: { repo: "https://github.com/ceph/s3-tests.git", commit: "1234567890abcdef" },
        mint: { repo: "https://github.com/minio/mint.git", commit: "def" },
      },
      suites: {},
    },
    suiteKey: "s3_tests",
    suite: { label: "s3-tests" },
    caseEntry: {
      name: "test_bucket_policy_access_denied[param]",
      classname: "s3tests.functional.test_iam",
      status: "fail",
      features: ["iam"],
      message: "AccessDenied",
      detail: "traceback",
    },
    runFile: "data/runs/2026-05-06T06-46-57Z.json",
    isLatestRun: true,
  });

  assert.equal(result.testName, "test_bucket_policy_access_denied[param]");
  assert.equal(result.suiteKey, "s3_tests");
  assert.equal(result.runId, "2026-05-06T06-46-57Z");
  assert.equal(result.runFile, "data/runs/2026-05-06T06-46-57Z.json");
  assert.equal(result.sourceLanguage, "python");
  assert.equal(result.sourcePath, "s3tests/functional/test_iam.py");
  assert.equal(result.sourceSymbol, "test_bucket_policy_access_denied");
  assert.equal(result.sourceRef, "1234567890abcdef");
  assert.equal(result.sourceRepo, "https://github.com/ceph/s3-tests.git");
});

test("run detail case rows expose modal details and permalinks through the app", () => {
  const appSource = readFileSync(path.join(siteRoot, "src", "App.vue"), "utf8");
  const historyItemSource = readFileSync(path.join(siteRoot, "src", "components", "HistoryItem.vue"), "utf8");
  const runDetailsSource = readFileSync(path.join(siteRoot, "src", "components", "RunDetails.vue"), "utf8");
  const suiteCardSource = readFileSync(path.join(siteRoot, "src", "components", "SuiteCard.vue"), "utf8");

  assert.match(suiteCardSource, /"open-case": \[result: SearchResult\]/);
  assert.match(suiteCardSource, /function openCaseDetails\(entry: StoredCaseEntry\): void/);
  assert.match(suiteCardSource, /function casePermalink\(entry: StoredCaseEntry\): string/);
  assert.match(suiteCardSource, />Details</);
  assert.match(suiteCardSource, />Permalink</);
  assert.match(runDetailsSource, /"open-case": \[result: SearchResult\]/);
  assert.match(historyItemSource, /"open-case": \[result: SearchResult\]/);
  assert.match(appSource, /function openRunDetailCaseModal\(result: SearchResult\): void/);
  assert.match(appSource, /@open-case="openRunDetailCaseModal"/);
});
