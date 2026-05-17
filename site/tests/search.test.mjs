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

const {
  createInMemorySearchSession,
  createPersistentSearchSession,
  fetchParquetSearchIndexPayload,
  fetchSearchIndexPayload,
  hydrateParquetSearchResultDetail,
  normalizeParquetSearchIndex,
} = require(path.join(outDir, "search.js"));

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

function searchTextForRow(row) {
  return [
    row.suiteKey,
    row.suiteLabel,
    row.testName,
    row.classname,
    row.status,
    ...(row.features || []),
    row.message,
    row.detail,
    row.runId,
    row.runStartedAt,
    row.runFile,
    row.sourcePath,
    row.sourceSymbol,
  ]
    .filter(Boolean)
    .join(" ");
}

function payloadWithRows(rows) {
  return {
    ...searchPayload,
    index_id: `test-${rows.map((row) => row.id).join("-")}`,
    row_count: rows.length,
    rows,
  };
}

function rowWithSearchText(row, overrides) {
  const nextRow = { ...row, ...overrides };
  return { ...nextRow, searchText: searchTextForRow(nextRow) };
}

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

test("deduplicates identical historical matches behind the newest row", async () => {
  const session = await createInMemorySearchSession(searchPayload);
  const results = await session.search("checksum");

  assert.deepEqual(
    results.map((result) => result.runId),
    ["2026-04-02T07-22-59Z"]
  );
});

test("keeps older matching rows visible when their content differs", async () => {
  const olderVariant = rowWithSearchText(searchPayload.rows[4], {
    id: 6,
    message: "Checksum mismatch after abort cleanup",
    detail: "Cleanup left a multipart upload marker behind",
    runId: "2026-03-31T07-22-59Z",
    runStartedAt: "2026-03-31T07:22:59Z",
    runFinishedAt: "2026-03-31T07:22:59Z",
    runFile: "data/runs/2026-03-31T07-22-59Z.json",
    runOrdinal: 2,
  });
  const session = await createInMemorySearchSession(payloadWithRows([...searchPayload.rows, olderVariant]));
  const results = await session.search("checksum", "all", 2);

  assert.deepEqual(
    results.map((result) => ({ runId: result.runId, message: result.message })),
    [
      {
        runId: "2026-04-02T07-22-59Z",
        message: "Checksum mismatch in trailer",
      },
      {
        runId: "2026-03-31T07-22-59Z",
        message: "Checksum mismatch after abort cleanup",
      },
    ]
  );
});

test("deduplicates historical rows when detail only differs by volatile object addresses", async () => {
  const latestRow = rowWithSearchText(searchPayload.rows[1], {
    detail:
      "s3tests/functional/test_s3.py:7058:\nclient = <botocore.client.S3 object at 0x7efd50744c90>, method = 'put_object'",
  });
  const olderRow = rowWithSearchText(searchPayload.rows[4], {
    detail:
      "s3tests/functional/test_s3.py:7057:\nclient = <botocore.client.S3 object at 0x7fcfc14a4f90>, method = 'put_object'",
  });
  const session = await createInMemorySearchSession(payloadWithRows([latestRow, olderRow]));
  const results = await session.search("checksum");

  assert.deepEqual(
    results.map((result) => result.runId),
    ["2026-04-02T07-22-59Z"]
  );
});

test("can include duplicate history when permalink restoration needs an exact run", async () => {
  const session = await createInMemorySearchSession(searchPayload);
  const results = await session.search("checksum", "all", 120, { dedupe: false });

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

test("reports row indexing progress while building a search session", async () => {
  const progressEvents = [];
  const session = await createInMemorySearchSession(searchPayload, {
    progressBatchSize: 2,
    onProgress: (progress) => {
      progressEvents.push(progress);
    },
  });

  assert.equal(session.persistent, false);
  assert(
    progressEvents.some(
      (progress) => progress.phase === "indexing" && progress.indexedRows === 2 && progress.totalRows === 5
    )
  );
  assert.deepEqual(progressEvents.at(-1), {
    phase: "ready",
    indexedRows: 5,
    totalRows: 5,
    persistent: false,
    fromCache: false,
  });
});

test("loads partitioned search index shards and reconstructs the legacy payload shape", async () => {
  const originalFetch = globalThis.fetch;
  const responses = new Map([
    [
      "./data/search-index.json",
      {
        schema_version: 2,
        partitioned: true,
        generated_at: searchPayload.generated_at,
        index_id: searchPayload.index_id,
        row_count: 2,
        partitions: {
          rows: ["search/rows-000.json", "search/rows-001.json"],
        },
      },
    ],
    ["./data/search/rows-000.json", { rows: [searchPayload.rows[0]] }],
    ["./data/search/rows-001.json", { rows: [searchPayload.rows[1]] }],
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
    const payload = await fetchSearchIndexPayload("./data/search-index.json");

    assert.deepEqual(
      requests.map((entry) => entry.path),
      ["./data/search-index.json", "./data/search/rows-000.json", "./data/search/rows-001.json"]
    );
    assert.deepEqual(requests.map((entry) => entry.cache), ["no-store", "no-store", "no-store"]);
    assert.equal(payload.schema_version, 1);
    assert.equal(payload.index_id, searchPayload.index_id);
    assert.equal(payload.row_count, 2);
    assert.deepEqual(
      payload.rows.map((row) => row.id),
      [1, 2]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("limits concurrent Parquet search row queries while loading archived runs", async () => {
  let activeQueries = 0;
  let maxActiveQueries = 0;
  const runIds = Array.from({ length: 12 }, (_, index) => `run-${String(index).padStart(2, "0")}`);
  const indexPayload = {
    generated_at: "2026-05-17T02:15:00.000Z",
    runs: runIds.map((runId, runOrdinal) => ({
      id: runId,
      run_id: runId,
      started_at: `2026-05-${String(17 - runOrdinal).padStart(2, "0")}T02:15:00.000Z`,
      finished_at: `2026-05-${String(17 - runOrdinal).padStart(2, "0")}T02:35:00.000Z`,
      file: `data/runs/${runId}.json`,
      parquet_detail_base_url: `data/runs/${runId}/`,
      sources: {},
      suites: {
        s3_tests: {
          label: "s3-tests",
        },
      },
    })),
  };
  const client = {
    async queryRows(filePath) {
      activeQueries += 1;
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeQueries -= 1;

      const runId = filePath.split("/runs/")[1]?.split("/")[0] || "unknown";
      return [
        {
          run_id: runId,
          suite_key: "s3_tests",
          case_id: `s3_tests:${runId}`,
          status: "fail",
          features: { toArray: () => ["policy"] },
          test_name: `test_${runId}`,
          classname: "s3tests.functional.test_s3",
          message: "AccessDenied",
          detail_preview: "short preview",
          source_path: "s3tests/functional/test_s3.py",
          source_symbol: `test_${runId}`,
          search_text: "AccessDenied policy",
        },
      ];
    },
  };

  const payload = await fetchParquetSearchIndexPayload(indexPayload, client);

  assert.equal(payload.row_count, 12);
  assert.ok(maxActiveQueries <= 6, `expected at most 6 active search queries, saw ${maxActiveQueries}`);
});

test("normalizes Parquet search rows into the existing search payload shape", () => {
  const payload = normalizeParquetSearchIndex({
    generated_at: "2026-05-18T01:15:00.000Z",
    runs: [
      {
        id: "run-new",
        run_id: "run-new",
        started_at: "2026-05-18T01:00:00.000Z",
        finished_at: "2026-05-18T01:15:00.000Z",
        file: "data/runs/run-new.json",
        parquet_detail_base_url: "data/runs/run-new/",
        sources: {
          s3_tests: {
            repo: "https://github.com/ceph/s3-tests.git",
            ref: "main",
            commit: "abc123456789",
            short_commit: "abc123456789",
          },
        },
        suites: {
          s3_tests: {
            label: "s3-tests",
          },
        },
      },
      {
        id: "run-old",
        run_id: "run-old",
        started_at: "2026-05-17T01:00:00.000Z",
        finished_at: "2026-05-17T01:15:00.000Z",
        file: "data/runs/run-old.json",
        parquet_detail_base_url: "data/runs/run-old/",
        sources: {},
        suites: {
          mint: {
            label: "mint",
          },
        },
      },
    ],
    rowsByRunId: {
      "run-new": [
        {
          run_id: "run-new",
          suite_key: "s3_tests",
          case_id: "s3_tests:test_bucket_policy_access_denied",
          status: "fail",
          features: ["policy"],
          test_name: "test_bucket_policy_access_denied",
          classname: "s3tests.functional.test_s3",
          message: "AccessDenied",
          detail_preview: "short preview",
          source_path: "s3tests/functional/test_s3.py",
          source_symbol: "test_bucket_policy_access_denied",
          search_text: "AccessDenied policy",
        },
      ],
      "run-old": [
        {
          run_id: "run-old",
          suite_key: "mint",
          case_id: "mint:awscli_bucket_list",
          status: "pass",
          features: { toArray: () => ["bucket"] },
          test_name: "awscli_bucket_list",
          classname: "awscli",
          message: "",
          detail_preview: "",
          source_path: "",
          source_symbol: "awscli_bucket_list",
          search_text: "awscli bucket",
        },
      ],
    },
  });

  assert.equal(payload.schema_version, 1);
  assert.equal(payload.generated_at, "2026-05-18T01:15:00.000Z");
  assert.equal(payload.row_count, 2);
  assert.match(payload.index_id, /^parquet-search-/);
  assert.deepEqual(
    payload.rows.map((row) => ({
      id: row.id,
      caseId: row.caseId,
      suiteLabel: row.suiteLabel,
      runId: row.runId,
      isLatestRun: row.isLatestRun,
      runOrdinal: row.runOrdinal,
      detail: row.detail,
      sourceLanguage: row.sourceLanguage,
      sourceRef: row.sourceRef,
      features: row.features,
    })),
    [
      {
        id: 1,
        caseId: "s3_tests:test_bucket_policy_access_denied",
        suiteLabel: "s3-tests",
        runId: "run-new",
        isLatestRun: true,
        runOrdinal: 0,
        detail: "short preview",
        sourceLanguage: "python",
        sourceRef: "abc123456789",
        features: ["policy"],
      },
      {
        id: 2,
        caseId: "mint:awscli_bucket_list",
        suiteLabel: "mint",
        runId: "run-old",
        isLatestRun: false,
        runOrdinal: 1,
        detail: "",
        sourceLanguage: "shell",
        sourceRef: "",
        features: ["bucket"],
      },
    ]
  );
  assert.match(payload.rows[0].searchText, /s3-tests/);
  assert.match(payload.rows[0].searchText, /run-new/);
  assert.match(payload.rows[0].searchText, /AccessDenied policy/);
});

test("hydrates a Parquet search result with full case detail on demand", async () => {
  const result = {
    id: "1",
    caseId: "s3_tests:test_bucket_policy_access_denied",
    suiteKey: "s3_tests",
    suiteLabel: "s3-tests",
    testName: "test_bucket_policy_access_denied",
    classname: "s3tests.functional.test_s3",
    status: "fail",
    features: ["policy"],
    message: "AccessDenied",
    detail: "short preview",
    runId: "run-new",
    runStartedAt: "2026-05-18T01:00:00.000Z",
    runFinishedAt: "2026-05-18T01:15:00.000Z",
    runFile: "data/runs/run-new.json",
    isLatestRun: true,
    matchedFields: [],
    score: 1,
  };
  const index = {
    runs: [
      {
        id: "run-new",
        run_id: "run-new",
        parquet_detail_base_url: "data/runs/run-new/",
      },
    ],
  };
  const queries = [];
  const client = {
    async queryRows(filePath, sql) {
      queries.push({ filePath, sql });
      return [
        {
          case_id: "s3_tests:test_bucket_policy_access_denied",
          name: "test_bucket_policy_access_denied",
          classname: "s3tests.functional.test_s3",
          status: "fail",
          duration_ms: 12,
          features: { toArray: () => ["policy", "iam"] },
          message: "AccessDenied full message",
          detail: "full traceback from cases parquet",
          source_repo: "https://github.com/ceph/s3-tests.git",
          source_ref: "abc123456789",
          source_path: "s3tests/functional/test_s3.py",
          source_symbol: "test_bucket_policy_access_denied",
        },
      ];
    },
  };

  const hydrated = await hydrateParquetSearchResultDetail(result, index, client);

  assert.deepEqual(queries, [
    {
      filePath: "data/runs/run-new/cases-s3-tests.parquet",
      sql:
        "SELECT * FROM read_parquet(__PARQUET_FILE__) WHERE case_id = 's3_tests:test_bucket_policy_access_denied' LIMIT 1",
    },
  ]);
  assert.equal(hydrated.detail, "full traceback from cases parquet");
  assert.equal(hydrated.message, "AccessDenied full message");
  assert.deepEqual(hydrated.features, ["policy", "iam"]);
  assert.equal(hydrated.sourceRepo, "https://github.com/ceph/s3-tests.git");
  assert.equal(hydrated.sourceRef, "abc123456789");
});

test("falls back to in-memory search when IndexedDB is unavailable", async () => {
  const session = await createPersistentSearchSession(searchPayload);
  const results = await session.search("accessdenied");

  assert.equal(session.persistent, false);
  assert.equal(results[0].testName, "test_bucket_policy_access_denied");
});
