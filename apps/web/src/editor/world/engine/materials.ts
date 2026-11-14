import * as THREE from "three";
import type { Material, MeshClip, MeshPart, Paint, ShadingMode } from "@solomotion/core";
import { drawPaintInto, type ColorResolver } from "../../stage/render/paint-style";
import { getImageForAsset } from "../../stage/render/media-cache";

/**
 * SURFACES — a mesh clip's look as three.js materials, one per draw group
 * (slot 0 = the object, then one per part). The base colour is the layer's
 * FILLS, through the 2D paint painter: a solid is a colour, a gradient or an
 * image becomes a texture across the mesh's UVs, so a 3D object is coloured
 * with exactly the editor, variables and keys a rectangle is.
 *
 * Materials are updated IN PLACE every sync (an animated roughness costs a few
 * property writes) and rebuilt only when their shader features change.
 */

export interface SurfaceLook {
  material: Material;
  fills: Paint[];
  opacity: number;
}

/** The look of slot 0 and every part, resolved through inheritance (part overrides win). */
export function surfaceLooks(clip: MeshClip, partIds: string[], opacity: number): SurfaceLook[] {
  const base: SurfaceLook = { material: clip.material, fills: clip.fills, opacity };
  return partIds.map((id) => {
    if (!id) return base;
    const part: MeshPart | undefined = clip.parts.find((p) => p.id === id);
    if (!part) return base;
    return {
      material: { ...clip.material, ...(part.material ?? {}) } as Material,
      fills: part.fills ?? clip.fills,
      opacity,
    };
  });
}

const textureCache = new Map<string, THREE.CanvasTexture>();

/** A fills stack that is a plain colour, or null when it needs a texture. */
function solidOf(fills: Paint[], resolve: ColorResolver): { color: string; opacity: number } | null {
  const visible = fills.filter((f) => f.enabled !== false);
  if (visible.length === 0) return { color: "#cccccc", opacity: 1 };
  const top = resolve.paint(visible[visible.length - 1]!);
  if (visible.length === 1 && top.type === "solid") return { color: resolve(top.color), opacity: top.opacity };
  if (visible.every((f) => resolve.paint(f).type === "solid")) {
    // Several solids: the top one, unless it is translucent — then let the painter mix.
    if (top.type === "solid" && top.opacity >= 1) return { color: resolve(top.color), opacity: 1 };
  }
  return null;
}

/** Paint a fills stack into a square texture (gradients and images across UV space). */
function fillsTexture(fills: Paint[], resolve: ColorResolver): THREE.CanvasTexture {
  const key = JSON.stringify(fills);
  let tex = textureCache.get(key);
  if (tex) return tex;
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  for (const f of fills) {
    if (f.enabled === false) continue;
    drawPaintInto(ctx, f, { x: 0, y: 0, w: size, h: size }, resolve, (id) => getImageForAsset(id));
  }
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  if (textureCache.size > 64) {
    const first = textureCache.keys().next().value!;
    textureCache.get(first)?.dispose();
    textureCache.delete(first);
  }
  textureCache.set(key, tex);
  return tex;
}

const toonRamps = new Map<number, THREE.DataTexture>();
function toonRamp(steps: number): THREE.DataTexture {
  let t = toonRamps.get(steps);
  if (!t) {
    const data = new Uint8Array(steps * 4);
    for (let i = 0; i < steps; i++) {
      const v = Math.round((i / (steps - 1)) * 255);
      data.set([v, v, v, 255], i * 4);
    }
    t = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    toonRamps.set(steps, t);
  }
  return t;
}

/** Build or refresh one slot's material for a shading mode. */
export function updateSurface(
  prev: THREE.Material | undefined,
  look: SurfaceLook,
  shading: ShadingMode,
  resolve: ColorResolver,
  fileMaterial: boolean,
  /** A comp texture that replaces the fills (it is the surface's paint). */
  texture: THREE.Texture | null = null,
): THREE.Material {
  const m = look.material;
  const solid = texture ? null : solidOf(look.fills, resolve);
  const map = texture ?? (solid ? null : fillsTexture(look.fills, resolve));
  const color = new THREE.Color(solid ? solid.color : "#ffffff");
  const alpha = look.opacity * (solid ? solid.opacity : 1);
  const side = m.doubleSided ? THREE.DoubleSide : THREE.FrontSide;

  if (shading === "solid" || shading === "wireframe") {
    // Blender's Solid: the object colour, matte, lit by a fixed studio.
    const mat = prev instanceof THREE.MeshStandardMaterial && !(prev instanceof THREE.MeshPhysicalMaterial) ? prev : new THREE.MeshStandardMaterial();
    mat.color.copy(color);
    // Solid view shows a painted texture too (Blender's "Texture" colour).
    if (mat.map !== texture) mat.needsUpdate = true;
    mat.map = texture;
    mat.roughness = 0.7;
    mat.metalness = 0;
    mat.side = side;
    mat.transparent = alpha < 1;
    mat.opacity = alpha;
    mat.emissive.set(0x000000);
    return mat;
  }
  if (fileMaterial) return prev ?? new THREE.MeshStandardMaterial({ color });

  if (m.model === "unlit") {
    const mat = prev instanceof THREE.MeshBasicMaterial ? prev : new THREE.MeshBasicMaterial();
    if (mat.map !== map) mat.needsUpdate = true;
    mat.color.copy(color);
    mat.map = map;
    mat.side = side;
    mat.transparent = alpha < 1;
    mat.opacity = alpha;
    return mat;
  }
  if (m.model === "toon") {
    const mat = prev instanceof THREE.MeshToonMaterial ? prev : new THREE.MeshToonMaterial();
    if (mat.map !== map) mat.needsUpdate = true;
    mat.color.copy(color);
    mat.map = map;
    mat.gradientMap = toonRamp(m.toonSteps);
    mat.emissive.set(m.emission);
    mat.emissiveIntensity = m.emissionStrength;
    mat.side = side;
    mat.transparent = alpha < 1;
    mat.opacity = alpha;
    return mat;
  }
  const mat = prev instanceof THREE.MeshPhysicalMaterial ? prev : new THREE.MeshPhysicalMaterial();
  // Features that change the SHADER: flip needsUpdate only when they flip.
  const sig = `${!!map}|${m.transmission > 0}|${m.clearcoat > 0}|${m.sheen > 0}|${m.iridescence > 0}|${side}`;
  if (mat.userData.sig !== sig) {
    mat.userData.sig = sig;
    mat.needsUpdate = true;
  }
  mat.color.copy(color);
  mat.map = map;
  mat.roughness = m.roughness;
  mat.metalness = m.metalness;
  mat.emissive.set(m.emission);
  mat.emissiveIntensity = m.emissionStrength;
  mat.transmission = m.transmission;
  mat.ior = m.ior;
  mat.thickness = m.thickness * 0.01;
  mat.clearcoat = m.clearcoat;
  mat.clearcoatRoughness = m.clearcoatRoughness;
  mat.sheen = m.sheen;
  mat.sheenColor.set("#ffffff");
  mat.iridescence = m.iridescence;
  mat.side = side;
  mat.transparent = alpha < 1;
  mat.opacity = alpha;
  return mat;
}

/** A picture's texture as the plane material wants it: premultiplied (see `planeMaterial`). */
export function premultipliedPicture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.premultiplyAlpha = true;
  return t;
}

/**
 * The picture material for a 2D layer standing in the world: its exact
 * colours, unlit. `layerOrder` (higher = above) pulls coplanar layers toward
 * the eye by a hair, so a layout made 3D keeps its stacking where layers still
 * share a plane, while real depth wins everywhere else.
 */
export function planeMaterial(prev: THREE.Material | undefined, texture: THREE.Texture, opacity: number, layerOrder = 0): THREE.MeshBasicMaterial {
  // Only reuse a material this function made: a bare `Mesh` starts with a
  // default (opaque) MeshBasicMaterial, which would draw the picture's clear
  // pixels as black.
  //
  // PREMULTIPLIED, as the picture itself is (`premultipliedPicture`): a
  // straight-alpha texture filters its clear texels' black into every edge, so
  // a thin light stroke or a small title went grey as soon as it was seen
  // small (mipmaps average it in). Blending ONE / 1−α over premultiplied
  // texels is exactly what straight blending gave inside the picture, and the
  // canvas's own compositing at its edges; opacity scales the colour with it.
  const mat =
    prev instanceof THREE.MeshBasicMaterial && prev.userData.plane
      ? prev
      : Object.assign(
          new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide,
            transparent: true,
            depthWrite: true,
            alphaTest: 0.004,
            toneMapped: false,
            polygonOffset: true,
            blending: THREE.CustomBlending,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
          }),
          { userData: { plane: true } },
        );
  mat.color.setScalar(opacity);
  mat.polygonOffsetFactor = 0;
  mat.polygonOffsetUnits = -2 * layerOrder;
  if (mat.map !== texture) {
    mat.map = texture;
    mat.needsUpdate = true;
  }
  mat.opacity = opacity;
  return mat;
}
