/**
 * Runtime environment detection — the ONE place anything asks "where am I".
 *
 * App code never sniffs the environment itself; it calls the `platform` facade
 * (or reads these). The desktop shell (Electron) injects its bridge global
 * (`HostIdentity.desktopGlobal`) on `window` via its preload before any app
 * script runs, so this is reliable at module-eval time. A future host (React Native, another shell) is a new branch
 * here plus, if it needs native power, a new adapter — nothing else changes.
 */

import type { HostIdentity } from "./host";

export type PlatformKind = "web" | "desktop";
export type OsKind = "macos" | "windows" | "linux" | "unknown";

export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** True when running inside the Electron desktop shell (renderer). */
export function isDesktop(host: HostIdentity): boolean {
  return isBrowser() && host.desktopGlobal in window;
}

export function platformKind(host: HostIdentity): PlatformKind {
  return isDesktop(host) ? "desktop" : "web";
}

/** Best-effort OS, from UA hints. Only cosmetic (shortcuts, labels) — never gate features on it. */
export function osKind(): OsKind {
  if (!isBrowser()) return "unknown";
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return "macos";
  if (/Win/.test(ua)) return "windows";
  if (/Linux|Android/.test(ua)) return "linux";
  return "unknown";
}
