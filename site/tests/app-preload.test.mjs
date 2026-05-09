import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(siteRoot, "src", "App.vue"), "utf8");

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
