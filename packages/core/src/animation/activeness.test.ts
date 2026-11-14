import { describe, expect, it } from "vitest";
import { activeAt, anyActiveAt, switchedOn, ENABLED_FIELD } from "./activeness";
import { propertyDef } from "./properties";
import { applyModulators, createModulator, modulatorPath } from "./modulators";
import { getClipProperty, setClipProperty } from "./paths";
import { createTextClip } from "../factories";
import { layerEffectPath } from "./layer-effects";
import { AFX } from "../audio/effects/registry";

describe("switchedOn", () => {
  it("falls back to the stored flag when nothing is keyed", () => {
    expect(switchedOn(true, "lfx.a.enabled", {})).toBe(true);
    expect(switchedOn(false, "lfx.a.enabled", {})).toBe(false);
    expect(switchedOn(true, "lfx.a.enabled", undefined)).toBe(true);
  });

  it("lets a sampled key beat the stored flag in both directions", () => {
    expect(switchedOn(true, "lfx.a.enabled", { "lfx.a.enabled": false })).toBe(false);
    expect(switchedOn(false, "lfx.a.enabled", { "lfx.a.enabled": true })).toBe(true);
  });

  it("coerces the 0/1 a driver or an imported document may have written", () => {
    expect(switchedOn(false, "p", { p: 1 })).toBe(true);
    expect(switchedOn(true, "p", { p: 0 })).toBe(false);
  });

  it("filters a list without touching unkeyed members", () => {
    const items = [
      { id: "a", enabled: true },
      { id: "b", enabled: true },
      { id: "c", enabled: false },
    ];
    const path = (id: string) => `lfx.${id}.${ENABLED_FIELD}`;
    expect(activeAt(items, path, {}).map((i) => i.id)).toEqual(["a", "b"]);
    expect(activeAt(items, path, { "lfx.a.enabled": false, "lfx.c.enabled": true }).map((i) => i.id)).toEqual(["b", "c"]);
    expect(anyActiveAt(items, path, { "lfx.a.enabled": false, "lfx.b.enabled": false })).toBe(false);
  });
});

describe("enabled is a real animatable property", () => {
  it("is registered as a holding discrete for layer AND audio effects", () => {
    for (const key of ["lfx.fx1.enabled", "afx.fx1.enabled", "mod.m1.enabled"]) {
      const def = propertyDef(key);
      expect(def, key).toBeDefined();
      // Discrete = holds between keys. A number kind would tween a switch
      // through 0.5, which is a state nothing can render.
      expect(def!.kind, key).toBe("discrete");
      expect(def!.identity, key).toBe(true);
    }
  });

  it("gives a modulator's own fields defs from the one field registry", () => {
    expect(propertyDef("mod.m1.rate")?.kind).toBe("number");
    expect(propertyDef("mod.m1.shape")?.kind).toBe("discrete");
    expect(propertyDef("mod.m1.notAField")).toBeUndefined();
  });

  it("round-trips a switch through the generic path setter", () => {
    const clip = createTextClip({ frameId: "f1", text: "Hi", startMs: 0 });
    clip.effects.push({ id: "fx1", type: "blur", enabled: true, radius: 4 } as never);
    const path = layerEffectPath("fx1", ENABLED_FIELD);
    expect(getClipProperty(clip, path)).toBe(true);
    setClipProperty(clip, path, false);
    expect(getClipProperty(clip, path)).toBe(false);
    expect(clip.effects[0]!.enabled).toBe(false);

    const audio = AFX.path("afx1", ENABLED_FIELD);
    clip.audioEffects.push({ id: "afx1", type: "eq", enabled: true, bands: [] } as never);
    setClipProperty(clip, audio, false);
    expect(getClipProperty(clip, audio)).toBe(false);
  });

  it("round-trips a MODULATOR's fields, which had no path binding at all", () => {
    const clip = createTextClip({ frameId: "f1", text: "Hi", startMs: 0 });
    const mod = createModulator("opacity");
    clip.modulators = [mod];
    expect(getClipProperty(clip, modulatorPath(mod.id, "rate"))).toBe(mod.rate);
    setClipProperty(clip, modulatorPath(mod.id, "rate"), 7);
    expect(clip.modulators[0]!.rate).toBe(7);
    setClipProperty(clip, modulatorPath(mod.id, ENABLED_FIELD), false);
    expect(clip.modulators[0]!.enabled).toBe(false);
  });
});

describe("a keyed switch actually silences its owner", () => {
  it("stops a modulator at the instant its enabled track says off", () => {
    const mod = { ...createModulator("opacity"), shape: "wave" as const, amount: 10, compose: "add" as const };
    const at = (sampled: Record<string, boolean>) => applyModulators([mod], "opacity", 0, 0.25, sampled);
    // On: the signal moves the value. Off: the value is returned untouched —
    // including the clamp pass, which must not run on a silenced modulator.
    expect(at({})).not.toBe(0);
    expect(at({ [modulatorPath(mod.id, ENABLED_FIELD)]: false })).toBe(0);
  });
});
