import type { MotionDocument, Clip } from "../schema";
import { clipBox, frameDurationMs } from "../timeline/ops";
import { compFps } from "../timeline/fps";
import { clipLookup, frameClipEntries } from "../timeline/frame-index";
import type { ExprContext, ExprInstanceScope, ExprLayer } from "../expressions/globals";
import { exprLayerProperties, type ExprLayerApi } from "../expressions/layer-api";
import { FUNCTIONS_BY_NAME } from "../expressions/functions";
import { readInput, scopeAtOuterLocal } from "../components/inputs";
import { machineClockMs, readMachineState } from "../machines/inputs";
import { mediaLayerApi } from "../speech/source";
import { heardGeneration } from "./heard";
import { makeClipPropertyReader } from "./driver-env";
import { makeTrackApi } from "../tracking/expressions";

/**
 * THE HOST FACTS an expression reads — assembled once, used everywhere.
 *
 * `makeExprContext` is pure so the renderer can call it per draw, the editor
 * for its live preview, and a test, worker or exporter for the bake — and the
 * number the preview shows is the number the canvas is actually drawing. If two
 * surfaces ever built their own context, "it previews 42 but renders 0" becomes
 * a class of bug nobody can reproduce.
 */
export function makeExprContext(
  doc: MotionDocument,
  timeMs: number,
  compId: string | null,
  playing: boolean,
  layer: ExprLayer | null = null,
  /** The instance chain this comp is drawn through (component inputs). */
  scope: ExprInstanceScope | null = null,
): ExprContext {
  const frame = compId ? doc.frames.find((f) => f.id === compId) : undefined;
  return {
    compId,
    scope,
    readInput: (idOrName) => readInput(doc, scope, compId, idOrName),
    readMachine: (machine, layer) => (compId ? readMachineState(doc, compId, scope, timeMs, machine, layer, machineHost(doc, timeMs, compId, scope)) : null),
    layersIn: (otherCompId, t) => makeLayerApi(doc, otherCompId, t),
    timeMs,
    fps: compFps(doc, compId),
    comp: frame ? { width: frame.width, height: frame.height, durationMs: frameDurationMs(doc, frame) } : null,
    layer,
    playing,
    layers: makeLayerApi(doc, compId, timeMs),
    tracks: makeTrackApi(doc, compId, timeMs),
    // Overwritten per expression by `makeExprScope` — the id is what makes a
    // wobble stable, and only the resolver knows which expression it is running.
    seed: 0,
  };
}

/**
 * What a machine reads that only the host can answer: `speaking(layer)` at an
 * EARLIER instant of the machine clock (the fold looks back), through the same
 * expression function a field uses, so a machine and a mouth hear one voice.
 * Speech landing late bumps the generation, which keys the fold. The machine
 * verbs pass it too, or `machine.inspect` hears silence where the canvas talks.
 */
export function machineHost(doc: MotionDocument, timeMs: number, compId: string, scope: ExprInstanceScope | null | undefined) {
  const clock = machineClockMs(scope, timeMs);
  const speaking = FUNCTIONS_BY_NAME.get("speaking");
  return {
    generation: `s${heardGeneration()}`,
    // The WHOLE context moves to that instant — the scope too, or a voice
    // beside the instance (an outer comp, `resolveScopedLayer`) is heard at
    // "now" for every step of the fold, and the state depends on which
    // instant happened to fold first.
    speakingAt: (layer: string, atMs: number) =>
      !!speaking && speaking.call([layer], makeExprContext(doc, timeMs + (atMs - clock), compId, false, null, scopeAtOuterLocal(scope, atMs)), 0) === 1,
  };
}

/**
 * THE LAYER API — one answer to "what does a layer have, and what is it?".
 *
 * Both halves come from something that already existed and is already shared:
 * the property surface is `exprLayerProperties`, which is `clipAnimatableProperties`
 * — the projection a Layer node builds its sockets from — and the reader is
 * `makeClipPropertyReader`, the same one the node engine samples through.
 *
 * That is the whole point. `#layer.rotation`, `layer("Title").rotation` and a
 * Layer node's Rotation socket are one question asked three ways, so they cannot
 * come back with three answers, and a property added to the document tomorrow is
 * writable and wireable on the same day with nothing to add here.
 *
 * Layers resolve by NAME within the current comp, because that is how the
 * timeline labels one and how a person writing a sentence refers to it; an id in
 * source text would be unreadable and unportable.
 */
export function makeLayerApi(doc: MotionDocument, compId: string | null, timeMs: number): ExprLayerApi {
  const read = makeClipPropertyReader(doc);
  // The comp's layers from core's per-document index, listed once per API —
  // every lookup used to rescan every clip in the project.
  let list: readonly Clip[] | null = null;
  const clips = (): readonly Clip[] => (list ??= compId ? frameClipEntries(doc, compId).map((e) => e.clip) : doc.tracks.flatMap((t) => t.clips));
  const clipOf = clipLookup(doc);
  const byId = (id: string) => {
    const clip = clipOf(id);
    return clip && (!compId || clip.frameId === compId) ? clip : undefined;
  };
  return {
    // A KEY (`clip:<id>`) is exact and rename-proof — what a pick writes; a
    // name is what a person types. Both resolve within this comp only.
    idFor: (name) => {
      const keyed = /^clip:(\S+)$/.exec(name.trim());
      if (keyed) return byId(keyed[1]!)?.id;
      const wanted = name.trim().toLowerCase();
      return clips().find((c) => c.name.trim().toLowerCase() === wanted)?.id;
    },
    nameOf: (id) => byId(id)?.name,
    propertiesOf: (id) => {
      const clip = byId(id);
      return clip ? exprLayerProperties(clip) : [];
    },
    read: (id, path) => read(id, path, timeMs),
    all: () => clips().map((c) => ({ id: c.id, name: c.name })),
    // Where a voice is in its recording, and how a layer acts a mouth — the
    // ONE source-time map (core `clipSourceTimeAt`), built in core.
    ...mediaLayerApi(doc, timeMs, byId),
  };
}

/**
 * The layer facts for one clip. `index` is its TRACK ROW, which is both the
 * order the timeline shows and the order the renderer paints (row 0 is the top
 * lane and paints above the rest), so `#layer.index` means the same thing
 * wherever a person looks — and costs nothing to compute.
 *
 * THE BOX IS MEASURED ONLY WHEN READ. The renderer scopes every layer of a
 * document with expressions through this, and a text layer's box is a text
 * layout: measured eagerly, one expression anywhere in a project laid out
 * every text layer of every comp on every frame (0.8 s of the Playground's
 * first paint) for a `#layer.width` nobody asked for.
 */
export function exprLayerFor(doc: MotionDocument, clip: Clip, index: number): ExprLayer {
  let box: { width: number; height: number } | null = null;
  const measured = () => (box ??= clipBox(doc, clip));
  const opacity = "opacity" in clip && typeof clip.opacity === "number" ? clip.opacity : 1;
  return {
    id: clip.id,
    name: clip.name,
    index,
    startMs: clip.startMs,
    durationMs: clip.durationMs,
    get width() {
      return measured().width;
    },
    get height() {
      return measured().height;
    },
    opacity,
  };
}
