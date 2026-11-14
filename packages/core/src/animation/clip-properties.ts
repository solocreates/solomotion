
import type { MotionDocument, Clip, LayerEffect } from "../schema";
import { gradePath, gradeSlots } from "../grade/paths";
import { LAYER_EFFECT_TYPES, layerEffectMoves } from "./layer-effects";
import { AFX } from "../audio/effects/registry";
import { TFX } from "./text-effects";
import { STROKE_SCALAR_PATHS } from "../vector/stroke";
import { paintSubPaths } from "./paint";
import { eqBandPath } from "../audio/effects/resolve";
import { worldClipPaths } from "../world/fields";
import { boneClipPaths } from "../rig/fields";
import { inputClipPaths } from "../components/inputs-fields";
import { poseClipPaths } from "../rig/pose-fields";
import { shapeKeyClipPaths } from "../shape-keys/fields";
import { forceClipPaths } from "../physics/forces";
import { emitterClipPaths } from "../physics/emitters";
import { behaviorClipPaths } from "../behaviors/fields";
import { soundClipPaths } from "../audio/sound-fields";
import { MODULATOR_FIELDS, modulatorPath } from "./modulators";
import { ENABLED_FIELD } from "./activeness";
import {
  propertiesFor,
  propertyDef,
  type AnimatablePropertyDef,
  type PropertyGroup,
} from "./properties";

/**
 * THE NATIVE PROPERTY ENUMERATOR — the single, dynamic answer to "what values
 * does THIS clip expose right now?". It projects the animatable-property
 * registry ([[properties]]) onto a concrete clip INSTANCE: the static defs for
 * the clip's kind PLUS every per-instance path the clip currently carries (one
 * per fill, stroke, effect field, gradient stop, EQ band). Nothing is
 * hand-listed — the list is derived from the same registries the inspector and
 * curve editor read, so the moment the data structure changes (a new property,
 * a new effect field, an added fill) every consumer that reads THIS grows the
 * matching value with zero extra code.
 *
 * The node system's Object/property nodes build their sockets from this, so
 * "expose all of a layer's fields as read+write sockets" is one call, not a
 * parallel table that can drift.
 */

export interface ClipProperty {
  /** Keyframe/driver path (`x`, `opacity`, `fill.<id>.color`, `lfx.<id>.blur`). */
  path: string;
  /** The resolved animatable-property def (label, kind, min/max/step, identity). */
  def: AnimatablePropertyDef;
  /** Grouping label for UIs (a node's section, an inspector header). */
  group: string;
  /** Machine-stable group id (the property group, or `effect:<id>` / `paint:<id>`). */
  groupId: string;
}

const GROUP_LABEL: Record<PropertyGroup, string> = {
  transform: "Transform",
  behavior: "Behaviors",
  layout: "Layout",
  typography: "Typography",
  caption: "Caption",
  audio: "Audio",
  vector: "Shape",
  video: "Video",
  waveform: "Waveform",
  trace: "Trace",
  capture: "Capture",
  effects: "Effects",
  motion: "Motion Blur",
  camera: "Camera",
  light: "Light",
  material: "Material",
  geometry: "Geometry",
  rig: "Bones",
  switch: "Switch",
  pose: "Poses",
  field: "Forces",
  inputs: "Inputs",
};

/** A `ClipProperty` from a synthesized/registry path — `propertyDef` names it. */
function fromPath(path: string, group: string, groupId: string): ClipProperty | null {
  const def = propertyDef(path);
  return def ? { path, def, group, groupId } : null;
}

/**
 * Every animatable value the clip instance exposes, in a stable, grouped order
 * (transform → typography → per-effect → per-paint → audio → …). Pure and
 * cheap; callers memoise on the clip identity when they render every frame.
 */
export function clipAnimatableProperties(clip: Clip, doc?: MotionDocument): ClipProperty[] {
  const out: ClipProperty[] = [];
  const push = (p: ClipProperty | null) => {
    if (p) out.push(p);
  };

  // 1. Static registry defs for this clip kind (transform, typography, …). Their
  //    `group` is authoritative; we only relabel it for humans.
  //
  //    Narrowed per INSTANCE, not just per kind: the registry's `appliesTo` can
  //    only say "shape", and a rectangle is not a star. Listing a knob nothing
  //    reads is worse than listing nothing — a rectangle used to offer four
  //    different ways to round a corner, three of which were inert, so wiring a
  //    node into the obvious-looking one did nothing at all and the board gave
  //    no hint which of the four was real.
  for (const def of propertiesFor(clip.kind)) {
    if (!appliesToInstance(clip, def.key)) continue;
    push({ path: def.key, def, group: GROUP_LABEL[def.group], groupId: def.group });
  }

  // 1b. A mesh's primitive params and modifier fields — per instance, named by
  //     the 3D registry (`world/fields.ts`), so a cube offers its size and a
  //     twist its angle without either being listed here.
  for (const path of worldClipPaths(clip)) {
    if (!path.startsWith("geometry.") && !path.startsWith("mdf.")) continue;
    const id = path.startsWith("mdf.") ? `modifier:${path.split(".")[1]}` : "geometry";
    push(fromPath(path, path.startsWith("mdf.") ? "Modifier" : "Geometry", id));
  }

  // 1c. A rig's bones — each bone's pose channels, grouped by the bone, so the
  //     board shows "Forearm · Rotation" and the curve editor one row per bone.
  for (const { path, bone } of boneClipPaths(clip)) push(fromPath(path, bone.name || "Bone", `bone:${bone.id}`));

  // 1c'. Its pose sets — one discrete channel per set, grouped by the set (`pose.<setId>`).
  for (const { path, set } of poseClipPaths(clip)) push(fromPath(path, set.name || "Poses", `pose:${set.id}`));

  // 1c''. Shape-key weights (`key.<id>`) — one row per key, labelled by its name.
  for (const { path, key } of shapeKeyClipPaths(clip)) {
    const p = fromPath(path, "Shape keys", "shapeKeys");
    if (p) push({ ...p, def: { ...p.def, label: key.name } });
  }

  // 1c'. An instance's INPUTS (`input.<id>`) — typed from its comp's
  //      definitions when the document is in hand, else the overrides it carries.
  for (const { path, def } of inputClipPaths(clip, doc)) push({ path, def, group: "Inputs", groupId: "inputs" });

  // 1d. Its forces — one group per card in the stack (`force.<id>.<field>`).
  for (const { path, force, label } of forceClipPaths(clip)) push(fromPath(path, label, `force:${force.id}`));
  for (const { path, emitter, label } of emitterClipPaths(clip)) push(fromPath(path, label, `emitter:${emitter.id}`));

  // 1e. Its behaviors — one group per card in the stack (`bhv.<id>.<field>`).
  for (const { path, behavior, label } of behaviorClipPaths(clip)) push(fromPath(path, label, `behavior:${behavior.id}`));

  // 2. Layer effects — one field per effect instance (`lfx.<id>.<field>`), named
  //    by the effect's own registry entry so cards and sockets read alike.
  if ("effects" in clip && Array.isArray(clip.effects)) {
    for (const eff of clip.effects) {
      const typeDef = LAYER_EFFECT_TYPES.find((t) => t.type === eff.type);
      const label = typeDef?.label ?? "Effect";
      const groupId = `effect:${eff.id}`;
      for (const field of typeDef?.fields ?? []) {
        if (field.key === "enabled") continue;
        push(fromPath(`lfx.${eff.id}.${field.key}`, label, groupId));
      }
      // 2b. A GRADE card carries a node graph, and every value inside it is
      //     animatable through the same namespace (`lfx.<card>.n.<node>.…`).
      //     Grouped per node, because a node is the only grouping that means
      //     anything on a page whose whole structure is nodes.
      if (eff.type === "grade") {
        for (const slot of gradeSlots(eff.graph)) {
          push(fromPath(`lfx.${eff.id}.${slot.suffix}`, slot.group, `grade:${eff.id}:${slot.nodeId}`));
        }
        for (const node of eff.graph.nodes) {
          if (node.kind !== "corrector") continue;
          const nodeGroup = node.name || "Node";
          for (const inner of node.effects) {
            const innerDef = LAYER_EFFECT_TYPES.find((t) => t.type === inner.type);
            for (const field of innerDef?.fields ?? []) {
              if (field.key === "enabled") continue;
              push(
                fromPath(
                  `lfx.${eff.id}.${gradePath.effect(node.id, inner.id, field.key)}`,
                  `${nodeGroup} · ${innerDef?.label ?? "Effect"}`,
                  `grade:${eff.id}:${node.id}:${inner.id}`,
                ),
              );
            }
          }
        }
      }
    }
  }

  // 2c. Text effects — one field per PER-GLYPH pass (`tfx.<id>.<field>`). The
  //     resolver, the sampler and `effects.add` (which hands this path back)
  //     all knew them; left off this list, `keyframes.set` refused the path it
  //     had just been given, so an echo could never be keyed by an agent.
  if (clip.kind === "text") {
    for (const fx of clip.style?.textEffects ?? []) {
      const def = TFX.def(fx.type);
      const label = def?.label ?? "Text effect";
      for (const field of def?.fields ?? []) {
        if (field.key === "enabled") continue;
        push(fromPath(TFX.path(fx.id, field.key), label, `effect:${fx.id}`));
      }
    }
  }

  // 3. Unified paint — per fill / stroke entry. Solids expose color+opacity;
  //    gradients also expose each stop and the handle geometry. All paths funnel
  //    through `propertyDef` (paintPropertyDef), so no paint internals leak here.
  if ("fills" in clip && Array.isArray(clip.fills)) {
    for (const fill of clip.fills) {
      const groupId = `paint:${fill.id}`;
      const group = "Fill";
      if (fill.type === "solid") push(fromPath(`fill.${fill.id}`, group, groupId));
      push(fromPath(`fill.${fill.id}.opacity`, group, groupId));
      // Stops, gradient handles, a pattern's fields — whatever this paint
      // carries, from the resolver's own enumerator. Listing stops by hand
      // here left every pattern field (spacing, offset, colour…) keyable in
      // the studio and refused by `keyframes.set` / `expression.set`.
      for (const sub of paintSubPaths(fill)) push(fromPath(`fill.${fill.id}.${sub}`, group, groupId));
    }
  }
  if ("strokes" in clip && Array.isArray(clip.strokes)) {
    for (const stroke of clip.strokes) {
      const groupId = `paint:${stroke.id}`;
      push(fromPath(`stroke.${stroke.id}.color`, "Stroke", groupId));
      // Every pipeline scalar — width, dash, TRIM (the draw-on), taper, wave,
      // ends — from core's one table, the same one the inspector's ◆ reads.
      // Listing only width and opacity here made `trim.end` keyable in the
      // panel and refused by the API that the skill tells agents to use.
      for (const sub of STROKE_SCALAR_PATHS) push(fromPath(`stroke.${stroke.id}.${sub}`, "Stroke", groupId));
      for (const sub of paintSubPaths(stroke.paint)) push(fromPath(`stroke.${stroke.id}.${sub}`, "Stroke", groupId));
    }
  }

  // 4. Audio effects — one entry per field of every card in the chain
  //    (`afx.<id>.<field>`), named by the registry so the node card, the curve
  //    editor and the inspector all read alike. EQ additionally exposes each
  //    BAND (`afx.<id>.band.<bandId>.…`), because a band is an instance inside
  //    an instance and its values are as animatable as any other.
  // Guarded like `effects` above: a clip assembled in a test or by an older
  // in-memory path has not been through the schema's `.default([])`.
  for (const fx of Array.isArray(clip.audioEffects) ? clip.audioEffects : []) {
    const def = AFX.def(fx.type);
    const label = def?.label ?? "Audio effect";
    const groupId = `effect:${fx.id}`;
    for (const field of def?.fields ?? []) {
      push(fromPath(AFX.path(fx.id, field.key), label, groupId));
    }
    if (fx.type === "eq") {
      for (const band of fx.bands) {
        for (const f of ["gain", "freq", "q"] as const) {
          push(fromPath(eqBandPath(fx.id, band.id, f), label, groupId));
        }
      }
    }
  }

  // 5. Modulators — every field of every modulator on the clip
  //    (`mod.<id>.<field>`), from the one field table the inspector renders.
  //    The resolver and the sampler already knew these paths; leaving them off
  //    this list made the API refuse them, so "the shake ramps in on the hit
  //    and dies away" could be drawn in the panel but never keyed by an agent.
  const modulators = "modulators" in clip && Array.isArray(clip.modulators) ? clip.modulators : [];
  for (const m of modulators) {
    const groupId = `modulator:${m.id}`;
    push(fromPath(modulatorPath(m.id, ENABLED_FIELD), "Modulator", groupId));
    for (const field of MODULATOR_FIELDS) push(fromPath(modulatorPath(m.id, field.key), "Modulator", groupId));
  }

  // 6. The sound stack's climax dials — one per entry (`snd.<id>.intensity`).
  for (const { path, entry } of soundClipPaths(clip)) push(fromPath(path, "Sound", `sound:${entry.id}`));

  return out;
}

/**
 * Does this property actually do anything to THIS clip?
 *
 * The registry answers per kind; this answers per instance, for the two places
 * where one kind holds several shapes of thing. It is deliberately a list of
 * what each variant READS — checked against the geometry compiler and the box
 * clip rather than guessed — so a knob is offered exactly when turning it
 * changes the picture.
 */
function appliesToInstance(clip: Clip, key: string): boolean {
  // A PROCESSOR has no moving ink to smear — `paintClipShutter` declines one
  // outright — so the shutter's four knobs would be inert on it. Everything
  // else in the visual set it genuinely reads: the pose sizes the composite it
  // grades, the mix blends the result, and crop/radius/feather shape the
  // WINDOW that grade is allowed through (see `renderAdjustment`).
  if (clip.kind === "adjustment") return !key.startsWith("mblur.");
  // Only a switch has a choice to make.
  if (key === "switch") return clip.kind === "group" && !!clip.switch;
  // A 2D layer's SURFACE is a world body's — offered once it has one (it is
  // thick, or it set a material), not on every flat text in every comp.
  if (key.startsWith("material.") && clip.kind !== "mesh") {
    const v = clip as { material?: unknown; extrude?: { depth: number } };
    return !!v.material || (v.extrude?.depth ?? 0) > 0;
  }
  if (clip.kind !== "shape") return true;

  // A shape's silhouette IS its geometry, so the layer box's rounding never
  // runs for one (`withBoxClip` is for footage, pixels and nested comps).
  if (key === "borderRadius" || key.startsWith("borderRadius.")) return false;

  // Per-corner radii are the rect's rounding; the uniform `radius` is the
  // polygon/star corner pull-back. `shapeCommands` reads one or the other,
  // never both.
  const perCorner = key.startsWith("radius.");
  const uniform = key === "radius";
  switch (clip.shape) {
    case "rect":
      return perCorner || !(uniform || SHAPE_ONLY_KEYS.has(key));
    case "ellipse":
      return !perCorner && !uniform && key !== "pointCount" && key !== "innerRatio";
    case "polygon":
      return !perCorner && !key.startsWith("arc") && key !== "innerRatio";
    case "star":
      return !perCorner && !key.startsWith("arc");
  }
}

/** Keys only a polygon, a star or an ellipse reads. */
const SHAPE_ONLY_KEYS = new Set(["pointCount", "innerRatio", "arcStartDeg", "arcSweepDeg", "arcRatio"]);

/**
 * DOES THIS CLIP'S PICTURE CHANGE OVER ITS OWN LIFETIME?
 *
 * One predicate, because "is this thing moving" is asked by more and more
 * surfaces — the poster model decides still-vs-filmstrip with it, and anything
 * that wants to skip work on a static layer (a cheaper thumbnail, a smarter
 * cache, a static-frame export hint) needs the SAME answer or it will show one
 * thing and cache another.
 *
 * The reason it enumerates rather than checking `keyframes` is that keyframes
 * are only one of the ways a layer moves, and every one of the others has bitten
 * something already:
 *
 *  - **Keyframes** on any path at all. That single check already covers far
 *    more than it looks: the path grammar is universal, so a colour ramp, a
 *    vector morph (`geometry`), a text content change, a gradient stop, an EQ
 *    band, a per-field effect value (`lfx.<id>.<field>`) and a pixel layer's
 *    snapshot are all just tracks in this list.
 *  - **Node drivers** (`expr:<id>`), which compute a value from a graph that
 *    reads time. A driven property has no keys and moves anyway.
 *  - **Modulators** — a wiggle is animation that never wrote a key.
 *  - **A track binding**, which drives the pose from a motion track.
 *  - **In/out animations**, which are the most common way a layer moves and
 *    are stored as specs, not as keys.
 *  - **Time-driven effects** — grain, scanlines, a glass ripple: fields frozen,
 *    output alive. The effect registry declares this (`timeDriven`), so a new
 *    one is honest here the day it ships.
 *
 * It answers about the clip's OWN animation, not about its source: a video is
 * moving whatever this says, which is why source-backed kinds never ask.
 */
export function clipVariesWithTime(clip: Clip): boolean {
  if (clip.keyframes.length > 0) return true;
  const c = clip as Clip & {
    drivers?: Record<string, string>;
    modulators?: unknown[];
    trackBinding?: unknown;
    animIn?: unknown;
    animOut?: unknown;
    animations?: { in?: unknown; out?: unknown };
    effects?: LayerEffect[];
  };
  if (c.drivers && Object.keys(c.drivers).length > 0) return true;
  if ((c.modulators?.length ?? 0) > 0) return true;
  if (c.trackBinding) return true;
  if (c.animIn || c.animOut) return true;
  if (c.animations?.in || c.animations?.out) return true;
  for (const effect of c.effects ?? []) {
    if (effect.enabled && layerEffectMoves(effect)) return true;
  }
  return false;
}
