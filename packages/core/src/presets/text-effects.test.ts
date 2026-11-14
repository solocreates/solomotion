import { describe, expect, it } from "vitest";
import { TEXT_EFFECT_TYPE_DEFS, TFX, resolveTextEffect, textEffectReachPx } from "../animation/text-effects";
import { createEmptyDocument, createTextClip } from "../factories";
import { DOCUMENT_VERSION, parseDocument, serializeDocument } from "../index";
import { textEffectSchema } from "../schema/text-style";
import { BUILTIN_TEXT_EFFECT_PRESETS, TEXT_LOOKS } from "./builtin-text-effects";
import { activePreset } from "./library";
import { effectsFromStackPreset, stackPresetFrom } from "./stacks";

describe("text effect registry", () => {
  it("creates every kind as a valid schema instance", () => {
    for (const def of TEXT_EFFECT_TYPE_DEFS) {
      const fx = TFX.create(def.type);
      expect(textEffectSchema.parse(fx)).toEqual(fx);
      // Every declared field is a real key of the instance — a field that
      // addresses nothing keyframes nothing.
      for (const f of def.fields) expect(f.key in fx, `${def.type}.${f.key}`).toBe(true);
    }
  });

  it("resolves the glyph colour when the source says so, and keyframes beat the base", () => {
    const glow = TFX.create("glow");
    const now = resolveTextEffect(glow, { [TFX.path(glow.id, "radius")]: 40 }, { glyphColor: "#123456" });
    expect(now.color).toBe("#123456");
    expect(now.type === "glow" && now.radius).toBe(40);
    const custom = resolveTextEffect({ ...glow, source: "custom", color: "#ff0000" }, {}, { glyphColor: "#123456" });
    expect(custom.color).toBe("#ff0000");
  });

  it("reaches at least as far as it draws", () => {
    const echo = { ...TFX.create("echo"), count: 3, distance: 10 } as const;
    expect(textEffectReachPx(resolveTextEffect(echo, {}, { glyphColor: "#000" }))).toBe(30);
  });
});

describe("built-in text presets", () => {
  const singles = BUILTIN_TEXT_EFFECT_PRESETS.filter((p) => p.kind.startsWith("textEffect:"));

  it("are complete patches over real fields, and find themselves back", () => {
    for (const p of singles) {
      const type = p.kind.slice("textEffect:".length) as never;
      const def = TFX.def(type);
      expect(def, p.name).toBeTruthy();
      const keys = new Set(def!.fields.map((f) => f.key));
      for (const k of Object.keys(p.data as object)) expect(keys.has(k), `${p.name} sets "${k}"`).toBe(true);
      for (const k of keys) expect(k in (p.data as object), `${p.name} omits "${k}"`).toBe(true);
      const applied = { ...TFX.create(type), ...(p.data as object) };
      expect(activePreset(singles.filter((x) => x.kind === p.kind), applied)?.id).toBe(p.id);
    }
  });

  it("has unique ids and names within a kind", () => {
    const ids = new Set<string>();
    for (const p of BUILTIN_TEXT_EFFECT_PRESETS) {
      expect(ids.has(p.id), p.id).toBe(false);
      ids.add(p.id);
    }
  });

  it("looks re-create as valid stacks with fresh ids", () => {
    for (const look of TEXT_LOOKS) {
      const stack = effectsFromStackPreset(TFX, look.data);
      expect(stack.length, look.name).toBe((look.data as unknown[]).length);
      for (const fx of stack) expect(textEffectSchema.parse(fx)).toEqual(fx);
      const again = effectsFromStackPreset(TFX, look.data);
      expect(again.map((e) => e.id)).not.toEqual(stack.map((e) => e.id));
    }
  });
});

describe("stack presets", () => {
  it("round-trip a live stack without its ids", () => {
    const live = [TFX.create("shadow"), { ...TFX.create("glow"), radius: 33 }];
    const saved = stackPresetFrom(live);
    expect(saved.every((e) => !("id" in e))).toBe(true);
    const back = effectsFromStackPreset(TFX, saved);
    expect(back.map((e) => e.type)).toEqual(["shadow", "glow"]);
    expect(back[1]!.type === "glow" && back[1]!.radius).toBe(33);
  });
  it("skips entries of a kind the registry does not know", () => {
    expect(effectsFromStackPreset(TFX, [{ type: "plasma" }, { type: "glow" }]).map((e) => e.type)).toEqual(["glow"]);
  });
});

describe("v72 migration", () => {
  it("turns a null colour into a text source, everywhere a stack lives", () => {
    const doc = createEmptyDocument();
    const clip = createTextClip({ frameId: doc.frames[0]!.id, text: "Hello world", startMs: 0 });
    doc.tracks[0]!.clips.push(clip);
    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    raw.version = 71;
    const c = ((raw.tracks as Array<Record<string, unknown>>)[0]!.clips as Array<Record<string, unknown>>)[0]!;
    (c.style as Record<string, unknown>).textEffects = [
      { id: "a", type: "glow", enabled: true, color: null, opacity: 1, radius: 12, intensity: 1 },
      { id: "b", type: "shadow", enabled: true, color: "#00000099", opacity: 1, x: 0, y: 4, blur: 8 },
    ];
    c.ranges = [
      {
        id: "rng",
        start: 0,
        end: 5,
        animation: null,
        overlay: {
          props: {},
          removed: [],
          added: { effects: [], fills: [], strokes: [], textEffects: [{ id: "r", type: "extrude", enabled: true, color: null, opacity: 1, angle: 45, length: 10 }] },
        },
      },
    ];
    const out = parseDocument(JSON.stringify(raw));
    expect(out.version).toBe(DOCUMENT_VERSION);
    const text = out.tracks[0]!.clips[0]!;
    if (text.kind !== "text") throw new Error("not text");
    expect(text.style.textEffects.map((e) => [e.source, e.color])).toEqual([
      ["text", "#ffffff"],
      ["custom", "#00000099"],
    ]);
    expect(text.ranges[0]!.overlay.added.textEffects[0]!.source).toBe("text");
  });
});
