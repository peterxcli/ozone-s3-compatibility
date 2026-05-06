import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(siteRoot, "src", "App.vue"), "utf8");

test("search result details open in a dismissible modal with highlighted code", () => {
  assert.match(appSource, /selectedSearchResult/);
  assert.match(appSource, /openSearchResultModal\(result\)/);
  assert.match(appSource, /class="case-modal-backdrop"/);
  assert.match(appSource, /@click\.self="closeSearchResultModal"/);
  assert.match(appSource, /class="case-modal-close"/);
  assert.match(appSource, /v-html="highlightedSearchSnippet"/);
});
