import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip } from "./factories";
import type { VisualClip } from "./schema";
import { createDocumentStore } from "./history/document-store";
import {
  MIN_TRANSITION_MS,
  applyTransition,
  applyTransitionAtTime,
  applyTransitionToClips,
  clampTransition,
  activeTransitionAt,
  crossfadeFactorAt,
  reconcileTransitions,
  resizeTransition,
  resolveTransitionDrop,
  transitionLimits,
  transitionMediaShortfall,
  trackTransitions,
  transitionSpan,
  transitionTargets,
} from "./timeline/transitions";
import { clipEnd, deleteClip, locateClip, moveClip, nestClips, splitClip, trimClip } from "./timeline/ops";
import { decomposeNestedClip } from "./timeline/decompose";
import {
  applyAnimationDrop,
  describePresetDrop,
  resolveAnimationDrop,
  resolvePresetDrop,
  resolveTransitionDropTarget,
} from "./timeline/drop-targets";
import {
  crossfadeGains,
  isSeparableMix,
  presetNeedsCompositor,
  retargetTransition,
  transitionMixAt,
  TRANSITION_PRESETS,
} from "./animation/transitions";
import type { MotionDocument, Track } from "./schema";

/** A doc with one track carrying `count` abutted 1000ms clips in one comp. */
function abuttedDoc(count = 2, durationMs = 1000): { doc: MotionDocument; track: Track; frameId: string } {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const track = doc.tracks[0]!;
  for (let i = 0; i < count; i++) {
    track.clips.push(
      createShapeClip({ frameId, shape: "rect", startMs: i * durationMs, durationMs }),
    );
  }
  return { doc, track, frameId };
}

const seamOf = (doc: MotionDocument, track: Track, frameId: string) =>
  transitionTargets(track, frameId).find((t) => t.kind === "seam")!;

describe("transition registry", () => {
  it("every preset evaluates to a finite, in-range mix across its whole span", () => {
    for (const preset of TRANSITION_PRESETS) {
      const tr = {
        id: "t",
        preset: preset.id,
        frameId: "f",
        aClipId: "a",
        bClipId: "b",
        durationMs: 500,
        splitMs: 250,
        easing: preset.defaultEasing,
        params: Object.fromEntries(preset.params.map((p) => [p.key, p.defaultValue])),
        color: null,
      };
      for (let i = 0; i <= 20; i++) {
        const op = transitionMixAt(tr, i / 20);
        for (const side of [op.a, op.b]) {
          expect(Number.isFinite(side.opacity), preset.id).toBe(true);
          expect(side.opacity).toBeGreaterThanOrEqual(0);
          expect(side.opacity).toBeLessThanOrEqual(1);
          expect(Number.isFinite(side.scale) && side.scale > 0, preset.id).toBe(true);
          expect(Number.isFinite(side.dx) && Number.isFinite(side.dy), preset.id).toBe(true);
          expect(side.blur).toBeGreaterThanOrEqual(0);
        }
        expect(op.veil).toBeGreaterThanOrEqual(0);
        expect(op.veil).toBeLessThanOrEqual(1);
      }
    }
  });

  it("ends fully on A and fully on B — no preset leaves a half-mixed edge", () => {
    for (const preset of TRANSITION_PRESETS) {
      const params = Object.fromEntries(preset.params.map((p) => [p.key, p.defaultValue]));
      const start = preset.evalMix(0, params);
      const end = preset.evalMix(1, params);
      // At t=0 the outgoing frame must be whole; at t=1 the incoming one must be.
      expect(start.a.opacity, `${preset.id} start`).toBeCloseTo(1);
      expect(end.b.opacity, `${preset.id} end`).toBeCloseTo(1);
      // …and the veil must have lifted at both ends, or the cut would flash.
      expect(start.veil, `${preset.id} start veil`).toBeCloseTo(0);
      expect(end.veil, `${preset.id} end veil`).toBeCloseTo(0);
    }
  });

  it("separability is what decides the fast path — and it is per instant", () => {
    // A plain dissolve never needs the compositor; a wipe always does.
    expect(presetNeedsCompositor("cross-dissolve")).toBe(false);
    expect(presetNeedsCompositor("slide-apart")).toBe(false);
    expect(presetNeedsCompositor("linear-wipe")).toBe(true);
    expect(presetNeedsCompositor("dip-to-color")).toBe(true);
    // A veiled preset is still separable at its own edges, where the veil is 0.
    const dip = TRANSITION_PRESETS.find((p) => p.id === "dip-to-color")!;
    expect(isSeparableMix(dip.evalMix(0, {}))).toBe(true);
    expect(isSeparableMix(dip.evalMix(0.5, {}))).toBe(false);
  });

  it("retargeting keeps timing and every knob the new preset shares", () => {
    const tr = {
      id: "t",
      preset: "linear-wipe",
      frameId: "f",
      aClipId: "a",
      bClipId: "b",
      durationMs: 900,
      splitMs: 300,
      easing: { kind: "linear" } as const,
      params: { angle: 42, softness: 33 },
      color: null,
    };
    const next = retargetTransition(tr, "barn-door");
    expect(next.durationMs).toBe(900);
    expect(next.splitMs).toBe(300);
    expect(next.params.angle).toBe(42); // shared knob survives
    expect(next.params.softness).toBe(33);
    // A preset without those knobs drops them rather than carrying dead params.
    expect(retargetTransition(tr, "cross-dissolve").params).toEqual({});
  });

  it("equal-power crossfade holds loudness through the cut", () => {
    const mid = crossfadeGains("equal-power", 0.5);
    expect(mid.a ** 2 + mid.b ** 2).toBeCloseTo(1);
    expect(crossfadeGains("equal-power", 0).a).toBeCloseTo(1);
    expect(crossfadeGains("equal-power", 1).b).toBeCloseTo(1);
    // A dip reaches true silence at the cut — the audible twin of dip-to-black.
    const dip = crossfadeGains("dip", 0.5);
    expect(dip.a).toBeCloseTo(0);
    expect(dip.b).toBeCloseTo(0);
  });
});

describe("transition targeting", () => {
  it("finds a seam between abutted clips, and lone edges everywhere else", () => {
    const { track, frameId } = abuttedDoc(2);
    const targets = transitionTargets(track, frameId);
    expect(targets.map((t) => t.kind)).toEqual(["head", "seam", "tail"]);
    expect(targets[1]!.cutMs).toBe(1000);
  });

  it("a gap turns one seam into two independent edges", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    track.clips[1]!.startMs = 1500;
    const kinds = transitionTargets(track, frameId).map((t) => t.kind);
    expect(kinds).toEqual(["head", "tail", "head", "tail"]);
    expect(doc.tracks[0]!.transitions).toEqual([]);
  });

  it("a drop snaps to the nearest cut, and seams win a tie", () => {
    const { track, frameId } = abuttedDoc(2);
    expect(resolveTransitionDrop(track, frameId, 1040, 120)!.kind).toBe("seam");
    expect(resolveTransitionDrop(track, frameId, 60, 120)!.kind).toBe("head");
    // Outside the tolerance the drag must honestly report no target.
    expect(resolveTransitionDrop(track, frameId, 500, 120)).toBeNull();
  });
});

describe("transition geometry", () => {
  it("a centred seam transition straddles the cut evenly", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 });
    const tr = doc.tracks[0]!.transitions[0]!;
    const span = transitionSpan(doc.tracks[0]!, tr)!;
    expect(span).toEqual({ cutMs: 1000, startMs: 800, endMs: 1200 });
  });

  it("a lone edge pins its span inside the one clip it has", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const targets = transitionTargets(track, frameId);
    applyTransition(doc, targets.find((t) => t.kind === "head")!, "iris", { durationMs: 300 });
    const span = transitionSpan(doc.tracks[0]!, doc.tracks[0]!.transitions[0]!)!;
    expect(span.startMs).toBe(0);
    expect(span.endMs).toBe(300);
  });

  it("clamping preserves the split RATIO instead of lurching to one side", () => {
    const { doc, track, frameId } = abuttedDoc(2, 300);
    const t = seamOf(doc, track, frameId);
    // Ask for 2000ms across two 300ms clips — only 600ms of room exists.
    const tr = applyTransition(doc, t, "cross-dissolve", { durationMs: 2000, splitMs: 1000 })!;
    expect(tr.durationMs).toBe(600);
    expect(tr.splitMs).toBe(300); // still centred
  });

  it("an asymmetric transition keeps its ratio when clamped", () => {
    const { doc, track, frameId } = abuttedDoc(2, 400);
    const tr = applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", {
      durationMs: 400,
      splitMs: 100, // 25% on A
    })!;
    const grown = clampTransition(doc.tracks[0]!, { ...tr, durationMs: 1600, splitMs: 400 });
    // B only has 400ms of room, and the 25% split means B takes 75% of the
    // span — so the SPAN is what gives way. Re-centring instead would throw
    // away the asymmetry the user deliberately dialled in.
    expect(grown.durationMs).toBeCloseTo(400 / 0.75);
    expect(grown.splitMs / grown.durationMs).toBeCloseTo(0.25);
  });

  it("neighbouring transitions on the same clip cannot overlap", () => {
    const { doc, track, frameId } = abuttedDoc(3, 500);
    const seams = transitionTargets(track, frameId).filter((t) => t.kind === "seam");
    applyTransition(doc, seams[0]!, "cross-dissolve", { durationMs: 600, splitMs: 300 });
    const live = doc.tracks[0]!;
    // The middle clip's head is now spoken for; the next seam sees less room.
    const second = transitionTargets(live, frameId).filter((t) => t.kind === "seam")[1]!;
    const tr = applyTransition(doc, second, "cross-dissolve", { durationMs: 1000 })!;
    const limits = transitionLimits(doc.tracks[0]!, tr);
    expect(limits.maxSplitMs).toBe(200); // 500 clip − 300 already reserved
    expect(tr.splitMs).toBeLessThanOrEqual(200);
  });
});

describe("transition resize", () => {
  it("symmetric drag moves both sides together", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const tr = applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 })!;
    resizeTransition(doc, tr.id, "end", 1300, true);
    const after = doc.tracks[0]!.transitions[0]!;
    const span = transitionSpan(doc.tracks[0]!, after)!;
    expect(span.endMs).toBeCloseTo(1300);
    expect(span.startMs).toBeCloseTo(700); // the other side followed
  });

  it("alt (asymmetric) drag moves only the dragged side", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const tr = applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 })!;
    resizeTransition(doc, tr.id, "end", 1300, false);
    const span = transitionSpan(doc.tracks[0]!, doc.tracks[0]!.transitions[0]!)!;
    expect(span.endMs).toBeCloseTo(1300);
    expect(span.startMs).toBeCloseTo(800); // untouched
  });

  it("dragging below the minimum removes the transition rather than leaving a sliver", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const tr = applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 })!;
    resizeTransition(doc, tr.id, "end", 1000 + MIN_TRANSITION_MS / 8, true);
    expect(doc.tracks[0]!.transitions).toHaveLength(0);
  });
});

describe("transition lifecycle", () => {
  it("survives a trim by re-clamping instead of overhanging the clip", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const tr = applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 800 })!;
    expect(tr.splitMs).toBe(400);
    // Trim A's head so it is only 200ms long — the transition must shrink.
    trimClip(doc, doc.tracks[0]!.clips[0]!.id, "start", 800);
    reconcileTransitions(doc);
    const after = doc.tracks[0]!.transitions[0]!;
    expect(after.splitMs).toBeLessThanOrEqual(200);
    const span = transitionSpan(doc.tracks[0]!, after)!;
    expect(span.startMs).toBeGreaterThanOrEqual(doc.tracks[0]!.clips[0]!.startMs);
  });

  it("degrades to a single-sided transition when one participant is deleted", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    applyTransition(doc, seamOf(doc, track, frameId), "iris", { durationMs: 400 });
    const bId = doc.tracks[0]!.clips[1]!.id;
    deleteClip(doc, bId);
    reconcileTransitions(doc);
    const after = doc.tracks[0]!.transitions;
    expect(after).toHaveLength(1);
    expect(after[0]!.bClipId).toBeNull();
    expect(after[0]!.aClipId).not.toBeNull();
    // …and it re-pins itself to the surviving clip's tail.
    expect(after[0]!.splitMs).toBe(after[0]!.durationMs);
  });

  it("stops being a seam when the pair is pulled apart", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    applyTransition(doc, seamOf(doc, track, frameId), "push", { durationMs: 400 });
    moveClip(doc, doc.tracks[0]!.clips[1]!.id, 1600);
    reconcileTransitions(doc);
    const after = doc.tracks[0]!.transitions[0]!;
    expect(after.bClipId).toBeNull();
  });

  it("never leaves a dangling record — the store reconciles every edit for free", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const store = createDocumentStore(doc);
    store.update("seed", (d) => {
      applyTransition(d, seamOf(d, d.tracks[0]!, frameId), "cross-dissolve", { durationMs: 400 });
    });
    expect(store.getState().tracks[0]!.transitions).toHaveLength(1);
    // A caller that knows nothing about transitions deletes both clips.
    store.update("nuke", (d) => {
      for (const clip of [...d.tracks[0]!.clips]) deleteClip(d, clip.id);
    });
    expect(store.getState().tracks[0]!.transitions).toHaveLength(0);
    // …and undo restores it, because reconcile rode the same patch set.
    store.undo();
    expect(store.getState().tracks[0]!.transitions).toHaveLength(1);
    expect(track).toBeDefined();
  });

  it("a split leaves the transition on the piece that still owns the cut", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 });
    splitClip(doc, doc.tracks[0]!.clips[0]!.id, 500);
    reconcileTransitions(doc);
    const live = doc.tracks[0]!;
    const tr = live.transitions[0]!;
    // Whichever clip now ends at the cut is the outgoing side.
    const a = live.clips.find((c) => c.id === tr.aClipId)!;
    expect(a.startMs + a.durationMs).toBe(1000);
  });

  it("one clip edge can only be claimed once", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const seam = seamOf(doc, track, frameId);
    applyTransition(doc, seam, "cross-dissolve", { durationMs: 400 });
    // Re-applying to the same target REPLACES rather than stacking.
    applyTransition(doc, transitionTargets(doc.tracks[0]!, frameId).find((t) => t.kind === "seam")!, "iris", {
      durationMs: 300,
    });
    expect(doc.tracks[0]!.transitions).toHaveLength(1);
    expect(doc.tracks[0]!.transitions[0]!.preset).toBe("iris");
  });
});

describe("transition playback", () => {
  it("reports the active mix only inside its own span", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 });
    const live = doc.tracks[0]!;
    expect(activeTransitionAt(live, frameId, 700)).toBeNull();
    expect(activeTransitionAt(live, frameId, 1000)!.progress).toBeCloseTo(0.5);
    expect(activeTransitionAt(live, frameId, 1200)!.progress).toBeCloseTo(1);
    expect(activeTransitionAt(live, frameId, 1300)).toBeNull();
  });

  it("crossfade multiplies each side's gain and is 1 everywhere else", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 });
    const live = doc.tracks[0]!;
    const [a, b] = live.clips;
    expect(crossfadeFactorAt(live, a!, 500)).toBe(1);
    expect(crossfadeFactorAt(live, a!, 1000)).toBeCloseTo(Math.cos(Math.PI / 4));
    expect(crossfadeFactorAt(live, b!, 1000)).toBeCloseTo(Math.sin(Math.PI / 4));
    expect(crossfadeFactorAt(live, b!, 1500)).toBe(1);
  });

  it("synthetic clips extrapolate freely — only real media can run short", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const tr = applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 })!;
    // Shapes have no source, so neither side is ever freeze-framed.
    expect(transitionMediaShortfall(doc, doc.tracks[0]!, tr)).toEqual({ aFreezeMs: 0, bFreezeMs: 0 });
  });
});

describe("multi-apply", () => {
  it("a shared cut between two selected clips is ONE transition, not two", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const ids = track.clips.map((c) => c.id);
    const applied = applyTransitionToClips(doc, ids, "cross-dissolve", { durationMs: 300 });
    // outer head + shared seam + outer tail
    expect(applied).toBe(3);
    expect(doc.tracks[0]!.transitions).toHaveLength(3);
    expect(doc.tracks[0]!.transitions.filter((t) => t.aClipId && t.bClipId)).toHaveLength(1);
    expect(frameId).toBeTruthy();
  });

  it("selecting only one clip still transitions the cut it shares", () => {
    const { doc, track } = abuttedDoc(2);
    applyTransitionToClips(doc, [track.clips[0]!.id], "iris", { durationMs: 300 });
    // Its head, plus the seam it shares with the unselected neighbour.
    expect(doc.tracks[0]!.transitions).toHaveLength(2);
  });

  it("the default-transition gesture lands on the cut nearest the playhead", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    expect(applyTransitionAtTime(doc, frameId, 1010, "cross-dissolve", 120)).toBe(1);
    const tr = doc.tracks[0]!.transitions[0]!;
    expect(tr.aClipId).toBe(track.clips[0]!.id);
    expect(tr.bClipId).toBe(track.clips[1]!.id);
    // Nowhere near a cut: nothing happens rather than something surprising.
    expect(applyTransitionAtTime(doc, frameId, 500, "cross-dissolve", 120)).toBe(0);
  });
});

describe("shared preset drop resolver", () => {
  it("an animation claims the HALF of the clip it was aimed at", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const first = track.clips[0]!;
    expect(resolveAnimationDrop(track, frameId, 100, "fade-up")!.edge).toBe("in");
    expect(resolveAnimationDrop(track, frameId, 900, "fade-up")!.edge).toBe("out");
    // Off the clips entirely → no target, so the ghost can say "not here".
    track.clips[1]!.startMs = 3000;
    expect(resolveAnimationDrop(track, frameId, 2000, "fade-up")).toBeNull();
    expect(doc.tracks[0]!.id).toBe(first.frameId ? track.id : track.id);
  });

  it("the preview span is the span the animation will actually occupy", () => {
    const { track, frameId } = abuttedDoc(2);
    const target = resolveAnimationDrop(track, frameId, 100, "fade-up")!;
    expect(target.startMs).toBe(0);
    expect(target.endMs).toBe(450); // fade-up's default duration
    const out = resolveAnimationDrop(track, frameId, 900, "fade-up")!;
    expect(out.endMs).toBe(1000);
    expect(out.startMs).toBe(550);
  });

  it("dropping onto a tuned animation RETARGETS it — timing survives", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const target = resolveAnimationDrop(track, frameId, 100, "fade-up")!;
    applyAnimationDrop(doc, target, "fade-up");
    (doc.tracks[0]!.clips[0]! as VisualClip).animIn!.durationMs = 1234;
    const again = resolveAnimationDrop(doc.tracks[0]!, frameId, 100, "pop-in")!;
    expect(again.replaces).toBe(true);
    applyAnimationDrop(doc, again, "pop-in");
    const spec = (doc.tracks[0]!.clips[0]! as VisualClip).animIn!;
    expect(spec.preset).toBe("pop-in");
    expect(spec.durationMs).toBe(1234);
  });

  it("a transition stays live across the WHOLE clip, aiming by the same midpoint rule", () => {
    // Two 1000ms clips abutting at 1000. Everything below is outside the 120ms
    // tolerance, so before the fix each of these was a dead drop.
    const { track, frameId } = abuttedDoc(2);
    const at = (ms: number) =>
      resolveTransitionDropTarget(track, frameId, ms, "cross-dissolve", 120)!.target;
    expect(at(200).kind).toBe("head"); // front half of clip 1 → its start
    expect(at(800).kind).toBe("seam"); // back half of clip 1 → the shared cut
    expect(at(1200).kind).toBe("seam"); // front half of clip 2 → the same cut
    expect(at(1800).kind).toBe("tail"); // back half of clip 2 → its end
    // Aiming AT a cut still wins over the midpoint of the clip owning that pixel.
    expect(at(1040).kind).toBe("seam");
  });

  it("both families go dead in the same place — off the clips", () => {
    const { track, frameId } = abuttedDoc(2);
    track.clips[1]!.startMs = 3000;
    const gapMs = 2000;
    expect(resolveAnimationDrop(track, frameId, gapMs, "fade-up")).toBeNull();
    expect(resolveTransitionDropTarget(track, frameId, gapMs, "cross-dissolve", 120)).toBeNull();
  });

  it("one resolver serves both families off the same pointer position", () => {
    const { track, frameId } = abuttedDoc(2);
    const anim = resolvePresetDrop(track, frameId, 990, { kind: "animation", id: "fade-up" }, 120);
    const tr = resolvePresetDrop(track, frameId, 990, { kind: "transition", id: "cross-dissolve" }, 120);
    expect(anim!.kind).toBe("animation");
    expect(tr!.kind).toBe("transition");
    // …and each describes itself for the drag ghost.
    expect(describePresetDrop(anim!, "Fade Up")).toContain("out");
    expect(describePresetDrop(tr!, "Cross Dissolve")).toContain("cut");
  });
});

describe("replacing", () => {
  it("dropping a new transition on an occupied cut REPLACES it", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 });
    applyTransition(doc, seamOf(doc, doc.tracks[0]!, frameId), "iris", { durationMs: 400 });
    expect(doc.tracks[0]!.transitions).toHaveLength(1);
    expect(doc.tracks[0]!.transitions[0]!.preset).toBe("iris");
  });

  it("a differently-SHAPED drop on the same edge still replaces", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    // A record claiming clip A's TAIL first. It is built by hand rather than
    // looked up: A abuts B, so `transitionTargets` offers that cut only as a
    // SEAM — the shape this test needs to collide with is precisely the one the
    // targets list will not hand you, which is why the collision is possible at
    // all (a paste, a trim that pulled the pair apart and back together).
    applyTransition(
      doc,
      {
        kind: "tail",
        trackId: track.id,
        frameId,
        aClipId: track.clips[0]!.id,
        bClipId: null,
        cutMs: clipEnd(track.clips[0]!),
        existingId: null,
      },
      "push",
      { durationMs: 400 },
    );
    // …then a SEAM across the same cut. The old record claimed A's tail, so it
    // must go rather than linger and win the re-anchor pass.
    applyTransition(doc, seamOf(doc, doc.tracks[0]!, frameId), "iris", { durationMs: 400 });
    reconcileTransitions(doc);
    expect(doc.tracks[0]!.transitions).toHaveLength(1);
    expect(doc.tracks[0]!.transitions[0]!.preset).toBe("iris");
  });

  it("dropping a new animation on an occupied edge retargets, keeping the timing", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    applyAnimationDrop(doc, resolveAnimationDrop(track, frameId, 50, "fade-up")!, "fade-up");
    (doc.tracks[0]!.clips[0]! as VisualClip).animIn!.durationMs = 900;
    applyAnimationDrop(doc, resolveAnimationDrop(doc.tracks[0]!, frameId, 50, "blur-in")!, "blur-in");
    const spec = (doc.tracks[0]!.clips[0]! as VisualClip).animIn!;
    expect(spec.preset).toBe("blur-in");
    expect(spec.durationMs).toBe(900);
  });
});

describe("transitions ride with their clips through nesting", () => {
  it("nestClips carries a seam into the nested comp, and the root keeps none", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const [a, b] = track.clips;
    const seam = applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 })!;

    const nestedId = nestClips(doc, [a!.id, b!.id])!;
    reconcileTransitions(doc);
    const nested = locateClip(doc, nestedId)!.clip;
    const sourceId = nested.kind === "nested" ? nested.sourceFrameId : "";

    // The root comp shows no transition — its two clips are not there any more.
    for (const t of doc.tracks) expect(trackTransitions(t, frameId)).toEqual([]);
    // The nested comp shows the same cut, still between A and B, still 400 ms.
    const inside = doc.tracks.flatMap((t) => trackTransitions(t, sourceId));
    expect(inside).toHaveLength(1);
    expect(inside[0]!.id).toBe(seam.id);
    expect(inside[0]!.aClipId).toBe(a!.id);
    expect(inside[0]!.bClipId).toBe(b!.id);
    expect(inside[0]!.durationMs).toBe(400);
    // …and it lives on the lane the clips live on.
    const lane = locateClip(doc, a!.id)!.track;
    expect(lane.transitions.map((t) => t.id)).toEqual([seam.id]);
  });

  it("nesting only one side of a cut leaves a single-sided edge on the clip that stayed", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const [a, b] = track.clips;
    applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 });

    nestClips(doc, [b!.id]);
    reconcileTransitions(doc);

    const root = doc.tracks.flatMap((t) => trackTransitions(t, frameId));
    expect(root).toHaveLength(1);
    expect(root[0]!.aClipId).toBe(a!.id);
    expect(root[0]!.bClipId).toBeNull();
  });

  it("decomposeNestedClip brings the cut back out, at the wrapper's speed", () => {
    const { doc, track, frameId } = abuttedDoc(2);
    const [a, b] = track.clips;
    applyTransition(doc, seamOf(doc, track, frameId), "cross-dissolve", { durationMs: 400 });
    const nestedId = nestClips(doc, [a!.id, b!.id])!;
    reconcileTransitions(doc);

    // Slow the wrapper to half speed: clips and the cut between them stretch 2×.
    const nested = locateClip(doc, nestedId)!.clip;
    if (nested.kind === "nested") nested.playback.speed = 0.5;
    nested.durationMs *= 2;

    expect(decomposeNestedClip(doc, nestedId)).toBe(true);
    reconcileTransitions(doc);

    const root = doc.tracks.flatMap((t) => trackTransitions(t, frameId));
    expect(root).toHaveLength(1);
    expect(root[0]!.aClipId).toBe(a!.id);
    expect(root[0]!.bClipId).toBe(b!.id);
    expect(root[0]!.durationMs).toBe(800);
    expect(locateClip(doc, b!.id)!.clip.startMs).toBe(2000);
  });
});
