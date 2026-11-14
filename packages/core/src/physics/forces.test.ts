import { describe, expect, it } from "vitest";
import { parseDocument, serializeDocument } from "../io";
import { createEmptyDocument } from "../factories";
import { createEmptyClip } from "../world/ops";
import { placeClip } from "../timeline/place";
import { getClipProperty, setClipProperty } from "../animation/paths";
import { clipAnimatableProperties } from "../animation/clip-properties";
import { FORCE } from "./forces";

describe("forces as a stack", () => {
  it("a v92 layer's one field becomes the first card, its keys, modulators and drivers re-addressed", () => {
    const doc = createEmptyDocument();
    const e = createEmptyClip({ frameId: doc.frames[0]!.id, startMs: 0, durationMs: 4000, name: "Wind" });
    placeClip(doc, e);
    const raw = JSON.parse(serializeDocument(doc));
    raw.version = 92;
    const clip = raw.tracks.flatMap((t: { clips: Array<Record<string, unknown>> }) => t.clips).find((c: { id: string }) => c.id === e.id);
    clip.field = { type: "vortex", strength: 700, radius: 300, falloff: "linear", scale: 240, seed: 0, enabled: true };
    clip.keyframes = [{ id: "k", property: "field.strength", keys: [{ id: "a", timeMs: 0, value: 0, easing: { kind: "linear" } }] }];
    clip.drivers = { "field.radius": "time * 10" };
    const out = parseDocument(JSON.stringify(raw));
    const c = out.tracks.flatMap((t) => t.clips).find((x) => x.id === e.id)!;
    if (c.kind === "audio") throw new Error("not visual");
    expect(c.forces).toHaveLength(1);
    const f = c.forces![0]!;
    expect(f).toMatchObject({ type: "vortex", strength: 700, radius: 300, falloff: "linear" });
    expect(c.keyframes[0]!.property).toBe(`force.${f.id}.strength`);
    expect(Object.keys(c.drivers ?? {})).toEqual([`force.${f.id}.radius`]);
    expect("field" in c).toBe(false);
  });

  it("every card's numbers are properties: read, written, listed — repeats each their own", () => {
    const doc = createEmptyDocument();
    const e = createEmptyClip({ frameId: doc.frames[0]!.id, startMs: 0, durationMs: 4000 });
    const a = FORCE.create("wind"), b = FORCE.create("wind");
    e.forces = [a, b];
    setClipProperty(e, `force.${b.id}.strength`, 123);
    expect(getClipProperty(e, `force.${a.id}.strength`)).toBe(600);
    expect(getClipProperty(e, `force.${b.id}.strength`)).toBe(123);
    const paths = clipAnimatableProperties(e).map((p) => p.path);
    expect(paths).toContain(`force.${a.id}.strength`);
    expect(paths).toContain(`force.${b.id}.radius`);
  });
});
