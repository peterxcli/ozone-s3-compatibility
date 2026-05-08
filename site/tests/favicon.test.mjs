import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("site declares and ships a root favicon", async () => {
  const indexHtml = await readFile(path.join(siteRoot, "index.html"), "utf8");

  assert.match(
    indexHtml,
    /<link\s+rel="icon"\s+href="\.\/favicon\.ico"\s+type="image\/x-icon"\s+\/>/,
  );

  const favicon = await readFile(path.join(siteRoot, "public", "favicon.ico"));
  assert.equal(favicon.readUInt16LE(0), 0, "ICO reserved field should be zero");
  assert.equal(favicon.readUInt16LE(2), 1, "ICO type should be icon");
  assert.ok(favicon.length > 100, "favicon should contain image data");
});
