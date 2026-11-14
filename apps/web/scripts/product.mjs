/**
 * THE PRODUCT this build is (editor/product-types.ts). Every folder in
 * `products/` with a `web/index.tsx` is one; `PRODUCT` picks it. With ONE
 * product (the public repo) it is the default. With several, a build or a
 * deploy never guesses: a silent wrong pick would ship another product's
 * storage names to real users, so it refuses. A dev server falls back to the
 * first, and says so. next.config.ts and scripts/deploy.mjs both ask here.
 */
import { existsSync, readdirSync, statSync } from "node:fs";

const PRODUCTS_DIR = new URL("../../../products/", import.meta.url);

export function listProducts() {
  if (!existsSync(PRODUCTS_DIR)) return [];
  return readdirSync(PRODUCTS_DIR)
    .filter((d) => statSync(new URL(d, PRODUCTS_DIR)).isDirectory() && existsSync(new URL(`${d}/web/index.tsx`, PRODUCTS_DIR)))
    .sort();
}

/** @param {{ dev?: boolean }} [opts] */
export function resolveProduct(opts = {}) {
  const products = listProducts();
  const asked = process.env.PRODUCT;
  const product = asked ?? (products.length === 1 || opts.dev ? products[0] : undefined);
  if (opts.dev && !asked && products.length > 1) console.warn(`PRODUCT is not set; this dev server is ${product}.`);
  if (!product || !products.includes(product)) {
    throw new Error(`Set PRODUCT to one of: ${products.join(", ") || "(no products/ folder)"}${product ? ` (got "${product}")` : ""}.`);
  }
  return product;
}

/** A path inside the product's folder, from apps/web. */
export const productPath = (product, rel) => `../../products/${product}/${rel}`;
