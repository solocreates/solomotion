import { z } from "zod";
import type { MotionDocument, Clip, Frame, GroupClip, VisualClip } from "../../schema";
import { FORCE_TYPES, jointSchema, PHYSICS_SHAPES, physicsSchema, simulationSchema } from "../../schema/physics";
import { FORCE } from "../../physics/forces";
import { EMITTER, EMITTER_LOOKS, emitterCarrierFor, emittersFromLook, emitterLook } from "../../physics/emitters";
import { emitterSchema } from "../../schema/physics";
import { createId } from "../../ids";
import { ApiError, defineCommand } from "../command";
import { requireClip, resolveTargetFrame } from "../lookup";
import { createEmptyClip } from "../../world/ops";
import { placeClip } from "../../timeline/place";
import { frameDurationMs, locateClip } from "../../timeline/ops";
import { isSpatialClip } from "../../clip-registry";
import { flatPhysics, resolveFlatPhysics } from "../../physics/flat";
import { evaluateWorld } from "../../world/evaluate";
import { bakeClipAt } from "../../world/evaluate";
import { matPosition } from "../../world/math";
import { rigPieceOf } from "../../physics/rig-plan";
import { groupChainMatrix } from "../../timeline/group-space";
import { apply } from "../../navigation/matrix";

/**
 * PHYSICS, FOR AGENTS — the verbs behind the Physics tab. One model for a flat
 * comp and a 3D world (docs/adr/ADR-physics.md): any layer is a body, forces
 * ride layers as a stack (a null usually), joints join bodies, a rig's pieces
 * act through their bones, and the comp holds the simulation's settings.
 * Exact per frame: no baking, scrub and export freely.
 */

const v3 = z.tuple([z.number(), z.number(), z.number()]);
const ids = z.union([z.string(), z.array(z.string())]);
const list = (v: string | string[]) => (typeof v === "string" ? [v] : v);

export const physicsBody = defineCommand({
  id: "physics.body",
  summary: "Make layers rigid BODIES — any layer, in a flat comp or a world: active (falls, collides, tumbles), passive (a fixed collider), animated (moves by its keys and pushes); type null removes.",
  details:
    "Bodies start where they are at the comp's physics start (physics_scene startMs), moving the way their keys were moving then (a thrown thing keeps flying) plus `velocity` (units/s; +y is DOWN in a flat comp) and `spin` (deg/s; a flat comp reads z, + clockwise). " +
    "`shape`: auto (a rectangle and a picture are boxes, a circle a circle, a star, path or text its real outline, an open line its edge), box, sphere, hull (convex outline, fastest), outline (exact, convex pieces), edge (the LINE as a wall, stroke-thick: a passive ring or circle with shape edge holds balls INSIDE it; a drawn line is a ramp or a deflector). A group is ONE body of everything in it. " +
    "A flat comp's bottom edge is a floor by default; physics_scene adds walls. 1 unit = 1 px = 1 cm; gravity 981 is Earth. " +
    "A body exists while its clip is on the timeline: it enters at its clip's start, and what rests on it falls when its clip ends. " +
    "`follow` 0..1 pulls an active body back toward its own animation (0 free, ~0.2 jiggle, 1 stiff). " +
    "IN A RIG a body acts through its bone: an active piece makes the bone it rides swing from its joint (pendulum, tail, ragdoll limb; with follow it lags behind the keyed pose — spring bones), a passive piece rides its bone as a collider, and the rig group's own body (or an active piece the rig itself carries) makes the whole character fall.",
  effect: "write",
  input: z.object({
    ids,
    type: z.enum(["active", "passive", "animated"]).nullable().optional(),
    mass: z.number().positive().optional(),
    bounce: z.number().min(0).max(1).optional(),
    friction: z.number().min(0).max(1).optional(),
    shape: z.enum(PHYSICS_SHAPES).optional(),
    velocity: v3.optional(),
    spin: v3.optional(),
    damping: z.number().min(0).max(1).optional(),
    follow: z.number().min(0).max(1).optional().describe("Pull back toward its own animation: 0 free, ~0.2 jiggle, 1 stiff"),
  }),
  run(input, rt) {
    const targets = list(input.ids);
    rt.write(input.type === null ? "No physics" : "Physics", (d) => {
      for (const id of targets) {
        const c = requireClip(d, id).clip;
        if (c.kind === "audio" || c.kind === "adjustment" || c.kind === "camera" || c.kind === "light") throw new ApiError(`"${c.name}" is a ${c.kind}; it has no body.`);
        const v = c as VisualClip;
        if (input.type === null) {
          v.physics = undefined;
          continue;
        }
        const { ids: _i, type, ...patch } = input;
        void _i;
        v.physics = physicsSchema.parse({ ...(v.physics ?? {}), ...(type && { type }), ...Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined)) });
      }
    });
    return { updated: targets };
  },
});

export const physicsScene = defineCommand({
  id: "physics.scene",
  summary: "A comp's simulation: gravity (downward, 981 = Earth, 0 floats), when it starts, a floor, walls (a flat comp's edges), slow motion.",
  details: "`floorAt`: a flat comp's floor y (null = its bottom edge), a world's ground Z (null = 0). `walls` makes a flat comp's left, right and top edges solid. `timeScale` < 1 is slow motion. `guard` (default on) substeps fast bodies so nothing tunnels through a wall; documents from before v106 have it off, so turn it on when you build on an old comp.",
  effect: "write",
  input: z.object({
    frameId: z.string().optional(),
    gravity: z.number().optional(),
    startMs: z.number().min(0).optional(),
    floor: z.boolean().optional(),
    floorAt: z.number().nullable().optional(),
    walls: z.boolean().optional(),
    timeScale: z.number().min(0.05).max(4).optional(),
    guard: z.boolean().optional(),
  }),
  run(input, rt) {
    const frame = resolveTargetFrame(rt, input.frameId);
    rt.write("Simulation", (d) => {
      const f = d.frames.find((x) => x.id === frame.id)!;
      const { frameId: _f, ...patch } = input;
      void _f;
      f.physics = simulationSchema.parse({ ...(f.physics ?? {}), ...Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined)) });
    });
    return { frameId: frame.id, physics: rt.doc().frames.find((x) => x.id === frame.id)!.physics };
  },
});

export const physicsForce = defineCommand({
  id: "physics.force",
  summary: "Add a FORCE — wind, point (attract; negative repels), vortex, turbulence, drag, gravity (a real inverse-square well with an event horizon and spin) — to a new null layer, or to any layer's force stack (`id`). Placed by its layer: wind blows along its +X, so turn the layer to aim it.",
  details:
    "A layer carries a STACK of forces (like its effects): call again with the same `id` to add another — two winds at different angles, a vortex inside a drag. They add up, so order never changes the result. " +
    "`strength` is an acceleration in units/s² (gravity is 981); drag: % of speed lost per second. `radius` limits its reach (0 = everywhere), `falloff` fades it. " +
    "GRAVITY reads `mass` instead of strength: its pull 100 units out (GM = mass × 10⁴), so an orbit of radius r runs at √(mass × 10⁴ / r) units/s — emitters launch there with `launch: \"orbit\"`. `horizon` (units, 0 = none): particles crossing it die, dynamic bodies are swallowed (out of the simulation, hidden from then on). `spin` −1..1: frame dragging — space turns with the well, hardest at the horizon, and pulls orbits toward its turn, so a fast disk spirals in. `core` softens the centre. A flat comp's own gravity still pulls: set physics_scene gravity 0 for space. " +
    "Returns `forceId`; its numbers key at `force.<forceId>.<field>` (keyframes_set — a gust is two keys on strength). Change, mute, reorder or remove a card with effects_update {id, effectId: forceId}.",
  effect: "write",
  input: z.object({
    id: z.string().optional().describe("A layer to carry the force; omit to make a new null"),
    frameId: z.string().optional(),
    name: z.string().optional(),
    position: z.union([z.tuple([z.number(), z.number()]), v3]).optional().describe("A new null's place: [x, y] in a flat comp, [x, y, z] in a world"),
    rotation: z.number().optional().describe("Degrees: where a wind blows (0 = right; a flat comp's + turns clockwise)"),
    type: z.enum(FORCE_TYPES).default("wind"),
    strength: z.number().optional(),
    mass: z.number().min(0).optional(),
    horizon: z.number().min(0).optional(),
    spin: z.number().min(-1).max(1).optional(),
    core: z.number().min(0).optional(),
    radius: z.number().min(0).optional(),
    falloff: z.enum(["none", "linear", "smooth"]).optional(),
    scale: z.number().positive().optional(),
    seed: z.number().int().optional(),
  }),
  run(input, rt) {
    let id = input.id ?? null;
    let forceId = "";
    rt.write(`Add ${FORCE.def(input.type)!.label}`, (d) => {
      if (!id) {
        const frame = resolveTargetFrame(rt, input.frameId);
        const e = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: carrierSpanMs(d, frame), name: input.name ?? FORCE.def(input.type)!.label, display: "arrows", size: 60 });
        e.fillDuration = true;
        const [x, y, z] = [input.position?.[0] ?? 0, input.position?.[1] ?? 0, input.position?.[2] ?? 0];
        e.transform = { ...e.transform, x, y, ...(z ? { z } : {}), rotation: input.rotation ?? 0 };
        placeClip(d, e, { landing: "surface" });
        id = e.id;
      }
      const c = requireClip(d, id).clip;
      if (c.kind === "audio") throw new ApiError("A sound cannot carry a force.");
      if (input.rotation !== undefined && input.id) c.transform = { ...c.transform, rotation: input.rotation };
      const keys = ["strength", "radius", "falloff", "scale", "seed", "mass", "horizon", "spin", "core"] as const;
      const patch = Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
      const force = { ...FORCE.create(input.type), ...patch };
      (c.forces ??= []).push(force);
      forceId = force.id;
    });
    return { layerId: id, forceId, path: `force.${forceId}.<field>` };
  },
});

const emitterFields = emitterSchema.omit({ id: true, type: true }).partial();

/**
 * How long a new force or particle null lives: its WHOLE comp.
 *
 * It took the document's length, which is the root comp's — 10 s in a new
 * project — so in a longer comp the null ended at 10 s, and a stream keyed to
 * start at 14 s never fired, with nothing said. A carrier is scenery for the
 * comp it is made in, so it is also born TRACKING it (`fillDuration`, the one
 * flag the comp-length setter re-fits): made in a fresh comp and the comp set
 * to 24 s afterwards, it spans 24 s, where it used to stay at the 10 s it was
 * born with. `timeline.trim` narrows it (and stops the tracking).
 */
function carrierSpanMs(doc: MotionDocument, frame: Frame): number {
  return Math.max(1000, frameDurationMs(doc, frame));
}

export const physicsEmit = defineCommand({
  id: "physics.emit",
  summary: `PARTICLES — a stream, a burst, a burst on every hit, or a sub-emitter thrown from another card's particles, on a new null (or any layer's emitter stack, \`id\`), in a look: ${EMITTER_LOOKS.map((l) => l.id).join(", ")}. They fall with the comp's gravity, feel its forces, bounce off every body (edge rings too), and ring the layer's hit sounds.`,
  details:
    "Placed by its layer: a stream flows along the layer's +X (`rotation` aims it; −90 = up), a burst throws `count` at once as its layer starts (move the layer's clip to move the pop), a `hit` throws up to `count` off every contact — its layer's when that layer is a body (`id` = the ball: sparks where IT lands), every body's in the comp when it is not (a new null: sparks off every hit) — more and faster the harder the hit, none under `threshold` units/s. A `sub` throws `count` from each particle of its `parent` card (an emitterId in the same stack; omitted = the card above it) as it dies (`on: \"death\"`, fanned about the way it went — spread 360 is a sphere) or hits (`on: \"hit\"`, off the surface; its parent must collide), carrying `inherit` of its motion; a sub's hue wanders per parent particle (one colour per firework shell). Looks firework, shell and rain add their sub-emitters too (returned in `emitterIds`); crackle and splash are sub looks for an existing stack. A look sets every field and places the null (rain and snow: a strip across the comp's top); any field you pass wins over the look. " +
    "Fields: rate (/s), count, threshold (hit), parent / on death|hit / inherit 0..1 (sub), sphere (thrown in 3D, seen flat: a 360 burst fills a ball, not a ring), source point|area|outline|ring (outline = along the layer's own edge — a word that sheds sparks; ring = an annulus `inner`..`outer` units about the layer's origin — a disk, a halo, a collapsing shell), launch aim|orbit|inward|outward (orbit = sideways at the circular speed about the strongest gravity well × `orbit`, −2..2, sign = way round, under 1 dips toward the well, add a little `drag` to spiral in; inward/outward = toward/away from the layer's origin at `speed`), spread °, speed, variance, life s, weight (× gravity; 0 floats, negative rises), drag, collide, bounce, friction, spin °/s, shape dot|square|spark|layer (+ instance: a layer id drawn per particle — hide that layer), size, grow, color, colorEnd, colorBy life|speed|temperature (speed: color → colorEnd at `hot` units/s; temperature: a blackbody at `kelvin` for particles at `hot`, cooler and dimmer as they slow — an accretion disk white-hot inside, ember at the rim; look-only, never re-simulates), hue (°, 180 = every colour), fade, soft (a dot's feather), glow (adds light), behind (under its layer), seed. " +
    "Returns `emitterId`; its numbers key at `emit.<emitterId>.<field>` (keyframes_set — a keyed rate swells and stops a stream). A `hit` sound on the carrier rings for its particles' hits, thinned to the hardest per 45 ms. Particles are flat comps only.",
  effect: "write",
  input: z
    .object({
      id: z.string().optional().describe("A layer to carry the emitter; omit to make a new null"),
      frameId: z.string().optional(),
      name: z.string().optional(),
      look: z.enum(EMITTER_LOOKS.map((l) => l.id) as [string, ...string[]]).optional().describe("A preset: every field set and the null placed for it"),
      type: z.enum(["stream", "burst", "hit", "sub"]).optional(),
      position: z.tuple([z.number(), z.number()]).optional().describe("A new null's place"),
      rotation: z.number().optional().describe("Degrees: where it emits (0 = right, −90 = up)"),
    })
    .merge(emitterFields),
  run(input, rt) {
    const look = input.look ? emitterLook(input.look) : undefined;
    const type = input.type ?? look?.type ?? "stream";
    let id = input.id ?? null;
    let emitterId = "";
    let emitterIds: string[] = [];
    rt.write(`Add ${look?.name ?? EMITTER.def(type)!.label}`, (d) => {
      if (!id) {
        const frame = resolveTargetFrame(rt, input.frameId);
        if (frame.world) throw new ApiError("Particles live in flat comps for now.");
        const place = emitterCarrierFor(look, frame, input.position);
        const e = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: carrierSpanMs(d, frame), name: input.name ?? look?.name ?? "Particles", display: "arrows", size: 60 });
        e.fillDuration = true;
        e.transform = { ...e.transform, x: place.x, y: place.y, rotation: input.rotation ?? place.rotation, scale: place.scale, scaleY: place.scaleY };
        placeClip(d, e, { landing: "surface" });
        id = e.id;
      }
      const c = requireClip(d, id).clip;
      if (c.kind === "audio") throw new ApiError("A sound cannot give off particles.");
      if (input.rotation !== undefined && input.id) c.transform = { ...c.transform, rotation: input.rotation };
      const { id: _i, frameId: _f, name: _n, look: _l, type: _t, position: _p, rotation: _r, ...fields } = input;
      // A look's own cards come with it (a shell's burst); fields passed land on its first.
      const [base, ...rest] = look && look.type === type ? emittersFromLook(look, d.frames.find((f) => f.id === c.frameId)) : [EMITTER.create(type)];
      const emitter = emitterSchema.parse({ ...base!, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), id: base!.id, type });
      if (emitter.instance && !requireClip(d, emitter.instance)) throw new ApiError(`No layer "${emitter.instance}" to draw as particles.`);
      if (emitter.parent && !c.emitters?.some((e) => e.id === emitter.parent)) throw new ApiError(`No card "${emitter.parent}" in "${c.name}"'s particles to throw from.`, "Pass an emitterId of the same layer, or omit parent for the card above.");
      if (type === "sub" && !emitter.parent && !c.emitters?.length) throw new ApiError("A sub-emitter throws from another card's particles, and this layer has none yet.", "Add a stream or burst first (or use look shell / firework).");
      (c.emitters ??= []).push(emitter, ...rest.map((e) => emitterSchema.parse(e)));
      emitterId = emitter.id;
      emitterIds = [emitter.id, ...rest.map((e) => e.id)];
    });
    return { layerId: id, emitterId, ...(emitterIds.length > 1 && { emitterIds }), path: `emit.${emitterId}.<field>` };
  },
});

const jointInput = z.object({
  type: z.enum(["pin", "weld", "rope", "spring"]).optional(),
  target: z.string().nullable().optional().describe("The other body (id or name); null = the comp itself (hold it in the air)"),
  anchor: v3.optional().describe("On this body, in its own space (units from its origin; a flat layer's own px)"),
  targetAnchor: v3.nullable().optional().describe("On the target, in its own space — or a point in the comp when the target is null; null = where this anchor is at the start"),
  stiffness: z.number().min(0).optional(),
  damping: z.number().min(0).optional(),
  length: z.number().min(0).nullable().optional(),
  enabled: z.boolean().optional(),
});

export const physicsJoint = defineCommand({
  id: "physics.joint",
  summary: "JOINTS between bodies (or a body and the comp): pin (a hinge, a pendulum), weld (one piece), rope (stays within a length), spring (pulls back, bounces).",
  details: "Anchors are in each body's own space. A pin with no target hangs the body from a point in the comp. Returns every joint on the body.",
  effect: "write",
  input: z.object({
    id: z.string().describe("The body the joints belong to"),
    add: z.array(jointInput).optional(),
    edit: z.array(jointInput.extend({ joint: z.string() })).optional(),
    remove: z.array(z.string()).optional(),
  }),
  run(input, rt) {
    rt.write("Joints", (d) => {
      const c = requireClip(d, input.id).clip as VisualClip;
      if (!c.physics) throw new ApiError(`"${c.name}" is not a body.`, "physics_body first.");
      const target = (t: string | null | undefined) => (t === undefined ? undefined : t === null ? null : requireClip(d, t).clip.id);
      const joints = [...(c.joints ?? [])];
      for (const a of input.add ?? []) joints.push(jointSchema.parse({ ...clean(a), id: createId("jnt"), target: target(a.target) ?? null }));
      for (const e of input.edit ?? []) {
        const i = joints.findIndex((j) => j.id === e.joint);
        if (i < 0) throw new ApiError(`No joint "${e.joint}" on "${c.name}".`);
        const { joint: _j, ...patch } = e;
        void _j;
        joints[i] = jointSchema.parse({ ...joints[i], ...clean(patch), ...(patch.target !== undefined && { target: target(patch.target) }) });
      }
      const gone = new Set(input.remove ?? []);
      const kept = joints.filter((j) => !gone.has(j.id));
      c.joints = kept.length ? kept : undefined;
    });
    return { joints: (requireClip(rt.doc(), input.id).clip as VisualClip).joints ?? [] };
  },
});

const clean = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export const physicsInspect = defineCommand({
  id: "physics.inspect",
  summary: "A comp's simulation at a moment: every body (kind, collider, where it is then; a rigged piece says which bone it swings on), every rig's swinging bones, every force, every joint, and the settings.",
  effect: "read",
  input: z.object({ frameId: z.string().optional(), atMs: z.number().min(0).default(0) }),
  run(input, rt) {
    const doc = rt.doc();
    const frame = resolveTargetFrame(rt, input.frameId);
    const settings = simulationSchema.parse(frame.physics ?? {});
    const visual = doc.tracks.flatMap((t) => t.clips).filter((c): c is VisualClip => c.frameId === frame.id && c.kind !== "audio");
    const round = (n: number) => Math.round(n * 10) / 10;
    let bodies: Array<Record<string, unknown>>;
    let rigs: Array<Record<string, unknown>> = [];
    if (frame.world) {
      const ev = evaluateWorld(doc, frame, input.atMs);
      bodies = visual.filter((c) => c.physics).map((c) => {
        const o = ev.objects.find((x) => x.id === c.id);
        return { id: c.id, name: c.name, type: c.physics!.type, shape: c.physics!.shape, at: o ? matPosition(o.matrix).map(round) : null };
      });
    } else {
      const fp = flatPhysics(doc, frame.id);
      const now = resolveFlatPhysics(doc, frame.id, input.atMs);
      const localOf = (c: Clip) => Math.max(0, input.atMs - c.startMs);
      bodies = visual.filter((c) => c.physics && !isSpatialClip(c)).map((c) => {
        const r = locateClip(now, c.id)!.clip as VisualClip;
        const t = bakeClipAt(r, localOf(r)).transform;
        const body = fp?.scene.bodies.find((b) => b.id === c.id);
        const piece = rigPieceOf(doc, c.id);
        // Where it is in the comp — through its groups and its bone.
        const p = apply(groupChainMatrix(now, c.id, localOf), { x: t.x, y: t.y });
        return {
          id: c.id,
          name: c.name,
          type: c.physics!.type,
          shape: c.physics!.shape,
          ...(piece ? { rig: piece.rig.name, swingsOn: piece.bone?.name ?? "the rig itself (its root)" } : { pieces: body?.colliders.length ?? 0 }),
          at: { x: round(p.x), y: round(p.y), rotation: round(t.rotation) },
        };
      });
      rigs = (fp?.rigs ?? []).map((run) => {
        const g = locateClip(now, run.rig.id)?.clip as GroupClip | undefined;
        return {
          rig: run.rig.name,
          swinging: run.dynamic.map((d) => {
            const b = g?.rig?.bones.find((x) => x.id === d.bone);
            return { bone: b?.name ?? d.bone, rotation: round(b?.pose?.rotation ?? 0) };
          }),
        };
      });
    }
    return {
      frameId: frame.id,
      space: frame.world ? "world units, Z up" : "flat comp px, y down",
      settings,
      simulating: input.atMs >= settings.startMs,
      bodies,
      ...(rigs.length && { rigs }),
      forces: visual.filter((c) => c.forces?.length).map((c) => ({ id: c.id, name: c.name, stack: c.forces })),
      joints: visual.flatMap((c) => (c.joints ?? []).map((j) => ({ body: c.name, ...j, target: j.target ? (locateClip(doc, j.target)?.clip.name ?? j.target) : null }))),
    };
  },
});

export const PHYSICS_COMMANDS = [physicsBody, physicsScene, physicsForce, physicsEmit, physicsJoint, physicsInspect];
