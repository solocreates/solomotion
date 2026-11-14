import { z } from "zod";

/**
 * PHYSICS (v92) — rigid bodies, joints and force fields, one model for a flat
 * comp and a 3D world. The whole design is docs/adr/ADR-physics.md; the short
 * of it:
 *
 *  - ANY layer can be a body (`clip.physics`): a shape, a text, a picture, a
 *    group, a mesh. Its collider comes from what it already is — a box, a
 *    circle or sphere, its convex hull, or its real outline cut into convex
 *    pieces — never a second shape to keep in step.
 *  - A flat comp simulates as a 3D world with a dimension resting: bodies
 *    move in its plane and turn about the line of sight, on the same solver,
 *    the same cache and the same fields as a world.
 *  - The simulation is keyed by what it STARTS from (poses, shapes, settings,
 *    fields, joints) and keeps every step, so any frame is exact — scrubbed,
 *    played backward or exported out of order.
 *  - FORCES are a stack any layer can carry (`clip.forces`, v93); a null layer
 *    (`empty`) is the usual carrier, a fan picture can be the wind. Their
 *    numbers key like any property: a gust is two keys on
 *    `force.<id>.strength`. Forces add up, so their order is the stack's
 *    reading order, never a different result.
 *
 * Units: 1 unit = 1 px = 1 cm. Time in seconds where a rate is meant.
 */

const v3 = z.tuple([z.number(), z.number(), z.number()]);

/** What a body collides as — the one list the schema, the API and the Physics tab read. */
export const PHYSICS_SHAPES = ["auto", "box", "sphere", "hull", "outline", "edge"] as const;

/**
 * A RIGID BODY. `active` bodies fall, collide and tumble from where they are at
 * the physics start; `passive` ones are fixed colliders; `animated` ones move
 * by their own keys and push what they meet (a hand shoving blocks).
 */
export const physicsSchema = z.object({
  type: z.enum(["active", "passive", "animated"]).default("active"),
  mass: z.number().positive().default(1),
  bounce: z.number().min(0).max(1).default(0.3),
  friction: z.number().min(0).max(1).default(0.5),
  /**
   * The collider: `auto` reads the layer (a rectangle is a box, a circle a
   * circle, a star or a word its outline, an open line its edge, a picture
   * its box; a mesh its box or a sphere for a round primitive); `box`;
   * `sphere` (a circle in a flat comp); `hull` (the outline's convex hull —
   * fast, no dents); `outline` (the real outline, cut into convex pieces);
   * `edge` (the LINE, not the fill: a wall along every contour as thick as
   * the stroke — a ring holds balls inside it, a drawn line is a ramp).
   */
  shape: z.enum(PHYSICS_SHAPES).default("auto"),
  /** Start velocity, units/s (a flat comp reads x and y; +y is down). */
  velocity: v3.default([0, 0, 0]),
  /** Start spin, degrees/s about each axis (a flat comp reads z: + turns clockwise on screen). */
  spin: v3.default([0, 0, 0]),
  /** Air resistance, 0..1: how much of its motion a body loses each second. */
  damping: z.number().min(0).max(1).default(0.01),
  /**
   * How hard an ACTIVE body is pulled back toward where its own animation puts
   * it, 0..1 (v93): 0 is free (it falls, it hangs limp); a little is jiggle —
   * it follows its keys and overshoots, settling behind them; 1 is stiff. For
   * a piece riding a bone it pulls the bone toward its animated angle: hair,
   * ears and tails that follow the character and swing.
   */
  follow: z.number().min(0).max(1).default(0),
});
export type PhysicsSpec = z.infer<typeof physicsSchema>;

/**
 * ONE FORCE in a layer's stack (v93), placed by the layer: it acts from the
 * layer's origin, a wind blows along its +X (turn the layer to aim it), a
 * vortex swirls about its Z (the line of sight in a flat comp). `id` is
 * stable, so its keys (`force.<id>.<field>`) survive reordering.
 */
/** Every kind of force — the one list the schema, the API and the stack read. */
export const FORCE_TYPES = ["wind", "vortex", "point", "turbulence", "drag", "gravity"] as const;

export const forceSchema = z.object({
  id: z.string(),
  type: z.enum(FORCE_TYPES).default("wind"),
  /**
   * How hard, as an acceleration in units/s² (gravity is 981): wind and
   * turbulence push, a vortex swirls (+ clockwise on screen), a point pulls
   * (negative pushes away). Drag: how much of a body's speed it takes per
   * second. A gravity well reads `mass` instead.
   */
  strength: z.number().default(600),
  /** How far it reaches from the layer's origin; 0 = everywhere. */
  radius: z.number().min(0).default(0),
  /** How it fades toward the edge of its reach. */
  falloff: z.enum(["none", "linear", "smooth"]).default("smooth"),
  /** Turbulence: the size of its eddies, units. */
  scale: z.number().positive().default(240),
  seed: z.number().int().default(0),
  /**
   * GRAVITY WELL (v107) — a real inverse-square pull, a = GM·r / (r² + core²)^{3/2}.
   * `mass` is that pull 100 units out, units/s² (GM = mass × 100²), so a body
   * launched at √(mass × 100² / r) holds a circle of radius r.
   */
  mass: z.number().min(0).default(8000),
  /** The softened core, units: inside it the pull eases off instead of running to infinity (a pass through the middle slingshots). */
  core: z.number().min(0).default(12),
  /**
   * The EVENT HORIZON, units (0 = none): a particle that crosses it is gone; a
   * dynamic body that crosses it is swallowed — it leaves the simulation and
   * is hidden from that instant on.
   */
  horizon: z.number().min(0).default(0),
  /**
   * FRAME DRAGGING, −1..1 (+ turns clockwise on screen): space near the well
   * turns with it, hardest at the horizon (its speed there ∝ 1/r², its grip
   * ∝ 1/r³), and everything is pulled toward turning with it — an orbit faster
   * than space loses its way and spirals in.
   */
  spin: z.number().min(-1).max(1).default(0),
  enabled: z.boolean().default(true),
});
export type ForceSpec = z.infer<typeof forceSchema>;
export type ForceType = ForceSpec["type"];

/**
 * ONE EMITTER in a layer's stack (v102) — PARTICLES. Placed by its layer like a
 * force: it emits from the layer's origin (or across its box, or along its
 * outline), along its +X (turn the layer to aim it), for as long as the layer
 * is on the timeline. Particles live in the comp's simulation: they fall with
 * its gravity (× `weight`), feel every force, bounce off every body, wall and
 * floor (one way — they never push a body back), and ring the layer's `hit`
 * sounds. `id` is stable, so its keys (`emit.<id>.<field>`) survive reordering;
 * a keyed `rate` is how a stream swells and stops.
 */
export const emitterSchema = z.object({
  id: z.string(),
  /**
   * `stream`: a steady flow while its layer is on. `burst`: `count` at once as
   * its layer starts. `hit`: a burst at every contact — its layer's, when the
   * layer is a body; every body's in the comp, when it is not — thrown off the
   * surface where they met, more and faster the harder the hit. `sub`: from
   * another card's particles — `count` from each one as it dies or hits (a
   * firework shell's burst, a raindrop's splash).
   */
  type: z.enum(["stream", "burst", "hit", "sub"]).default("stream"),
  enabled: z.boolean().default(true),
  /** Particles per second (a stream). */
  rate: z.number().min(0).max(2000).default(40),
  /** Particles in the burst (a `hit`: at a hard hit — softer ones throw fewer). */
  count: z.number().int().min(1).max(4000).default(120),
  /** A `hit`'s closing speed, units/s, under which a contact throws nothing (a ball settling). */
  threshold: z.number().min(0).max(5000).default(150),
  /** A `sub`'s parent: the id of a card in the same stack whose particles throw these. Empty = the card above it. */
  parent: z.string().default(""),
  /** A `sub` throws as a parent particle dies, or each time one hits something (it must collide). */
  on: z.enum(["death", "hit"]).default("death"),
  /** A `sub`: the share of its parent particle's velocity each one carries (0 = from a standstill, 1 = moving on with it). */
  inherit: z.number().min(0).max(1).default(0.25),
  /** Where they are born: the layer's origin, anywhere in its box, along its outline, or in a ring about its origin (`inner`..`outer`). */
  source: z.enum(["point", "area", "outline", "ring"]).default("point"),
  /** A ring source's inner and outer radius, units about the layer's origin (v107) — a disk, a halo, a shell. */
  inner: z.number().min(0).max(10000).default(140),
  outer: z.number().min(0).max(10000).default(420),
  /**
   * Which way they leave (v107): `aim` along the layer's +X (the cone is
   * `spread`), `orbit` sideways at the speed that holds a circle about the
   * strongest gravity well there × `orbit`, `inward` toward the layer's
   * origin, `outward` away from it — the last two at `speed`, spread about it.
   */
  launch: z.enum(["aim", "orbit", "inward", "outward"]).default("aim"),
  /**
   * × the circular speed (`launch: "orbit"`): 1 holds the circle, under 1 falls
   * into an ellipse that dips toward the well, over √2 escapes. Its sign is the
   * way round (+ clockwise on screen). With no well, `speed` about the origin.
   */
  orbit: z.number().min(-2).max(2).default(1),
  /** The cone they leave in, degrees about the layer's +X (360 = every way). */
  spread: z.number().min(0).max(360).default(30),
  /** Thrown in 3D and seen flat: each one's speed is its share of a sphere's, so a full spread fills a disc with a bright rim instead of drawing a ring. */
  sphere: z.boolean().default(false),
  /** Units/s as they leave. */
  speed: z.number().min(0).max(10000).default(600),
  /** 0..1: how much each one's speed, life and size wander from the set value. */
  variance: z.number().min(0).max(1).default(0.3),
  /** Seconds each one lives. */
  life: z.number().min(0.05).max(30).default(2),
  /** × the comp's gravity: 1 falls, 0 floats, negative rises (smoke). */
  weight: z.number().min(-4).max(4).default(1),
  /** Air: the share of its speed a particle loses each second (0..1). */
  drag: z.number().min(0).max(1).default(0),
  /** Bounce off bodies, walls and the floor. Off = they pass through everything. */
  collide: z.boolean().default(true),
  bounce: z.number().min(0).max(1).default(0.4),
  friction: z.number().min(0).max(1).default(0.2),
  /** Degrees/s each one turns, either way at random (confetti tumbling). */
  spin: z.number().min(0).max(3600).default(0),
  /** How each is drawn: a dot, a square, a spark stretched along its motion, or a layer's picture. */
  shape: z.enum(["dot", "square", "spark", "layer"]).default("dot"),
  /** The layer drawn per particle (`shape: "layer"`) — usually hidden where it stands. */
  instance: z.string().nullable().default(null),
  /** Size at birth, units. */
  size: z.number().min(0.5).max(500).default(8),
  /** Size at death, × its size at birth (0 shrinks away, 2 doubles). */
  grow: z.number().min(0).max(4).default(1),
  color: z.string().default("#FFFFFF"),
  /** Its colour as it dies, eased toward from `color`. */
  colorEnd: z.string().default("#FFFFFF"),
  /** Degrees each one's hue may wander from `color` (180 = every colour: confetti). */
  hue: z.number().min(0).max(180).default(0),
  /**
   * What its colour follows (v107, look-only): `life` eases `color` → `colorEnd`
   * as it ages; `speed` runs `color` (still) → `colorEnd` (at `hot`);
   * `temperature` glows as a blackbody whose heat rises with its speed — `kelvin`
   * at `hot`, ∝ speed^1.5 below it (a disk's inner edge white, its rim ember).
   */
  colorBy: z.enum(["life", "speed", "temperature"]).default("life"),
  /** The speed, units/s, that reads as `colorEnd` or as `kelvin`. */
  hot: z.number().min(1).max(20000).default(1200),
  /** The temperature at `hot`, K. */
  kelvin: z.number().min(1000).max(50000).default(12000),
  /** How far it fades out by the end of its life (0 = never, 1 = gone). */
  fade: z.number().min(0).max(1).default(1),
  /**
   * How much of every particle shows — the card's own fade, keyed to bring an
   * effect in or out. The carrier's opacity does not reach its particles (v103):
   * once thrown they are their own picture, so a word fading in can shed
   * sparks before it shows, and an invisible collider still sparks.
   */
  opacity: z.number().min(0).max(1).default(1),
  /** A dot's edge: 0 crisp, 1 a soft puff that fades to nothing (smoke, dust, bokeh). */
  soft: z.number().min(0).max(1).default(0),
  /** Light: 0 paints, up to 1 adds light with a halo — overlapping sparks burn white. */
  glow: z.number().min(0).max(1).default(0),
  /** Drawn under its layer instead of over it — a ball's trail stays behind the ball. */
  behind: z.boolean().default(false),
  /**
   * HOW THE PLANE IS SEEN (v107, look-only — `physics/particle-view.ts`).
   * `tilt`: degrees the simulation's plane leans away about the horizontal
   * line through the layer's origin (up the screen is the far side), so a
   * disk is drawn as the ellipse it is from the side — no squashed nest.
   * `lensing`: how much the heaviest gravity well with a horizon bends light
   * from behind it (1 = a real point lens with Rs = the horizon, a shadow of
   * 2.6 Rs). `beaming`: gas coming at the camera brighter and bluer, going
   * away dimmer and redder, against `hot`.
   */
  tilt: z.number().min(0).max(89).default(0),
  lensing: z.number().min(0).max(1).default(0),
  beaming: z.number().min(0).max(1).default(0),
  seed: z.number().int().default(0),
});
export type EmitterSpec = z.infer<typeof emitterSchema>;
export type EmitterType = EmitterSpec["type"];

/**
 * A JOINT from this body to another (or to the comp itself — a pin in the
 * air). Anchors are in each body's own space, units from its origin; a null
 * target anchor means "where this anchor is at the start".
 *
 *  - `pin`: the two anchors stay together, free to turn (a pendulum, a hinge).
 *  - `weld`: the two bodies move as one.
 *  - `rope`: the anchors stay `length` apart (a rod on a string's length).
 *  - `spring`: pulled toward `length` apart by `stiffness`, settled by `damping`.
 */
export const jointSchema = z.object({
  id: z.string(),
  type: z.enum(["pin", "weld", "rope", "spring"]).default("pin"),
  target: z.string().nullable().default(null),
  anchor: v3.default([0, 0, 0]),
  targetAnchor: v3.nullable().default(null),
  /** Spring: pull per unit stretched (per unit mass), 0..∞. */
  stiffness: z.number().min(0).default(40),
  /** Spring: how quickly it stops bouncing. */
  damping: z.number().min(0).default(2),
  /** Rope and spring rest length; null = their distance at the start. */
  length: z.number().min(0).nullable().default(null),
  enabled: z.boolean().default(true),
});
export type JointSpec = z.infer<typeof jointSchema>;

/** A comp's simulation — one for a flat comp and a world alike. */
export const simulationSchema = z.object({
  /** Downward pull, units/s² (981 is Earth; 0 floats). Down is +y on a flat comp, −Z in a world. */
  gravity: z.number().default(981),
  /** Comp time the simulation starts from (bodies rest as authored before it). */
  startMs: z.number().min(0).default(0),
  /** A floor: a flat comp's bottom edge, a world's ground. */
  floor: z.boolean().default(true),
  /** Where the floor is: a flat comp's y (null = its bottom edge), a world's Z (null = 0). */
  floorAt: z.number().nullable().default(null),
  /** A flat comp's left, right and top edges are walls too. */
  walls: z.boolean().default(false),
  /** Slow motion below 1, faster above. */
  timeScale: z.number().min(0.05).max(4).default(1),
  /**
   * NOTHING PASSES THROUGH A WALL (v106). A step that would carry a body
   * further than ¾ of its own radius is split into substeps (up to 8), so a
   * small fast ball cannot skip across a thin collider between two steps.
   * Off = the v105 stepping, which documents made before v106 keep so their
   * saved simulations replay exactly.
   */
  guard: z.boolean().default(true),
});
export type SimulationSpec = z.infer<typeof simulationSchema>;
