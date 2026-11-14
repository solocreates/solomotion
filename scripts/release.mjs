#!/usr/bin/env node
/**
 * The release steps .github/workflows/release.yml runs. No dependencies.
 *
 *   node scripts/release.mjs plan              tag ↔ version check; what to build (→ $GITHUB_OUTPUT)
 *   node scripts/release.mjs notes             this version's CHANGELOG section, for the GitHub Release
 *   node scripts/release.mjs publish [--dry-run]
 *                                              every public @solomotion/* package to npm
 *
 * The version lives in the root package.json. Every workspace package carries
 * the same one, so a tag names exactly one version of everything.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const version = readJson("package.json").version;
const prerelease = version.includes("-");

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

/** Every workspace package, in dependency order (a package after the ones it needs). */
function workspacePackages() {
  const listed = JSON.parse(
    execFileSync("pnpm", ["-r", "ls", "--depth", "-1", "--json"], { cwd: ROOT, encoding: "utf8" }),
  );
  const pkgs = listed
    .filter((p) => p.path !== ROOT)
    .map((p) => ({ dir: p.path, manifest: JSON.parse(fs.readFileSync(path.join(p.path, "package.json"), "utf8")) }));
  const byName = new Map(pkgs.map((p) => [p.manifest.name, p]));
  const ordered = [];
  const seen = new Set();
  const visit = (p) => {
    if (seen.has(p.manifest.name)) return;
    seen.add(p.manifest.name);
    const m = p.manifest;
    for (const dep of Object.keys({ ...m.dependencies, ...m.peerDependencies, ...m.optionalDependencies })) {
      const d = byName.get(dep);
      if (d) visit(d);
    }
    ordered.push(p);
  };
  pkgs.forEach(visit);
  return ordered;
}

/** The bare `solomotion` CLI and the @solomotion scope; everything else stays in the repo. */
const publishable = (p) =>
  !p.manifest.private && (p.manifest.name === "solomotion" || p.manifest.name.startsWith("@solomotion/"));

function plan() {
  const tag = process.env.GITHUB_REF_NAME;
  if (tag && tag !== `v${version}`) {
    fail(`tag ${tag} does not match package.json version ${version}; tag v${version} instead`);
  }
  const packages = exists("packages") && workspacePackagesSafe().some(publishable);
  const out = {
    version,
    prerelease: String(prerelease),
    web: String(exists("apps/web/package.json")),
    desktop: String(exists("apps/desktop/package.json")),
    packages: String(packages),
  };
  const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n");
  console.log(lines);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines + "\n");
}

/** `plan` runs before `pnpm install`, so read manifests without pnpm. */
function workspacePackagesSafe() {
  const dirs = [];
  for (const parent of ["packages", "apps"]) {
    if (!exists(parent)) continue;
    for (const name of fs.readdirSync(path.join(ROOT, parent))) {
      const rel = `${parent}/${name}/package.json`;
      if (exists(rel)) dirs.push({ dir: path.join(ROOT, parent, name), manifest: readJson(rel) });
    }
  }
  return dirs;
}

function changelogSection() {
  const text = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## \\[?${version.replace(/\./g, "\\.")}\\]?(\\s|$)`).test(l));
  if (start < 0) fail(`CHANGELOG.md has no "## ${version}" section`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

function notes() {
  const parts = [changelogSection()];
  if (exists("apps/desktop/package.json")) {
    const product = readJson("apps/desktop/package.json").build?.productName ?? "SoloMotion";
    parts.push(
      [
        "### Desktop builds are not signed yet",
        "",
        "The installers below are not code-signed or notarized, so your system will warn you the first time you open them. Each file's checksum is in `SHA256SUMS.txt`, and its build provenance can be checked with `gh attestation verify <file> --repo novincode/solomotion`.",
        "",
        `- **macOS:** open the disk image and drag ${product} to Applications. If macOS says the app is damaged or cannot be checked, run \`xattr -dr com.apple.quarantine "/Applications/${product}.app"\` once.`,
        "- **Windows:** if SmartScreen stops the installer, choose More info, then Run anyway.",
        "- **Linux:** make the AppImage executable (`chmod +x`), or install the `.deb`.",
      ].join("\n"),
    );
  }
  process.stdout.write(parts.join("\n\n") + "\n");
}

function publish(dryRun) {
  const npmTag = prerelease ? "next" : "latest";
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "solomotion-pack-"));
  const pkgs = workspacePackages().filter(publishable);
  if (!pkgs.length) return console.log("No public packages to publish.");
  for (const { dir, manifest } of pkgs) {
    const id = `${manifest.name}@${manifest.version}`;
    if (manifest.version !== version) fail(`${id} does not carry the release version ${version}`);
    const seen = spawnSync("npm", ["view", id, "version"], { encoding: "utf8" });
    if (seen.status === 0 && seen.stdout.trim() === manifest.version) {
      console.log(`${id} is already on npm, skipping.`);
      continue;
    }
    // pnpm pack turns workspace:* ranges into the real versions.
    const before = new Set(fs.readdirSync(out));
    execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: dir, stdio: "inherit" });
    const tarball = fs.readdirSync(out).find((f) => !before.has(f) && f.endsWith(".tgz"));
    if (!tarball) fail(`pnpm pack produced no tarball for ${id}`);
    // Provenance needs the CI's OIDC identity, so a local dry run leaves it out.
    const args = ["publish", path.join(out, tarball), "--access", "public", "--tag", npmTag];
    args.push(dryRun ? "--dry-run" : "--provenance");
    execFileSync("npm", args, { stdio: "inherit" });
    console.log(`${dryRun ? "Would publish" : "Published"} ${id} under "${npmTag}".`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "plan") plan();
else if (command === "notes") notes();
else if (command === "publish") publish(rest.includes("--dry-run"));
else fail("usage: release.mjs plan | notes | publish [--dry-run]");
