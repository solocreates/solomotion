import type { ProductIdentity } from "./product-types";
import { identity as built } from "#product/identity";

/**
 * WHO this build is — the product's names and looks, from its leaf module
 * (`#product/identity`, next.config.ts). Read this, not `product`, from
 * anything that runs while the app loads: the product's behaviour imports
 * the editor, so it may still be loading when such a module evaluates.
 */
export const identity: ProductIdentity = built;
