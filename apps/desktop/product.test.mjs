/**
 * The desktop manifest repeats three facts the web identity owns, because the
 * build cannot import identity.ts (some products' pull in their theme). They must
 * agree: the renderer only follows `<ns>://` links, and the shell must open
 * the origin whose storage the user's projects live in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const PRODUCTS = new URL("../../products/", import.meta.url);
const field = (src, key) => src.match(new RegExp(`\\b${key}:\\s*"([^"]+)"`))?.[1];

for (const id of readdirSync(PRODUCTS).filter((d) => existsSync(new URL(`${d}/desktop/product.json`, PRODUCTS)))) {
  test(`${id}: desktop manifest agrees with web identity`, () => {
    const p = JSON.parse(readFileSync(new URL(`${id}/desktop/product.json`, PRODUCTS), "utf8"));
    const identity = readFileSync(new URL(`${id}/web/identity.ts`, PRODUCTS), "utf8");
    assert.equal(p.scheme, field(identity, "ns"), "scheme must be identity.ns");
    assert.equal(p.productName, field(identity, "name"), "productName must be identity.name");
    assert.equal(p.remoteUrl, `${field(identity, "webOrigin")}/`, "remoteUrl must be identity.webOrigin");
    assert.ok(existsSync(new URL(`${id}/desktop/icon.png`, PRODUCTS)), "icon.png (1024², opaque) is required");
  });
}
