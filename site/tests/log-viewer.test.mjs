import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(siteRoot, "src", "App.vue"), "utf8");
const historyItemSource = readFileSync(path.join(siteRoot, "src", "components", "HistoryItem.vue"), "utf8");
const runDetailsSource = readFileSync(path.join(siteRoot, "src", "components", "RunDetails.vue"), "utf8");
const parquetReportSource = readFileSync(path.join(siteRoot, "src", "lib", "parquetReport.ts"), "utf8");

test("run details expose Parquet log files through a log viewer", () => {
  assert.match(runDetailsSource, /run\.log_files/);
  assert.match(runDetailsSource, /"open-log": \[logFile: LogFileRecord\]/);
  assert.match(historyItemSource, /"open-log": \[summary: RunSummary, logFile: LogFileRecord\]/);
  assert.match(appSource, /fetchParquetLogLines/);
  assert.match(appSource, /selectedLog/);
  assert.match(appSource, /selectedLogText/);
  assert.match(appSource, /class="case-modal log-modal"/);
  assert.match(parquetReportSource, /function fetchParquetLogLines/);
});
