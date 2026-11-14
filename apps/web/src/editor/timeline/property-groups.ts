"use client";

import {
  layerEffectTypeDef,
  propertyDef,
  type Clip,
  type KeyframeTrack,
} from "@solomotion/core";

const PROP_COLORS: Record<string, string> = {
  x: "#F5B843",
  y: "#4CC3E0",
  scale: "#B18CFF",
  rotation: "#7BD88F",
  opacity: "#E8E6E1",
  fontSize: "#E5484D",
  letterSpacing: "#F58F43",
  lineHeight: "#43E0C3",
  highlightScale: "#F543B4",
  gain: "#8FD87B",
};
const EXTRA_PALETTE = ["#F5B843", "#4CC3E0", "#B18CFF", "#7BD88F", "#E5484D", "#F58F43", "#43E0C3", "#F543B4"];
function hashIndex(s: string, n: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % n;
}
/** Stable color per property — registry props keep their hue; effects/others hash into the palette. */
export const colorFor = (property: string) =>
  PROP_COLORS[property] ?? EXTRA_PALETTE[hashIndex(property, EXTRA_PALETTE.length)]!;

/**
 * The property tree — ONE brain that names and groups every keyframe track a
 * clip can carry, used by the graph panel's left column (curves visibility
 * list + dope-sheet rows). "lfx.abc123.x" stops reading like a bare "X":
 * it becomes item "X" inside group "Shadow", exactly like the inspector's
 * effect cards. Groups, in render order:
 *
 *   Transform   x/y/scale/rotation/opacity
 *   Typography  fontSize/letterSpacing/lineHeight/…
 *   <Effect>    one group per effect INSTANCE (text style fx.* and layer lfx.*)
 *   Fill/Stroke paint-list entries (fill.<id>.* / stroke.<id>.*)
 *   Audio       gain
 *   Other       anything new — never hidden, never crashes
 */

export interface PropItem {
  property: string;
  /** Short label — the group header carries the context ("X" under "Shadow"). */
  label: string;
  color: string;
  track: KeyframeTrack;
}

export interface PropGroup {
  id: string;
  label: string;
  items: PropItem[];
}

const TRANSFORM_PROPS = ["x", "y", "scale", "scaleY", "rotation", "opacity"];
const TYPO_PROPS = ["fontSize", "fontWeight", "fauxBold", "letterSpacing", "lineHeight", "highlightScale"];

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The effect instance a `lfx.<id>.*` path addresses. */
function effectOf(clip: Clip, effectId: string) {
  return clip.kind !== "audio" ? clip.effects.find((e) => e.id === effectId) : undefined;
}

/** Effect-instance label for `lfx.<id>.*`. */
function effectGroupLabel(clip: Clip, effectId: string): string {
  const eff = effectOf(clip, effectId);
  return (eff && layerEffectTypeDef(eff.type)?.label) ?? "Effect";
}

/** Field label inside an effect group ("x" → "X", "blur" → "Blur"…). */
function effectFieldLabel(clip: Clip, effectId: string, field: string): string {
  const eff = effectOf(clip, effectId);
  const defs = (eff && layerEffectTypeDef(eff.type)?.fields) || [];
  return defs.find((f) => f.key === field)?.label ?? cap(field);
}

export function propertyGroupsFor(clip: Clip): PropGroup[] {
  const transform: PropItem[] = [];
  const typo: PropItem[] = [];
  const effects = new Map<string, PropGroup>(); // keyed `lfx.${effectId}`
  const paints = new Map<string, PropGroup>(); // keyed `fill.<id>` / `stroke.<id>`
  const audio: PropItem[] = [];
  const other: PropItem[] = [];
  // A rig's bones: one group per bone, named for it ("Forearm · Rotation"), in the rig's bone order.
  const bones = new Map<string, PropGroup>();
  const character: PropItem[] = [];

  let effectSeq = 0;
  const item = (track: KeyframeTrack, label: string): PropItem => ({
    property: track.property,
    label,
    color: colorFor(track.property),
    track,
  });

  for (const track of clip.keyframes) {
    if (track.keys.length === 0) continue;
    const p = track.property;
    const parts = p.split(".");

    if (TRANSFORM_PROPS.includes(p)) {
      transform.push(item(track, propertyDef(p)?.label ?? cap(p)));
    } else if (TYPO_PROPS.includes(p)) {
      typo.push(item(track, propertyDef(p)?.label ?? cap(p)));
    } else if (parts[0] === "lfx" && parts.length >= 3) {
      const effectId = parts[1]!;
      const key = `lfx.${effectId}`;
      let group = effects.get(key);
      if (!group) {
        effectSeq++;
        group = { id: key, label: effectGroupLabel(clip, effectId), items: [] };
        effects.set(key, group);
      }
      group.items.push(item(track, effectFieldLabel(clip, effectId, parts.slice(2).join("."))));
    } else if ((parts[0] === "fill" || parts[0] === "stroke") && parts.length >= 2) {
      const key = `${parts[0]}.${parts[1]}`;
      let group = paints.get(key);
      if (!group) {
        group = { id: key, label: cap(parts[0]!), items: [] };
        paints.set(key, group);
      }
      const field = parts.slice(2).join(".");
      group.items.push(item(track, field ? cap(field) : "Color"));
    } else if (parts[0] === "bone" && parts.length === 3 && clip.kind === "group") {
      const bone = clip.rig?.bones.find((b) => b.id === parts[1]);
      const key = `bone.${parts[1]}`;
      let group = bones.get(key);
      if (!group) {
        group = { id: key, label: bone?.name ?? "Bone", items: [] };
        bones.set(key, group);
      }
      group.items.push(item(track, propertyDef(p)?.label ?? cap(parts[2]!)));
    } else if (p === "switch") {
      character.push(item(track, "Show"));
    } else if (p === "gain" || p.startsWith("eq.")) {
      audio.push(item(track, propertyDef(p)?.label ?? cap(p)));
    } else if (p.startsWith("highlight.")) {
      typo.push(item(track, `Highlight ${parts[1] ?? ""}`.trim()));
    } else {
      other.push(item(track, propertyDef(p)?.label ?? cap(p)));
    }
  }

  // Duplicate effect labels ("Shadow", "Shadow") get a running number.
  const effectGroups = [...effects.values()];
  const counts = new Map<string, number>();
  for (const g of effectGroups) counts.set(g.label, (counts.get(g.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const g of effectGroups) {
    if ((counts.get(g.label) ?? 0) > 1) {
      const n = (seen.get(g.label) ?? 0) + 1;
      seen.set(g.label, n);
      g.label = `${g.label} ${n}`;
    }
  }
  void effectSeq;

  const out: PropGroup[] = [];
  if (transform.length) out.push({ id: "transform", label: "Transform", items: transform });
  if (typo.length) out.push({ id: "typography", label: "Typography", items: typo });
  if (character.length) out.push({ id: "switch", label: "Switch", items: character });
  if (bones.size && clip.kind === "group") {
    const order = new Map((clip.rig?.bones ?? []).map((b, i) => [`bone.${b.id}`, i]));
    out.push(...[...bones.values()].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9)));
  }
  out.push(...effectGroups, ...paints.values());
  if (audio.length) out.push({ id: "audio", label: "Audio", items: audio });
  if (other.length) out.push({ id: "other", label: "Other", items: other });
  return out;
}

/**
 * The union of several clips' property trees — one entry per property, so a
 * multi-select curves view lists (and toggles) "Opacity" ONCE even when five
 * layers each animate it. Groups and items keep first-seen order; transform /
 * typography / audio dedupe by property (they share names across clips), while
 * effect and paint instances stay distinct (their ids differ per clip).
 */
export function mergedPropertyGroups(clips: Clip[]): PropGroup[] {
  const byId = new Map<string, PropGroup>();
  const order: string[] = [];
  for (const clip of clips) {
    for (const g of propertyGroupsFor(clip)) {
      let merged = byId.get(g.id);
      if (!merged) {
        merged = { id: g.id, label: g.label, items: [] };
        byId.set(g.id, merged);
        order.push(g.id);
      }
      for (const it of g.items) {
        if (!merged.items.some((x) => x.property === it.property)) merged.items.push(it);
      }
    }
  }
  return order.map((id) => byId.get(id)!);
}

/** Grouped label for flat contexts (tooltips, the inline key editor). */
export function fullPropertyLabel(clip: Clip, property: string): string {
  for (const g of propertyGroupsFor(clip)) {
    const it = g.items.find((i) => i.property === property);
    if (it) return g.id === "transform" || g.id === "other" ? it.label : `${g.label} · ${it.label}`;
  }
  return property;
}
