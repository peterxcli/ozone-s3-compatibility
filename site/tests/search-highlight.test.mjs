import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "ozone-s3-compatibility-highlight-test-"));
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
    "src/lib/searchHighlight.ts",
  ],
  { cwd: siteRoot, stdio: "inherit" }
);
writeFileSync(path.join(outDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
symlinkSync(path.join(siteRoot, "node_modules"), path.join(outDir, "node_modules"), "junction");

const { highlightSearchMatch } = require(path.join(outDir, "searchHighlight.js"));

test("highlights query tokens while escaping result text", () => {
  assert.equal(
    highlightSearchMatch('ClientError: <AccessDenied> & "policy"', "accessdenied policy"),
    'ClientError: &lt;<mark class="search-match">AccessDenied</mark>&gt; &amp; &quot;<mark class="search-match">policy</mark>&quot;'
  );
});

test("highlights adjacent camel-case token matches as one mark", () => {
  assert.equal(
    highlightSearchMatch("ClientError: AccessDenied for bucket policy", "access denied"),
    'ClientError: <mark class="search-match">AccessDenied</mark> for bucket policy'
  );
});

test("returns escaped text without marks for an empty query", () => {
  assert.equal(highlightSearchMatch("<no query>", " "), "&lt;no query&gt;");
});
