#!/usr/bin/env node
/**
 * Builds dist/ for npm. The source imports siblings without an extension
 * (`./manifest`), which the editor's bundler and `moduleResolution: Bundler`
 * accept, but Node's ESM loader and `moduleResolution: NodeNext` do not. So
 * after tsc, every relative specifier in dist/ gets its `.js`, in the .js and
 * the .d.ts alike, and the package works in Node, in a bundler and in a
 * NodeNext type-check.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });

const SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g;
const withExt = (file, spec) => {
  if (/\.(m?js|json)$/.test(spec)) return spec;
  const base = join(dirname(file), spec);
  if (existsSync(base + ".js") || existsSync(base + ".d.ts")) return spec + ".js";
  if (existsSync(join(base, "index.js"))) return spec + "/index.js";
  throw new Error(`${file}: cannot resolve ${spec}`);
};
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
for (const file of walk(dist).filter((f) => /\.(js|d\.ts)$/.test(f))) {
  const text = readFileSync(file, "utf8");
  const next = text.replace(SPECIFIER, (_, kw, q, spec) => `${kw}${q}${withExt(file, spec)}${q}`);
  if (next !== text) writeFileSync(file, next);
}
