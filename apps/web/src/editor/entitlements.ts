import { product } from "./product";
import type { FeatureId } from "./product-types";

export type { FeatureId } from "./product-types";

/**
 * THE seam between an action and what this person may do — for every caller:
 * hooks, handlers, the agent runner, the MCP link. The product answers
 * (`Product.entitlements`); the editor never knows about plans or prices.
 */
export function requireFeature(feature?: FeatureId, source?: string): boolean {
  return product.entitlements.require(feature, source);
}

export interface FeatureGate {
  /** True when this person does NOT have it. */
  locked: boolean;
  /** True when they do. */
  pro: boolean;
  /** Guard an action; false = the product showed the way to yes. */
  allow: () => boolean;
  /** Show the way to yes, regardless of state. */
  promptUpgrade: () => void;
}

/** The React form: `const gate = useFeatureGate("export.video"); if (!gate.allow()) return;` */
export function useFeatureGate(feature?: FeatureId): FeatureGate {
  const has = product.entitlements.useHas(feature);
  return {
    locked: !has,
    pro: has,
    allow: () => product.entitlements.require(feature),
    promptUpgrade: () => product.entitlements.prompt(feature),
  };
}
