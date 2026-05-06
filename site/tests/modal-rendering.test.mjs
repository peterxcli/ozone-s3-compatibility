import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(siteRoot, "src", "App.vue"), "utf8");
const stylesSource = readFileSync(path.join(siteRoot, "src", "styles.css"), "utf8");

test("modal avoids compositor-heavy backdrop blur while scrolling", () => {
  const backdropRule = stylesSource.match(/\.case-modal-backdrop\s*\{[^}]+\}/s)?.[0] || "";

  assert.doesNotMatch(backdropRule, /backdrop-filter/);
  assert.match(backdropRule, /overflow-y:\s*auto/);
  assert.match(backdropRule, /overscroll-behavior:\s*none/);
});

test("page scroll is locked while the modal is open", () => {
  assert.match(appSource, /function lockPageScroll\(\): void/);
  assert.match(appSource, /function unlockPageScroll\(\): void/);
  assert.match(appSource, /document\.body\.classList\.add\("modal-open"\)/);
  assert.match(appSource, /document\.body\.classList\.remove\("modal-open"\)/);
  assert.match(stylesSource, /body\.modal-open/);
});

test("modal traps wheel and touch overscroll at scroll boundaries", () => {
  assert.match(appSource, /function handleModalBackdropWheel\(event: WheelEvent\): void/);
  assert.match(appSource, /function handleModalBackdropTouchStart\(event: TouchEvent\): void/);
  assert.match(appSource, /function handleModalBackdropTouchMove\(event: TouchEvent\): void/);
  assert.match(appSource, /@wheel="handleModalBackdropWheel"/);
  assert.match(appSource, /@touchstart="handleModalBackdropTouchStart"/);
  assert.match(appSource, /@touchmove="handleModalBackdropTouchMove"/);
});
