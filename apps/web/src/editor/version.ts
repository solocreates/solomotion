/**
 * Build-time product version — single-sourced from the root package.json and
 * embedded by `next.config.ts` as NEXT_PUBLIC_APP_VERSION. This is what the
 * running editor build actually is, resolved with zero runtime cost. Release
 * METADATA (changelog, download links) is read separately + dynamically from
 * GitHub Releases by the marketing site (a product's releases reader); this constant is
 * just "which build am I".
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
