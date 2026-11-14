import type { CameraClip, Clip, KeyframeValue, LightClip, Material, MeshClip, Modifier, VisualClip } from "../schema";
import type { AnimatablePropertyDef } from "../animation/properties";
import { isReferenceField } from "../animation/effect-base";
import { extrudeSchema, lineArtSchema } from "../schema/world";
import { BODY_KINDS, isBodyKind, layerMaterial } from "./body";
import { PRIMITIVES, primitiveDef } from "./primitives";
import { MODIFIER_PATH, MODIFIERS, modifierDef, modifierValue } from "./modifiers";

/**
 * THE 3D FIELD REGISTRY — every animatable value the 3D kinds own, as rows
 * with their own reader and writer, so `properties.ts` and `paths.ts` each
 * delegate ONE call here instead of growing a `case` per field. A new camera
 * or light field is one row; the inspector, the curve editor, record mode,
 * drivers, modulators, the node board and `layer.set` all see it.
 *
 * Synthesized families: `geometry.<param>` (a primitive's params — any
 * primitive in the registry) and `mdf.<id>.<field>` (a modifier's fields, on
 * a mesh or on any 2D layer's body).
 */

interface FieldRow {
  def: AnimatablePropertyDef;
  get(clip: Clip): KeyframeValue | undefined;
  set(clip: Clip, value: KeyframeValue): void;
}

const isCam = (c: Clip): c is CameraClip => c.kind === "camera";
const isLight = (c: Clip): c is LightClip => c.kind === "light";
const isMesh = (c: Clip): c is MeshClip => c.kind === "mesh";
/** Anything with a surface in a world: a mesh, or a 2D layer's body. */
const SURFACE_KINDS = ["mesh", ...BODY_KINDS] as const;
const hasSurface = (c: Clip): c is VisualClip => c.kind === "mesh" || isBodyKind(c.kind);
/** Where modifier paths read and write — a mesh's stack, or a body's (made on first write). */
const stackOf = (c: Clip): Modifier[] | undefined => (hasSurface(c) ? (c as VisualClip).modifiers : undefined);

function numberRow<C extends Clip>(
  key: string,
  label: string,
  group: AnimatablePropertyDef["group"],
  kind: C["kind"],
  is: (c: Clip) => c is C,
  read: (c: C) => number,
  write: (c: C, v: number) => void,
  identity: number,
  range: { min?: number; max?: number; step?: number } = {},
): FieldRow {
  return {
    def: { key, label, kind: "number", group, identity, compose: "replace", appliesTo: [kind], ...range },
    get: (c) => (is(c) ? read(c) : undefined),
    set: (c, v) => {
      if (!is(c) || typeof v !== "number" || !Number.isFinite(v)) return;
      let x = v;
      if (range.min !== undefined) x = Math.max(range.min, x);
      if (range.max !== undefined) x = Math.min(range.max, x);
      write(c, x);
    },
  };
}

function colorRow<C extends Clip>(
  key: string,
  label: string,
  group: AnimatablePropertyDef["group"],
  kind: C["kind"],
  is: (c: Clip) => c is C,
  read: (c: C) => string,
  write: (c: C, v: string) => void,
  identity: string,
): FieldRow {
  return {
    def: { key, label, kind: "color", group, identity, compose: "replace", appliesTo: [kind] },
    get: (c) => (is(c) ? read(c) : undefined),
    set: (c, v) => {
      if (is(c) && typeof v === "string") write(c, v);
    },
  };
}

const cam = (key: keyof CameraClip["camera"] & string, label: string, identity: number, range: { min?: number; max?: number; step?: number }) =>
  numberRow(`camera.${key}`, label, "camera", "camera", isCam, (c) => c.camera[key] as number, (c, v) => void ((c.camera as Record<string, unknown>)[key] = v), identity, range);
const light = (key: keyof LightClip["light"] & string, label: string, identity: number, range: { min?: number; max?: number; step?: number }) =>
  numberRow(`light.${key}`, label, "light", "light", isLight, (c) => c.light[key] as number, (c, v) => void ((c.light as Record<string, unknown>)[key] = v), identity, range);
/**
 * A MATERIAL field — on a mesh, and on any 2D layer in a world. A layer that
 * has not set a material reads the one it shows (`layerMaterial`), and its
 * first write makes that its own, so keying Roughness on a photo is the same
 * gesture as on a cube.
 */
function surfaceRow(key: keyof Material & string, label: string, kind: "number" | "color", identity: number | string, range: { min?: number; max?: number; step?: number } = {}): FieldRow {
  return {
    def: { key: `material.${key}`, label, kind, group: "material", identity, compose: "replace", appliesTo: [...SURFACE_KINDS], ...range },
    get: (c) => (hasSurface(c) ? (layerMaterial(c)[key] as KeyframeValue) : undefined),
    set: (c, v) => {
      if (!hasSurface(c)) return;
      let x: unknown = v;
      if (kind === "color") {
        if (typeof v !== "string") return;
      } else {
        if (typeof v !== "number" || !Number.isFinite(v)) return;
        let n = v;
        if (range.min !== undefined) n = Math.max(range.min, n);
        if (range.max !== undefined) n = Math.min(range.max, n);
        x = n;
      }
      if (!c.material) c.material = { ...layerMaterial(c) };
      (c.material as Record<string, unknown>)[key] = x;
    },
  };
}
const mat = (key: keyof Material & string, label: string, identity: number, range: { min?: number; max?: number; step?: number }) => surfaceRow(key, label, "number", identity, range);

function extrudeRow(key: "depth" | "bevel", label: string, identity: number, range: { min?: number; max?: number; step?: number }): FieldRow {
  return {
    def: { key: `extrude.${key}`, label, kind: "number", group: "geometry", identity, compose: "replace", appliesTo: [...BODY_KINDS], ...range },
    get: (c) => (isBodyKind(c.kind) ? ((c as VisualClip).extrude?.[key] ?? (key === "depth" ? 0 : identity)) : undefined),
    set: (c, v) => {
      if (!isBodyKind(c.kind) || typeof v !== "number" || !Number.isFinite(v)) return;
      let x = v;
      if (range.min !== undefined) x = Math.max(range.min, x);
      if (range.max !== undefined) x = Math.min(range.max, x);
      const b = c as VisualClip;
      b.extrude = { ...(b.extrude ?? extrudeSchema.parse({ depth: 0 })), [key]: x };
    },
  };
}

/** A layer body's line art (`lineArt`) — keyed like any field; keying one on a layer without line art gives it some. */
function lineArtRow(key: "width" | "opacity" | "color", label: string, identity: number | string, range: { min?: number; max?: number; step?: number } = {}): FieldRow {
  const kind = key === "color" ? "color" : "number";
  return {
    def: { key: `lineArt.${key}`, label, kind, group: "material", identity, compose: "replace", appliesTo: [...BODY_KINDS], ...range },
    get: (c) => (isBodyKind(c.kind) ? (c as VisualClip).lineArt?.[key] : undefined),
    set: (c, v) => {
      if (!isBodyKind(c.kind)) return;
      let x: number | string;
      if (kind === "color") {
        if (typeof v !== "string") return;
        x = v;
      } else {
        if (typeof v !== "number" || !Number.isFinite(v)) return;
        x = Math.min(range.max ?? Infinity, Math.max(range.min ?? -Infinity, v));
      }
      const b = c as VisualClip;
      b.lineArt = { ...(b.lineArt ?? lineArtSchema.parse({})), [key]: x };
    },
  };
}

const ROWS: FieldRow[] = [
  lineArtRow("width", "Line width", 2, { min: 0, max: 64, step: 0.5 }),
  lineArtRow("opacity", "Line opacity", 1, { min: 0, max: 1, step: 0.01 }),
  lineArtRow("color", "Line colour", "#111111"),
  extrudeRow("depth", "Depth", 0, { min: 0, step: 1 }),
  extrudeRow("bevel", "Bevel", 0, { min: 0, step: 0.5 }),
  cam("focalLength", "Focal length", 50, { min: 1, max: 5000, step: 1 }),
  cam("orthoScale", "Ortho scale", 1000, { min: 0.01, step: 1 }),
  cam("shiftX", "Shift X", 0, { min: -2, max: 2, step: 0.001 }),
  cam("shiftY", "Shift Y", 0, { min: -2, max: 2, step: 0.001 }),
  cam("clipStart", "Clip start", 1, { min: 0.001, step: 0.1 }),
  cam("clipEnd", "Clip end", 100000, { min: 1, step: 10 }),
  numberRow("camera.dof.focusDistance", "Focus distance", "camera", "camera", isCam, (c) => c.camera.dof.focusDistance, (c, v) => void (c.camera.dof.focusDistance = v), 1000, { min: 0.01, step: 1 }),
  numberRow("camera.dof.fStop", "F-stop", "camera", "camera", isCam, (c) => c.camera.dof.fStop, (c, v) => void (c.camera.dof.fStop = v), 2.8, { min: 0.1, max: 128, step: 0.1 }),

  colorRow("light.color", "Color", "light", "light", isLight, (c) => c.light.color, (c, v) => void (c.light.color = v), "#ffffff"),
  light("intensity", "Power", 1000, { min: 0, step: 1 }),
  light("range", "Range", 0, { min: 0, step: 1 }),
  light("spotAngle", "Spot size", 45, { min: 1, max: 179, step: 0.5 }),
  light("spotBlend", "Spot blend", 0.15, { min: 0, max: 1, step: 0.01 }),
  light("width", "Width", 100, { min: 0.01, step: 1 }),
  light("height", "Height", 100, { min: 0.01, step: 1 }),
  colorRow("light.groundColor", "Ground color", "light", "light", isLight, (c) => c.light.groundColor, (c, v) => void (c.light.groundColor = v), "#2b2a28"),
  light("shadowSoftness", "Shadow softness", 2, { min: 0, max: 20, step: 0.1 }),

  mat("roughness", "Roughness", 0.5, { min: 0, max: 1, step: 0.01 }),
  mat("metalness", "Metallic", 0, { min: 0, max: 1, step: 0.01 }),
  surfaceRow("emission", "Emission", "color", "#000000"),
  mat("emissionStrength", "Emission strength", 1, { min: 0, max: 100, step: 0.1 }),
  mat("transmission", "Transmission", 0, { min: 0, max: 1, step: 0.01 }),
  mat("ior", "IOR", 1.45, { min: 1, max: 2.5, step: 0.01 }),
  mat("thickness", "Thickness", 0, { min: 0, step: 1 }),
  mat("clearcoat", "Coat", 0, { min: 0, max: 1, step: 0.01 }),
  mat("clearcoatRoughness", "Coat roughness", 0.1, { min: 0, max: 1, step: 0.01 }),
  mat("sheen", "Sheen", 0, { min: 0, max: 1, step: 0.01 }),
  mat("iridescence", "Iridescence", 0, { min: 0, max: 1, step: 0.01 }),
  numberRow("smoothAngle", "Auto angle", "geometry", "mesh", isMesh, (c) => c.smoothAngle, (c, v) => void (c.smoothAngle = v), 30, { min: 0, max: 180, step: 1 }),
];

const byKey = new Map(ROWS.map((r) => [r.def.key, r]));

/** The static 3D defs, for the registry's own table. */
export const WORLD_PROPERTY_DEFS: AnimatablePropertyDef[] = ROWS.map((r) => r.def);

const GEOMETRY_PATH = /^geometry\.([A-Za-z0-9_]+)$/;

/** Synthesized defs: `geometry.<param>` and `mdf.<id>.<field>`. */
export function worldPropertyDef(key: string): AnimatablePropertyDef | undefined {
  const g = GEOMETRY_PATH.exec(key);
  if (g) {
    // The param's label and range from the first primitive that declares it;
    // the range widens over every declaration so no curve clamps a legal value.
    let def: AnimatablePropertyDef | undefined;
    for (const p of PRIMITIVES) {
      const param = p.params.find((x) => x.key === g[1]);
      if (!param) continue;
      if (!def) {
        def = { key, label: param.label, kind: "number", group: "geometry", identity: param.default, compose: "replace", appliesTo: ["mesh"], min: param.min, max: param.max, step: param.step };
      } else {
        if (param.min !== undefined) def.min = def.min === undefined ? param.min : Math.min(def.min, param.min);
        if (param.max !== undefined) def.max = def.max === undefined ? param.max : Math.max(def.max, param.max);
      }
    }
    return def;
  }
  const m = MODIFIER_PATH.exec(key);
  if (m) {
    const field = m[2]!;
    if (field === "enabled") return { key, label: "Enabled", kind: "discrete", group: "geometry", identity: true, compose: "replace", appliesTo: [...SURFACE_KINDS] };
    for (const t of MODIFIERS) {
      const f = t.fields.find((x) => x.key === field);
      if (!f) continue;
      return {
        key,
        label: f.label,
        kind: f.kind === "select" || isReferenceField(f.kind) ? "discrete" : f.kind,
        group: "geometry",
        identity: f.default,
        compose: "replace",
        appliesTo: [...SURFACE_KINDS],
        min: f.min,
        max: f.max,
        step: f.step,
      };
    }
  }
  return undefined;
}

/**
 * Is this a path the 3D registry answers on this clip? Everything on a
 * camera, a light or a mesh; on a 2D layer, its body's own families
 * (thickness, surface, modifiers) — the rest of its paths are 2D's.
 */
export function isWorldPath(clip: Clip, path: string): boolean {
  if (clip.kind === "mesh" || clip.kind === "camera" || clip.kind === "light") return true;
  return isBodyKind(clip.kind) && (path.startsWith("extrude.") || path.startsWith("material.") || path.startsWith("mdf.") || path.startsWith("lineArt."));
}

/** Read a 3D path off a clip; `undefined` when the path is not a 3D one (or not on this instance). */
export function getWorldProperty(clip: Clip, path: string): KeyframeValue | undefined {
  const row = byKey.get(path);
  if (row) return row.get(clip);
  const m = MODIFIER_PATH.exec(path);
  if (m) {
    const mod = stackOf(clip)?.find((x) => x.id === m[1]);
    if (!mod) return undefined;
    if (m[2] === "enabled") return mod.enabled;
    const def = modifierDef(mod.type);
    return def ? modifierValue(mod, def, m[2]!) : undefined;
  }
  if (clip.kind !== "mesh") return undefined;
  const g = GEOMETRY_PATH.exec(path);
  if (g) {
    if (clip.geometry.type !== "primitive") return undefined;
    const def = primitiveDef(clip.geometry.primitive);
    const param = def?.params.find((p) => p.key === g[1]);
    if (!param) return undefined;
    return clip.geometry.params[param.key] ?? param.default;
  }
  return undefined;
}

/** Write a 3D path's base value. Returns false when the path is not a 3D one. */
export function setWorldProperty(clip: Clip, path: string, value: KeyframeValue): boolean {
  const row = byKey.get(path);
  if (row) {
    row.set(clip, value);
    return true;
  }
  const m = MODIFIER_PATH.exec(path);
  if (m && hasSurface(clip)) {
    const mod = stackOf(clip)?.find((x) => x.id === m[1]);
    if (!mod) return true;
    if (m[2] === "enabled") {
      if (typeof value === "boolean") mod.enabled = value;
      return true;
    }
    const key = m[2]!;
    // Identity is not a field: a path may never rename or retype the instance.
    if (key !== "id" && key !== "type" && (typeof value === "number" || typeof value === "string" || typeof value === "boolean")) mod[key] = value;
    return true;
  }
  if (clip.kind !== "mesh") return false;
  const g = GEOMETRY_PATH.exec(path);
  if (g) {
    if (clip.geometry.type === "primitive" && typeof value === "number" && Number.isFinite(value)) {
      clip.geometry.params[g[1]!] = value;
    }
    return true;
  }
  return false;
}

/** Every 3D path THIS instance exposes (a cube's params, its modifiers' fields…). */
export function worldClipPaths(clip: Clip): string[] {
  const out: string[] = [];
  for (const r of ROWS) {
    if (!r.def.appliesTo.includes(clip.kind)) continue;
    // Line art's fields exist once the layer has line art.
    if (r.def.key.startsWith("lineArt.") && !(clip as VisualClip).lineArt) continue;
    out.push(r.def.key);
  }
  if (clip.kind === "mesh" && clip.geometry.type === "primitive") {
    for (const p of primitiveDef(clip.geometry.primitive)?.params ?? []) out.push(`geometry.${p.key}`);
  }
  for (const m of stackOf(clip) ?? []) {
    for (const f of modifierDef(m.type)?.fields ?? []) if (f.kind !== "select" && f.kind !== "layer") out.push(`mdf.${m.id}.${f.key}`);
  }
  return out;
}
