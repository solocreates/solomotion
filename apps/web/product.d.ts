/**
 * The editor compiles against the Product CONTRACT, never a product: the build
 * aliases `#product` to `products/<PRODUCT>/web` and `#product/identity` to
 * its leaf identity module (next.config.ts), and each product typechecks
 * itself against the same contract (`products/<id>`).
 */
declare module "#product" {
  export const product: import("./src/editor/product-types").Product;
}
declare module "#product/assets" {
  export const assets: import("./src/editor/product-types").BrandAssets;
}
declare module "#product/identity" {
  export const identity: import("./src/editor/product-types").ProductIdentity;
}
