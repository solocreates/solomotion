/**
 * Static-export build for the desktop shell (Electron loads it via app://).
 *
 * Route handlers (src/app/api/*) can't be statically exported, and the desktop
 * build doesn't need them. So we stash the api folder, run `next build` with
 * BUILD_TARGET=desktop (→ out/), and always restore it, even if the build fails.
 * Deterministic and self-healing; nothing tracked is left moved.
 */
import { access, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = path.join(webRoot, "src", "app", "api");
const stashDir = path.join(webRoot, ".api-stash");

const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );

const hadApi = await exists(apiDir);
let status = 0;
try {
  if (hadApi) await rename(apiDir, stashDir);
  const res = spawnSync("pnpm", ["exec", "next", "build"], {
    stdio: "inherit",
    cwd: webRoot,
    env: { ...process.env, BUILD_TARGET: "desktop" },
    // shell:true so Windows can launch `pnpm.cmd`; harmless elsewhere.
    shell: true,
  });
  status = res.status ?? 1;
} finally {
  // Restore BEFORE exiting — process.exit() would skip this block.
  if (hadApi && (await exists(stashDir))) await rename(stashDir, apiDir);
}
process.exit(status);
