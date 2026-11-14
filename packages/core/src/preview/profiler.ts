/**
 * THE PROFILER — which layer spent the frame?
 *
 * The governor (`render-budget.ts`) knows a frame took too long. This knows
 * WHY. Together they are the honest version of the "activity monitor" a canvas
 * app cannot actually build: we will not invent a GPU number we cannot measure,
 * but we can say exactly which layers our own renderer spent its milliseconds
 * inside, because every layer in the app already funnels through one function.
 *
 * That funnel is the whole reason this is cheap. `paintLayerNode` brackets each
 * layer; motion blur reports its share from inside the sampler. There is no
 * instrumentation scattered anywhere else, and there never should be: if a
 * future subsystem is expensive, it reports through this or it does not report
 * at all.
 *
 * Headless on purpose — `performance.now()` is passed in as a sample, never
 * called here, so the exporter and a worker can profile through the same sink.
 *
 * ## The number has to mean one thing
 *
 * A raw millisecond count is not comparable with itself, and shipping it as if
 * it were is how a cost readout becomes a liar. The SAME layer costs:
 *
 *   - a sixteenth as much at quarter preview resolution, because the work is
 *     per-pixel and the tier divides the pixels;
 *   - almost nothing when the layer cache served it, because that render was
 *     one `drawImage`.
 *
 * So a person watching the timeline while the governor drops a tier would see
 * every layer get cheap and conclude their project got lighter, and a person
 * whose heaviest layer is parked and cached would see it disappear from the
 * list entirely — at the exact moment they went looking for it.
 *
 * Both are fixed here rather than at the twenty places a cost is displayed:
 *
 *   NORMALISED. Every sample is divided by the pixel scale it was measured at
 *   (`scale²` — the work is area), so the reported figure always answers "what
 *   would this cost at full resolution", which is the only version of the
 *   question that is stable while the governor is moving underneath it.
 *
 *   A CACHE HIT IS NOT A COST. It is reported, because "this layer is cached"
 *   is exactly what a person wants to see, but it does not touch the cost
 *   average. The layer keeps the last price it actually charged.
 */

/** How a layer's pixels arrived this paint. */
export type LayerPaintSource = "rendered" | "cached";

export interface LayerSample {
  /** Pixel scale the frame was rendered at — 1 is full resolution. */
  scale: number;
  source: LayerPaintSource;
}

export interface LayerCost {
  clipId: string;
  name: string;
  /**
   * Total ms across the frames in this window, NORMALISED to full resolution.
   * Only real renders contribute — see the header.
   */
  totalMs: number;
  /** How many samples contributed — a layer drawn twice per frame counts twice. */
  calls: number;
  /** Of `totalMs`, how much went to motion blur specifically. */
  motionBlurMs: number;
  /** Samples the shutter actually spent, summed. 0 = never blurred. */
  motionBlurSamples: number;
  /** Paints in this window that came out of the layer cache rather than a render. */
  cachedCalls: number;
  /** How this layer's pixels arrived the LAST time it was painted. */
  lastSource: LayerPaintSource;
}

export interface FrameProfile {
  frames: number;
  /** Normalised total across the window. */
  totalMs: number;
  layers: LayerCost[];
}

/**
 * The sink the renderer writes into. A nullable field on `DrawOptions`, so
 * threading it costs nothing and reaches every draw path — including nested
 * comps, which is where a surprising cost usually hides.
 */
export interface RenderProfiler {
  layer(clipId: string, name: string, ms: number, sample: LayerSample): void;
  motionBlur(clipId: string, ms: number, samples: number): void;
  /**
   * A composite walked this comp. Called once per `drawFrameContent`, so a
   * nested comp three levels down reports itself — which is what lets an edit
   * inside a precomp invalidate the cached frames of everything that shows it,
   * without anyone maintaining a map of who nests whom.
   */
  comp(frameId: string): void;
  frame(ms: number, scale: number): void;
}

/**
 * What a layer costs is what it MEASURED — at the resolution it ran at.
 *
 * It used to be scaled up to a "full-resolution equivalent" by 1/s², on the
 * theory that all work is per-pixel. For a grain pass that is roughly true; for
 * a rectangle it is fiction — most of a cheap layer's cost is fixed overhead
 * that does not shrink with the tier — so at an eighth every badge was
 * multiplied by 64 and a half-millisecond rectangle read "31ms". Worse, the
 * layer cache read the same inflated number to decide what was "heavy", so
 * dropping the preview tier made EVERY layer look expensive and cached all of
 * them per frame: a lower resolution that made playback slower. Measured is
 * the only number that is true, and a lower tier genuinely is cheaper.
 */
function normalise(ms: number, _scale: number): number {
  return ms;
}

/**
 * A rolling accumulator over the last `window` frames.
 *
 * A window rather than a running total because the question is always "what is
 * slow RIGHT NOW" — a layer that was expensive thirty seconds ago before you
 * deleted its blur should not still be at the top of the list.
 */
export function createProfiler(window = 60): RenderProfiler & { read(): FrameProfile; reset(): void } {
  let frames = 0;
  let totalMs = 0;
  const layers = new Map<string, LayerCost>();

  const row = (clipId: string, name: string): LayerCost => {
    let r = layers.get(clipId);
    if (!r) {
      r = {
        clipId,
        name,
        totalMs: 0,
        calls: 0,
        motionBlurMs: 0,
        motionBlurSamples: 0,
        cachedCalls: 0,
        lastSource: "rendered",
      };
      layers.set(clipId, r);
    }
    // A rename mid-window should show the current name, not the one it had when
    // the window opened.
    r.name = name;
    return r;
  };

  const reset = () => {
    frames = 0;
    totalMs = 0;
    layers.clear();
  };

  return {
    layer(clipId, name, ms, sample) {
      const r = row(clipId, name);
      r.lastSource = sample.source;
      if (sample.source === "cached") {
        // Reported, never averaged: a blit is not what this layer costs, and
        // letting it into the average is how the heaviest layer in a document
        // vanishes from the list the moment it gets cheap to show.
        r.cachedCalls++;
        return;
      }
      r.totalMs += normalise(ms, sample.scale);
      r.calls++;
    },
    motionBlur(clipId, ms, samples) {
      const r = layers.get(clipId);
      if (!r) return;
      r.motionBlurMs += ms;
      r.motionBlurSamples += samples;
    },
    comp() {
      // The cost view is per LAYER; which comps were walked is the frame
      // cache's question, and `createFrameLedger` is the reader that answers it.
    },
    frame(ms, scale) {
      frames++;
      totalMs += normalise(ms, scale);
      if (frames >= window) {
        // Halve rather than clear: the list stays populated between windows, so
        // the panel never flashes empty while it is being read.
        frames = Math.floor(frames / 2);
        totalMs /= 2;
        for (const r of layers.values()) {
          r.totalMs /= 2;
          r.calls = Math.floor(r.calls / 2);
          r.motionBlurMs /= 2;
          r.motionBlurSamples = Math.floor(r.motionBlurSamples / 2);
          r.cachedCalls = Math.floor(r.cachedCalls / 2);
          if (r.calls === 0 && r.cachedCalls === 0) layers.delete(r.clipId);
        }
      }
    },
    read() {
      return {
        frames,
        totalMs,
        layers: [...layers.values()].sort((a, b) => b.totalMs - a.totalMs),
      };
    },
    reset,
  };
}

/**
 * WHO PAINTED INTO THIS ONE FRAME — the frame cache's other half.
 *
 * A cached composite is only re-usable while every layer that went into it is
 * still the layer it was, so the cache has to know what went into it. The only
 * answer that cannot drift from the picture is the one the PAINTER gives: the
 * ids it actually walked, this frame, including the ones three levels down
 * inside a group or a nested comp that no document-side model would have to
 * remember to recurse into.
 *
 * It is the same instrumentation point as the cost — `paintLayerNode` — which
 * is why this is a second reader of one sink and not a second pass over the
 * scene. `tee` is what lets both listen at once.
 */
export interface FrameLedger extends RenderProfiler {
  readonly clipIds: Set<string>;
  readonly frameIds: Set<string>;
  /** Total normalised ms this frame, for the governor. */
  readonly costMs: number;
  begin(): void;
}

export function createFrameLedger(): FrameLedger {
  const clipIds = new Set<string>();
  const frameIds = new Set<string>();
  let costMs = 0;
  return {
    clipIds,
    frameIds,
    get costMs() {
      return costMs;
    },
    begin() {
      clipIds.clear();
      frameIds.clear();
      costMs = 0;
    },
    layer(clipId, _name, ms, sample) {
      clipIds.add(clipId);
      if (sample.source === "rendered") costMs += normalise(ms, sample.scale);
    },
    motionBlur() {
      // Already inside the layer's own bracket.
    },
    comp(frameId) {
      frameIds.add(frameId);
    },
    frame() {
      // The ledger's window is one frame; `begin` opens it.
    },
  };
}

/** Both sinks, one draw. Nulls fall away so a caller never branches. */
export function teeProfiler(
  a: RenderProfiler | null | undefined,
  b: RenderProfiler | null | undefined,
): RenderProfiler | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return {
    layer: (id, n, ms, s) => {
      a.layer(id, n, ms, s);
      b.layer(id, n, ms, s);
    },
    motionBlur: (id, ms, n) => {
      a.motionBlur(id, ms, n);
      b.motionBlur(id, ms, n);
    },
    comp: (id) => {
      a.comp(id);
      b.comp(id);
    },
    frame: (ms, scale) => {
      a.frame(ms, scale);
      b.frame(ms, scale);
    },
  };
}
