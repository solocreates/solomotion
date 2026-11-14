"use client";

import { create } from "zustand";
import {
  DEFAULT_RUNTIME_CONFIG,
  supervisor,
  taskKinds,
  type RuntimeConfig,
  type TaskLimit,
} from "@solomotion/core";

/**
 * The Safety settings, persisted. A thin shell around core's `RuntimeConfig`:
 * the store holds it, writes it to storage and pushes it into the supervisor,
 * and that is all it does. Every rule about what a budget MEANS lives in
 * `core/runtime/config.ts`, so the exporter and a test resolve limits exactly
 * the way the running editor does.
 */

const KEY = "tm-safety";

function load(): RuntimeConfig {
  if (typeof window === "undefined") return DEFAULT_RUNTIME_CONFIG;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_RUNTIME_CONFIG;
    const saved = JSON.parse(raw) as Partial<RuntimeConfig>;
    // Field-by-field over a spread: a stored blob from an older build must not
    // be able to introduce a key this version has no defaults for, and a
    // corrupted number must not become the app's deadline.
    return {
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULT_RUNTIME_CONFIG.enabled,
      defaultLimitMs: num(saved.defaultLimitMs, DEFAULT_RUNTIME_CONFIG.defaultLimitMs),
      sliceMs: num(saved.sliceMs, DEFAULT_RUNTIME_CONFIG.sliceMs),
      watchdog:
        typeof saved.watchdog === "boolean" ? saved.watchdog : DEFAULT_RUNTIME_CONFIG.watchdog,
      freezeMs: num(saved.freezeMs, DEFAULT_RUNTIME_CONFIG.freezeMs),
      limits: sanitizeLimits(saved.limits),
    };
  } catch {
    return DEFAULT_RUNTIME_CONFIG;
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Keep only overrides for kinds this build still has, in a shape it understands. */
function sanitizeLimits(raw: unknown): Record<string, TaskLimit> {
  if (!raw || typeof raw !== "object") return {};
  const known = new Set(taskKinds().map((k) => k.id));
  const out: Record<string, TaskLimit> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(id) || !v || typeof v !== "object") continue;
    const mode = (v as TaskLimit).mode;
    if (mode === "default" || mode === "unlimited") out[id] = { mode };
    else if (mode === "fixed") {
      const ms = (v as { ms?: unknown }).ms;
      if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) out[id] = { mode, ms };
    }
  }
  return out;
}

function save(config: RuntimeConfig) {
  supervisor.configure(config);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    // Storage unavailable (private mode, quota) — the session still applies.
  }
}

interface SafetyState {
  config: RuntimeConfig;
  set: (patch: Partial<RuntimeConfig>) => void;
  /** Set or clear one kind's override. `null` returns it to the kind's own rule. */
  setKindLimit: (kindId: string, limit: TaskLimit | null) => void;
  reset: () => void;
}

export const useSafety = create<SafetyState>((set, get) => {
  const initial = load();
  supervisor.configure(initial);
  return {
    config: initial,
    set: (patch) => {
      const config = { ...get().config, ...patch };
      save(config);
      set({ config });
    },
    setKindLimit: (kindId, limit) => {
      const limits = { ...get().config.limits };
      if (limit === null) delete limits[kindId];
      else limits[kindId] = limit;
      const config = { ...get().config, limits };
      save(config);
      set({ config });
    },
    reset: () => {
      save(DEFAULT_RUNTIME_CONFIG);
      set({ config: DEFAULT_RUNTIME_CONFIG });
    },
  };
});
