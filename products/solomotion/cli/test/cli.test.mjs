import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/solomotion.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });

test("prints its own version", () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(run("--version").stdout.trim(), version);
});

test("help names both commands", () => {
  const out = run("--help").stdout;
  assert.match(out, /npx solomotion mcp/);
  assert.match(out, /open the studio/);
});

test("an unknown command fails with the help", () => {
  const r = run("nope");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown command: nope/);
});
