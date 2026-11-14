#!/usr/bin/env node
/**
 * Copy the skill and default design system beside the CLI before
 * `npm pack` / `npm publish`, so `npx @solomotion/mcp` serves them as resources
 * without the monorepo. The copy is build output (gitignored).
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "../skill");
const out = join(root, "skill");
if (!existsSync(src)) throw new Error("packages/skill not found — pack from the monorepo.");
rmSync(out, { recursive: true, force: true });
cpSync(join(src, "skills"), join(out, "skills"), { recursive: true });
cpSync(join(src, "design-systems"), join(out, "design-systems"), { recursive: true });
console.log("copied the skill into packages/mcp/skill");
