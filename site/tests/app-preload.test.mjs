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
