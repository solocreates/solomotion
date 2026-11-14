import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * "No component branches on a theme id." A component that asks which look is
 * on (`theme.id === "paper"`) breaks the contract that a theme is data anyone
 * can write: a user's theme would never get that branch. Components read CSS
 * variables and root dialects; only the registry and the store know ids.
 *
 * Scans the hosts that exist in this checkout (the public repo may have fewer).
 */
const ROOT = path.resolve(__dirname, "../../..");
const HOSTS = ["apps/web/src", "apps/solomotion-site/src"].map((p) => path.join(ROOT, p)).filter((p) => fs.existsSync(p));
// The theme store, and the product seam (a PRODUCT id is identity, not a look).
const ALLOWED = [/editor\/theme\//, /editor\/settings\/pages\.tsx$/, /editor\/products?(\/|\.ts$)/];
const BRANCH = [
  /\b(theme\.(id|presetId)|themeId)\s*[!=]==?\s*["'`]/,
  // A look's name compared on anything that says it holds a theme.
  /\b(activeTheme|themeName|currentTheme|lookId)\s*[!=]==?\s*["']/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p, out);
    } else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("components never know a theme by name", () => {
  it.skipIf(HOSTS.length === 0)("finds no branch on a theme id outside the theme store", () => {
    const hits: string[] = [];
    for (const host of HOSTS)
      for (const file of walk(host)) {
        if (ALLOWED.some((r) => r.test(file))) continue;
        fs.readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (BRANCH.some((r) => r.test(line))) hits.push(`${path.relative(ROOT, file)}:${i + 1}`);
          });
      }
    expect(hits).toEqual([]);
  });
});
