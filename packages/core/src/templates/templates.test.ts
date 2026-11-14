import { describe, expect, it } from "vitest";
import { createLayerEffect } from "../animation/layer-effects";
import { getPreset } from "../animation/presets";
import { createTextClip, defaultTextStyle } from "../factories";
import {
  INHERIT_PREFS,
  TEXT_TEMPLATES,
  TEMPLATE_CATEGORIES,
  applyTemplateToClip,
  createClipFromTemplate,
  defaultLookVoice,
  effectivePalette,
  lookUnits,
  resolveColorToken,
  resolveTemplate,
  substituteRoles,
  type TextLookPrefs,
} from "./index";

const CUSTOM: TextLookPrefs = {
  color: { mode: "custom", ink: "#123456", accent: null },
  sound: { mode: "inherit" },
};

/** Every role token anywhere in a value — what must never survive resolution. */
function tokensIn(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("@") ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(tokensIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(tokensIn);
  return [];
}

describe("colour roles", () => {
  const palette = { ink: "#FF0000", accent: "#00FF00", shade: "#000000" };

  it("resolves a bare token and an alpha token", () => {
    expect(resolveColorToken("@ink", palette)).toBe("#FF0000");
    expect(resolveColorToken("@shade/50", palette)).toBe("#00000080");
    expect(resolveColorToken("@accent/0", palette)).toBe("#00FF0000");
  });

  it("leaves a literal colour alone", () => {
    expect(resolveColorToken("#ABCDEF", palette)).toBe("#ABCDEF");
    expect(resolveColorToken("var:abc", palette)).toBe("var:abc");
  });

  it("substitutes at any depth without mutating the source", () => {
    const src = { a: "@ink", b: { c: ["@accent", 4] }, d: 7 };
    const out = substituteRoles(src, palette);
    expect(out).toEqual({ a: "#FF0000", b: { c: ["#00FF00", 4] }, d: 7 });
    expect(src.a).toBe("@ink");
  });

  it("an override replaces the identity and keeps the neutral", () => {
    const base = { ink: "#FF0000", accent: "#00FF00", shade: "#111111" };
    expect(effectivePalette(base, { mode: "inherit" })).toEqual(base);
    expect(effectivePalette(base, { mode: "custom", ink: "#0000FF", accent: null })).toEqual({
      ink: "#0000FF",
      accent: "#00FF00",
      shade: "#111111",
    });
    expect(effectivePalette(base, { mode: "custom", ink: "#0000FF", accent: "#FFFF00" })).toEqual({
      ink: "#0000FF",
      accent: "#FFFF00",
      shade: "#111111",
    });
  });
});

describe("the catalogue", () => {
  it("has unique ids and a known category", () => {
    const ids = TEXT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEXT_TEMPLATES) expect(TEMPLATE_CATEGORIES).toContain(t.category);
  });

  it("only names animation presets that exist", () => {
    for (const t of TEXT_TEMPLATES) {
      for (const spec of [t.animations.in, t.animations.out]) {
        if (spec) expect(getPreset(spec.preset), `${t.id} → ${spec.preset}`).toBeTruthy();
      }
    }
  });

  /**
   * The guard that makes the role system worth having: a look that hard-codes a
   * hex where a token belongs is one the colour dial silently does nothing to,
   * and nothing about it looks wrong until someone tries to recolour it.
   */
  it("writes every colour as a role, so the dial reaches all of them", () => {
    for (const t of TEXT_TEMPLATES) {
      const colours: string[] = [];
      const push = (c: unknown) => {
        if (typeof c === "string") colours.push(c);
      };
      push(t.style.color);
      push(t.style.highlight?.color);
      push(t.focus?.props.color);
      push(t.focus?.props["highlight.color"]);
      for (const e of t.style.textEffects ?? []) push(e.color);
      for (const e of t.effects ?? []) {
        const c = (e as { color?: string }).color;
        // A colour the look never touched is the registry's own default — a
        // scanline mask is black because masks are black, not because anyone
        // chose it, and it must not follow a brand colour. Only what the
        // AUTHOR wrote is held to the rule.
        if (c !== (createLayerEffect(e.type) as { color?: string }).color) push(c);
      }
      for (const c of colours) {
        expect(c.startsWith("@"), `${t.id} holds a literal colour ${c}`).toBe(true);
      }
    }
  });

  it("leaves no token behind once resolved", () => {
    for (const t of TEXT_TEMPLATES) {
      const look = resolveTemplate(t, CUSTOM);
      expect(tokensIn(look.style), t.id).toEqual([]);
      expect(tokensIn(look.effects), t.id).toEqual([]);
      expect(tokensIn(look.focus), t.id).toEqual([]);
    }
  });

  it("every caption look says what the spoken word looks like", () => {
    for (const t of TEXT_TEMPLATES.filter((t) => t.category === "Captions")) {
      expect(t.focus, `${t.id} has no focus`).toBeDefined();
    }
  });
});

describe("preferences", () => {
  const look = TEXT_TEMPLATES.find((t) => t.id === "hero-pop")!;

  it("inherits the preset's own palette and voice by default", () => {
    const r = resolveTemplate(look, INHERIT_PREFS);
    expect(r.palette).toEqual(look.palette);
    expect(r.style.color).toBe(look.palette.ink);
    expect(r.sound?.pack).toBe("thock");
  });

  it("an ink override reaches the style", () => {
    expect(resolveTemplate(look, CUSTOM).style.color).toBe("#123456");
  });

  it("silence is a real arm, not a quiet voice", () => {
    expect(resolveTemplate(look, { ...INHERIT_PREFS, sound: { mode: "off" } }).sound).toBeNull();
  });

  it("a custom voice reaches a look that ships silent", () => {
    const silent = TEXT_TEMPLATES.find((t) => !t.sound)!;
    const voice = defaultLookVoice();
    expect(resolveTemplate(silent, { ...INHERIT_PREFS, sound: voice }).sound?.pack).toBe(
      voice.voice.pack,
    );
  });
});

/**
 * The regression this file exists for. Creating a layer from a look and
 * restyling one with it used to be two implementations, and the creating half
 * silently dropped the effects and the typing sound — so the same card gave a
 * different result depending on where you dropped it.
 */
describe("apply", () => {
  const withEverything = TEXT_TEMPLATES.find((t) => t.id === "tiktok-punch")!;

  it("a caption takes the look's focus; a look with no opinion leaves it alone", () => {
    const karaoke = TEXT_TEMPLATES.find((t) => t.id === "karaoke-pill")!;
    const clip = createTextClip({ frameId: "f", text: "sing it back", startMs: 0, caption: {} });
    clip.caption!.states.focus.overlay.props.color = "#F5B843";
    applyTemplateToClip(clip, karaoke);
    // The band's second colour, as a whole pill, resolved from the palette.
    expect(clip.caption!.states.focus.overlay.props["highlight.color"]).toBe(karaoke.palette.accent);
    expect(clip.caption!.states.focus.overlay.props.color).toBeUndefined();
    expect(clip.caption!.states.focus.scale).toBe(1.06);

    const title = TEXT_TEMPLATES.find((t) => t.category === "Titles" && !t.focus)!;
    applyTemplateToClip(clip, title);
    expect(clip.caption!.states.focus.overlay.props["highlight.color"]).toBe(karaoke.palette.accent);

    const plain = createTextClip({ frameId: "f", text: "x", startMs: 0 });
    applyTemplateToClip(plain, karaoke);
    expect(plain.caption).toBeNull();
  });

  it("creating and restyling produce the same look", () => {
    const created = createClipFromTemplate(withEverything, { frameId: "f", startMs: 0 });
    const restyled = createTextClip({ frameId: "f", text: "x", startMs: 0 });
    applyTemplateToClip(restyled, withEverything);

    expect(restyled.style.color).toBe(created.style.color);
    expect(restyled.effects.length).toBe(created.effects.length);
    expect(restyled.sounds.length).toBe(created.sounds.length);
    expect(restyled.style.textEffects.length).toBe(created.style.textEffects.length);
    expect(restyled.animations.in?.preset).toBe(created.animations.in?.preset);
  });

  it("gives each clip its own effect ids", () => {
    const a = createClipFromTemplate(withEverything, { frameId: "f", startMs: 0 });
    const b = createClipFromTemplate(withEverything, { frameId: "f", startMs: 0 });
    const ids = (c: typeof a) => [...c.effects.map((e) => e.id), ...c.style.textEffects.map((e) => e.id)];
    for (const id of ids(a)) expect(ids(b)).not.toContain(id);
  });

  it("replaces rather than merges — no orphan from the previous look", () => {
    const clip = createTextClip({ frameId: "f", text: "x", startMs: 0 });
    applyTemplateToClip(clip, withEverything);
    const plain = TEXT_TEMPLATES.find((t) => !t.effects && !t.style.textEffects && !t.sound)!;
    applyTemplateToClip(clip, plain);
    expect(clip.effects).toEqual([]);
    expect(clip.style.textEffects).toEqual([]);
    expect(clip.sounds).toEqual([]);
  });

  it("resets typography the new look has no opinion about", () => {
    // The merge bug: a look states the fields it cares about, so anything the
    // PREVIOUS look set and this one omits used to survive — and applying looks
    // in sequence accumulated the union of all of them.
    const clip = createTextClip({ frameId: "f", text: "x", startMs: 0 });
    clip.style.letterSpacing = 42;
    clip.style.italic = true;
    clip.style.textCase = "upper";
    const look = TEXT_TEMPLATES.find(
      (t) =>
        t.style.letterSpacing === undefined &&
        t.style.italic === undefined &&
        t.style.textCase === undefined,
    )!;
    applyTemplateToClip(clip, look);
    const fresh = defaultTextStyle();
    expect(clip.style.letterSpacing).toBe(fresh.letterSpacing);
    expect(clip.style.italic).toBe(fresh.italic);
    expect(clip.style.textCase).toBe(fresh.textCase);
  });

  it("drops keyframes and modulators left pointing at the old look's effects", () => {
    const clip = createTextClip({ frameId: "f", text: "x", startMs: 0 });
    applyTemplateToClip(clip, withEverything);
    const dead = clip.effects[0] ?? clip.style.textEffects[0]!;
    const prefix = clip.effects[0] ? "lfx" : "tfx";
    clip.keyframes.push({
      id: "k1",
      property: `${prefix}.${dead.id}.opacity`,
      range: null,
      keys: [{ id: "a", timeMs: 0, value: 1, easing: { kind: "linear" } }],
    });
    clip.keyframes.push({
      id: "k2",
      property: "opacity",
      range: null,
      keys: [{ id: "b", timeMs: 0, value: 1, easing: { kind: "linear" } }],
    });
    applyTemplateToClip(clip, withEverything);
    // Re-applying mints fresh ids, so the old track addresses nothing. The
    // clip's OWN properties are none of the look's business and stay.
    expect(clip.keyframes.map((k) => k.property)).toEqual(["opacity"]);
  });
});

describe("the preview plan", () => {
  it("splits at the grain and covers the whole specimen", () => {
    for (const unit of ["letter", "word", "line"] as const) {
      const units = lookUnits("two words\nand a line", unit);
      expect(units.map((u) => u.text).join("")).toBe("two words\nand a line");
    }
    expect(lookUnits("ab", "letter")).toHaveLength(2);
    expect(lookUnits("one two three", "word")).toHaveLength(3);
    expect(lookUnits("a\nb", "line")).toHaveLength(2);
  });
});
