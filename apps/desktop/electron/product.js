const fs = require("node:fs");
const path = require("node:path");

/**
 * The product this shell is: { name, scheme, remoteUrl, releasesRepo }.
 * Packaged, electron-builder.cjs stamped it into package.json. Unpackaged
 * (`pnpm dev:desktop`), it is read from the product PRODUCT names, which the
 * dev script resolves with the web build's own rule.
 */
function loadProduct() {
  const stamped = require("../package.json").product;
  if (stamped) return stamped;
  const id = process.env.PRODUCT;
  if (!id) throw new Error("PRODUCT is not set: run `pnpm dev:desktop`, or set PRODUCT to a folder in products/.");
  const file = path.join(__dirname, "..", "..", "..", "products", id, "desktop", "product.json");
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  return { name: p.productName, scheme: p.scheme, remoteUrl: p.remoteUrl, releasesRepo: `${p.releases.owner}/${p.releases.repo}` };
}

module.exports = { product: loadProduct() };
