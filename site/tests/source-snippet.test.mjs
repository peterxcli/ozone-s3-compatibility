import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(os.tmpdir(), "ozone-s3-compatibility-source-snippet-test-"));
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
    "src/lib/sourceSnippet.ts",
  ],
  { cwd: siteRoot, stdio: "inherit" }
);

const { extractPythonSnippet, highlightCode } = require(path.join(outDir, "sourceSnippet.js"));

test("extracts a Python test function with decorators and line numbers", () => {
  const source = [
    "import pytest",
    "",
    "@pytest.mark.s3",
    "def test_bucket_policy_access_denied(conn):",
    "    bucket = get_new_bucket()",
    "    assert bucket.name",
    "",
    "def test_other(conn):",
    "    pass",
  ].join("\n");

  const snippet = extractPythonSnippet(source, "test_bucket_policy_access_denied");

  assert.equal(snippet.startLine, 3);
  assert.match(snippet.text, /@pytest\.mark\.s3/);
  assert.match(snippet.text, /def test_bucket_policy_access_denied/);
  assert.doesNotMatch(snippet.text, /def test_other/);
});

test("escapes HTML before applying syntax highlighting", () => {
  const highlighted = highlightCode("def test_case():\n    return '<tag>'", "python");

  assert.match(highlighted, /<span class="syntax-keyword">def<\/span>/);
  assert.match(highlighted, /&lt;tag&gt;/);
  assert.doesNotMatch(highlighted, /<tag>/);
});
