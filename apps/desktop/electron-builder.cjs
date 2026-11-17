/**
 * The installer build, for whichever product this is. electron-builder finds
 * this file on its own, so `electron-builder` with no flags builds the product
 * that `PRODUCT` names, by the same rule as the web build
 * (apps/web/scripts/product.mjs): with one product it is the default, with
 * several an unset PRODUCT refuses rather than ship the wrong name.
 *
 * The shell names no product. Everything a user could see or keep (app id,
 * name, icon, link scheme, update feed, the origin it loads) comes from
 * products/<id>/desktop/product.json, and the part main.js needs at runtime is
 * stamped into the packaged package.json as `product`.
 */
const fs = require("node:fs");
const path = require("node:path");

module.exports = async () => {
  const { resolveProduct } = await import("../web/scripts/product.mjs");
  const id = resolveProduct();
  const dir = path.join(__dirname, "..", "..", "products", id, "desktop");
  const product = JSON.parse(fs.readFileSync(path.join(dir, "product.json"), "utf8"));
  const icon = (name) => path.join(dir, name);
  // A hand-tuned .icns wins on macOS; otherwise electron-builder makes one from the PNG.
  const macIcon = fs.existsSync(icon("icon.icns")) ? icon("icon.icns") : icon("icon.png");
  const web = path.join(__dirname, "..", "web", "out");
  // A missing snapshot shipped once without failing anything (the app still opened online).
  if (!fs.existsSync(path.join(web, "index.html"))) {
    throw new Error(`apps/web/out is missing: run \`PRODUCT=${id} pnpm --filter ./apps/web run build:static\` first.`);
  }

  return {
    appId: product.appId,
    productName: product.productName,
    executableName: product.productName,
    artifactName: "${productName}-${version}-${arch}.${ext}",
    extraMetadata: {
      description: product.description,
      author: product.author,
      homepage: product.homepage,
      product: {
        name: product.productName,
        scheme: product.scheme,
        remoteUrl: product.remoteUrl,
        releasesRepo: `${product.releases.owner}/${product.releases.repo}`,
      },
    },
    publish: [{ provider: "github", owner: product.releases.owner, repo: product.releases.repo }],
    directories: { output: "dist" },
    files: ["electron/**/*"],
    extraResources: [{ from: "../web/out", to: "web-out" }],
    mac: {
      icon: macIcon,
      target: [{ target: "dmg", arch: ["universal"] }],
      category: "public.app-category.graphics-design",
    },
    win: { icon: icon("icon.png"), target: ["nsis"] },
    linux: {
      icon: icon("icon.png"),
      target: ["AppImage", "deb"],
      maintainer: product.author,
      category: "Graphics",
    },
    protocols: [{ name: `${product.productName} link`, schemes: [product.scheme] }],
  };
};
