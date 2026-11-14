import { describe, expect, it } from "vitest";
import type { ShapeKey } from "../schema";
import { createEmptyDocument } from "../factories";
import { placeClip } from "../timeline/place";
import { locateClip } from "../timeline/ops";
import { createMeshClip, createWorld } from "./ops";
import { applyFacePoses, normalizeKeyName, recognizeFace } from "./face-presets";

const keys = (...names: string[]): ShapeKey[] => names.map((name, i) => ({ id: `k${i}`, name, source: { kind: "asset", target: name } }));
const idOf = (ks: ShapeKey[], name: string) => ks.find((k) => k.name === name)!.id;

describe("face conventions", () => {
  it("reads ARKit name variants as one key", () => {
    for (const n of ["jawOpen", "JawOpen", "jaw_open", "blendShape1.jawOpen", "ARKit_jawOpen", "Face:jaw-open"]) expect(normalizeKeyName(n)).toBe("jawopen");
    expect(normalizeKeyName("eyeBlinkLeft")).toBe(normalizeKeyName("eyeBlink_L"));
    expect(normalizeKeyName("mouthSmileRight")).toBe(normalizeKeyName("mouthSmile_R"));
  });

  it("ARKit-52 → viseme mixes from the lipsync weight table", () => {
    const ks = keys("JawOpen", "mouth_funnel", "mouthPucker", "mouthSmile_L", "mouthSmile_R", "mouthStretchLeft", "mouthStretchRight", "eyeBlink_L", "eyeBlink_R");
    const f = recognizeFace(ks);
    expect(f.convention).toBe("arkit");
    const ai = f.visemes.find((v) => v.name === "AI")!.weights;
    const u = f.visemes.find((v) => v.name === "U")!.weights;
    expect(ai[idOf(ks, "JawOpen")]).toBeGreaterThan(u[idOf(ks, "JawOpen")]!);
    expect(u[idOf(ks, "mouthPucker")]).toBeGreaterThan(0.5);
    // Every pose lists every key the set touches, so blends are well defined.
    const touched = Object.keys(ai).sort();
    for (const v of f.visemes) expect(Object.keys(v.weights).sort()).toEqual(touched);
    // X is the rest: nothing but a breath of jaw.
    expect(Math.max(...Object.values(f.visemes.find((v) => v.name === "X")!.weights))).toBeLessThan(0.05);
    expect(f.eyes.map((e) => e.name)).toEqual(["Open", "Half", "Closed"]);
    expect(f.eyes[2]!.weights).toEqual({ [idOf(ks, "eyeBlink_L")]: 1, [idOf(ks, "eyeBlink_R")]: 1 });
  });

  it("VRoid VRM (Fcl_MTH_A …) → vowels; Fcl_EYE_Close_L/R → eyes", () => {
    const ks = keys("Fcl_ALL_Neutral", "Fcl_MTH_A", "Fcl_MTH_I", "Fcl_MTH_U", "Fcl_MTH_E", "Fcl_MTH_O", "Fcl_MTH_Close", "Fcl_EYE_Close", "Fcl_EYE_Close_L", "Fcl_EYE_Close_R");
    const f = recognizeFace(ks);
    expect(f.convention).toBe("vrm");
    expect(f.visemes.find((v) => v.name === "AI")!.weights[idOf(ks, "Fcl_MTH_A")]).toBe(1);
    expect(f.visemes.find((v) => v.name === "MBP")!.weights[idOf(ks, "Fcl_MTH_Close")]).toBe(1);
    expect(Object.entries(f.eyes[2]!.weights).filter(([, w]) => w === 1).map(([id]) => id).sort()).toEqual([idOf(ks, "Fcl_EYE_Close_L"), idOf(ks, "Fcl_EYE_Close_R")].sort());
  });

  it("Ready Player Me: Oculus visemes win over its ARKit shapes", () => {
    const oculus = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U"].map((n) => `viseme_${n}`);
    const ks = keys(...oculus, "jawOpen", "mouthFunnel", "mouthPucker", "eyeBlinkLeft", "eyeBlinkRight");
    const f = recognizeFace(ks);
    expect(f.convention).toBe("oculus");
    expect(f.visemes.find((v) => v.name === "AI")!.weights[idOf(ks, "viseme_aa")]).toBe(1);
    expect(f.visemes.find((v) => v.name === "U")!.weights[idOf(ks, "viseme_U")]).toBe(1);
    expect(f.missing).toEqual([]);
  });

  it("the built-in head's own viseme names map 1:1; unknown faces are refused", () => {
    const ks = keys("AI", "E", "O", "U", "MBP", "FV", "L", "S", "eyeBlink_L", "eyeBlink_R");
    const f = recognizeFace(ks);
    expect(f.convention).toBe("visemes");
    expect(f.visemes.find((v) => v.name === "FV")!.weights[idOf(ks, "FV")]).toBe(1);
    const none = recognizeFace(keys("Smile", "Frown"));
    expect(none.convention).toBeNull();
    expect(none.eyes).toEqual([]);
  });
});

describe("applyFacePoses", () => {
  it("wraps the face in a group and builds Mouth + Eyes sets; re-running keeps set ids", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const mesh = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 1000, assetId: "asset_x", name: "Avatar" });
    mesh.shapeKeys = keys("jawOpen", "mouthFunnel", "mouthPucker", "mouthSmileLeft", "mouthSmileRight", "eyeBlinkLeft", "eyeBlinkRight");
    placeClip(doc, mesh);
    const r = applyFacePoses(doc, mesh.id)!;
    expect(r.convention).toBe("arkit");
    const group = locateClip(doc, r.groupId)!.clip;
    expect(group.kind === "group" && group.poses!.map((s) => [s.name, s.vocabulary, s.show])).toEqual([
      ["Mouth", "visemes", "X"],
      ["Eyes", "eyes", "Open"],
    ]);
    const mouth = group.kind === "group" ? group.poses![0]! : null;
    expect(mouth!.poses.map((p) => p.name)).toEqual(["X", "MBP", "S", "E", "AI", "O", "U", "FV", "L"]);
    expect(mouth!.poses.find((p) => p.name === "AI")!.values.find((v) => v.path === `key.${idOf(mesh.shapeKeys!, "jawOpen")}`)!.value).toBeCloseTo(0.6);
    const again = applyFacePoses(doc, mesh.id)!;
    expect(again.groupId).toBe(r.groupId);
    expect([again.mouthSetId, again.eyesSetId]).toEqual([r.mouthSetId, r.eyesSetId]);
  });
});
