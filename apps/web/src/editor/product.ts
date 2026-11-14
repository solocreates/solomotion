import type { Product } from "./product-types";
import { product as built } from "#product";

export type { Product } from "./product-types";

/**
 * THE PRODUCT this build is — the only door to identity (see `Product`).
 * `#product` is resolved at BUILD time to `products/<PRODUCT>/web`
 * (`next.config.ts`), so a bundle holds one product and never the other, and
 * nothing outside this file may import a product module.
 */
export const product: Product = built;
