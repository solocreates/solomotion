import type { Clip, KeyframeValue, TraceSpec } from "../schema";
import type { AnimatablePropertyDef } from "../animation/properties";

/**
 * A TRACE'S LOOK AS PROPERTY PATHS — `trace.<field>`, the family the property
 * registry and `paths.ts` each delegate ONE call to. So the head's width, the
 * cooling time or the ghost spacing can be keyed (`keyframes_set`), driven by
 * an expression or a node, and listed by `layer_properties`, with no code of
 * their own anywhere. Each row names the spec field it reads and writes.
 */

interface TraceField {
  def: Omit<AnimatablePropertyDef, "key" | "group" | "compose" | "appliesTo">;
  get: (t: TraceSpec) => KeyframeValue | undefined;
  set: (t: TraceSpec, v: KeyframeValue) => void;
}

const num = (v: KeyframeValue): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function end(which: "head" | "tail", label: string): Record<string, TraceField> {
  return {
    [`${which}.color`]: {
      def: { label: `${label} colour`, kind: "color", identity: which === "head" ? "#FF5A2E" : "#EDE9E2" },
      get: (t) => t[which].color,
      set: (t, v) => {
        if (typeof v === "string") t[which].color = v;
      },
    },
    [`${which}.width`]: {
      def: { label: `${label} width`, kind: "number", identity: which === "head" ? 8 : 1, min: 0, max: 400, step: 0.5 },
      get: (t) => t[which].width,
      set: (t, v) => {
        const n = num(v);
        if (n !== undefined) t[which].width = clamp(n, 0, 400);
      },
    },
    [`${which}.opacity`]: {
      def: { label: `${label} opacity`, kind: "number", identity: 1, min: 0, max: 1, step: 0.01 },
      get: (t) => t[which].opacity,
      set: (t, v) => {
        const n = num(v);
        if (n !== undefined) t[which].opacity = clamp(n, 0, 1);
      },
    },
  };
}

const FIELDS: Record<string, TraceField> = {
  ...end("head", "Head"),
  ...end("tail", "Tail"),
  // Null (the whole history) has no number; keying it starts from what shows.
  lengthMs: {
    def: { label: "Length", kind: "number", identity: 0, min: 0, step: 10 },
    get: (t) => t.lengthMs ?? undefined,
    set: (t, v) => {
      const n = num(v);
      if (n !== undefined) t.lengthMs = Math.max(0, n);
    },
  },
  coolMs: {
    def: { label: "Cooling", kind: "number", identity: 1000, min: 1, step: 10 },
    get: (t) => t.coolMs ?? undefined,
    set: (t, v) => {
      const n = num(v);
      if (n !== undefined) t.coolMs = Math.max(1, n);
    },
  },
  falloff: {
    def: { label: "Falloff", kind: "number", identity: 1, min: 0.05, max: 20, step: 0.05 },
    get: (t) => t.falloff,
    set: (t, v) => {
      const n = num(v);
      if (n !== undefined) t.falloff = clamp(n, 0.05, 20);
    },
  },
  "point.x": {
    def: { label: "Point X", kind: "number", identity: 0, step: 1 },
    get: (t) => t.source.point.x,
    set: (t, v) => {
      const n = num(v);
      if (n !== undefined) t.source.point = { ...t.source.point, x: n };
    },
  },
  "point.y": {
    def: { label: "Point Y", kind: "number", identity: 0, step: 1 },
    get: (t) => t.source.point.y,
    set: (t, v) => {
      const n = num(v);
      if (n !== undefined) t.source.point = { ...t.source.point, y: n };
    },
  },
  "ghosts.everyMs": {
    def: { label: "Ghost every", kind: "number", identity: 100, min: 10, max: 60_000, step: 10 },
    get: (t) => t.ghosts.everyMs,
    set: (t, v) => {
      const n = num(v);
      if (n !== undefined) t.ghosts.everyMs = clamp(n, 10, 60_000);
    },
  },
  "ghosts.opacity": {
    def: { label: "Ghost opacity", kind: "number", identity: 0.5, min: 0, max: 1, step: 0.01 },
    get: (t) => t.ghosts.opacity,
    set: (t, v) => {
      const n = num(v);
      if (n !== undefined) t.ghosts.opacity = clamp(n, 0, 1);
    },
  },
  "ghosts.size": {
    def: { label: "Ghost size", kind: "number", identity: 12, min: 0.5, max: 400, step: 0.5 },
    get: (t) => t.ghosts.size,
    set: (t, v) => {
      const n = num(v);
      if (n !== undefined) t.ghosts.size = clamp(n, 0.5, 400);
    },
  },
};

export const TRACE_PATH = /^trace\.(.+)$/;

/** The registry rows for every `trace.<field>` path. */
export const TRACE_PROPERTY_DEFS: AnimatablePropertyDef[] = Object.entries(FIELDS).map(([field, f]) => ({
  ...f.def,
  key: `trace.${field}`,
  group: "trace",
  compose: "replace",
  appliesTo: ["trace"],
}));

export function isTracePath(clip: Clip, path: string): boolean {
  return clip.kind === "trace" && TRACE_PATH.test(path);
}

export function getTraceProperty(clip: Clip, path: string): KeyframeValue | undefined {
  if (clip.kind !== "trace") return undefined;
  const field = FIELDS[TRACE_PATH.exec(path)?.[1] ?? ""];
  return field?.get(clip.trace);
}

/** Write a `trace.<field>` base value (mutates — call inside an update). False = not a trace field. */
export function setTraceProperty(clip: Clip, path: string, value: KeyframeValue): boolean {
  if (clip.kind !== "trace") return false;
  const field = FIELDS[TRACE_PATH.exec(path)?.[1] ?? ""];
  if (!field) return false;
  field.set(clip.trace, value);
  return true;
}
