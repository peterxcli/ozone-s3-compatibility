import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "ozone-s3-compatibility-report-format-test-"));
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
    "--rootDir",
    "src/lib",
    "--outDir",
    outDir,
    "src/lib/parquetReport.ts",
    "src/lib/report.ts",
  ],
  { cwd: siteRoot, stdio: "inherit" },
);
writeFileSync(path.join(outDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
symlinkSync(path.join(siteRoot, "node_modules"), path.join(outDir, "node_modules"), "junction");

const { chartLabel, formatDate } = require(path.join(outDir, "report.js"));

test("formats invalid report dates as fallback text without throwing", () => {
  assert.equal(formatDate(""), "Unknown date");
  assert.equal(formatDate("not-a-date"), "not-a-date");
  assert.equal(chartLabel("not-a-date"), "not-a-date");
});
