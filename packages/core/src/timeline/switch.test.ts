import { describe, expect, it } from "vitest";
import type { GroupClip, ShapeClip } from "../schema";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { addVariant, makeComponent, renameVariant } from "../components";
import { setClipProperty } from "../animation/paths";
import { locateClip } from "./ops";
import { groupBoxAt } from "./group-bounds";
import { hiddenBySwitch, switchOptions } from "./switch";
import { makeSwitch, setSwitch, switchFromVariants, unmakeSwitch } from "./switch-ops";

/** Three eye states stacked in one place, at different sizes so the box tells them apart. */
function eyes() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const add = (name: string, height: number) => {
    const c = createShapeClip({ frameId, shape: "ellipse", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 60, height }) as ShapeClip;
    c.name = name;
    const lane = createTrack(name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  const open = add("Open", 40), half = add("Half", 20), closed = add("Closed", 4);
  const id = makeSwitch(doc, [open.id, half.id, closed.id], { name: "Eye" })!;
  const group = () => locateClip(doc, id)!.clip as GroupClip;
  const shown = (at: number) =>
    switchOptions(doc, id)
      .filter((c) => !hiddenBySwitch(doc, locateClip(doc, c.id)!.track, c, at))
      .map((c) => c.name);
  return { doc, id, group, shown, open, half, closed };
}

describe("a switch shows one member at a time", () => {
  it("shows its top member by default, and only that member is in its box", () => {
    const { doc, group, shown } = eyes();
    expect(switchOptions(doc, group().id).map((c) => c.name)[0]).toBe(shown(0)[0]);
    expect(shown(0)).toHaveLength(1);
  });

  it("its box is the shown member's, not the union of every state", () => {
    const { doc, id, group } = eyes();
    setSwitch(doc, id, "Closed", 0);
    expect(groupBoxAt(doc, group(), 0).height).toBeCloseTo(4, 6);
    setSwitch(doc, id, "Half", 0);
    expect(groupBoxAt(doc, group(), 0).height).toBeCloseTo(20, 6);
  });

  it("a blink is two keys: the choice holds between them and cuts at each", () => {
    const { doc, id, shown } = eyes();
    setSwitch(doc, id, "Open", 0, { key: true });
    setSwitch(doc, id, "closed", 1000, { key: true }); // any case
    setSwitch(doc, id, "Open", 1100, { key: true });
    expect(shown(500)).toEqual(["Open"]);
    expect(shown(1000)).toEqual(["Closed"]);
    expect(shown(1050)).toEqual(["Closed"]);
    expect(shown(1100)).toEqual(["Open"]);
  });

  it("an expression's number counts from the top, a flag picks the first two, a stray name falls back to the top", () => {
    const { doc, id, group, shown } = eyes();
    const top = switchOptions(doc, id).map((c) => c.name);
    setClipProperty(group(), "switch", 2);
    expect(shown(0)).toEqual([top[2]]);
    setClipProperty(group(), "switch", 9.4); // held to the last
    expect(shown(0)).toEqual([top[2]]);
    setClipProperty(group(), "switch", true);
    expect(shown(0)).toEqual([top[1]]);
    setClipProperty(group(), "switch", "Wink");
    expect(shown(0)).toEqual([top[0]]);
  });

  it("writes a member by id as its name, refuses one it does not hold, and unmaking shows everything again", () => {
    const { doc, id, group, half, shown } = eyes();
    expect(setSwitch(doc, id, half.id, 0)).toBe(true);
    expect(group().switch!.show).toBe("Half");
    expect(setSwitch(doc, id, "Nope", 0)).toBe(false);
    setSwitch(doc, id, "Closed", 500, { key: true });
    unmakeSwitch(doc, id);
    expect(group().keyframes.some((k) => k.property === "switch")).toBe(false);
    expect(shown(0)).toHaveLength(3);
  });

  it("a component's variants become a switch of instances — main on top, each named for its variant", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const c = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 2000, x: 0, y: 0, width: 80, height: 30 }) as ShapeClip;
    const lane = createTrack("mouth");
    lane.clips.push(c);
    doc.tracks.push(lane);
    const { frameId: main } = makeComponent(doc, [c.id])!;
    renameVariant(doc, main, "Rest");
    renameVariant(doc, addVariant(doc, main, "AI")!, "AI");
    renameVariant(doc, addVariant(doc, main, "O")!, "O");
    const id = switchFromVariants(doc, frameId, main, { x: 10, y: 20 })!;
    const members = switchOptions(doc, id);
    expect(members.map((m) => m.name)).toEqual(["Rest", "AI", "O"]);
    expect(members.every((m) => m.kind === "nested")).toBe(true);
    expect((locateClip(doc, id)!.clip as GroupClip).switch!.show).toBe("Rest");
    // Lip sync keys a sound by its name.
    expect(setSwitch(doc, id, "O", 300, { key: true })).toBe(true);
  });
});
