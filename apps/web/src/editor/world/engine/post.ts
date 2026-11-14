import * as THREE from "three";
import type { WorldEval } from "@solomotion/core";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { TexturePass } from "three/examples/jsm/postprocessing/TexturePass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { SavePass } from "three/examples/jsm/postprocessing/SavePass.js";
import { Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { BokehShader } from "three/examples/jsm/shaders/BokehShader.js";
import { CopyShader } from "three/examples/jsm/shaders/CopyShader.js";
import { UNIT } from "./sync";

/**
 * THE LENS — depth of field and bloom, on the FINISHED picture.
 *
 * The frame is rendered exactly as without them (tone mapping applied, every
 * flat picture in its exact colours), copied, and then blurred by depth and
 * bloomed by brightness. Doing this before tone mapping would be "more
 * physical" and would also push every 2D picture standing in the world through
 * the filmic curve — a logo would come back a different colour for having
 * turned on a lens. On the display picture, only what is actually bright
 * enough glows and only what is out of the focal plane blurs.
 *
 * Alpha survives both: the bokeh averages it with the colour (a transparent
 * world blurs into what is behind it on the comp), and glow carries its own,
 * so a world composited over 2D still glows over it.
 */

export interface PostLook {
  dof: { focus: number; aperture: number; maxblur: number } | null;
  bloom: { strength: number; radius: number; threshold: number; source: "bright" | "emission" } | null;
  /** Ambient occlusion, radius in metres. */
  ao: { radius: number; strength: number } | null;
}

/**
 * What the live camera and the world ask for, in the passes' terms — null when
 * the picture needs nothing. DOF is the thin-lens circle of confusion,
 * linearised about the focal plane: c ≈ f² / (N · (S − f) · S) per metre off
 * the plane, as a fraction of the sensor's width (what the bokeh measures in).
 */
export function postLookOf(ev: WorldEval): PostLook | null {
  const spec = ev.camera.spec;
  let dof: PostLook["dof"] = null;
  if (spec.dof.enabled && ev.camera.projection.type === "perspective") {
    let S = spec.dof.focusDistance;
    const target = spec.dof.focusObjectId ? ev.objects.find((o) => o.id === spec.dof.focusObjectId) : undefined;
    if (target) {
      const m = ev.camera.matrix;
      // Along the camera's view axis (−Z), not the straight line: the focal plane is a plane.
      const d = [target.matrix[12]! - m[12]!, target.matrix[13]! - m[13]!, target.matrix[14]! - m[14]!];
      S = Math.max(1, -(d[0]! * m[8]! + d[1]! * m[9]! + d[2]! * m[10]!));
    }
    const s = Math.max(0.01, S * UNIT);
    const f = spec.focalLength / 1000;
    const sensor = spec.sensorWidth / 1000;
    const aperture = (f * f) / (Math.max(0.1, spec.dof.fStop) * Math.max(1e-3, s - f) * s * sensor);
    dof = { focus: s, aperture, maxblur: 0.03 };
  }
  const b = ev.spec.render.bloom;
  const bloom = b?.enabled ? { strength: b.strength, radius: b.radius, threshold: b.threshold, source: b.source ?? "bright" } : null;
  const a = ev.spec.render.ao;
  const ao = a?.enabled ? { radius: a.radius * UNIT, strength: a.strength } : null;
  return dof || bloom || ao ? { dof, bloom, ao } : null;
}

/**
 * The last word: the picture, with the glow SCREENED over it rather than added
 * (a display picture is already near 1 where it is bright, and adding light
 * there only clips it to white — screening lightens without losing the colour),
 * and alpha at least the light, so glow shows over a transparent world.
 */
const FINISH = {
  name: "LensFinish",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tBase: { value: null as THREE.Texture | null },
    glow: { value: 0 },
  },
  vertexShader: CopyShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBase;
    uniform float glow;
    varying vec2 vUv;
    void main() {
      vec4 top = texture2D(tDiffuse, vUv);
      if (glow < 0.5) { gl_FragColor = top; return; }
      vec4 base = texture2D(tBase, vUv);
      vec3 g = clamp(top.rgb, 0.0, 1.0);
      gl_FragColor = vec4(1.0 - (1.0 - base.rgb) * (1.0 - g), clamp(max(base.a, max(g.r, max(g.g, g.b))), 0.0, 1.0));
    }`,
};

/**
 * WHAT EMITS LIGHT, as a picture: the scene rendered again with every surface
 * black and every emissive one its emission (colour × strength, exposed),
 * the background and viewport furniture
 * left out. Bloom on THIS is Blender's "emission glows" — a white wall lit by
 * the sun stays a wall, a dim neon sign still glows. Its output replaces the
 * picture in the chain only for the bloom; the finish screens the glow over
 * the frame kept before it.
 */
class EmissionPass extends Pass {
  private readonly black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  private readonly glows = new Map<string, THREE.MeshBasicMaterial>();
  constructor(
    public scene: THREE.Scene,
    public camera: THREE.Camera,
  ) {
    super();
    this.needsSwap = false;
  }

  private emissive(m: THREE.Material): THREE.Material {
    const e = m as THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number; map?: THREE.Texture | null; alphaMap?: THREE.Texture | null };
    const lit = !!e.emissive && (e.emissiveIntensity ?? 1) > 0 && (e.emissive.r > 0 || e.emissive.g > 0 || e.emissive.b > 0);
    // A PICTURE (a text, a path, an image standing in the world) is its drawn
    // shape, not its quad: its alpha comes along, so it glows — and hides the
    // glow behind it — only where it is drawn. Swapping it for a flat colour
    // bloomed every neon word as a rectangle.
    const map = e.map ?? null, alphaMap = e.alphaMap ?? null;
    if (!lit && !map && !alphaMap) return this.black;
    // A fading object fades its light too: a flash keyed to opacity 0 must stop glowing, not bloom
    // at full strength until its layer ends.
    const k = lit ? (e.emissiveIntensity ?? 1) * (m.transparent ? m.opacity : 1) : 0;
    const key = `${lit ? e.emissive!.getHexString() : "-"}|${k.toFixed(3)}|${m.side}|${map?.uuid ?? ""}|${alphaMap?.uuid ?? ""}`;
    let g = this.glows.get(key);
    if (!g) {
      // Exposed like light on film (1 − e^−v): a strong emission glows more,
      // never without bound — Strength means the same in both modes.
      const c = lit ? e.emissive!.clone().multiplyScalar(k) : new THREE.Color(0, 0, 0);
      c.setRGB(1 - Math.exp(-c.r), 1 - Math.exp(-c.g), 1 - Math.exp(-c.b));
      // The lens works on DISPLAY values (see the top of this file) and a pass
      // writes its colour raw: hand it the display colour. Left linear, every
      // mixed hue lost its weaker channels — orange and pink glowed red.
      c.convertLinearToSRGB();
      g = new THREE.MeshBasicMaterial({ color: c, toneMapped: false, side: m.side, map, alphaMap, alphaTest: map || alphaMap ? 0.02 : 0 });
      // The picture lends its SHAPE, not its colours: an orange word glowing orange
      // must not come out red (orange × orange).
      if (map) g.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", "#ifdef USE_MAP\n\tdiffuseColor.a *= texture2D( map, vMapUv ).a;\n#endif");
      };
      if (this.glows.size > 64) {
        for (const x of this.glows.values()) x.dispose();
        this.glows.clear();
      }
      this.glows.set(key, g);
    }
    return g;
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    const swapped: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    const hidden: THREE.Object3D[] = [];
    this.scene.traverseVisible((o) => {
      if (o.userData.overlay || (o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) {
        hidden.push(o);
        return;
      }
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      swapped.push([mesh, mesh.material]);
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => this.emissive(m)) : this.emissive(mesh.material);
    });
    for (const o of hidden) o.visible = false;
    const bg = this.scene.background, env = this.scene.environment, fog = this.scene.fog;
    this.scene.background = null;
    this.scene.fog = null;
    const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(read);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setClearColor(clear, alpha);
    this.scene.background = bg;
    this.scene.environment = env;
    this.scene.fog = fog;
    for (const o of hidden) o.visible = true;
    for (const [mesh, mat] of swapped) mesh.material = mat;
  }

  dispose(): void {
    this.black.dispose();
    for (const g of this.glows.values()) g.dispose();
  }
}

export class PostStack {
  private emission: EmissionPass | null = null;
  private composer: EffectComposer | null = null;
  private frame: THREE.FramebufferTexture | null = null;
  private source: TexturePass | null = null;
  private bokeh: BokehPass | null = null;
  private gtao: GTAOPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private base: SavePass | null = null;
  private out: ShaderPass | null = null;
  private shape = "";

  constructor(readonly renderer: THREE.WebGLRenderer) {}

  /**
   * Run the lens over what the renderer just drew to its canvas (call right
   * after `render(scene, camera)` to the screen, before any overlay).
   */
  apply(scene: THREE.Scene, camera: THREE.Camera, look: PostLook): void {
    const r = this.renderer;
    const w = r.domElement.width, h = r.domElement.height;
    if (w < 2 || h < 2) return;
    if (!this.frame || this.frame.image.width !== w || this.frame.image.height !== h) {
      this.frame?.dispose();
      this.frame = new THREE.FramebufferTexture(w, h);
    }
    r.setRenderTarget(null);
    r.copyFramebufferToTexture(this.frame);
    const shape = `${!!look.ao}|${!!look.dof}|${look.bloom?.source ?? ""}`;
    if (!this.composer || this.shape !== shape) this.build(look, scene, camera, shape);
    const composer = this.composer!;
    composer.setPixelRatio(1);
    composer.setSize(w, h);
    this.source!.map = this.frame;
    if (this.gtao && look.ao) {
      this.gtao.scene = scene;
      this.gtao.camera = camera;
      this.gtao.blendIntensity = look.ao.strength;
      this.gtao.updateGtaoMaterial({ radius: look.ao.radius, distanceExponent: 1, thickness: 1, scale: 1 });
    }
    if (this.bokeh && look.dof) {
      this.bokeh.scene = scene;
      this.bokeh.camera = camera;
      const u = this.bokeh.uniforms as Record<string, THREE.IUniform>;
      u.focus!.value = look.dof.focus;
      u.aperture!.value = look.dof.aperture;
      u.maxblur!.value = look.dof.maxblur;
      u.aspect!.value = w / h;
    }
    if (this.emission) {
      this.emission.scene = scene;
      this.emission.camera = camera;
    }
    if (this.bloom && look.bloom) {
      this.bloom.strength = look.bloom.strength;
      this.bloom.radius = look.bloom.radius;
      // What emits light glows whole; the threshold is the bright picture's knee.
      this.bloom.threshold = look.bloom.source === "emission" ? 0 : look.bloom.threshold;
      // A SOFT KNEE: only what is brighter than the threshold spills, in
      // proportion to how much brighter — not the whole bright surface at full
      // colour, which turns a lit object into a white blob on a display picture.
      const hp = (this.bloom as unknown as { highPassUniforms: Record<string, THREE.IUniform> }).highPassUniforms;
      hp.smoothWidth!.value = look.bloom.source === "emission" ? 0.01 : Math.max(0.05, 1 - look.bloom.threshold);
    }
    const auto = r.autoClear;
    r.autoClear = false;
    composer.render();
    r.autoClear = auto;
  }

  private build(look: PostLook, scene: THREE.Scene, camera: THREE.Camera, shape: string): void {
    this.composer?.dispose();
    const composer = new EffectComposer(this.renderer);
    composer.renderToScreen = true;
    this.source = new TexturePass(this.frame!);
    composer.addPass(this.source);
    this.bokeh = null;
    this.bloom = null;
    this.gtao = null;
    if (look.ao) {
      // Contact shadow first: it darkens the picture the lens then blurs.
      this.gtao = new GTAOPass(scene, camera, 256, 256);
      composer.addPass(this.gtao);
    }
    if (look.dof) {
      this.bokeh = new BokehPass(scene, camera, { focus: 1, aperture: 0, maxblur: 0.03 });
      // The stock bokeh writes alpha 1 — a transparent world would turn opaque black.
      this.bokeh.materialBokeh.fragmentShader = BokehShader.fragmentShader.replace("gl_FragColor.a = 1.0;", "");
      this.bokeh.materialBokeh.needsUpdate = true;
      composer.addPass(this.bokeh);
    }
    this.base = null;
    if (look.bloom) {
      // Keep the picture as it is before the glow; the bloom pass then leaves
      // ONLY its glow behind (no blend), and the finish screens one over the other.
      this.base = new SavePass();
      composer.addPass(this.base);
      this.emission?.dispose();
      this.emission = null;
      if (look.bloom.source === "emission") {
        this.emission = new EmissionPass(scene, camera);
        composer.addPass(this.emission);
      }
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), look.bloom.strength, look.bloom.radius, look.bloom.threshold);
      this.bloom.blendMaterial.blending = THREE.NoBlending;
      this.bloom.blendMaterial.needsUpdate = true;
      composer.addPass(this.bloom);
    }
    // Always end on our own pass: the stock passes' screen output re-encodes
    // colour, and these values are display values already.
    this.out = new ShaderPass(FINISH);
    this.out.uniforms.glow!.value = look.bloom ? 1 : 0;
    if (this.base) this.out.uniforms.tBase!.value = this.base.renderTarget.texture;
    composer.addPass(this.out);
    this.composer = composer;
    this.shape = shape;
  }

  dispose(): void {
    this.composer?.dispose();
    this.frame?.dispose();
    this.bokeh?.dispose();
    this.bloom?.dispose();
    this.base?.dispose();
    this.emission?.dispose();
    this.gtao?.dispose();
    this.composer = null;
    this.frame = null;
  }
}

/**
 * THE SHUTTER — a world's motion blur: the shot rendered at several instants
 * across the camera's open shutter, each one finished (tone mapped, exactly
 * the frame you would see), and averaged by the shutter's weights. Alpha is
 * averaged too, so a transparent world blurs over the 2D behind it.
 */
export class ShutterAccumulator {
  private acc: THREE.WebGLRenderTarget | null = null;
  private frame: THREE.FramebufferTexture | null = null;
  private readonly quad = new FullScreenQuadLite();
  private readonly add = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null as THREE.Texture | null }, weight: { value: 1 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: "uniform sampler2D tMap; uniform float weight; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tMap, vUv) * weight; }",
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  private readonly show = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null as THREE.Texture | null } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: "uniform sampler2D tMap; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tMap, vUv); }",
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });

  constructor(readonly renderer: THREE.WebGLRenderer) {}

  /** Start a frame: the accumulation cleared to nothing. */
  begin(): void {
    const r = this.renderer;
    const w = r.domElement.width, h = r.domElement.height;
    if (!this.acc || this.acc.width !== w || this.acc.height !== h) {
      this.acc?.dispose();
      this.acc = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
      this.frame?.dispose();
      this.frame = new THREE.FramebufferTexture(w, h);
    }
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.acc);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setRenderTarget(prev);
  }

  /** Add what the canvas shows now, by `weight`. */
  addCanvas(weight: number): void {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.copyFramebufferToTexture(this.frame!);
    this.add.uniforms.tMap!.value = this.frame;
    this.add.uniforms.weight!.value = weight;
    r.setRenderTarget(this.acc);
    this.quad.render(r, this.add);
    r.setRenderTarget(null);
  }

  /** Put the average on the canvas. */
  present(): void {
    const r = this.renderer;
    r.setRenderTarget(null);
    this.show.uniforms.tMap!.value = this.acc!.texture;
    this.quad.render(r, this.show);
  }

  dispose(): void {
    this.acc?.dispose();
    this.frame?.dispose();
    this.add.dispose();
    this.show.dispose();
  }
}

/** One triangle over the whole target — the cheapest full-screen pass. */
class FullScreenQuadLite {
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;
  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    this.mesh = new THREE.Mesh(g);
    this.mesh.frustumCulled = false;
  }
  render(r: THREE.WebGLRenderer, m: THREE.Material): void {
    this.mesh.material = m;
    const auto = r.autoClear;
    r.autoClear = false;
    r.render(this.mesh, this.camera);
    r.autoClear = auto;
  }
}
