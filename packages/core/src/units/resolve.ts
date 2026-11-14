import { Immer } from "immer";
import type { MotionDocument, Clip } from "../schema";
import type { LengthSpec, LengthUnit } from "../schema/units";
import { channelValueAt } from "../animation/channels";
import { getClipProperty, setClipProperty } from "../animation/paths";
import { clipLocalTime } from "../animation/evaluate";
import { groupChainMatrix } from "../timeline/group-space";
import { clipAncestorGroups } from "../timeline/groups";
import { bakeClipValues } from "../nodes/resolve-clip";
import { clipByIdIn } from "../timeline/frame-index";
import type { Mat2D } from "../navigation/matrix";
import { isScreenUnit, lengthAxisOf, pxPerUnit, type LengthAxis, type LengthFrame, type LengthView, type ScreenScale, type Size } from "./length";

/**
 * THE UNITS STAGE OF THE BAKE — every field written in a relational unit
 * becomes comp px, once, here.
 *
 * It is a bake stage and not a paint-time conversion on purpose: the bake is
 * where a token becomes a value (`evaluate/resolved-doc.ts`), and everything
 * downstream — the painters, bounds, hit rects, the auto layout that runs
 * right after, motion blur, the exporters — reads the clip's own slots. A unit
 * converted at paint time would be right on the canvas and wrong in every one
 * of those, which is the second-opinion bug this codebase keeps paying for.
 *
 * ANY numeric path takes a unit: the conversion is `getClipProperty` /
 * `setClipProperty` by path (through `bakeClipValues`, the driver bake's own
 * writer), so a field added next year needs nothing here.
 *
 * Order (see `bake`): after drivers, poses and trackers — a driver's result is
 * in the field's unit, and a driven scale is the scale a screen unit divides
 * by — and before relations, so an auto layout lays out px.
 */

/** Does any clip in the document carry a unit? (Memoised; the common document pays one walk per edit.) */
export function documentHasUnits(doc: MotionDocument): boolean {
  const known = hasUnits.get(doc);
  if (known !== undefined) return known;
  let any = false;
  outer: for (const t of doc.tracks) for (const c of t.clips) if (c.units && hasEntry(c.units)) { any = true; break outer; }
  hasUnits.set(doc, any);
  return any;
}
const hasUnits = new WeakMap<MotionDocument, boolean>();

/** Does an expression call a length function (`spx(2)`, `fw(50)`)? Its value then depends on the view too. */
export function documentReadsLengths(doc: MotionDocument): boolean {
  const known = readsLengths.get(doc);
  if (known !== undefined) return known;
  const any = doc.expressions.some((e) => LENGTH_CALL.test(e.source));
  readsLengths.set(doc, any);
  return any;
}
const readsLengths = new WeakMap<MotionDocument, boolean>();
const LENGTH_CALL = /\b(spx|fw|fh|vw|vh|vmin|vmax|pw)\s*\(/;

/** Does the comp hold a SCREEN unit — so its picture depends on how it is seen? */
export function compHasScreenUnits(doc: MotionDocument, compId: string): boolean {
  if (documentReadsLengths(doc)) return true;
  let byComp = screenComps.get(doc);
  if (!byComp) {
    byComp = new Set();
    for (const t of doc.tracks) for (const c of t.clips) if (c.units && Object.values(c.units).some((u) => u && specIsScreen(u))) byComp.add(c.frameId);
    screenComps.set(doc, byComp);
  }
  return byComp.has(compId);
}
const screenComps = new WeakMap<MotionDocument, Set<string>>();

/** Does a spec change anything? Plain px with no bounds is no spec at all. */
export function specActive(spec: LengthSpec | undefined): spec is LengthSpec {
  return !!spec && (spec.unit !== "px" || !!spec.min || !!spec.max);
}
function specIsScreen(spec: LengthSpec): boolean {
  return isScreenUnit(spec.unit) || (!!spec.min && isScreenUnit(spec.min.unit)) || (!!spec.max && isScreenUnit(spec.max.unit));
}
function hasEntry(units: Record<string, LengthSpec | undefined>): boolean {
  for (const k in units) if (specActive(units[k])) return true;
  return false;
}

/** A matrix's per-axis and area scale. */
function scaleOf(m: Mat2D): ScreenScale {
  return { x: Math.hypot(m.a, m.b), y: Math.hypot(m.c, m.d), d: Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) };
}
const times = (a: ScreenScale, k: number, ky = k): ScreenScale => ({ x: a.x * Math.abs(k), y: a.y * Math.abs(ky), d: a.d * Math.sqrt(Math.abs(k * ky)) });

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * A LAYER'S LENGTH FRAME in one render: its comp, its parent box, the output,
 * and the scale from its own px (and its parent's) to the output's.
 * `doc` is the document as resolved so far (driven scales are written).
 */
export function lengthFrameOf(doc: MotionDocument, clip: Clip, timeMs: number, view: LengthView | null): LengthFrame {
  const comp = doc.frames.find((f) => f.id === clip.frameId);
  const compSize: Size = comp ? { width: comp.width, height: comp.height } : { width: view?.width ?? 1920, height: view?.height ?? 1080 };
  const output: Size = view ? { width: view.width, height: view.height } : compSize;
  const k = view?.scale ?? 1;
  const chain = scaleOf(groupChainMatrix(doc, clip.id, (g) => clipLocalTime(g, timeMs) ?? 0));
  const parentScreen = times(chain, k, view?.scaleY ?? k);
  let screen = parentScreen;
  if ("transform" in clip && clip.transform) {
    const local = timeMs - clip.startMs;
    const sx = num(channelValueAt(clip, "scale", local), clip.transform.scale);
    const sy = num(channelValueAt(clip, "scaleY", local), sx);
    screen = times(parentScreen, sx, sy);
  }
  return { comp: compSize, parent: parentBox(doc, clip) ?? compSize, output, screen, parentScreen };
}

/** The `%` base: the nearest enclosing auto-layout box with a declared size. */
function parentBox(doc: MotionDocument, clip: Clip): Size | null {
  for (const g of clipAncestorGroups(doc, clip.id)) {
    const w = g.layout?.width;
    const h = g.layout?.height;
    if (w || h) {
      const comp = doc.frames.find((f) => f.id === clip.frameId);
      return { width: w ?? comp?.width ?? 0, height: h ?? comp?.height ?? 0 };
    }
  }
  return null;
}

/**
 * A FIELD'S VALUE IN COMP PX, BOUNDS APPLIED — the value in its unit, then
 * held between `min` and `max` (each in its own unit, through the same frame).
 * CSS `clamp()`: a min above the max wins, as it does there.
 */
export function specToPx(value: number, spec: LengthSpec, clip: Clip, path: string, frame: LengthFrame): number {
  const axis = lengthAxisOf(clip, path);
  let px = lengthToPx(value, spec.unit, clip, path, frame, axis);
  if (spec.max) px = Math.min(px, lengthToPx(spec.max.value, spec.max.unit, clip, path, frame, axis));
  if (spec.min) px = Math.max(px, lengthToPx(spec.min.value, spec.min.unit, clip, path, frame, axis));
  return px;
}

/** One field's value in comp px. */
export function lengthToPx(value: number, unit: LengthUnit, clip: Clip, path: string, frame: LengthFrame, axis: LengthAxis = lengthAxisOf(clip, path)): number {
  return value * pxPerUnit(unit, axis, frame, path);
}

/** The reverse — what a px value reads as in `unit` (the inspector's unit switch keeps the size). */
export function pxToLength(px: number, unit: LengthUnit, clip: Clip, path: string, frame: LengthFrame): number {
  const k = pxPerUnit(unit, lengthAxisOf(clip, path), frame, path);
  return k ? px / k : px;
}

/**
 * Bake every unit in one comp (or the whole document) at one instant, seen
 * through `view`. Untouched clips keep their identity.
 */
export function resolveDocumentUnits(doc: MotionDocument, timeMs: number, compId: string | null, view: LengthView | null): MotionDocument {
  if (!documentHasUnits(doc)) return doc;
  let changedAny = false;
  const tracks = doc.tracks.map((track) => {
    let changed = false;
    const clips = track.clips.map((clip) => {
      if ((compId && clip.frameId !== compId) || !clip.units || !hasEntry(clip.units)) return clip;
      const frame = lengthFrameOf(doc, clip, timeMs, view);
      const local = timeMs - clip.startMs;
      const writes: Array<[string, number]> = [];
      for (const [path, spec] of Object.entries(clip.units)) {
        if (!specActive(spec)) continue;
        const v = channelValueAt(clip, path, local);
        if (typeof v !== "number") continue;
        writes.push([path, specToPx(v, spec, clip, path, frame)]);
      }
      const next = bakeClipValues(clip, writes);
      if (next !== clip) changed = true;
      return next;
    });
    if (!changed) return track;
    changedAny = true;
    return { ...track, clips };
  });
  return changedAny ? { ...doc, tracks } : doc;
}

/**
 * px per `unit` for field `path` of layer `id` — what the expression functions
 * (`spx(2)`, `fw(50)`) call. Frames are built on first ask per layer.
 */
export function lengthReader(doc: MotionDocument, timeMs: number, view: LengthView | null): (id: string, unit: LengthUnit, path: string) => number {
  const frames = new Map<string, { clip: Clip; frame: LengthFrame } | null>();
  return (id, unit, path) => {
    let hit = frames.get(id);
    if (hit === undefined) {
      let clip: Clip | undefined;
      for (const t of doc.tracks) {
        clip = t.clips.find((c) => c.id === id);
        if (clip) break;
      }
      hit = clip ? { clip, frame: lengthFrameOf(doc, clip, timeMs, view) } : null;
      frames.set(id, hit);
    }
    return hit ? pxPerUnit(unit, lengthAxisOf(hit.clip, path), hit.frame, path) : 1;
  };
}

/**
 * WRITE A FIELD IN ANOTHER UNIT, KEEPING ITS SIZE — the base value and every
 * key re-expressed through px at their own instants, then the spec recorded
 * (its bounds replaced when `bounds` is given, kept otherwise). What the
 * inspector's unit switch and the API's `layer.set {width: "50fw"}` both do;
 * one function, so a keyed width switched in the panel and by an agent come
 * out the same. Seen with the comp as its own output (the only view an edit
 * knows): exact for the root comp; inside a magnified nest, give the screen
 * values themselves. Mutates (call inside a write). Without a document the
 * numbers are kept as they are.
 */
export function setFieldUnit(
  doc: MotionDocument | null,
  clip: Clip,
  path: string,
  unit: LengthUnit,
  bounds?: Pick<LengthSpec, "min" | "max">,
): void {
  const was = clip.units?.[path];
  const from = was?.unit ?? "px";
  if (doc && from !== unit) {
    const recast = (v: number, compMs: number) => {
      const frame = lengthFrameOf(doc, clip, compMs, null);
      return pxToLength(lengthToPx(v, from, clip, path, frame), unit, clip, path, frame);
    };
    const base = getClipProperty(clip, path);
    if (typeof base === "number") setClipProperty(clip, path, recast(base, clip.startMs));
    for (const track of clip.keyframes) {
      if (track.property !== path) continue;
      for (const k of track.keys) if (typeof k.value === "number") k.value = recast(k.value, clip.startMs + k.timeMs);
    }
  }
  const min = bounds ? bounds.min : was?.min;
  const max = bounds ? bounds.max : was?.max;
  const spec: LengthSpec = { unit, ...(min ? { min } : {}), ...(max ? { max } : {}) };
  if (!specActive(spec)) {
    if (clip.units) {
      delete clip.units[path];
      if (Object.keys(clip.units).length === 0) delete clip.units;
    }
  } else {
    clip.units = { ...(clip.units ?? {}), [path]: spec };
  }
}

/**
 * WHAT WAS WRITTEN, OVER WHAT IS SEEN — a bake with every unit field put back
 * to its authored number and keys (`40` in fw, not the 432 px it bakes to).
 * The surfaces that EDIT values (the inspector, a node row) read this; the
 * stage reads the bake, since its handles live in px. Without it a field
 * showed 432, and typing into it wrote 432 fw. Clips without units keep their
 * identity.
 */
const authoredWriter = new Immer({ autoFreeze: false });

export function withAuthoredLengths(baked: MotionDocument, raw: MotionDocument): MotionDocument {
  if (baked === raw || !documentHasUnits(raw)) return baked;
  let changedAny = false;
  const tracks = baked.tracks.map((track) => {
    let changed = false;
    const clips = track.clips.map((clip) => {
      if (!clip.units || !hasEntry(clip.units)) return clip;
      const source = clipByIdIn(raw, clip.id);
      if (!source || source === clip) return clip;
      const paths = Object.keys(clip.units).filter((p) => specActive(clip.units![p]));
      // Copy-on-write: the setter walks into paints and effects the bake shares.
      const out = authoredWriter.produce(clip, (draft) => {
        draft.keyframes = [...draft.keyframes.filter((t) => !paths.includes(t.property)), ...source.keyframes.filter((t) => paths.includes(t.property))];
        for (const p of paths) {
          const v = getClipProperty(source, p);
          if (typeof v === "number") setClipProperty(draft, p, v);
        }
      });
      changed = true;
      return out;
    });
    if (!changed) return track;
    changedAny = true;
    return { ...track, clips };
  });
  return changedAny ? { ...baked, tracks } : baked;
}
