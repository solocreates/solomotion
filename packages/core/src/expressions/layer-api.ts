import { clipAnimatableProperties } from "../animation/clip-properties";
import type { AnimatablePropertyDef } from "../animation/properties";
import type { Asset, Clip } from "../schema";
import type { ExprType, ExprValue } from "./types";

/**
 * WHAT A LAYER IS, said once.
 *
 * The node board builds a layer's sockets from `clipAnimatableProperties`. The
 * expression language used to answer the same question from a hand-written list
 * of eight facts in `globals.ts` — so `#layer.` suggested `index` and `width`
 * while the Layer node beside it offered rotation, every fill, every effect
 * field and every gradient stop. Two descriptions of one thing, and only one of
 * them grew when the document did.
 *
 * There is one now. `#layer.rotation`, `#layer.fill.<id>.color`,
 * `#layer.lfx.<id>.blur` and `layer("Title").rotation` all resolve against THIS,
 * which is the same projection a socket comes from — so anything you can wire,
 * you can write, on the day it ships and with no entry in any table here.
 */

export interface ExprLayerProperty {
  /** The keyframe/driver path — `rotation`, `fill.<id>.color`, `lfx.<id>.blur`. */
  path: string;
  /** What the inspector and the socket both call it. */
  label: string;
  /** Grouping label, for a menu ("Transform", "Fill", the effect's own name). */
  group: string;
  type: ExprType;
}

/** Every value a layer exposes, as the expression language sees it. */
export function exprLayerProperties(clip: Clip): ExprLayerProperty[] {
  return clipAnimatableProperties(clip).map((p) => ({
    path: p.path,
    label: p.def.label,
    group: p.group,
    type: exprTypeForProperty(p.def),
  }));
}

/**
 * The expression type of an animatable property. The registry's `kind` is about
 * INTERPOLATION (how a value moves between keys), not about storage, so
 * `discrete` covers a font weight (a number), an italic flag (a boolean) and a
 * font family (text). Its identity value is what says which — the one fact the
 * registry already carries that distinguishes them.
 */
export function exprTypeForProperty(def: AnimatablePropertyDef): ExprType {
  if (def.kind === "color") return "color";
  if (def.kind === "number") return "float";
  if (typeof def.identity === "boolean") return "bool";
  return typeof def.identity === "string" ? "string" : "float";
}

/**
 * THE LAYER API a host injects — "which layer is that?", "what does it have?"
 * and "what is it right now?". Deliberately three small questions rather than
 * one big one, because the checker and the editor's suggestions need the middle
 * one without ever evaluating anything.
 *
 * Keyed by clip ID, with a separate name lookup, because a person writing a
 * sentence names a layer the way the timeline labels it while everything
 * underneath addresses it by id.
 */
export interface ExprLayerApi {
  /** The id of the layer with this name in the current comp, if there is one. */
  idFor: (name: string) => string | undefined;
  /** How the timeline labels a layer — for messages and suggestions. */
  nameOf: (clipId: string) => string | undefined;
  /** Every path this layer exposes. The SAME list its node sockets come from. */
  propertiesOf: (clipId: string) => ExprLayerProperty[];
  /** One path's value at the current time. Undefined = this layer has no such
   *  value, which reads as "unavailable" rather than as zero. */
  read: (clipId: string, path: string) => ExprValue | undefined;
  /** Every layer in the current comp, for suggestions. */
  all: () => Array<{ id: string; name: string }>;
  /** Where a media layer (audio, video) is in its asset now (+ `offsetMs`),
   *  through THE source-time map (`clipSourceTimeAt`: trim, speed and ramps,
   *  loop, reverse) — undefined while it is not sounding (outside its span,
   *  past a play-once end, frozen). Core's `mediaLayerApi` builds it once;
   *  `lipsync()`, `speaking()`, `loudness()` read through it. `asset` is the
   *  record it plays (its lip-sync engine choice and hand fixes ride on it). */
  sourceOf?: (clipId: string, offsetMs?: number) => { assetId: string; sourceMs: number; asset?: Asset } | undefined;
  /** How a layer acts a mouth: its derived kind (drawings · morph · bones —
   *  the lip-sync feel profile) and, for a switch, its member names top first
   *  (what a viseme resolves against). Core's `mediaLayerApi` builds it. */
  mouth?: (clipId: string) => { kind: "drawings" | "morph" | "bones"; choices?: string[] } | undefined;
}

/** Index a property list by path — what the checker and the editor look through. */
export function layerPropertyIndex(props: ExprLayerProperty[]): Map<string, ExprLayerProperty> {
  return new Map(props.map((p) => [p.path, p]));
}
