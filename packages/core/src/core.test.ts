import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./history/document-store";
import { defaultTextCaret, makeSoundLayer, createStarterDocument, createTextClip, createEmptyDocument, createFrame, createNestedClip, createShapeClip, createPathClip, createAudioClip, createAssetAudioClip, createTrack, createCarrierTrack, createVideoClip, createWaveformClip } from "./factories";
import { linkClips, unlinkClips, expandLinkedSelection, remapClipRefsAfterCopy } from "./timeline/links";
import { autoSmoothHandles, editPointHandlesFromAnchor, editPointHandlesFromHandle, lerpSubpaths, pathCommands, roundableVertices, setUniformCornerRadius, uniformCornerRadius, shapeCommands, shapeCornerBasis, shapeCornerPoints, shapeLocalBounds, shapeVertices } from "./vector/geometry";
import {
  alignNodes,
  averageNodes,
  breakAtNode,
  convertNodes,
  deleteSegment,
  joinEndpoints,
  knifeSubpaths,
  mergeSnapCandidates,
  mirrorHandles,
  nodeSnapLines,
  openEndpoints,
  reverseSubpaths,
  setNodesClosed,
  simplifySubpaths,
} from "./vector/edit-engine";
import { parseSvgPathData } from "./vector/svg-path";
import { beginTangentDrag, resolveTangentDrag, isMirroredPair, shouldPairTangents } from "./tangents";
import { splitEasing } from "./easing";
import type { Contour, Easing } from "./schema";

type Pt = { x: number; y: number };
import { NO_CROP } from "./schema/clips";
import { buildSnapCandidates, snapMove, snapPoint, snapPointOnRay, DEFAULT_VIEWPORT_SNAP } from "./snapping/viewport-snap";
import { fitCamera, isBoundsVisible, clampCameraToLeash } from "./viewport/camera";
import { alignBoxes, distributeBoxes } from "./snapping/align";
import { trimCommands } from "./vector/trim";
import type { PathCommand } from "./vector/geometry";
import { applyRangePatch, sharedStyleIn, styleAt, remapRangesAfterSplice, diffAsSplice } from "./text/ranges";
import { defaultTextStyle } from "./factories";
import {
  convertShapeClipToPath,
  deleteClip,
  nestClips,
  splitClip,
  moveClip,
  moveClipOverwrite,
  moveClipToNewLane,
  moveClipsToNewLanes,
  rollEdit,
  locateClip,
  clipEnd,
  contentEndMs,
  deleteFrame,
  scaleFrameContents,
  resizeFrame,
  frameDurationMs,
  setFrameDurationMs,
  restackClip,
  reparentClipToFrame,
  reissueClipIds,
  trimClip,
  restackClips,
  frameContentDurationMs,
  retimeClip,
  clipSourceCapacityMs,
  retimeRippleDefault,
  resolveRetimeRipple,
  pruneTrackIfEmptied,
  pruneEmptiedTracks,
  addClipToTrack,
} from "./timeline/ops";
import {
  applyRenderInPlace,
  isRenderedInPlace,
  renderInPlaceMeta,
  revertRenderInPlace,
} from "./timeline/render-in-place";
import { decomposeNestedClip } from "./timeline/decompose";
import { detectImageSequences } from "./io/sequence";
import { allGroupClips, groupClipById, groupClips, ungroupClips, clipsInGroup, clipsUnderGroup, expandSelectionToGroups, groupAncestry, selectionTopUnits, moveClipsToScope, groupOfClip, nextEnterGroup, pullClipsOutOneLevel } from "./timeline/groups";
import { applyCompositeMode, selectionCompositeInfo, setClipStencilRole } from "./timeline/group-composite";
import { frameLayerTree } from "./timeline/layer-tree";
import { restackUnits } from "./timeline/ops";
import {
  makeComponent,
  makeComponentFromFrame,
  detachInstance,
  detachInstanceFrame,
  addVariant,
  switchInstanceVariant,
  deleteVariant,
  gcOrphanNestedSources,
  cloneFrameContent,
  isComponentFrame,
  isInstanceClip,
  componentFrames,
  componentSetId,
  componentSet,
  mainVariant,
  createComponentInstanceClip,
  duplicateFrame,
} from "./components";
import { resolvePlaybackScope } from "./timeline/playback-scope";
import { editPath } from "./navigation";
import { CLIP_KINDS, clipPlaybackOf, isVisualClip } from "./clip-registry";
import {
  parseCssRules,
  cssDeclarationsFor,
  cssColorToHex,
  selectorMatches,
} from "./vector/svg-style";
import { reconcileFillClips, compDurationMs, compOwnerNested, compAncestryPath, ownerNestedOf } from "./timeline/ops";
import {
  addColorVariable,
  colorVarToken,
  colorVariableUsage,
  deleteColorVariable,
  resolveColor,
  addVariable,
  deleteVariable,
  varToken,
  applyColorEdit,
  linkColorSlot,
  parseVarToken,
  parseVarAlpha,
  withVarAlpha,
  variableUsage,
  resolveNumber,
  resolveFontFamily,
} from "./variables";
import { collectSubtreeColors, remapSubtreeColors } from "./colors/variables";
import { evaluateEasing } from "./easing";
import { parseDocument, serializeDocument } from "./io";
import { segmentText, splitGraphemes } from "./text/segment";
import { caretAt, textTimelineOf, textUnitEvents } from "./animation/evaluate";
import { specFromPreset } from "./animation/presets";
import type { AnimationSpec } from "./schema";
import { captureLibrarySnapshot, instantiateLibrarySnapshot } from "./library";
import { createLayerEffect, cloneLayerEffects, layerEffectPath } from "./animation/layer-effects";
import { getClipProperty, setClipProperty, effectiveCornerOffsets, removeClipKeyframes, clearClipKeyframes } from "./animation/paths";
import { effectiveText, evaluateClipPose, evaluateTextGlyphs, segmentTextCached, sourceTimeAt } from "./animation/evaluate";
import {
  moveKeyframe,
  propertyHasKeys,
  sampleKeyframeTrack,
  sampleKeyframes,
  sampleRangeStyles,
  setKeyframe,
  adjacentKeyframe,
} from "./animation/keyframes";
import { lerpColor, propertyDef } from "./animation/properties";
import { CAPTURE_PROPERTY, captureCursor, captureStateAt, captureSurfaceIds, captureTrack, isCaptureClip, planCapture } from "./drawing/capture";
import { createBrushPreset } from "./drawing/brush";
import { vectorStroke, vectorStrokeWidths, widthProfileSamples } from "./drawing/vector-stroke";
import { resolvePaintTarget } from "./drawing/paint-target";
import {
  bendMotionSegment,
  deleteMotionKey,
  insertMotionKey,
  motionKeysOf,
  setMotionTangent,
  toggleMotionSmooth,
} from "./animation/motion-path";
import { gradientColorAt } from "./animation/paint";
import { buildSoundCues, clipHasSound, collectContainedAudioClips, compHasAudio, frameHasAudio } from "./audio/cues";
import { frameTarget, targetCapabilities } from "./export/target";
import { audioGainAt, dbToGain, gainToDb, hasGainAutomation, sampleGainEnvelope } from "./audio/envelope";
import { audioEffectsAt } from "./audio/effects/resolve";
import { eqMagnitudeDb } from "./audio/eq";
import { audioNeedsBake, audioNeedsBakeLive, clipAudioSignature, pitchShift, timeStretch } from "./audio/dsp";
import type { KeyframeTrack, StyleRange, Subpath, MotionDocument } from "./schema";
import {
  DEFAULT_FRAME_OVERFLOW,
  DOCUMENT_VERSION,
  frameSchema,
  solidPaint,
  strokeStyle,
  type AudioClip,
  type StrokeStyle,
} from "./schema";

function frameIdOf(doc: MotionDocument): string {
  return doc.frames[0]!.id;
}

describe("history store", () => {
  it("undoes and redoes patch-based updates", () => {
    const store = createDocumentStore(createEmptyDocument());
    const clip = createTextClip({ frameId: frameIdOf(store.getState()), text: "hello", startMs: 0 });
    store.update("Add clip", (d) => {
      d.tracks[0]!.clips.push(clip);
    });
    expect(store.getState().tracks[0]!.clips).toHaveLength(1);
    store.undo();
    expect(store.getState().tracks[0]!.clips).toHaveLength(0);
    store.redo();
    expect(store.getState().tracks[0]!.clips).toHaveLength(1);
  });

  it("coalesces updates sharing a mergeKey into one undo step", () => {
    const store = createDocumentStore(createEmptyDocument());
    for (let i = 1; i <= 5; i++) {
      store.update("Rename", (d) => void (d.name = `Name ${i}`), { mergeKey: "rename" });
    }
    expect(store.getState().name).toBe("Name 5");
    store.undo();
    expect(store.getState().name).toBe("Untitled");
    expect(store.canUndo()).toBe(false);
  });

  it("splits clips inside an immer update without DataCloneError", () => {
    const store = createDocumentStore(createEmptyDocument());
    const clip = createTextClip({
      frameId: frameIdOf(store.getState()),
      text: "split in draft",
      startMs: 0,
      durationMs: 2000,
    });
    store.update("Add clip", (d) => void d.tracks[0]!.clips.push(clip));
    // The original bug: splitClip called structuredClone on an immer Proxy.
    store.update("Split", (d) => {
      const rightId = splitClip(d, clip.id, 1000);
      expect(rightId).not.toBeNull();
    });
    expect(store.getState().tracks[0]!.clips).toHaveLength(2);
  });
});

describe("range algebra", () => {
  const base = defaultTextStyle();

  it("applies, splits and merges ranges without overlap", () => {
    let ranges: StyleRange[] = [];
    ranges = applyRangePatch(ranges, 0, 10, { style: { color: "red" } });
    ranges = applyRangePatch(ranges, 5, 15, { style: { fontWeight: 900 } });

    expect(styleAt(base, ranges, 2).color).toBe("red");
    expect(styleAt(base, ranges, 7).color).toBe("red");
    expect(styleAt(base, ranges, 7).fontWeight).toBe(900);
    expect(styleAt(base, ranges, 12).color).toBe(base.color);
    expect(styleAt(base, ranges, 12).fontWeight).toBe(900);

    // Invariant: sorted + non-overlapping
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.start).toBeGreaterThanOrEqual(ranges[i - 1]!.end);
    }
  });

  it("reports mixed values as undefined in sharedStyleIn", () => {
    let ranges: StyleRange[] = [];
    ranges = applyRangePatch(ranges, 0, 5, { style: { color: "red" } });
    const shared = sharedStyleIn(base, ranges, 0, 10);
    expect(shared.color).toBeUndefined(); // mixed
    expect(shared.fontSize).toBe(base.fontSize); // uniform
  });

  it("remaps ranges across text edits", () => {
    let ranges: StyleRange[] = [];
    ranges = applyRangePatch(ranges, 5, 10, { style: { color: "red" } });
    const oldG = splitGraphemes("hello world").map((g) => g.char);
    const newG = splitGraphemes("hey world").map((g) => g.char);
    const splice = diffAsSplice(oldG, newG);
    const remapped = remapRangesAfterSplice(ranges, splice.at, splice.removed, splice.inserted);
    expect(remapped[0]!.start).toBe(3);
    expect(remapped[0]!.end).toBe(8);
  });
});

describe("timeline ops", () => {
  it("pruneTrackIfEmptied removes only an emptied AUTO carrier, never a real lane", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const busy = createCarrierTrack("busy");
    busy.clips.push(createTextClip({ frameId: fid, text: "x", startMs: 0, durationMs: 1000 }));
    const emptied = createCarrierTrack("emptied"); // auto lane, its clip just left
    const manualEmptied = createTrack("manual"); // user lane, emptied — must SURVIVE
    doc.tracks.push(busy, emptied, manualEmptied);
    const total = doc.tracks.length;

    expect(pruneTrackIfEmptied(doc, busy.id)).toBe(false); // has a clip
    // A user-made lane that a clip just left is auto:false → never swept (the bug).
    expect(pruneTrackIfEmptied(doc, manualEmptied.id)).toBe(false);
    expect(pruneTrackIfEmptied(doc, emptied.id)).toBe(true);
    expect(doc.tracks.length).toBe(total - 1);
    expect(doc.tracks.some((t) => t.id === manualEmptied.id)).toBe(true);
    // Never deletes the last remaining track, even an auto one.
    const one = createEmptyDocument();
    while (one.tracks.length > 1) one.tracks.pop();
    one.tracks[0]!.auto = true;
    one.tracks[0]!.clips = [];
    expect(pruneTrackIfEmptied(one, one.tracks[0]!.id)).toBe(false);
  });

  it("addClipToTrack graduates an adopted auto lane out of auto-prune", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const lane = createCarrierTrack("auto");
    addClipToTrack(lane, createTextClip({ frameId: fid, text: "a", startMs: 0, durationMs: 500 }));
    expect(lane.auto).toBe(true); // first clip: still an auto carrier
    addClipToTrack(lane, createTextClip({ frameId: fid, text: "b", startMs: 600, durationMs: 500 }));
    expect(lane.auto).toBe(false); // 2nd clip adopted → now a real lane
    doc.tracks.push(lane);
    lane.clips.length = 0;
    expect(pruneTrackIfEmptied(doc, lane.id)).toBe(false); // survives even when emptied
  });

  it("splits a text clip into in/out halves", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "split me", startMs: 1000, durationMs: 2000, presetId: "fade-up" });
    doc.tracks[0]!.clips.push(clip);
    const rightId = splitClip(doc, clip.id, 1800);
    expect(rightId).not.toBeNull();
    const left = locateClip(doc, clip.id)!.clip;
    const right = locateClip(doc, rightId!)!.clip;
    expect(left.durationMs).toBe(800);
    expect(right.startMs).toBe(1800);
    expect(right.durationMs).toBe(1200);
    if (left.kind === "text" && right.kind === "text") {
      expect(left.animations.in).not.toBeNull();
      expect(right.animations.in).toBeNull();
    }
  });

  it("split CONTINUES a source-backed clip (audio in-point advances)", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    doc.assets.push({
      id: "asset_a",
      kind: "audio",
      name: "a.mp3",
      mime: "audio/mpeg",
      bytes: 1,
      width: null,
      height: null,
      durationMs: 10000,
      fps: null,
      folderId: null,
      origin: null,
    });
    const clip = createAudioClip({ frameId: fid, startMs: 0, durationMs: 4000 });
    clip.source = { type: "asset", assetId: "asset_a" };
    clip.trimInMs = 1000;
    doc.tracks[0]!.clips.push(clip);
    const rightId = splitClip(doc, clip.id, 3000); // local = 3000
    const right = locateClip(doc, rightId!)!.clip;
    const left = locateClip(doc, clip.id)!.clip;
    if (right.kind === "audio") expect(right.trimInMs).toBe(4000); // 1000 + 3000 played
    if (left.kind === "audio") expect(left.trimInMs).toBe(1000); // untouched
  });

  it("split continues a nested clip via its new in-point", () => {
    const doc = createEmptyDocument();
    const parentFid = frameIdOf(doc);
    doc.frames.push({ ...doc.frames[0]!, id: "frame_src", name: "src" });
    const srcTrack = createTrack("s");
    srcTrack.clips.push(createTextClip({ frameId: "frame_src", text: "x", startMs: 0, durationMs: 8000 }));
    doc.tracks.push(srcTrack);
    const nested = createNestedClip({ frameId: parentFid, sourceFrameId: "frame_src", startMs: 0, durationMs: 4000 });
    doc.tracks[0]!.clips.push(nested);
    const rightId = splitClip(doc, nested.id, 2500);
    const right = locateClip(doc, rightId!)!.clip;
    if (right.kind === "nested") expect(right.trimInMs).toBe(2500);
  });

  it("split plants boundary keyframes so an in-progress animation stays smooth", () => {
    const doc = createEmptyDocument();
    const clip = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0 });
    clip.durationMs = 2000;
    doc.tracks[0]!.clips.push(clip);
    clip.keyframes = [
      {
        id: "kt1",
        property: "opacity",
        range: null,
        keys: [
          { id: "k0", timeMs: 0, value: 0, easing: { kind: "linear" } },
          { id: "k1", timeMs: 2000, value: 1, easing: { kind: "linear" } },
        ],
      },
    ];
    const rightId = splitClip(doc, clip.id, 1000); // mid-ramp, sampled value 0.5
    const left = locateClip(doc, clip.id)!.clip;
    const right = locateClip(doc, rightId!)!.clip;
    const leftOp = left.keyframes.find((t) => t.property === "opacity")!;
    const rightOp = right.keyframes.find((t) => t.property === "opacity")!;
    // Left ENDS on the sampled value; right RESUMES from it — no snap.
    const leftLast = leftOp.keys[leftOp.keys.length - 1]!;
    expect(leftLast.timeMs).toBe(1000);
    expect(leftLast.value).toBeCloseTo(0.5, 5);
    expect(rightOp.keys[0]!.timeMs).toBe(0);
    expect(rightOp.keys[0]!.value).toBeCloseTo(0.5, 5);
    // Right still animates on to 1 at its own (re-based) end.
    const rightLast = rightOp.keys[rightOp.keys.length - 1]!;
    expect(rightLast.timeMs).toBe(1000);
    expect(rightLast.value).toBe(1);
  });

  it("prevents overlap when moving clips in a track", () => {
    const doc = createEmptyDocument();
    const a = createTextClip({ frameId: frameIdOf(doc), text: "a", startMs: 0, durationMs: 1000 });
    const b = createTextClip({ frameId: frameIdOf(doc), text: "b", startMs: 2000, durationMs: 1000 });
    doc.tracks[0]!.clips.push(a, b);
    moveClip(doc, b.id, 500); // would overlap a — clamps to a's end
    expect(locateClip(doc, b.id)!.clip.startMs).toBe(1000);
  });

  it("roll edit trims both adjacent clips, keeping the outer span", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const a = createTextClip({ frameId: fid, text: "a", startMs: 0, durationMs: 1000 });
    const b = createTextClip({ frameId: fid, text: "b", startMs: 1000, durationMs: 1000 });
    doc.tracks[0]!.clips.push(a, b);
    expect(rollEdit(doc, a.id, b.id, 1400)).toBe(true);
    expect(locateClip(doc, a.id)!.clip.durationMs).toBe(1400); // left grew
    expect(locateClip(doc, b.id)!.clip.startMs).toBe(1400); // right in-point followed
    expect(locateClip(doc, b.id)!.clip.durationMs).toBe(600); // right shrank
    // Outer span (a.start .. b.end) is unchanged.
    const bLoc = locateClip(doc, b.id)!.clip;
    expect(bLoc.startMs + bLoc.durationMs).toBe(2000);
  });

  it("roll edit advances a media right clip's in-point so it stays in sync", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    doc.assets.push({
      id: "asset_v", kind: "audio", name: "v.mp3", mime: "audio/mpeg",
      bytes: 1, width: null, height: null, durationMs: 10000, fps: null, folderId: null, origin: null,
    });
    const a = createTextClip({ frameId: fid, text: "a", startMs: 0, durationMs: 1000 });
    const b = createAudioClip({ frameId: fid, startMs: 1000, durationMs: 1000 });
    b.source = { type: "asset", assetId: "asset_v" };
    b.trimInMs = 2000;
    doc.tracks[0]!.clips.push(a, b);
    expect(rollEdit(doc, a.id, b.id, 1400)).toBe(true); // seam +400 into b
    const right = locateClip(doc, b.id)!.clip;
    expect(right.startMs).toBe(1400);
    if (right.kind === "audio") expect(right.trimInMs).toBe(2400); // 2000 + 400 consumed
  });

  it("overwrite-move eats the tail of a clip it pushes into", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const a = createTextClip({ frameId: fid, text: "a", startMs: 0, durationMs: 2000 });
    const b = createTextClip({ frameId: fid, text: "b", startMs: 3000, durationMs: 1000 });
    doc.tracks[0]!.clips.push(a, b);
    // Push b left so its head covers a's tail → a's out-point gets trimmed.
    expect(moveClipOverwrite(doc, b.id, 1500)).toBe(true);
    expect(locateClip(doc, b.id)!.clip.startMs).toBe(1500);
    expect(clipEnd(locateClip(doc, a.id)!.clip)).toBe(1500); // a's tail eaten to b's start
    expect(locateClip(doc, a.id)!.clip.startMs).toBe(0);
  });

  it("overwrite-move splits a clip it lands inside, and eats one fully covered", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const big = createTextClip({ frameId: fid, text: "big", startMs: 0, durationMs: 4000 });
    const small = createTextClip({ frameId: fid, text: "s", startMs: 5000, durationMs: 1000 });
    doc.tracks[0]!.clips.push(big, small);
    // Drop small inside big → big splits into a left remnant + a right remnant.
    expect(moveClipOverwrite(doc, small.id, 1000)).toBe(true);
    const sameFrame = doc.tracks[0]!.clips.filter((c) => c.frameId === fid);
    expect(sameFrame.length).toBe(3); // big-left, small, big-right
    const left = sameFrame.find((c) => c.startMs === 0)!;
    expect(clipEnd(left)).toBe(1000);
    const right = sameFrame.find((c) => c.startMs === 2000)!;
    expect(clipEnd(right)).toBe(4000);

    // Now drag small over the entire left remnant → it's eaten whole.
    expect(moveClipOverwrite(doc, small.id, 0)).toBe(true);
    expect(doc.tracks[0]!.clips.some((c) => c.id === left.id)).toBe(false);
  });

  it("drags a clip onto a fresh top/bottom lane, without deleting the vacated one", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const a = createTextClip({ frameId: fid, text: "a", startMs: 0, durationMs: 1000 });
    const srcTrack = doc.tracks[0]!;
    srcTrack.clips.push(a);
    const before = doc.tracks.length;
    expect(moveClipToNewLane(doc, a.id, 500, "top")).toBe(true);
    expect(doc.tracks[0]!.clips[0]!.id).toBe(a.id); // rode a new top lane
    expect(locateClip(doc, a.id)!.clip.startMs).toBe(500);
    // Tracks are never auto-deleted by an edit — only an explicit "Delete
    // track" removes one. The vacated lane survives, now homed to the comp
    // it just emptied out of (so it stays visible there, not everywhere).
    expect(doc.tracks.length).toBe(before + 1);
    expect(srcTrack.clips.length).toBe(0);
    expect(srcTrack.homeCompId).toBe(fid);
  });

  it("moves a linked SET onto fresh lanes — one per source row, arrangement kept", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    // Two source rows: a video-ish clip on top, its audio on a lower lane.
    const top = doc.tracks[0]!;
    const lower = createCarrierTrack("audio", fid);
    doc.tracks.push(lower);
    const v = createTextClip({ frameId: fid, text: "v", startMs: 0, durationMs: 1000 });
    const au = createAudioClip({ frameId: fid, startMs: 0, durationMs: 1000 });
    top.clips.push(v);
    lower.clips.push(au);
    const before = doc.tracks.length;

    const created = moveClipsToNewLanes(
      doc,
      [
        { clipId: v.id, startMs: 500 },
        { clipId: au.id, startMs: 500 },
      ],
      "top",
    );
    expect(created.length).toBe(2); // one new lane per distinct source row
    expect(doc.tracks.length).toBe(before + 2);
    // Topmost source row (video) → topmost new lane; audio just below it.
    expect(doc.tracks[0]!.clips[0]!.id).toBe(v.id);
    expect(doc.tracks[1]!.clips[0]!.id).toBe(au.id);
    expect(locateClip(doc, v.id)!.clip.startMs).toBe(500);
    expect(locateClip(doc, au.id)!.clip.startMs).toBe(500);
  });

  it("collapses a set sharing one source row onto a SINGLE new lane", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const a = createTextClip({ frameId: fid, text: "a", startMs: 0, durationMs: 500 });
    const b = createTextClip({ frameId: fid, text: "b", startMs: 1000, durationMs: 500 });
    doc.tracks[0]!.clips.push(a, b);
    const before = doc.tracks.length;
    const created = moveClipsToNewLanes(
      doc,
      [
        { clipId: a.id, startMs: 0 },
        { clipId: b.id, startMs: 1000 },
      ],
      "bottom",
    );
    expect(created.length).toBe(1); // same source row → one lane, both clips
    expect(doc.tracks.length).toBe(before + 1);
    expect(doc.tracks[doc.tracks.length - 1]!.clips.length).toBe(2);
  });

  it("moves ANY clip kind — tracks are uniform channels", () => {
    const doc = createEmptyDocument();
    const shape = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0 });
    doc.tracks[0]!.clips.push(shape);
    expect(moveClip(doc, shape.id, 1500)).toBe(true);
    expect(locateClip(doc, shape.id)!.clip.startMs).toBe(1500);
  });

  it("nests clips into a new comp — pixels and times survive", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const a = createTextClip({ frameId: fid, text: "a", startMs: 1000, durationMs: 2000 });
    const b = createTextClip({ frameId: fid, text: "b", startMs: 4000, durationMs: 1000 });
    doc.tracks[0]!.clips.push(a, b);
    const nestedId = nestClips(doc, [a.id, b.id]);
    expect(nestedId).not.toBeNull();
    const nested = locateClip(doc, nestedId!)!.clip;
    expect(nested.kind).toBe("nested");
    expect(nested.startMs).toBe(1000); // earliest member
    expect(nested.durationMs).toBe(4000); // spans to b's end
    expect(doc.frames.length).toBe(2);
    const sourceId = nested.kind === "nested" ? nested.sourceFrameId : "";
    // Members moved to the new comp, re-based to t=0.
    expect(locateClip(doc, a.id)!.clip.frameId).toBe(sourceId);
    expect(locateClip(doc, a.id)!.clip.startMs).toBe(0);
    expect(locateClip(doc, b.id)!.clip.startMs).toBe(3000);
  });

  it("auto-sizes a nested comp to its content bounds, preserving pixels", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    // Two 100×100 rects whose union spans x[-50,250], y[-50,150] → 300×200,
    // centered at (100, 50) relative to the parent frame center.
    const a = createShapeClip({ frameId: fid, shape: "rect", startMs: 0, x: 0, y: 0, width: 100, height: 100 });
    const b = createShapeClip({ frameId: fid, shape: "rect", startMs: 0, x: 200, y: 100, width: 100, height: 100 });
    doc.tracks[0]!.clips.push(a, b);

    const nestedId = nestClips(doc, [a.id, b.id])!;
    const nested = locateClip(doc, nestedId)!.clip;
    const source = doc.frames.find((f) => f.id === (nested.kind === "nested" ? nested.sourceFrameId : ""))!;

    // Comp fits the content, NOT the parent (1080×1920).
    expect(source.width).toBe(300);
    expect(source.height).toBe(200);
    // Nested clip carries the content-center offset so nothing moves on screen.
    expect(nested.kind !== "audio" && nested.transform.x).toBe(100);
    expect(nested.kind !== "audio" && nested.transform.y).toBe(50);
    // Members re-centered on the comp: A at (-100,-50), B at (100,50).
    const na = locateClip(doc, a.id)!.clip;
    const nb = locateClip(doc, b.id)!.clip;
    expect(na.kind !== "audio" && na.transform.x).toBe(-100);
    expect(na.kind !== "audio" && na.transform.y).toBe(-50);
    expect(nb.kind !== "audio" && nb.transform.x).toBe(100);
    expect(nb.kind !== "audio" && nb.transform.y).toBe(50);
  });

  it("a new artboard dims its spill; a frame with no stored value takes the default", () => {
    expect(createEmptyDocument().frames[0]!.overflow).toBe(DEFAULT_FRAME_OVERFLOW);
    const legacyFrame = frameSchema.parse({
      id: "f1",
      name: "F",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      background: "#000",
      durationMs: null,
      fps: null,
    });
    expect(legacyFrame.overflow).toBe(DEFAULT_FRAME_OVERFLOW);
  });

  it("restacks a clip to an exact z position and prunes the emptied source", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    // Same track, overlapping times — the case plain moveClip can never reorder.
    const a = createTextClip({ frameId: fid, text: "a", startMs: 0, durationMs: 1000 });
    const b = createTextClip({ frameId: fid, text: "b", startMs: 2000, durationMs: 1000 });
    doc.tracks[0]!.clips.push(a, b);
    const before = doc.tracks.length;

    // Put b above everything (carrier at index 0) — a's track survives.
    expect(restackClip(doc, b.id, { trackIndex: 0 })).toBe(true);
    expect(locateClip(doc, b.id)!.trackIndex).toBe(0);
    expect(doc.tracks.length).toBe(before + 1);

    // Move a below b into its own carrier — its old (now empty) track prunes.
    restackClip(doc, a.id, { trackIndex: locateClip(doc, b.id)!.trackIndex + 1 });
    expect(locateClip(doc, a.id)!.trackIndex).toBe(1);

    // Reparent while restacking.
    const otherFrame = duplicateFrame(doc, fid)!;
    restackClip(doc, a.id, { trackIndex: 0, frameId: otherFrame });
    const moved = locateClip(doc, a.id)!.clip;
    expect(moved.kind !== "audio" && moved.frameId).toBe(otherFrame);
  });

  it("restacks blocks preserving relative order and group membership", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const a = createTextClip({ frameId: fid, text: "a", startMs: 0 });
    const b = createTextClip({ frameId: fid, text: "b", startMs: 0 });
    const c = createTextClip({ frameId: fid, text: "c", startMs: 0 });
    doc.tracks[0]!.clips.push(a);
    doc.tracks.push({ ...doc.tracks[0]!, id: "t2", clips: [b] } as (typeof doc.tracks)[number]);
    doc.tracks.push({ ...doc.tracks[0]!, id: "t3", clips: [c] } as (typeof doc.tracks)[number]);
    doc.tracks[0]!.clips = [a];

    const gid = groupClips(doc, [b.id, c.id])!;
    restackClips(doc, [b.id, c.id], { trackIndex: 0, groupId: null });
    expect(locateClip(doc, b.id)!.trackIndex).toBe(0);
    expect(locateClip(doc, c.id)!.trackIndex).toBe(1);
    expect(groupOfClip(doc, b.id)).toBe(null);
    expect(groupsOf(doc).some((g) => g.id === gid)).toBe(false); // emptied group pruned
  });

  it("reparents a layer into another frame — world position kept, on top, void no-ops", () => {
    const doc = createEmptyDocument();
    const a = doc.frames[0]!;
    const bId = duplicateFrame(doc, a.id)!;
    const b = doc.frames.find((f) => f.id === bId)!;
    // Shape at frame A's center; another layer occupies a higher track first.
    const shape = createShapeClip({ frameId: a.id, shape: "rect", startMs: 0, x: 0, y: 0 });
    doc.tracks[0]!.clips.push(shape);
    const top = createShapeClip({ frameId: a.id, shape: "rect", startMs: 0 });
    const topTrack = createTrack();
    topTrack.clips.push(top);
    doc.tracks.unshift(topTrack);

    const worldX = a.x + a.width / 2 + 0;
    expect(reparentClipToFrame(doc, shape.id, b.id)).toBe(true);
    const moved = locateClip(doc, shape.id)!;
    expect(moved.clip.kind !== "audio" && moved.clip.frameId).toBe(b.id);
    expect(moved.trackIndex).toBe(0); // landed on TOP of the whole stack
    // World position preserved: the new frame-relative x maps to the same world x.
    const newX = moved.clip.kind !== "audio" ? moved.clip.transform.x : 0;
    expect(b.x + b.width / 2 + newX).toBe(worldX);

    // Already in the target, or a missing target (the void) → no change.
    expect(reparentClipToFrame(doc, shape.id, b.id)).toBe(false);
    expect(reparentClipToFrame(doc, shape.id, "no-such-frame")).toBe(false);
  });
});

describe("frames (artboards)", () => {
  it("duplicates a frame with its clips onto new tracks", () => {
    const doc = createStarterDocument();
    const srcId = frameIdOf(doc);
    const clipCountBefore = doc.tracks.flatMap((t) => t.clips).length;
    const newFrameId = duplicateFrame(doc, srcId);
    expect(newFrameId).not.toBeNull();
    expect(doc.frames).toHaveLength(2);
    // v9: audio clips belong to the comp too, so they duplicate with it.
    const copies = doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === newFrameId);
    expect(copies.length).toBeGreaterThan(0);
    expect(doc.tracks.flatMap((t) => t.clips).length).toBe(clipCountBefore + copies.length);
  });

  it("deletes a frame together with its clips — the last one too", () => {
    const doc = createStarterDocument();
    const srcId = frameIdOf(doc);
    const newId = duplicateFrame(doc, srcId)!;
    expect(deleteFrame(doc, newId)).toBe(true);
    expect(doc.frames).toHaveLength(1);
    expect(
      doc.tracks.flatMap((t) => t.clips).some((c) => c.kind !== "audio" && c.frameId === newId),
    ).toBe(false);
    // A project may be an empty canvas — and it survives a save/load that way.
    expect(deleteFrame(doc, srcId)).toBe(true);
    expect(doc.frames).toHaveLength(0);
    expect(parseDocument(serializeDocument(doc)).frames).toHaveLength(0);
  });
});

describe("easing + evaluation", () => {
  it("bezier endpoints are exact and curve is monotone-ish sane", () => {
    const e = { kind: "preset", name: "ease-out-expo" } as const;
    expect(evaluateEasing(e, 0)).toBe(0);
    expect(evaluateEasing(e, 1)).toBe(1);
    expect(evaluateEasing(e, 0.5)).toBeGreaterThan(0.5);
  });

  it("glyphs reveal progressively under a staggered in-animation", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({
      frameId: frameIdOf(doc),
      text: "abc",
      startMs: 0,
      durationMs: 3000,
      presetId: "fade-up",
    });
    clip.animations.in!.unit = "letter";
    clip.animations.in!.staggerMs = 100;
    clip.animations.in!.durationMs = 200;
    const seg = segmentTextCached(clip.text);
    const early = evaluateTextGlyphs(clip, seg, 50);
    expect(early[0]!.opacity).toBeGreaterThan(0);
    expect(early[2]!.opacity).toBe(0);
    const late = evaluateTextGlyphs(clip, seg, 1000);
    expect(late.every((g) => g.opacity === 1)).toBe(true);
  });

  it("fades a slice by its range-keyed opacity (stored AND rendered)", () => {
    const clip = createTextClip({ frameId: frameIdOf(createEmptyDocument()), text: "dim light", startMs: 0, durationMs: 3000 });
    clip.animations = { in: null, out: null } as typeof clip.animations;
    setKeyframe(clip.keyframes, "opacity", 0, 1, { kind: "linear" }, { start: 0, end: 3 });
    setKeyframe(clip.keyframes, "opacity", 1000, 0.35, { kind: "linear" }, { start: 0, end: 3 });
    const seg = segmentTextCached(clip.text);
    const at = evaluateTextGlyphs(clip, seg, 1000);
    expect(at.slice(0, 3).every((g) => Math.abs(g.opacity - 0.35) < 1e-9)).toBe(true);
    expect(at.slice(3).every((g) => g.opacity === 1)).toBe(true);
    expect(evaluateTextGlyphs(clip, seg, 500)[0]!.opacity).toBeCloseTo(0.675, 6);
  });
});

describe("keyframes", () => {
  it("interpolates numbers, blends colors, holds discrete values", () => {
    const tracks: KeyframeTrack[] = [];
    setKeyframe(tracks, "x", 0, 0, { kind: "linear" });
    setKeyframe(tracks, "x", 1000, 100, { kind: "linear" });
    setKeyframe(tracks, "color", 0, "#000000", { kind: "linear" });
    setKeyframe(tracks, "color", 1000, "#ffffff", { kind: "linear" });
    setKeyframe(tracks, "italic", 0, false, { kind: "linear" });
    setKeyframe(tracks, "italic", 1000, true, { kind: "linear" });

    const xTrack = tracks.find((t) => t.property === "x")!;
    const colorTrack = tracks.find((t) => t.property === "color")!;
    const italicTrack = tracks.find((t) => t.property === "italic")!;

    expect(sampleKeyframeTrack(xTrack, 500)).toBe(50);
    expect(sampleKeyframeTrack(colorTrack, 500)).toBe("#808080");
    expect(sampleKeyframeTrack(italicTrack, 999)).toBe(false); // holds
    expect(sampleKeyframeTrack(italicTrack, 1000)).toBe(true);
  });

  it("navigates to adjacent keyframes", () => {
    const tracks: KeyframeTrack[] = [];
    setKeyframe(tracks, "opacity", 200, 0);
    setKeyframe(tracks, "opacity", 800, 1);
    expect(adjacentKeyframe(tracks, 500, "prev", "opacity")?.timeMs).toBe(200);
    expect(adjacentKeyframe(tracks, 500, "next", "opacity")?.timeMs).toBe(800);
    expect(adjacentKeyframe(tracks, 200, "prev", "opacity")).toBeNull();
    expect(adjacentKeyframe(tracks, 800, "next", "opacity")).toBeNull();
  });

  it("lerps hex colors with alpha", () => {
    expect(lerpColor("#00000000", "#ffffffff", 0.5)).toBe("#80808080");
    expect(lerpColor("#ff0000", "#00ff00", 0.5)).toBe("#808000");
  });

  it("keyframed values are absolute — keys own the property (AE semantics)", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "kf", startMs: 0, x: 40, y: 40 });
    // No keys → base transform applies.
    expect(evaluateClipPose(clip, 0).x).toBe(40);
    // Keys → sampled value replaces the base entirely.
    setKeyframe(clip.keyframes, "x", 0, 100, { kind: "linear" });
    setKeyframe(clip.keyframes, "x", 1000, 300, { kind: "linear" });
    expect(evaluateClipPose(clip, 0).x).toBe(100);
    expect(evaluateClipPose(clip, 500).x).toBe(200);
    expect(evaluateClipPose(clip, 1000).x).toBe(300);
    // y untouched by x keys.
    expect(evaluateClipPose(clip, 500).y).toBe(40);
  });

  it("un-keying keeps the value you see: the last key bakes into the base", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "kf", startMs: 1000, x: 40, y: 40 });
    setKeyframe(clip.keyframes, "x", 0, 100, { kind: "linear" });
    setKeyframe(clip.keyframes, "x", 1000, 300, { kind: "linear" });
    const ids = clip.keyframes[0]!.keys.map((k) => k.id);

    // Half the animation goes: still animated, base untouched.
    removeClipKeyframes(clip, [ids[1]!], 500);
    expect(clip.transform.x).toBe(40);
    expect(clip.keyframes[0]!.keys).toHaveLength(1);

    // The last one goes at t=500 — but a lone key holds 100 everywhere, so 100
    // is exactly what the stage was showing.
    removeClipKeyframes(clip, [ids[0]!], 500);
    expect(clip.keyframes).toHaveLength(0);
    expect(clip.transform.x).toBe(100);
    expect(evaluateClipPose(clip, 500).x).toBe(100);
  });

  it("deleting a whole animation freezes the pose at the current time, mid-segment", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "kf", startMs: 0, x: 0, y: 0 });
    setKeyframe(clip.keyframes, "x", 0, 0, { kind: "linear" });
    setKeyframe(clip.keyframes, "x", 1000, 200, { kind: "linear" });
    setKeyframe(clip.keyframes, "opacity", 0, 1, { kind: "linear" });
    setKeyframe(clip.keyframes, "opacity", 1000, 0, { kind: "linear" });
    const all = clip.keyframes.flatMap((t) => t.keys.map((k) => k.id));

    const posed = evaluateClipPose(clip, 250);
    removeClipKeyframes(clip, all, 250);
    expect(clip.keyframes).toHaveLength(0);
    expect(clip.transform.x).toBeCloseTo(posed.x, 6);
    expect(clip.transform.x).toBeCloseTo(50, 6);
    expect(clip.opacity).toBeCloseTo(0.75, 6);
  });

  it("un-keying bakes ANY value kind — colors, discrete flags, effect fields", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "kf", startMs: 0 });
    const shadow = createLayerEffect("shadow");
    clip.effects.push(shadow);
    setKeyframe(clip.keyframes, "color", 0, "#000000", { kind: "linear" });
    setKeyframe(clip.keyframes, "color", 1000, "#ffffff", { kind: "linear" });
    setKeyframe(clip.keyframes, "italic", 0, false, { kind: "linear" });
    setKeyframe(clip.keyframes, "italic", 1000, true, { kind: "linear" });
    setKeyframe(clip.keyframes, layerEffectPath(shadow.id, "blur"), 0, 0, { kind: "linear" });
    setKeyframe(clip.keyframes, layerEffectPath(shadow.id, "blur"), 1000, 40, { kind: "linear" });

    clearClipKeyframes(
      clip,
      ["color", "italic", layerEffectPath(shadow.id, "blur")],
      500,
    );
    expect(clip.keyframes).toHaveLength(0);
    expect(clip.style.color).toBe("#808080");
    expect(clip.style.italic).toBe(false); // discrete: holds the leaving key
    expect(getClipProperty(clip, layerEffectPath(shadow.id, "blur"))).toBe(20);
  });

  it("range-scoped (per-glyph) tracks un-key without touching the clip-level value", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "kf", startMs: 0 });
    const before = clip.style.fontSize;
    setKeyframe(clip.keyframes, "fontSize", 0, 10, { kind: "linear" }, { start: 0, end: 1 });
    setKeyframe(clip.keyframes, "fontSize", 1000, 90, { kind: "linear" }, { start: 0, end: 1 });
    const ids = clip.keyframes[0]!.keys.map((k) => k.id);

    removeClipKeyframes(clip, ids, 500);
    expect(clip.keyframes).toHaveLength(0);
    // The slice's resting value lives in the style range, not the clip slot —
    // baking there would silently restyle the whole layer.
    expect(clip.style.fontSize).toBe(before);
  });

  it("merges keyframes that land on the same time", () => {
    const tracks: KeyframeTrack[] = [];
    setKeyframe(tracks, "x", 0, 0);
    setKeyframe(tracks, "x", 500, 50);
    const moved = setKeyframe(tracks, "x", 1000, 100);
    moveKeyframe(tracks, moved.id, 500); // lands on the 500ms key → replaces it
    const track = tracks[0]!;
    expect(track.keys).toHaveLength(2);
    expect(track.keys[1]!.id).toBe(moved.id);
    expect(track.keys[1]!.value).toBe(100);
  });

  it("scopes keyframes to a text range, kept separate from whole-clip tracks", () => {
    const tracks: KeyframeTrack[] = [];
    // Whole-clip color, plus a color keyframe on just graphemes [2, 5).
    setKeyframe(tracks, "color", 0, "#ffffff", { kind: "linear" });
    setKeyframe(tracks, "color", 0, "#ff0000", { kind: "linear" }, { start: 2, end: 5 });
    setKeyframe(tracks, "color", 1000, "#0000ff", { kind: "linear" }, { start: 2, end: 5 });
    // Two distinct tracks: one whole-clip, one range-scoped.
    expect(tracks).toHaveLength(2);
    expect(propertyHasKeys(tracks, "color")).toBe(true); // whole-clip track counts
    // Clip-level sampling ignores the range track.
    expect(sampleKeyframes(tracks, 500).color).toBe("#ffffff");
    // Range sampling returns the slice with its blended value.
    const rs = sampleRangeStyles(tracks, 500);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.start).toBe(2);
    expect(rs[0]!.end).toBe(5);
    expect(rs[0]!.values.color).toBe("#800080");
  });

  it("keyframes text content, held between keys (discrete)", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "start", startMs: 0, durationMs: 2000 });
    expect(effectiveText(clip, 500)).toBe("start"); // no keys → base text
    setKeyframe(clip.keyframes, "text", 0, "one");
    setKeyframe(clip.keyframes, "text", 1000, "two");
    expect(effectiveText(clip, 0)).toBe("one");
    expect(effectiveText(clip, 999)).toBe("one"); // holds until next key
    expect(effectiveText(clip, 1000)).toBe("two");
    // Content keyframes don't leak into the clip-level pose sample.
    expect(sampleKeyframes(clip.keyframes, 1000).x).toBeUndefined();
  });
});

/** Every group clip in the document — `doc.groups` is gone; a group is a clip. */
function groupsOf(doc: MotionDocument) {
  return allGroupClips(doc);
}
/** The group clip with this id. */
function groupOf(doc: MotionDocument, id: string) {
  return groupClipById(doc, id)!;
}

describe("groups", () => {
  it("groups, expands selection, and ungroups", () => {
    const doc = createEmptyDocument();
    const a = createTextClip({ frameId: frameIdOf(doc), text: "a", startMs: 0 });
    const b = createTextClip({ frameId: frameIdOf(doc), text: "b", startMs: 4000 });
    const c = createTextClip({ frameId: frameIdOf(doc), text: "c", startMs: 8000 });
    doc.tracks[0]!.clips.push(a, b, c);

    const gid = groupClips(doc, [a.id, b.id])!;
    expect(gid).not.toBeNull();
    expect(groupsOf(doc)).toHaveLength(1);
    expect(new Set(clipsInGroup(doc, gid))).toEqual(new Set([a.id, b.id]));

    // Clicking a member selects the GROUP — one id, one thing. Entering the
    // group selects the member singly.
    expect(expandSelectionToGroups(doc, [a.id])).toEqual([gid]);
    expect(expandSelectionToGroups(doc, [a.id], gid)).toEqual([a.id]);
    expect(expandSelectionToGroups(doc, [c.id])).toEqual([c.id]);

    // The group carries a real span: the union of what it holds.
    const group = groupOf(doc, gid);
    expect(group.startMs).toBe(a.startMs);
    expect(group.startMs + group.durationMs).toBe(b.startMs + b.durationMs);

    ungroupClips(doc, [gid]);
    expect(groupsOf(doc)).toHaveLength(0);
    expect(groupOfClip(doc, a.id)).toBeNull();
  });

  it("nests groups: ⌘G inside a group makes a subgroup, ungroup pops one level", () => {
    const doc = createEmptyDocument();
    const a = createTextClip({ frameId: frameIdOf(doc), text: "a", startMs: 0 });
    const b = createTextClip({ frameId: frameIdOf(doc), text: "b", startMs: 1000 });
    const c = createTextClip({ frameId: frameIdOf(doc), text: "c", startMs: 2000 });
    doc.tracks[0]!.clips.push(a, b, c);

    const outer = groupClips(doc, [a.id, b.id, c.id])!;
    // Re-group two members already inside `outer` → a SUBGROUP nested under it.
    const inner = groupClips(doc, [a.id, b.id])!;
    expect(inner).not.toBe(outer);
    expect(groupOfClip(doc, inner)).toBe(outer);
    expect(groupOfClip(doc, a.id)).toBe(inner);
    expect(groupOfClip(doc, c.id)).toBe(outer);
    // The parent encloses every descendant; the child only its own.
    // A nested group is a clip, so it is one of its parent's descendants.
    expect(new Set(clipsUnderGroup(doc, outer))).toEqual(new Set([a.id, b.id, c.id, inner]));
    expect(new Set(clipsUnderGroup(doc, inner))).toEqual(new Set([a.id, b.id]));
    expect(groupAncestry(doc, inner)).toEqual([inner, outer]);

    // Re-nesting a group into its own descendant would cycle — refused.
    moveClipsToScope(doc, [outer], inner);
    expect(groupOfClip(doc, outer)).toBeNull();

    // Ungrouping a member pops just its innermost group up to the parent.
    ungroupClips(doc, [a.id]);
    expect(groupsOf(doc).some((g) => g.id === inner)).toBe(false);
    expect(groupOfClip(doc, a.id)).toBe(outer);
    expect(groupsOf(doc).some((g) => g.id === outer)).toBe(true);
  });

  it("nextEnterGroup drills one level at a time toward a clip (progressive deep-select)", () => {
    const doc = createEmptyDocument();
    const a = createTextClip({ frameId: frameIdOf(doc), text: "a", startMs: 0 });
    const b = createTextClip({ frameId: frameIdOf(doc), text: "b", startMs: 1000 });
    const c = createTextClip({ frameId: frameIdOf(doc), text: "c", startMs: 2000 });
    doc.tracks[0]!.clips.push(a, b, c);
    const outer = groupClips(doc, [a.id, b.id, c.id])!; // a,b,c in outer
    const inner = groupClips(doc, [a.id, b.id])!; // a,b in inner, inner under outer
    // Not yet entered → outermost. Enter it → the child group. Enter that → null
    // (a sits directly in `inner`, nothing deeper). One step per call.
    expect(nextEnterGroup(doc, a.id, null)).toBe(outer);
    expect(nextEnterGroup(doc, a.id, outer)).toBe(inner);
    expect(nextEnterGroup(doc, a.id, inner)).toBeNull();
    // An unrelated entered group re-aims from the outermost. `c` sits directly
    // in outer — which is OPEN while inner is entered — so it has nothing
    // deeper: a double-click lands on it instead of folding back to outer.
    expect(nextEnterGroup(doc, a.id, "nope")).toBe(outer);
    expect(nextEnterGroup(doc, c.id, inner)).toBeNull();
    expect(nextEnterGroup(doc, c.id, outer)).toBeNull();
    const loose = createTextClip({ frameId: frameIdOf(doc), text: "x", startMs: 5000 });
    doc.tracks[0]!.clips.push(loose);
    expect(nextEnterGroup(doc, loose.id, null)).toBeNull();
  });

  it("pullClipsOutOneLevel pops a clip up one nesting level (drag-out) and prunes empties", () => {
    const doc = createEmptyDocument();
    const a = createTextClip({ frameId: frameIdOf(doc), text: "a", startMs: 0 });
    const b = createTextClip({ frameId: frameIdOf(doc), text: "b", startMs: 1000 });
    const c = createTextClip({ frameId: frameIdOf(doc), text: "c", startMs: 2000 });
    doc.tracks[0]!.clips.push(a, b, c);
    const outer = groupClips(doc, [a.id, b.id, c.id])!;
    const inner = groupClips(doc, [a.id, b.id])!; // a,b: inner → outer
    // Pop `a` out of `inner` into `outer`; `inner` still holds `b`, so it lives.
    pullClipsOutOneLevel(doc, [a.id]);
    expect(groupOfClip(doc, a.id)).toBe(outer);
    expect(groupsOf(doc).some((g) => g.id === inner)).toBe(true);
    // Pop again → out of `outer` to the top; `outer` still holds `b`,`c` → lives.
    pullClipsOutOneLevel(doc, [a.id]);
    expect(groupOfClip(doc, a.id)).toBeNull();
    expect(groupsOf(doc).some((g) => g.id === outer)).toBe(true);
    // A top-level clip has nowhere to go — no-op, no crash.
    pullClipsOutOneLevel(doc, [a.id]);
    expect(groupOfClip(doc, a.id)).toBeNull();
    // Emptying a group DOES prune it: pull the lone remaining member of `inner`.
    pullClipsOutOneLevel(doc, [b.id]);
    expect(groupsOf(doc).some((g) => g.id === inner)).toBe(false);
  });

  it("grouping a selection that covers a whole group NESTS it — never dissolves it", () => {
    const doc = createEmptyDocument();
    const a = createTextClip({ frameId: frameIdOf(doc), text: "a", startMs: 0 });
    const b = createTextClip({ frameId: frameIdOf(doc), text: "b", startMs: 0 });
    const c = createTextClip({ frameId: frameIdOf(doc), text: "c", startMs: 0 });
    doc.tracks[0]!.clips.push(a, b, c);

    const inner = groupClips(doc, [a.id, b.id])!;
    groupOf(doc, inner).mode = "union";

    // The partition: a selected group is ONE unit and its contents come with
    // it; c is loose. Selecting a MEMBER without its group is exactly that —
    // the member — which is what makes "a group is one thing" checkable.
    const units = selectionTopUnits(doc, [inner, c.id]);
    expect(units.groups).toEqual([inner]);
    expect(units.clips).toEqual([c.id]);
    expect(selectionTopUnits(doc, [inner, a.id]).clips).toEqual([]);

    const outer = groupClips(doc, [inner, c.id])!;
    // The union group survives intact, nested under the new group.
    expect(groupsOf(doc).some((g) => g.id === inner)).toBe(true);
    expect(groupOfClip(doc, inner)).toBe(outer);
    expect(groupsOf(doc).find((g) => g.id === inner)!.mode).toBe("union");
    expect(groupOfClip(doc, a.id)).toBe(inner);
    expect(groupOfClip(doc, c.id)).toBe(outer);

    // ⌘G on exactly one whole group wraps it (parent climbs past the unit).
    const wrap = groupClips(doc, [inner, a.id, b.id])!;
    expect(groupOfClip(doc, inner)).toBe(wrap);
    expect(groupOfClip(doc, wrap)).toBe(outer);
  });

  it("restackUnits moves a whole group out of its parent with its structure intact", () => {
    const doc = createEmptyDocument();
    const a = createTextClip({ frameId: frameIdOf(doc), text: "a", startMs: 0 });
    const b = createTextClip({ frameId: frameIdOf(doc), text: "b", startMs: 0 });
    const c = createTextClip({ frameId: frameIdOf(doc), text: "c", startMs: 0 });
    doc.tracks[0]!.clips.push(a, b, c);
    const inner = groupClips(doc, [a.id, b.id])!;
    // The app groups what is SELECTED, and selecting a member resolves to its
    // group — so wrapping "the inner group and c" is `[inner, c]`.
    const outer = groupClips(doc, [inner, c.id])!;

    // Drag the inner group to the frame's top level (the layers-list gesture
    // that used to dissolve EVERY group).
    restackUnits(doc, [{ kind: "group", id: inner }], { trackIndex: 0, groupId: null });
    expect(groupsOf(doc).some((g) => g.id === inner)).toBe(true);
    expect(groupsOf(doc).some((g) => g.id === outer)).toBe(true);
    expect(groupOfClip(doc, inner)).toBeNull();
    expect(groupOfClip(doc, a.id)).toBe(inner);
    expect(groupOfClip(doc, b.id)).toBe(inner);
    expect(groupOfClip(doc, c.id)).toBe(outer);

    // Dropping a group into its own descendant is refused (no cycle).
    moveClipsToScope(doc, [inner], outer);
    restackUnits(doc, [{ kind: "group", id: outer }], { trackIndex: 0, groupId: inner });
    expect(groupOfClip(doc, outer)).toBeNull();
  });

  it("nested composite groups: a union inside a subtract stays one whole-group selection", () => {
    const doc = createEmptyDocument();
    const a = createTextClip({ frameId: frameIdOf(doc), text: "a", startMs: 0 });
    const b = createTextClip({ frameId: frameIdOf(doc), text: "b", startMs: 0 });
    const c = createTextClip({ frameId: frameIdOf(doc), text: "c", startMs: 0 });
    doc.tracks[0]!.clips.push(a, b, c);

    const union = applyCompositeMode(doc, [a.id, b.id], "union")!;
    // Selecting the union + another layer and subtracting NESTS the union.
    const outer = applyCompositeMode(doc, [union, c.id], "subtract")!;
    expect(outer).not.toBe(union);
    expect(groupsOf(doc).find((g) => g.id === union)!.mode).toBe("union");
    expect(groupOfClip(doc, union)).toBe(outer);
    expect(groupsOf(doc).find((g) => g.id === outer)!.mode).toBe("subtract");

    // The whole selection still reads as the OUTER group (nesting-aware), so
    // mode switches keep editing it in place.
    const info = selectionCompositeInfo(doc, [outer]);
    expect(info.groupId).toBe(outer);
    expect(applyCompositeMode(doc, [outer], "intersect")).toBe(outer);
    expect(groupsOf(doc).find((g) => g.id === union)!.mode).toBe("union");

    // The layer tree mirrors it: outer → [union → [a, b], c].
    const tree = frameLayerTree(doc, frameIdOf(doc));
    expect(tree).toHaveLength(1);
    const outerNode = tree[0]!;
    if (outerNode.type !== "group") throw new Error("expected group node");
    expect(outerNode.clip.id).toBe(outer);
    expect(outerNode.clipIds).toEqual([a.id, b.id, c.id]);
    const unionNode = outerNode.children[0]!;
    if (unionNode.type !== "group") throw new Error("expected nested group node");
    expect(unionNode.clip.id).toBe(union);
    expect(unionNode.clipIds).toEqual([a.id, b.id]);
    expect(outerNode.children[1]).toMatchObject({ type: "clip" });
  });

  it("composite modes reuse a whole-group selection instead of wrapping it", () => {
    const doc = createEmptyDocument();
    const a = createTextClip({ frameId: frameIdOf(doc), text: "a", startMs: 0 });
    const b = createTextClip({ frameId: frameIdOf(doc), text: "b", startMs: 0 });
    doc.tracks[0]!.clips.push(a, b);

    // Fresh selection → a new group carrying the mode.
    const gid = applyCompositeMode(doc, [a.id, b.id], "subtract")!;
    expect(gid).not.toBeNull();
    expect(groupsOf(doc)).toHaveLength(1);
    expect(groupsOf(doc)[0]!.mode).toBe("subtract");

    // Selecting the GROUP and switching modes edits it IN PLACE.
    const info = selectionCompositeInfo(doc, [gid]);
    expect(info.eligible).toBe(true);
    expect(info.groupId).toBe(gid);
    expect(applyCompositeMode(doc, [gid], "union")).toBe(gid);
    expect(groupsOf(doc)).toHaveLength(1);
    expect(groupsOf(doc)[0]!.mode).toBe("union");

    // A single layer can't combine.
    expect(selectionCompositeInfo(doc, [a.id]).eligible).toBe(false);
    expect(applyCompositeMode(doc, [a.id], "union")).toBeNull();
  });

  it("mask mode promotes the topmost member to the stencil by default", () => {
    const doc = createEmptyDocument();
    const bottom = createTextClip({ frameId: frameIdOf(doc), text: "content", startMs: 0 });
    const top = createTextClip({ frameId: frameIdOf(doc), text: "stencil", startMs: 0 });
    // Track 0 paints on top; put `top` on its own upper track.
    doc.tracks[0]!.clips.push(top);
    doc.tracks.push(structuredClone(doc.tracks[0]!));
    doc.tracks[1]!.clips = [bottom];
    doc.tracks[1]!.id = "track_b";

    const gid = applyCompositeMode(doc, [bottom.id, top.id], "mask")!;
    expect(groupsOf(doc).find((g) => g.id === gid)!.mode).toBe("mask");
    expect(top.isStencil).toBe(true);
    expect(bottom.isStencil).toBe(false);

    // Roles survive a round-trip through another mode.
    applyCompositeMode(doc, [bottom.id, top.id], "intersect");
    applyCompositeMode(doc, [bottom.id, top.id], "mask");
    expect(top.isStencil).toBe(true);
    expect(bottom.isStencil).toBe(false);

    setClipStencilRole(doc, bottom.id, true);
    expect(bottom.isStencil).toBe(true);
  });
});

describe("frame sizing & timing", () => {
  it("scales frame contents uniformly, including x/y/scale keyframes", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "s", startMs: 0, x: 100, y: -50 });
    setKeyframe(clip.keyframes, "x", 0, 200, { kind: "linear" });
    doc.tracks[0]!.clips.push(clip);

    resizeFrame(doc, frameIdOf(doc), 2160, 3840, { scaleContents: true });
    expect(doc.frames[0]!.width).toBe(2160);
    expect(clip.transform.x).toBe(200);
    expect(clip.transform.y).toBe(-100);
    expect(clip.transform.scale).toBe(2);
    expect(clip.keyframes[0]!.keys[0]!.value).toBe(400);
  });

  it("a comp's length lives on the comp, however many comps the document has (v113)", () => {
    const doc = createEmptyDocument();
    expect(frameDurationMs(doc, doc.frames[0]!)).toBe(10000);
    setFrameDurationMs(doc, doc.frames[0]!.id, 4000);
    expect(doc.frames[0]!.durationMs).toBe(4000);
    expect(frameDurationMs(doc, doc.frames[0]!)).toBe(4000);
    // A second comp changes nothing about the first.
    doc.frames.push(createFrame({ name: "Other" }));
    expect(frameDurationMs(doc, doc.frames[0]!)).toBe(4000);
  });
});

describe("color variables", () => {
  it("resolves tokens, counts usage, detaches on delete", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "v", startMs: 0 });
    doc.tracks[0]!.clips.push(clip);

    const brand = addColorVariable(doc, "Brand", "#F5B843");
    clip.style.color = colorVarToken(brand.id);
    doc.frames[0]!.background = colorVarToken(brand.id);

    expect(resolveColor(doc, clip.style.color)).toBe("#F5B843");
    expect(resolveColor(doc, "#123456")).toBe("#123456");
    expect(colorVariableUsage(doc).get(brand.id)).toBe(2);

    brand.value = "#4CC3E0";
    expect(resolveColor(doc, clip.style.color)).toBe("#4CC3E0");

    deleteColorVariable(doc, brand.id);
    expect(doc.variables).toHaveLength(0);
    expect(clip.style.color).toBe("#4CC3E0"); // detached to the literal
    expect(doc.frames[0]!.background).toBe("#4CC3E0");
  });

  it("carries a slot's own alpha on the reference, invisibly to everything else", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "v", startMs: 0 });
    doc.tracks[0]!.clips.push(clip);
    const brand = addColorVariable(doc, "Brand", "#F5B843");

    // Fully opaque writes no modifier at all — the token a document held
    // yesterday is byte-identical to the one it holds today.
    expect(varToken(brand.id, 1)).toBe(varToken(brand.id));
    expect(parseVarAlpha(varToken(brand.id))).toBeNull();

    const faded = withVarAlpha(varToken(brand.id), 0.5);
    expect(parseVarToken(faded)).toBe(brand.id);
    expect(parseVarAlpha(faded)).toBe(0.5);
    expect(resolveColor(doc, faded)).toBe("#f5b84380");

    // …and the reference is still a reference: retinting reaches it, and the
    // usage count, the walker and delete-detach never saw a modifier.
    clip.style.color = faded;
    expect(colorVariableUsage(doc).get(brand.id)).toBe(1);
    brand.value = "#4CC3E0";
    expect(resolveColor(doc, clip.style.color)).toBe("#4cc3e080");
    deleteColorVariable(doc, brand.id);
    expect(clip.style.color).toBe("#4CC3E0");
  });

  it("multiplies a slot's alpha into the variable's own", () => {
    const doc = createEmptyDocument();
    // A translucent variable asked for at 50% is HALF of what it is, not
    // opaque-at-50 — replacing would let a slot discard a property of the
    // palette it is only referencing.
    const scrim = addColorVariable(doc, "Scrim", "#00000080");
    expect(resolveColor(doc, withVarAlpha(varToken(scrim.id), 0.5))).toBe("#00000040");
  });

  it("detaches on a colour edit and rides the reference on an alpha edit", () => {
    const doc = createEmptyDocument();
    // Hex carries alpha in /255, so "80" is 0.502 and not 0.5. The token keeps
    // three decimals, which round-trips back to the same byte exactly.
    const HEX_HALF = 128 / 255;
    const brand = addColorVariable(doc, "Brand", "#f5b843");
    const bound = varToken(brand.id);

    // Same colour, less of it → still the variable, now carrying this slot's
    // opacity. This is the whole point: fading a layer must not unlink it.
    expect(applyColorEdit(doc, bound, "#f5b84380")).toBe(varToken(brand.id, HEX_HALF));
    // A different colour → a literal, and the link is gone.
    expect(applyColorEdit(doc, bound, "#4cc3e0")).toBe("#4cc3e0");
    // An unbound slot is untouched by any of it.
    expect(applyColorEdit(doc, "#ffffff", "#ffffff80")).toBe("#ffffff80");

    // A translucent variable: the control shows 25% of the palette entry, so
    // asking for 50% has to store 50% — not 50% of something invisible.
    const scrim = addColorVariable(doc, "Scrim", "#00000080");
    const half = varToken(scrim.id, 0.5);
    expect(resolveColor(doc, half)).toBe("#00000040");
    expect(applyColorEdit(doc, half, "#00000080")).toBe(varToken(scrim.id, 1));
  });

  it("keeps the slot's opacity when it is linked", () => {
    const doc = createEmptyDocument();
    const brand = addColorVariable(doc, "Brand", "#f5b843");
    // A faded literal, linked: you asked for this colour, not for the fade you
    // had dialled in to be thrown away.
    expect(linkColorSlot(doc, "#11223380", brand.id)).toBe(varToken(brand.id, 128 / 255));
    expect(linkColorSlot(doc, "#112233", brand.id)).toBe(varToken(brand.id));
    // Re-linking a bound slot carries its modifier across.
    expect(linkColorSlot(doc, varToken(brand.id, 0.25), brand.id)).toBe(varToken(brand.id, 0.25));
    expect(linkColorSlot(doc, undefined, brand.id)).toBe(varToken(brand.id));
  });

  it("keeps a literal a literal", () => {
    expect(withVarAlpha("#ff0000", 0.5)).toBe("#ff0000");
    expect(parseVarAlpha("#ff0000")).toBeNull();
    expect(parseVarToken("var:")).toBeNull();
  });
});

describe("typed variables", () => {
  it("resolves typed tokens, enforces unique names, detaches typography on delete", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "v", startMs: 0 });
    doc.tracks[0]!.clips.push(clip);

    const size = addVariable(doc, "number", "H1 Size", 96);
    const family = addVariable(doc, "fontFamily", "Display", "Space Grotesk");
    // Unique names auto-suffix on clash (case-insensitive).
    const dupe = addVariable(doc, "number", "h1 size", 48);
    expect(dupe.name).toBe("h1 size 2");

    clip.style.fontSize = varToken(size.id);
    clip.style.fontFamily = varToken(family.id);

    expect(resolveNumber(doc, clip.style.fontSize, 12)).toBe(96);
    expect(resolveNumber(doc, 24, 12)).toBe(24); // literal passthrough
    expect(resolveFontFamily(doc, clip.style.fontFamily)).toBe("Space Grotesk");
    // Wrong-type / missing → the type's fallback.
    expect(resolveNumber(doc, varToken(family.id), 12)).toBe(12);
    expect(variableUsage(doc).get(size.id)).toBe(1);

    deleteVariable(doc, size.id);
    expect(clip.style.fontSize).toBe(96); // detached to the literal number
    expect(doc.variables.find((v) => v.id === size.id)).toBeUndefined();
  });

  it("migrates a v34 colorVariables doc into the v35 typed variables table", () => {
    const doc = createEmptyDocument();
    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    raw.version = 34;
    delete raw.variables;
    raw.colorVariables = [{ id: "cvar_1", name: "Brand", value: "#F5B843" }];

    const migrated = parseDocument(JSON.stringify(raw));
    expect(migrated.version).toBe(DOCUMENT_VERSION);
    expect((migrated as unknown as { colorVariables?: unknown }).colorVariables).toBeUndefined();
    expect(migrated.variables).toEqual([
      { id: "cvar_1", name: "Brand", type: "color", value: "#F5B843" },
    ]);
  });

  it("migrates a v52 vector `capture` track into the `geometry` morph channel", () => {
    const doc = createEmptyDocument();
    const path = createPathClip({
      frameId: doc.frames[0]!.id,
      subpaths: [{ closed: false, points: [{ x: 0, y: 0, hIn: null, hOut: null }] }],
      startMs: 0,
    });
    doc.tracks[0]!.clips.push(path);
    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    raw.version = 52;
    const clip = ((raw.tracks as Array<Record<string, unknown>>)[0]!
      .clips as Array<Record<string, unknown>>).find((c) => c.kind === "path")!;
    const box = (n: number) => [{ closed: true, points: [{ x: n, y: 0, hIn: null, hOut: null }] }];
    clip.captureCrossfade = true;
    clip.keyframes = [
      { id: "kt", property: "capture", range: null, keys: [
        { id: "k0", timeMs: 0, value: box(1), easing: { kind: "linear" } },
        { id: "k1", timeMs: 100, value: box(2), easing: { kind: "linear" } },
      ] },
    ];

    const migrated = parseDocument(JSON.stringify(raw));
    const out = migrated.tracks[0]!.clips.find((c) => c.kind === "path")!;
    // The snapshots survive verbatim — only the channel they animate changes.
    expect(out.keyframes.map((t) => t.property)).toEqual(["geometry"]);
    expect(out.keyframes[0]!.keys.map((k) => k.value)).toEqual([box(1), box(2)]);
    expect((out as { captureCrossfade?: boolean }).captureCrossfade).toBeUndefined();
  });

  it("folds a converted capture track into a geometry track the clip already had", () => {
    const doc = createEmptyDocument();
    const path = createPathClip({
      frameId: doc.frames[0]!.id,
      subpaths: [{ closed: false, points: [{ x: 0, y: 0, hIn: null, hOut: null }] }],
      startMs: 0,
    });
    doc.tracks[0]!.clips.push(path);
    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    raw.version = 52;
    const clip = ((raw.tracks as Array<Record<string, unknown>>)[0]!
      .clips as Array<Record<string, unknown>>).find((c) => c.kind === "path")!;
    const box = (n: number) => [{ closed: true, points: [{ x: n, y: 0, hIn: null, hOut: null }] }];
    clip.keyframes = [
      { id: "g", property: "geometry", range: null, keys: [
        { id: "g0", timeMs: 200, value: box(9), easing: { kind: "linear" } },
      ] },
      { id: "c", property: "capture", range: null, keys: [
        { id: "c0", timeMs: 0, value: box(1), easing: { kind: "linear" } },
      ] },
    ];

    const migrated = parseDocument(JSON.stringify(raw));
    const out = migrated.tracks[0]!.clips.find((c) => c.kind === "path")!;
    // One channel, keys in time order — never two tracks fighting over one outline.
    expect(out.keyframes.length).toBe(1);
    expect(out.keyframes[0]!.keys.map((k) => k.timeMs)).toEqual([0, 200]);
  });

  it("carries a v35 fixed 3-band EQ all the way to an EQ CARD, keyframes intact", () => {
    const doc = createEmptyDocument();
    const audio = createAudioClip({ frameId: doc.frames[0]!.id, startMs: 0, durationMs: 1000 });
    (audio as unknown as { eq: unknown }).eq = { low: 3, mid: 0, high: -6 };
    setKeyframe(audio.keyframes, "eq.mid", 0, 4, { kind: "linear" });
    doc.tracks[0]!.clips.push(audio);
    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    raw.version = 35;

    // Two hops: v36 made the fixed triple parametric, v55 made the whole thing
    // an ordinary card in the audio effect stack. A document written before
    // either must still arrive with its curve AND its automation.
    const migrated = parseDocument(JSON.stringify(raw));
    const clip = migrated.tracks[0]!.clips.find((c) => c.kind === "audio") as AudioClip;
    expect((clip as unknown as { eq?: unknown }).eq).toBeUndefined();

    const eq = clip.audioEffects[0]!;
    expect(eq.type).toBe("eq");
    if (eq.type !== "eq") throw new Error("expected an EQ card");
    expect(eq.enabled).toBe(true);
    expect(eq.bands.length).toBe(3);
    expect(eq.bands[0]!.type).toBe("lowshelf");
    expect(eq.bands[0]!.gainDb).toBe(3);
    expect(eq.bands[2]!.gainDb).toBe(-6);

    // The old `eq.mid` track now addresses the middle band inside that card.
    const midId = eq.bands[1]!.id;
    expect(clip.keyframes.some((t) => t.property === `afx.${eq.id}.band.${midId}.gain`)).toBe(true);
    expect(clip.keyframes.some((t) => t.property.startsWith("eq."))).toBe(false);
  });
});

describe("sound cues", () => {
  it("emits one cue per unit, skipping whitespace, deterministic seeds", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({
      frameId: frameIdOf(doc),
      text: "hi yo",
      startMs: 0,
      durationMs: 3000,
      presetId: "typewriter",
    });
    clip.sounds = [makeSoundLayer({ kind: "text" }, "in")];
    doc.tracks[0]!.clips.push(clip);
    const cues = buildSoundCues(doc, 0, 10000);
    expect(cues.length).toBe(4); // h, i, y, o — space skipped
    const cues2 = buildSoundCues(doc, 0, 10000);
    expect(cues.map((c) => c.seed)).toEqual(cues2.map((c) => c.seed));
  });

  it("detects text typing sound as export audio (the vanished 'include sound' bug)", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({
      frameId: frameIdOf(doc),
      text: "hi",
      startMs: 0,
      durationMs: 3000,
      presetId: "typewriter",
    });
    clip.sounds = [makeSoundLayer({ kind: "text" }, "in")];
    doc.tracks[0]!.clips.push(clip);
    expect(compHasAudio(doc, [clip])).toBe(true);
    expect(targetCapabilities(doc, frameTarget(doc, frameIdOf(doc))).hasAudio).toBe(true);
  });

  it("detects + emits sound inside a nested comp (recursive inventory)", () => {
    const doc = createEmptyDocument();
    const parentFid = frameIdOf(doc);
    doc.frames.push({ ...doc.frames[0]!, id: "frame_src", name: "src" });
    const srcTrack = createTrack("s");
    const inner = createTextClip({ frameId: "frame_src", text: "hi", startMs: 0, durationMs: 4000, presetId: "typewriter" });
    inner.sounds = [makeSoundLayer({ kind: "text" }, "in")];
    srcTrack.clips.push(inner);
    doc.tracks.push(srcTrack);
    const nested = createNestedClip({ frameId: parentFid, sourceFrameId: "frame_src", startMs: 500, durationMs: 4000 });
    doc.tracks[0]!.clips.push(nested);

    // The parent comp knows it carries sound, and cues fold up into parent time.
    expect(frameHasAudio(doc, parentFid)).toBe(true);
    expect(clipHasSound(doc, nested)).toBe(true);
    const cues = buildSoundCues(doc, 0, 10000, parentFid);
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.every((c) => c.timeMs >= 500)).toBe(true); // shifted by the nested start

    // Muting the nested clip's universal fader silences the whole sub-mix.
    nested.audioMix.muted = true;
    expect(buildSoundCues(doc, 0, 10000, parentFid).length).toBe(0);
    expect(compHasAudio(doc, [nested])).toBe(false);
  });
});

describe("io", () => {
  it("roundtrips the starter document through JSON", () => {
    const doc = createStarterDocument();
    const parsed = parseDocument(serializeDocument(doc));
    expect(parsed).toEqual(doc);
    expect(contentEndMs(parsed)).toBeGreaterThan(0);
  });

  it("migrates a v1 document to v2 (frames, frameId, caption animations)", () => {
    const v1 = {
      version: 1,
      id: "doc_v1",
      name: "Old project",
      frame: { width: 1080, height: 1920, background: "#0E0E11", fps: 30, durationMs: 8000 },
      tracks: [
        {
          id: "track_1",
          name: "Text",
          kind: "text",
          muted: false,
          locked: false,
          hidden: false,
          clips: [
            {
              id: "clip_1",
              kind: "text",
              name: "hello",
              startMs: 0,
              durationMs: 2000,
              text: "hello",
              style: defaultTextStyle(),
              ranges: [],
              transform: { x: 0, y: 0, scale: 1, scaleY: null, rotation: 0 },
              maxWidth: null,
              animations: { in: null, out: null },
              keyframes: [],
              sound: { enabled: false, pack: "mechanical", volume: 0.6, randomness: 0.35, pitch: 1 },
            },
          ],
        },
      ],
    };
    const doc = parseDocument(JSON.stringify(v1));
    expect(doc.version).toBeGreaterThanOrEqual(3);
    expect(doc.frames).toHaveLength(1);
    // v48: the document rate is gone — the v1 doc's 30fps landed on the frame.
    expect(doc.frames[0]!.fps).toBe(30);
    expect(doc.durationMs).toBe(8000);
    expect(groupsOf(doc)).toEqual([]);
    expect(doc.variables).toEqual([]);
    // v113: the one comp carries the document's length.
    expect(doc.frames[0]!.durationMs).toBe(8000);
    const clip = doc.tracks[0]!.clips[0]!;
    expect(clip.kind).toBe("text");
    if (clip.kind === "text") {
      expect(clip.frameId).toBe(doc.frames[0]!.id);
      expect(groupOfClip(doc, clip.id)).toBeNull();
    }
  });

  it("rejects garbage", () => {
    expect(() => parseDocument("{}")).toThrow();
    expect(() => parseDocument("not json")).toThrow();
  });
});

describe("segmentation", () => {
  it("handles emoji as single units and assigns word indices", () => {
    const seg = segmentText("go 🚀 now");
    const rocket = seg.graphemes.findIndex((g) => g.char === "🚀");
    expect(rocket).toBeGreaterThan(-1);
    expect(seg.wordCount).toBe(3);
    expect(seg.wordIndex[rocket]).toBe(1);
  });
});

describe("clip playback / time remap", () => {
  it("clamps (none), wraps (loop), bounces (pingpong), and scales by speed", () => {
    expect(sourceTimeAt(500, 1000, { speed: 1, loop: "none", reverse: false, loopLengthMs: null })).toBe(500);
    expect(sourceTimeAt(1500, 1000, { speed: 1, loop: "none", reverse: false, loopLengthMs: null })).toBe(1000); // clamp at end
    expect(sourceTimeAt(1200, 1000, { speed: 1, loop: "loop", reverse: false, loopLengthMs: null })).toBe(200); // wrap
    expect(sourceTimeAt(1200, 1000, { speed: 1, loop: "pingpong", reverse: false, loopLengthMs: null })).toBe(800); // bounce back
    expect(sourceTimeAt(1000, 1000, { speed: 1, loop: "pingpong", reverse: false, loopLengthMs: null })).toBe(1000); // turnaround
    expect(sourceTimeAt(300, 1000, { speed: 2, loop: "none", reverse: false, loopLengthMs: null })).toBe(600); // 2× speed
    // Reverse mirrors the mapped source time about the span.
    expect(sourceTimeAt(300, 1000, { speed: 1, loop: "none", reverse: true, loopLengthMs: null })).toBe(700);
    expect(sourceTimeAt(0, 1000, { speed: 1, loop: "none", reverse: true, loopLengthMs: null })).toBe(1000); // starts at end
    expect(sourceTimeAt(1200, 1000, { speed: 1, loop: "loop", reverse: true, loopLengthMs: null })).toBe(800); // reversed wrap
  });

  it("nested factory + frame content duration", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    doc.tracks[0]!.clips.push(
      createTextClip({ frameId: fid, text: "a", startMs: 0, durationMs: 2000 }),
      createTextClip({ frameId: fid, text: "b", startMs: 1500, durationMs: 2000 }),
    );
    expect(frameContentDurationMs(doc, fid)).toBe(3500); // last clip end
    const nested = createNestedClip({ frameId: fid, sourceFrameId: fid, startMs: 0 });
    expect(nested.kind).toBe("nested");
    expect(nested.playback).toEqual({ speed: 1, loop: "none", reverse: false, loopLengthMs: null });
    expect(nested.sourceFrameId).toBe(fid);
  });
});

describe("effect stack + keyframe paths", () => {
  it("blends effect color keyframes via value-based interpolation (no registry entry)", () => {
    const tracks: import("./schema").KeyframeTrack[] = [];
    setKeyframe(tracks, "lfx.e1.color", 0, "#000000", { kind: "linear" });
    setKeyframe(tracks, "lfx.e1.color", 100, "#ffffff", { kind: "linear" });
    const mid = sampleKeyframeTrack(tracks[0]!, 50);
    expect(typeof mid).toBe("string");
    expect(mid).not.toBe("#000000");
    expect(mid).not.toBe("#ffffff");
    expect((mid as string).startsWith("#")).toBe(true);
  });

  it("lets an ANIMATED scale pass below the 1% gesture floor (camera pull-backs, scale-to-0 exits)", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "far", startMs: 0 });
    setClipProperty(clip, "scale", 0.0025);
    expect(clip.transform.scale).toBe(0.0025);
    setClipProperty(clip, "scaleY", -0.0004);
    expect(clip.transform.scaleY).toBe(-0.0004); // a mirror stays a mirror
    setClipProperty(clip, "scale", 0);
    expect(clip.transform.scale).toBeGreaterThan(0); // still invertible for hit testing
    expect(clip.transform.scale).toBeLessThan(1e-5);
  });

  it("reads and writes any value by path, including effect-stack fields", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "fx", startMs: 0 });
    const shadow = createLayerEffect("shadow");
    clip.effects.push(shadow);

    setClipProperty(clip, "x", 42);
    expect(getClipProperty(clip, "x")).toBe(42);
    expect(clip.transform.x).toBe(42);

    setClipProperty(clip, layerEffectPath(shadow.id, "blur"), 40);
    expect(getClipProperty(clip, layerEffectPath(shadow.id, "blur"))).toBe(40);
    expect(clip.effects[0]).toMatchObject({ type: "shadow", blur: 40 });
  });

  it("clones effects with fresh ids so styles never alias", () => {
    const a = [createLayerEffect("shadow"), createLayerEffect("stroke")];
    const b = cloneLayerEffects(a);
    expect(b.map((e) => e.id)).not.toEqual(a.map((e) => e.id));
    expect(b[0]!.type).toBe("shadow");
  });

  it("v87: film damage that already slipped keeps slipping; a new card does not", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "reel", startMs: 0 });
    doc.tracks[0]!.clips.push(clip);
    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    raw.version = 86;
    const card = (id: string, jump: number) => ({ ...createLayerEffect("filmDamage"), id, jump, splices: undefined });
    const c = (raw.tracks as any)[0].clips[0];
    c.effects = [card("slips", 0.06), card("still", 0), card("keyed", 0)].map(({ splices: _s, ...fx }) => fx);
    c.keyframes = [{ id: "k", property: "lfx.keyed.jump", keys: [] }];
    const migrated = parseDocument(JSON.stringify(raw)).tracks[0]!.clips[0]!;
    if (migrated.kind === "audio") throw new Error("expected a visual clip");
    const byId = Object.fromEntries(migrated.effects.map((e) => [e.id, e]));
    expect(byId.slips).toMatchObject({ splices: true });
    expect(byId.still).toMatchObject({ splices: false });
    expect(byId.keyed).toMatchObject({ splices: true });
    expect(createLayerEffect("filmDamage")).toMatchObject({ splices: false });
  });

  it("carries a v4 single shadow/stroke all the way onto the v54 layer stack", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "old", startMs: 0 });
    doc.tracks[0]!.clips.push(clip);
    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    raw.version = 4;
    const style = (raw.tracks as any)[0].clips[0].style as Record<string, unknown>;
    delete style.effects;
    style.shadow = { color: "#123456", x: 1, y: 2, blur: 3 };
    style.stroke = { color: "#abcdef", width: 5 };

    const migrated = parseDocument(JSON.stringify(raw));
    const text = migrated.tracks.flatMap((t) => t.clips).find((c) => c.kind === "text")!;
    if (text.kind !== "text") throw new Error("expected text clip");
    // v5 put them on the glyph stack; v54 promoted that stack onto the layer.
    const types = text.effects.map((e) => e.type);
    expect(types).toContain("shadow");
    expect(types).toContain("stroke");
    expect(text.effects.find((e) => e.type === "shadow")).toMatchObject({ blur: 3 });
    // A stroke authored with `strokeText` straddled the outline — `center` is
    // the position that keeps the migrated look identical.
    expect(text.effects.find((e) => e.type === "stroke")).toMatchObject({ width: 5, placement: "center" });
    expect("shadow" in text.style).toBe(false);
    expect("effects" in text.style).toBe(false);
  });

  it("v54 hoists the glyph stack onto the layer, keyframes and order included", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: frameIdOf(doc), text: "old", startMs: 0 });
    doc.tracks[0]!.clips.push(clip);
    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    raw.version = 53;
    const rawClip = (raw.tracks as any)[0].clips[0] as Record<string, unknown>;
    // A glyph stack, a layer stack, keyframes on both, and a range override.
    (rawClip.style as Record<string, unknown>).effects = [
      { id: "g1", type: "glow", enabled: true, color: "#ff0000", blur: 30 },
      { id: "g2", type: "stroke", enabled: false, color: "#00ff00", width: 7 },
    ];
    rawClip.effects = [{ id: "lfx1", type: "blur", enabled: true, radius: 5 }];
    const track = (property: string, value: number) => ({
      id: `t-${property}`,
      property,
      keys: [{ id: `k-${property}`, timeMs: 0, value, easing: { kind: "linear" } }],
    });
    rawClip.keyframes = [track("fx.g1.blur", 10), track("fx.gone.blur", 3), track("x", 1)];
    rawClip.ranges = [{ id: "r", start: 0, end: 1, animation: null, style: { effects: [{ id: "r1", type: "glow", enabled: true, color: "#00f", blur: 4 }] } }];

    const text = parseDocument(JSON.stringify(raw)).tracks.flatMap((t) => t.clips).find((c) => c.kind === "text")!;
    if (text.kind !== "text") throw new Error("expected text clip");

    // Promoted cards PREPEND — they used to paint before any layer effect saw
    // the layer, and stack order is pass order.
    expect(text.effects.map((e) => e.id)).toEqual(["g1", "g2", "lfx1"]);
    // The glyph glow was a flat canvas shadow: `solid`, with blur as the spread.
    expect(text.effects[0]).toMatchObject({ type: "glow", mode: "solid", color: "#ff0000", size: 30 });
    expect(text.effects[1]).toMatchObject({ type: "stroke", enabled: false, width: 7, placement: "center" });

    const paths = text.keyframes.map((t) => t.property);
    expect(paths).toContain("lfx.g1.size"); // re-pointed AND renamed
    expect(paths).toContain("x"); // untouched
    expect(paths).not.toContain("fx.gone.blur"); // ghost track dropped
    expect("effects" in text.ranges[0]!.overlay.props).toBe(false);
  });
});

describe("library snapshots", () => {
  it("captures a single clip, rebases time, and reinstantiates with fresh ids", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const clip = createTextClip({ frameId: fid, text: "hi", startMs: 1500, x: 20, y: -30 });
    doc.tracks[0]!.clips.push(clip);

    const snap = captureLibrarySnapshot(doc, [clip.id]);
    expect(snap).not.toBeNull();
    expect(snap!.clips[0]!.startMs).toBe(0); // rebased to the earliest
    expect(snap!.group).toBeNull();

    const { clips, group } = instantiateLibrarySnapshot(snap!, { frameId: "frame-x", startMs: 4000 });
    expect(group).toBeNull();
    expect(clips).toHaveLength(1);
    const made = clips[0]!;
    expect(made.id).not.toBe(clip.id); // fresh id
    expect(made.startMs).toBe(4000); // rebased onto the target time
    if (made.kind !== "audio") {
      expect(made.frameId).toBe("frame-x");
      expect(made.transform.x).toBe(20);
    }
  });

  it("recreates a group when capturing multiple visual clips and preserves relative timing", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const a = createTextClip({ frameId: fid, text: "a", startMs: 2000 });
    const b = createTextClip({ frameId: fid, text: "b", startMs: 2600 });
    doc.tracks[0]!.clips.push(a, b);

    const snap = captureLibrarySnapshot(doc, [a.id, b.id])!;
    expect(snap.group).not.toBeNull();

    const { clips, group, members: memberIds } = instantiateLibrarySnapshot(snap, { frameId: fid, startMs: 500 });
    expect(group).not.toBeNull();
    // The group clip comes back IN the list — a group is a clip, so there is
    // nothing left for a caller to place separately and forget.
    expect(clips[0]!.id).toBe(group!.id);
    const members = clips.filter((c) => c.kind !== "group");
    const starts = members.map((c) => c.startMs).sort((x, y) => x - y);
    expect(starts).toEqual([500, 1100]); // 600ms gap preserved, rebased to 500
    // Placed on lanes, then handed to the group: membership is the row's.
    for (const c of clips) {
      const lane = createTrack("t", fid);
      lane.clips.push(c);
      doc.tracks.push(lane);
    }
    moveClipsToScope(doc, memberIds, group!.id);
    for (const c of members) {
      if (c.kind !== "audio") expect(groupOfClip(doc, c.id)).toBe(group!.id);
    }
    // …and it SPANS them.
    expect(group!.startMs).toBe(500);
    expect(group!.startMs + group!.durationMs).toBe(1100 + members[1]!.durationMs);
  });

  it("clip registry declares per-kind capabilities consistently", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const text = createTextClip({ frameId: fid, text: "hi", startMs: 0 });
    const nested = createNestedClip({ frameId: fid, sourceFrameId: fid, startMs: 0, durationMs: 1000 });

    // Visual = has a frame + transform; nested is visual AND source-backed.
    expect(isVisualClip(text)).toBe(true);
    expect(isVisualClip(nested)).toBe(true);
    expect(CLIP_KINDS.audio.visual).toBe(false);
    expect(CLIP_KINDS.nested.sourceBacked).toBe(true);
    expect(CLIP_KINDS.text.sourceBacked).toBe(false);

    // Playback comes only from source-backed clips.
    expect(clipPlaybackOf(nested)).not.toBeNull();
    expect(clipPlaybackOf(text)).toBeNull();
  });
});

describe("vector engine", () => {
  it("compiles shapes to closed command lists", () => {
    const base = {
      width: 100,
      height: 60,
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      radius: 0,
      pointCount: 5,
      innerRatio: 0.5,
    };
    const rect = shapeCommands({ ...base, shape: "rect" });
    expect(rect[0]).toEqual({ type: "M", x: -50, y: -30 });
    expect(rect[rect.length - 1]!.type).toBe("Z");

    // Rounded corners produce cubics; radii clamp so edges never overlap.
    const rounded = shapeCommands({
      ...base,
      shape: "rect",
      cornerRadius: { tl: 500, tr: 500, br: 0, bl: 0 },
    });
    expect(rounded.some((c) => c.type === "C")).toBe(true);

    const star = shapeCommands({ ...base, shape: "star" });
    expect(star.filter((c) => c.type === "L").length).toBe(9); // 10 verts, first is M

    // Star vertices alternate outer/inner radius.
    const verts = shapeVertices({ ...base, shape: "star" });
    expect(verts).toHaveLength(10);
    expect(Math.hypot(verts[0]!.x, verts[0]!.y)).toBeGreaterThan(Math.hypot(verts[1]!.x, verts[1]!.y));
  });

  it("ellipse arc: full is a plain ellipse, sweep makes a pie, ratio a ring", () => {
    const base = {
      width: 100,
      height: 100,
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      radius: 0,
      pointCount: 3,
      innerRatio: 0.5,
    };
    // Default (full, solid) is byte-identical to the old 4-cubic ellipse.
    const full = shapeCommands({ ...base, shape: "ellipse", arcStartDeg: 0, arcSweepDeg: 360, arcRatio: 0 });
    expect(full[0]).toEqual({ type: "M", x: 0, y: -50 });
    expect(full.filter((c) => c.type === "C")).toHaveLength(4);

    // A 90° sweep with no hole is a pie: an arc that closes through the center.
    const pie = shapeCommands({ ...base, shape: "ellipse", arcStartDeg: 0, arcSweepDeg: 90, arcRatio: 0 });
    expect(pie[0]).toEqual({ type: "M", x: 50, y: 0 }); // start at 3 o'clock
    expect(pie.some((c) => c.type === "L" && c.x === 0 && c.y === 0)).toBe(true); // through center
    expect(pie[pie.length - 1]!.type).toBe("Z");

    // A hole with a partial sweep is a ring segment: two arcs, no center point.
    const ring = shapeCommands({ ...base, shape: "ellipse", arcStartDeg: 0, arcSweepDeg: 180, arcRatio: 0.5 });
    expect(ring.some((c) => c.type === "L" && c.x === 0 && c.y === 0)).toBe(false);
    expect(ring.filter((c) => c.type === "C").length).toBeGreaterThanOrEqual(4);
  });

  it("free corner offsets nudge a shape's vertices while it stays a shape", () => {
    const base = {
      width: 100,
      height: 100,
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      radius: 0,
      pointCount: 3,
      innerRatio: 0.5,
    };
    // Corner basis counts: rect 4, polygon n, star 2n, ellipse none.
    expect(shapeCornerBasis({ ...base, shape: "rect" })).toHaveLength(4);
    expect(shapeCornerBasis({ ...base, shape: "polygon", pointCount: 5 })).toHaveLength(5);
    expect(shapeCornerBasis({ ...base, shape: "star", pointCount: 5 })).toHaveLength(10);
    expect(shapeCornerBasis({ ...base, shape: "ellipse" })).toHaveLength(0);

    // A rect's top-left corner (basis (-50,-50)) nudged by (+10,+5).
    const offsets = [
      { x: 10, y: 5 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    const pts = shapeCornerPoints({ ...base, shape: "rect", cornerOffsets: offsets });
    expect(pts[0]).toEqual({ x: -40, y: -45 });
    expect(pts[2]).toEqual({ x: 50, y: 50 }); // untouched

    // With offsets the rect compiles as a rounded quad through the moved corner.
    const cmds = shapeCommands({ ...base, shape: "rect", cornerOffsets: offsets });
    expect(cmds.some((c) => (c.type === "M" || c.type === "L") && c.x === -40 && c.y === -45)).toBe(true);
    // No offsets → the classic rect path (unchanged), starting at the top-left.
    const plain = shapeCommands({ ...base, shape: "rect", cornerOffsets: null });
    expect(plain[0]).toEqual({ type: "M", x: -50, y: -50 });
  });

  it("corner nudges are keyframable numbers, and the box grows to fit them", () => {
    const clip = createShapeClip({ frameId: frameIdOf(createEmptyDocument()), shape: "rect", startMs: 0, width: 100, height: 100 });

    // corner.<i>.x|y are per-vertex number paths — get/set materialize the array.
    expect(propertyDef("corner.0.x")?.kind).toBe("number");
    setClipProperty(clip, "corner.0.x", 20);
    setClipProperty(clip, "corner.0.y", 12);
    expect(getClipProperty(clip, "corner.0.x")).toBe(20);
    expect(clip.cornerOffsets).toHaveLength(4);

    // Sampled corner keyframes override the base offsets (what makes them animate).
    const eff = effectiveCornerOffsets(clip.cornerOffsets, { "corner.0.x": 50 });
    expect(eff![0]).toEqual({ x: 50, y: 12 });

    // Bounds = the w×h frame grown to include a pushed-out corner.
    const grown = shapeLocalBounds({
      shape: "rect",
      width: 100,
      height: 100,
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      radius: 0,
      pointCount: 3,
      innerRatio: 0.5,
      cornerOffsets: [
        { x: 0, y: -30 }, // top-left pushed up past the frame
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
    });
    expect(grown.minY).toBe(-80); // -50 frame − 30 nudge
    expect(grown.maxX).toBe(50); // frame edge unchanged
  });

  it("grows a mirrored pair out of an anchor, or only the leading side", () => {
    // The default pairing pulls a symmetric pair out of a bare corner — the
    // classic pen place-and-drag.
    const corner = { x: 10, y: 20, hIn: null as Pt | null, hOut: null as Pt | null };
    editPointHandlesFromAnchor(corner, { x: 30, y: 40 });
    expect(corner.hOut).toEqual({ x: 30, y: 40 });
    expect(corner.hIn!.x).toBeCloseTo(-10, 6);
    expect(corner.hIn!.y).toBeCloseTo(0, 6);

    // No pairing (⌥ while drawing) leaves the trailing side exactly as it was,
    // so a fresh point stays a corner on the way in — that is the cusp.
    const cusp = { x: 10, y: 20, hIn: null as Pt | null, hOut: null as Pt | null };
    editPointHandlesFromAnchor(cusp, { x: 30, y: 40 }, false);
    expect(cusp.hOut).toEqual({ x: 30, y: 40 });
    expect(cusp.hIn).toEqual(null);

    // …and it does not disturb a trailing handle that already exists.
    const kept = { x: 10, y: 20, hIn: { x: 5, y: 15 } as Pt | null, hOut: { x: 15, y: 25 } as Pt | null };
    editPointHandlesFromAnchor(kept, { x: 30, y: 40 }, false);
    expect(kept.hIn).toEqual({ x: 5, y: 15 });
  });

  it("keeps BOTH sides tracking for a whole anchor drag, not just the first pixel", () => {
    // The regression: growing the trailing side only "when it is still missing"
    // planted it on move one — a pixel from the anchor, where the pointer still
    // was — and then never touched it again, because it was no longer missing.
    // One handle followed the pointer and a dead nub sat by the anchor.
    const pt = { x: 0, y: 0, hIn: null as Pt | null, hOut: null as Pt | null };
    for (const d of [1, 8, 40, 120]) editPointHandlesFromAnchor(pt, { x: d, y: 0 });
    expect(pt.hOut).toEqual({ x: 120, y: 0 });
    expect(pt.hIn!.x).toBeCloseTo(-120, 6); // tracked all the way, not stuck at -1
  });

  it("writes one handle, or balances the pair, exactly as told", () => {
    const point = { x: 10, y: 20, hIn: { x: 5, y: 15 } as Pt | null, hOut: { x: 15, y: 25 } as Pt | null };

    // Unmirrored: the partner keeps whatever you gave it. The old version always
    // mirrored, forcing hIn to the dragged arm's length — which silently
    // destroyed a lopsided tangent with no way to keep one.
    editPointHandlesFromHandle(point, "hOut", { x: 30, y: 40 });
    expect(point.hOut).toEqual({ x: 30, y: 40 });
    expect(point.hIn).toEqual({ x: 5, y: 15 });

    // Mirrored: the partner is the reflection through the anchor —
    // 2·10−30 = −10, 2·20−40 = 0.
    editPointHandlesFromHandle(point, "hOut", { x: 30, y: 40 }, true);
    expect(point.hIn!.x).toBeCloseTo(-10, 6);
    expect(point.hIn!.y).toBeCloseTo(0, 6);

    // Mirroring conjures the partner on a one-armed node, which is what makes
    // ⌥ useful on a node you already broke.
    const single = { x: 10, y: 20, hIn: null as Pt | null, hOut: { x: 15, y: 25 } as Pt | null };
    editPointHandlesFromHandle(single, "hOut", { x: 30, y: 40 });
    expect(single.hIn).toEqual(null);
    editPointHandlesFromHandle(single, "hOut", { x: 30, y: 40 }, true);
    expect(single.hIn!.x).toBeCloseTo(-10, 6);
  });

  it("autoSmoothHandles makes mirrored Catmull-Rom handles scaled to neighbor spacing", () => {
    // Symmetric neighbors → mirrored handles along the horizontal chord.
    const near = autoSmoothHandles({ x: 0, y: 0 }, { x: -30, y: 0 }, { x: 30, y: 0 });
    expect(near.hOut).toEqual({ x: 10, y: 0 }); // (next - prev)/6 = 60/6 = 10
    expect(near.hIn).toEqual({ x: -10, y: 0 }); // mirror
    // Same shape scaled up 10× → handles scale 10× (proportional, NOT clamped).
    const far = autoSmoothHandles({ x: 0, y: 0 }, { x: -300, y: 0 }, { x: 300, y: 0 });
    expect(far.hOut).toEqual({ x: 100, y: 0 });
    expect(far.hIn).toEqual({ x: -100, y: 0 });
    // Open endpoint (head: prev null) → a gentle handle a third toward `next`.
    const head = autoSmoothHandles({ x: 0, y: 0 }, null, { x: 30, y: 0 });
    expect(head.hOut).toEqual({ x: 10, y: 0 });
    expect(head.hIn).toEqual({ x: -10, y: 0 });
    // Tail (next null) points its incoming handle toward `prev`.
    const tail = autoSmoothHandles({ x: 0, y: 0 }, { x: -30, y: 0 }, null);
    expect(tail.hIn).toEqual({ x: -10, y: 0 });
    expect(tail.hOut).toEqual({ x: 10, y: 0 });
  });

  it("nodeSnapLines + mergeSnapCandidates make anchors first-class snap targets", () => {
    const nodes = nodeSnapLines([{ x: 100, y: 40 }]);
    expect(nodes.v).toEqual([{ pos: 100, lo: 40, hi: 40, kind: "node" }]);
    expect(nodes.h).toEqual([{ pos: 40, lo: 100, hi: 100, kind: "node" }]);
    // A moving point near that node snaps onto it on BOTH axes at once.
    const r = snapPoint(103, 37, nodes, 8);
    expect(r.x).toBe(100);
    expect(r.y).toBe(40);
    const merged = mergeSnapCandidates({ v: [], h: [] }, nodes);
    expect(merged.v).toHaveLength(1);
    expect(merged.h).toHaveLength(1);
  });

  it("knifeSubpaths slices every path the line crosses", () => {
    // A closed 100×100 square centered at origin, sliced by a vertical line at x=0.
    const square = [
      {
        closed: true,
        points: [
          { x: -50, y: -50, hIn: null, hOut: null },
          { x: 50, y: -50, hIn: null, hOut: null },
          { x: 50, y: 50, hIn: null, hOut: null },
          { x: -50, y: 50, hIn: null, hOut: null },
        ],
      },
    ];
    const r = knifeSubpaths(square, { x: 0, y: -80 }, { x: 0, y: 80 });
    expect(r.cuts).toBe(2); // top edge + bottom edge
    expect(r.subs.every((s) => !s.closed)).toBe(true); // the closed run opened
    // An open horizontal line cut once in the middle → two open pieces.
    const line = [
      { closed: false, points: [{ x: -50, y: 0, hIn: null, hOut: null }, { x: 50, y: 0, hIn: null, hOut: null }] },
    ];
    const r2 = knifeSubpaths(line, { x: 0, y: -20 }, { x: 0, y: 20 });
    expect(r2.cuts).toBe(1);
    expect(r2.subs).toHaveLength(2);
    // A knife that misses leaves the path untouched.
    const r3 = knifeSubpaths(line, { x: 200, y: -20 }, { x: 200, y: 20 });
    expect(r3.cuts).toBe(0);
    expect(r3.subs).toHaveLength(1);
  });

  it("openEndpoints finds head/tail of open runs and skips closed ones", () => {
    const ends = openEndpoints([
      { closed: false, points: [{ x: 0, y: 0, hIn: null, hOut: null }, { x: 10, y: 0, hIn: null, hOut: null }] },
      { closed: true, points: [{ x: 0, y: 0, hIn: null, hOut: null }, { x: 10, y: 0, hIn: null, hOut: null }] },
    ]);
    expect(ends.map((e) => [e.sub, e.index, e.end])).toEqual([
      [0, 0, "head"],
      [0, 1, "tail"],
    ]);
  });

  it("node ops: reverse swaps handles, convert/reset, close, average, align", () => {
    const P = (x: number, y: number, hIn: any = null, hOut: any = null) => ({ x, y, hIn, hOut });
    // reverse: order flips and hIn/hOut swap.
    const rev = [{ closed: false, points: [P(0, 0, null, { x: 1, y: 0 }), P(10, 0, { x: 9, y: 0 }, null)] }];
    reverseSubpaths(rev);
    expect(rev[0]!.points.map((p) => p.x)).toEqual([10, 0]);
    expect(rev[0]!.points[0]!.hOut).toEqual({ x: 9, y: 0 }); // was hIn, now hOut

    // convert to smooth then reset to corner.
    const sm = [{ closed: false, points: [P(-30, 0), P(0, 0), P(30, 0)] }];
    convertNodes(sm, [{ sub: 0, index: 1 }], "smooth");
    expect(sm[0]!.points[1]!.hOut).toEqual({ x: 10, y: 0 });
    convertNodes(sm, [{ sub: 0, index: 1 }], "corner");
    expect(sm[0]!.points[1]!.hIn).toBeNull();

    // close.
    const op = [{ closed: false, points: [P(0, 0), P(10, 0), P(10, 10)] }];
    setNodesClosed(op, [{ sub: 0, index: 0 }], true);
    expect(op[0]!.closed).toBe(true);

    // average both → centroid; handles ride along.
    const av = [{ closed: false, points: [P(0, 0, null, { x: 2, y: 0 }), P(10, 10)] }];
    averageNodes(av, [{ sub: 0, index: 0 }, { sub: 0, index: 1 }]);
    expect(av[0]!.points[0]!).toMatchObject({ x: 5, y: 5 });
    expect(av[0]!.points[0]!.hOut).toEqual({ x: 7, y: 5 }); // moved by +5,+5

    // align left.
    const al = [{ closed: false, points: [P(0, 0), P(10, 0), P(4, 8)] }];
    alignNodes(al, [{ sub: 0, index: 0 }, { sub: 0, index: 1 }, { sub: 0, index: 2 }], "left");
    expect(al[0]!.points.map((p) => p.x)).toEqual([0, 0, 0]);
  });

  it("node ops: mirrorHandles symmetric; break/deleteSegment/join restructure; simplify thins", () => {
    const P = (x: number, y: number, hIn: any = null, hOut: any = null) => ({ x, y, hIn, hOut });
    // mirror: unequal handles become collinear + equal length (avg = 15).
    const mh = [{ closed: false, points: [P(0, 0, { x: -10, y: 0 }, { x: 20, y: 0 })] }];
    mirrorHandles(mh, [{ sub: 0, index: 0 }]);
    expect(mh[0]!.points[0]!.hOut).toEqual({ x: 15, y: 0 });
    expect(mh[0]!.points[0]!.hIn).toEqual({ x: -15, y: 0 });

    // break a closed run at a node → open, starts+ends at that node.
    const br = [{ closed: true, points: [P(0, 0), P(10, 0), P(10, 10), P(0, 10)] }];
    breakAtNode(br, { sub: 0, index: 1 });
    expect(br[0]!.closed).toBe(false);
    expect(br[0]!.points.length).toBe(5);
    expect(br[0]!.points[0]!).toMatchObject({ x: 10, y: 0 });
    expect(br[0]!.points[4]!).toMatchObject({ x: 10, y: 0 });

    // break an OPEN run's interior node → two subpaths.
    const br2 = [{ closed: false, points: [P(0, 0), P(10, 0), P(20, 0)] }];
    breakAtNode(br2, { sub: 0, index: 1 });
    expect(br2.length).toBe(2);
    expect(br2[0]!.points.map((p) => p.x)).toEqual([0, 10]);
    expect(br2[1]!.points.map((p) => p.x)).toEqual([10, 20]);

    // deleteSegment between adjacent nodes of an open run → split.
    const ds = [{ closed: false, points: [P(0, 0), P(10, 0), P(20, 0), P(30, 0)] }];
    expect(deleteSegment(ds, [{ sub: 0, index: 1 }, { sub: 0, index: 2 }])).toBe(true);
    expect(ds.length).toBe(2);
    expect(ds[0]!.points.map((p) => p.x)).toEqual([0, 10]);
    expect(ds[1]!.points.map((p) => p.x)).toEqual([20, 30]);

    // join two different open subpaths at coincident endpoints.
    const jn = [
      { closed: false, points: [P(0, 0), P(10, 0)] },
      { closed: false, points: [P(10, 0), P(20, 0)] },
    ];
    expect(joinEndpoints(jn, { sub: 0, index: 1 }, { sub: 1, index: 0 })).toBe(true);
    expect(jn.length).toBe(1);
    expect(jn[0]!.points.map((p) => p.x)).toEqual([0, 10, 20]);

    // join two ends of the SAME subpath → close.
    const jc = [{ closed: false, points: [P(0, 0), P(10, 0), P(10, 10)] }];
    expect(joinEndpoints(jc, { sub: 0, index: 0 }, { sub: 0, index: 2 })).toBe(true);
    expect(jc[0]!.closed).toBe(true);

    // simplify: a nearly-straight run of many points collapses to its ends.
    const line = { closed: false, points: [P(0, 0), P(1, 0.1), P(2, 0), P(3, 0.1), P(4, 0)] };
    const simp = simplifySubpaths([line], 1);
    expect(simp[0]!.points.length).toBe(2);
  });

  it("parses SVG path data incl. relative, curves, arcs and close", () => {
    // A triangle with an implicit repeat and relative moves.
    const tri = parseSvgPathData("M 0 0 l 10 0 0 10 Z");
    expect(tri).toHaveLength(1);
    expect(tri[0]!.closed).toBe(true);
    expect(tri[0]!.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);

    // Cubic handles land on the right anchors.
    const curve = parseSvgPathData("M0 0 C 10 0 20 10 30 10");
    expect(curve[0]!.points[0]!.hOut).toEqual({ x: 10, y: 0 });
    expect(curve[0]!.points[1]!.hIn).toEqual({ x: 20, y: 10 });

    // Arcs flatten to cubic segments that end at the arc's endpoint.
    const arc = parseSvgPathData("M0 0 A 10 10 0 0 1 20 0");
    const last = arc[0]!.points[arc[0]!.points.length - 1]!;
    expect(last.x).toBeCloseTo(20, 3);
    expect(last.y).toBeCloseTo(0, 3);

    // Q → exact cubic elevation.
    const quad = parseSvgPathData("M0 0 Q 15 30 30 0");
    expect(quad[0]!.points[0]!.hOut!.x).toBeCloseTo(10, 5);
    expect(quad[0]!.points[0]!.hOut!.y).toBeCloseTo(20, 5);
  });

  it("keyframe paths address vector geometry and per-id paint", () => {
    const doc = createEmptyDocument();
    const shape = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0 });
    const fillId = shape.fills[0]!.id;
    setClipProperty(shape, "radius.tl", 24);
    setClipProperty(shape, `fill.${fillId}`, "#123456");
    setClipProperty(shape, `fill.${fillId}.opacity`, 0.4);
    setClipProperty(shape, "width", 320);
    expect(shape.cornerRadius.tl).toBe(24);
    expect(getClipProperty(shape, "radius.tl")).toBe(24);
    expect(shape.fills[0]).toMatchObject({ type: "solid", color: "#123456", opacity: 0.4 });
    expect(getClipProperty(shape, `fill.${fillId}`)).toBe("#123456");
    expect(getClipProperty(shape, `fill.${fillId}.opacity`)).toBe(0.4);
    expect(shape.width).toBe(320);
    // A bare `fill.<id>` on a solid fill is a color; its def interpolates as color.
    expect(propertyDef(`fill.${fillId}`)?.kind).toBe("color");
    expect(propertyDef(`fill.${fillId}.opacity`)?.kind).toBe("number");
  });

  it("addresses gradient paints per stop and blends new-stop colors in the ramp", () => {
    const doc = createEmptyDocument();
    const shape = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0 });
    const fillId = shape.fills[0]!.id;
    // Swap the default solid fill for a gradient carrying the same entry id.
    shape.fills[0] = {
      id: fillId,
      type: "linear",
      enabled: true,
      opacity: 1,
      blendMode: "normal",
      start: { x: 0, y: 0.5 },
      end: { x: 1, y: 0.5 },
      stops: [
        { id: "a", offset: 0, color: "#000000" },
        { id: "b", offset: 1, color: "#ffffff" },
      ],
    };
    setClipProperty(shape, `fill.${fillId}.end.y`, 1);
    setClipProperty(shape, `fill.${fillId}.stop.b.offset`, 0.5);
    setClipProperty(shape, `fill.${fillId}.stop.a.color`, "#ff0000");
    expect(getClipProperty(shape, `fill.${fillId}.end.y`)).toBe(1);
    expect(getClipProperty(shape, `fill.${fillId}.stop.b.offset`)).toBe(0.5);
    expect(getClipProperty(shape, `fill.${fillId}.stop.a.color`)).toBe("#ff0000");
    // Solid path doesn't apply to gradients (and vice versa) — keys survive type switches.
    expect(getClipProperty(shape, `fill.${fillId}`)).toBeUndefined();
    // A stop added mid-ramp samples the ramp, not a default.
    expect(gradientColorAt([
      { id: "a", offset: 0, color: "#000000" },
      { id: "b", offset: 1, color: "#ffffff" },
    ], 0.5)).toBe("#808080");
    // Dynamic defs exist for gradient sub-paths (id segment and all).
    expect(propertyDef(`fill.${fillId}.stop.a.color`)?.kind).toBe("color");
    expect(propertyDef("stroke.anyid.end.x")?.kind).toBe("number");
  });

  it("addresses per-id stroke scalars and stroke gradient stops", () => {
    const doc = createEmptyDocument();
    const shape = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0 });
    shape.strokes = [
      strokeStyle(
        {
          id: "sp",
          type: "linear",
          enabled: true,
          opacity: 1,
          blendMode: "normal",
          start: { x: 0, y: 0.5 },
          end: { x: 1, y: 0.5 },
          stops: [
            { id: "s0", offset: 0, color: "#000000" },
            { id: "s1", offset: 1, color: "#ffffff" },
          ],
        },
        { width: 3 },
      ),
    ];
    const sid = shape.strokes[0]!.id;
    setClipProperty(shape, `stroke.${sid}.width`, 8);
    setClipProperty(shape, `stroke.${sid}.opacity`, 0.5);
    setClipProperty(shape, `stroke.${sid}.stop.s1.color`, "#ff0000");
    expect(getClipProperty(shape, `stroke.${sid}.width`)).toBe(8);
    expect(getClipProperty(shape, `stroke.${sid}.opacity`)).toBe(0.5);
    expect(getClipProperty(shape, `stroke.${sid}.stop.s1.color`)).toBe("#ff0000");
    expect(shape.strokes[0]!.paint.type === "linear" && shape.strokes[0]!.paint.stops[1]!.color).toBe("#ff0000");
    expect(propertyDef(`stroke.${sid}.width`)?.kind).toBe("number");
  });

  it("migrates a v24 single fill/stroke into per-id lists and re-addresses its keys", () => {
    const doc = createEmptyDocument();
    doc.version = 24;
    const shape = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0 });
    // Hand-roll the pre-v25 single-fill/stroke shape with legacy keyframe paths.
    const legacy = {
      ...shape,
      fill: { type: "solid", color: "#112233" },
      stroke: { paint: { type: "solid", color: "#445566" }, width: 4, align: "center", cap: "butt", join: "miter", dash: [] },
      keyframes: [
        { id: "t1", property: "fill", range: null, keys: [{ id: "k1", timeMs: 0, value: "#112233", easing: { kind: "linear" } }] },
        { id: "t2", property: "stroke.width", range: null, keys: [{ id: "k2", timeMs: 0, value: 4, easing: { kind: "linear" } }] },
      ],
    } as unknown as Record<string, unknown>;
    delete legacy.fills;
    delete legacy.strokes;
    delete legacy.blendMode;
    const track = doc.tracks[0]!;
    (track.clips as unknown[]).push(legacy);

    const migrated = parseDocument(serializeDocument(doc as unknown as MotionDocument));
    expect(migrated.version).toBe(DOCUMENT_VERSION);
    const s = migrated.tracks[0]!.clips.find((c) => c.id === shape.id);
    if (!s || (s.kind !== "shape" && s.kind !== "path")) throw new Error("shape lost in migration");
    expect(s.fills).toHaveLength(1);
    expect(s.fills[0]).toMatchObject({ type: "solid", color: "#112233", opacity: 1, blendMode: "normal" });
    expect(s.strokes).toHaveLength(1);
    expect(s.strokes[0]).toMatchObject({ width: 4, opacity: 1, blendMode: "normal" });
    // Keyframe tracks re-addressed under the new entry ids — animations survive.
    const fillId = s.fills[0]!.id;
    const strokeId = s.strokes[0]!.id;
    expect(s.keyframes.some((t) => t.property === `fill.${fillId}`)).toBe(true);
    expect(s.keyframes.some((t) => t.property === `stroke.${strokeId}.width`)).toBe(true);
  });

  it("collects and remaps every color across a selection subtree (recursing into nested comps)", () => {
    const doc = createEmptyDocument();
    const rootFrame = frameIdOf(doc);
    // A nested source frame with a red-filled rect.
    const srcFrame = "frame_src_colors";
    doc.frames.push({ ...doc.frames[0]!, id: srcFrame, name: "Src", pageId: doc.frames[0]!.pageId });
    const inner = createShapeClip({ frameId: srcFrame, shape: "rect", startMs: 0, fill: "#ff0000" });
    // A top-level rect (also red) that nests the source frame.
    const outer = createShapeClip({ frameId: rootFrame, shape: "rect", startMs: 0, fill: "#ff0000" });
    const nested = createNestedClip({ frameId: rootFrame, sourceFrameId: srcFrame, startMs: 0 });
    doc.tracks[0]!.clips.push(inner, outer, nested);

    const colors = collectSubtreeColors(doc, [outer.id, nested.id]);
    const red = colors.find((c) => c.value === "#ff0000");
    // outer's fill + inner's fill (reached through the nested clip) both counted.
    expect(red?.count).toBe(2);

    remapSubtreeColors(doc, [outer.id, nested.id], "#ff0000", "#00ff00");
    expect(outer.fills[0]!.type === "solid" && outer.fills[0]!.color).toBe("#00ff00");
    expect(inner.fills[0]!.type === "solid" && inner.fills[0]!.color).toBe("#00ff00");
  });

  it("trims paths by arc length — start/end window, wrap via offset", () => {
    // A 100-long horizontal line.
    const line: PathCommand[] = [
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 100, y: 0 },
    ];
    // Middle half.
    const mid = trimCommands(line, 0.25, 0.75);
    expect(mid[0]).toEqual({ type: "M", x: 25, y: 0 });
    expect(mid[1]).toEqual({ type: "L", x: 75, y: 0 });
    // Identity returns the input unchanged.
    expect(trimCommands(line, 0, 1)).toBe(line);
    // Empty window.
    expect(trimCommands(line, 0.5, 0.5)).toEqual([]);

    // A closed 100×100 square (perimeter 400): a wrapped window across the
    // seam yields two runs whose total length is half the perimeter.
    const square: PathCommand[] = [
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 100, y: 0 },
      { type: "L", x: 100, y: 100 },
      { type: "L", x: 0, y: 100 },
      { type: "Z" },
    ];
    const wrapped = trimCommands(square, 0, 0.5, 0.875); // window [0.875, 1.375]
    const moves = wrapped.filter((c) => c.type === "M").length;
    expect(moves).toBe(2);

    // Trimming half of the square keeps exactly two full edges' length.
    const half = trimCommands(square, 0, 0.5);
    expect(half[0]).toEqual({ type: "M", x: 0, y: 0 });
    expect(half.at(-1)).toEqual({ type: "L", x: 100, y: 100 });

    // Trim is addressed PER STROKE — two strokes on one shape hold two windows.
    const doc = createEmptyDocument();
    const shape = createShapeClip({ frameId: frameIdOf(doc), shape: "ellipse", startMs: 0 });
    shape.strokes = [strokeStyle(solidPaint("#fff")), strokeStyle(solidPaint("#000"))];
    const [a, b] = shape.strokes as [StrokeStyle, StrokeStyle];
    setClipProperty(shape, `stroke.${a.id}.trim.end`, 0.4);
    setClipProperty(shape, `stroke.${b.id}.trim.start`, 0.6);
    expect(getClipProperty(shape, `stroke.${a.id}.trim.end`)).toBe(0.4);
    expect(getClipProperty(shape, `stroke.${b.id}.trim.start`)).toBe(0.6);
    expect(a.trim.start).toBe(0);
    expect(b.trim.end).toBe(1);
  });

  it("morphs path geometry point-to-point between keys", () => {
    const geoA: Contour[] = [
      { closed: false, points: [
        { x: 0, y: 0, hIn: null, hOut: null },
        { x: 100, y: 0, hIn: null, hOut: null },
      ] },
    ];
    const geoB: Contour[] = [
      { closed: false, points: [
        { x: 0, y: 100, hIn: null, hOut: { x: 50, y: 100 } },
        { x: 100, y: 100, hIn: null, hOut: null },
      ] },
    ];
    // Direct lerp: coordinates blend; the one-sided handle grows out of its anchor.
    const mid = lerpSubpaths(geoA, geoB, 0.5)!;
    expect(mid[0]!.points[0]!.y).toBe(50);
    expect(mid[0]!.points[0]!.hOut).toEqual({ x: 25, y: 50 });
    // Structure mismatch → null (sampler holds).
    expect(lerpSubpaths(geoA, [{ closed: false, points: geoB[0]!.points.slice(0, 1) }], 0.5)).toBeNull();

    // Through the keyframe engine: geometry keys sample as morphed subpaths.
    const track: KeyframeTrack = {
      id: "t",
      property: "geometry",
      range: null,
      keys: [
        { id: "k1", timeMs: 0, value: geoA, easing: { kind: "linear" } },
        { id: "k2", timeMs: 1000, value: geoB, easing: { kind: "linear" } },
      ],
    };
    const sampledMid = sampleKeyframeTrack(track, 500);
    expect(Array.isArray(sampledMid)).toBe(true);
    expect((sampledMid as Subpath[])[0]!.points[1]!.y).toBe(50);

    // Convert-to-path produces editable geometry that round-trips the outline.
    const doc = createEmptyDocument();
    const rect = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0, width: 100, height: 50 });
    doc.tracks[0]!.clips.push(rect);
    expect(convertShapeClipToPath(doc, rect.id)).toBe(true);
    const converted = locateClip(doc, rect.id)!.clip;
    expect(converted.kind).toBe("path");
    if (converted.kind === "path") {
      expect(converted.subpaths[0]!.closed).toBe(true);
      expect(converted.subpaths[0]!.points.length).toBe(4);
    }
  });
});

describe("clip linking + waveform clips", () => {
  it("links, expands selection, unlinks, and merges groups", () => {
    const doc = createEmptyDocument();
    const frameId = frameIdOf(doc);
    const a = createAudioClip({ frameId, startMs: 0, durationMs: 4000 });
    const b = createTextClip({ frameId, text: "x", startMs: 0 });
    const c = createTextClip({ frameId, text: "y", startMs: 5000 });
    doc.tracks[0]!.clips.push(a, b, c);

    const group = linkClips(doc, [a.id, b.id]);
    expect(group).toBeTruthy();
    expect(a.linkGroupId).toBe(group);
    expect(b.linkGroupId).toBe(group);
    // Selecting one linked clip pulls in its partners; unlinked clips don't expand.
    expect(expandLinkedSelection(doc, [a.id]).sort()).toEqual([a.id, b.id].sort());
    expect(expandLinkedSelection(doc, [c.id])).toEqual([c.id]);

    // Linking c into the existing group merges (one group, three members).
    linkClips(doc, [c.id, a.id]);
    expect(c.linkGroupId).toBe(group);
    expect(expandLinkedSelection(doc, [b.id]).length).toBe(3);

    // Unlink one — the other two stay linked.
    unlinkClips(doc, [c.id]);
    expect(c.linkGroupId).toBeNull();
    expect(expandLinkedSelection(doc, [a.id]).length).toBe(2);
  });

  it("remaps link groups + waveform targets on copy batches", () => {
    const doc = createEmptyDocument();
    const frameId = frameIdOf(doc);
    const audio = createAudioClip({ frameId, startMs: 0, durationMs: 3000 });
    const wave = createWaveformClip({
      frameId,
      targetClipId: audio.id,
      startMs: 0,
      durationMs: 3000,
    });
    doc.tracks[0]!.clips.push(audio, wave);
    const group = linkClips(doc, [audio.id, wave.id])!;

    // Copy BOTH: fresh shared group, waveform retargets to the copied audio.
    const audioCopy = reissueClipIds(audio);
    const waveCopy = reissueClipIds(wave);
    const idMap = new Map([
      [audio.id, audioCopy.id],
      [wave.id, waveCopy.id],
    ]);
    remapClipRefsAfterCopy(doc, [audioCopy, waveCopy], idMap);
    expect(audioCopy.linkGroupId).toBeTruthy();
    expect(audioCopy.linkGroupId).not.toBe(group);
    expect(waveCopy.linkGroupId).toBe(audioCopy.linkGroupId);
    if (waveCopy.kind === "waveform") expect(waveCopy.targetClipId).toBe(audioCopy.id);

    // Copy ONE member alone: it unlinks (its partner wasn't copied) but keeps
    // pointing at the ORIGINAL audio, so it still visualizes something.
    const lone = reissueClipIds(wave);
    remapClipRefsAfterCopy(doc, [lone], new Map([[wave.id, lone.id]]));
    expect(lone.linkGroupId).toBeNull();
    if (lone.kind === "waveform") expect(lone.targetClipId).toBe(audio.id);
  });

  it("waveform clips are visual, procedural, and survive io round-trips", () => {
    const doc = createEmptyDocument();
    const frameId = frameIdOf(doc);
    const audio = createAudioClip({ frameId, startMs: 1000, durationMs: 4000 });
    const wave = createWaveformClip({
      frameId,
      targetClipId: audio.id,
      startMs: 1000,
      durationMs: 4000,
      style: { template: "circular", color: "#00ffcc", glow: 24 },
    });
    doc.tracks[0]!.clips.push(audio, wave);
    linkClips(doc, [audio.id, wave.id]);

    expect(isVisualClip(wave)).toBe(true);
    expect(CLIP_KINDS.waveform.sourceBacked).toBe(false);
    // Spectrum (fixed EQ) is the default read mode; decay ships schema-defaulted.
    expect(wave.style.mode).toBe("spectrum");
    expect(wave.style.decay).toBeCloseTo(0.55);

    // Split at 3000: both halves keep the style + target; the right half is
    // pure doc-time (procedural), so no in-point bookkeeping exists to drift.
    const rightId = splitClip(doc, wave.id, 3000);
    expect(rightId).toBeTruthy();
    const right = locateClip(doc, rightId!)!.clip;
    expect(right.kind).toBe("waveform");
    if (right.kind === "waveform") {
      expect(right.targetClipId).toBe(audio.id);
      expect(right.startMs).toBe(3000);
      expect(right.style.template).toBe("circular");
    }

    // io round-trip: v19 parses back byte-identical semantics.
    const parsed = parseDocument(serializeDocument(doc));
    const reWave = locateClip(parsed, wave.id)!.clip;
    if (reWave.kind === "waveform") {
      expect(reWave.style.glow).toBe(24);
      expect(reWave.linkGroupId).toBe(locateClip(parsed, audio.id)!.clip.linkGroupId);
    }
  });
});

describe("head edits are one seam for every clip kind", () => {
  it("trim-start consumes the source head of ANY source-backed clip, restores it, and re-bases keyframes", () => {
    const doc = createEmptyDocument();
    const frameId = frameIdOf(doc);
    const video = createVideoClip({ frameId, assetId: "a1", startMs: 1000, durationMs: 4000 });
    video.playback.speed = 2;
    video.keyframes.push({
      id: "t",
      property: "opacity",
      range: null,
      keys: [{ id: "k", timeMs: 1000, value: 1, easing: { kind: "linear" } }],
    });
    doc.tracks[0]!.clips.push(video);

    // Consume 500 wall ms: in-point advances speed-aware, the keyframe stays
    // glued to its CONTENT (shifts to local 500) — nothing drifts.
    trimClip(doc, video.id, "start", 1500);
    expect(video.startMs).toBe(1500);
    expect(video.trimInMs).toBe(1000); // 500 wall × speed 2
    expect(video.keyframes[0]!.keys[0]!.timeMs).toBe(500);

    // Extend back out: the head restores exactly, clamped at source 0 — the
    // clip can never reveal media that doesn't exist.
    trimClip(doc, video.id, "start", 0);
    expect(video.startMs).toBe(1000);
    expect(video.trimInMs).toBe(0);
    expect(video.keyframes[0]!.keys[0]!.timeMs).toBe(1000);

    // Same seam, no per-kind code: asset audio and nested comps.
    const audio = createAssetAudioClip({ frameId, assetId: "a2", startMs: 6000, durationMs: 3000 });
    const nested = createNestedClip({ frameId, sourceFrameId: "other", startMs: 10000, durationMs: 2000 });
    doc.tracks[0]!.clips.push(audio, nested);
    trimClip(doc, audio.id, "start", 7000);
    expect(audio.trimInMs).toBe(1000);
    trimClip(doc, nested.id, "start", 10500);
    expect(nested.trimInMs).toBe(500);
  });

  it("splitting a linked audio+waveform pair keeps both sides coherent", () => {
    const doc = createEmptyDocument();
    const frameId = frameIdOf(doc);
    const audio = createAssetAudioClip({ frameId, assetId: "a1", startMs: 0, durationMs: 4000 });
    const wave = createWaveformClip({ frameId, targetClipId: audio.id, startMs: 0, durationMs: 4000 });
    doc.tracks[0]!.clips.push(audio);
    doc.tracks.push(createTrack());
    doc.tracks[1]!.clips.push(wave);
    linkClips(doc, [audio.id, wave.id]);
    const leftGroup = audio.linkGroupId!;

    // The splitAtPlayhead contract: split the batch, then remap the rights.
    const rightAudioId = splitClip(doc, audio.id, 2500)!;
    const rightWaveId = splitClip(doc, wave.id, 2500)!;
    const rights = [locateClip(doc, rightAudioId)!.clip, locateClip(doc, rightWaveId)!.clip];
    remapClipRefsAfterCopy(
      doc,
      rights,
      new Map([
        [audio.id, rightAudioId],
        [wave.id, rightWaveId],
      ]),
    );

    // Right waveform follows the split-off audio half — no reset to the start.
    const rightWave = rights[1]!;
    if (rightWave.kind === "waveform") expect(rightWave.targetClipId).toBe(rightAudioId);
    // Left pair stays a group; right pair forms its OWN group — never 4 chained.
    expect(wave.linkGroupId).toBe(leftGroup);
    expect(rights[0]!.linkGroupId).toBe(rights[1]!.linkGroupId);
    expect(rights[0]!.linkGroupId).not.toBe(leftGroup);
    // And the audio itself continues (in-point advanced), locked elsewhere too.
    if (rights[0]!.kind === "audio") expect(rights[0]!.trimInMs).toBe(2500);
  });
});

describe("components", () => {
  it("makeComponent flags a source frame and turns the selection into an instance", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const clip = createTextClip({ frameId: fid, text: "logo", startMs: 0, durationMs: 2000 });
    doc.tracks[0]!.clips.push(clip);

    const res = makeComponent(doc, [clip.id]);
    expect(res).not.toBeNull();
    const compFrame = doc.frames.find((f) => f.id === res!.frameId)!;
    expect(isComponentFrame(compFrame)).toBe(true);
    const inst = locateClip(doc, res!.clipId)!.clip;
    expect(inst.kind).toBe("nested");
    expect(isInstanceClip(doc, inst)).toBe(true);
    expect(componentFrames(doc)).toHaveLength(1);
  });

  it("a copied nested clip SHARES its source; detach clones it private", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const clip = createTextClip({ frameId: fid, text: "logo", startMs: 0, durationMs: 2000 });
    doc.tracks[0]!.clips.push(clip);
    const { frameId, clipId } = makeComponent(doc, [clip.id])!;

    // A plain copy references the SAME source frame — no frame duplication.
    const before = doc.frames.length;
    const copy = reissueClipIds(locateClip(doc, clipId)!.clip);
    doc.tracks[0]!.clips.push(copy);
    expect(doc.frames.length).toBe(before);
    expect(copy.kind === "nested" && copy.sourceFrameId).toBe(frameId);

    // Detach → its source becomes a fresh PRIVATE clone (explicit divergence).
    detachInstance(doc, copy.id);
    const detached = locateClip(doc, copy.id)!.clip;
    expect(doc.frames.length).toBe(before + 1);
    expect(detached.kind === "nested" && detached.sourceFrameId).not.toBe(frameId);
    expect(isInstanceClip(doc, detached)).toBe(false);
  });

  it("makeComponent moves the master OFF the working page but leaves an in-place instance", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const workingPage = doc.frames.find((f) => f.id === fid)!.pageId;
    const clip = createTextClip({ frameId: fid, text: "logo", startMs: 0, durationMs: 2000 });
    doc.tracks[0]!.clips.push(clip);

    const { frameId: masterId, clipId } = makeComponent(doc, [clip.id])!;
    const master = doc.frames.find((f) => f.id === masterId)!;
    // Master is a component and NOT on the working page (so it can't collide
    // with its instances) — the instance stays where the content was.
    expect(isComponentFrame(master)).toBe(true);
    expect(master.pageId).not.toBe(workingPage);
    const inst = locateClip(doc, clipId)!.clip;
    expect(inst.frameId).toBe(fid);
    expect(isInstanceClip(doc, inst)).toBe(true);
  });

  it("makeComponentFromFrame promotes the frame IN PLACE — no extra frames, no wrapping", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const R = doc.frames.find((f) => f.id === fid)!;
    const page = R.pageId;
    doc.tracks[0]!.clips.push(
      createTextClip({ frameId: fid, text: "a", startMs: 0, durationMs: 1000 }),
      createTextClip({ frameId: fid, text: "b", startMs: 1000, durationMs: 1000 }),
    );
    const framesBefore = doc.frames.length;

    const resId = makeComponentFromFrame(doc, fid);
    expect(resId).toBe(fid);
    // The frame itself becomes the component; nothing is cloned, moved or wrapped.
    const stillR = doc.frames.find((f) => f.id === fid)!;
    expect(isComponentFrame(stillR)).toBe(true);
    expect(stillR.pageId).toBe(page);
    expect(doc.frames.length).toBe(framesBefore); // no extra nested frame
    // Its own content is untouched (no instance wrapping).
    expect(doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === fid)).toHaveLength(2);
    expect(componentSetId(stillR)).toBe(fid);
    // Idempotent: already a component → returns itself, still one frame.
    expect(makeComponentFromFrame(doc, fid)).toBe(fid);
    expect(doc.frames.length).toBe(framesBefore);
  });

  it("duplicateFrame on a component makes a LINKED instance frame (no cloned content)", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    doc.tracks[0]!.clips.push(createTextClip({ frameId: fid, text: "logo", startMs: 0, durationMs: 2000 }));
    // A plain frame still deep-clones (independent) — the pre-component baseline.
    const plainDup = duplicateFrame(doc, fid)!;
    expect(doc.frames.find((f) => f.id === plainDup)!.instanceOf).toBeNull();
    expect(doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === plainDup)).toHaveLength(1);

    makeComponentFromFrame(doc, fid); // fid is now a component master
    const clipsBefore = doc.tracks.flatMap((t) => t.clips).length;

    const dupId = duplicateFrame(doc, fid)!;
    const dup = doc.frames.find((f) => f.id === dupId)!;
    // Linked instance: points at the master, is not itself a component, clones nothing.
    expect(dup.instanceOf).toBe(fid);
    expect(isComponentFrame(dup)).toBe(false);
    expect(doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === dupId)).toHaveLength(0);
    expect(doc.tracks.flatMap((t) => t.clips).length).toBe(clipsBefore);
    // Duplicating an INSTANCE links to the SAME master (not the instance).
    const dup2 = duplicateFrame(doc, dupId)!;
    expect(doc.frames.find((f) => f.id === dup2)!.instanceOf).toBe(fid);
  });

  it("variant lifecycle: add, switch a linked frame, detach frame, delete variant", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    doc.tracks[0]!.clips.push(createTextClip({ frameId: fid, text: "A", startMs: 0, durationMs: 1000 }));
    makeComponentFromFrame(doc, fid); // main variant of the set
    const inst = duplicateFrame(doc, fid)!; // a linked instance frame
    expect(doc.frames.find((f) => f.id === inst)!.instanceOf).toBe(fid);

    // Add a variant → a sibling component frame in the same set.
    const v2 = addVariant(doc, fid)!;
    expect(componentSetId(doc.frames.find((f) => f.id === v2)!)).toBe(fid);
    expect(componentSet(doc, fid).map((f) => f.id).sort()).toEqual([fid, v2].sort());

    // Switch the instance to the new variant (its placement is untouched).
    switchInstanceVariant(doc, inst, v2);
    expect(doc.frames.find((f) => f.id === inst)!.instanceOf).toBe(v2);

    // Detach the instance frame → independent, with the master's content cloned in.
    detachInstanceFrame(doc, inst);
    const det = doc.frames.find((f) => f.id === inst)!;
    expect(det.instanceOf).toBeNull();
    expect(doc.tracks.flatMap((t) => t.clips).some((c) => c.frameId === inst)).toBe(true);

    // Delete a variant → an instance of it falls back to the main.
    const inst2 = duplicateFrame(doc, v2)!;
    expect(doc.frames.find((f) => f.id === inst2)!.instanceOf).toBe(v2);
    deleteVariant(doc, v2);
    expect(doc.frames.some((f) => f.id === v2)).toBe(false);
    expect(doc.frames.find((f) => f.id === inst2)!.instanceOf).toBe(fid);
  });

  it("makeComponent on an existing INSTANCE mints a NEW independent set (never re-links)", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const clip = createTextClip({ frameId: fid, text: "logo", startMs: 0, durationMs: 2000 });
    doc.tracks[0]!.clips.push(clip);
    const first = makeComponent(doc, [clip.id])!;
    const set1 = componentSetId(doc.frames.find((f) => f.id === first.frameId)!);

    // A linked copy of the instance.
    const copy = reissueClipIds(locateClip(doc, first.clipId)!.clip);
    doc.tracks[0]!.clips.push(copy);
    expect(copy.kind === "nested" && copy.sourceFrameId).toBe(first.frameId);

    // "Create component" on that copy → a brand-new set, unlinked from the origin.
    const second = makeComponent(doc, [copy.id])!;
    const secondClip = locateClip(doc, second.clipId)!.clip;
    expect(second.frameId).not.toBe(first.frameId);
    expect(secondClip.kind === "nested" && secondClip.sourceFrameId).toBe(second.frameId);
    expect(secondClip.kind === "nested" && secondClip.sourceFrameId).not.toBe(first.frameId);
    const set2 = componentSetId(doc.frames.find((f) => f.id === second.frameId)!);
    expect(set2).not.toBe(set1);
    // The original instance is untouched (still linked to the first set).
    expect((locateClip(doc, first.clipId)!.clip as { sourceFrameId: string }).sourceFrameId).toBe(first.frameId);
  });

  it("componentSetId groups a set and falls back to the frame id for legacy metas", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const clip = createTextClip({ frameId: fid, text: "logo", startMs: 0, durationMs: 2000 });
    doc.tracks[0]!.clips.push(clip);
    const { frameId } = makeComponent(doc, [clip.id])!;
    const master = doc.frames.find((f) => f.id === frameId)!;
    // Fresh component is the main variant of its own set (setId == its id).
    expect(componentSetId(master)).toBe(frameId);
    expect(componentSet(doc, frameId).map((f) => f.id)).toEqual([frameId]);
    expect(mainVariant(doc, frameId)!.id).toBe(frameId);
    // Legacy meta with no explicit setId still resolves to the frame id.
    master.component!.setId = null;
    expect(componentSetId(master)).toBe(frameId);
  });

  it("gcOrphanNestedSources removes a private source comp once nothing references it", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const a = createTextClip({ frameId: fid, text: "a", startMs: 0, durationMs: 1000 });
    const b = createTextClip({ frameId: fid, text: "b", startMs: 1000, durationMs: 1000 });
    doc.tracks[0]!.clips.push(a, b);
    const nestedId = nestClips(doc, [a.id, b.id])!; // creates a source frame on the Nested page
    const srcId = (locateClip(doc, nestedId)!.clip as { sourceFrameId: string }).sourceFrameId;
    expect(doc.frames.some((f) => f.id === srcId)).toBe(true);

    // Delete the only nested clip, then GC — the orphan source frame + its
    // clips are gone, and the emptied Nested page is dropped.
    deleteClip(doc, nestedId);
    gcOrphanNestedSources(doc);
    expect(doc.frames.some((f) => f.id === srcId)).toBe(false);
    expect(doc.tracks.flatMap((t) => t.clips).some((c) => c.frameId === srcId)).toBe(false);
  });

  it("cloneFrameContent deep-clones the frame and its clips with fresh ids", () => {
    const doc = createEmptyDocument();
    const parentFid = frameIdOf(doc);
    const src = { ...doc.frames[0]!, id: "frame_src", name: "src", component: null };
    doc.frames.push(src);
    const srcTrack = createTrack("s");
    srcTrack.clips.push(createTextClip({ frameId: "frame_src", text: "inner", startMs: 0, durationMs: 3000 }));
    doc.tracks.push(srcTrack);
    const nested = createNestedClip({ frameId: parentFid, sourceFrameId: "frame_src", startMs: 0, durationMs: 3000 });
    doc.tracks[0]!.clips.push(nested);

    const cloneId = cloneFrameContent(doc, "frame_src");
    expect(cloneId).not.toBeNull();
    expect(cloneId).not.toBe("frame_src");
    const cloneClips = doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === cloneId);
    expect(cloneClips).toHaveLength(1);
    expect(cloneClips[0]!.id).not.toBe(srcTrack.clips[0]!.id);
  });


  it("detectImageSequences groups runs, sorts numerically, keeps singles", () => {
    const scan = detectImageSequences([
      "render_010.png",
      "render_002.png",
      "render_001.png",
      "logo.png",
      "frame1.jpg",
      "frame2.jpg",
      "scene2_frame001.png",
      "scene2_frame002.png",
    ]);
    // Three sequences (render_*, frame*, scene2_frame*), one single (logo).
    expect(scan.singles).toEqual(["logo.png"]);
    const render = scan.sequences.find((s) => s.base === "render")!;
    expect(render.files).toEqual(["render_001.png", "render_002.png", "render_010.png"]);
    expect(scan.sequences.some((s) => s.base === "frame" && s.files.length === 2)).toBe(true);
    // A prefix containing its own digits still splits on the TRAILING number.
    expect(scan.sequences.some((s) => s.base === "scene2_frame")).toBe(true);
  });

  it("nestClips → decomposeNestedClip round-trips positions and times", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const a = createShapeClip({ frameId: fid, shape: "rect", startMs: 1000, durationMs: 2000, x: 120, y: -40 });
    const b = createShapeClip({ frameId: fid, shape: "ellipse", startMs: 1500, durationMs: 1500, x: -80, y: 60 });
    doc.tracks[0]!.clips.push(a);
    const t2 = createTrack("t2");
    t2.clips.push(b);
    doc.tracks.push(t2);
    const before = [a, b].map((c) => ({ id: c.id, x: c.transform.x, y: c.transform.y, start: c.startMs, dur: c.durationMs }));

    const nestedId = nestClips(doc, [a.id, b.id])!;
    expect(nestedId).not.toBeNull();
    // While nested, the originals live in a private source comp.
    expect(locateClip(doc, a.id)!.clip.frameId).not.toBe(fid);

    expect(decomposeNestedClip(doc, nestedId)).toBe(true);
    // The wrapper is gone; the shapes are back on the parent comp where they were,
    // and there are EXACTLY two clips total — decompose must never duplicate.
    const all = doc.tracks.flatMap((t) => t.clips);
    expect(all.some((c) => c.id === nestedId)).toBe(false);
    expect(all.length).toBe(2);
    for (const b0 of before) {
      const back = locateClip(doc, b0.id)!.clip as unknown as {
        frameId: string;
        startMs: number;
        durationMs: number;
        transform: { x: number; y: number };
      };
      expect(back.frameId).toBe(fid);
      expect(back.transform.x).toBeCloseTo(b0.x, 0);
      expect(back.transform.y).toBeCloseTo(b0.y, 0);
      expect(back.startMs).toBeCloseTo(b0.start, 0);
      expect(back.durationMs).toBeCloseTo(b0.dur, 0);
    }
  });

  it("collectContainedAudioClips finds audio buried inside nested comps, recursively", () => {
    const doc = createEmptyDocument();
    const parentFid = frameIdOf(doc);
    // Inner comp holds a voice clip + a deeper nested comp holding another.
    const inner = { ...doc.frames[0]!, id: "frame_inner", name: "Inner", component: null };
    const deep = { ...doc.frames[0]!, id: "frame_deep", name: "Deep", component: null };
    doc.frames.push(inner, deep);
    const innerTrack = createTrack("i");
    innerTrack.clips.push(createAssetAudioClip({ frameId: "frame_inner", assetId: "v1", startMs: 0, durationMs: 2000 }));
    innerTrack.clips.push(createNestedClip({ frameId: "frame_inner", sourceFrameId: "frame_deep", startMs: 0, durationMs: 2000 }));
    const deepTrack = createTrack("d");
    deepTrack.clips.push(createAssetAudioClip({ frameId: "frame_deep", assetId: "v2", startMs: 0, durationMs: 2000 }));
    doc.tracks.push(innerTrack, deepTrack);
    const container = createNestedClip({ frameId: parentFid, sourceFrameId: "frame_inner", startMs: 0, durationMs: 2000 });
    doc.tracks[0]!.clips.push(container);

    const found = collectContainedAudioClips(doc, container);
    expect(found.map((f) => f.clip.source).map((s) => (s.type === "asset" ? s.assetId : ""))).toEqual(["v1", "v2"]);
    // The deeper one carries its frame trail.
    expect(found[1]!.framePath).toEqual(["Inner", "Deep"]);
    // A non-container clip yields nothing.
    expect(collectContainedAudioClips(doc, innerTrack.clips[0]!)).toEqual([]);
  });

  it("createComponentInstanceClip only builds for component frames", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const clip = createTextClip({ frameId: fid, text: "x", startMs: 0, durationMs: 1000 });
    doc.tracks[0]!.clips.push(clip);
    const { frameId } = makeComponent(doc, [clip.id])!;
    const built = createComponentInstanceClip(doc, frameId, { frameId: fid, startMs: 500 });
    expect(built?.kind).toBe("nested");
    expect(built && built.sourceFrameId).toBe(frameId);
    // A non-component frame id yields null.
    expect(createComponentInstanceClip(doc, fid, { frameId: fid, startMs: 0 })).toBeNull();
  });

  it("a component definition is parent-agnostic — no owner or ancestry, even with many instances", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const clip = createTextClip({ frameId: fid, text: "x", startMs: 0, durationMs: 1000 });
    doc.tracks[0]!.clips.push(clip);
    const { frameId } = makeComponent(doc, [clip.id])!;
    // Place three instances of the component on a track (the lip-sync case).
    const seqTrack = createTrack("seq");
    doc.tracks.push(seqTrack);
    for (let i = 0; i < 3; i++) {
      const inst = createComponentInstanceClip(doc, frameId, { frameId: fid, startMs: i * 1000 })!;
      seqTrack.clips.push(inst);
    }
    // The definition has no owner and no ancestry path — instances reference it,
    // they don't contain it. This is what stops parent-preview from rendering
    // the instancing sequence behind the static component.
    expect(ownerNestedOf(doc, frameId)).toBeNull();
    expect(compAncestryPath(doc, frameId)).toEqual([]);
  });

  it("resolvePlaybackScope: audio and video share ONE authority (no sound-over-frozen-picture)", () => {
    // Frame1 = a component with content; Frame2 hosts a nested INSTANCE of it.
    const doc = createEmptyDocument();
    const fid1 = frameIdOf(doc);
    const inner = createTextClip({ frameId: fid1, text: "hi", startMs: 0, durationMs: 2000 });
    doc.tracks[0]!.clips.push(inner);
    makeComponentFromFrame(doc, fid1); // fid1 is now a component definition

    const f2 = { ...doc.frames[0]!, id: "frame_2", name: "Frame 2", component: null };
    doc.frames.push(f2);
    const instance = createComponentInstanceClip(doc, fid1, { frameId: "frame_2", startMs: 1000 })!;
    const seq = createTrack("seq");
    seq.clips.push(instance);
    doc.tracks.push(seq);

    // Flat: Frame1 selected on its page — it alone is the authority, conducts
    // itself, and advances at the raw playhead.
    const flat = resolvePlaybackScope(doc, { path: editPath(fid1), playheadMs: 400 });
    expect(flat.mode).toBe("flat");
    expect(flat.conductId).toBe(fid1);
    expect(flat.liveTimes.get(fid1)).toBe(400);

    // In-place edit of the instance (double-clicked Frame2's instance → drilled
    // into the definition). The PICTURE is painted through Frame2, so the scope
    // MUST advance Frame2 and conduct it — otherwise sound plays over a still
    // image (the bug). Root advances; the definition is live too.
    const path = editPath("frame_2", [instance.id]);
    const inplace = resolvePlaybackScope(doc, { path, playheadMs: 500 });
    expect(inplace.mode).toBe("inplace");
    expect(inplace.conductId).toBe("frame_2"); // conduct the ancestry root
    expect(inplace.liveTimes.has("frame_2")).toBe(true); // the picture-bearing frame advances
    expect(inplace.liveTimes.get(fid1)).toBe(500); // the definition is live at the playhead
    // conductTimeMs is the root's mapped time (instance starts at 1000).
    expect(inplace.conductTimeMs).toBe(1000 + 500);
  });
});

describe("svg css cascade (Figma logo)", () => {
  // The exact <style>-class fills that broke the old getComputedStyle importer.
  const css = ".st0{fill:#0acf83}.st1{fill:#a259ff}.st2{fill:#f24e1e}.st3{fill:#ff7262}.st4{fill:#1abcfe}";

  it("parses class rules and resolves each path's fill", () => {
    const rules = parseCssRules(css);
    expect(rules).toHaveLength(5);
    const resolve = (cls: string) =>
      cssDeclarationsFor({ tag: "path", id: null, classes: [cls] }, rules).fill;
    expect(resolve("st0")).toBe("#0acf83");
    expect(resolve("st1")).toBe("#a259ff");
    expect(resolve("st4")).toBe("#1abcfe");
  });

  it("matches compound / id / tag selectors", () => {
    expect(selectorMatches(".st0", { tag: "path", id: null, classes: ["st0"] })).toBe(true);
    expect(selectorMatches("path.st0", { tag: "path", id: "x", classes: ["st0"] })).toBe(true);
    expect(selectorMatches("rect.st0", { tag: "path", id: null, classes: ["st0"] })).toBe(false);
    expect(selectorMatches("#logo", { tag: "path", id: "logo", classes: [] })).toBe(true);
  });

  it("normalizes hex/rgb/named colors with alpha", () => {
    expect(cssColorToHex("#0acf83")).toBe("#0acf83");
    expect(cssColorToHex("#abc")).toBe("#aabbcc");
    expect(cssColorToHex("rgb(10, 207, 131)")).toBe("#0acf83");
    expect(cssColorToHex("white")).toBe("#ffffff");
    expect(cssColorToHex("#ffffff", 0.5)).toBe("#ffffff80");
    expect(cssColorToHex("none")).toBeNull();
  });
});

describe("fill-duration (nested children track the comp)", () => {
  function nestedWithChild(childDur: number, nestedDur: number) {
    const doc = createEmptyDocument();
    const parentFid = frameIdOf(doc);
    doc.frames.push({ ...doc.frames[0]!, id: "frame_src", name: "src", component: null, pageId: "__internal__" });
    const st = createTrack("s");
    const child = createShapeClip({ frameId: "frame_src", shape: "rect", startMs: 0 });
    child.durationMs = childDur;
    child.fillDuration = true;
    st.clips.push(child);
    doc.tracks.push(st);
    const nested = createNestedClip({ frameId: parentFid, sourceFrameId: "frame_src", startMs: 0, durationMs: nestedDur });
    doc.tracks[0]!.clips.push(nested);
    return { doc, child, nested };
  }

  it("a private nested comp's duration IS its sole owner clip's duration", () => {
    const { doc, nested } = nestedWithChild(500, 4000);
    expect(compOwnerNested(doc, "frame_src")?.id).toBe(nested.id);
    expect(compDurationMs(doc, "frame_src")).toBe(4000);
  });

  it("reconcile stretches fill children to the comp duration; trim locks them", () => {
    const { doc, child, nested } = nestedWithChild(500, 4000);
    reconcileFillClips(doc, "frame_src");
    expect(locateClip(doc, child.id)!.clip.durationMs).toBe(4000);
    // Resizing the nested clip re-flows the child (trimClip reconciles).
    trimClip(doc, nested.id, "end", 6000);
    expect(locateClip(doc, child.id)!.clip.durationMs).toBe(6000);
    // A manual trim on the child LOCKS it (fillDuration cleared, value kept).
    trimClip(doc, child.id, "end", 2000);
    expect(locateClip(doc, child.id)!.clip.fillDuration).toBe(false);
    reconcileFillClips(doc, "frame_src");
    expect(locateClip(doc, child.id)!.clip.durationMs).toBe(2000); // no longer tracks
  });

  it("splitting a fill clip LOCKS both halves (a cut is bound to the timeline, never full-width)", () => {
    const { doc, child } = nestedWithChild(4000, 4000);
    child.durationMs = 4000;
    child.fillDuration = true; // pixel/capture layers are born this way
    // Cut it in the middle.
    const rightId = splitClip(doc, child.id, 1500)!;
    const left = locateClip(doc, child.id)!.clip;
    const right = locateClip(doc, rightId)!.clip;
    // Both halves are now fixed-length — the cut boundaries are authoritative.
    expect(left.fillDuration).toBe(false);
    expect(right.fillDuration).toBe(false);
    expect(left.durationMs).toBe(1500);
    expect(right.durationMs).toBe(2500);
    // Reconcile can NEVER balloon them back to full width.
    reconcileFillClips(doc, "frame_src");
    expect(locateClip(doc, child.id)!.clip.durationMs).toBe(1500);
    expect(locateClip(doc, rightId)!.clip.durationMs).toBe(2500);
  });

  it("a fill clip reconciles into the free gap, never overlapping the next clip on its track", () => {
    const { doc } = nestedWithChild(4000, 8000);
    const track = doc.tracks.find((t) => t.clips.some((c) => c.frameId === "frame_src"))!;
    const fill = track.clips.find((c) => c.frameId === "frame_src")!;
    fill.startMs = 0;
    fill.durationMs = 500;
    fill.fillDuration = true;
    // A fixed clip sits later on the SAME track.
    const blocker = createShapeClip({ frameId: "frame_src", shape: "rect", startMs: 3000 });
    blocker.durationMs = 1000;
    track.clips.push(blocker);
    reconcileFillClips(doc, "frame_src");
    // The fill takes the gap up to the blocker (3000), not the comp end (8000).
    expect(locateClip(doc, fill.id)!.clip.durationMs).toBe(3000);
  });

  it("retiming an instance NEVER mutates the source comp (speed is a time-remap)", () => {
    // A private nested comp with a fillDuration child carrying snapshot-style
    // keyframes (the capture/drawing-layer shape). Retiming the OWNER must
    // rescale only its footprint — the source comp, its fill child's length and
    // its keyframe times must all stay put.
    const { doc, child, nested } = nestedWithChild(500, 4000);
    child.durationMs = 4000; // acts like a fill child already spanning the comp
    child.keyframes = [
      { id: "tx", property: "x", range: null, keys: [
        { id: "kx0", timeMs: 0, value: 0, easing: { kind: "linear" } },
        { id: "kx1", timeMs: 3000, value: 100, easing: { kind: "linear" } },
      ] },
    ];
    reconcileFillClips(doc, "frame_src");
    const sourceSpanBefore = compDurationMs(doc, "frame_src");
    expect(sourceSpanBefore).toBe(4000);

    // Speed up the instance 1.3× — footprint shrinks, source is untouched.
    expect(retimeClip(doc, nested.id, 1.3, { ripple: false })).toBe(true);
    expect(locateClip(doc, nested.id)!.clip.durationMs).toBe(Math.round(4000 / 1.3));
    // Invariant: footprint × speed === source span (stays constant).
    expect(compDurationMs(doc, "frame_src")).toBe(sourceSpanBefore);
    // The fill child and its keyframes are exactly as they were — no misplacement.
    const childAfter = locateClip(doc, child.id)!.clip;
    expect(childAfter.durationMs).toBe(4000);
    expect(childAfter.keyframes[0]!.keys.map((k) => k.timeMs)).toEqual([0, 3000]);

    // And back to 1× restores the original footprint exactly.
    expect(retimeClip(doc, nested.id, 1, { ripple: false })).toBe(true);
    expect(compDurationMs(doc, "frame_src")).toBe(4000);
    expect(locateClip(doc, child.id)!.clip.durationMs).toBe(4000);
  });

  it("detachInstance deep-clones the source INSIDE an immer update (draft-safe)", () => {
    const store = createDocumentStore(createEmptyDocument());
    let clipId = "";
    let compFrameId = "";
    store.update("setup", (d) => {
      const fid = d.frames[0]!.id;
      const clip = createTextClip({ frameId: fid, text: "logo", startMs: 0, durationMs: 2000 });
      d.tracks[0]!.clips.push(clip);
      const res = makeComponent(d, [clip.id])!;
      clipId = res.clipId;
      compFrameId = res.frameId;
    });
    const framesBefore = store.getState().frames.length;

    // Detach inside a producer (the production path — cloneFrameContent on a draft).
    store.update("detach", (d) => void detachInstance(d, clipId));

    expect(store.getState().frames.length).toBe(framesBefore + 1);
    const detached = locateClip(store.getState(), clipId)!.clip;
    expect(detached.kind === "nested" && detached.sourceFrameId).not.toBe(compFrameId);
  });
});

describe("audio gain envelope (headless)", () => {
  it("samples gain keyframes and multiplies edge fades", () => {
    const doc = createEmptyDocument();
    const clip = createAudioClip({ frameId: doc.frames[0]!.id, startMs: 0, durationMs: 2000 });
    // Keyframed volume: 1 → 0.5 across the clip, linear.
    setKeyframe(clip.keyframes, "gain", 0, 1, { kind: "linear" });
    setKeyframe(clip.keyframes, "gain", 2000, 0.5, { kind: "linear" });
    expect(audioGainAt(clip, 0)).toBeCloseTo(1);
    expect(audioGainAt(clip, 1000)).toBeCloseTo(0.75);
    expect(audioGainAt(clip, 2000)).toBeCloseTo(0.5);

    // A fade-in multiplies the automation instead of replacing it.
    clip.fadeIn = { durationMs: 1000, curve: { kind: "linear" } };
    expect(audioGainAt(clip, 0)).toBeCloseTo(0);
    expect(audioGainAt(clip, 500)).toBeCloseTo(0.875 * 0.5);
    expect(audioGainAt(clip, 1500)).toBeCloseTo(0.625);
    expect(hasGainAutomation(clip)).toBe(true);

    const env = sampleGainEnvelope(clip, 500);
    expect(env.length).toBeGreaterThanOrEqual(2);
    expect(env[0]).toBeCloseTo(0);
  });

  it("dB helpers round-trip and unkeyed clips use the base gain", () => {
    expect(gainToDb(1)).toBeCloseTo(0);
    expect(dbToGain(gainToDb(0.5))).toBeCloseTo(0.5);
    expect(gainToDb(0)).toBe(-Infinity);
    const doc = createEmptyDocument();
    const clip = createAudioClip({ frameId: doc.frames[0]!.id, startMs: 0, durationMs: 1000 });
    clip.gain = 0.8;
    expect(audioGainAt(clip, 500)).toBeCloseTo(0.8);
    expect(hasGainAutomation(clip)).toBe(false);
    // EQ is a card in the audio stack now; its bands sample per band, through
    // the ONE resolver every engine reads.
    clip.audioEffects = [
      {
        id: "fx-eq",
        type: "eq",
        enabled: true,
        bands: [
          { id: "b-low", type: "lowshelf", freqHz: 200, gainDb: 3, q: 0.707, enabled: true },
          { id: "b-mid", type: "peaking", freqHz: 1000, gainDb: 0, q: 0.707, enabled: true },
          { id: "b-high", type: "highshelf", freqHz: 4000, gainDb: -6, q: 0.707, enabled: false },
        ],
      },
    ];
    setKeyframe(clip.keyframes, "afx.fx-eq.band.b-mid.gain", 0, 0, { kind: "linear" });
    setKeyframe(clip.keyframes, "afx.fx-eq.band.b-mid.gain", 1000, 12, { kind: "linear" });
    const bands = audioEffectsAt(clip.audioEffects, clip.keyframes, 500)[0]!.bands;
    // Disabled high band is dropped; mid gain samples to 6 dB mid-ramp.
    expect(bands.map((b) => b.id)).toEqual(["b-low", "b-mid"]);
    expect(bands[0]!.gainDb).toBe(3);
    expect(bands[1]!.gainDb).toBeCloseTo(6);
  });

  it("timeStretch scales length by the ratio; pitchShift preserves it", () => {
    // A 1 kHz sine at 48k, half a second.
    const N = 24000;
    const sine = new Float32Array(N);
    for (let i = 0; i < N; i++) sine[i] = Math.sin((2 * Math.PI * 1000 * i) / 48000);

    const slower = timeStretch([sine], 2);
    expect(slower[0]!.length).toBe(N * 2);
    const faster = timeStretch([sine], 0.5);
    expect(faster[0]!.length).toBe(N * 0.5);
    // Ratio 1 is a passthrough copy (not the same reference).
    const same = timeStretch([sine], 1);
    expect(same[0]!.length).toBe(N);
    expect(same[0]).not.toBe(sine);

    // Pitch shift keeps duration exactly and preserves stereo channel count.
    const shifted = pitchShift([sine, sine], 5);
    expect(shifted.length).toBe(2);
    expect(shifted[0]!.length).toBe(N);
    // The stretched output stays bounded (no runaway from OLA normalize).
    let max = 0;
    for (const v of slower[0]!) max = Math.max(max, Math.abs(v));
    expect(max).toBeLessThan(1.5);
  });

  it("clipAudioSignature + audioNeedsBake track the heavy factors", () => {
    const doc = createEmptyDocument();
    const clip = createAssetAudioClip({ frameId: doc.frames[0]!.id, assetId: "a1", startMs: 0, durationMs: 1000 });
    const base = clipAudioSignature(clip);
    expect(audioNeedsBake(clip)).toBe(false); // keepPitch on but speed 1 → nothing to do
    clip.pitchSemitones = 3;
    expect(clipAudioSignature(clip)).not.toBe(base);
    expect(audioNeedsBake(clip)).toBe(true);
    expect(audioNeedsBakeLive(clip)).toBe(true);
    clip.pitchSemitones = 0;
    clip.playback.speed = 2; // keepPitch + speed → export bakes, live uses the element
    expect(audioNeedsBake(clip)).toBe(true);
    expect(audioNeedsBakeLive(clip)).toBe(false);
  });

  it("EQ magnitude curve peaks near a bell band's center frequency", () => {
    const bands = [
      { id: "b", type: "peaking" as const, freqHz: 1000, gainDb: 12, q: 1, enabled: true },
    ];
    // A +12 dB bell should read ~+12 dB at its center and ~0 dB far away.
    expect(eqMagnitudeDb(bands, 1000)).toBeGreaterThan(9);
    expect(Math.abs(eqMagnitudeDb(bands, 50))).toBeLessThan(1);
  });
});

describe("retime (speed changes rescale the clip footprint)", () => {
  const mediaAsset = (id: string, durationMs: number) => ({
    id,
    kind: "video" as const,
    name: `${id}.mp4`,
    mime: "video/mp4",
    bytes: 1,
    width: 1920,
    height: 1080,
    durationMs,
    fps: null,
    folderId: null,
    origin: null,
  });

  it("2× on a play-once clip halves its duration and scales keyframes; ripple shifts the neighbors", () => {
    const doc = createEmptyDocument();
    const frameId = frameIdOf(doc);
    const video = createVideoClip({ frameId, assetId: "a1", startMs: 1000, durationMs: 4000 });
    video.keyframes.push({
      id: "t",
      property: "opacity",
      range: null,
      keys: [{ id: "k", timeMs: 2000, value: 1, easing: { kind: "linear" } }],
    });
    const next = createVideoClip({ frameId, assetId: "a1", startMs: 5000, durationMs: 1000 });
    doc.tracks[0]!.clips.push(video, next);

    expect(retimeClip(doc, video.id, 2, { ripple: true })).toBe(true);
    expect(video.playback.speed).toBe(2);
    expect(video.durationMs).toBe(2000);
    expect(video.keyframes[0]!.keys[0]!.timeMs).toBe(1000); // stretched with content
    expect(next.startMs).toBe(3000); // rippled left by the 2000ms shrink

    // Back to 0.5× the current length: grows, ripple pushes the neighbor right.
    expect(retimeClip(doc, video.id, 1, { ripple: true })).toBe(true);
    expect(video.durationMs).toBe(4000);
    expect(next.startMs).toBe(5000);
  });

  it("without ripple a growing clip clamps at its next neighbor", () => {
    const doc = createEmptyDocument();
    const frameId = frameIdOf(doc);
    const video = createVideoClip({ frameId, assetId: "a1", startMs: 0, durationMs: 2000 });
    const next = createVideoClip({ frameId, assetId: "a1", startMs: 3000, durationMs: 1000 });
    doc.tracks[0]!.clips.push(video, next);

    retimeClip(doc, video.id, 0.5, { ripple: false }); // wants 4000ms
    expect(video.durationMs).toBe(3000); // stopped at the neighbor
    expect(next.startMs).toBe(3000); // untouched
  });

  it("loop-mode clips keep their footprint on retime", () => {
    const doc = createEmptyDocument();
    const frameId = frameIdOf(doc);
    const video = createVideoClip({ frameId, assetId: "a1", startMs: 0, durationMs: 4000 });
    video.playback.loop = "loop";
    doc.tracks[0]!.clips.push(video);

    retimeClip(doc, video.id, 2, { ripple: true });
    expect(video.playback.speed).toBe(2);
    expect(video.durationMs).toBe(4000);
  });

  it("clipSourceCapacityMs reports the footage-bound length; loop mode is uncapped", () => {
    const doc = createEmptyDocument();
    const frameId = frameIdOf(doc);
    doc.assets.push(mediaAsset("a1", 5000));
    const video = createVideoClip({ frameId, assetId: "a1", startMs: 0, durationMs: 3000 });
    doc.tracks[0]!.clips.push(video);

    expect(clipSourceCapacityMs(doc, video)).toBe(5000);
    video.trimInMs = 1000;
    expect(clipSourceCapacityMs(doc, video)).toBe(4000);
    video.playback.speed = 2;
    expect(clipSourceCapacityMs(doc, video)).toBe(2000);
    video.playback.loop = "loop";
    expect(clipSourceCapacityMs(doc, video)).toBeNull();
  });

  it("ripple default is on only when the next clip sits attached to the end", () => {
    const doc = createEmptyDocument();
    const frameId = frameIdOf(doc);
    const a = createVideoClip({ frameId, assetId: "a1", startMs: 0, durationMs: 2000 });
    const b = createVideoClip({ frameId, assetId: "a1", startMs: 2000, durationMs: 1000 });
    doc.tracks[0]!.clips.push(a, b);
    expect(retimeRippleDefault(doc, a.id)).toBe(true); // b attached to a's end
    expect(retimeRippleDefault(doc, b.id)).toBe(false); // nothing after b

    // A saved per-clip override beats the automatic default.
    a.playback.ripple = false;
    expect(resolveRetimeRipple(doc, a.id)).toBe(false);
  });
});

describe("viewport snapping (headless 2D magnet)", () => {
  const box = { minX: 100, minY: 100, maxX: 200, maxY: 160 }; // 100×60

  it("snaps a moving box's near edge onto a target edge within threshold", () => {
    // A wide target far to the right → only its LEFT edge (95) is near the box.
    const cand = buildSnapCandidates([{ minX: 95, minY: 0, maxX: 1000, maxY: 400 }], null, DEFAULT_VIEWPORT_SNAP);
    const r = snapMove(box, cand, 8);
    expect(r.dx).toBe(-5); // left 100 → 95
    expect(r.dy).toBe(0);
    expect(r.v.length).toBeGreaterThan(0);
  });

  it("snaps center-to-center on both axes independently", () => {
    // Target centered at (150, 130) — same center as the box → 0 delta but a guide.
    const cand = buildSnapCandidates([{ minX: 140, minY: 120, maxX: 160, maxY: 140 }], null, DEFAULT_VIEWPORT_SNAP);
    const r = snapMove(box, cand, 8);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.v.some((l) => l.kind === "center")).toBe(true);
    expect(r.h.some((l) => l.kind === "center")).toBe(true);
  });

  it("snaps to the page center when enabled", () => {
    const page = { minX: 0, minY: 0, maxX: 300, maxY: 260 }; // center (150, 130)
    const cand = buildSnapCandidates([], page, DEFAULT_VIEWPORT_SNAP);
    const r = snapMove({ minX: 104, minY: 104, maxX: 196, maxY: 156 }, cand, 8);
    // box center (150,130) already == page center → snapped, guides light up
    expect(r.v.some((l) => l.kind === "page")).toBe(true);
    expect(r.h.some((l) => l.kind === "page")).toBe(true);
  });

  it("does nothing when everything is outside the threshold", () => {
    const cand = buildSnapCandidates([{ minX: 500, minY: 500, maxX: 600, maxY: 600 }], null, DEFAULT_VIEWPORT_SNAP);
    const r = snapMove(box, cand, 8);
    expect(r).toEqual({ dx: 0, dy: 0, v: [], h: [] });
  });

  it("respects the settings toggles (page off, layers off)", () => {
    const page = { minX: 0, minY: 0, maxX: 300, maxY: 260 };
    const cand = buildSnapCandidates([{ minX: 95, minY: 100, maxX: 300, maxY: 160 }], page, {
      thresholdPx: 8,
      toLayers: false,
      toPageEdges: false,
      toPageCenter: false,
      toGuides: false,
    });
    expect(cand.v).toEqual([]);
    expect(cand.h).toEqual([]);
    expect(snapMove(box, cand, 8).dx).toBe(0);
  });

  it("snapPoint snaps a lone corner on both axes", () => {
    const cand = buildSnapCandidates([{ minX: 50, minY: 50, maxX: 98, maxY: 103 }], null, DEFAULT_VIEWPORT_SNAP);
    const r = snapPoint(100, 100, cand, 8);
    expect(r.x).toBe(98); // right edge 98 within 8 of 100
    expect(r.y).toBe(103); // bottom edge 103 within 8 of 100
  });
});

describe("alignment (headless boxes)", () => {
  const b = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });
  it("aligns units to a container edge / center", () => {
    const units = [b(0, 0, 10, 10), b(100, 50, 130, 90)];
    const container = b(0, 0, 130, 90);
    expect(alignBoxes(units, container, "left").map((d) => d.dx)).toEqual([0, -100]);
    expect(alignBoxes(units, container, "right").map((d) => d.dx)).toEqual([120, 0]);
    // hcenter: container center x = 65; unit centers 5 and 115 → +60, -50.
    expect(alignBoxes(units, container, "hcenter").map((d) => d.dx)).toEqual([60, -50]);
    expect(alignBoxes(units, container, "top").map((d) => d.dy)).toEqual([0, -50]);
  });

  it("distributes gaps equally (3+ units, outer ones fixed)", () => {
    // sizes 10,10,10 across span 0..90 → free 60, gap 30. Middle should land at 30.
    const units = [b(0, 0, 10, 10), b(20, 0, 30, 10), b(80, 0, 90, 10)];
    const d = distributeBoxes(units, "h");
    expect(d[0]!.dx).toBe(0); // first fixed
    expect(d[2]!.dx).toBe(0); // last fixed
    expect(d[1]!.dx).toBe(20); // 20 → 40 (equal 30px gaps)
  });

  it("distribute is a no-op below 3 units", () => {
    expect(distributeBoxes([b(0, 0, 1, 1), b(5, 0, 6, 1)], "h")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  });
});

describe("camera (headless fit / leash / visibility)", () => {
  const viewport = { width: 800, height: 600 };

  it("fitCamera centers bounds with padding and clamps to maxScale", () => {
    const cam = fitCamera({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, viewport, { paddingPx: 0, maxScale: 2 });
    expect(cam.scale).toBe(2); // would-be 8x clamped down to the 2x ceiling
    expect(cam.tx).toBeCloseTo((800 - 100 * 2) / 2);
    expect(cam.ty).toBeCloseTo((600 - 100 * 2) / 2);
  });

  it("isBoundsVisible is true for any overlap, however small", () => {
    const cam = { scale: 1, tx: 0, ty: 0 };
    // Bounds mostly off the right edge, 1 world px still on screen.
    expect(isBoundsVisible({ minX: 799, minY: 0, maxX: 900, maxY: 50 }, cam, viewport)).toBe(true);
    expect(isBoundsVisible({ minX: 801, minY: 0, maxX: 900, maxY: 50 }, cam, viewport)).toBe(false);
  });

  it("clampCameraToLeash is a no-op while content is within slack of the viewport", () => {
    const content = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
    // Panned so content sits just outside the raw viewport but well within 1x slack.
    const cam = { scale: 1, tx: -700, ty: -700 };
    expect(clampCameraToLeash(cam, content, viewport)).toEqual(cam);
  });

  it("clampCameraToLeash pulls the camera back once content drifts past the leash", () => {
    const content = { minX: 0, minY: 0, maxX: 200, maxY: 200 };
    // Flung far away — content's screen projection is nowhere near the viewport + slack.
    const cam = { scale: 1, tx: -100000, ty: 0 };
    const clamped = clampCameraToLeash(cam, content, viewport);
    expect(clamped.scale).toBe(1); // leash only ever pans
    expect(clamped.tx).toBeGreaterThan(cam.tx);
    // Content's projected right edge now sits exactly on the pulled-back leash line.
    expect(clamped.tx + content.maxX).toBeCloseTo(-viewport.width * 1);
  });
});

describe("motion paths (spatial position keyframes)", () => {
  const makeHost = () => {
    const host = { keyframes: [] as KeyframeTrack[], transform: { x: 0, y: 0 } };
    setKeyframe(host.keyframes, "x", 0, 0, { kind: "linear" });
    setKeyframe(host.keyframes, "y", 0, 0, { kind: "linear" });
    setKeyframe(host.keyframes, "x", 1000, 100, { kind: "linear" });
    setKeyframe(host.keyframes, "y", 1000, 0, { kind: "linear" });
    return host;
  };

  it("without tangents, sampling stays the independent per-axis lerp", () => {
    const host = makeHost();
    const mid = sampleKeyframes(host.keyframes, 500);
    expect(mid["x"]).toBe(50);
    expect(mid["y"]).toBe(0);
  });

  it("tangents curve the sampled position through the bezier", () => {
    const host = makeHost();
    setMotionTangent(host, 0, "out", { x: 0, y: -90 });
    setMotionTangent(host, 1000, "in", { x: 0, y: -90 });
    const mid = sampleKeyframes(host.keyframes, 500);
    // Symmetric vertical tangents: x still crosses the middle, y bows up 3/4 of the pull.
    expect(mid["x"]).toBeCloseTo(50, 5);
    expect(mid["y"]).toBeCloseTo(-67.5, 5);
    // Ends hold exactly.
    expect(sampleKeyframes(host.keyframes, 0)["y"]).toBe(0);
    expect(sampleKeyframes(host.keyframes, 1000)["y"]).toBe(0);
  });

  it("insertMotionKey splits on the curve without changing its shape", () => {
    const host = makeHost();
    setMotionTangent(host, 0, "out", { x: 0, y: -90 });
    setMotionTangent(host, 1000, "in", { x: 0, y: -90 });
    const before = [250, 400, 600, 800].map((t) => sampleKeyframes(host.keyframes, t));
    const [a, b] = motionKeysOf(host);
    insertMotionKey(host, a!, b!, 0.5);
    expect(motionKeysOf(host)).toHaveLength(3);
    [250, 400, 600, 800].forEach((t, i) => {
      const after = sampleKeyframes(host.keyframes, t);
      expect(after["x"] as number).toBeCloseTo(before[i]!["x"] as number, 4);
      expect(after["y"] as number).toBeCloseTo(before[i]!["y"] as number, 4);
    });
  });

  it("toggleMotionSmooth round-trips corner → smooth → corner; delete removes the pair", () => {
    const host = makeHost();
    setKeyframe(host.keyframes, "x", 500, 80, { kind: "linear" });
    setKeyframe(host.keyframes, "y", 500, -60, { kind: "linear" });
    toggleMotionSmooth(host, 500);
    const smoothed = motionKeysOf(host).find((k) => k.timeMs === 500)!;
    expect(smoothed.tIn && smoothed.tOut).toBeTruthy();
    // Catmull-Rom mirror: in = -out.
    expect(smoothed.tIn!.x).toBeCloseTo(-smoothed.tOut!.x, 6);
    toggleMotionSmooth(host, 500);
    expect(motionKeysOf(host).find((k) => k.timeMs === 500)!.tOut).toBeNull();
    deleteMotionKey(host, 500);
    expect(motionKeysOf(host)).toHaveLength(2);
  });

  it("bendMotionSegment pulls the curve through the grabbed point", () => {
    const host = makeHost();
    const [a, b] = motionKeysOf(host);
    bendMotionSegment(host, a!, b!, 0.5, 0, -40);
    const mid = sampleKeyframes(host.keyframes, 500);
    expect(mid["y"] as number).toBeCloseTo(-40, 5);
    expect(mid["x"] as number).toBeCloseTo(50, 5);
  });

  it("a lone-axis extra key still samples (unaligned keys degrade gracefully)", () => {
    const host = makeHost();
    setMotionTangent(host, 0, "out", { x: 0, y: -90 });
    setKeyframe(host.keyframes, "x", 500, 10, { kind: "linear" });
    expect(typeof sampleKeyframes(host.keyframes, 250)["y"]).toBe("number");
  });
});

describe("vector corner radius (Figma-style)", () => {
  const corner = (x: number, y: number, cornerRadius?: number) => ({ x, y, hIn: null, hOut: null, ...(cornerRadius ? { cornerRadius } : {}) });

  it("rounds a closed square's corners with a true circular fillet (KAPPA arc)", () => {
    const cmds = pathCommands([{ closed: true, points: [
      corner(0, 0, 20), corner(100, 0, 20), corner(100, 100, 20), corner(0, 100, 20),
    ] }]);
    // Straight runs shrink by the radius at each end; corners become cubics.
    const m = cmds[0] as { type: string; x: number; y: number };
    expect(m.type).toBe("M");
    expect(m.x).toBeCloseTo(20, 6);
    expect(m.y).toBeCloseTo(0, 6);
    expect(cmds[1]).toMatchObject({ type: "L", x: 80, y: 0 });
    const arc = cmds[2] as { type: string; x1: number; x: number; y: number };
    expect(arc.type).toBe("C");
    // 90° arc control arm = r·KAPPA (0.5523); lands the corner tangent-continuous.
    expect(arc.x1).toBeCloseTo(100 - 20 * (1 - 0.5522847), 4);
    expect(arc.x).toBeCloseTo(100, 6);
    expect(arc.y).toBeCloseTo(20, 6);
    expect(cmds.at(-1)).toMatchObject({ type: "Z" });
  });

  it("leaves zero-radius corners as straight lines (byte-identical to before)", () => {
    const cmds = pathCommands([{ closed: true, points: [corner(0, 0), corner(10, 0), corner(10, 10)] }]);
    expect(cmds).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 10, y: 0 },
      { type: "L", x: 10, y: 10 },
      { type: "L", x: 0, y: 0 },
      { type: "Z" },
    ]);
  });

  it("never rounds an open path's endpoints, only interior corners", () => {
    const verts = roundableVertices([{ closed: false, points: [corner(0, 0), corner(100, 0), corner(100, 100)] }]);
    expect(verts).toEqual([{ sub: 0, index: 1 }]); // only the middle vertex
    const cmds = pathCommands([{ closed: false, points: [corner(0, 0, 20), corner(100, 0, 20), corner(100, 100, 20)] }]);
    expect(cmds[0]).toMatchObject({ type: "M", x: 0, y: 0 }); // start endpoint untouched
    expect(cmds.at(-1)).toMatchObject({ type: "L", x: 100, y: 100 }); // ends exactly on the last endpoint
    expect(cmds.some((c) => c.type === "C")).toBe(true); // the middle corner did round
  });

  it("skips smooth (curved) corners — a bezier side has no corner to fillet", () => {
    const smooth = { x: 100, y: 0, hIn: { x: 90, y: 0 }, hOut: { x: 110, y: 0 }, cornerRadius: 20 };
    const verts = roundableVertices([{ closed: true, points: [corner(0, 0), smooth, corner(100, 100)] }]);
    expect(verts.some((v) => v.index === 1)).toBe(false);
  });

  it("bulk read/set operate on the roundable set only", () => {
    const subs = [{ closed: true, points: [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)] }];
    setUniformCornerRadius(subs, 12);
    expect(uniformCornerRadius(subs)).toBe(12);
    expect(subs[0]!.points.every((p) => p.cornerRadius === 12)).toBe(true);
    setUniformCornerRadius(subs, 0);
    expect(uniformCornerRadius(subs)).toBe(0);
    expect(subs[0]!.points.every((p) => p.cornerRadius === undefined)).toBe(true);
  });
});

describe("shift-lock + smart-guide composition (snapPointOnRay)", () => {
  const cand = { v: [{ pos: 50, lo: 0, hi: 100, kind: "edge" as const }], h: [] };

  it("slides a ray-locked point onto a crossing guide without leaving the ray", () => {
    // Ray from origin heading 45°; a vertical guide at x=50 crosses it at (50,50).
    const r = snapPointOnRay({ x: 0, y: 0 }, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, { x: 48, y: 48 }, cand, 8);
    expect(r.x).toBeCloseTo(50, 6);
    expect(r.y).toBeCloseTo(50, 6); // stayed on the 45° ray
    expect(r.v).toHaveLength(1); // the guide flashes
  });

  it("leaves the point put when no crossing is within threshold", () => {
    const r = snapPointOnRay({ x: 0, y: 0 }, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, { x: 10, y: 10 }, cand, 8);
    expect(r).toMatchObject({ x: 10, y: 10, v: [], h: [] });
  });

  it("ignores guides the ray runs parallel to (never crosses)", () => {
    // A vertical ray is parallel to the vertical guide at x=50 — no crossing.
    const r = snapPointOnRay({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 48 }, cand, 8);
    expect(r).toMatchObject({ x: 0, y: 48, v: [], h: [] });
  });
});

describe("capture engine (recordable drawing over time)", () => {
  const lin = { kind: "linear" as const };
  const track = {
    id: "cap",
    property: CAPTURE_PROPERTY,
    range: null,
    keys: [
      { id: "k0", timeMs: 0, value: "surf-a", easing: lin },
      { id: "k1", timeMs: 100, value: "surf-b", easing: lin },
      { id: "k2", timeMs: 200, value: "surf-c", easing: lin },
    ],
  };

  it("finds the capture track and its snapshot surfaces", () => {
    expect(isCaptureClip([track])).toBe(true);
    expect(captureTrack([track])?.id).toBe("cap");
    expect(captureSurfaceIds([track])).toEqual(["surf-a", "surf-b", "surf-c"]);
  });

  it("is blank before the first snapshot (drawing appears over time)", () => {
    expect(captureStateAt(track, -1, false)).toBeNull();
  });

  it("holds a snapshot until the next key (crisp FBF, no crossfade)", () => {
    expect(captureStateAt(track, 0, false)).toMatchObject({ value: "surf-a", mix: 0 });
    expect(captureStateAt(track, 50, false)).toMatchObject({ value: "surf-a", next: null });
    expect(captureStateAt(track, 100, false)).toMatchObject({ value: "surf-b" });
    expect(captureStateAt(track, 999, false)).toMatchObject({ value: "surf-c", next: null });
  });

  it("crossfades between neighbouring snapshots when enabled", () => {
    const mid = captureStateAt(track, 50, true);
    expect(mid).toMatchObject({ value: "surf-a", next: "surf-b" });
    expect(mid!.mix).toBeCloseTo(0.5, 5);
    // Past the last key there is nothing to fade toward — pure hold.
    expect(captureStateAt(track, 250, true)).toMatchObject({ value: "surf-c", next: null, mix: 0 });
  });

  it("registers `capture` as a discrete (hold) property", () => {
    expect(propertyDef("capture")?.kind).toBe("discrete");
  });

});

describe("capture planning (what the next stroke does)", () => {
  const lin = { kind: "linear" as const };
  const tracks = [
    {
      id: "cap",
      property: CAPTURE_PROPERTY,
      range: null,
      keys: [
        { id: "k0", timeMs: 0, value: "surf-a", easing: lin },
        { id: "k1", timeMs: 200, value: "surf-b", easing: lin },
      ],
    },
  ];
  // 25fps → a 40ms frame, so key times and frame boundaries are exact integers.
  const FPS = 25;
  const plan = (patch: Partial<Parameters<typeof planCapture>[0]>) =>
    planCapture({ tracks, localMs: 0, fps: FPS, recording: false, seed: "continue", liveValue: "live", ...patch });

  it("paints the layer's own content when it isn't recording", () => {
    expect(plan({ tracks: [], localMs: 0 })).toEqual({ kind: "live" });
  });

  it("edits the frame already sitting at the playhead", () => {
    expect(plan({ localMs: 200 })).toEqual({ kind: "edit", keyTimeMs: 200, value: "surf-b" });
  });

  it("`continue` seeds a new frame from the one held before it", () => {
    expect(plan({ localMs: 100 })).toEqual({ kind: "new", keyTimeMs: 100, seedFrom: "surf-a" });
  });

  it("`blank` starts a new frame empty", () => {
    expect(plan({ localMs: 100, seed: "blank" })).toEqual({ kind: "new", keyTimeMs: 100, seedFrom: null });
  });

  it("the FIRST recorded frame continues what is already on the layer", () => {
    expect(plan({ tracks: [], localMs: 480, recording: true }))
      .toEqual({ kind: "new", keyTimeMs: 480, seedFrom: "live" });
  });

  it("a new frame BEFORE the first one starts blank even on `continue`", () => {
    // Nothing is held there yet — there is no earlier drawing to continue.
    const early = [{ ...tracks[0]!, keys: [{ id: "k1", timeMs: 200, value: "surf-b", easing: lin }] }];
    expect(plan({ tracks: early, localMs: 40, recording: true }))
      .toEqual({ kind: "new", keyTimeMs: 40, seedFrom: null });
  });

  it("edits the frame you are STANDING ON, anywhere inside its own frame", () => {
    // The bug this pins: a key is authored at the render clock's instant, but a
    // playhead a few ms further into the SAME frame used to miss it and stamp a
    // duplicate — so the snapshot only appeared after stepping forward.
    expect(plan({ localMs: 215 })).toEqual({ kind: "edit", keyTimeMs: 200, value: "surf-b" });
    expect(plan({ localMs: 239.4 })).toEqual({ kind: "edit", keyTimeMs: 200, value: "surf-b" });
    // The next frame along is genuinely a new one.
    expect(plan({ localMs: 240 })).toMatchObject({ kind: "new", seedFrom: "surf-b" });
  });

  it("resolves a key stored just off the grid to the frame it looks like", () => {
    // Keys written by an earlier build sit a hair past their grid instant.
    const off = [{ ...tracks[0]!, keys: [{ id: "k1", timeMs: 200.4, value: "surf-b", easing: lin }] }];
    expect(plan({ tracks: off, localMs: 200 })).toMatchObject({ kind: "edit", value: "surf-b" });
  });
});

describe("capture cursor (which frame a moment addresses)", () => {
  const FPS = 25; // 40ms frames
  const times = [0, 200, 400];

  it("is ON a frame anywhere inside that frame, not only at its exact ms", () => {
    expect(captureCursor(times, 200, FPS)).toEqual({ index: 1, onFrame: true });
    expect(captureCursor(times, 231, FPS)).toEqual({ index: 1, onFrame: true });
  });

  it("is in a GAP once the next render frame starts", () => {
    expect(captureCursor(times, 240, FPS)).toEqual({ index: 1, onFrame: false });
  });

  it("is before everything until the first frame begins", () => {
    expect(captureCursor([200], 0, FPS)).toEqual({ index: -1, onFrame: false });
  });
});

describe("vector brush strokes (the shared rasterizer)", () => {
  const line = (n: number, pressure = 1) =>
    Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0, pressure }));
  const brush = (vector: Record<string, unknown> = {}, strokePath: Record<string, unknown> = {}) =>
    createBrushPreset({ name: "v", engine: "vector", vector, strokePath } as never);

  it("a uniform brush fits ONE open centre line carrying the brush's stroke stack", () => {
    const s = vectorStroke(line(8), brush(), 6)!;
    expect(s.subpaths).toHaveLength(1);
    expect(s.subpaths[0]!.closed).toBe(false);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]!.width).toBe(6);
    expect(s.lines[0]!.profile.samples).toBeNull();
  });

  it("a pressure brush stays a CENTRE LINE — the width comes back as a measurement", () => {
    const s = vectorStroke(line(8), brush({ variableWidth: true }), 6)!;
    // Not baked into a filled ribbon: the geometry is still the open line, so
    // the width, colour, caps and dash all stay editable afterwards.
    expect(s.subpaths[0]!.closed).toBe(false);
    // …and not baked into the brush's line stack either. The curve is handed
    // back for the caller to place on the CONTOUR it was drawn on, so the next
    // stroke on the same layer does not inherit this one's pressure.
    expect(s.lines[0]!.profile.samples).toBeNull();
    const widths = s.widths!;
    expect(widths.length).toBeGreaterThan(1);
    expect(Math.max(...widths)).toBeCloseTo(6, 6);
    // As profile samples they are multipliers on whatever width they land on.
    expect(Math.max(...widthProfileSamples(widths, 6))).toBeCloseTo(1, 6);
  });

  it("pressure drives width, floored by minWidth", () => {
    const b = brush({ variableWidth: true, widthPressure: 1, minWidth: 0.25 });
    const w = vectorStrokeWidths(line(4, 0), b, 20);
    expect(w.every((x) => Math.abs(x - 5) < 1e-9)).toBe(true);
  });

  it("taper is measured in px along the line, from both ends", () => {
    // 4 points, 10px apart → 30px long; a 30px taper reaches full width only
    // at the far end, so the profile must rise then fall.
    const w = vectorStrokeWidths(
      line(4),
      brush({ variableWidth: true, widthPressure: 0 }, { taperStartPx: 30, taperEndPx: 30 }),
      20,
    );
    expect(w[0]!).toBeLessThan(w[1]!);
    expect(w[3]!).toBeLessThan(w[2]!);
  });

  it("closes a loop when the ends meet inside autoClosePx", () => {
    const loop = [
      { x: 0, y: 0, pressure: 1 },
      { x: 40, y: 0, pressure: 1 },
      { x: 40, y: 40, pressure: 1 },
      { x: 0, y: 40, pressure: 1 },
      { x: 3, y: 3, pressure: 1 },
    ];
    expect(vectorStroke(loop, brush({ autoClosePx: 10 }), 4)!.subpaths[0]!.closed).toBe(true);
    expect(vectorStroke(loop, brush({ autoClosePx: 0 }), 4)!.subpaths[0]!.closed).toBe(false);
  });

  it("a tap draws nothing", () => {
    expect(vectorStroke([{ x: 0, y: 0, pressure: 1 }], brush(), 4)).toBeNull();
  });
});

describe("paint-target resolution (draw on the selected layer, else make a clip)", () => {
  it("paints a selected pixel layer's own surface", () => {
    expect(resolvePaintTarget({ id: "r1", kind: "raster" }, "raster")).toEqual({ kind: "edit", clipId: "r1", surface: "own" });
  });
  // Anything the renderer can DRAW takes an overlay: a photo, a video, a nested
  // comp, a graded adjustment, text, a vector outline. The media is never
  // touched and the marks live on their own layer beside it — so the set is
  // "everything visual", not a hand-picked four.
  it("paints a non-destructive overlay on anything visual", () => {
    for (const kind of ["image", "video", "path", "shape", "nested", "text", "adjustment", "waveform"] as const) {
      expect(resolvePaintTarget({ id: "c1", kind }, "raster")).toEqual({
        kind: "edit",
        clipId: "c1",
        surface: "overlay",
      });
    }
  });
  it("spawns a fresh raster layer when nothing paintable is selected", () => {
    expect(resolvePaintTarget(null, "raster")).toEqual({ kind: "new", clipKind: "raster" });
    // Audio has no picture to paint on, so it is the one thing that still falls
    // through to a layer of its own.
    expect(resolvePaintTarget({ id: "a1", kind: "audio" }, "raster")).toEqual({ kind: "new", clipKind: "raster" });
  });
  it("vector on a pixel layer is impossible → makes a new path clip", () => {
    expect(resolvePaintTarget({ id: "r1", kind: "raster" }, "vector")).toEqual({ kind: "new", clipKind: "path" });
    expect(resolvePaintTarget(null, "vector")).toEqual({ kind: "new", clipKind: "path" });
  });
  it("vector appends to a selected path clip", () => {
    expect(resolvePaintTarget({ id: "p1", kind: "path" }, "vector")).toEqual({ kind: "edit", clipId: "p1", surface: "own" });
  });
});

// ── Text content schedule (epochs, cohorts, humanisation) ────────────────────

describe("text content schedule", () => {
  const textClip = (text: string, durationMs = 4000) =>
    createTextClip({ frameId: "f", text, startMs: 0, durationMs, presetId: "typewriter" });

  const wordSpec = (over: Partial<AnimationSpec> = {}): AnimationSpec => ({
    ...specFromPreset("fade-up"),
    unit: "word",
    durationMs: 200,
    staggerMs: 100,
    jitterMs: 0,
    ...over,
  });

  it("static content is ONE epoch spanning the clip (the pre-keyframe behaviour)", () => {
    const clip = textClip("A B");
    const tl = textTimelineOf(clip);
    expect(tl.epochs).toHaveLength(1);
    expect(tl.epochs[0]!.fromMs).toBe(0);
    expect(tl.epochs[0]!.toMs).toBe(4000);
    expect(tl.epochs[0]!.enterAtMs.every((t) => t === 0)).toBe(true);
    expect(tl.epochs[0]!.exitAtMs.every((t) => t === 4000)).toBe(true);
  });

  it("a content keyframe splits the clip into epochs with per-glyph lifespans", () => {
    const clip = textClip("A B C D");
    setKeyframe(clip.keyframes, "text", 0, "A B C D");
    setKeyframe(clip.keyframes, "text", 1000, "A E F G");
    const tl = textTimelineOf(clip);
    expect(tl.epochs.map((e) => e.text)).toEqual(["A B C D", "A E F G"]);

    // Epoch 0: "A " survives to the clip end, "B C D" must be gone by the cut.
    const first = tl.epochs[0]!;
    expect(first.exitAtMs.slice(0, 2)).toEqual([4000, 4000]); // "A", " "
    expect(first.exitAtMs.slice(2)).toEqual([1000, 1000, 1000, 1000, 1000]); // "B C D"

    // Epoch 1: "A " kept its original arrival, "E F G" arrive at the cut.
    const second = tl.epochs[1]!;
    expect(second.enterAtMs.slice(0, 2)).toEqual([0, 0]);
    expect(second.enterAtMs.slice(2).every((t) => t === 1000)).toBe(true);
  });

  it("an arriving cohort staggers from ZERO, not from its position in the line", () => {
    const clip = textClip("A B C D");
    setKeyframe(clip.keyframes, "text", 0, "A B C D");
    setKeyframe(clip.keyframes, "text", 1000, "A E F G");
    clip.animations.in = wordSpec();
    const ins = textUnitEvents(clip).filter((e) => e.phase === "in");
    // Epoch 0 types all four words on the usual grid; then E/F/G arrive at the
    // cut on 0/100/200 — NOT +100/200/300, which would hold the new words
    // hostage to stagger slots that words "B C D" used a second ago.
    expect(ins.map((e) => e.atMs)).toEqual([0, 100, 200, 300, 1000, 1100, 1200]);
  });

  it("a departing cohort FINISHES at the cut, so only one content string is ever on screen", () => {
    const clip = textClip("A B C D");
    setKeyframe(clip.keyframes, "text", 0, "A B C D");
    setKeyframe(clip.keyframes, "text", 1000, "A E F G");
    clip.animations.in = wordSpec();
    clip.animations.out = wordSpec();
    const outs = textUnitEvents(clip).filter((e) => e.phase === "out" && e.atMs < 900);
    // B/C/D: span = 2*100 + 200 = 400, anchored to finish at 1000 → 600/700/800.
    expect(outs.map((e) => e.atMs)).toEqual([600, 700, 800]);
    // Each starts + its own duration lands at or before the cut.
    expect(outs.every((e) => e.atMs + 200 <= 1000)).toBe(true);
  });

  it("a surviving glyph enters and leaves exactly once across many cuts", () => {
    const clip = textClip("A B");
    setKeyframe(clip.keyframes, "text", 0, "A B");
    setKeyframe(clip.keyframes, "text", 1000, "A C");
    setKeyframe(clip.keyframes, "text", 2000, "A D");
    clip.animations.in = wordSpec();
    clip.animations.out = wordSpec();
    const forA = textUnitEvents(clip).filter((e) => e.graphemeIndex === 0);
    expect(forA.filter((e) => e.phase === "in")).toHaveLength(1);
    expect(forA.filter((e) => e.phase === "out")).toHaveLength(1);
    expect(forA.find((e) => e.phase === "in")!.atMs).toBe(0);
  });

  it("re-keying the SAME words is not a content change", () => {
    const clip = textClip("hello");
    setKeyframe(clip.keyframes, "text", 0, "hello");
    setKeyframe(clip.keyframes, "text", 900, "hello");
    expect(textTimelineOf(clip).epochs).toHaveLength(1);
  });

  it("rebuilds when a clip is mutated in place (core edits are not copies)", () => {
    const clip = textClip("one");
    expect(effectiveText(clip, 500)).toBe("one");
    setKeyframe(clip.keyframes, "text", 0, "one");
    setKeyframe(clip.keyframes, "text", 400, "two");
    expect(effectiveText(clip, 500)).toBe("two");
    clip.durationMs = 9000;
    expect(textTimelineOf(clip).epochs[0]!.toMs).toBe(400);
    expect(textTimelineOf(clip).epochs[1]!.toMs).toBe(9000);
  });

  it("jitter only ever LAGS entrances and ADVANCES exits, deterministically", () => {
    const clip = textClip("alpha beta gamma delta");
    clip.animations.in = wordSpec({ jitterMs: 80 });
    clip.animations.out = wordSpec({ jitterMs: 80 });
    const evs = textUnitEvents(clip);
    const ins = evs.filter((e) => e.phase === "in").map((e) => e.atMs);
    const outs = evs.filter((e) => e.phase === "out").map((e) => e.atMs);
    // Unjittered grid is 0/100/200/300 in, and 3400/3500/3600/3700 out.
    ins.forEach((t, i) => {
      expect(t).toBeGreaterThanOrEqual(i * 100);
      expect(t).toBeLessThanOrEqual(i * 100 + 80);
    });
    outs.forEach((t) => expect(t + 200).toBeLessThanOrEqual(4000));
    expect(ins.some((t, i) => t !== i * 100)).toBe(true); // it actually moved
    expect(textUnitEvents(clip).map((e) => e.atMs)).toEqual(evs.map((e) => e.atMs));
  });

  it("scatter fades to nothing, so the resting layout stays exact", () => {
    const clip = textClip("wobble");
    clip.animations.in = wordSpec({ scatterPx: 40, scatterDeg: 20, durationMs: 400, staggerMs: 0 });
    const seg = segmentTextCached("wobble");
    const settled = evaluateTextGlyphs(clip, seg, 400);
    expect(settled.every((g) => Math.abs(g.dx) < 1e-9 && Math.abs(g.rotation) < 1e-9)).toBe(true);
    const mid = evaluateTextGlyphs(clip, seg, 100);
    expect(mid.some((g) => g.dx !== 0)).toBe(true);
  });
});

describe("text sound follows the schedule", () => {
  const soundedClip = (doc: MotionDocument, text: string) => {
    const clip = createTextClip({
      frameId: frameIdOf(doc),
      text,
      startMs: 0,
      durationMs: 4000,
      presetId: "typewriter",
    });
    clip.animations.in = { ...specFromPreset("typewriter"), unit: "word", staggerMs: 100, jitterMs: 0 };
    clip.sounds = [makeSoundLayer({ kind: "text" }, "in")];
    doc.tracks[0]!.clips.push(clip);
    return clip;
  };

  it("KEYFRAMED content still clicks — and clicks the words actually on screen", () => {
    const doc = createEmptyDocument();
    const clip = soundedClip(doc, "A B C D");
    setKeyframe(clip.keyframes, "text", 0, "A B C D");
    setKeyframe(clip.keyframes, "text", 1000, "A E F G");
    const cues = buildSoundCues(doc, 0, 10000);
    // 4 words at the start + the 3 that arrive at the cut = 7 (the "A" that
    // survives is not retyped). Before the schedule existed this was silent.
    expect(cues).toHaveLength(7);
    expect(cues.map((c) => c.timeMs)).toEqual([0, 100, 200, 300, 1000, 1100, 1200]);
  });

  it("the OUT voice sounds departures, independently of the IN voice", () => {
    const doc = createEmptyDocument();
    const clip = soundedClip(doc, "A B C D");
    setKeyframe(clip.keyframes, "text", 0, "A B C D");
    setKeyframe(clip.keyframes, "text", 1000, "A E F G");
    clip.animations.out = { ...specFromPreset("fade"), unit: "word", durationMs: 200, staggerMs: 100, jitterMs: 0 };
    clip.sounds = [makeSoundLayer({ kind: "text" }, "out", { pack: "soft" })];
    const cues = buildSoundCues(doc, 0, 10000);
    expect(cues.every((c) => c.pack === "soft")).toBe(true);
    // B/C/D leaving at the cut, then all four survivors leaving at the end.
    expect(cues.filter((c) => c.timeMs < 900).map((c) => c.timeMs)).toEqual([600, 700, 800]);
    expect(cues.filter((c) => c.timeMs > 900)).toHaveLength(4);
  });

  it("a cue carries the SAME seed the renderer humanised its unit with", () => {
    const doc = createEmptyDocument();
    const clip = soundedClip(doc, "tick tock");
    clip.animations.in = { ...clip.animations.in!, jitterMs: 90 };
    const cues = buildSoundCues(doc, 0, 10000);
    const evs = textUnitEvents(clip).filter((e) => e.phase === "in");
    expect(cues.map((c) => c.seed)).toEqual(evs.map((e) => e.seed));
    expect(cues.map((c) => c.timeMs)).toEqual(evs.map((e) => e.atMs));
  });

  it("a range overrides only the stack entry it names", () => {
    const doc = createEmptyDocument();
    const clip = soundedClip(doc, "aa bb");
    clip.ranges = applyRangePatch(clip.ranges, 3, 5, { sounds: { [clip.sounds[0]!.id]: { pack: "pop" } } });
    const cues = buildSoundCues(doc, 0, 10000);
    expect(cues.map((c) => c.pack)).toEqual(["mechanical", "pop"]);
  });
});

describe("typing caret (derived, never stored)", () => {
  const typed = () => {
    const clip = createTextClip({
      frameId: "f",
      text: "ab cd",
      startMs: 0,
      durationMs: 4000,
      presetId: "typewriter",
    });
    clip.animations.in = { ...specFromPreset("typewriter"), unit: "letter", staggerMs: 100, jitterMs: 0 };
    clip.caret = defaultTextCaret({ enabled: true, blinkMs: 0 });
    return clip;
  };

  it("disabled → nothing to draw, but the tuning survives the switch", () => {
    const clip = typed();
    clip.caret = { ...clip.caret, style: "block", enabled: false };
    expect(caretAt(clip, 100)).toBeNull();
    clip.caret.enabled = true;
    expect(clip.caret.style).toBe("block");
    expect(caretAt(clip, 100)).not.toBeNull();
  });

  it("follows the typing head, one grapheme past the last unit that started", () => {
    const clip = typed();
    expect(caretAt(clip, 0)!.graphemeIndex).toBe(1); // "a" typed
    expect(caretAt(clip, 250)!.graphemeIndex).toBe(3); // through the space
    expect(caretAt(clip, 350)!.graphemeIndex).toBe(4);
  });

  it("vanishes when typing ends unless it persists", () => {
    const clip = typed();
    expect(caretAt(clip, 3000)).toBeNull();
    clip.caret = { ...clip.caret, persist: true };
    expect(caretAt(clip, 3000)!.graphemeIndex).toBe(5);
  });

  it("holds solid while typing and blinks from the LAST keystroke, not the clip start", () => {
    const clip = typed();
    clip.caret = { ...clip.caret, blinkMs: 500, persist: true };
    // "ab cd" types on 0/100/…/400, so at 450 the last keystroke was 50ms ago:
    // solid, even though a clip-start grid would have flipped it off at 500.
    expect(caretAt(clip, 450)!.lit).toBe(true);
    expect(caretAt(clip, 600)!.lit).toBe(true);
    // Idle after the last keystroke (400) it blinks on its own period.
    expect(caretAt(clip, 950)!.lit).toBe(false);
    expect(caretAt(clip, 1450)!.lit).toBe(true);
    expect(caretAt(clip, 950)!.lit).toBe(false); // no wall clock anywhere
  });

  it("jumps to the new cohort after a content keyframe", () => {
    const clip = typed();
    setKeyframe(clip.keyframes, "text", 0, "ab");
    setKeyframe(clip.keyframes, "text", 1000, "ab xyz");
    expect(caretAt(clip, 1000)!.text).toBe("ab xyz");
    // The space takes the first slot of the arriving cohort, so at the cut the
    // head has moved past it and "x" lands one stagger later.
    expect(caretAt(clip, 1000)!.graphemeIndex).toBe(3);
    expect(caretAt(clip, 1100)!.graphemeIndex).toBe(4);
  });
});

describe("delay is symmetric against each phase's own edge", () => {
  it("pushes an entrance later and pulls an exit earlier", () => {
    const clip = createTextClip({ frameId: "f", text: "a b", startMs: 0, durationMs: 2000 });
    const base = { ...specFromPreset("fade"), unit: "word" as const, durationMs: 100, staggerMs: 50, jitterMs: 0 };
    clip.animations.in = { ...base, delayMs: 300 };
    clip.animations.out = { ...base, delayMs: 300 };
    const evs = textUnitEvents(clip);
    expect(evs.filter((e) => e.phase === "in").map((e) => e.atMs)).toEqual([300, 350]);
    // span = 50 + 100 = 150; deadline 2000 − 300 delay → last unit ends at 1700.
    const outs = evs.filter((e) => e.phase === "out").map((e) => e.atMs);
    expect(outs).toEqual([1550, 1600]);
    expect(Math.max(...outs) + 100).toBe(1700);
  });
});

describe("text box size is a first-class animatable property", () => {
  it("is in the registry for text, and surfaces on the pose when keyed", () => {
    expect(propertyDef("maxWidth")?.appliesTo).toContain("text");
    const clip = createTextClip({ frameId: "f", text: "wrap me", startMs: 0, durationMs: 2000 });
    clip.maxWidth = 400;
    // Unkeyed: no override, so the layout falls through to the clip's own value.
    expect(evaluateClipPose(clip, 500).maxWidthOverride).toBeUndefined();
    setKeyframe(clip.keyframes, "maxWidth", 0, 400);
    setKeyframe(clip.keyframes, "maxWidth", 1000, 800);
    expect(evaluateClipPose(clip, 0).maxWidthOverride).toBe(400);
    expect(evaluateClipPose(clip, 500).maxWidthOverride).toBe(600); // tweens
    expect(evaluateClipPose(clip, 1000).maxWidthOverride).toBe(800);
  });
});

describe("tangent drag: a node behaves how it looks, and ⌥ toggles that", () => {
  const drag = (symmetric: boolean, alt: boolean) =>
    resolveTangentDrag({ symmetric }, { vector: { x: 0, y: 10 }, alt, shift: false, dissolveWithin: 1 });

  it("reads whether a pair is balanced, forgivingly", () => {
    expect(isMirroredPair({ x: 10, y: 0 }, { x: -10, y: 0 })).toBe(true);
    // Rounded by a drag, but plainly still the smooth node the user made.
    expect(isMirroredPair({ x: 10, y: 0 }, { x: -10.02, y: 0.05 })).toBe(true);
    expect(isMirroredPair({ x: 10, y: 0 }, { x: 0, y: 5 })).toBe(false); // 90° apart
    expect(isMirroredPair({ x: 10, y: 0 }, { x: -5, y: 0 })).toBe(false); // half length
    expect(isMirroredPair({ x: 10, y: 0 }, null)).toBe(false); // nothing to pair with
  });

  it("⌥ always means 'do the other one', whichever node you grabbed", () => {
    // Balanced node: plain keeps them together, ⌥ breaks the pair.
    expect(shouldPairTangents(true, false)).toBe(true);
    expect(shouldPairTangents(true, true)).toBe(false);
    // Broken node: the opposite — plain leaves it broken, ⌥ balances it.
    expect(shouldPairTangents(false, false)).toBe(false);
    expect(shouldPairTangents(false, true)).toBe(true);
  });

  it("moves the partner exactly when the toggle says so", () => {
    expect(drag(true, false).partner).toEqual({ x: -0, y: -10 }); // balanced, plain
    expect(drag(true, true).partner).toBe(null); // balanced + ⌥ = break
    expect(drag(false, false).partner).toBe(null); // broken, plain
    expect(drag(false, true).partner).toEqual({ x: -0, y: -10 }); // broken + ⌥ = balance
  });

  it("dissolves into a corner, and that outranks any pairing", () => {
    const res = resolveTangentDrag(
      { symmetric: true },
      { vector: { x: 0.5, y: 0 }, alt: false, shift: false, dissolveWithin: 4 },
    );
    expect(res.dragged).toBe(null);
    expect(res.partner).toBe(null);
  });

  it("⇧ locks the arm to a 15° ray before anything else looks at it", () => {
    const res = resolveTangentDrag(
      { symmetric: true },
      { vector: { x: 100, y: 4 }, alt: false, shift: true, dissolveWithin: 1 },
    );
    expect(res.dragged!.y).toBeCloseTo(0, 6); // snapped flat
    // The partner is balanced against the CONSTRAINED arm, not the raw pointer.
    expect(res.partner!.y).toBeCloseTo(0, 6);
  });

  it("freezes the node's state at press, so ⌥ can't fight itself mid-drag", () => {
    // A broken pair, grabbed. ⌥ balances it — but the FROZEN answer stays
    // "broken", so every later move keeps balancing instead of flip-flopping.
    const start = beginTangentDrag({ x: 10, y: 0 }, { x: 0, y: 5 });
    expect(start.symmetric).toBe(false);
    for (const v of [{ x: 0, y: 10 }, { x: 3, y: 9 }, { x: 8, y: 2 }]) {
      const res = resolveTangentDrag(start, { vector: v, alt: true, shift: false, dissolveWithin: 1 });
      expect(res.partner).toEqual({ x: -v.x, y: -v.y });
    }
  });
});

describe("inserting a motion key cuts the easing instead of copying it", () => {
  it("keeps an EASED segment's timing identical at every moment", () => {
    const host = {
      transform: { x: 0, y: 0 },
      keyframes: [] as ReturnType<typeof createEmptyDocument>["frames"][number] extends never ? never : never,
    } as unknown as { keyframes: Parameters<typeof motionKeysOf>[0]["keyframes"]; transform: { x: number; y: number } };
    host.keyframes = [];
    // A pronounced ease-in-out — the exact shape that used to double up into a
    // stall when both halves inherited the whole curve.
    const ease: Easing = { kind: "bezier", values: [0.9, 0, 0.1, 1] };
    setKeyframe(host.keyframes, "x", 0, 0, ease);
    setKeyframe(host.keyframes, "y", 0, 0, ease);
    setKeyframe(host.keyframes, "x", 1000, 400);
    setKeyframe(host.keyframes, "y", 1000, 200);

    const sampleAt = [100, 250, 400, 500, 600, 750, 900];
    const before = sampleAt.map((t) => sampleKeyframes(host.keyframes, t));

    const keys = motionKeysOf(host);
    insertMotionKey(host, keys[0]!, keys[1]!, 0.5);
    expect(motionKeysOf(host)).toHaveLength(3);

    // The layer is in the same place at the same moment — adding a handle
    // changed what you can edit, not what plays.
    sampleAt.forEach((t, i) => {
      expect(sampleKeyframes(host.keyframes, t)["x"] as number).toBeCloseTo(before[i]!["x"] as number, 2);
      expect(sampleKeyframes(host.keyframes, t)["y"] as number).toBeCloseTo(before[i]!["y"] as number, 2);
    });
  });

  it("splitEasing halves compose back to the original curve", () => {
    const ease: Easing = { kind: "bezier", values: [0.9, 0, 0.1, 1] };
    const [a, b] = splitEasing(ease, 0.5);
    // Walk both halves and compare against the original at the same global time.
    for (let i = 0; i <= 10; i++) {
      const g = i / 10;
      const whole = evaluateEasing(ease, g);
      const half = g <= 0.5 ? evaluateEasing(a, g / 0.5) : evaluateEasing(b, (g - 0.5) / 0.5);
      // Halves are renormalized into their own boxes, so rescale back out.
      const mid = evaluateEasing(ease, 0.5);
      const rebuilt = g <= 0.5 ? half * mid : mid + half * (1 - mid);
      expect(rebuilt).toBeCloseTo(whole, 2);
    }
    // Linear stays exactly linear — no algebra, no drift.
    expect(splitEasing({ kind: "linear" }, 0.37)).toEqual([{ kind: "linear" }, { kind: "linear" }]);
  });
});
