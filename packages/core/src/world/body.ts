import { contoursAreDeep } from "../vector/geometry";
import type { Clip, ExtrudeSpec, Material, MeshData, Modifier, VisualClip } from "../schema";
import type { V3 } from "./math";
import { materialSchema } from "../schema/world";
import { meshBounds, refineMesh } from "./mesh";
import { activeModifiers, stackDetail, stackOnto, type StackEnv } from "./modifiers";
import { bevelMesh } from "./bevel";

/**
 * A LAYER'S BODY — what a 2D layer is made of when it stands in a world.
 *
 * Blender's rule, that every object has a mesh and a modifier stack and a
 * material whatever it started as, applied to the app's layers: a text, a logo,
 * a photo, a video, a nested comp. By default the body is the cheapest thing
 * that can be: the layer's picture on a card, drawn exactly as the flat canvas
 * draws it. It becomes a real mesh only when asked to:
 *
 *   thickness  (`extrude`)    — a slab or an outline solid, bevelled
 *   material   (`material`)   — lit, glossy, metal, glass, toon…
 *   modifiers  (`modifiers`)  — bend, twist, wave, array, particles…
 *
 * Every body is built in the layer's own space (pivot at the origin, layer px,
 * the picture on the local XZ plane facing −Y, depth along +Y — `planeToLocal`)
 * and carries its unwrap in layer px, so the picture lands on the surface
 * wherever modifiers take it. What needs a renderer (a font's glyphs, a
 * picture's transparency) the renderer supplies as an outline; everything
 * else is here, headless.
 */

/** Every 2D kind that stands in a world as a picture — and so can have thickness, a material and modifiers. */
export const BODY_KINDS = ["text", "shape", "path", "image", "video", "nested", "raster", "waveform"] as const;
export type BodyKind = (typeof BODY_KINDS)[number];

export function isBodyKind(kind: string): kind is BodyKind {
  return (BODY_KINDS as readonly string[]).includes(kind);
}

/** A 2D layer that can stand in a world as a body. */
export function isBodyClip(clip: Clip): clip is VisualClip {
  return isBodyKind(clip.kind);
}

/** Kinds whose outline is their own geometry (exact for free). */
export const VECTOR_BODY_KINDS: ReadonlySet<string> = new Set(["text", "shape", "path"]);
/** Pictures that hold still, so tracing their silhouette once is cheap. */
const STILL_KINDS: ReadonlySet<string> = new Set(["image", "raster"]);

export type BodyFit = NonNullable<ExtrudeSpec["fit"]>;

/**
 * A path whose stack STARTS by revolving it (Screw) is a lathe profile: its
 * body is the outline as loose edges, turned into a surface — a vase, a glass —
 * not its picture on a card.
 */
export function bodyIsRevolved(clip: Clip): boolean {
  return clip.kind === "path" && layerModifiers(clip).find((m) => m.enabled)?.type === "screw";
}

/**
 * A path whose points have DEPTH and that has a stroke is a stroke in SPACE:
 * its body is a tube along the curve (`strokeTube`), sized by the stroke's
 * width and its pressure profile.
 */
export function bodyIsTube(clip: Clip): boolean {
  return clip.kind === "path" && !bodyIsRevolved(clip) && contoursAreDeep(clip.subpaths) && clip.strokes.some((st) => st.enabled !== false && st.width > 0);
}

/** The thickness a layer has at this instant, or null for a flat picture. */
export function bodyThickness(clip: Clip): ExtrudeSpec | null {
  if (!isBodyKind(clip.kind)) return null;
  const e = (clip as VisualClip).extrude;
  return e && e.depth > 0 ? e : null;
}

/** How the thickness follows the layer: exact outline for vectors and stills, a box for what moves on its own. */
export function bodyFit(clip: Clip): BodyFit {
  const own = (clip as VisualClip).extrude?.fit;
  if (own) return own;
  return VECTOR_BODY_KINDS.has(clip.kind) || STILL_KINDS.has(clip.kind) ? "outline" : "box";
}

const FLAT_MATERIAL: Material = Object.freeze(materialSchema.parse({ model: "unlit" })) as Material;
const SOLID_MATERIAL: Material = Object.freeze(materialSchema.parse({ roughness: 0.35 })) as Material;

/**
 * The surface a layer has in a world. A mesh's own; a 2D layer's own when it
 * set one, else the default that keeps it honest: a flat picture shows its
 * exact colours (unlit — it IS the 2D layer), a thick one is lit like an
 * object (or it would read as a cut-out, not a solid).
 */
export function layerMaterial(clip: VisualClip): Material {
  if (clip.kind === "mesh") return clip.material;
  return clip.material ?? (bodyThickness(clip) || bodyIsRevolved(clip) ? SOLID_MATERIAL : FLAT_MATERIAL);
}

/** The modifier stack a layer carries (a mesh's, or a 2D layer's — absent is none). */
export function layerModifiers(clip: Clip): readonly Modifier[] {
  return (clip as VisualClip).modifiers ?? [];
}

/** Does a 2D layer need a mesh of its own, or is the picture card enough? */
export function needsBody(clip: VisualClip): boolean {
  // Line art needs edges to draw: a flat text's are its glyph outlines.
  return !!bodyThickness(clip) || !!clip.material || !!clip.lineArt || layerModifiers(clip).some((m) => m.enabled);
}

export interface BodyRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The CARD — the picture's rectangle as a mesh. Flat (`depth` 0) it is one
 * face; thick, a slab: the face where the picture stood, a back that shows it
 * through (as a printed card does), and sides. The sides are their own part
 * ("side") so they can wear a colour; their unwrap runs along the rim, so
 * left to the picture they draw its edge pixels back along the depth.
 */
export function cardMesh(r: BodyRect, depth: number): MeshData {
  const ring: Array<[number, number]> = [
    [r.minX, r.minY],
    [r.maxX, r.minY],
    [r.maxX, r.maxY],
    [r.minX, r.maxY],
  ];
  const positions: number[] = [];
  const uv: number[] = [];
  for (const y of depth > 0 ? [0, depth] : [0]) {
    for (const [u, v] of ring) {
      positions.push(u, y, -v);
      uv.push(u, v);
    }
  }
  // [0, 3, 2, 1] faces −Y: the front, where the flat picture was.
  if (depth <= 0) return { positions, faces: [[0, 3, 2, 1]], uv };
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7]];
  const faceParts = ["", ""];
  const front = [0, 3, 2, 1];
  for (let i = 0; i < 4; i++) {
    const a = front[i]!, b = front[(i + 1) % 4]!;
    faces.push([b, a, a + 4, b + 4]);
    faceParts.push("side");
  }
  return { positions, faces, faceParts, uv };
}

/** A thick card with its edges rounded — the bevel modifier's own kernel. */
export function bevelledCard(r: BodyRect, spec: ExtrudeSpec): MeshData {
  const card = cardMesh(r, spec.depth);
  const w = Math.min(spec.bevel, spec.depth / 2 - 0.01, (r.maxX - r.minX) / 2 - 0.01, (r.maxY - r.minY) / 2 - 0.01);
  return w > 0 ? bevelMesh(card, w, spec.bevelSegments, 30) : card;
}

const refined = new Map<string, MeshData>();

/**
 * A body's base mesh through its modifiers. A stack that BENDS (twist, bend,
 * wave…) first gets points along the surface (`refineMesh`) — a card is two
 * triangles and a letter's cap a fan of slivers, and nobody should have to
 * know to add a Subdivision before a Bend for a picture to curl.
 */
export function bodyThroughStack(base: MeshData, key: string, modifiers: readonly Modifier[], localMs: number, env: StackEnv = {}): { key: string; mesh: MeshData } {
  const detail = stackDetail(activeModifiers(modifiers, env));
  if (!detail) return stackOnto(base, key, modifiers, localMs, env);
  const rkey = `${key}|refined${detail}`;
  let dense = refined.get(rkey);
  if (!dense) {
    const b = meshBounds(base);
    const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    // ~32 points across the longest side bends smoothly at any size (a
    // displacement asks for more); the cap keeps a long text from growing past
    // what a frame can afford.
    dense = refineMesh(base, Math.max(1, span / detail), detail > 64 ? 40000 : 20000);
    if (refined.size > 48) refined.delete(refined.keys().next().value!);
    refined.set(rkey, dense);
  }
  return stackOnto(dense, rkey, modifiers, localMs, env);
}

/** A path's outline as a lathe profile: its points with loose edges between them (`MeshData.lines`). */
export function profileMesh(points: readonly V3[]): MeshData {
  const positions = points.flatMap((p) => [p[0], p[1], p[2]]);
  const lines: number[] = [];
  for (let i = 0; i + 1 < points.length; i++) lines.push(i, i + 1);
  return { positions, faces: [], lines };
}
