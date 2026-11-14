import { sampleKeyframes } from "../animation/keyframes";
import { layerEffectTypeDef } from "../animation/layer-effects";
import { textEffectTypeDef } from "../animation/text-effects";
import { createId } from "../ids";
import { setStrokeScalar } from "../vector/stroke";
import type { StrokeStyle } from "../schema/vector";
import type { KeyframeTrack } from "../schema/animation";
import type { Clip } from "../schema/clips";
import { modifierDef } from "../world/modifiers";
import { BEHAVIOR } from "../behaviors/registry";
import { FORCE } from "../physics/forces";
import { EMITTER } from "../physics/emitters";
import { isBodyKind } from "../world/body";
import type { LayerEffect } from "../schema/layer-effects";

/**
 * Property transfer — the ONE headless brain behind "copy/paste properties".
 * A clip's copyable surface is a set of DOMAINS (transform, effects, fills,
 * sound…), each declared ONCE in the registry below: which clips it applies
 * to, which top-level fields it snapshots, which keyframe tracks it owns, and
 * (for instance lists like effects) its child items. Everything else — the
 * checkbox dialog, section context menus, per-effect copy, ⌘V paste — is a
 * thin caller of capture/apply, so a new copyable domain is one entry here.
 *
 * Capture semantics: with `includeKeyframes` the domain's tracks travel too;
 * without it, values are BAKED at the source clip's local time (you copy what
 * you see mid-animation). Apply replaces the domain's fields and tracks on
 * the target and re-issues instance ids (effects, paints, EQ bands) so pasted
 * lists never share ids with their source.
 */

export interface TransferContext {
  /** Source-clip local time (ms) used to bake values when keyframes stay behind. */
  localMs: number;
  includeKeyframes: boolean;
}

export interface TransferItem {
  id: string;
  label: string;
}

export interface DomainSnapshot {
  /** Top-level clip fields, deep-cloned. */
  values: Record<string, unknown>;
  /** Keyframe tracks the domain owns (empty when animations weren't included). */
  tracks: KeyframeTrack[];
  /** Effects only: append to the target stack instead of replacing it. */
  mode?: "replace" | "append";
}

export interface CapturedProperties {
  kind: "properties";
  sourceKind: Clip["kind"];
  domains: Record<string, DomainSnapshot>;
}

type Rec = Record<string, unknown>;

export interface PropertyDomainDef {
  id: string;
  label: string;
  appliesTo(clip: Clip): boolean;
  /** Top-level clip fields to snapshot (skipped when absent on the clip). */
  fields: string[];
  /** Which keyframe-track properties belong to this domain. */
  trackMatch(property: string): boolean;
  /** Track property → dotted values path, for baking sampled values. */
  bakeMap?: Record<string, string>;
  /** Instance-list fields to re-id on apply (tracks remapped alongside). */
  reissueLists?: Array<{ field: string; idPrefix: string }>;
  /** Child items for tri-state selection (e.g. one per effect card). */
  items?(clip: Clip): TransferItem[];
}

const visual = (clip: Clip) => clip.kind !== "audio";

/**
 * A domain FIELD may be nested (`style.textEffects`): the per-glyph stack
 * lives on the text style, not on the clip. These three are the whole dotted-
 * path vocabulary the transfer needs — no wildcards, no arrays in the path —
 * so a domain names its field exactly as the schema spells it.
 */
function hasField(obj: unknown, path: string): boolean {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object" || !(seg in (cur as Rec))) return false;
    cur = (cur as Rec)[seg];
  }
  return true;
}
function readField(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Rec)[seg];
  }
  return cur;
}
function writeField(obj: Rec, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Rec = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]!];
    if (!next || typeof next !== "object") return;
    cur = next as Rec;
  }
  cur[parts[parts.length - 1]!] = value;
}
const prefix = (...prefixes: string[]) => (p: string) => prefixes.some((x) => p.startsWith(x));
const exact = (...names: string[]) => (p: string) => names.includes(p);

export const PROPERTY_DOMAINS: PropertyDomainDef[] = [
  {
    id: "transform",
    label: "Transform",
    appliesTo: visual,
    fields: ["transform"],
    trackMatch: exact("x", "y", "scale", "scaleY", "rotation"),
    bakeMap: {
      x: "transform.x",
      y: "transform.y",
      scale: "transform.scale",
      scaleY: "transform.scaleY",
      rotation: "transform.rotation",
    },
  },
  {
    id: "layout",
    label: "Size & shape",
    appliesTo: (c) => c.kind === "shape",
    fields: [
      "width",
      "height",
      "cornerRadius",
      "radius",
      "pointCount",
      "innerRatio",
      "arcStartDeg",
      "arcSweepDeg",
      "arcRatio",
      "cornerOffsets",
    ],
    trackMatch: (p) =>
      exact("width", "height", "radius", "pointCount", "innerRatio", "arcStartDeg", "arcSweepDeg", "arcRatio")(p) ||
      p.startsWith("corner."),
    bakeMap: {
      width: "width",
      height: "height",
      radius: "radius",
      innerRatio: "innerRatio",
      arcStartDeg: "arcStartDeg",
      arcSweepDeg: "arcSweepDeg",
      arcRatio: "arcRatio",
    },
  },
  {
    id: "appearance",
    label: "Opacity & blend",
    appliesTo: visual,
    fields: ["opacity", "blendMode"],
    trackMatch: exact("opacity"),
    bakeMap: { opacity: "opacity" },
  },
  {
    id: "fills",
    label: "Fills",
    appliesTo: (c) => visual(c) && Array.isArray((c as Rec)["fills"]),
    fields: ["fills"],
    trackMatch: prefix("fill."),
    reissueLists: [{ field: "fills", idPrefix: "paint" }],
  },
  {
    id: "strokes",
    label: "Strokes",
    appliesTo: (c) => visual(c) && Array.isArray((c as Rec)["strokes"]),
    fields: ["strokes"],
    trackMatch: prefix("stroke."),
    reissueLists: [{ field: "strokes", idPrefix: "stroke" }],
  },
  {
    id: "text",
    label: "Text style",
    appliesTo: (c) => c.kind === "text",
    fields: ["style", "maxWidth", "direction"],
    trackMatch: prefix("style."),
    // The style carries the per-glyph stack; a paste must not share its ids.
    reissueLists: [{ field: "style.textEffects", idPrefix: "tfx" }],
  },
  {
    id: "textEffects",
    label: "Text effects",
    appliesTo: (c) => c.kind === "text",
    fields: ["style.textEffects"],
    trackMatch: prefix("tfx."),
    reissueLists: [{ field: "style.textEffects", idPrefix: "tfx" }],
    items: (clip) =>
      clip.kind !== "text"
        ? []
        : clip.style.textEffects.map((e) => ({ id: e.id, label: textEffectTypeDef(e.type)?.label ?? e.type })),
  },
  {
    id: "effects",
    label: "Effects",
    appliesTo: visual,
    fields: ["effects"],
    trackMatch: prefix("lfx."),
    reissueLists: [{ field: "effects", idPrefix: "lfx" }],
    items: (clip) =>
      clip.kind === "audio"
        ? []
        : clip.effects.map((e) => ({
            id: e.id,
            label: layerEffectTypeDef(e.type)?.label ?? e.type,
          })),
  },
  {
    id: "modifiers",
    label: "Modifiers",
    appliesTo: (c) => c.kind === "mesh" || isBodyKind(c.kind),
    fields: ["modifiers"],
    trackMatch: prefix("mdf."),
    reissueLists: [{ field: "modifiers", idPrefix: "mdf" }],
    items: (clip) => (clip.kind === "audio" ? [] : (clip.modifiers ?? []).map((m) => ({ id: m.id, label: modifierDef(m.type)?.label ?? m.type }))),
  },
  {
    id: "forces",
    label: "Forces",
    appliesTo: visual,
    fields: ["forces"],
    trackMatch: prefix("force."),
    reissueLists: [{ field: "forces", idPrefix: "force" }],
    items: (clip) => (clip.kind === "audio" ? [] : (clip.forces ?? []).map((f) => ({ id: f.id, label: FORCE.def(f.type)?.label ?? f.type }))),
  },
  {
    id: "emitters",
    label: "Particles",
    appliesTo: visual,
    fields: ["emitters"],
    trackMatch: prefix("emit."),
    reissueLists: [{ field: "emitters", idPrefix: "emit" }],
    items: (clip) => (clip.kind === "audio" ? [] : (clip.emitters ?? []).map((e) => ({ id: e.id, label: EMITTER.def(e.type)?.label ?? e.type }))),
  },
  {
    // A character's life: paste Pip's blink, breath and voice onto another character.
    id: "behaviors",
    label: "Behaviors",
    appliesTo: (c) => c.kind === "group",
    fields: ["behaviors"],
    trackMatch: prefix("bhv."),
    reissueLists: [{ field: "behaviors", idPrefix: "bhv" }],
    items: (clip) => (clip.kind === "group" ? (clip.behaviors ?? []).map((b) => ({ id: b.id, label: BEHAVIOR.def(b.type)?.label ?? b.type })) : []),
  },
  {
    id: "animate",
    label: "In/out animations",
    appliesTo: visual,
    fields: ["animIn", "animOut"],
    trackMatch: () => false,
  },
  {
    id: "sound",
    label: "Sound",
    appliesTo: (c) => "audioMix" in c,
    fields: [
      "audioMix",
      "gain",
      "volume",
      "fadeIn",
      "fadeOut",
      "eq",
      "role",
      "keepPitch",
      "pitchSemitones",
    ],
    trackMatch: (p) => exact("gain", "volume", "audioMix.volume")(p) || p.startsWith("eq."),
    bakeMap: { gain: "gain", volume: "volume", "audioMix.volume": "audioMix.volume" },
    reissueLists: [{ field: "eq", idPrefix: "eq" }],
  },
  {
    id: "playback",
    label: "Speed & loop",
    appliesTo: (c) => "playback" in c,
    fields: ["playback"],
    trackMatch: () => false,
  },
];

const domainById = new Map(PROPERTY_DOMAINS.map((d) => [d.id, d]));

export function propertyDomain(id: string): PropertyDomainDef | undefined {
  return domainById.get(id);
}

/** The domains a clip can offer for copying, in registry order. */
export function transferDomains(clip: Clip): PropertyDomainDef[] {
  return PROPERTY_DOMAINS.filter((d) => d.appliesTo(clip) && d.fields.some((f) => hasField(clip, f)));
}

/** Set a dotted path inside a values snapshot (used by baking). */
function setPath(values: Rec, path: string, v: unknown): void {
  const parts = path.split(".");
  let cur: Rec = values;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]!];
    if (typeof next !== "object" || next === null) return;
    cur = next as Rec;
  }
  if (parts[parts.length - 1]! in cur) cur[parts[parts.length - 1]!] = v;
}

/**
 * Bake a sampled keyframe value into the snapshot: dotted paths via the
 * domain's bakeMap, plus id-addressed instance fields (`lfx.<id>.<field>`,
 * `fill.<id>`, `stroke.<id>.<field>`) written into the captured lists.
 */
function bakeValue(def: PropertyDomainDef, values: Rec, property: string, v: unknown): void {
  const mapped = def.bakeMap?.[property];
  if (mapped) {
    setPath(values, mapped, v);
    return;
  }
  const seg = property.split(".");
  const inList = (field: string, id: string, write: (item: Rec) => void) => {
    const list = readField(values, field);
    if (!Array.isArray(list)) return;
    const item = (list as Rec[]).find((x) => x["id"] === id);
    if (item) write(item);
  };
  if (seg[0] === "lfx" && seg.length === 3) {
    inList("effects", seg[1]!, (fx) => {
      if (seg[2]! in fx) fx[seg[2]!] = v;
    });
  } else if (seg[0] === "mdf" && seg.length === 3) {
    inList("modifiers", seg[1]!, (m) => {
      if (seg[2]! in m) m[seg[2]!] = v;
    });
  } else if (seg[0] === "force" && seg.length === 3) {
    inList("forces", seg[1]!, (f) => {
      if (seg[2]! in f) f[seg[2]!] = v;
    });
  } else if (seg[0] === "emit" && seg.length === 3) {
    inList("emitters", seg[1]!, (e) => {
      if (seg[2]! in e) e[seg[2]!] = v;
    });
  } else if (seg[0] === "bhv" && seg.length === 3) {
    inList("behaviors", seg[1]!, (b) => {
      b[seg[2]!] = v;
    });
  } else if (seg[0] === "tfx" && seg.length === 3) {
    inList("style.textEffects", seg[1]!, (fx) => {
      if (seg[2]! in fx) fx[seg[2]!] = v;
    });
  } else if (seg[0] === "fill" && seg.length === 2 && typeof v === "string") {
    inList("fills", seg[1]!, (paint) => {
      if (paint["type"] === "solid") paint["color"] = v;
    });
  } else if (seg[0] === "stroke" && seg.length >= 3 && typeof v === "number") {
    // A stroke path addresses the whole pipeline, so it can be nested
    // (`stroke.<id>.trim.end`, `stroke.<id>.markers.end.size`). Core owns the
    // vocabulary; this just hands the suffix over.
    inList("strokes", seg[1]!, (s) => setStrokeScalar(s as unknown as StrokeStyle, seg.slice(2).join("."), v));
  } else if (seg[0] === "stroke" && seg.length === 3) {
    inList("strokes", seg[1]!, (s) => {
      if (seg[2]! in s) s[seg[2]!] = v;
    });
  }
}

/**
 * Snapshot the selected domains from a clip. `selection` maps domain id →
 * true (whole domain) or an item-id subset (e.g. specific effect cards);
 * omit it to capture every applicable domain.
 */
export function captureProperties(
  clip: Clip,
  ctx: TransferContext,
  selection?: Record<string, true | string[]>,
): CapturedProperties {
  const domains: Record<string, DomainSnapshot> = {};
  const sampled = ctx.includeKeyframes ? null : sampleKeyframes(clip.keyframes, ctx.localMs);

  for (const def of transferDomains(clip)) {
    const sel = selection ? selection[def.id] : true;
    if (!sel) continue;
    const values: Rec = {};
    // Snapshots are keyed by the FIELD PATH, nested or not — `style.textEffects`
    // is one entry holding one list, never a whole `style` with a list inside.
    for (const f of def.fields) {
      if (hasField(clip, f)) values[f] = structuredClone(readField(clip, f));
    }
    // Item subset (e.g. two of four effect cards): filter every reissue list.
    const itemIds = Array.isArray(sel) ? new Set(sel) : null;
    if (itemIds) {
      for (const list of def.reissueLists ?? []) {
        const arr = readField(values, list.field);
        if (Array.isArray(arr)) writeField(values, list.field, arr.filter((x) => itemIds.has((x as Rec)["id"] as string)));
      }
      if (itemIds.size === 0) continue;
    }
    const ownsTrack = (t: KeyframeTrack) =>
      def.trackMatch(t.property) &&
      (!itemIds || t.property.split(".").some((s) => itemIds.has(s)));
    if (ctx.includeKeyframes) {
      domains[def.id] = {
        values,
        tracks: clip.keyframes.filter(ownsTrack).map((t) => structuredClone(t)),
      };
    } else {
      for (const t of clip.keyframes) {
        if (ownsTrack(t) && sampled && t.property in sampled) {
          bakeValue(def, values, t.property, sampled[t.property]);
        }
      }
      domains[def.id] = { values, tracks: [] };
    }
  }
  return { kind: "properties", sourceKind: clip.kind, domains };
}

/** Domain ids in a capture that can land on this target clip. */
export function applicableDomains(captured: CapturedProperties, target: Clip): string[] {
  return Object.keys(captured.domains).filter((id) => {
    const def = domainById.get(id);
    return !!def && def.appliesTo(target) && def.fields.some((f) => hasField(target, f));
  });
}

/** Segment-wise id swap on a keyframe path (`lfx.<id>.blur` → new id). */
function remapTrackId(property: string, oldId: string, newId: string): string {
  return property
    .split(".")
    .map((s) => (s === oldId ? newId : s))
    .join(".");
}

/**
 * Write captured domains onto a target clip (all of them, or `domainIds`).
 * Replaces the domain's fields and tracks; effects captured in `append` mode
 * extend the stack instead. Returns the labels of the domains applied.
 */
export function applyProperties(
  target: Clip,
  captured: CapturedProperties,
  domainIds?: string[],
): string[] {
  const applied: string[] = [];
  const ids = domainIds ?? Object.keys(captured.domains);

  for (const id of ids) {
    const def = domainById.get(id);
    const snap = captured.domains[id];
    if (!def || !snap || !def.appliesTo(target)) continue;
    const t = target as Rec;
    const append = snap.mode === "append";
    let touched = false;

    for (const [field, value] of Object.entries(snap.values)) {
      if (!hasField(t, field)) continue;
      const cloned = structuredClone(value);
      const existing = readField(t, field);
      if (append && Array.isArray(cloned) && Array.isArray(existing)) {
        existing.push(...cloned);
      } else {
        writeField(t, field, cloned);
      }
      touched = true;
    }
    if (!touched) continue;

    // Tracks: drop the target's tracks this domain owns (unless appending),
    // then bring the captured ones over under fresh track/key ids.
    if (!append) {
      target.keyframes = target.keyframes.filter((tr) => !def.trackMatch(tr.property));
    }
    const incoming = snap.tracks.map((tr) => {
      const copy = structuredClone(tr);
      copy.id = createId("ktrack");
      for (const k of copy.keys) k.id = createId("key");
      return copy;
    });
    target.keyframes.push(...incoming);

    // Re-issue instance ids (paints, effects, EQ bands) and re-point the
    // tracks that address them — a paste never shares ids with its source.
    for (const list of def.reissueLists ?? []) {
      const arr = readField(t, list.field);
      if (!Array.isArray(arr)) continue;
      // The `text` domain snapshots the whole style; its stack arrives inside
      // that entry rather than under its own path, so look in both places.
      const src = snap.values[list.field] ?? readField(snap.values, list.field);
      const fresh = append && Array.isArray(src) ? src.length : 0;
      const start = append ? arr.length - fresh : 0;
      for (let i = Math.max(start, 0); i < arr.length; i++) {
        const item = arr[i] as Rec;
        const oldId = item["id"];
        if (typeof oldId !== "string") continue;
        const newId = createId(list.idPrefix);
        item["id"] = newId;
        for (const tr of incoming) tr.property = remapTrackId(tr.property, oldId, newId);
      }
    }
    applied.push(def.label);
  }
  return applied;
}
