import { current, isDraft } from "immer";
import type { MotionDocument, Clip, GroupClip, KeyframeValue, NodeValue, VisualClip } from "../schema";
import type { ExprContext, ExprInstanceScope } from "../expressions/globals";
import { withExpressionContext, withExpressionLayer, withFieldValue } from "../expressions/bind";
import { channelValueAt } from "../animation/channels";
import { getVariableClock, setVariableClock } from "../variables";
import { resolveDriver, type DriverEnv } from "../nodes/drivers";
import { resolveClipDriver, resolveClipDrivers, resolveDocumentDrivers } from "../nodes/resolve-clip";
import { clipByIdIn, clipLookup, clipRowIn } from "../timeline/frame-index";
import { clipsUnderGroup, isGroupClip } from "../timeline/groups";
import { noteBakedFrom, settleDocument, storedDocumentOf } from "../timeline/settled";
import { documentHasRelations, resolveDocumentRelations } from "../relations/resolve";
import { documentHasFlatPhysics, flatBodyAt, resolveFlatPhysics } from "../physics/flat";
import { outlineGeneration } from "../physics/outline";
import { applyPoseMixes, documentHasPoses, type PoseEnv } from "../rig/poses";
import { asInstanceScope, documentHasInputs, readInput, scopeAtOuterLocal, scopeCacheKey } from "../components/inputs";
import { documentHasMachines } from "../machines/inputs";
import { heardGeneration } from "./heard";
import { installWorldNestedResolver } from "../world/evaluate";
import { makeDriverEnv } from "./driver-env";
import { applyTrackFollow, documentHasFollowers } from "../tracking/follow";
import { exprLayerFor, makeExprContext } from "./expr-context";
import { documentHasUnits, documentReadsLengths, lengthReader, resolveDocumentUnits } from "../units/resolve";
import type { LengthView } from "../units/length";

/**
 * THE ONE PLACE A TOKEN BECOMES A VALUE.
 *
 * `resolveDocumentDrivers` is the brain; this is its single call site. The
 * renderer, the stage's chrome, the inspector, the layers panel, the node board,
 * the agent's verbs and the tests all ask the same question — "what does this
 * document actually say at this instant, in this comp, through this instance?"
 * — and they all ask it here, so they cannot come back with different answers.
 * Grep for `resolveDocumentDrivers` outside this file: every hit would be a
 * second opinion. It is headless on purpose: a test, a worker or an exporter
 * evaluates a character exactly as the canvas draws it.
 *
 * Three things it owns that the callers must not have to remember:
 *
 *  - **The ambient expression context.** An `fx:` driver reads `#time`,
 *    `#comp.*` and `#layer.*` from the ambient context, so the context has to be
 *    right *while the bake runs* — not only while the canvas paints. React
 *    callers never set one, which is why an inspector field used to report an
 *    expression's value at time zero.
 *  - **Idempotence.** The renderer hands its already-resolved document down to
 *    nested comps, which resolve again at their own time. Normalising back to
 *    the raw source (`storedDocumentOf`) keeps every bake a first bake: a driver that
 *    reads another layer reads it through this bake's own pass (`driverPass`),
 *    never through a value an outer bake already wrote.
 *  - **Memoisation.** One resolution per (document, comp, instant) is shared by
 *    every surface, so the chrome is not paying to re-derive what the canvas
 *    just computed. Keyed on document identity, so an edit invalidates
 *    everything for free.
 */

/** What a bake was asked — so a reader of one can ask again at another instant. */
const askedOf = new WeakMap<MotionDocument, Asked>();
type Asked = { compId: string | null; timeMs: number; playing: boolean; scope: ExprInstanceScope | null; view: LengthView | null };

/** Per-document cache of resolutions, keyed by comp + instant + transport. */
const cacheOf = new WeakMap<MotionDocument, Map<string, MotionDocument>>();

/** How many (comp, instant) resolutions of one document stay warm, least
 *  recently used first out. ONE frame's draw asks for the root plus every
 *  nested comp it recurses into — a film's master can show dozens — so a limit
 *  smaller than one frame evicted its own entries mid-frame and re-baked every
 *  comp on every repaint. Entries are cheap: a resolution shares everything
 *  with the raw document except the clips it re-baked, and the whole map dies
 *  with the document. */
const CACHE_LIMIT = 256;

/** Whole-comp bakes run so far (cache misses) — what a frame's cost is counted in. */
let bakes = 0;
export function bakeCount(): number {
  return bakes;
}

/**
 * WHAT A BAKE WAS ASKED — its comp, transport and instance scope. Null for a
 * raw document, or a bake that changed nothing (it IS the raw document). A
 * reader that must answer for one comp checks this before trusting a bake it
 * was handed: a bake of another comp left that comp's layers unresolved.
 */
export function bakeAskedOf(doc: MotionDocument): Readonly<Asked> | null {
  return askedOf.get(doc) ?? null;
}

/**
 * A COMP AS IT IS AT AN INSTANT — the one way a reader holding SOME document
 * asks for "comp `compId`, resolved at `timeMs`": the bake it holds when that
 * is already the answer, else the (memoised) bake of that comp at that
 * instant, on the same transport (and instance scope, when it is the same
 * comp's).
 *
 * A bake has every driven field written into its clip and the field's keys
 * dropped, so reading a bake at ANOTHER instant, or for another comp, reads
 * frozen values: a world posed every shutter instant from the frame's bake
 * froze an expression-driven carousel (no blur), and a trace read through its
 * parent's bake sampled a nested ball at its stored base. Ask here instead.
 */
export function bakeOfCompAt(doc: MotionDocument, compId: string, timeMs: number): MotionDocument {
  const asked = askedOf.get(doc);
  if (asked && asked.compId === compId && asked.timeMs === timeMs) return doc;
  const same = asked?.compId === compId;
  return resolvedDocAt(storedDocumentOf(doc), timeMs, compId, asked?.playing ?? false, same ? asked.scope : null, same ? asked.view : null);
}

/**
 * A BAKE ASKED AT ANOTHER INSTANT — `bakeOfCompAt` for a document this module
 * baked; anything else (a raw document, one composed by hand) comes back as
 * handed. What a reader that takes "the document as handed" uses, so a bake of
 * one instant is never read as if it were another.
 */
export function rebakeAt(doc: MotionDocument, compId: string, timeMs: number): MotionDocument {
  return askedOf.has(doc) ? bakeOfCompAt(doc, compId, timeMs) : doc;
}

/** The raw document a bake came from (a raw document is its own source). */
export function bakeSourceOf(doc: MotionDocument): MotionDocument {
  return storedDocumentOf(doc);
}

// A world component placed in a world resolves at its own instant, like a
// nested comp the 2D renderer recurses into (`installWorldNestedResolver`).
// Installed on first use — the world module reaches this one through physics,
// so at load time either may still be initialising.
let nestedInstalled = false;

export function resolvedDocAt(
  doc: MotionDocument,
  timeMs: number,
  compId: string | null,
  playing = false,
  /**
   * The instance chain this comp is drawn through (component inputs). Its
   * `scopeCacheKey` is part of the bake key: two instances with different
   * inputs get two bakes, equal ones share one.
   */
  scope: ExprInstanceScope | null = null,
  /**
   * How this comp is SEEN — output px per comp px and the output's size
   * (`units/length.ts`). Only screen units (`spx`, `vw`…) read it, and only a
   * document holding a unit keys on it; null = the comp is its own output.
   */
  view: LengthView | null = null,
): MotionDocument {
  if (!nestedInstalled) {
    nestedInstalled = true;
    installWorldNestedResolver({ nested: bakeOfCompAt, at: rebakeAt });
  }
  const raw = storedDocumentOf(doc);
  // Nothing can be driven without one of these, and building the env walks every
  // clip — so the common document pays nothing at all. Relations (a text on a
  // path, an auto layout) are the other way a value gets derived, and they are
  // resolved in the same pass so the two cannot disagree about an instant.
  const driven = raw.graphs.length > 0 || raw.expressions.length > 0 || raw.variables.length > 0 || documentHasInputs(raw) || documentHasMachines(raw);
  const physics = !!compId && documentHasFlatPhysics(raw);
  const posed = documentHasPoses(raw);
  const followed = !!compId && documentHasFollowers(raw);
  const units = documentHasUnits(raw);
  if (!driven && !posed && !followed && !units && !documentHasRelations(raw) && !physics) return raw;
  // Only a document whose values depend on how a comp is seen keys on it.
  const seen = units || documentReadsLengths(raw) ? view : null;

  // A late outline (a font, a picture) re-shapes bodies: its generation keys the bake.
  const key = `${compId ?? ""}@${timeMs}${playing ? "!" : ""}${physics ? `#${outlineGeneration()}` : ""}${posed ? previewKey : ""}${driven || posed ? `~${heardGeneration()}` : ""}${scopeTerm(raw, compId, scope)}${seen ? `^${seen.scale}:${seen.scaleY ?? seen.scale}:${seen.width}x${seen.height}` : ""}`;
  let cache = cacheOf.get(raw);
  if (!cache) {
    cache = new Map();
    cacheOf.set(raw, cache);
  }
  const hit = cache.get(key);
  if (hit) {
    // Recency, so a frame's own comps are never the ones evicted.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const resolved = bake(raw, timeMs, compId, playing, driven, posed, followed, scope, units, seen);
  bakes++;
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, resolved);
  if (resolved !== raw) {
    noteBakedFrom(resolved, raw);
    askedOf.set(resolved, { compId, timeMs, playing, scope, view: seen });
    // Immutable from here on: every per-document memo in core may keep it (see
    // core `settled.ts`) — or each nested draw re-indexes the whole project.
    settleDocument(resolved);
  }
  return resolved;
}

/**
 * A CLIP AS ITS BAKE'S COMP RESOLVES IT AT ANOTHER INSTANT — what a reader
 * holding one instant's bake asks when it must look at a neighbouring one:
 * the shutter's sub-samples. A driven property's keys are dropped in the bake
 * (`clip.x` is where the layer IS), so sampling the baked clip's keys at
 * t ± ε reads the same value at every sub-sample and a simulated body, a
 * tracked layer or an expression-driven move never smeared.
 *
 * A clip the bake did not touch (the same object as the raw one — bakes share
 * everything they do not re-derive) comes back as is, with no second bake:
 * its own keys already answer every instant. Same comp, transport and
 * instance scope as the bake it was read from.
 *
 * A SUB-SAMPLE COSTS THE LAYER, NOT THE COMP. A body is its own pose from the
 * run (`flatBodyAt`), a driven layer its own drivers at that instant (reading
 * other layers on demand) — no whole-comp bake. The shutter reads each body at
 * as many instants as its speed asks for, and the counts differ per body, so a
 * frame of 130 balls asked about a hundred instants: a hundred bakes of every
 * expression in the comp, 25× the frame's own cost. Only a layer that poses,
 * a tracker or a relation reshaped (they read the comp), or a group whose
 * members the bake re-derived, still asks for the whole comp at that instant.
 */
export function clipAtInstant<C extends Clip>(doc: MotionDocument, clip: C, timeMs: number): { doc: MotionDocument; clip: C } {
  const asked = askedOf.get(doc);
  const raw = storedDocumentOf(doc);
  if (!asked || raw === doc) return { doc, clip };
  const stored = clipByIdIn(raw, clip.id);
  if (stored === clip) return { doc, clip };
  const own = stored ? ownAt(doc, raw, asked, stored, timeMs) : null;
  if (own && own.kind === clip.kind) return { doc, clip: own as C };
  const at = resolvedDocAt(raw, timeMs, asked.compId, asked.playing, asked.scope, asked.view);
  const moved = clipByIdIn(at, clip.id);
  return moved && moved.kind === clip.kind ? { doc: at, clip: moved as C } : { doc, clip };
}

/** One layer at another instant from its own derivations — see `clipAtInstant`. Null = bake the comp. */
function ownAt(doc: MotionDocument, raw: MotionDocument, asked: Asked, stored: Clip, timeMs: number): Clip | null {
  const stages = stagesOf.get(doc);
  if (!stages || stored.kind === "audio") return null;
  const id = stored.id;
  const afterDrivers = clipByIdIn(stages.drivers, id);
  if (clipByIdIn(stages.related, id) !== afterDrivers) return null;
  if (isGroupClip(stored) && clipsUnderGroup(raw, id).some((m) => clipByIdIn(doc, m) !== clipByIdIn(raw, m))) return null;
  const driven = afterDrivers === stored ? stored : driversAt(doc, raw, asked, timeMs, stored);
  return asked.compId && documentHasFlatPhysics(raw) ? flatBodyAt(raw, asked.compId, timeMs, doc, driven as VisualClip) : driven;
}

/** One clip's drivers at an instant, under that instant's pass (one per bake and instant). */
function driversAt(doc: MotionDocument, raw: MotionDocument, asked: Asked, timeMs: number, stored: Clip): Clip {
  let byInstant = passesOf.get(doc);
  if (!byInstant) passesOf.set(doc, (byInstant = new Map()));
  let pass = byInstant.get(timeMs);
  if (!pass) {
    pass = driverPass(raw, timeMs, asked.compId, asked.playing, asked.scope, asked.view);
    if (byInstant.size >= CACHE_LIMIT) byInstant.delete(byInstant.keys().next().value!);
    byInstant.set(timeMs, pass);
  }
  const { env, ctx } = pass;
  return withExpressionContext(ctx, () => resolveClipDrivers(stored, timeMs, env));
}

/** A bake's documents before the stages after its drivers — what `ownAt` tells a layer's derivations apart by. */
const stagesOf = new WeakMap<MotionDocument, { drivers: MotionDocument; related: MotionDocument }>();

/** Driver passes at a bake's neighbouring instants (the shutter's), per bake. */
const passesOf = new WeakMap<MotionDocument, Map<number, DriverPass>>();

function bake(
  raw: MotionDocument,
  timeMs: number,
  compId: string | null,
  playing: boolean,
  driven: boolean,
  posed: boolean,
  followed: boolean,
  scope: ExprInstanceScope | null,
  units: boolean,
  view: LengthView | null,
): MotionDocument {
  // Drivers first, relations after: a laid-out member whose width is driven
  // is laid out at its driven width, and a text whose host is driven follows
  // the host where the driver put it. Pose sets sit between (ADR-characters,
  // amendment 5): a driver picks the pose, the pose writes its members, and
  // shape keys, relations and physics see the posed values.
  // Every stage is noted as a bake of `raw` BEFORE the next reads it, so a
  // group's pivot is measured at rest in each of them (`storedDocumentOf`).
  const withDrivers = noteBakedFrom(driven ? bakeDrivers(raw, timeMs, compId, playing, scope, view) : raw, raw);
  const posedDoc = noteBakedFrom(posed ? applyPoseMixes(withDrivers, timeMs, compId, poseEnv(raw, timeMs, compId, playing, scope)) : withDrivers, raw);
  // Followers after poses: a tracker places a layer that drivers and poses
  // have already shaped, and relations (a text on a path) follow it there.
  const followedDoc = noteBakedFrom(followed && compId ? applyTrackFollow(posedDoc, compId, timeMs) : posedDoc, raw);
  // Units after everything that writes a value or a scale, before the layout
  // that measures the result (`units/resolve.ts`).
  const sized = noteBakedFrom(units ? resolveDocumentUnits(followedDoc, timeMs, compId, view) : followedDoc, raw);
  const related = noteBakedFrom(resolveDocumentRelations(sized, timeMs, compId), raw);
  // Bodies last: the simulation is built from the raw document (one build per
  // edit), its poses written where the layers are now.
  const out = compId && documentHasFlatPhysics(raw) ? resolveFlatPhysics(raw, compId, timeMs, related) : related;
  // The stages are as immutable as the bake: settled, so reading a clip in one is an index hit.
  if (out !== raw) stagesOf.set(out, { drivers: settleDocument(withDrivers), related: settleDocument(related) });
  return out;
}

function bakeDrivers(raw: MotionDocument, timeMs: number, compId: string | null, playing: boolean, scope: ExprInstanceScope | null, view: LengthView | null): MotionDocument {
  const { env, ctx } = driverPass(raw, timeMs, compId, playing, scope, view);
  return withExpressionContext(ctx, () => resolveDocumentDrivers(raw, timeMs, env, compId));
}

/** What a driver pass at one instant runs under: the env, and the expression context it reads. */
interface DriverPass {
  env: DriverEnv;
  ctx: ExprContext;
}

/**
 * THE DRIVER PASS OF AN INSTANT — the env and context every driven field of
 * the comp resolves under, at that instant.
 *
 * Reading another layer reads what it IS: `layer("Count").x`, a graph's
 * Layer node and `#layer`-free reads of any driven field go through `driven`,
 * which runs that field's own driver (in its own layer scope) on first ask and
 * remembers it for the rest of the pass — the bake writing that field later
 * takes the same answer. The base reader only knew keys and base, so a layer
 * following an expression-driven one followed its stored 0. A cycle (A reads
 * B reads A) is cut where it closes: that read gets the field's keys or base,
 * never a stack overflow. Fields of other comps, and other instants, read keys
 * and base: they are drawn at their own time.
 */
function driverPass(raw: MotionDocument, timeMs: number, compId: string | null, playing: boolean, scope: ExprInstanceScope | null, view: LengthView | null = null): DriverPass {
  const env = withInputs(makeDriverEnv(raw, timeMs, compId), raw, compId, scope);
  // `#layer.*` is a fact about the clip being resolved, so it is set per clip
  // and torn down after — the same contract the renderer honours per layer.
  const scopeClip = <T,>(clip: Clip, fn: () => T): T => withExpressionLayer(exprLayerFor(raw, clip, Math.max(0, clipRowIn(raw, clip.id))), fn);
  env.scopeClip = scopeClip;
  const memo = new Map<Clip, Map<string, NodeValue | undefined>>();
  const open = new Set<string>();
  const driven = (clip: Clip, path: string): NodeValue | undefined => {
    const known = memo.get(clip);
    if (known?.has(path)) return known.get(path);
    const token = clip.drivers?.[path];
    const key = `${clip.id}\u0000${path}`;
    if (!token || open.has(key)) return undefined;
    open.add(key);
    let value: NodeValue | undefined;
    try {
      value = scopeClip(clip, () => resolveClipDriver(clip, path, token, timeMs, env));
    } finally {
      open.delete(key);
    }
    if (known) known.set(path, value);
    else memo.set(clip, new Map([[path, value]]));
    return value;
  };
  env.driven = driven;
  const stored = env.readProperty;
  const clipOf = clipLookup(raw);
  env.readProperty = (id, path, t) => {
    const clip = t === timeMs ? clipOf(id) : undefined;
    if (clip?.drivers?.[path] && (!compId || clip.frameId === compId)) {
      const v = driven(clip, path);
      if (v !== undefined && typeof v !== "object") return v;
    }
    return stored(id, path, t);
  };
  const made = makeExprContext(raw, timeMs, compId, playing, null, scope);
  // `spx(2)`, `fw(50)` in an expression: px per unit for the layer it drives.
  const ctx = { ...made, lengths: lengthReader(raw, timeMs, view) };
  const layers = ctx.layers;
  return { env, ctx: layers ? { ...ctx, layers: { ...layers, read: (id, path) => env.readProperty(id, path, timeMs) } } : ctx };
}

/**
 * THE POSE CHANNEL'S DRIVER, RE-RUN AT ANY INSTANT — what the PoseMix look-back
 * and the pose verbs (inspect, bake) read. Amendment 6: the one driver re-runs
 * at each earlier frame under the bake's own expression context shifted to
 * that instant — never `resolvedDocAt(t')`, which would bake every comp again
 * per look-back step. The env is the bake's, so a set driven by
 * `lipsync(input("Voice"))`, `state("Mood")` or a node graph answers here
 * exactly as it does on the canvas.
 */
export function poseDriverAt(
  raw: MotionDocument,
  timeMs: number,
  compId: string | null,
  playing = false,
  scope: ExprInstanceScope | null = null,
): NonNullable<PoseEnv["driverAt"]> {
  let base: DriverEnv | null = null;
  const outerLocal = asInstanceScope(scope)?.outerLocalMs ?? 0;
  return (group: GroupClip, path: string, token: string, t: number): KeyframeValue | undefined => {
    base ??= makeDriverEnv(raw, timeMs, compId);
    // The WHOLE context at t′ — layers, inputs, machine, and the scope on its
    // outer clock. Spreading the bake's context with only `timeMs: t′` left
    // every host reader at the bake instant: `lipsync()` heard the voice
    // "now" at every look-back step, so a lip-synced float pose (a key
    // weight, a jaw, a y) never eased — it jumped.
    const at = t === timeMs ? scope : scopeAtOuterLocal(scope, outerLocal + (t - timeMs), raw);
    const env = withInputs({ ...base }, raw, compId, at);
    // `#value`: the channel's own keys or base at t′ — what a blink rides on.
    const own = () => {
      const v = channelValueAt(group, path, t - group.startMs);
      return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : undefined;
    };
    const run = () => {
      const v = withFieldValue(own, () => resolveDriver(token, t, env));
      return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : undefined;
    };
    const clock = getVariableClock();
    if (clock !== null) setVariableClock(clock + (t - timeMs));
    try {
      return withExpressionContext(makeExprContext(raw, t, compId, playing, null, at), () => withExpressionLayer(exprLayerFor(raw, group, Math.max(0, clipRowIn(raw, group.id))), run));
    } finally {
      if (clock !== null) setVariableClock(clock);
    }
  };
}

function poseEnv(raw: MotionDocument, timeMs: number, compId: string | null, playing: boolean, scope: ExprInstanceScope | null): PoseEnv {
  return {
    ...poseEnvAt(raw, timeMs, compId, playing, scope),
    force: posePreview ? (groupId, setId) => (posePreview && posePreview.key === `${groupId}/${setId}` ? posePreview.poseId : undefined) : undefined,
  };
}

/**
 * THE POSE ENV OF AN INSTANT — what every reader of a character outside the
 * bake passes (the timeline's lanes, the Face pad, the pose verbs, a drag):
 * the pose channel's driver re-run at any instant (`poseDriverAt`) and the
 * expression context behaviors read there (instance scope on its outer clock,
 * machines, layers through the instance chain). One factory, so a lane, a
 * tile and the canvas hear the same voice and blink on the same frames.
 */
export function poseEnvAt(raw: MotionDocument, timeMs: number, compId: string | null, playing = false, scope: ExprInstanceScope | null = null): PoseEnv {
  const outerLocal = asInstanceScope(scope)?.outerLocalMs ?? 0;
  // Inside a write the caller may hand us its DRAFT. Every reader below may
  // memoise on the document it is given (a machine's fold adopts the last
  // one), and a draft is revoked the moment the write ends — so they read a
  // snapshot of it, taken once, only if they read at all.
  let doc: MotionDocument | null = isDraft(raw) ? null : raw;
  const settled = () => (doc ??= current(raw));
  let driverAt: NonNullable<PoseEnv["driverAt"]> | null = null;
  return {
    driverAt: (group, path, token, t) => (driverAt ??= poseDriverAt(settled(), timeMs, compId, playing, scope))(group, path, token, t),
    contextAt: (t) => makeExprContext(settled(), t, compId, playing, null, t === timeMs ? scope : scopeAtOuterLocal(scope, outerLocal + (t - timeMs), settled())),
  };
}

/** The bake-key term for a scoped comp ("" = the comp's own picture). */
function scopeTerm(raw: MotionDocument, compId: string | null, scope: ExprInstanceScope | null): string {
  const key = compId && scope ? scopeCacheKey(raw, compId, scope) : "";
  return key ? `|${key}` : "";
}

/** `input:<id>` drivers read the comp's inputs in the bake's instance scope. */
function withInputs<E extends DriverEnv>(env: E, raw: MotionDocument, compId: string | null, scope: ExprInstanceScope | null): E {
  env.readInput = (id) => readInput(raw, scope, compId, id);
  return env;
}

/**
 * THE FACE PAD'S HOVER PREVIEW — one set shown in one pose outright. A view
 * flag: it keys the bake and never reaches the document; the host sets it for
 * the stage and clears it the moment the pointer leaves the tile (the web
 * wrapper also marks the stage dirty).
 */
let posePreview: { key: string; poseId: string } | null = null;
let previewKey = "";
export function setBakePosePreview(next: { groupId: string; setId: string; poseId: string } | null): void {
  posePreview = next ? { key: `${next.groupId}/${next.setId}`, poseId: next.poseId } : null;
  previewKey = posePreview ? `~${posePreview.key}=${posePreview.poseId}` : "";
}
