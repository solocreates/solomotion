/**
 * Build and deploy (or preview) the editor as THIS product's Worker. Each
 * product owns its Cloudflare config (`products/<id>/deploy/wrangler.jsonc`):
 * its name, its route. So a deploy can only ever go where its product says.
 *
 *   node scripts/deploy.mjs deploy | preview
 */
import { spawnSync } from "node:child_process";
import { productPath, resolveProduct } from "./product.mjs";

const verb = process.argv[2];
if (verb !== "deploy" && verb !== "preview") throw new Error("usage: deploy.mjs deploy|preview");
const product = resolveProduct();
const config = productPath(product, "deploy/wrangler.jsonc");
const env = { ...process.env, PRODUCT: product };
for (const args of [["build", "-c", config], [verb, "-c", config]]) {
  const r = spawnSync("pnpm", ["exec", "opennextjs-cloudflare", ...args], { stdio: "inherit", env, shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
