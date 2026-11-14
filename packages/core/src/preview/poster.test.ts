import { describe, expect, it } from "vitest";
import {
  clipPosterSource,
  planPosterTiles,
  posterHeightTier,
  posterTileFloorPx,
  POSTER_HEIGHT_TIERS,
  POSTER_MAX_TILE_PX,
  POSTER_MIN_TILE_PX,
  type PosterPlanInput,
} from "./poster";
import { sourcePhaseAt } from "../animation/evaluate";
import type { ClipPlayback } from "../schema";

/**
 * The poster plan is the one thing in this feature that has to be RIGHT rather
 * than merely plausible: it decides which picture the timeline claims a clip is
 * showing at a given instant. Everything below pins that claim against the same
 * playback map the renderer uses, so a strip cannot say "frame 4" while the
 * canvas draws frame 7.
 */

const playback = (over: Partial<ClipPlayback> = {}): ClipPlayback => ({
  speed: 1,
  loop: "none",
  reverse: false,
  loopLengthMs: null,
  ...over,
});

/** A plan over a source of `sourceMs` length, sampled through the real map. */
function plan(over: Partial<PosterPlanInput> & { sourceSpanMs?: number; pb?: ClipPlayback } = {}) {
  const { sourceSpanMs = 1000, pb = playback(), ...rest } = over;
  const input: PosterPlanInput = {
    durationMs: 1000,
    // 100 px/s: a 1s clip is 100px wide, so tile widths read directly as px/10.
    pxPerMs: 0.1,
    renderStepMs: 1000 / 60,
    sourceStepMs: 1000 / 10, // a 10fps source: 10 pictures per source second
    speed: pb.speed,
    phaseAt: (localMs) => sourcePhaseAt(localMs, sourceSpanMs, pb),
    minTilePx: 1, // tiny, so the tests see the true cut and not the floor
    ...rest,
  };
  return planPosterTiles(input);
}

describe("planPosterTiles — the cut follows the source, not the pixels", () => {
  it("cuts one tile per source frame at 1× over a matching span", () => {
    const tiles = plan();
    // 1000ms of a 10fps source = 10 pictures.
    expect(tiles).toHaveLength(10);
    expect(tiles.map((t) => Math.round(t.sourceMs))).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(tiles[0]!.startMs).toBe(0);
    expect(tiles.at(-1)!.endMs).toBe(1000);
  });

  it("is SPEED-safe: 2× shows twice the source in the same wall span", () => {
    const tiles = plan({ pb: playback({ speed: 2, loop: "loop" }), sourceSpanMs: 2000 });
    // 1000ms of wall at 2× reads 2000ms of source = 20 pictures at 10fps.
    expect(tiles).toHaveLength(20);
    expect(Math.round(tiles.at(-1)!.sourceMs)).toBe(1900);
  });

  it("is SPEED-safe downwards: 0.5× stretches each picture over twice the wall", () => {
    const tiles = plan({ pb: playback({ speed: 0.5 }), sourceSpanMs: 2000 });
    expect(tiles).toHaveLength(5); // only 500ms of source is read in 1000ms of wall
    // Each source frame now occupies 200ms of wall instead of 100ms.
    expect(tiles[1]!.startMs - tiles[0]!.startMs).toBeCloseTo(200, 0);
  });

  it("is LOOP-safe: the pictures restart and the pass is counted", () => {
    const tiles = plan({ durationMs: 1000, sourceSpanMs: 400, pb: playback({ loop: "loop" }) });
    // Two and a half passes over a 400ms source.
    expect(Math.max(...tiles.map((t) => t.cycleIndex))).toBe(2);
    // The source time restarts at every pass boundary.
    const starts = tiles.filter((t) => t.cycleStart).map((t) => Math.round(t.sourceMs));
    expect(starts).toEqual([0, 0]);
    // A looping clip is never "held" — it always has a next picture.
    expect(tiles.some((t) => t.held)).toBe(false);
  });

  it("is PING-PONG-safe: the second pass runs the pictures back", () => {
    const tiles = plan({ durationMs: 800, sourceSpanMs: 400, pb: playback({ loop: "pingpong" }) });
    const forward = tiles.filter((t) => t.cycleIndex === 0).map((t) => t.sourceMs);
    const back = tiles.filter((t) => t.cycleIndex === 1).map((t) => t.sourceMs);
    expect(forward).toEqual([...forward].sort((a, b) => a - b));
    expect(back).toEqual([...back].sort((a, b) => b - a));
  });

  it("is REVERSE-safe: play-once reversed walks the source down from the end", () => {
    const tiles = plan({ sourceSpanMs: 1000, pb: playback({ reverse: true }) });
    const times = tiles.map((t) => t.sourceMs);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("collapses a play-once tail into ONE held tile", () => {
    // A 1000ms clip over a 300ms source: 300ms of motion, 700ms frozen.
    const tiles = plan({ durationMs: 1000, sourceSpanMs: 300 });
    const held = tiles.filter((t) => t.held);
    expect(held).toHaveLength(1);
    expect(held[0]!.endMs).toBe(1000);
    // The frozen stretch is one wide tile, not seven identical thumbnails.
    expect(held[0]!.endMs - held[0]!.startMs).toBeGreaterThan(600);
  });

  it("holds a slow source: a 2fps comp cuts on twos, not on the parent's grid", () => {
    const tiles = plan({ sourceStepMs: 500, sourceSpanMs: 1000 });
    expect(tiles).toHaveLength(2);
    expect(tiles.map((t) => t.sourceMs)).toEqual([0, 500]);
  });

  it("a still is one tile spanning the clip, whatever its length", () => {
    const tiles = plan({ sourceStepMs: Infinity, durationMs: 60_000 });
    expect(tiles).toEqual([
      { startMs: 0, endMs: 60_000, sourceMs: 0, cycleIndex: 0, held: false, cycleStart: false },
    ]);
  });
});

describe("planPosterTiles — bounded cost, stable identity", () => {
  it("skips frames rather than cutting illegible tiles", () => {
    // A 10fps source at 20px/s: one source frame is 2px wide.
    const tiles = plan({ pxPerMs: 0.02, minTilePx: 18 });
    for (const t of tiles) expect((t.endMs - t.startMs) * 0.02).toBeGreaterThanOrEqual(17.9);
  });

  it("never exceeds the tile ceiling, however long the clip", () => {
    const tiles = plan({ durationMs: 3_600_000, sourceSpanMs: 3_600_000, pxPerMs: 100, maxTiles: 96 });
    expect(tiles.length).toBeLessThanOrEqual(96);
  });

  it("tile source times are ZOOM-INVARIANT — the whole reason a zoom is free", () => {
    // Same clip, three zoom levels. Every picture the coarse plan asks for must
    // also be asked for by the fine one, so zooming in only ADDS cache entries
    // and zooming out reads entries it already has.
    const fine = new Set(plan({ pxPerMs: 1 }).map((t) => Math.round(t.sourceMs)));
    for (const px of [0.1, 0.3]) {
      for (const tile of plan({ pxPerMs: px })) {
        expect(fine.has(Math.round(tile.sourceMs))).toBe(true);
      }
    }
  });

  it("trimming or moving a clip changes no picture's identity", () => {
    // Trim-in is applied by the clip layer, so a shorter clip over the same
    // source asks for a PREFIX of the same source times — never new ones.
    const full = plan({ durationMs: 1000 }).map((t) => t.sourceMs);
    const short = plan({ durationMs: 400 }).map((t) => t.sourceMs);
    expect(full.slice(0, short.length)).toEqual(short);
  });

  it("tiles tile the clip exactly — no gaps, no overlaps", () => {
    for (const tiles of [plan(), plan({ pb: playback({ loop: "loop" }), sourceSpanMs: 250 }), plan({ sourceSpanMs: 120 })]) {
      expect(tiles[0]!.startMs).toBe(0);
      expect(tiles.at(-1)!.endMs).toBe(1000);
      for (let i = 1; i < tiles.length; i++) expect(tiles[i]!.startMs).toBe(tiles[i - 1]!.endMs);
    }
  });

  it("a degenerate clip plans to nothing rather than to a divide-by-zero", () => {
    expect(plan({ durationMs: 0 })).toEqual([]);
    expect(plan({ pxPerMs: 0 })).toEqual([]);
  });
});

describe("posterHeightTier", () => {
  it("rounds UP to a tier, so pictures are only ever scaled down", () => {
    expect(posterHeightTier(24)).toBe(32);
    expect(posterHeightTier(32)).toBe(32);
    expect(posterHeightTier(33)).toBe(48);
  });

  it("caps at the largest tier — a timeline row is never a canvas", () => {
    const max = POSTER_HEIGHT_TIERS.at(-1)!;
    expect(posterHeightTier(4000)).toBe(max);
  });

  it("a continuous zoom sweep only ever visits a handful of tiers", () => {
    const seen = new Set<number>();
    for (let h = 20; h <= 140; h += 0.5) seen.add(posterHeightTier(h));
    expect(seen.size).toBeLessThanOrEqual(POSTER_HEIGHT_TIERS.length);
  });
});

describe("clipPosterSource — a still is only honest when nothing varies", () => {
  /**
   * The rule this pins: a poster is a picture of a SOURCE, and a source's
   * picture varies with SOURCE time. For a file or a comp, keyframes on the
   * clip animate the LAYER and leave the source alone — so they change
   * nothing here. But when the clip IS the source (a pixel layer), its own
   * animation IS the source's animation, and a frozen thumbnail of a fading
   * or recolouring layer is a lie.
   */
  const layerClip = (over: Record<string, unknown> = {}) =>
    ({ kind: "raster", id: "c1", frameId: "f1", hidden: false, startMs: 0, durationMs: 2000, keyframes: [], ...over }) as never;
  const doc = { assets: [], frames: [{ id: "f1", fps: 24, width: 100, height: 100 }] } as never;

  it("a static pixel layer is a still — one picture, one draw", () => {
    const source = clipPosterSource(doc, layerClip());
    expect(source?.mode).toBe("still");
    expect(source?.stepMs).toBe(Infinity);
  });

  it("a KEYFRAMED pixel layer strips, on the comp's own grid", () => {
    const source = clipPosterSource(doc, layerClip({ keyframes: [{ property: "opacity", keys: [] }] }));
    expect(source?.mode).toBe("strip");
    expect(source?.stepMs).toBeCloseTo(1000 / 24, 5);
  });

  /**
   * Every one of these moves a layer WITHOUT writing a keyframe. A poster that
   * only watched `keyframes` would show a frozen picture for all of them —
   * which is the exact complaint that got shapes dropped in the first place.
   */
  it.each([
    ["a modulator (a wiggle)", { modulators: [{ id: "m", path: "opacity" }] }],
    ["a node driver", { drivers: { opacity: "expr:n1" } }],
    ["a motion-track binding", { trackBinding: { trackerId: "t1" } }],
    ["an in-animation", { animIn: { preset: "fade", durationMs: 400 } }],
    ["a live effect (grain)", { effects: [{ id: "e", type: "grain", enabled: true }] }],
  ])("a pixel layer moved by %s strips, not stills", (_label, over) => {
    expect(clipPosterSource(doc, layerClip(over))?.mode).toBe("strip");
  });

  it("a DISABLED live effect leaves it a still — the badge counts what runs", () => {
    const source = clipPosterSource(doc, layerClip({ effects: [{ id: "e", type: "grain", enabled: false }] }));
    expect(source?.mode).toBe("still");
  });

  it("keys on a layer source cut a tile per animated frame", () => {
    const source = clipPosterSource(doc, layerClip({ keyframes: [{ property: "opacity", keys: [] }] }))!;
    const tiles = planPosterTiles({
      durationMs: 500,
      pxPerMs: 1,
      renderStepMs: source.stepMs,
      sourceStepMs: source.stepMs,
      speed: 1,
      phaseAt: (localMs) => ({ sourceMs: localMs, cycleIndex: 0, held: false }),
      minTilePx: 1,
    });
    expect(tiles.length).toBe(12); // 500ms at 24fps
  });

  it("shapes and paths show no poster at all", () => {
    for (const kind of ["shape", "path"] as const) {
      expect(clipPosterSource(doc, layerClip({ kind }))).toBeNull();
    }
  });
});

describe("planPosterTiles — a strip costs what is on screen", () => {
  // A 35 s looping 12fps comp at 200 px/s: a 7000px strip, ~420 pictures long.
  const long = (over: Partial<PosterPlanInput> = {}) =>
    plan({
      durationMs: 35_000,
      sourceSpanMs: 4000,
      pb: playback({ loop: "loop" }),
      sourceStepMs: 1000 / 12,
      pxPerMs: 0.2,
      minTilePx: 18,
      maxTiles: 10_000,
      ...over,
    });

  it("plans only the window, and every windowed tile is the whole plan's tile there", () => {
    const whole = long();
    const window = { fromMs: 12_340, toMs: 18_000 };
    const seen = long({ window });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(whole.length / 4);
    expect(seen[0]!.startMs).toBeLessThanOrEqual(window.fromMs);
    expect(seen.at(-1)!.endMs).toBeGreaterThanOrEqual(window.toMs);
    // Same identity as the whole-clip plan: scrolling hits, never re-renders.
    for (const tile of seen) {
      const twin = whole.find((w) => w.startMs <= tile.startMs + 1e-6 && w.endMs >= tile.startMs + 1e-6);
      expect(twin?.sourceMs).toBe(tile.sourceMs);
    }
  });

  it("an off-screen window plans nothing", () => {
    expect(long({ window: { fromMs: 40_000, toMs: 50_000 } })).toEqual([]);
  });

  it("the cap bounds one plan's window, not the whole clip", () => {
    const capped = long({ maxTiles: 96 });
    const windowed = long({ maxTiles: 96, window: { fromMs: 0, toMs: 2000 } });
    // Whole clip: the cap spreads 96 tiles over 35 s. Window: full density.
    expect(capped.length).toBeLessThanOrEqual(96);
    expect(windowed[1]!.startMs - windowed[0]!.startMs).toBeLessThan(capped[1]!.startMs - capped[0]!.startMs);
  });
});

describe("posterTileFloorPx — density follows cost", () => {
  it("cheap sources keep the legibility floor", () => {
    expect(posterTileFloorPx(null)).toBe(POSTER_MIN_TILE_PX);
    expect(posterTileFloorPx(4)).toBe(POSTER_MIN_TILE_PX);
  });
  it("heavier sources get wider tiles, monotonically, up to a cap", () => {
    const a = posterTileFloorPx(40);
    const b = posterTileFloorPx(200);
    expect(a).toBeGreaterThan(POSTER_MIN_TILE_PX);
    expect(b).toBeGreaterThan(a);
    expect(posterTileFloorPx(5000)).toBe(POSTER_MAX_TILE_PX);
  });
});

describe("planPosterTiles — zoom reuses pictures", () => {
  it("every zoomed-out tile is a picture the zoomed-in plan already has", () => {
    const at = (pxPerMs: number) =>
      plan({ durationMs: 20_000, sourceSpanMs: 20_000, sourceStepMs: 1000 / 24, pxPerMs, minTilePx: 18, maxTiles: 10_000 });
    for (const [inner, outer] of [
      [0.5, 0.25],
      [0.3, 0.07],
      [0.12, 0.05],
    ] as const) {
      const fine = new Set(at(inner).map((t) => Math.round(t.sourceMs)));
      for (const t of at(outer)) expect(fine.has(Math.round(t.sourceMs))).toBe(true);
    }
  });
});
