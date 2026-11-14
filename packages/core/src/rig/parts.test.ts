import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from "../api";
import { detectParts, type PartMap } from "./parts";

/**
 * Real-world drawings, the way people name (or don't name) their layers. Each
 * fixture is built through the API, then detection must name every part a
 * person would point at — and nothing it can't justify.
 */

type Spec = { name: string; x: number; y: number; w: number; h: number } | { name: string; kids: Spec[]; switch?: boolean };

export function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "AI",
    session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] },
  };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}${res.hint ? ` (${res.hint})` : ""}`);
    return res.value as Record<string, unknown>;
  };
  const build = async (s: Spec): Promise<string> => {
    if ("kids" in s) {
      const ids: string[] = [];
      for (const k of s.kids) ids.push(await build(k));
      if (s.switch) return (await call("switch.create", { ids, name: s.name })).switchId as string;
      return (await call("layers.group", { ids, name: s.name })).groupId as string;
    }
    return (await call("layer.create", { kind: "shape", shape: "ellipse", width: s.w, height: s.h, x: s.x, y: s.y, fill: "#888888", name: s.name })).id as string;
  };
  return { store, api, ctx, call, build };
}

const leaf = (name: string, x: number, y: number, w: number, h: number): Spec => ({ name, x, y, w, h });
const group = (name: string, kids: Spec[], sw = false): Spec => ({ name, kids, switch: sw });

/** role → layer name, for readable expectations. */
function named(map: PartMap): Record<string, string> {
  return Object.fromEntries(Object.entries(map.parts).map(([r, m]) => [r, m!.name]));
}

async function detect(spec: Spec) {
  const h = harness();
  const id = await h.build(spec);
  const map = detectParts(h.store.getState(), id)!;
  return { ...h, id, map, roles: named(map) };
}

/** A face at the origin: head 300×340, eyes at ±60, mouth below. */
const HEAD = leaf("Layer 1", 0, 0, 300, 340);

describe("detectParts — names the way people type them", () => {
  it("reads messy English: copies, sides in any place, case", async () => {
    const { roles, map } = await detect(
      group("Pip", [
        leaf("Head", 0, 0, 300, 340),
        leaf("Eye_L", 60, -40, 50, 60),
        leaf("Eye_L copy 2", -60, -40, 50, 60),
        leaf("left pupil", 60, -40, 16, 16),
        leaf("Pupil.R", -60, -40, 16, 16),
        leaf("BROW-left", 60, -95, 70, 14),
        leaf("rightBrow", -60, -95, 70, 14),
        leaf("nose", 0, 20, 30, 30),
        leaf("Mouth", 0, 90, 110, 40),
      ]),
    );
    expect(roles).toMatchObject({
      head: "Head",
      "eye.L": "Eye_L",
      "eye.R": "Eye_L copy 2",
      "pupil.L": "left pupil",
      "pupil.R": "Pupil.R",
      "brow.L": "BROW-left",
      "brow.R": "rightBrow",
      nose: "nose",
      mouth: "Mouth",
    });
    expect(map.parts["eye.R"]!.reason).toMatch(/mirrors Eye_L/);
    expect(map.figure).toBe("face");
  });

  it("reads Spanish, French, German, Japanese, Persian", async () => {
    const { roles } = await detect(
      group("Personaje", [
        leaf("cabeza", 0, 0, 300, 340),
        leaf("ojo izquierdo", 60, -40, 50, 60),
        leaf("œil droit", -60, -40, 50, 60),
        leaf("Mund", 0, 90, 110, 40),
        leaf("左眉", 60, -95, 70, 14),
        leaf("ابرو راست", -60, -95, 70, 14),
      ]),
    );
    expect(roles).toMatchObject({ head: "cabeza", "eye.L": "ojo izquierdo", "eye.R": "œil droit", mouth: "Mund", "brow.L": "左眉", "brow.R": "ابرو راست" });
  });

  it("a lone 目 and numbered eyes split by place (the character's left is the screen's right)", async () => {
    const { roles, map } = await detect(group("キャラ", [leaf("顔", 0, 0, 300, 340), leaf("目 1", -60, -40, 50, 60), leaf("目 2", 60, -40, 50, 60), leaf("口", 0, 90, 110, 40)]));
    expect(roles).toMatchObject({ "eye.L": "目 2", "eye.R": "目 1", mouth: "口" });
    // 顔 is a face; with no head, it is still the face.
    expect(roles.face ?? roles.head).toBe("顔");
    expect(map.parts["eye.L"]!.confidence).toBeLessThan(map.parts.mouth!.confidence);
  });

  it("a mirrored pair where only one side is named", async () => {
    const { roles, map } = await detect(group("Bob", [HEAD, leaf("Eye R", -60, -40, 50, 60), leaf("Eye", 60, -40, 50, 60), leaf("Mouth", 0, 90, 110, 40)]));
    expect(roles).toMatchObject({ "eye.R": "Eye R", "eye.L": "Eye" });
    expect(map.parts["eye.L"]!.reason).toMatch(/mirrors Eye R/);
  });

  it("a plural group hands its kind to members named only by side", async () => {
    const { roles } = await detect(group("Kid", [HEAD, group("Eyes", [leaf("Left", 60, -40, 50, 60), leaf("Right", -60, -40, 50, 60)]), leaf("Mouth", 0, 90, 110, 40)]));
    expect(roles).toMatchObject({ "eye.L": "Left", "eye.R": "Right" });
  });

  it("nested groups: a pupil inherits its eye's side; an eye's white is part of the eye", async () => {
    const { roles } = await detect(
      group("Nested", [
        HEAD,
        group("Face", [
          group("Eye L", [leaf("eye white L", 60, -40, 50, 60), leaf("pupil", 60, -40, 16, 16)]),
          group("Eye R", [leaf("eye white R", -60, -40, 50, 60), leaf("pupil", -60, -40, 16, 16)]),
          leaf("Mouth", 0, 90, 110, 40),
        ]),
      ]),
    );
    expect(roles).toMatchObject({ face: "Face", "eye.L": "Eye L", "eye.R": "Eye R", "pupil.L": "pupil", "pupil.R": "pupil", mouth: "Mouth" });
    expect(Object.values(roles)).not.toContain("eye white L");
  });
});

describe("detectParts — structure and vocabularies", () => {
  it("a switch of Rhubarb letters is the mouth, whatever its own name", async () => {
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "X"];
    const { map } = await detect(group("Guy", [HEAD, group("Group 7", letters.map((l) => leaf(l, 0, 90, 110, 40)), true)]));
    const mouth = map.parts.mouth!;
    expect(mouth.name).toBe("Group 7");
    expect(mouth.via).toBe("structure");
    expect(mouth.vocabulary).toBe("visemes");
    // Rhubarb's E is the round O, D the open AI.
    expect(Object.fromEntries(mouth.members!.map((m) => [m.name, m.pose]))).toMatchObject({ A: "MBP", D: "AI", E: "O", X: "X" });
  });

  it("canonical viseme names and Character Animator's both read", async () => {
    const ca = ["Neutral", "Ah", "D", "Ee", "F", "L", "M", "Oh", "R", "S", "Uh", "W-Oo"];
    const { map } = await detect(group("Ch", [HEAD, group("mouth shapes", ca.map((l) => leaf(l, 0, 90, 110, 40)), true)]));
    expect(map.parts.mouth!.members!.length).toBe(12);
    expect(map.parts.mouth!.members!.find((m) => m.name === "Ah")!.pose).toBe("AI");
  });

  it("an eye switch's open/closed members, and a hand's poses", async () => {
    const { map } = await detect(
      group("Pal", [
        HEAD,
        group("Eye L", [leaf("Open", 60, -40, 50, 60), leaf("Closed", 60, -40, 50, 6)], true),
        group("Eye R", [leaf("open", -60, -40, 50, 60), leaf("shut", -60, -40, 50, 6)], true),
        group("Thing", [leaf("fist", 200, 300, 40, 40), leaf("point", 200, 300, 40, 40), leaf("open", 200, 300, 40, 40)], true),
      ]),
    );
    expect(map.parts["eye.L"]!.members!.map((m) => m.pose).sort()).toEqual(["Closed", "Open"]);
    expect(map.parts["eye.R"]!.members!.map((m) => m.pose).sort()).toEqual(["Closed", "Open"]);
    expect(map.parts["hand.L"]?.name ?? map.parts["hand.R"]?.name).toBe("Thing");
  });
});

describe("detectParts — geometry only", () => {
  it("a face of unnamed ellipses: head, eyes, pupils, brows, nose, mouth", async () => {
    const { roles } = await detect(
      group("Group 1", [
        leaf("Ellipse", 0, 0, 300, 340),
        leaf("Ellipse 2", -60, -40, 50, 60),
        leaf("Ellipse 3", 60, -40, 50, 60),
        leaf("Ellipse 4", -60, -40, 16, 16),
        leaf("Ellipse 5", 60, -40, 16, 16),
        leaf("Shape", -60, -95, 70, 14),
        leaf("Shape 2", 60, -95, 70, 14),
        leaf("Ellipse 6", 0, 25, 26, 26),
        leaf("Ellipse 7", 0, 95, 110, 40),
      ]),
    );
    expect(roles).toEqual({
      head: "Ellipse",
      "eye.L": "Ellipse 3",
      "eye.R": "Ellipse 2",
      "pupil.L": "Ellipse 5",
      "pupil.R": "Ellipse 4",
      "brow.L": "Shape 2",
      "brow.R": "Shape",
      nose: "Ellipse 6",
      mouth: "Ellipse 7",
    });
  });

  it("a figure of unnamed pieces: head, body, arms, hands, legs, feet", async () => {
    const { roles, map } = await detect(
      group("Layer 9", [
        leaf("1", 0, -300, 200, 220),
        leaf("2", -40, -320, 30, 36),
        leaf("3", 40, -320, 30, 36),
        leaf("4", 0, -240, 60, 20),
        leaf("5", 0, -60, 220, 300),
        leaf("6", -150, -110, 50, 160),
        leaf("7", 150, -110, 50, 160),
        leaf("8", -150, 10, 40, 40),
        leaf("9", 150, 10, 40, 40),
        leaf("10", -60, 230, 60, 220),
        leaf("11", 60, 230, 60, 220),
        leaf("12", -70, 360, 80, 30),
        leaf("13", 70, 360, 80, 30),
      ]),
    );
    expect(map.figure).toBe("body");
    expect(roles).toMatchObject({ head: "1", "eye.L": "3", "eye.R": "2", mouth: "4", torso: "5", "arm.L": "7", "arm.R": "6", "hand.L": "9", "hand.R": "8", "leg.L": "11", "leg.R": "10", "foot.L": "13", "foot.R": "12" });
  });
});

describe("detectParts — corrections, determinism", () => {
  it("an override wins and frees the layer it took; null drops a role", async () => {
    const h = harness();
    const id = await h.build(group("Pip", [HEAD, leaf("Eye L", 60, -40, 50, 60), leaf("Eye R", -60, -40, 50, 60), leaf("Mouth", 0, 90, 110, 40), leaf("Blob", 0, 30, 40, 30)]));
    const doc = h.store.getState();
    const blob = doc.tracks.flatMap((t) => t.clips).find((c) => c.name === "Blob")!.id;
    const map = detectParts(doc, id, { overrides: { mouth: blob, "eye.R": null } })!;
    expect(map.parts.mouth).toMatchObject({ name: "Blob", via: "override", confidence: 1 });
    expect(map.parts["eye.R"]).toBeUndefined();
    expect(map.parts["eye.L"]!.name).toBe("Eye L");
  });

  it("is deterministic and never mutates", async () => {
    const h = harness();
    const id = await h.build(group("Pip", [HEAD, leaf("Eye_L", 60, -40, 50, 60), leaf("Eye_L copy", -60, -40, 50, 60), leaf("Mouth", 0, 90, 110, 40)]));
    const doc = h.store.getState();
    const a = JSON.stringify(detectParts(doc, id));
    const b = JSON.stringify(detectParts(doc, id));
    expect(a).toBe(b);
    expect(h.store.getState()).toBe(doc);
  });

  it("refuses what is not a character", async () => {
    const h = harness();
    const id = await h.build(leaf("Eye", 0, 0, 10, 10));
    expect(detectParts(h.store.getState(), id)).toBeNull();
  });
});
