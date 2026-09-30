import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "ozone-s3-compatibility-search-test-"));
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

const {
  STALE_SEARCH_INDEX_MESSAGE,
  buildCaseSearchSql,
  caseSearchClientFromEngine,
  createCaseSearchSession,
  hydrateParquetSearchResultDetail,
  runTokenMatches,
  searchQueryTokens,
  searchResultFromRow,
} = require(path.join(outDir, "search.js"));

const fixtureDir = path.join(siteRoot, "tests", "fixtures");
const fixtureRuns = JSON.parse(readFileSync(path.join(fixtureDir, "search-runs.json"), "utf8"));
const fixtureParquet = readFileSync(path.join(fixtureDir, "search-cases.parquet"));
const searchCasesUrl = "https://report.example/data/search/cases.parquet";
const [latestRun, middleRun, oldestRun] = fixtureRuns;

/** Serves the fixture with HTTP range semantics, the way GitHub Pages does. */
function fixtureRangeFetcher(requests = []) {
  return async (url, range) => {
    requests.push({ url, range });
    const size = fixtureParquet.length;
    const suffix = /^bytes=-(\d+)$/.exec(range);
    const bounded = /^bytes=(\d+)-(\d+)$/.exec(range);
    const start = suffix ? Math.max(0, size - Number(suffix[1])) : Number(bounded[1]);
    const end = suffix ? size - 1 : Math.min(size - 1, Number(bounded[2]));
    return {
      status: 206,
      etag: '"fixture"',
      contentRange: `bytes ${start}-${end}/${size}`,
      body: new Uint8Array(fixtureParquet.subarray(start, end + 1)),
    };
  };
}

let enginePromise;
function loadEngine() {
  enginePromise ||= (async () => {
    const generatedDir = path.join(siteRoot, "src", "generated", "case-search");
    const engine = await import(pathToFileURL(path.join(generatedDir, "case_search.js")).href);
    engine.initSync({ module: readFileSync(path.join(generatedDir, "case_search_bg.wasm")) });
    return engine;
  })();
  return enginePromise;
}

async function openFixtureSession(requests = []) {
  const engine = await loadEngine();
  return createCaseSearchSession({
    index: { runs: fixtureRuns },
    searchCasesUrl,
    createClient: async () => caseSearchClientFromEngine(new engine.CaseSearchEngine(fixtureRangeFetcher(requests))),
  });
}

function fakeClient({ count = 3, rows = [], onQuery } = {}) {
  const calls = [];
  return {
    calls,
    async registerParquet(table, url) {
      calls.push({ registerParquet: [table, url] });
    },
    async queryRows(sql) {
      calls.push({ sql });
      onQuery?.(sql);
      return /COUNT\(\*\)/.test(sql) ? [{ row_count: count }] : rows;
    },
    stats() {
      return { requests: 0, bytesFetched: 0, cacheHits: 0 };
    },
  };
}

test("normalizes queries into the lowercase words stored in search_text", () => {
  assert.deepEqual(searchQueryTokens("  AccessDenied  put_object ACCESS "), ["access", "denied", "put", "object"]);
  assert.equal(searchQueryTokens(Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ")).length, 12);
});

test("builds a word-prefix query ordered by run recency and score", () => {
  const sql = buildCaseSearchSql({ tokens: ["access", "12"], suiteFilter: "s3_tests", limit: 120 });

  assert.match(sql, /FROM search_cases/);
  assert.match(sql, /WHERE suite_key = 's3_tests' AND search_text LIKE '% access%' AND search_text LIKE '% 12 %'/);
  assert.match(sql, /latest_run_id AS run_id, latest_run_ordinal AS run_ordinal/);
  assert.match(sql, /CASE WHEN \(COALESCE\(test_name, ''\) ILIKE '%access%'\)/);
  assert.match(sql, /ORDER BY run_ordinal, score DESC, suite_key, test_name, content_id\nLIMIT 120$/);
  assert.doesNotMatch(sql, /unnest/);
});

test("quotes user input in generated SQL", () => {
  const sql = buildCaseSearchSql({ tokens: ["bucket"], suiteFilter: "x' OR '1'='1", limit: 5 });

  assert.match(sql, /suite_key = 'x'' OR ''1''=''1'/);
});

test("treats query words that name some runs as run filters", () => {
  const tokens = searchQueryTokens("2026-05-16 checksum");
  const runTokens = runTokenMatches(tokens, fixtureRuns);
  const allRunIds = fixtureRuns.map((run) => run.run_id);

  assert.deepEqual(runTokens, [
    { token: "2026", runIds: allRunIds },
    { token: "05", runIds: allRunIds },
    { token: "16", runIds: [middleRun.run_id] },
  ]);

  // "2026" and "05" name every run, so they match any case; only "16" narrows.
  const sql = buildCaseSearchSql({ tokens, limit: 10, runTokens, runIds: allRunIds });
  assert.match(sql, /  WHERE search_text LIKE '% checksum%'\n/);
  assert.doesNotMatch(sql, /LIKE '% 2026%'|LIKE '% 05 %'/);
  assert.match(sql, /unnest\(run_ids\) AS run_id/);
  assert.match(sql, new RegExp(`\\(token_0 OR occurrences\\.run_id IN \\('${middleRun.run_id}'\\)\\)`));
  assert.match(sql, new RegExp(`VALUES \\('${latestRun.run_id}', 0\\), \\('${middleRun.run_id}', 1\\)`));
});

test("maps search rows to results with run metadata from the report catalog", () => {
  const result = searchResultFromRow(
    {
      content_id: 7,
      suite_key: "mint",
      case_id: "mint:awscli_bucket_list",
      test_name: "awscli_bucket_list",
      classname: "awscli",
      status: "fail",
      features: ["awscli"],
      message: "NoSuchBucket",
      detail_preview: "preview",
      source_path: "",
      source_symbol: "awscli_bucket_list",
      run_id: middleRun.run_id,
      run_ordinal: 1,
      score: 91,
    },
    fixtureRuns,
    ["bucket", "nosuchbucket"],
  );

  assert.deepEqual(
    {
      id: result.id,
      caseId: result.caseId,
      suiteLabel: result.suiteLabel,
      runId: result.runId,
      runStartedAt: result.runStartedAt,
      runFile: result.runFile,
      isLatestRun: result.isLatestRun,
      sourceLanguage: result.sourceLanguage,
      sourceRef: result.sourceRef,
      sourceRepo: result.sourceRepo,
      sourceSnippet: result.sourceSnippet,
      detail: result.detail,
      matchedFields: result.matchedFields,
      score: result.score,
    },
    {
      id: "search:7",
      caseId: "mint:awscli_bucket_list",
      suiteLabel: "mint",
      runId: middleRun.run_id,
      runStartedAt: middleRun.started_at,
      runFile: middleRun.file,
      isLatestRun: false,
      sourceLanguage: "shell",
      sourceRef: "mintcommit16",
      sourceRepo: "https://github.com/minio/mint.git",
      sourceSnippet: "# Mint test case\ntarget=awscli\nfunction=awscli_bucket_list",
      detail: "preview",
      matchedFields: ["test name", "error message", "source"],
      score: 91,
    },
  );
});

test("opens the search cases file and reports each loading phase", async () => {
  const client = fakeClient({ count: 42 });
  const progress = [];
  const cacheModes = [];

  const session = await createCaseSearchSession({
    index: { runs: fixtureRuns },
    searchCasesUrl,
    createClient: async (cache) => {
      cacheModes.push(cache);
      return client;
    },
    onProgress: (event) => progress.push(event),
  });

  assert.equal(session.rowCount, 42);
  assert.deepEqual(cacheModes, ["default"]);
  assert.deepEqual(client.calls, [
    { registerParquet: ["search_cases", searchCasesUrl] },
    { sql: "SELECT COUNT(*) AS row_count FROM search_cases" },
  ]);
  assert.deepEqual(
    progress.map((event) => event.phase),
    ["loading-engine", "opening-index", "ready"],
  );
  assert.deepEqual(await session.search("   "), []);
  assert.equal(client.calls.length, 2);
});

test("reopens the index without the HTTP cache when it is republished mid-session", async () => {
  let failures = 1;
  const staleClient = fakeClient({
    onQuery(sql) {
      if (!/COUNT/.test(sql) && failures-- > 0) {
        throw new Error(`Precondition failure: ${STALE_SEARCH_INDEX_MESSAGE}`);
      }
    },
  });
  const freshClient = fakeClient({
    count: 5,
    rows: [{ content_id: 1, suite_key: "s3_tests", test_name: "test_new", run_id: latestRun.run_id }],
  });
  const cacheModes = [];
  const session = await createCaseSearchSession({
    index: { runs: fixtureRuns },
    searchCasesUrl,
    createClient: async (cache) => {
      cacheModes.push(cache);
      return cache === "reload" ? freshClient : staleClient;
    },
  });

  const results = await session.search("new");

  assert.deepEqual(cacheModes, ["default", "reload"]);
  assert.deepEqual(results.map((result) => result.testName), ["test_new"]);
  assert.equal(session.rowCount, 5);
});

test("DataFusion finds cases by split and joined words across suites", async () => {
  const session = await openFixtureSession();

  assert.equal(session.rowCount, 8);

  const joined = await session.search("accessdenied");
  const split = await session.search("Access Denied");
  assert.deepEqual(
    joined.map((result) => [result.testName, result.runId, result.isLatestRun]),
    [["test_bucket_policy_access_denied", latestRun.run_id, true]],
  );
  assert.deepEqual(split.map((result) => result.id), joined.map((result) => result.id));
  assert.deepEqual(joined[0].matchedFields, ["test name", "error message", "source"]);
  assert.deepEqual(joined[0].features, ["policy"]);

  const camelCase = await session.search("bucket", "mint");
  assert.deepEqual(
    camelCase.map((result) => result.testName).sort(),
    ["awscli_bucket_list", "setBucketPolicy(bucketName, bucketPolicy, cb)"],
  );

  assert.deepEqual(await session.search("nothingmatchesthis"), []);
});

test("DataFusion returns one row per failure, newest run first", async () => {
  const session = await openFixtureSession();

  const results = await session.search("checksum", "s3_tests");

  assert.deepEqual(
    results.map((result) => [result.message, result.runId]),
    [
      ["ChecksumSHA256 missing", latestRun.run_id],
      ["Checksum mismatch in trailer", oldestRun.run_id],
    ],
  );
});

test("DataFusion matches short numbers as whole words", async () => {
  const session = await openFixtureSession();

  const results = await session.search("12");

  assert.deepEqual(results.map((result) => result.testName), ["test_list_objects_max_keys_12"]);
});

test("DataFusion narrows results to the run named in the query", async () => {
  const session = await openFixtureSession();

  const results = await session.search("2026-05-16 checksum");

  assert.deepEqual(
    results.map((result) => [result.message, result.runId, result.isLatestRun]),
    [["ChecksumSHA256 missing", middleRun.run_id, false]],
  );
  assert.ok(results[0].matchedFields.includes("run"));
});

test("DataFusion reads the search file through ranged requests", async () => {
  const requests = [];
  const session = await openFixtureSession(requests);

  await session.search("policy");

  assert.ok(requests.length >= 1);
  assert.ok(requests.every((request) => request.url === searchCasesUrl && /^bytes=/.test(request.range)));
  assert.ok(session.stats().bytesFetched <= fixtureParquet.length);
});

test("hydrates a Parquet search result with full case detail on demand", async () => {
  const result = {
    id: "search:1",
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
        "SELECT * FROM read_parquet(__PARQUET_FILE__) WHERE case_id = 's3_tests:test_bucket_policy_access_denied' " +
        "ORDER BY name = 'test_bucket_policy_access_denied' DESC LIMIT 1",
    },
  ]);
  assert.equal(hydrated.detail, "full traceback from cases parquet");
  assert.equal(hydrated.message, "AccessDenied full message");
  assert.deepEqual(hydrated.features, ["policy", "iam"]);
  assert.equal(hydrated.sourceRepo, "https://github.com/ceph/s3-tests.git");
  assert.equal(hydrated.sourceRef, "abc123456789");
});
