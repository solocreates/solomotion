import { describe, expect, it } from "vitest";
import { createEmptyDocument, createTextClip } from "../factories";
import { placeClip } from "../timeline/place";
import { locateClip } from "../timeline/ops";
import { frameLayerTree } from "../timeline/layer-tree";
import { createMeshClip, createWorld, texturePaintLayer } from "./ops";
import type { MeshClip } from "../schema";

describe("painting on a mesh", () => {
  it("a bare mesh gets a texture comp: its own colour as a base coat, a drawing layer on top; again reuses it", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const ball = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 4000, primitive: "uvSphere", color: "#3366ff" });
    placeClip(doc, ball, { landing: "surface" });
    const first = texturePaintLayer(doc, ball.id)!;
    const mesh = locateClip(doc, ball.id)!.clip as MeshClip;
    expect(mesh.texture?.frameId).toBe(first.frameId);
    const tree = frameLayerTree(doc, first.frameId);
    expect(tree.map((n) => (n.type === "clip" ? n.clip.kind : n.type))).toEqual(["raster", "shape"]);
    const coat = tree[1]!.type === "clip" ? tree[1]!.clip : null;
    expect(coat && "fills" in coat && coat.fills[0]).toMatchObject({ type: "solid", color: "#3366ff" });
    expect(texturePaintLayer(doc, ball.id)).toEqual(first);
  });

  it("a texture whose top layer is a design gets its own drawing layer on top — the design is never painted into", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const box = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 4000, primitive: "cube" });
    placeClip(doc, box, { landing: "surface" });
    const made = texturePaintLayer(doc, box.id)!;
    const label = createTextClip({ frameId: made.frameId, startMs: 0, durationMs: 4000, text: "Label" });
    placeClip(doc, label, { landing: "surface" });
    const next = texturePaintLayer(doc, box.id)!;
    expect(next.rasterId).not.toBe(made.rasterId);
    const top = frameLayerTree(doc, made.frameId)[0]!;
    expect(top.type === "clip" && top.clip.id).toBe(next.rasterId);
  });
});
