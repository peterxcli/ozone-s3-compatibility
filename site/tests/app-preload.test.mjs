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

test("preloads the persistent search session after the report shell is visible", () => {
  assert.match(appSource, /function scheduleSearchSessionPreload\(\): void \{/);
  assert.match(appSource, /scheduleSearchSessionPreload\(\);/);
  assert.match(appSource, /requestIdleCallback/);
  assert.match(appSource, /void ensureSearchSession\(\);/);
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

test("fetches report JSON without browser cache reuse", () => {
  assert.match(reportSource, /fetch\(path,\s*\{\s*cache:\s*"no-store"\s*\}\)/);
});

test("loads partitioned report index shards in parallel", () => {
  assert.match(reportSource, /function fetchIndex/);
  assert.match(reportSource, /Promise\.all/);
  assert.match(appSource, /fetchIndex\("\.\/data\/index\.json"\)/);
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

test("defers stored case comparison until a feature detail is opened", () => {
  assert.match(reportSource, /function compareFeatureRateWithPrevious/);
  assert.match(suiteCardSource, /compareFeatureRateWithPrevious/);
  assert.match(suiteCardSource, /featureCaseComparisons/);
  assert.match(suiteCardSource, /handleFeatureToggle/);
  assert.doesNotMatch(suiteCardSource, /comparison:\s*compareFeatureWithPrevious/);
});
