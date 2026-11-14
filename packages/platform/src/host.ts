/**
 * WHO THE HOST IS, as far as the platform layer needs to know: what the app
 * calls its local stores, the global its desktop shell injects, and the build
 * it is. The app passes it once to `createPlatform`; nothing here is global.
 */
export interface HostIdentity {
  /** The app's data namespace; local stores are named `<ns>-…`. */
  ns: string;
  /** The `window` global the desktop shell's preload sets (`__<NS>_DESKTOP__`). */
  desktopGlobal: string;
  /** This build's version. */
  version: string;
}

/** The desktop shell's bridge object, when the app runs inside it. */
export function desktopBridge<T>(host: HostIdentity): T | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, T | undefined>)[host.desktopGlobal];
}
