import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    "--esModuleInterop",
    "--rootDir",
    "src/lib",
    "--outDir",
    outDir,
    "src/lib/search.ts",
  ],
  { cwd: siteRoot, stdio: "inherit" }
);
writeFileSync(path.join(outDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
symlinkSync(path.join(siteRoot, "node_modules"), path.join(outDir, "node_modules"), "junction");

const { createInMemorySearchSession, createPersistentSearchSession } = require(path.join(outDir, "search.js"));

const searchPayload = {
  schema_version: 1,
  generated_at: "2026-04-02T07:22:59Z",
  index_id: "2026-04-02T07-22-59Z-5",
  row_count: 5,
  rows: [
    {
      id: 1,
      suiteKey: "s3_tests",
      suiteLabel: "s3-tests",
      testName: "test_bucket_policy_access_denied",
      classname: "s3tests.functional.test_s3",
      status: "fail",
      features: ["policy"],
      message: "ClientError: AccessDenied for bucket policy",
      detail: "",
      runId: "2026-04-02T07-22-59Z",
      runStartedAt: "2026-04-02T07:22:59Z",
      runFinishedAt: "2026-04-02T07:22:59Z",
      runFile: "data/runs/2026-04-02T07-22-59Z.json",
      isLatestRun: true,
      runOrdinal: 0,
      searchText:
        "s3_tests s3-tests test_bucket_policy_access_denied s3tests.functional.test_s3 fail policy ClientError: AccessDenied for bucket policy 2026-04-02T07-22-59Z 2026-04-02T07:22:59Z data/runs/2026-04-02T07-22-59Z.json",
    },
    {
      id: 2,
      suiteKey: "s3_tests",
      suiteLabel: "s3-tests",
      testName: "test_multipart_upload_checksum",
      classname: "s3tests.functional.test_headers",
      status: "error",
      features: ["headers"],
      message: "Checksum mismatch in trailer",
      detail: "",
      runId: "2026-04-02T07-22-59Z",
      runStartedAt: "2026-04-02T07:22:59Z",
      runFinishedAt: "2026-04-02T07:22:59Z",
      runFile: "data/runs/2026-04-02T07-22-59Z.json",
      isLatestRun: true,
      runOrdinal: 0,
      searchText:
        "s3_tests s3-tests test_multipart_upload_checksum s3tests.functional.test_headers error headers Checksum mismatch in trailer 2026-04-02T07-22-59Z 2026-04-02T07:22:59Z data/runs/2026-04-02T07-22-59Z.json",
    },
    {
      id: 3,
      suiteKey: "s3_tests",
      suiteLabel: "s3-tests",
      testName: "test_v4_signature_streaming",
      classname: "s3tests.functional.test_headers",
      status: "fail",
      features: ["headers"],
      message: "",
      detail: "Traceback: SignatureDoesNotMatch while validating signed chunks",
      runId: "2026-04-02T07-22-59Z",
      runStartedAt: "2026-04-02T07:22:59Z",
      runFinishedAt: "2026-04-02T07:22:59Z",
      runFile: "data/runs/2026-04-02T07-22-59Z.json",
      isLatestRun: true,
      runOrdinal: 0,
      searchText:
        "s3_tests s3-tests test_v4_signature_streaming s3tests.functional.test_headers fail headers Traceback: SignatureDoesNotMatch while validating signed chunks 2026-04-02T07-22-59Z 2026-04-02T07:22:59Z data/runs/2026-04-02T07-22-59Z.json",
    },
    {
      id: 4,
      suiteKey: "mint",
      suiteLabel: "mint",
      testName: "minio-js_presigned_get",
      classname: "minio-js",
      status: "pass",
      features: ["presigned"],
      message: "",
      detail: "",
      runId: "2026-04-02T07-22-59Z",
      runStartedAt: "2026-04-02T07:22:59Z",
      runFinishedAt: "2026-04-02T07:22:59Z",
      runFile: "data/runs/2026-04-02T07-22-59Z.json",
      isLatestRun: true,
      runOrdinal: 0,
      searchText:
        "mint mint minio-js_presigned_get minio-js pass presigned 2026-04-02T07-22-59Z 2026-04-02T07:22:59Z data/runs/2026-04-02T07-22-59Z.json",
    },
    {
      id: 5,
      suiteKey: "s3_tests",
      suiteLabel: "s3-tests",
      testName: "test_multipart_upload_checksum",
      classname: "s3tests.functional.test_headers",
      status: "error",
      features: ["headers"],
      message: "Checksum mismatch in trailer",
      detail: "",
      runId: "2026-04-01T07-22-59Z",
      runStartedAt: "2026-04-01T07:22:59Z",
      runFinishedAt: "2026-04-01T07:22:59Z",
      runFile: "data/runs/2026-04-01T07-22-59Z.json",
      isLatestRun: false,
      runOrdinal: 1,
      searchText:
        "s3_tests s3-tests test_multipart_upload_checksum s3tests.functional.test_headers error headers Checksum mismatch in trailer 2026-04-01T07-22-59Z 2026-04-01T07:22:59Z data/runs/2026-04-01T07-22-59Z.json",
    },
  ],
};

test("matches case-insensitive full text across test names and error messages", async () => {
  const session = await createInMemorySearchSession(searchPayload);
  const results = await session.search("accessdenied policy");

  assert.equal(results.length, 1);
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

test("matches suite and run metadata and labels the latest run", async () => {
  const session = await createInMemorySearchSession(searchPayload);
  const results = await session.search("mint 2026-04-02");

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
      runId: "2026-04-02T07-22-59Z",
      runStartedAt: "2026-04-02T07:22:59Z",
      isLatestRun: true,
    }
  );
  assert(results[0].matchedFields.includes("suite"));
  assert(results[0].matchedFields.includes("run"));
});

test("prioritizes more recent matching runs before older matching runs", async () => {
  const session = await createInMemorySearchSession(searchPayload);
  const results = await session.search("checksum");

  assert.deepEqual(
    results.map((result) => result.runId),
    ["2026-04-02T07-22-59Z", "2026-04-01T07-22-59Z"]
  );
});

test("matches stored failure detail text when the short message is empty", async () => {
  const session = await createInMemorySearchSession(searchPayload);
  const results = await session.search("signaturedoesnotmatch chunks");

  assert.equal(results.length, 1);
  assert.equal(results[0].testName, "test_v4_signature_streaming");
  assert.equal(results[0].detail, "Traceback: SignatureDoesNotMatch while validating signed chunks");
  assert(results[0].matchedFields.includes("error message"));
});

test("can narrow matches to a selected suite", async () => {
  const session = await createInMemorySearchSession(searchPayload);
  const results = await session.search("presigned", "s3_tests");

  assert.equal(results.length, 0);
});

test("falls back to in-memory search when IndexedDB is unavailable", async () => {
  const session = await createPersistentSearchSession(searchPayload);
  const results = await session.search("accessdenied");

  assert.equal(session.persistent, false);
  assert.equal(results[0].testName, "test_bucket_policy_access_denied");
});
