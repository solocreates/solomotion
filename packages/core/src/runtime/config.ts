import { taskKind, type TaskKindDef, type TaskLimit } from "./kinds";

/**
 * THE SAFETY SETTINGS — the whole of what a person can change, as data.
 *
 * Headless: this is a plain object with a resolver beside it. The app persists
 * it, the Safety tab edits it, the supervisor reads it, and a test constructs
 * one inline. Nothing here knows what a checkbox is.
 *
 * `enabled: false` turns off LIMITS, not visibility. That distinction is the
 * design: someone switching this off is saying "stop interrupting my work",
 * not "stop telling me what the app is doing", and an Activity window that
 * goes blank the moment you most need it (while the tab is struggling) would
 * be exactly backwards.
 */
export interface RuntimeConfig {
  /** Master switch for time limits and automatic stopping. */
  enabled: boolean;
  /** The budget every kind that has no opinion of its own inherits, in ms. */
  defaultLimitMs: number;
  /** Per-kind overrides by kind id. Absent = the kind's own declaration. */
  limits: Record<string, TaskLimit>;
  /**
   * How long one slice of chunked work may hold the thread before yielding.
   * Under one 60fps frame, so the app keeps painting while it grinds.
   */
  sliceMs: number;
  /** Whether to notice and report that the app stopped responding. */
  watchdog: boolean;
  /** A gap longer than this in the heartbeat counts as a freeze, in ms. */
  freezeMs: number;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  enabled: true,
  defaultLimitMs: 30_000,
  limits: {},
  sliceMs: 12,
  watchdog: true,
  freezeMs: 3_000,
};

/**
 * The one place a budget is decided. Order of authority, most specific first:
 * what the person set for this kind, then what the kind declares about itself,
 * then the global default. Returns null for "no limit".
 */
export function resolveLimitMs(
  config: RuntimeConfig,
  kind: TaskKindDef | string | undefined,
): number | null {
  if (!config.enabled) return null;
  const def = typeof kind === "string" ? taskKind(kind) : kind;
  const limit = (def && config.limits[def.id]) ?? def?.limit ?? { mode: "default" as const };
  switch (limit.mode) {
    case "unlimited":
      return null;
    case "fixed":
      return limit.ms > 0 ? limit.ms : null;
    case "default":
      return config.defaultLimitMs > 0 ? config.defaultLimitMs : null;
  }
}

/** The effective limit as the SETTINGS row shows it, ignoring the master switch. */
export function effectiveLimit(config: RuntimeConfig, def: TaskKindDef): TaskLimit {
  return config.limits[def.id] ?? def.limit;
}
