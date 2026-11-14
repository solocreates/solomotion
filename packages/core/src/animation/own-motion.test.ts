import { describe, expect, it } from "vitest";
import { createEmptyDocument, createTextClip } from "../factories";
import { parseDocument, serializeDocument } from "../io";
import { layerEffectSchema } from "../schema/layer-effects";
import { resolveGrainParams } from "./analog";
import { ownClockSec } from "./effect-base";
import { LFX, createLayerEffect } from "./layer-effects";
import { sweepAt } from "./sweep";

/**
 * A self-moving card can hold still (`animate`), and holding still must stop
 * EVERY clock it moves by — re-roll, sweep, speed, drift — while keys play on.
 */
describe("a card's own motion", () => {
  it("every card's create() is exactly what its schema makes of it", () => {
    // `create()` restates the schema's defaults by hand; a default flipped in one
    // place and not the other is a card that changes the moment it is saved.
    for (const def of LFX.types) {
      const made = def.create();
      expect(layerEffectSchema.parse(made), def.type).toEqual(made);
    }
  });

  it("every time-driven card carries the switch, and only those", () => {
    for (const def of LFX.types) {
      const toggle = (def.toggles ?? []).some((t) => t.key === "animate");
      expect(toggle, def.type).toBe(LFX.isTimeDriven(def.type));
      expect("animate" in def.create(), def.type).toBe(toggle);
    }
  });

  it("surfaces arrive still; motion cards arrive moving", () => {
    for (const type of ["grain", "noise", "roughenEdges"] as const) expect(createLayerEffect(type)).toMatchObject({ animate: false });
    for (const type of ["filmDamage", "glitch", "boil", "shine", "wave", "lightning", "scanlines"] as const) {
      expect(createLayerEffect(type)).toMatchObject({ animate: true });
    }
  });

  it("held still, the clock stops and the card stops moving", () => {
    const grain = { ...createLayerEffect("grain"), animate: true } as Extract<ReturnType<typeof createLayerEffect>, { type: "grain" }>;
    const at = (fx: typeof grain, t: number) => resolveGrainParams(fx, {}, 1, t).seed;
    expect(at(grain, 0)).not.toBe(at(grain, 3.2));
    const still = { ...grain, animate: false };
    expect(at(still, 0)).toBe(at(still, 3.2));
    expect(LFX.isMoving(still)).toBe(false);
    expect(LFX.pictureAt(still, 3.2)).toBeNull();
    expect(ownClockSec(still, 7)).toBe(0);
    expect(ownClockSec(grain, 7)).toBe(7);
  });

  it("a still sweep sits at its position", () => {
    const shine = { ...createLayerEffect("shine"), animate: false };
    const clock = { position: 0.3, duration: 1.6, delay: 0, loop: true };
    expect(sweepAt(clock, ownClockSec(shine, 0.8))).toBe(0.3);
  });

  it("v100: grain, noise and rough edges already in a project keep moving", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: doc.frames[0]!.id, text: "paper", startMs: 0 });
    doc.tracks[0]!.clips.push(clip);
    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    raw.version = 99;
    const old = (type: "grain" | "noise" | "roughenEdges" | "glitch") => {
      const { animate: _a, ...fx } = createLayerEffect(type) as Record<string, unknown>;
      return { ...fx, id: type };
    };
    const c = (raw.tracks as Array<{ clips: Array<Record<string, unknown>> }>)[0]!.clips[0]!;
    c.effects = [old("grain"), old("noise"), old("roughenEdges"), old("glitch")];
    const migrated = parseDocument(JSON.stringify(raw)).tracks[0]!.clips[0]!;
    if (migrated.kind === "audio") throw new Error("expected a visual clip");
    const byId = Object.fromEntries(migrated.effects.map((e) => [e.id, e]));
    for (const id of ["grain", "noise", "roughenEdges", "glitch"]) expect(byId[id], id).toMatchObject({ animate: true });
  });
});
