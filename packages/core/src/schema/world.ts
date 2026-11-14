import { z } from "zod";
import { paintSchema } from "./vector";

/**
 * THE 3D WORLD (v89) — the data a world comp and its objects carry.
 *
 * A world is a comp (`frame.world`), its objects are clips (`mesh`, `camera`,
 * `light`, plus every 2D kind as a picture plane), and everything here is the
 * part of those clips that has no 2D counterpart. See docs/adr/ADR-3d.md.
 *
 * Axes: worlds are Z-up, right-handed (Blender). 1 unit = 1 px = 1 cm.
 */

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * An editable polygon mesh — n-gons, Blender's BMesh model rather than a
 * triangle soup, because every edit a person makes (extrude a face, inset it,
 * merge two verts) is a statement about POLYGONS, and a quad that has become
 * two triangles can no longer be loop-cut.
 *
 * Flat arrays rather than `{x,y,z}` objects: a mesh is the one place in the
 * document where size matters, and an edit replaces an array WHOLESALE (one
 * patch), never element by element (thirty thousand patches).
 *
 * Edges, normals and triangles are derived (`world/mesh.ts`) and never stored.
 */
export const meshDataSchema = z.object({
  /** Vertex positions, xyz triples, in the object's own space. */
  positions: z.array(z.number()),
  /** Polygons as vertex-index loops, counter-clockwise seen from outside. */
  faces: z.array(z.array(z.number().int().min(0))),
  /**
   * Which PART each face wears (parallel to `faces`): "" = the object's own
   * look, anything else = a `parts[]` id. Absent = every face is the object.
   */
  faceParts: z.array(z.string()).optional(),
  /** Edges marked for line strokes, as flattened vertex-index pairs. */
  marks: z.array(z.number().int().min(0)).optional(),
  /** Hard edges (shading seams), flattened vertex-index pairs. */
  sharp: z.array(z.number().int().min(0)).optional(),
  /**
   * The mesh's OWN unwrap — a (u, v) pair per vertex, carried through every
   * modifier (a vertex a modifier makes takes the average of its sources), so
   * a picture bent, twisted or subdivided keeps its pixels where they were.
   * Absent, or out of step with `positions` after an edit, = projected by the
   * clip's `uv` mode.
   */
  uv: z.array(z.number()).optional(),
  /**
   * LOOSE EDGES (vertex-index pairs) — edges with no face: a profile drawn to be
   * revolved (Screw), a wire. Faces' own edges are derived, never listed here.
   */
  lines: z.array(z.number().int().min(0)).optional(),
});
export type MeshData = z.infer<typeof meshDataSchema>;

/**
 * WHERE A MESH'S GEOMETRY COMES FROM.
 *
 *  - `primitive`: parametric, Cinema 4D's model — a cube stays a cube whose
 *    size, segments and fillet keyframe (`geometry.<param>`). Params absent
 *    from `params` take the registry default, so a new param costs nothing.
 *  - `mesh`: editable polygons. Entering edit mode makes a primitive this.
 *  - `asset`: an imported model; the bytes live in the blob store like every
 *    other asset, so a heavy scan never enters the JSON or an undo patch.
 */
export const meshSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("primitive"),
    primitive: z.string(),
    params: z.record(z.string(), z.number()).default({}),
  }),
  z.object({ type: z.literal("mesh"), mesh: meshDataSchema }),
  z.object({ type: z.literal("asset"), assetId: z.string() }),
]);
export type MeshSource = z.infer<typeof meshSourceSchema>;

// ── Surface ─────────────────────────────────────────────────────────────────

/**
 * A SURFACE RESPONSE — how light treats the object. The COLOUR is not here:
 * it is the layer's own `fills`, through the one paint model (solid, gradient,
 * image), so a 3D object is coloured with the same editor, variables and
 * keyframes as a rectangle.
 */
export const materialSchema = z.object({
  /** `pbr` = physically based; `toon` = banded cel shading; `unlit` = flat colour, no light. */
  model: z.enum(["pbr", "toon", "unlit"]).default("pbr"),
  roughness: z.number().min(0).max(1).default(0.5),
  metalness: z.number().min(0).max(1).default(0),
  /** Self-illumination colour; black = none. */
  emission: z.string().default("#000000"),
  emissionStrength: z.number().min(0).max(100).default(1),
  /** Glass: 0 = opaque, 1 = fully transmissive. */
  transmission: z.number().min(0).max(1).default(0),
  ior: z.number().min(1).max(2.5).default(1.45),
  /** Volume depth for transmission, in world units. */
  thickness: z.number().min(0).default(0),
  clearcoat: z.number().min(0).max(1).default(0),
  clearcoatRoughness: z.number().min(0).max(1).default(0.1),
  sheen: z.number().min(0).max(1).default(0),
  iridescence: z.number().min(0).max(1).default(0),
  /** Bands of light in `toon`. */
  toonSteps: z.number().int().min(2).max(8).default(3),
  doubleSided: z.boolean().default(false),
  /**
   * For an imported model: `file` keeps the materials the file brought (with
   * their textures); `custom` replaces them with this material and the layer's
   * fills. Meaningless on other geometry.
   */
  source: z.enum(["file", "custom"]).default("custom"),
  /** The library preset this came from — a label for the picker, never read by the renderer. */
  preset: z.string().nullable().default(null),
});
export type Material = z.infer<typeof materialSchema>;

/**
 * A PART — "these faces, except…". The scope rule every other override in the
 * document uses: presence is the override, absence is inheritance, so a face
 * whose part has no `fills` wears the object's.
 */
export const meshPartSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  fills: z.array(paintSchema).optional(),
  material: materialSchema.partial().optional(),
});
export type MeshPart = z.infer<typeof meshPartSchema>;

/**
 * WHICH EDGES A STROKE DRAWS on a 3D object (Blender's Line Art / Freestyle).
 * The look of the line is the layer's `strokes`; this says where it goes. The
 * defaults outline the shape you SEE and its hard edges — what "give it a
 * stroke" means to someone who has never heard of a crease angle.
 */
export const meshLinesSchema = z.object({
  silhouette: z.boolean().default(true),
  creases: z.boolean().default(true),
  /** Edges whose faces meet sharper than this (degrees) count as creases. */
  creaseAngle: z.number().min(0).max(180).default(40),
  boundaries: z.boolean().default(true),
  /** Edges marked in edit mode. */
  marked: z.boolean().default(true),
});
export type MeshLines = z.infer<typeof meshLinesSchema>;

/**
 * LINE ART ON A LAYER'S BODY — the same silhouette, crease and border lines a
 * mesh draws (`meshLinesSchema`), for a 2D layer standing in a world. A mesh
 * draws its lines with its own strokes; a layer's strokes already mean its 2D
 * outline (drawn into its picture), so its line art carries its own look: a
 * colour (a token or hex, through the one resolver) and a width in screen px.
 */
export const lineArtSchema = meshLinesSchema.extend({
  color: z.string().default("#111111"),
  width: z.number().min(0).max(64).default(2),
  opacity: z.number().min(0).max(1).default(1),
});
export type LineArt = z.infer<typeof lineArtSchema>;

/**
 * A LATTICE CAGE — a mesh that is a grid of `u × v × w` points spanning `size`
 * (its own space, centred on its origin), in the order x fastest, then y, then
 * z. This record is the REST grid: the points as they were made, which is what
 * a Lattice modifier measures each moved point against. Edit the cage's
 * points in edit mode and everything it deforms follows; add or delete a
 * point and the grid no longer matches, and the modifier stands aside.
 */
export const latticeSpecSchema = z.object({
  u: z.number().int().min(2).max(12).default(3),
  v: z.number().int().min(2).max(12).default(3),
  w: z.number().int().min(2).max(12).default(3),
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
});
export type LatticeSpec = z.infer<typeof latticeSpecSchema>;

/**
 * A MODIFIER — a non-destructive geometry step, and an instance of the
 * `geometry` domain of the one effect registry (`world/modifiers.ts` → `MDF`).
 * A list with stable ids, like effects, because order is meaning (mirror then
 * subdivide is not subdivide then mirror).
 *
 * FLAT, exactly like an effect: `{ id, type, enabled, ...fields }`. The fields
 * are open here because the registry declares each type's fields, toggles and
 * defaults — a new modifier is one registry entry and no schema change — and
 * every reader resolves through it (`modifierValue`), so a missing or mistyped
 * field reads as its default. Keyframed at `mdf.<id>.<field>`.
 */
const modifierObject = z
  .object({ id: z.string(), type: z.string(), enabled: z.boolean().default(true) })
  .catchall(z.union([z.number(), z.string(), z.boolean()]));
export const modifierSchema = z.preprocess(liftDevParams, modifierObject);
export type Modifier = z.infer<typeof modifierObject>;

/**
 * Builds of v89 before it shipped stored a modifier's values in a `params` bag.
 * No released file has that shape; this keeps the projects made while it was
 * being built opening, and costs one branch on a list rarely longer than three.
 */
function liftDevParams(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !("params" in raw)) return raw;
  const { params, ...rest } = raw as { params?: unknown };
  return params && typeof params === "object" ? { ...(params as object), ...rest } : rest;
}

// ── Cameras and lights ──────────────────────────────────────────────────────

export const cameraSpecSchema = z.object({
  projection: z.enum(["perspective", "orthographic"]).default("perspective"),
  /** Lens, in mm on a `sensorWidth` sensor (50 on 36 = the classic normal lens). */
  focalLength: z.number().min(1).max(5000).default(50),
  sensorWidth: z.number().min(1).max(200).default(36),
  /** Orthographic: the visible WIDTH in world units. */
  orthoScale: z.number().positive().default(1000),
  clipStart: z.number().positive().default(1),
  clipEnd: z.number().positive().default(100000),
  /** Lens shift, as a fraction of the frame width (Blender). */
  shiftX: z.number().default(0),
  shiftY: z.number().default(0),
  dof: z
    .object({
      enabled: z.boolean().default(false),
      /** Distance to the plane in focus, world units. */
      focusDistance: z.number().positive().default(1000),
      fStop: z.number().min(0.1).max(128).default(2.8),
      /**
       * Keep THIS layer in focus wherever it or the camera goes (Blender's Focus
       * Object) — the distance is measured every frame and wins over
       * `focusDistance`. Null = the distance.
       */
      focusObjectId: z.string().nullable().default(null),
    })
    .default({}),
});
export type CameraSpec = z.infer<typeof cameraSpecSchema>;

export const LIGHT_TYPES = ["point", "sun", "spot", "area", "environment", "hemisphere"] as const;
export const lightTypeSchema = z.enum(LIGHT_TYPES);
export type LightType = z.infer<typeof lightTypeSchema>;

export const ENVIRONMENT_PRESETS = ["studio", "soft", "sunset", "dawn", "night", "overcast"] as const;

export const lightSpecSchema = z.object({
  type: lightTypeSchema,
  color: z.string().default("#ffffff"),
  /**
   * Blender's units: POWER in watts for point, spot and area; STRENGTH for
   * sun (irradiance), environment and hemisphere. One field, labelled per type.
   */
  intensity: z.number().min(0).default(1000),
  /** Point/spot cut-off distance in world units; 0 = physically unbounded. */
  range: z.number().min(0).default(0),
  /** Spot cone, full angle in degrees. */
  spotAngle: z.number().min(1).max(179).default(45),
  /** Spot edge softness, 0 = hard. */
  spotBlend: z.number().min(0).max(1).default(0.15),
  /** Area light size, world units. */
  width: z.number().positive().default(100),
  height: z.number().positive().default(100),
  /** Hemisphere: the colour bounced up from the ground. */
  groundColor: z.string().default("#2b2a28"),
  castShadow: z.boolean().default(true),
  /** Shadow edge softness (blur radius in shadow-map texels). */
  shadowSoftness: z.number().min(0).max(20).default(2),
  /** Environment: which studio/sky lights the world. */
  environment: z.enum(ENVIRONMENT_PRESETS).default("studio"),
  /** Environment: show it as the background instead of the comp's paint. */
  showBackground: z.boolean().default(false),
});
export type LightSpec = z.infer<typeof lightSpecSchema>;

// ── Constraints (relations by id) ───────────────────────────────────────────

/**
 * CONSTRAINTS — placement derived from another layer, by id (the v73 relation
 * rule: a dangling id is no constraint, never a crash). Order matters and is
 * the list order: follow, then look.
 *
 *  - `lookAt` (Track To): turn so the forward axis points at the target. A
 *    camera or light looks down its −Z, a picture plane faces with its front.
 *  - `follow` (Child Of, translation): ride along with the target; the layer's
 *    own position becomes its OFFSET from the target, so "keep this distance"
 *    is literally the stored value.
 */
export const constraintSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("lookAt"),
    targetId: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
    influence: z.number().min(0).max(1).default(1),
  }),
  z.object({
    id: z.string(),
    type: z.literal("follow"),
    targetId: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
    influence: z.number().min(0).max(1).default(1),
    /** Also inherit the target's rotation (a camera mounted on a car). */
    rotation: z.boolean().default(false),
  }),
  /**
   * CHILD OF — Blender's constraint, the unit of a rig: the layer inherits its
   * target's whole transform (move, turn, scale) as if parented. `inverse` is
   * the target's world matrix inverted at the moment of parenting, so the
   * child stays where it was and only FOLLOWS from then on; null parents with
   * the child's own transform read as an offset from the target.
   */
  z.object({
    id: z.string(),
    type: z.literal("childOf"),
    targetId: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
    influence: z.number().min(0).max(1).default(1),
    inverse: z.array(z.number()).length(16).nullable().default(null),
  }),
  /**
   * IK — Blender's Inverse Kinematics, on the TIP of a Child Of chain (a hand
   * under a forearm under an upper arm): the `chainLength` layers above it turn
   * so the tip reaches the target; a `poleId` says which way the middle bends
   * (an elbow points at it). Move the target and the arm follows — key a hand,
   * not three rotations.
   */
  z.object({
    id: z.string(),
    type: z.literal("ik"),
    targetId: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
    influence: z.number().min(0).max(1).default(1),
    chainLength: z.number().int().min(1).max(16).default(2),
    poleId: z.string().nullable().default(null),
  }),
]);
export type Constraint = z.infer<typeof constraintSchema>;

// ── The world itself ────────────────────────────────────────────────────────

/**
 * THICKNESS — a 2D layer standing in a world as a real 3D object rather than a
 * picture plane: `depth` units back from where its picture stood, with a
 * rounded `bevel` on the edges (Blender's text Extrude + Bevel, C4D's
 * Extrude). Every 2D kind takes it — a text's glyphs, a logo, a photo, a
 * video, a nested comp.
 *
 * `fit` is the trade every 3D app makes between exact and fast:
 *  - `outline` follows the layer's real shape — a text's glyphs, a shape's
 *    contour, the silhouette of an image's transparency. Exact; for a moving
 *    picture it is re-traced every frame.
 *  - `box` is a slab the size of the picture. One box, built once, whatever
 *    plays on its face — the right thing for video and photographs.
 * Absent = the kind's own default (`bodyFit`): outline for vectors and
 * stills, box for anything that moves on its own.
 *
 * The face wears the layer's own picture; the sides take `sideColor`, or (on
 * a picture) its edge pixels drawn back along the depth, as a printed block
 * does. How light treats the body is the layer's `material`. Every number
 * keys at `extrude.<field>`.
 */
export const extrudeSchema = z.object({
  depth: z.number().min(0).default(40),
  bevel: z.number().min(0).default(0),
  bevelSegments: z.number().int().min(1).max(8).default(3),
  sideColor: z.string().nullable().default(null),
  fit: z.enum(["outline", "box"]).optional(),
});
export type ExtrudeSpec = z.infer<typeof extrudeSchema>;

export const SHADING_MODES = ["wireframe", "solid", "material", "rendered"] as const;
export type ShadingMode = (typeof SHADING_MODES)[number];

/**
 * Where the viewport was left — VIEW STATE, written through `store.remember`
 * and never an undo step (the `frame.playheadMs` rule). Absent = frame all.
 */
export const worldViewSchema = z.object({
  target: z.tuple([z.number(), z.number(), z.number()]),
  distance: z.number().positive(),
  /** Turntable angles, degrees: yaw about Z, pitch above the horizon. */
  yaw: z.number(),
  pitch: z.number(),
  ortho: z.boolean().default(false),
  shading: z.enum(SHADING_MODES).default("solid"),
  xray: z.boolean().default(false),
  /** The floor grid: world units per major cell, and minor lines per cell. */
  gridSize: z.number().positive().default(100),
  gridDivisions: z.number().int().min(1).max(100).default(10),
  showGrid: z.boolean().default(true),
  showOverlays: z.boolean().default(true),
});
export type WorldView = z.infer<typeof worldViewSchema>;

/**
 * A comp's 3D-ness (v89). Present = this comp is a WORLD. The background is
 * the frame's own paint; lighting is light clips; what remains here is how the
 * picture is developed.
 */
export const worldSpecSchema = z.object({
  render: z
    .object({
      toneMapping: z.enum(["agx", "aces", "neutral", "none"]).default("agx"),
      /** Exposure in stops. */
      exposure: z.number().min(-10).max(10).default(0),
      shadows: z.boolean().default(true),
      shadowQuality: z.enum(["low", "medium", "high"]).default("medium"),
      /**
       * BLOOM — bright things glow into their surroundings (Eevee's Bloom):
       * what makes emission read as light. On the finished picture, so a flat
       * picture keeps its exact colours and only what is bright enough spills.
       */
      bloom: z
        .object({
          enabled: z.boolean().default(false),
          /** How much of the glow is added. */
          strength: z.number().min(0).max(3).default(0.8),
          /** How far it spreads, 0..1. */
          radius: z.number().min(0).max(1).default(0.5),
          /** How bright a pixel must be to glow, 0..1. */
          threshold: z.number().min(0).max(1).default(0.75),
          /**
           * What glows: `bright` — whatever is bright enough in the finished
           * picture; `emission` — only what emits light (a material's
           * emission), so a white wall never glows and a dim neon still does.
           */
          source: z.enum(["bright", "emission"]).default("bright"),
        })
        .default({}),
      /**
       * AMBIENT OCCLUSION — contact shadow where surfaces meet and crevices
       * close (Eevee's AO): what seats an object on a floor and gives type its
       * depth. `radius` in world units.
       */
      ao: z
        .object({
          enabled: z.boolean().default(false),
          radius: z.number().min(1).max(5000).default(60),
          strength: z.number().min(0).max(2).default(1),
        })
        .default({}),

      /**
       * THE FLOOR the shot stands on, at `z`:
       *  - `shadow` — a SHADOW CATCHER: invisible but for the shadows on it, so
       *    a transparent world casts real shadows onto the 2D layout behind it;
       *  - `solid` — a studio floor in `color`;
       *  - `mirror` — a glossy floor reflecting the scene, tinted by `color`.
       */
      floor: z
        .object({
          mode: z.enum(["none", "shadow", "solid", "mirror"]).default("none"),
          color: z.string().default("#202024"),
          /** How dark a caught shadow is, 0..1. */
          opacity: z.number().min(0).max(1).default(0.45),
          z: z.number().default(0),
        })
        .default({}),
    })
    .default({}),
  fog: z
    .object({
      enabled: z.boolean().default(false),
      color: z.string().default("#9aa3ad"),
      start: z.number().min(0).default(1000),
      end: z.number().min(0).default(20000),
    })
    .default({}),
  view: worldViewSchema.optional(),
});
export type WorldSpec = z.infer<typeof worldSpecSchema>;

