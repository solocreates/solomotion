import { createPlatform, type Platform } from "@solomotion/platform";
import { NAMES } from "./names";
import { identity } from "./identity";

/**
 * THE platform — host capabilities (files, clipboard, fonts, the desktop
 * shell's bridges) for this build's product. Every caller imports this one
 * instance; `@solomotion/platform` itself holds no identity.
 */
export const platform: Platform = createPlatform({
  ns: identity.ns,
  desktopGlobal: NAMES.wire.desktopGlobal,
  // Single-sourced from the root package.json, baked in by next.config.
  version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
});
