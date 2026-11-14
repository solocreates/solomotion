/**
 * The capability vocabulary — a plugin declares the capabilities it needs in its
 * manifest, and the host gates every bridge call against what was granted (see
 * `METHOD_CAPABILITY` in ./api). This is the whole trust model in one place: a
 * sandboxed plugin can do *only* what its capabilities allow, and nothing here
 * grants raw store access.
 *
 * Deliberately small and honest — we ship a capability ONLY when the host
 * actually enforces it. The vocabulary grows as the bridge grows; new keys are
 * purely additive (older plugins that never asked for them are unaffected).
 */
export const CAPABILITIES = {
  "document:read": "Read the document — its frames, layers and properties.",
  "document:write": "Create, edit and remove layers in the document.",
  "selection:read": "See and react to what the user has selected.",
  "ui:notify": "Show toast messages in the editor.",
} as const;

export type Capability = keyof typeof CAPABILITIES;

export const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[];

export function isCapability(value: string): value is Capability {
  return value in CAPABILITIES;
}

export function capabilityDescription(cap: Capability): string {
  return CAPABILITIES[cap];
}
