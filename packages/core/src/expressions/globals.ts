import type { LengthUnit } from "../schema/units";
import type { MachineOutput } from "../schema/machines";
import type { ExprLayerApi } from "./layer-api";
import type { ExprType, ExprValue } from "./types";

/**
 * THE GLOBALS CATALOGUE — one table, four consumers.
 *
 * Autocomplete, the docs page, the checker's environment and the node board's
 * input list all read THIS. If a name, a type or a sentence of prose about
 * `#time` needs to exist in two places, the second place is a bug.
 *
 * Globals read as VARIABLES, not as function calls, because that is what they
 * are: named values the document already knows. `#time` is not something you
 * ask for, it is something that is true right now — so it wears the same `#`
 * sigil as a variable you made yourself, and the language has exactly one idea
 * of "a value with a name" instead of two that look different for no reason.
 */

/** The host facts a `#global` reads. Small, flat and PURE — the host resolves
 *  its own document/playhead/selection once, and the language never touches
 *  either. Anything the host cannot answer is `null`, and the reads that depend
 *  on it report themselves unavailable rather than inventing a zero. */
export interface ExprContext {
  /** COMPOSITION time in milliseconds — the playhead mapped into this comp.
   *  Deliberately not clip-local: `#layer.time` derives that from `layer.startMs`,
   *  so one clock feeds both and they cannot disagree. */
  timeMs: number;
  /** The composition's frame rate (rates are per-frame — see fps.ts). */
  fps: number;
  comp: ExprComp | null;
  /**
   * THE FIELD'S OWN VALUE — its keys, or what was typed in — before the
   * expression on it runs: what `#value` reads (After Effects' `value`). A
   * thunk, so a field that never says `#value` never samples its keys. Absent
   * when the expression drives no field (a variable, a board node).
   */
  fieldValue?: () => ExprValue | undefined;
  /** The layer this expression drives, when it is attached to one. */
  layer: ExprLayer | null;
  /**
   * RELATIONAL LENGTHS — comp px per `unit` for field `path` of layer `id`, in
   * the render this bake is for (`units/resolve.ts`). What `spx()`, `fw()`,
   * `vw()`… call. Absent = every unit reads as px.
   */
  lengths?: (id: string, unit: LengthUnit, path: string) => number;
  /** The field path this expression drives (`stroke.<id>.width`), when it drives one. */
  fieldPath?: string;
  playing: boolean;
  /**
   * THE LAYER API — what a layer has and what it is, for this layer and every
   * other one. The same projection the node board builds its sockets from, so
   * `#layer.rotation` and a Layer node's Rotation socket are one question asked
   * two ways. Absent = layer reads report themselves unavailable.
   */
  layers?: ExprLayerApi;
  /**
   * THE TRACKER API — what the footage knows, read through core's one tracking
   * reader (`tracking/read.ts`) in this comp at this instant. Absent = every
   * `track()` read is unavailable and gives the reading's identity.
   */
  tracks?: ExprTrackApi;
  /**
   * A stable number derived from WHERE this expression lives (its slot), never
   * from the clock. It is what makes `random()` and `wiggle()` pure: the same
   * field gets the same wobble every frame and on every machine, while two
   * fields running the same expression still differ.
   */
  seed: number;
  /** The comp this expression is evaluated in (the frame id the bake is for). */
  compId?: string | null;
  /** The instance chain this comp is being rendered through — null when the
   *  comp is drawn as itself (editing a master reads input DEFAULTS). Inputs,
   *  triggers and machines run on `scope.outerLocalMs`; content runs on
   *  `timeMs`. See ADR-characters, "Inputs". */
  scope?: ExprInstanceScope | null;
  /**
   * The layer API of ANOTHER comp at its own instant — how a `layer` input
   * resolves in the comp the instance sits in (`resolveScopedLayer`). Host-built;
   * absent = only the current comp's layers are reachable.
   */
  layersIn?: (compId: string, timeMs: number) => ExprLayerApi | undefined;
  /**
   * Read an input of `compId` by id or name, in `scope` (host-built over
   * `readInput` in `components/inputs.ts`, which needs the document for names
   * and defaults). Absent = `input()` reads `scope.values` by id only.
   */
  readInput?: (idOrName: string) => ExprValue | undefined;
  /**
   * Read a STATE MACHINE of `compId` in `scope` at this instant (host-built over
   * `readMachineState` in `machines/inputs.ts`). Absent = `state()` reads "".
   */
  readMachine?: (machine: string, layer?: string) => { stateName: string; timeInStateMs: number; output?: MachineOutput } | null;
}

/** What expressions can ask about trackers (host-built: `makeTrackApi`). */
export interface ExprTrackApi {
  /** The tracker with this name (or id), if there is one. */
  idFor: (name: string) => string | undefined;
  nameOf: (id: string) => string | undefined;
  /** What this tracker can be read for, with each reading's type — its readings table. */
  readingsOf: (id: string) => Array<{ id: string; type: "float" | "vec2" | "bool"; describe?: string }>;
  /** One reading now, in this comp's space. Undefined = nothing can be said here. */
  read: (id: string, reading: string) => ExprValue | undefined;
  all: () => Array<{ id: string; name: string }>;
}

/** One hop of the instance chain a comp is rendered through. */
export interface ExprInstanceScope {
  /** The nested/instance clip doing the rendering. */
  instanceClipId: string;
  /** That clip's LOCAL time in its own (outer) comp — the input/machine clock. */
  outerLocalMs: number;
  /** The instance's input values at that instant, by input id. */
  values: Record<string, ExprValue>;
  /** Derived: "" when every input is at its default, so equal instances share
   *  bakes and pictures. Part of every cache key a scoped render touches. */
  key: string;
  /** The scope the instance clip itself was rendered through. */
  parent: ExprInstanceScope | null;
}

export interface ExprComp {
  width: number;
  height: number;
  durationMs: number;
}

export interface ExprLayer {
  /** Which clip this is. `#layer` IS this id — the same handle a Layer wire
   *  carries — which is what lets `#layer.rotation` and `layer("X").rotation`
   *  be the same mechanism rather than two that look alike. */
  id: string;
  /** How the timeline labels it. */
  name: string;
  /** Stacking position — 0 is the topmost layer in the composition. */
  index: number;
  startMs: number;
  durationMs: number;
  width: number;
  height: number;
  /** 0..1. */
  opacity: number;
}

export type GlobalCategory = "time" | "layer" | "comp" | "playback" | "random";

export const GLOBAL_CATEGORY_META: Record<GlobalCategory, { label: string; describe: string }> = {
  time: { label: "Time", describe: "Where the playhead is." },
  layer: { label: "Layer", describe: "The layer this expression is attached to." },
  comp: { label: "Composition", describe: "The frame the layer lives in." },
  playback: { label: "Playback", describe: "What the editor is doing right now." },
  random: { label: "Randomness", describe: "The seed behind random() and wiggle()." },
};

export interface GlobalDef {
  /** Dotted name WITHOUT the `#` sigil — `time`, `layer.index`. */
  name: string;
  category: GlobalCategory;
  type: ExprType;
  /** One sentence, written for the docs page and reused verbatim in the editor. */
  describe: string;
  /** A convenience computed from the others. Documented as such so nobody has to
   *  wonder whether it is a second stored fact that can drift. */
  derived?: string;
  /** Typed as the FIELD the expression drives (`#value`), `type` when it drives none. */
  fieldTyped?: boolean;
  /** Undefined = "the host cannot answer this here" (e.g. no layer in scope). */
  read: (ctx: ExprContext) => ExprValue | undefined;
}

const seconds = (ms: number) => ms / 1000;

export const GLOBALS: GlobalDef[] = [
  // ── Time ───────────────────────────────────────────────────────────────────
  {
    name: "time",
    category: "time",
    type: "float",
    describe: "Seconds since the start of the composition — the playhead.",
    read: (c) => seconds(c.timeMs),
  },
  {
    name: "frame",
    category: "time",
    type: "float",
    describe: "The frame number under the playhead, counted at the composition’s own rate.",
    read: (c) => Math.round(seconds(c.timeMs) * c.fps),
  },
  {
    name: "fps",
    category: "time",
    type: "float",
    describe: "Frames per second of the composition this layer lives in.",
    read: (c) => c.fps,
  },
  {
    name: "progress",
    category: "time",
    type: "float",
    describe: "How far through the composition the playhead is: 0 at the start, 1 at the end.",
    derived: "#time / #comp.duration",
    read: (c) => (c.comp && c.comp.durationMs > 0 ? c.timeMs / c.comp.durationMs : 0),
  },

  // ── Layer ──────────────────────────────────────────────────────────────────
  {
    name: "value",
    category: "layer",
    type: "float",
    fieldTyped: true,
    describe:
      "This field’s own value — its keys, or what you typed in — before this expression. Build on it instead of replacing it: #value + wiggle(2, 5), or if(blink(4) > 0, \"Closed\", #value) so a blink rides on whatever pose you pick.",
    read: (c) => c.fieldValue?.(),
  },
  {
    name: "layer",
    category: "layer",
    type: "layer",
    describe:
      "The layer this expression is attached to. Read any of its values off it — #layer.rotation, #layer.opacity, #layer.fill.<id>.color — the same list its node card shows.",
    read: (c) => c.layer?.id,
  },
  {
    name: "layer.time",
    category: "layer",
    type: "float",
    describe: "Seconds since this layer started — 0 on its first frame, however late it begins.",
    derived: "#time − #layer.start",
    read: (c) => (c.layer ? seconds(c.timeMs - c.layer.startMs) : undefined),
  },
  {
    name: "layer.progress",
    category: "layer",
    type: "float",
    describe: "How far through this layer’s own duration the playhead is, 0 to 1.",
    derived: "#layer.time / #layer.duration",
    read: (c) => (c.layer && c.layer.durationMs > 0 ? (c.timeMs - c.layer.startMs) / c.layer.durationMs : undefined),
  },
  {
    name: "layer.duration",
    category: "layer",
    type: "float",
    describe: "How long this layer lasts, in seconds.",
    read: (c) => (c.layer ? seconds(c.layer.durationMs) : undefined),
  },
  {
    name: "layer.start",
    category: "layer",
    type: "float",
    describe: "When this layer begins, in composition seconds.",
    read: (c) => (c.layer ? seconds(c.layer.startMs) : undefined),
  },
  {
    name: "layer.end",
    category: "layer",
    type: "float",
    describe: "When this layer ends, in composition seconds.",
    derived: "#layer.start + #layer.duration",
    read: (c) => (c.layer ? seconds(c.layer.startMs + c.layer.durationMs) : undefined),
  },
  {
    name: "layer.index",
    category: "layer",
    type: "float",
    describe: "This layer’s stacking position — 0 is the topmost layer in the composition.",
    read: (c) => c.layer?.index,
  },
  {
    name: "layer.width",
    category: "layer",
    type: "float",
    describe: "The layer’s own width in pixels, before scaling.",
    read: (c) => c.layer?.width,
  },
  {
    name: "layer.height",
    category: "layer",
    type: "float",
    describe: "The layer’s own height in pixels, before scaling.",
    read: (c) => c.layer?.height,
  },
  {
    name: "layer.opacity",
    category: "layer",
    type: "float",
    describe: "The layer’s opacity, 0 to 1.",
    read: (c) => c.layer?.opacity,
  },

  // ── Composition ────────────────────────────────────────────────────────────
  {
    name: "comp.width",
    category: "comp",
    type: "float",
    describe: "The composition’s width in pixels.",
    read: (c) => c.comp?.width,
  },
  {
    name: "comp.height",
    category: "comp",
    type: "float",
    describe: "The composition’s height in pixels.",
    read: (c) => c.comp?.height,
  },
  {
    name: "comp.duration",
    category: "comp",
    type: "float",
    describe: "How long the composition runs, in seconds.",
    read: (c) => (c.comp ? seconds(c.comp.durationMs) : undefined),
  },
  {
    name: "comp.frames",
    category: "comp",
    type: "float",
    describe: "How many frames the composition holds at its own rate.",
    derived: "#comp.duration × #fps",
    read: (c) => (c.comp ? Math.round(seconds(c.comp.durationMs) * c.fps) : undefined),
  },

  // ── Playback ───────────────────────────────────────────────────────────────
  {
    name: "playing",
    category: "playback",
    type: "bool",
    describe: "True while the timeline is playing, false while you scrub or sit still.",
    read: (c) => c.playing,
  },

  // ── Randomness ─────────────────────────────────────────────────────────────
  {
    name: "seed",
    category: "random",
    type: "float",
    describe:
      "This field’s own seed. It never changes as time moves, so random() and wiggle() stay identical on every replay — and two fields with the same expression still differ.",
    read: (c) => c.seed,
  },
];

/** Lookup by dotted name (without `#`). */
export const GLOBALS_BY_NAME: Map<string, GlobalDef> = new Map(GLOBALS.map((g) => [g.name, g]));

/** Which globals need a layer / a composition to answer — drives the checker's
 *  "not available here" warning and the editor's greyed-out suggestions. */
export function globalRequires(def: GlobalDef): "layer" | "comp" | null {
  if (def.category === "layer") return "layer";
  if (def.category === "comp" || def.name === "progress") return "comp";
  return null;
}

/** Globals grouped for a menu or a docs page, in the order both should show them. */
export const GLOBAL_CATEGORY_ORDER: GlobalCategory[] = ["time", "layer", "comp", "playback", "random"];

export function globalsByCategory(): Array<{ category: GlobalCategory; globals: GlobalDef[] }> {
  return GLOBAL_CATEGORY_ORDER.map((category) => ({
    category,
    globals: GLOBALS.filter((g) => g.category === category),
  }));
}
