import type { Bone, Clip, Easing, Frame, GroupClip, KeyframeTrack, Paint, StrokeStyle, Subpath } from "../schema";
import { physicsSchema } from "../schema/physics";
import { LFX } from "../animation/layer-effects";
import { TFX } from "../animation/text-effects";
import { AFX } from "../audio/effects/registry";
import { MDF } from "../world/modifiers";
import { FORCE } from "../physics/forces";
import { EMITTER } from "../physics/emitters";
import type { BaseEffect, EffectRegistry, EffectTypeDefBase } from "../animation/effect-base";
import { specFromPreset } from "../animation/presets";
import { layerSpecFromPreset } from "../animation/layer-animation";
import { bonesInRig, rigIsPlanar } from "../rig/ops";
import { machineSpec } from "../machines/code";
import { registerReifier, type ReifyContext } from "./reify";
import type { Ref } from "./reify-code";

/**
 * THE BUILT-IN PRINTERS — one per layer kind that has a creating verb, and
 * one per family of things a layer carries. Each says what a person would
 * write; the bridge (`reify.ts`) measures what they leave out and adds it.
 * Sibling families (poses, shape keys, inputs, machines, rig constraints)
 * are printed here through their own verbs.
 */

// ── Small shared helpers ─────────────────────────────────────────────────────

const DEFAULT_EASE: Easing = { kind: "preset", name: "ease-in-out" };

/** An easing as the API's shorthand: "linear", a preset name, or "cubic-bezier(…)". */
export function easingText(e: Easing): string {
  if (e.kind === "linear" || e.kind === "hold") return e.kind;
  if (e.kind === "preset") return e.name;
  return `cubic-bezier(${e.values.join(",")})`;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Fields of `value` that differ from `defaults`, skipping `omit`. */
function changed(value: object, defaults: object, omit: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (omit.includes(k) || v === undefined) continue;
    if (!same(v, (defaults as Record<string, unknown>)[k])) out[k] = v;
  }
  return out;
}

const varHint = (clip: Clip) => clip.name;

/** Where a new layer goes: the comp the code made, and its place in the stack. */
function where(clip: Clip, cx: ReifyContext): Record<string, unknown> {
  const placement = cx.placement(clip.id);
  return { ...(cx.frame ? { frameId: cx.frame } : {}), ...(placement ? { placement } : {}) };
}

function timing(clip: Clip, defaultMs: number | null): Record<string, unknown> {
  return { startMs: clip.startMs, ...(defaultMs !== null && clip.durationMs === defaultMs ? {} : { durationMs: clip.durationMs }) };
}

function xy(clip: Clip): Record<string, unknown> {
  if (clip.kind === "audio") return {};
  return { ...(clip.transform.x ? { x: clip.transform.x } : {}), ...(clip.transform.y ? { y: clip.transform.y } : {}) };
}

/** A paint as `layer.create` takes it: a colour when that says it all, else the stored object (its id is the API's to mint). */
function paintInput(p: Paint): unknown {
  if (p.type === "solid" && p.enabled && p.opacity === 1 && p.blendMode === "normal") return p.color;
  const { id: _id, ...rest } = p;
  void _id;
  return rest;
}

function strokeInput(s: StrokeStyle): unknown {
  const { id: _id, paint, ...rest } = s;
  const { id: _pid, ...paintRest } = paint;
  void [_id, _pid];
  return { paint: paintRest, ...rest };
}

/** The first fill and stroke `layer.create` made, known to the script by the ids it returns. */
function bindPaints(clip: Clip, ref: Ref, cx: ReifyContext): void {
  if (clip.kind === "audio") return;
  if (clip.fills[0]) cx.bindId(clip.fills[0].id, ref.at("fills", 0));
  if (clip.strokes[0]) cx.bindId(clip.strokes[0].id, ref.at("strokes", 0));
}

/** Contours as SVG path data — what `layer.create {kind:"path"}` and a model both read. */
export function subpathsToD(subpaths: readonly Subpath[]): string {
  const n = (v: number) => String(Math.round(v * 1000) / 1000);
  const parts: string[] = [];
  for (const sp of subpaths) {
    const pts = sp.points;
    if (!pts.length) continue;
    parts.push(`M${n(pts[0]!.x)} ${n(pts[0]!.y)}`);
    const seg = (a: (typeof pts)[number], b: (typeof pts)[number]) => {
      if (a.hOut || b.hIn) {
        const c1 = a.hOut ?? a;
        const c2 = b.hIn ?? b;
        parts.push(`C${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(b.x)} ${n(b.y)}`);
      } else parts.push(`L${n(b.x)} ${n(b.y)}`);
    };
    for (let i = 1; i < pts.length; i++) seg(pts[i - 1]!, pts[i]!);
    if (sp.closed) {
      const last = pts[pts.length - 1]!;
      if (pts.length > 1 && (last.hOut || pts[0]!.hIn)) seg(last, pts[0]!);
      parts.push("Z");
    }
  }
  return parts.join(" ");
}

// ── Create: one printer per kind ─────────────────────────────────────────────

registerReifier("text", {
  phase: "create",
  kinds: ["text"],
  print(clip, cx) {
    if (clip.kind !== "text") return;
    const ref = cx.call(
      "layer.create",
      {
        kind: "text",
        text: clip.text,
        ...((clip.text.slice(0, 24) || "Text") === clip.name ? {} : { name: clip.name }),
        ...timing(clip, 3000),
        ...xy(clip),
        ...(clip.maxWidth ? { maxWidth: clip.maxWidth } : {}),
        ...(clip.caption ? { caption: true } : {}),
        ...where(clip, cx),
      },
      { name: varHint(clip), owner: clip.id },
    );
    cx.bindLayer(clip.id, ref.at("id"));
  },
});

registerReifier("shape", {
  phase: "create",
  kinds: ["shape"],
  print(clip, cx) {
    if (clip.kind !== "shape") return;
    const r = clip.cornerRadius;
    const uniform = r.tl === r.tr && r.tr === r.br && r.br === r.bl ? r.tl : null;
    const ref = cx.call(
      "layer.create",
      {
        kind: "shape",
        shape: clip.shape,
        name: clip.name,
        width: clip.width,
        height: clip.height,
        ...(clip.fills[0] ? { fill: paintInput(clip.fills[0]) } : {}),
        ...(clip.strokes[0] ? { stroke: strokeInput(clip.strokes[0]) } : {}),
        ...(uniform ? { cornerRadius: uniform } : {}),
        ...timing(clip, 5000),
        ...xy(clip),
        ...where(clip, cx),
      },
      { name: varHint(clip), owner: clip.id },
    );
    cx.bindLayer(clip.id, ref.at("id"));
    bindPaints(clip, ref, cx);
  },
});

registerReifier("path", {
  phase: "create",
  kinds: ["path"],
  print(clip, cx) {
    if (clip.kind !== "path") return;
    const d = subpathsToD(clip.subpaths);
    if (!d) return cx.warn(`"${clip.name}" has no points to draw.`);
    const ref = cx.call(
      "layer.create",
      {
        kind: "path",
        name: clip.name,
        d,
        ...(clip.fills[0] ? { fill: paintInput(clip.fills[0]) } : {}),
        ...(clip.strokes[0] ? { stroke: strokeInput(clip.strokes[0]) } : {}),
        ...timing(clip, 5000),
        ...xy(clip),
        ...where(clip, cx),
      },
      { name: varHint(clip), owner: clip.id },
    );
    cx.bindLayer(clip.id, ref.at("id"));
    bindPaints(clip, ref, cx);
  },
});

registerReifier("media", {
  phase: "create",
  kinds: ["image", "video", "audio"],
  print(clip, cx) {
    if (clip.kind !== "image" && clip.kind !== "video" && clip.kind !== "audio") return;
    const assetId = clip.kind === "audio" ? (clip.source.type === "asset" ? clip.source.assetId : null) : clip.assetId;
    if (!assetId) return cx.warn(`"${clip.name}" plays a built-in sound pack, which has no code form yet.`);
    const ref = cx.call(
      "layer.create",
      { kind: "media", assetId: cx.outside("asset", assetId), name: clip.name, ...timing(clip, null), ...xy(clip), ...where(clip, cx) },
      { name: varHint(clip), owner: clip.id },
    );
    cx.bindLayer(clip.id, ref.at("id"));
  },
});

registerReifier("nested", {
  phase: "create",
  kinds: ["nested"],
  print(clip, cx) {
    if (clip.kind !== "nested") return;
    const ref = cx.call(
      "layer.create",
      { kind: "comp", sourceFrameId: cx.outside("frame", clip.sourceFrameId), name: clip.name, ...timing(clip, null), ...xy(clip), ...where(clip, cx) },
      { name: varHint(clip), owner: clip.id },
    );
    cx.bindLayer(clip.id, ref.at("id"));
  },
});

registerReifier("adjustment", {
  phase: "create",
  kinds: ["adjustment"],
  print(clip, cx) {
    const ref = cx.call("layer.create", { kind: "adjustment", name: clip.name, ...timing(clip, null), ...where(clip, cx) }, { name: varHint(clip), owner: clip.id });
    cx.bindLayer(clip.id, ref.at("id"));
  },
});

registerReifier("trace", {
  phase: "create",
  kinds: ["trace"],
  print(clip, cx) {
    if (clip.kind !== "trace") return;
    const { source, ...look } = clip.trace;
    // A source in the subject may be made after the trace: it is pointed at
    // once every layer exists (the "trace-source" printer below).
    const outside = source.clipId && !cx.inSubject(source.clipId) ? { source: cx.outside("clip", source.clipId) } : {};
    const point = source.point.x || source.point.y ? { point: source.point } : {};
    const ref = cx.call(
      "layer.create",
      { kind: "trace", name: clip.name, ...outside, ...point, trace: look, ...timing(clip, null), ...xy(clip), ...where(clip, cx) },
      { name: varHint(clip), owner: clip.id },
    );
    cx.bindLayer(clip.id, ref.at("id"));
  },
});

registerReifier("trace-source", {
  phase: "layer",
  kinds: ["trace"],
  print(clip, cx) {
    if (clip.kind !== "trace" || !clip.trace.source.clipId || !cx.inSubject(clip.trace.source.clipId)) return;
    cx.call("layer.patch", { id: cx.layer(clip.id), ops: [{ op: "set", path: "trace.source.clipId", value: cx.layer(clip.trace.source.clipId) }] });
  },
});

registerReifier("world", {
  phase: "create",
  kinds: ["mesh", "camera", "light", "empty"],
  print(clip, cx) {
    if (clip.kind !== "mesh" && clip.kind !== "camera" && clip.kind !== "light" && clip.kind !== "empty") return;
    const t = clip.transform;
    const geometry = clip.kind === "mesh" ? (clip.geometry as { type?: string; primitive?: string; params?: Record<string, number> }) : null;
    const ref = cx.call(
      "world.add",
      {
        ...(cx.frame ? { frameId: cx.frame } : {}),
        kind: clip.kind === "empty" ? "controller" : clip.kind,
        ...(geometry?.type === "primitive" && geometry.primitive ? { primitive: geometry.primitive, ...(geometry.params ? { params: geometry.params } : {}) } : {}),
        ...(clip.kind === "light" ? { light: clip.light.type } : {}),
        name: clip.name,
        position: [t.x, t.y, t.z ?? 0],
        rotation: [t.rotationX ?? 0, t.rotationY ?? 0, t.rotation],
        ...(clip.fillDuration ? {} : timing(clip, null)),
      },
      { name: varHint(clip), owner: clip.id },
    );
    cx.bindLayer(clip.id, ref.at("id"));
  },
});

/** The members a group creates from, as the script knows them. */
function membersOf(clip: GroupClip, cx: ReifyContext): Array<Ref | string> {
  const ids = cx.doc.tracks.filter((t) => t.groupId === clip.id).flatMap((t) => t.clips.map((c) => c.id));
  return ids.filter((id) => cx.inSubject(id)).map((id) => cx.layer(id));
}

registerReifier("group", {
  phase: "create",
  kinds: ["group"],
  print(clip, cx) {
    if (clip.kind !== "group") return;
    const ids = membersOf(clip, cx);
    if (clip.rig) return printRig(clip, ids, cx);
    if (!ids.length) return cx.warn(`"${clip.name}" is an empty group; it is left out.`);
    if (clip.switch) {
      const ref = cx.call("switch.create", { ids, name: clip.name, ...(clip.switch.show !== "" ? { show: clip.switch.show } : {}) }, { name: varHint(clip), owner: clip.id });
      return cx.bindLayer(clip.id, ref.at("switchId"));
    }
    const ref = cx.call(
      "layers.group",
      { ids, name: clip.name, ...(clip.mode !== "pass" ? { mode: clip.mode } : {}), ...(clip.layout ? { layout: clip.layout } : {}) },
      { name: varHint(clip), owner: clip.id },
    );
    cx.bindLayer(clip.id, ref.at("groupId"));
  },
});

/** Bones parents-first, so each names a parent that already exists. */
function bonesInOrder(bones: readonly Bone[]): Bone[] {
  const out: Bone[] = [];
  const done = new Set<string>();
  const visit = (b: Bone, seen: Set<string>) => {
    if (done.has(b.id) || seen.has(b.id)) return;
    seen.add(b.id);
    const parent = b.parent ? bones.find((x) => x.id === b.parent) : undefined;
    if (parent) visit(parent, seen);
    done.add(b.id);
    out.push(b);
  };
  bones.forEach((b) => visit(b, new Set()));
  return out;
}

function printRig(clip: GroupClip, ids: Array<Ref | string>, cx: ReifyContext): void {
  const rig = clip.rig!;
  const planar = rigIsPlanar(cx.doc, clip);
  const rest = bonesInRig(rig, planar);
  const pt = (p: readonly number[]) => (planar ? [p[0]!, p[1]!] : [p[0]!, p[1]!, p[2] ?? 0]).map((v) => Math.round(v * 1000) / 1000);
  const nameOf = (id: string | null) => (id ? (rig.bones.find((b) => b.id === id)?.name ?? null) : null);
  const bones = bonesInOrder(rig.bones).map((b) => {
    const r = rest.get(b.id)!;
    return {
      name: b.name,
      head: pt(r.head),
      tail: pt(r.tail),
      parent: nameOf(b.parent),
      ...(b.deform ? {} : { deform: false }),
      ...(b.shape !== "bone" ? { shape: b.shape } : {}),
      ...(b.size !== null ? { size: b.size } : {}),
      ...(b.color !== null ? { color: b.color } : {}),
      ...(b.limits ? { limits: b.limits } : {}),
      ...(!planar && b.rest.rotationX ? { roll: b.rest.rotationX } : {}),
    };
  });
  const ref = cx.call("rig.create", { ...(ids.length ? { ids } : cx.frame ? { frameId: cx.frame } : {}), name: clip.name, ...(bones.length ? { bones } : {}) }, { name: varHint(clip), owner: clip.id });
  cx.bindLayer(clip.id, ref.at("rigId"));
  if (rig.bones.some((b) => cx.referenced(b.id))) {
    const names = cx.names(ref.at("bones"), `${clip.name} bone`);
    for (const b of rig.bones) cx.bindId(b.id, names.at(b.name));
  }
}

registerReifier("unprintable", {
  phase: "create",
  kinds: ["waveform", "raster"],
  print(clip, cx) {
    cx.warn(
      clip.kind === "raster"
        ? `"${clip.name}" is painted pixels, which have no code form — it is left out.`
        : `"${clip.name}" (an audio visualizer) has no creating verb yet — it is left out.`,
    );
  },
});

// ── Layer aspects (after every layer exists) ─────────────────────────────────

type Registry = EffectRegistry<BaseEffect, EffectTypeDefBase<BaseEffect>>;
const asReg = (r: unknown) => r as Registry;

function stacks(clip: Clip): Array<{ domain: string; reg: Registry; list: BaseEffect[] }> {
  const out: Array<{ domain: string; reg: Registry; list: BaseEffect[] }> = [];
  if (clip.kind !== "audio") {
    out.push({ domain: "layer", reg: asReg(LFX), list: clip.effects as BaseEffect[] });
    if (clip.kind === "text") out.push({ domain: "text", reg: asReg(TFX), list: clip.style.textEffects as BaseEffect[] });
    if (clip.modifiers?.length) out.push({ domain: "geometry", reg: asReg(MDF), list: clip.modifiers as BaseEffect[] });
    if (clip.forces?.length) out.push({ domain: "force", reg: asReg(FORCE), list: clip.forces as BaseEffect[] });
    if (clip.emitters?.length) out.push({ domain: "emitter", reg: asReg(EMITTER), list: clip.emitters as BaseEffect[] });
  }
  out.push({ domain: "audio", reg: asReg(AFX), list: clip.audioEffects as BaseEffect[] });
  return out;
}

registerReifier("effects", {
  phase: "layer",
  order: 10,
  print(clip, cx) {
    for (const { domain, reg, list } of stacks(clip)) {
      for (const fx of list) {
        let defaults: object;
        try {
          defaults = reg.createFor(fx.type, [clip.kind]);
        } catch {
          defaults = {};
        }
        const values = changed(fx, defaults, ["id", "type"]);
        const ref = cx.call(
          "effects.add",
          { id: cx.layer(clip.id), ...(domain !== "layer" ? { domain } : {}), type: fx.type, ...(Object.keys(values).length ? { values } : {}) },
          { name: `${clip.name} ${fx.type}` },
        );
        cx.bindId(fx.id, ref.at("effectId"));
      }
    }
  },
});

registerReifier("rig-details", {
  phase: "layer",
  order: 20,
  print(clip, cx) {
    if (clip.kind !== "group" || !clip.rig) return;
    const rig = clip.rig;
    const name = (id: string | null | undefined) => (id ? (rig.bones.find((b) => b.id === id)?.name ?? id) : null);
    const ik = rig.bones.filter((b) => b.ik);
    if (ik.length) {
      cx.call("rig.bone", {
        rigId: cx.layer(clip.id),
        edit: ik.map((b) => ({ bone: b.name, ik: { target: name(b.ik!.target), chain: b.ik!.chain, ...(b.ik!.pole ? { pole: name(b.ik!.pole) } : {}), ...(b.ik!.flip ? { flip: true } : {}), ...(b.ik!.mix !== 1 ? { mix: b.ik!.mix } : {}) } })),
      });
    }
    const cons = rig.bones.flatMap((b) => (b.constraints ?? []).map((c) => ({ b, c })));
    if (cons.length) {
      const ref = cx.call(
        "rig.constrain",
        {
          rigId: cx.layer(clip.id),
          add: cons.map(({ b, c }) => ({
            bone: b.name,
            type: c.type,
            target: c.target.kind === "bone" ? name(c.target.bone) : [c.target.x, c.target.y, ...(c.target.z !== undefined ? [c.target.z] : [])],
            ...(c.influence !== 1 ? { influence: c.influence } : {}),
            ...(c.enabled ? {} : { enabled: false }),
            ...("radius" in c && c.radius !== null ? { radius: c.radius } : {}),
          })),
        },
        { name: `${clip.name} constraints` },
      );
      cons.forEach(({ c }, i) => cx.bindId(c.id, ref.at("added", i, "id")));
    }
  },
});

registerReifier("shape-keys", {
  phase: "layer",
  order: 25,
  print(clip, cx) {
    const keys = clip.kind === "path" || clip.kind === "mesh" ? (clip.shapeKeys ?? []) : [];
    for (const k of keys) {
      const rel = k.relativeTo ? keys.find((x) => x.id === k.relativeTo)?.name : undefined;
      const ref = cx.call(
        "shapekey.create",
        { id: cx.layer(clip.id), name: k.name, ...(rel ? { relativeTo: rel } : {}), ...(k.value ? { weight: k.value } : {}) },
        { name: `${clip.name} ${k.name} key` },
      );
      cx.bindId(k.id, ref.at("id"));
    }
  },
});

registerReifier("text-ranges", {
  phase: "layer",
  order: 30,
  print(clip, cx) {
    if (clip.kind !== "text") return;
    for (const r of clip.ranges) {
      const style = r.overlay.props;
      if (!Object.keys(style).length) continue;
      cx.call("text.style", { id: cx.layer(clip.id), start: r.start, end: r.end, style });
    }
  },
});

registerReifier("animations", {
  phase: "layer",
  order: 40,
  print(clip, cx) {
    if (clip.kind === "audio") return;
    if (clip.kind === "text") {
      for (const slot of ["in", "out"] as const) {
        const spec = clip.animations[slot];
        if (!spec) continue;
        const values = changed(spec, specFromPreset(spec.preset), ["preset"]);
        const allowed = ["durationMs", "delayMs", "staggerMs", "unit", "easing", "jitterMs", "params"];
        const input: Record<string, unknown> = {};
        for (const k of allowed) if (k in values) input[k] = k === "easing" ? easingText(values[k] as Easing) : values[k];
        cx.call("animation.set", { id: cx.layer(clip.id), slot, preset: spec.preset, target: "text", ...input });
      }
    }
    for (const [slot, spec] of [["in", clip.animIn], ["out", clip.animOut]] as const) {
      if (!spec) continue;
      const values = changed(spec, layerSpecFromPreset(spec.preset), ["preset"]);
      cx.call("animation.set", {
        id: cx.layer(clip.id),
        slot,
        preset: spec.preset,
        target: "layer",
        ...("durationMs" in values ? { durationMs: values.durationMs } : {}),
        ...("easing" in values ? { easing: easingText(values.easing as Easing) } : {}),
        ...("params" in values ? { params: values.params } : {}),
      });
    }
  },
});

registerReifier("poses", {
  phase: "layer",
  order: 50,
  print(clip, cx) {
    if (clip.kind !== "group" || !clip.poses?.length) return;
    for (const set of clip.poses) {
      const blend = set.blend as { ms?: number; ease?: Easing } | undefined;
      const ref = cx.call(
        "poses.create",
        {
          groupId: cx.layer(clip.id),
          name: set.name,
          ...(set.vocabulary !== undefined ? { vocabulary: set.vocabulary } : {}),
          poses: set.poses.map((p) => ({ name: p.name, values: p.values.map((v) => ({ clipId: v.clipId, path: v.path, value: v.value })) })),
          ...(blend ? { blend: { ...(blend.ms !== undefined ? { ms: blend.ms } : {}), ...(blend.ease ? { ease: easingText(blend.ease) } : {}) } } : {}),
        },
        { name: `${clip.name} ${set.name} poses` },
      );
      cx.bindId(set.id, ref.at("setId"));
    }
  },
});

function keysInput(track: KeyframeTrack): Array<Record<string, unknown>> {
  return track.keys.map((k) => ({ at: k.timeMs, value: k.value, ...(same(k.easing, DEFAULT_EASE) ? {} : { easing: easingText(k.easing) }) }));
}

/**
 * A CURVED motion path as one `position` call. Its curve handles live on the x
 * key (`Keyframe.spatial`), which two separate x/y calls cannot carry — the
 * path came back straight. Only aligned pairs (same times, same easing — what
 * the motion ops write) qualify; anything else prints as two tracks.
 */
function curvedPosition(clip: Clip): { x: KeyframeTrack; y: KeyframeTrack } | null {
  const x = clip.keyframes.find((t) => !t.range && t.property === "x" && t.keys.length);
  const y = clip.keyframes.find((t) => !t.range && t.property === "y" && t.keys.length);
  if (!x || !y || !x.keys.some((k) => k.spatial && (k.spatial.in || k.spatial.out))) return null;
  if (x.keys.length !== y.keys.length) return null;
  const aligned = x.keys.every((k, i) => Math.abs(k.timeMs - y.keys[i]!.timeMs) < 0.5 && same(k.easing, y.keys[i]!.easing));
  return aligned && x.keys.every((k) => typeof k.value === "number") && y.keys.every((k) => typeof k.value === "number") ? { x, y } : null;
}

registerReifier("keyframes", {
  phase: "layer",
  order: 60,
  print(clip, cx) {
    const pos = curvedPosition(clip);
    if (pos) {
      const keys = pos.x.keys.map((k, i) => ({
        at: k.timeMs,
        value: [k.value, pos.y.keys[i]!.value],
        ...(same(k.easing, DEFAULT_EASE) ? {} : { easing: easingText(k.easing) }),
        ...(k.spatial?.in ? { in: [k.spatial.in.x, k.spatial.in.y] } : {}),
        ...(k.spatial?.out ? { out: [k.spatial.out.x, k.spatial.out.y] } : {}),
      }));
      cx.call("keyframes.set", { id: cx.layer(clip.id), property: "position", keys });
    }
    for (const t of clip.keyframes) {
      if (!t.keys.length || (pos && (t === pos.x || t === pos.y))) continue;
      cx.call("keyframes.set", { id: cx.layer(clip.id), property: t.property, ...(t.range ? { range: t.range } : {}), keys: keysInput(t) });
    }
  },
});

/** Expressions shared by several properties: the first binding names it, the rest reuse it. */
const sharedExpr = new WeakMap<object, Map<string, Ref>>();

registerReifier("expressions", {
  phase: "layer",
  order: 70,
  print(clip, cx) {
    let seen = sharedExpr.get(cx);
    if (!seen) sharedExpr.set(cx, (seen = new Map()));
    for (const [property, token] of Object.entries(clip.drivers ?? {})) {
      if (!token.startsWith("fx:")) continue; // node graphs and variables ride the residual
      const expr = cx.doc.expressions.find((e) => e.id === token.slice(3));
      if (!expr) continue;
      const prior = seen.get(expr.id);
      const defaultName = `${clip.name} · ${property}`;
      const ref = cx.call(
        "expression.set",
        {
          id: cx.layer(clip.id),
          property,
          source: expr.source,
          ...(prior ? { expressionId: prior } : expr.name !== defaultName ? { name: expr.name } : {}),
        },
        { name: `${clip.name} ${property} fx` },
      );
      if (!prior) seen.set(expr.id, ref.at("expressionId"));
    }
  },
});

registerReifier("physics", {
  phase: "layer",
  order: 80,
  print(clip, cx) {
    if (clip.kind === "audio") return;
    if (clip.physics) {
      const values = changed(clip.physics, physicsSchema.parse({ type: clip.physics.type }), ["type"]);
      cx.call("physics.body", { ids: cx.layer(clip.id), type: clip.physics.type, ...values });
    }
    if (clip.joints?.length) {
      cx.call("physics.joint", { id: cx.layer(clip.id), add: clip.joints.map(({ id: _id, ...j }) => (void _id, j)) });
    }
  },
});

// ── Comp aspects (a whole comp the code creates) ─────────────────────────────

const compRef = (frame: Frame, cx: ReifyContext) => cx.frame ?? cx.outside("frame", frame.id);

registerReifier("inputs", {
  phase: "comp",
  order: 10,
  comp(frame, cx) {
    for (const def of frame.inputs ?? []) {
      const { id, ...rest } = def;
      const ref = cx.call("component.inputs", { action: "define", frameId: compRef(frame, cx), def: rest }, { name: `${def.name} input` });
      cx.bindId(id, ref.at("inputId"));
    }
  },
});

function printMachine(frame: Frame, machineId: string, cx: ReifyContext): boolean {
  const m = frame.machines?.find((x) => x.id === machineId || x.name === machineId);
  if (!m) return false;
  cx.call("machine.create", { ...machineSpec(frame, m, cx.doc), frameId: compRef(frame, cx) });
  return true;
}

registerReifier("machine", {
  phase: "comp",
  order: 20,
  comp(frame, cx) {
    for (const m of frame.machines ?? []) printMachine(frame, m.id, cx);
  },
  part: printMachine,
});

registerReifier("simulation", {
  phase: "comp",
  order: 30,
  comp(frame, cx) {
    if (frame.physics) cx.call("physics.scene", { frameId: compRef(frame, cx), ...frame.physics });
  },
});
