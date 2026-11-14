#!/usr/bin/env node
/**
 * Every tool the skill names must exist. The skill teaches craft and names
 * tools by their model-facing names (`layer_create`); a rename in the code
 * that the skill still teaches would send agents to a tool that is not
 * there. This reads the command ids straight from the sources that define
 * them (no second list to drift) and fails on any name the skill uses that no
 * command, and no runtime tool, answers to.
 *
 * Runs inside the the app monorepo; in a standalone copy of the skill there
 * is nothing to check against, so it says so and passes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const repo = join(root, "../..");
const sources = [join(repo, "packages/core/src/api"), join(repo, "apps/web/src/editor/agent/host-commands.ts"), join(repo, "apps/web/src/editor/agent/media-ai.ts"), join(repo, "apps/web/src/editor/world/import-command.ts")];
if (!sources.every(existsSync)) {
  console.log("check-tools: not inside the monorepo — skipped");
  process.exit(0);
}

const files = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => files(join(p, n))) : /\.ts$/.test(p) && !/\.test\.ts$/.test(p) ? [p] : []);
const tools = new Set(["skill_read", "report_issue", "agent_delegate"]);
for (const f of sources.flatMap(files)) {
  for (const m of readFileSync(f, "utf8").matchAll(/\bid:\s*"([a-z]+(?:\.[a-z_]+)+)"/g)) tools.add(m[1].replace(/\./g, "_"));
}

const AREAS = "doc|layers?|text|template|keyframes|animation|effects|catalog|api|timeline|frame|history|grade|expression|transition|view|session|media|audio|font|sounds|app|generate|voices|layout|skill|report|agent|world|mesh|flipbook|page|rig|switch|physics|track";
const named = new Map();
const skillFiles = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? skillFiles(join(d, n)) : n.endsWith(".md") ? [join(d, n)] : []));
for (const f of skillFiles(join(root, "skills"))) {
  for (const m of readFileSync(f, "utf8").matchAll(new RegExp(`\\b(?:${AREAS})_[a-z_]+\\b`, "g"))) {
    if (!named.has(m[0])) named.set(m[0], f.slice(root.length));
  }
}
const missing = [...named].filter(([t]) => !tools.has(t));
if (missing.length) {
  for (const [t, f] of missing) console.error(`✗ ${f} names "${t}", which no command defines`);
  process.exit(1);
}
console.log(`check-tools: all ${named.size} tools the skill names exist (${tools.size} defined)`);
