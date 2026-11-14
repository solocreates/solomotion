import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import {
  evaluateGeometry,
  modifierScene,
  bodyIsRevolved,
  bodyIsTube,
  type StackEnv,
  bodyFit,
  bodyThickness,
  layerMaterial,
  needsBody,
  solidPaint,
  VECTOR_BODY_KINDS,
  locateClip,
  worldSourceId,
  type Paint,
  type VisualClip,
  meshBuffers,
  meshEdges,
  type MotionDocument,
  type Frame,
  type LightClip,
  type Mat4,
  type MeshClip,
  type MeshData,
  type ShadingMode,
  type WorldEval,
  type WorldObject,
  type StrokeStyle,
  type LineArt,
  strokeStyle,
} from "@solomotion/core";
import type { ColorResolver } from "../../stage/render/paint-style";
import { planePicture } from "../plane-picture";
import { paintGeneration } from "../paint-gen";
import { drawFrameContent } from "../../stage/render/draw-frame";
import { planeMaterial, premultipliedPicture, surfaceLooks, updateSurface } from "./materials";
import { loadModelTemplate, peekModelTemplate } from "./models";
import { MeshLines } from "./lines";
import { markTransientPicture, notifyPicturesChanged } from "../../stage/render/media-cache";
import { onOutlineReady } from "./extrude";
import { layerBody } from "./body";
import { booleanGeometry, isBooleanMode, unionKeepingLooks, weldToMesh } from "./booleans";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * THE SCENE SYNC — `WorldEval` → a three.js scene, incrementally.
 *
 * One instance per surface that draws a world (a viewport, the picture
 * renderer per comp). Objects are keyed by clip id and kept across syncs;
 * what a sync does per object is proportional to what CHANGED:
 *
 *   matrix        — always (sixteen numbers)
 *   material      — property writes; a rebuild only when shader features flip
 *   geometry      — only when the evaluated-geometry key changes (shared cache)
 *   plane picture — only when the layer's picture key changes
 *
 * The world lives under a ×0.01 root: documents are in centimetres (1 unit =
 * 1 px), three.js lights and shadows are physical in metres.
 */

export const UNIT = 0.01;

let areaLibReady = false;

interface GeometryEntry {
  geometry: THREE.BufferGeometry;
  wire: THREE.BufferGeometry;
  /** Part id per material slot (slot 0 = the object). */
  parts: string[];
  /** Triangle → polygon (picking). */
  triFace: Uint32Array;
  mesh: MeshData;
  users: number;
  last: number;
}

const geometries = new Map<string, GeometryEntry>();
let geoTick = 0;

function geometryFor(key: string, mesh: MeshData, shading: MeshClip["shading"], smoothAngle: number, uv: MeshClip["uv"] = "box"): GeometryEntry {
  const full = `${key}|${shading}|${smoothAngle}|${uv}`;
  let g = geometries.get(full);
  if (g) {
    g.last = ++geoTick;
    return g;
  }
  const b = meshBuffers(mesh, { shading, smoothAngle, uv });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(b.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(b.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(b.uvs, 2));
  const parts = [""];
  for (const grp of b.groups) if (!parts.includes(grp.part)) parts.push(grp.part);
  for (const grp of b.groups) geometry.addGroup(grp.start, grp.count, parts.indexOf(grp.part));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const { list } = meshEdges(mesh);
  const wp = new Float32Array(list.length * 6);
  list.forEach((e, i) => {
    wp.set([mesh.positions[e.a * 3]!, mesh.positions[e.a * 3 + 1]!, mesh.positions[e.a * 3 + 2]!], i * 6);
    wp.set([mesh.positions[e.b * 3]!, mesh.positions[e.b * 3 + 1]!, mesh.positions[e.b * 3 + 2]!], i * 6 + 3);
  });
  const wire = new THREE.BufferGeometry();
  wire.setAttribute("position", new THREE.BufferAttribute(wp, 3));
  g = { geometry, wire, parts, triFace: b.triFace, mesh, users: 0, last: ++geoTick };
  geometries.set(full, g);
  // Evict the least recently used unshared geometries beyond a budget.
  if (geometries.size > 96) {
    const victims = [...geometries.entries()].filter(([, e]) => e.users === 0).sort((a, b) => a[1].last - b[1].last);
    for (const [k, e] of victims.slice(0, geometries.size - 96)) {
      e.geometry.dispose();
      e.wire.dispose();
      geometries.delete(k);
    }
  }
  return g;
}

export interface SyncOptions {
  doc: MotionDocument;
  frame: Frame;
  shading: ShadingMode;
  resolve: ColorResolver;
  /** Picture pixels per layer px for 2D planes. */
  density: number;
  /**
   * Picture pixels per layer px for ONE object, where the view knows better
   * than a constant: the viewport asks for what that plane covers on screen,
   * so a stroke you move close to stays sharp. Absent, `density`.
   */
  densityFor?: (o: WorldObject) => number;
  /** See-through solids (Alt+Z). */
  xray?: boolean;
  /** Objects hidden in this viewport only (H) — never written to the document. */
  localHidden?: ReadonlySet<string>;
  /** Live, uncommitted mesh edits (edit mode / a modal transform on vertices). */
  meshOverride?: ReadonlyMap<string, MeshData>;
  /** The interactive viewport (modifiers switched off for it are skipped). */
  viewport?: boolean;
}

export interface ObjectEntry {
  id: string;
  kind: WorldObject["kind"];
  holder: THREE.Group;
  mesh: THREE.Mesh | null;
  wire: THREE.LineSegments | null;
  geo: GeometryEntry | null;
  geoKey: string;
  materials: THREE.Material[];
  light: THREE.Light | null;
  lightType: string | null;
  plane: { mesh: THREE.Mesh; texture: THREE.CanvasTexture | null; key: string; rect: string } | null;
  model: THREE.Object3D | null;
  /** Strokes drawn on the mesh's edges (Line Art). */
  lines: MeshLines | null;
  seen: number;
  /** The evaluated object this entry last showed. */
  object: WorldObject;
}

const WIRE_COLOR = new THREE.Color("#1d1d1f");

/** A layer's line art as the one stroke the line drawer takes (cached per look, so it is not re-minted each frame). */
const artStrokes = new Map<string, StrokeStyle>();
function lineArtStroke(art: LineArt): StrokeStyle {
  const k = `${art.color}|${art.width}|${art.opacity}`;
  let st = artStrokes.get(k);
  if (!st) {
    st = strokeStyle({ ...solidPaint(art.color), opacity: art.opacity }, { width: art.width });
    if (artStrokes.size > 64) artStrokes.clear();
    artStrokes.set(k, st);
  }
  return st;
}

export class SceneSync {
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();
  readonly entries = new Map<string, ObjectEntry>();
  /** The live environment, for the renderer to apply (PMREMs belong to a renderer). */
  environment: { preset: LightClip["light"]["environment"]; intensity: number; rotationZ: number; showBackground: boolean } | null = null;
  readonly hemisphere = new THREE.HemisphereLight(0xffffff, 0x444444, 0);
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0.03);
  private tick = 0;
  private wireMaterial = new THREE.LineBasicMaterial({ color: WIRE_COLOR, transparent: true, opacity: 0.85 });
  /** Called when something async (a model) arrives and the scene should redraw. */
  onChange: (() => void) | null = null;

  private readonly unlisten = onOutlineReady(() => this.onChange?.());

  constructor() {
    this.root.scale.setScalar(UNIT);
    this.scene.add(this.root);
    this.hemisphere.position.set(0, 0, 1);
    this.scene.add(this.hemisphere, this.ambient);
    if (!areaLibReady) {
      RectAreaLightUniformsLib.init();
      areaLibReady = true;
    }
  }

  private resolve: ColorResolver | null = null;
  /** Stacking order of each layer (higher = above) — coplanar planes paint in it. */
  readonly layerOrder: Record<string, number> = {};

  private timeMs = 0;
  /** The world the object being synced can reach (its modifiers' scene) — set per object. */
  private env: StackEnv = {};

  sync(ev: WorldEval, opts: SyncOptions): void {
    const tick = ++this.tick;
    this.timeMs = ev.timeMs;
    this.resolve = opts.resolve;
    this.environment = null;
    this.hemisphere.intensity = 0;
    const rendered = opts.shading === "rendered";
    const total = ev.objects.length;
    ev.objects.forEach((o, i) => (this.layerOrder[o.id] = total - i));
    for (const o of ev.objects) {
      if (opts.localHidden?.has(o.id)) continue;
      let e = this.entries.get(o.id);
      if (!e || e.kind !== o.kind) {
        if (e) this.remove(e);
        e = this.create(o);
      }
      e.seen = tick;
      e.object = o;
      this.env = { scene: modifierScene(opts.doc, opts.frame, ev, o), viewport: opts.viewport, skin: o.skin };
      e.holder.matrix.fromArray(o.matrix);
      e.holder.matrixWorldNeedsUpdate = true;
      e.holder.visible = true;
      if (o.kind === "mesh") this.syncMesh(e, o, opts);
      else if (o.kind === "light") this.syncLight(e, o, rendered);
      else if (o.kind === "plane") this.syncPlane(e, o, opts, ev.timeMs);
    }
    for (const e of [...this.entries.values()]) {
      if (e.seen !== tick) {
        if (opts.localHidden?.has(e.id)) e.holder.visible = false;
        else this.remove(e);
      }
    }
    this.syncBooleans(ev, opts);
    this.syncFloor(ev.spec.render.floor, rendered);
    this.ambient.intensity = rendered ? 0.03 : 0;
    // Fog lives on the scene, in metres.
    const fog = ev.spec.fog;
    this.scene.fog = rendered && fog.enabled ? new THREE.Fog(fog.color, fog.start * UNIT, Math.max(fog.start + 1, fog.end) * UNIT) : null;
    if (rendered) this.fitSunShadows();
  }

  private create(o: WorldObject): ObjectEntry {
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.userData.clipId = o.id;
    this.root.add(holder);
    const e: ObjectEntry = {
      id: o.id, kind: o.kind, holder, mesh: null, wire: null, geo: null, geoKey: "", materials: [],
      light: null, lightType: null, plane: null, model: null, lines: null, seen: 0, object: o,
    };
    this.entries.set(o.id, e);
    return e;
  }

  private remove(e: ObjectEntry): void {
    this.root.remove(e.holder);
    e.lines?.dispose();
    if (e.light instanceof THREE.DirectionalLight) this.scene.remove(e.light, e.light.target);
    if (e.geo) e.geo.users--;
    for (const m of e.materials) m.dispose();
    if (e.mesh?.userData.solid) {
      for (const m of e.mesh.material as THREE.Material[]) m.dispose();
      (e.mesh.userData.faceTex as THREE.Texture | undefined)?.dispose();
    }
    if (e.plane) {
      e.plane.mesh.geometry.dispose();
      e.plane.texture?.dispose();
      (e.plane.mesh.material as THREE.Material).dispose();
    }
    if (e.light && "dispose" in e.light) (e.light as THREE.Light).dispose();
    this.entries.delete(e.id);
  }

  private syncMesh(e: ObjectEntry, o: WorldObject, opts: SyncOptions): void {
    const clip = o.clip as MeshClip;
    const override = opts.meshOverride?.get(o.id);
    const ev = override ? { key: `live:${Math.random()}`, mesh: override, assetId: null } : evaluateGeometry(clip, o.localMs, this.env);
    if (ev.assetId) {
      this.syncModel(e, ev.assetId, clip, opts, ev.morphs);
      return;
    }
    if (!ev.mesh) return;
    const geoKey = override ? "live" : `${ev.key}|${clip.uv}`;
    if (geoKey !== e.geoKey || override) {
      if (e.geo) e.geo.users--;
      e.geo = override ? liveGeometry(override, clip) : geometryFor(ev.key, ev.mesh, clip.shading, clip.smoothAngle, clip.uv);
      e.geo.users++;
      e.geoKey = geoKey;
      if (!e.mesh) {
        e.mesh = new THREE.Mesh(e.geo.geometry, []);
        e.mesh.userData.clipId = o.id;
        e.holder.add(e.mesh);
        e.wire = new THREE.LineSegments(e.geo.wire, this.wireMaterial);
        e.wire.userData.overlay = true;
        e.holder.add(e.wire);
      } else {
        e.mesh.geometry = e.geo.geometry;
        e.wire!.geometry = e.geo.wire;
      }
    }
    const looks = surfaceLooks(clip, e.geo!.parts, o.opacity * (opts.xray ? 0.35 : 1));
    const tex = clip.texture && opts.shading !== "wireframe" ? compTexture(opts.doc, clip.texture.frameId, this.timeMs, clip.texture.repeat) : null;
    e.materials = looks.map((look, i) => updateSurface(e.materials[i], look, opts.shading, opts.resolve, false, i === 0 ? tex : null));
    if (opts.xray) for (const m of e.materials) (m.depthWrite = false), (m.transparent = true);
    else for (const m of e.materials) m.depthWrite = m.opacity >= 1;
    e.mesh!.material = e.materials;
    // A lattice cage is a guide: the viewport draws it (a helper, from this
    // geometry), a render never does.
    const guide = !!clip.lattice;
    e.mesh!.castShadow = clip.castShadow && !guide;
    e.mesh!.receiveShadow = clip.receiveShadow;
    e.mesh!.visible = !guide && opts.shading !== "wireframe";
    e.wire!.visible = !guide && (opts.shading === "wireframe" || !!opts.xray);
  }

  private syncModel(e: ObjectEntry, assetId: string, clip: MeshClip, opts: SyncOptions, morphs?: Array<{ target: number | string; weight: number }>): void {
    const template = peekModelTemplate(assetId);
    if (!template) {
      // Not parsed yet: this picture is transient, and its arrival redraws all.
      markTransientPicture();
      void loadModelTemplate(assetId).then(() => {
        notifyPicturesChanged();
        this.onChange?.();
      });
      return;
    }
    if (!e.model || e.model.userData.assetId !== assetId) {
      if (e.model) e.holder.remove(e.model);
      e.model = template.clone(true);
      e.model.userData.assetId = assetId;
      e.model.traverse((n) => {
        n.userData.clipId = e.id;
        if ((n as THREE.Mesh).isMesh) {
          const m = n as THREE.Mesh;
          m.castShadow = true;
          m.receiveShadow = true;
          m.userData.fileMaterial = m.material;
        }
      });
      e.holder.add(e.model);
    }
    const custom = clip.material.source === "custom";
    const look = surfaceLooks(clip, [""], e.object.opacity)[0]!;
    e.model.traverse((n) => {
      const m = n as THREE.Mesh;
      if (!m.isMesh) return;
      if (custom || opts.shading === "solid" || opts.shading === "wireframe") {
        m.material = updateSurface(m.userData.custom as THREE.Material | undefined, look, opts.shading, opts.resolve, false);
        m.userData.custom = m.material;
      } else {
        m.material = m.userData.fileMaterial as THREE.Material;
      }
      m.castShadow = clip.castShadow;
      m.receiveShadow = clip.receiveShadow;
      // The model's OWN blendshapes, weighted by its asset shape keys (core
      // resolves weights; the file keeps the vertices). Named (glTF
      // targetNames → three's dictionary) or by index; unweighted targets are 0.
      if (m.morphTargetInfluences) {
        m.morphTargetInfluences.fill(0);
        for (const { target, weight } of morphs ?? []) {
          const i = typeof target === "number" ? target : m.morphTargetDictionary?.[target];
          if (i !== undefined && i < m.morphTargetInfluences.length) m.morphTargetInfluences[i] = weight;
        }
      }
    });
  }

  private syncLight(e: ObjectEntry, o: WorldObject, rendered: boolean): void {
    const l = (o.clip as LightClip).light;
    if (l.type === "environment") {
      if (rendered && !this.environment) {
        this.environment = { preset: l.environment, intensity: l.intensity, rotationZ: o.clip.transform.rotation, showBackground: l.showBackground };
      }
      if (e.light) {
        e.holder.remove(e.light);
        e.light = null;
      }
      return;
    }
    if (l.type === "hemisphere") {
      if (rendered) {
        this.hemisphere.color.set(l.color);
        this.hemisphere.groundColor.set(l.groundColor);
        this.hemisphere.intensity += l.intensity;
      }
      return;
    }
    if (!e.light || e.lightType !== l.type) {
      if (e.light) e.light.removeFromParent();
      e.light = makeLight(l.type);
      e.lightType = l.type;
      if (e.light instanceof THREE.DirectionalLight) {
        // A sun has a direction and no place: it lives at the scene's root and
        // is re-aimed at whatever is in the world every sync (fitSunShadows).
        this.scene.add(e.light, e.light.target);
      } else {
        e.holder.add(e.light);
        if (e.light instanceof THREE.SpotLight) {
          e.holder.add(e.light.target);
          e.light.target.position.set(0, 0, -100);
        }
      }
    }
    if (e.light instanceof THREE.DirectionalLight) {
      const m = o.matrix;
      e.light.userData.dir = new THREE.Vector3(-m[8]!, -m[9]!, -m[10]!).normalize();
    }
    const light = e.light;
    light.visible = rendered;
    light.color.set(l.color);
    const power = l.intensity;
    if (light instanceof THREE.PointLight) {
      light.intensity = power / (4 * Math.PI);
      light.distance = l.range * UNIT;
      light.decay = 2;
    } else if (light instanceof THREE.SpotLight) {
      light.intensity = power / (4 * Math.PI);
      light.distance = l.range * UNIT;
      light.decay = 2;
      light.angle = ((l.spotAngle / 2) * Math.PI) / 180;
      light.penumbra = l.spotBlend;
    } else if (light instanceof THREE.DirectionalLight) {
      light.intensity = power;
    } else if (light instanceof THREE.RectAreaLight) {
      const area = Math.max(1e-4, l.width * UNIT * (l.height * UNIT));
      light.width = l.width * UNIT;
      light.height = l.height * UNIT;
      light.intensity = power / (Math.PI * area) / 4;
    }
    const shadow = (light as THREE.Light & { shadow?: THREE.LightShadow }).shadow;
    if (shadow) {
      light.castShadow = l.castShadow;
      shadow.radius = l.shadowSoftness;
      shadow.bias = -0.0004;
      shadow.normalBias = 0.02;
    }
  }

  /**
   * A 2D layer's BODY (core `body.ts`, built by engine/body): its card, slab
   * or outline solid through its modifiers, wearing its own picture. Returns
   * false while the body cannot be built yet (a font still loading) — the flat
   * picture stands in until it lands.
   */
  private syncBody(e: ObjectEntry, o: WorldObject, opts: SyncOptions, timeMs: number): boolean {
    const pic = planePicture(opts.doc, opts.frame, o.source, timeMs, opts.densityFor?.(o) ?? opts.density);
    if (!pic) return false;
    const body = layerBody(opts.doc, opts.frame, o, pic, this.env);
    if (!body) {
      markTransientPicture();
      return false;
    }
    if (e.geoKey !== body.key || !e.geo) {
      if (e.geo) e.geo.users--;
      e.geo = geometryFor(body.key, body.mesh, "auto", 30);
      e.geo.users++;
      e.geoKey = body.key;
    }
    if (!e.mesh || !e.mesh.userData.solid) {
      if (e.mesh) e.holder.remove(e.mesh);
      e.mesh = new THREE.Mesh(e.geo.geometry, []);
      e.mesh.userData.clipId = o.id;
      e.mesh.userData.solid = true;
      e.holder.add(e.mesh);
      e.wire = new THREE.LineSegments(e.geo.wire, this.wireMaterial);
      e.wire.userData.overlay = true;
      e.holder.add(e.wire);
    } else {
      e.mesh.geometry = e.geo.geometry;
      e.wire!.geometry = e.geo.wire;
    }
    const mesh = e.mesh;
    const clip = o.clip;
    const spec = bodyThickness(clip);
    const flat = !spec;
    // The picture as the surface's texture. Vertices carry layer px, so the
    // texture's own transform maps the picture's rectangle onto them.
    let tex = mesh.userData.faceTex as THREE.CanvasTexture | undefined;
    if (!tex || tex.image !== pic.canvas || tex.userData.w !== pic.canvas.width || tex.userData.h !== pic.canvas.height) {
      tex?.dispose();
      tex = new THREE.CanvasTexture(pic.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.userData.w = pic.canvas.width;
      tex.userData.h = pic.canvas.height;
      mesh.userData.faceTex = tex;
      mesh.userData.faceKey = "";
    }
    if (mesh.userData.faceKey !== pic.key) {
      tex.needsUpdate = true;
      mesh.userData.faceKey = pic.key;
    }
    const w = pic.maxX - pic.minX || 1;
    const h = pic.maxY - pic.minY || 1;
    tex.repeat.set(1 / w, -1 / h);
    tex.offset.set(-pic.minX / w, pic.maxY / h);

    const material = layerMaterial(clip);
    const opacity = o.opacity * (opts.xray ? 0.5 : 1);
    const order = this.layerOrder[o.id] ?? 0;
    const fit = bodyFit(clip);
    // A revolved profile is a new surface, not the picture: it wears the
    // path's own colour (its stroke, else its fill), on both sides (it is open).
    const revolved = bodyIsRevolved(clip);
    const tube = bodyIsTube(clip);
    const ink = revolved || tube ? strokeOrFill(clip, this.resolve!) : null;
    e.materials = e.geo.parts.map((part, i) => {
      if (ink) {
        const m = updateSurface(e.materials[i], { material, fills: [solidPaint(ink)], opacity }, opts.shading, opts.resolve, false, null);
        // A revolved profile is open (both sides); a tube is closed.
        const faces = revolved ? THREE.DoubleSide : THREE.FrontSide;
        const toneMapped = material.model !== "unlit";
        if (m.side !== faces || m.toneMapped !== toneMapped) (m.side = faces), (m.toneMapped = toneMapped), (m.needsUpdate = true);
        return m;
      }
      const side = part === "side";
      // The sides: their own colour, a shade of a vector's face, or a
      // picture's edge pixels drawn back along the depth.
      const sideColor = side ? (spec?.sideColor ? this.resolve!(spec.sideColor) : VECTOR_BODY_KINDS.has(clip.kind) ? `#${new THREE.Color(faceColor(clip, this.resolve!)).multiplyScalar(0.62).getHexString()}` : null) : null;
      const look = { material, fills: sideColor ? [solidPaint(sideColor)] : [], opacity };
      const m = updateSurface(e.materials[i], look, opts.shading, opts.resolve, false, sideColor ? null : tex);
      // A flat card is the 2D layer: both faces, its own alpha, its stacking
      // among coplanar layers, and (unlit) its exact colours. A solid's face
      // is opaque — the outline already is the shape — except a box, whose
      // picture's clear pixels are cut out of its face.
      const alphaTest = flat ? 0.004 : fit === "box" && !side ? 0.5 : 0;
      if (m.alphaTest !== alphaTest) {
        m.alphaTest = alphaTest;
        m.needsUpdate = true;
      }
      m.transparent = flat || opacity < 1 || material.transmission > 0;
      const faces = flat || material.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
      const toneMapped = material.model !== "unlit";
      if (m.side !== faces || m.toneMapped !== toneMapped) {
        m.side = faces;
        m.toneMapped = toneMapped;
        m.needsUpdate = true;
      }
      m.polygonOffset = flat;
      m.polygonOffsetUnits = flat ? -2 * order : 0;
      m.depthWrite = flat || opacity >= 1;
      return m;
    });
    mesh.material = e.materials;
    mesh.userData.layerOrder = order;
    mesh.visible = opts.shading !== "wireframe";
    mesh.castShadow = mesh.receiveShadow = opts.shading === "rendered";
    e.wire!.visible = opts.shading === "wireframe" || !!opts.xray;
    return true;
  }

  private syncPlane(e: ObjectEntry, o: WorldObject, opts: SyncOptions, timeMs: number): void {
    // A stroke in space (depth on its points) is always a body: its tube. So is
    // a picture bending with a rig — a card has to have points to bend.
    if ((needsBody(o.clip) || bodyIsTube(o.clip) || o.skin) && this.syncBody(e, o, opts, timeMs)) {
      if (e.plane) e.plane.mesh.visible = false;
      return;
    }
    // Back to its card: the body goes, not just out of sight. A hidden body was
    // still the layer's surface to everything that asks for one — the
    // selection outline kept tracing an Array's copies after the card was gone.
    if (e.mesh?.userData.solid) this.dropBody(e);
    const pic = planePicture(opts.doc, opts.frame, o.source, timeMs, opts.densityFor?.(o) ?? opts.density);
    if (!pic) {
      if (e.plane) e.plane.mesh.visible = false;
      return;
    }
    const rect = `${pic.minX},${pic.minY},${pic.maxX},${pic.maxY}`;
    if (!e.plane) {
      const mesh = new THREE.Mesh(quad(pic.minX, pic.minY, pic.maxX, pic.maxY));
      mesh.userData.clipId = o.id;
      e.holder.add(mesh);
      e.plane = { mesh, texture: null, key: "", rect };
    } else if (e.plane.rect !== rect) {
      e.plane.mesh.geometry.dispose();
      e.plane.mesh.geometry = quad(pic.minX, pic.minY, pic.maxX, pic.maxY);
      e.plane.rect = rect;
    }
    const p = e.plane;
    p.mesh.visible = true;
    if (p.key !== pic.key) {
      const tex = p.texture;
      if (!tex || tex.image !== pic.canvas || tex.image.width !== tex.userData.w || tex.image.height !== tex.userData.h) {
        tex?.dispose();
        p.texture = premultipliedPicture(pic.canvas);
        p.texture.colorSpace = THREE.SRGBColorSpace;
        p.texture.anisotropy = 4;
        p.texture.userData.w = pic.canvas.width;
        p.texture.userData.h = pic.canvas.height;
      } else tex.needsUpdate = true;
      p.key = pic.key;
    }
    const order = this.layerOrder[o.id] ?? 0;
    p.mesh.material = planeMaterial(p.mesh.material as THREE.Material, p.texture!, o.opacity * (opts.xray ? 0.5 : 1), order);
    p.mesh.userData.layerOrder = order;
  }

  /** A 2D layer's body (its solid, wire, line art and face texture), released. */
  private dropBody(e: ObjectEntry): void {
    if (!e.mesh) return;
    e.holder.remove(e.mesh);
    for (const m of e.mesh.material as THREE.Material[]) m.dispose();
    (e.mesh.userData.faceTex as THREE.Texture | undefined)?.dispose();
    e.mesh = null;
    e.materials = [];
    if (e.wire) e.holder.remove(e.wire);
    e.wire = null;
    if (e.lines) {
      e.holder.remove(e.lines.group);
      e.lines.dispose();
      e.lines = null;
    }
    if (e.geo) e.geo.users--;
    e.geo = null;
    e.geoKey = "";
  }

  private readonly booleans = new Map<
    string,
    {
      mesh: THREE.Mesh;
      key: string;
      /** The merged surface, welded — what its line art reads (built on first need). */
      data?: MeshData | null;
      lines?: MeshLines;
      /** The member whose strokes and line settings the merged shape wears. */
      base?: ObjectEntry;
      /** Each member's own look kept (a union): the materials are the result's. */
      looks?: THREE.Material[];
    }
  >();

  /**
   * Groups whose mode is a boolean become one solid (engine/booleans): the
   * result stands where the kept members were and answers for the bottom one
   * (picking it selects that layer); cutters are drawn as wire while you work
   * and vanish in the render. Rebuilt only when a member's shape or placement
   * changes.
   */
  private syncBooleans(ev: WorldEval, opts: SyncOptions): void {
    for (const e of this.entries.values()) {
      if (e.model) e.model.visible = true;
      if (!e.mesh) continue;
      delete e.mesh.userData.cutter;
      delete e.mesh.userData.booleanResult;
    }
    const byGroup = new Map<string, WorldObject[]>();
    for (const o of ev.objects) {
      const g = o.groups[o.groups.length - 1];
      if ((o.kind !== "mesh" && o.kind !== "plane") || !g) continue;
      let list = byGroup.get(g);
      if (!list) byGroup.set(g, (list = []));
      list.push(o);
    }
    const live = new Set<string>();
    for (const [gid, members] of byGroup) {
      // A group inside an instance of a world component is the component's own group.
      const group = locateClip(opts.doc, worldSourceId(gid))?.clip;
      const mode = group?.kind === "group" ? group.mode : "pass";
      if (!isBooleanMode(mode)) continue;
      // Bottom first, like the layers they are; only meshes this scene has built.
      const ordered = members
        .slice()
        .reverse()
        .map((o) => this.entries.get(o.id))
        .filter((e): e is ObjectEntry => !!e && !!brushOf(e));
      if (ordered.length < 2) continue;
      // The cutters: members marked as such, else the topmost — the 2D rule.
      let cutters = ordered.filter((e) => (e.object.source as { isStencil?: boolean }).isStencil);
      if (cutters.length === 0 || cutters.length === ordered.length) cutters = [ordered[ordered.length - 1]!];
      const kept = ordered.filter((e) => !cutters.includes(e));
      const base = kept[0]!;
      const key = `${mode}|${ordered.map((e) => `${e.id}:${brushOf(e)!.key}:${e.object.matrix.map((v) => v.toFixed(3)).join(",")}${cutters.includes(e) ? "c" : ""}`).join("|")}`;
      let b = this.booleans.get(gid);
      if (!b || b.key !== key) {
        const input = (e: ObjectEntry) => ({ geometry: brushOf(e)!.geometry, matrix: e.object.matrix, ...(mode === "union" ? { material: resultMaterial(e) } : {}) });
        // A union keeps every member's own look; the cutting modes wear the base's.
        const kept2 = mode === "union" ? unionKeepingLooks(ordered.map(input)) : null;
        const geo = kept2?.geometry ?? booleanGeometry(mode, kept.map(input), mode === "union" ? [] : cutters.map(input));
        if (!geo) continue;
        if (!b) {
          const mesh = new THREE.Mesh(geo);
          this.root.add(mesh);
          b = { mesh, key };
          this.booleans.set(gid, b);
        } else {
          b.mesh.geometry.dispose();
          b.mesh.geometry = geo;
          b.key = key;
          b.data = undefined;
        }
        b.looks = kept2?.materials;
      }
      live.add(gid);
      const mesh = b.mesh;
      mesh.userData.clipId = base.id;
      b.base = ordered.find((e) => e.object.clip.kind === "mesh" && ((e.object.clip as MeshClip).strokes ?? []).some((st) => st.enabled !== false && st.width > 0)) ?? base;
      mesh.material = b.looks?.length ? b.looks : resultMaterial(base);
      mesh.castShadow = (base.object.clip as MeshClip).castShadow ?? true;
      mesh.receiveShadow = (base.object.clip as MeshClip).receiveShadow ?? true;
      mesh.visible = opts.shading !== "wireframe";
      const hide = (e: ObjectEntry) => {
        if (e.mesh) e.mesh.visible = false;
        if (e.model) e.model.visible = false;
      };
      for (const e of mode === "union" ? ordered : kept) {
        hide(e);
        if (e.mesh) e.mesh.userData.booleanResult = mesh;
      }
      if (mode !== "union") {
        for (const e of cutters) {
          hide(e);
          if (e.mesh) e.mesh.userData.cutter = true;
          if (e.wire) e.wire.visible = opts.shading !== "rendered";
        }
      }
    }
    for (const [gid, b] of this.booleans) {
      if (live.has(gid)) continue;
      this.root.remove(b.mesh);
      b.mesh.geometry.dispose();
      if (b.lines) {
        this.root.remove(b.lines.group);
        b.lines.dispose();
      }
      this.booleans.delete(gid);
    }
  }

  private floor: { mesh: THREE.Mesh; mode: string } | null = null;

  /**
   * THE FLOOR (world render `floor`): a shadow catcher (invisible but for the
   * shadows it receives — a transparent world drops real shadows on the 2D
   * behind it), a solid studio floor, or a mirror. Rendered shading only; the
   * working views have their grid.
   */
  private syncFloor(f: WorldEval["spec"]["render"]["floor"] | undefined, rendered: boolean): void {
    const mode = rendered && f ? f.mode : "none";
    if (this.floor && this.floor.mode !== mode) {
      this.root.remove(this.floor.mesh);
      this.floor.mesh.geometry.dispose();
      (this.floor.mesh.material as THREE.Material).dispose();
      (this.floor.mesh as unknown as { dispose?: () => void }).dispose?.();
      this.floor = null;
    }
    if (mode === "none" || !f) return;
    if (!this.floor) {
      const size = 200000;
      const geo = new THREE.PlaneGeometry(size, size);
      const material =
        mode === "shadow"
          ? new THREE.ShadowMaterial({ transparent: true })
          : mode === "mirror"
            ? new THREE.MeshStandardMaterial({ roughness: 0.25, transparent: true })
            : new THREE.MeshStandardMaterial({ roughness: 0.85 });
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      mesh.userData.overlayFree = true;
      this.root.add(mesh);
      this.floor = { mesh, mode };
    }
    const m = this.floor.mesh;
    m.position.z = f.z;
    m.updateMatrix();
    const mat = m.material as THREE.Material;
    if (mat instanceof THREE.ShadowMaterial) mat.opacity = f.opacity;
    else if (mat instanceof THREE.MeshStandardMaterial) {
      mat.color.set(this.resolve!(f.color));
      // A mirror's floor lets the reflection through by (1 − opacity).
      if (mode === "mirror") mat.opacity = Math.max(0.05, f.opacity);
    }
  }

  /**
   * A MIRROR FLOOR's reflection: the scene drawn mirrored about the floor's
   * plane (only what stands above it — a clip plane keeps the mirror image
   * below), before the translucent floor and the real scene are drawn over
   * it. Call right after clearing, before the main render, with autoClear off.
   */
  renderMirror(r: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (this.floor?.mode !== "mirror") return;
    const z = this.floor.mesh.position.z * UNIT;
    const floorMesh = this.floor.mesh;
    floorMesh.visible = false;
    const pos = this.root.position.z, sz = this.root.scale.z;
    this.root.scale.z = -UNIT;
    this.root.position.z = 2 * z;
    this.root.updateMatrixWorld(true);
    const clip = r.clippingPlanes;
    r.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), z)];
    const auto = r.autoClear;
    r.autoClear = false;
    r.render(this.scene, camera);
    r.autoClear = auto;
    r.clippingPlanes = clip;
    this.root.scale.z = sz;
    this.root.position.z = pos;
    this.root.updateMatrixWorld(true);
    floorMesh.visible = true;
  }

  /** Aim each sun at what is actually in the scene, its shadow box sized to fit. */
  private fitSunShadows(): void {
    const box = new THREE.Box3();
    for (const e of this.entries.values()) {
      if (e.mesh && e.mesh.visible) box.expandByObject(e.mesh);
      else if (e.model) box.expandByObject(e.model);
      else if (e.plane?.mesh.visible) box.expandByObject(e.plane.mesh);
    }
    const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 2) : box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(0.5, sphere.radius);
    for (const e of this.entries.values()) {
      const l = e.light;
      if (!(l instanceof THREE.DirectionalLight)) continue;
      const dir = (l.userData.dir as THREE.Vector3 | undefined) ?? new THREE.Vector3(0, 0, -1);
      l.position.copy(sphere.center).addScaledVector(dir, -r * 3);
      l.target.position.copy(sphere.center);
      l.updateMatrixWorld();
      l.target.updateMatrixWorld();
      const cam = l.shadow.camera;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.near = Math.max(0.01, r * 1.5);
      cam.far = r * 5;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * Strokes on meshes, for one camera — the silhouette depends on where the
   * eye is, so each renderer calls this right before it draws. `pxScale`
   * grows widths for renders larger than the comp (a 2× export).
   */
  updateLines(camera: THREE.Camera, resolution: THREE.Vector2, pxScale: number): void {
    const eye = new THREE.Vector3();
    camera.updateMatrixWorld();
    camera.getWorldPosition(eye);
    for (const e of this.entries.values()) {
      const clip = e.object.clip;
      // A member of a boolean draws no line of its own: the merged shape is
      // outlined once, below — never an eye's rim inside the head it sits in.
      if (e.mesh?.userData.booleanResult) {
        if (e.lines) e.lines.group.visible = false;
        continue;
      }
      // A mesh draws its line art with its own strokes; a layer's body with
      // its `lineArt` (its strokes are its 2D outline, already in its picture).
      let lines: MeshClip["lines"] | null = null;
      let strokes: StrokeStyle[] = [];
      if (e.kind === "mesh" && e.geo && clip.kind === "mesh" && !clip.lattice) {
        lines = clip.lines;
        strokes = clip.strokes.filter((st) => st.enabled !== false && st.width > 0);
      } else if (e.geo && e.mesh?.userData.solid && e.mesh.visible && (clip as VisualClip).lineArt) {
        const art = (clip as VisualClip).lineArt!;
        lines = art;
        if (art.width > 0) strokes = [lineArtStroke(art)];
      }
      if (!lines || !strokes.length || !e.geo) {
        if (e.lines) e.lines.group.visible = false;
        continue;
      }
      if (!e.lines) {
        e.lines = new MeshLines();
        e.holder.add(e.lines.group);
      }
      e.lines.group.visible = true;
      e.holder.updateMatrixWorld();
      const local = eye.clone().applyMatrix4(e.holder.matrixWorld.clone().invert());
      e.lines.update(e.geo.mesh, lines, strokes, this.resolve!, local, resolution, pxScale, e.object.opacity);
    }
    // The merged shapes: one outline around the whole, creases where parts meet.
    for (const b of this.booleans.values()) {
      const clip = b.base?.object.clip;
      const strokes = clip?.kind === "mesh" ? (clip as MeshClip).strokes.filter((st) => st.enabled !== false && st.width > 0) : [];
      // No borders: a solver's seams (T-junctions where parts were cut) read as
      // open edges — the outline is the silhouette and the creases where parts meet.
      const own = clip?.kind === "mesh" ? (clip as MeshClip).lines : null;
      const lines = own ? { ...own, boundaries: false } : null;
      if (!lines || !strokes.length || !b.mesh.visible) {
        if (b.lines) b.lines.group.visible = false;
        continue;
      }
      if (b.data === undefined) b.data = weldToMesh(b.mesh.geometry) as MeshData;
      if (!b.data) continue;
      if (!b.lines) {
        b.lines = new MeshLines();
        this.root.add(b.lines.group);
      }
      b.lines.group.visible = true;
      this.root.updateMatrixWorld();
      const local = eye.clone().applyMatrix4(this.root.matrixWorld.clone().invert());
      b.lines.update(b.data, lines, strokes, this.resolve!, local, resolution, pxScale, b.base?.object.opacity ?? 1);
    }
  }

  /** The three.js object for a clip — what the viewport hit-tests and outlines. */
  pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const e of this.entries.values()) {
      if (!e.holder.visible) continue;
      // A cutter is hidden but still yours to click (it is drawn as wire).
      if (e.mesh?.visible || e.mesh?.userData.cutter) out.push(e.mesh!);
      if (e.plane?.mesh.visible) out.push(e.plane.mesh);
      if (e.model) out.push(e.model);
    }
    for (const b of this.booleans.values()) if (b.mesh.visible) out.push(b.mesh);
    return out;
  }

  dispose(): void {
    this.unlisten();
    for (const e of [...this.entries.values()]) this.remove(e);
    this.wireMaterial.dispose();
  }
}

function makeLight(type: string): THREE.Light {
  switch (type) {
    case "sun":
      return new THREE.DirectionalLight();
    case "spot":
      return new THREE.SpotLight();
    case "area":
      return new THREE.RectAreaLight();
    default:
      return new THREE.PointLight();
  }
}

/** A picture quad in layer px: content (u right, v down) on the local XZ plane, facing −Y. */
function quad(minX: number, minY: number, maxX: number, maxY: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([minX, 0, -minY, maxX, 0, -minY, maxX, 0, -maxY, minX, 0, -maxY]), 3),
  );
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]), 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  g.computeBoundingSphere();
  return g;
}

/** Geometry for an uncommitted edit — rebuilt every sync, never cached. */
let liveEntry: GeometryEntry | null = null;
function liveGeometry(mesh: MeshData, clip: MeshClip): GeometryEntry {
  if (liveEntry && liveEntry.mesh === mesh) return liveEntry;
  liveEntry?.geometry.dispose();
  liveEntry?.wire.dispose();
  const key = `live-${Math.random()}`;
  const e = geometryFor(key, mesh, clip.shading, clip.smoothAngle, clip.uv);
  geometries.delete(`${key}|${clip.shading}|${clip.smoothAngle}`);
  liveEntry = e;
  return e;
}

/** Column-major Mat4 (document space) → a three.js camera, units → metres. */
export function cameraMatrixToThree(m: Mat4, cam: THREE.Camera): void {
  const a = m.slice();
  a[12] = a[12]! * UNIT;
  a[13] = a[13]! * UNIT;
  a[14] = a[14]! * UNIT;
  cam.matrixAutoUpdate = false;
  cam.matrix.fromArray(a);
  cam.matrixWorld.copy(cam.matrix);
  cam.matrixWorldInverse.copy(cam.matrix).invert();
}

/**
 * Transparent objects back to front — except that pictures sharing a depth
 * keep their LAYER order, the way the same layers stacked on a flat canvas.
 */
export function transparentSort(a: { z: number; object: THREE.Object3D; id: number }, b: { z: number; object: THREE.Object3D; id: number }): number {
  if (Math.abs(a.z - b.z) > 1e-5) return b.z - a.z;
  return ((a.object.userData.layerOrder as number) ?? 0) - ((b.object.userData.layerOrder as number) ?? 0) || a.id - b.id;
}

/** A layer's face colour: its top solid fill, else a text's own colour. */
function faceColor(clip: VisualClip, resolve: ColorResolver): string {
  const fills = (clip as { fills?: Paint[] }).fills ?? [];
  for (let i = fills.length - 1; i >= 0; i--) {
    const p = resolve.paint(fills[i]!);
    if (p.enabled !== false && p.type === "solid") return resolve(p.color);
    if (p.enabled !== false && p.type !== "solid" && "stops" in p && Array.isArray(p.stops) && p.stops[0]) return resolve(p.stops[0].color);
  }
  if (clip.kind === "text") return resolve(clip.style.color ?? "#ffffff");
  return "#ffffff";
}

/**
 * What a layer contributes to a boolean, in its own local units: a mesh's
 * built geometry, a solid's extrusion, or an imported model's meshes merged
 * (cached on the model — its pieces carry their own placement inside it).
 */
function brushOf(e: ObjectEntry): { geometry: THREE.BufferGeometry; key: string } | null {
  if (e.model) {
    let g = e.model.userData.brush as THREE.BufferGeometry | undefined;
    if (!g) {
      e.holder.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(e.holder.matrixWorld).invert();
      const parts: THREE.BufferGeometry[] = [];
      e.model.traverse((n) => {
        const m = n as THREE.Mesh;
        if (!m.isMesh || !m.geometry.getAttribute("position")) return;
        let part = new THREE.BufferGeometry();
        part.setAttribute("position", m.geometry.getAttribute("position").clone());
        if (m.geometry.index) part.setIndex(m.geometry.index.clone());
        part = part.index ? part.toNonIndexed() : part;
        part.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
        part.computeVertexNormals();
        parts.push(part);
      });
      if (!parts.length) return null;
      g = mergeGeometries(parts) ?? undefined;
      if (!g) return null;
      e.model.userData.brush = g;
    }
    return { geometry: g, key: `model:${e.model.uuid}` };
  }
  if (!e.mesh) return null;
  if (e.mesh.userData.solid) return { geometry: e.mesh.geometry, key: `solid:${e.mesh.geometry.uuid}` };
  return e.geo ? { geometry: e.geo.geometry, key: e.geoKey } : null;
}

/** The boolean result's look: the base member's own surface (a body's sides, a model's first material). */
function resultMaterial(base: ObjectEntry): THREE.Material {
  if (base.mesh?.userData.solid) {
    const mats = base.mesh.material as THREE.Material[];
    return mats[mats.length - 1]!;
  }
  if (base.model) {
    let found: THREE.Material | null = null;
    base.model.traverse((n) => {
      const m = n as THREE.Mesh;
      if (!found && m.isMesh) found = (Array.isArray(m.material) ? m.material[0] : m.material) ?? null;
    });
    if (found) return found;
  }
  return base.materials[0] ?? new THREE.MeshStandardMaterial();
}

// ── Comp textures ────────────────────────────────────────────────────────────

const compTextures = new Map<string, { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; key: string }>();
const animates = new WeakMap<MotionDocument, Map<string, boolean>>();

/** Does anything in this comp move on its own (so its picture depends on time)? */
function compAnimates(doc: MotionDocument, frameId: string): boolean {
  let per = animates.get(doc);
  if (!per) animates.set(doc, (per = new Map()));
  let v = per.get(frameId);
  if (v === undefined) {
    v = doc.tracks.some((t) =>
      t.clips.some((c) => c.frameId === frameId && (c.keyframes.length > 0 || c.kind === "video" || c.kind === "nested" || !!(c as { animIn?: unknown }).animIn || !!(c as { animOut?: unknown }).animOut || !!c.modulators?.length)),
    );
    per.set(frameId, v);
  }
  return v;
}

/**
 * A COMP AS A TEXTURE — the frame drawn by the 2D renderer itself (so pixel
 * paint, vectors, text and animation are exactly what wraps the mesh), into
 * one canvas per comp, redrawn only when the document changes or, for a comp
 * that animates, when the instant does.
 */
function compTexture(doc: MotionDocument, frameId: string, timeMs: number, repeat: number): THREE.CanvasTexture | null {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame || frame.world) return null;
  const k = Math.min(1, 1024 / Math.max(frame.width, frame.height));
  const w = Math.max(1, Math.round(frame.width * k)), h = Math.max(1, Math.round(frame.height * k));
  let entry = compTextures.get(frameId);
  if (!entry || entry.canvas.width !== w || entry.canvas.height !== h) {
    entry?.texture.dispose();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    entry = { canvas, texture, key: "" };
    compTextures.set(frameId, entry);
  }
  // Painted in place (a brush on the mesh): the pixels moved, the document did not.
  const key = `${docSerial(doc)}|${compAnimates(doc, frameId) ? Math.round(timeMs) : "-"}|${paintGeneration(frameId)}`;
  if (entry.key !== key) {
    const ctx = entry.canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.scale(k, k);
    drawFrameContent(ctx, doc, frame, timeMs);
    entry.texture.needsUpdate = true;
    entry.key = key;
  }
  entry.texture.wrapS = entry.texture.wrapT = repeat === 1 ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  entry.texture.repeat.set(repeat, repeat);
  return entry.texture;
}

let docCounter = 0;
const docIds = new WeakMap<object, number>();
function docSerial(doc: object): number {
  let n = docIds.get(doc);
  if (n === undefined) docIds.set(doc, (n = ++docCounter));
  return n;
}

/** A path's own colour: its first visible stroke's, else its fill's (what a revolved profile wears). */
function strokeOrFill(clip: VisualClip, resolve: ColorResolver): string {
  for (const st of clip.strokes) {
    if (st.enabled === false || !(st.width > 0)) continue;
    const p = resolve.paint(st.paint);
    if (p.type === "solid") return resolve(p.color);
  }
  return faceColor(clip, resolve);
}

/** A body's side colour as the scene draws it: its own, a shade of a vector's face, or null (a picture's edge pixels). */
export function bodySideColor(clip: VisualClip, resolve: ColorResolver): string | null {
  const spec = bodyThickness(clip);
  if (spec?.sideColor) return resolve(spec.sideColor);
  if (!VECTOR_BODY_KINDS.has(clip.kind)) return null;
  return `#${new THREE.Color(faceColor(clip, resolve)).multiplyScalar(0.62).getHexString()}`;
}
