import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(siteRoot, "src", "App.vue"), "utf8");
const historyItemSource = readFileSync(path.join(siteRoot, "src", "components", "HistoryItem.vue"), "utf8");
const runDetailsSource = readFileSync(path.join(siteRoot, "src", "components", "RunDetails.vue"), "utf8");
const suiteCardSource = readFileSync(path.join(siteRoot, "src", "components", "SuiteCard.vue"), "utf8");
const reportSource = readFileSync(path.join(siteRoot, "src", "lib", "report.ts"), "utf8");
const envSource = readFileSync(path.join(siteRoot, "src", "env.d.ts"), "utf8");
const duckdbClientSource = readFileSync(path.join(siteRoot, "src", "lib", "duckdbParquetQueryClient.ts"), "utf8");

test("defers search and history detail Parquet files until user demand", () => {
  assert.doesNotMatch(appSource, /scheduleSearchSessionPreload\(\);/);
  assert.doesNotMatch(appSource, /void ensureComparisonRunLoadedForRunOrdinal\(0\);/);
  assert.doesNotMatch(appSource, /const latestPromise = loadLatestRun\(\);/);
  assert.match(appSource, /@click="loadLatestRun"/);
  assert.match(appSource, /async function handleHistoryToggle/);
  assert.match(appSource, /if \(open\) \{[\s\S]*ensureHistoryRunLoaded\(summary\)/);
});

test("shows search index load progress before a query is entered", () => {
  assert.match(appSource, /const searchIndexProgress = ref<SearchIndexLoadProgress \| null>\(null\)/);
  assert.match(appSource, /const searchIndexProgressText = computed<string>\(\(\) => \{/);
  assert.match(appSource, /v-if="searchIndexProgressVisible"/);
  assert.match(appSource, /role="progressbar"/);
  assert.match(appSource, /search-index-progress-fill/);
});

test("renders every archived run summary instead of batching history rows", () => {
  assert.match(appSource, /v-for="\(\s*summary,\s*runIndex\s*\) in archivedSummaries"/);
  assert.doesNotMatch(appSource, /visibleArchivedSummaries/);
  assert.doesNotMatch(appSource, /canLoadMoreHistory/);
  assert.doesNotMatch(appSource, /Load \{\{ Math\.min\(historyBatchSize/);
});

test("shows latest run catalog statistics before loading full run detail", () => {
  assert.match(appSource, /const latestSuiteSummaries = computed<SuiteSummaryEntry\[\]>/);
  assert.match(appSource, /class="suite-summary-strip latest-summary-strip"/);
  assert.match(appSource, /v-for="entry in latestSuiteSummaries"/);
  assert.match(appSource, /latest-summary-strip[\s\S]*<div class="run-details"/);
});

test("fetches report JSON without browser cache reuse", () => {
  assert.match(reportSource, /fetch\(path,\s*\{\s*cache:\s*"no-store"\s*\}\)/);
});

test("loads partitioned report index shards in parallel", () => {
  assert.match(reportSource, /function fetchIndex/);
  assert.match(reportSource, /Promise\.all/);
  assert.match(appSource, /const fetchOptions = await reportDataOptions\(\)/);
  assert.match(appSource, /fetchReportIndex\(reportIndexPath,\s*fetchOptions\)/);
});

test("can opt into the Parquet report data path", () => {
  assert.match(appSource, /isParquetReportEnabled/);
  assert.match(appSource, /VITE_REPORT_DATA_FORMAT/);
  assert.match(appSource, /VITE_REPORT_DATA_BASE_URL/);
  assert.match(appSource, /reportIndexPath/);
  assert.match(appSource, /import\("\.\/lib\/duckdbParquetQueryClient"\)/);
  assert.match(appSource, /createDuckDbParquetQueryClient/);
  assert.match(reportSource, /function fetchReportIndex/);
  assert.match(reportSource, /fetchParquetIndexPayload/);
  assert.match(appSource, /fetchParquetSearchIndexPayload/);
  assert.match(appSource, /hydrateParquetSearchResultDetail/);
});

test("can opt into DuckDB cached HTTP reads for Parquet data", () => {
  assert.match(envSource, /VITE_DUCKDB_CACHE_MODE/);
  assert.match(appSource, /new URLSearchParams\(window\.location\.search\)\.get\("cacheFs"\)/);
  assert.match(appSource, /VITE_DUCKDB_CACHE_MODE/);
  assert.match(appSource, /createDuckDbParquetQueryClient\(\{\s*cacheMode:\s*parquetCacheMode\s*\}\)/);
  assert.match(duckdbClientSource, /INSTALL cache_httpfs FROM community/);
  assert.match(duckdbClientSource, /SET cache_httpfs_type=\$\{sqlString\(this\.cacheMode\)\}/);
  assert.match(duckdbClientSource, /falling back to direct HTTP Parquet reads/);
});

test("shows feature movement rollups at run and suite levels", () => {
  assert.match(reportSource, /function summarizeFeatureComparisons/);
  assert.match(appSource, /featureMovement/);
  assert.match(appSource, /feature-rollup/);
  assert.match(historyItemSource, /featureMovementForSuite/);
  assert.match(historyItemSource, /feature-rollup/);
  assert.match(runDetailsSource, /runFeatureMovements/);
  assert.match(runDetailsSource, /run-feature-summary/);
  assert.match(suiteCardSource, /featureMovement/);
  assert.match(suiteCardSource, /feature-rollup/);
});

test("opens archived run suite details when a history run expands", () => {
  assert.match(historyItemSource, /<RunDetails[\s\S]*:default-suite-open="true"/);
});

test("applies initial section hash navigation without loading latest run detail", () => {
  assert.match(
    appSource,
    /if \(target && \(!searchStateApplied \|\| target !== SEARCH_SECTION_HASH\.slice\(1\)\)\) \{[\s\S]*await nextTick\(\);[\s\S]*await navigateToSection\(target, \{ expandArchived: true \}\);[\s\S]*\}/,
  );
  assert.doesNotMatch(appSource, /await latestPromise/);
});

test("defers stored case comparison until a feature detail is opened", () => {
  assert.match(reportSource, /function compareFeatureRateWithPrevious/);
  assert.match(suiteCardSource, /compareFeatureRateWithPrevious/);
  assert.match(suiteCardSource, /featureCaseComparisons/);
  assert.match(suiteCardSource, /handleFeatureToggle/);
  assert.doesNotMatch(suiteCardSource, /comparison:\s*compareFeatureWithPrevious/);
});
