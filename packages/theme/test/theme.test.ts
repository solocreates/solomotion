import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PRESETS,
  compile,
  listPresets,
  parseTheme,
  readThemeFile,
  SOLOMOTION,
  varName,
  writeThemeFile,
} from "../src";

describe("theme file", () => {
  it("every built-in preset is a valid theme exactly as written", () => {
    for (const t of BUILT_IN_PRESETS) {
      const r = parseTheme(t);
      expect(r.ok && r.theme).toEqual(t);
    }
  });
  it("round-trips every built-in preset", () => {
    for (const t of BUILT_IN_PRESETS) {
      const r = readThemeFile(writeThemeFile(t));
      expect(r.ok && r.theme).toEqual(t);
    }
  });
  it("names the field that is wrong", () => {
    const bad = JSON.parse(writeThemeFile(SOLOMOTION));
    bad.parts.switch = "toggle";
    const r = readThemeFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^parts\.switch: expected one of notch \| dial/);
    expect(readThemeFile("{")).toEqual({ ok: false, error: "That file isn't JSON." });
    const missing = JSON.parse(writeThemeFile(SOLOMOTION));
    delete missing.neutral.light.fg;
    const m = readThemeFile(JSON.stringify(missing));
    expect(!m.ok && m.error).toBe("neutral.light.fg: missing");
  });
  it("rejects a colour that could break out of a declaration", () => {
    const bad = JSON.parse(writeThemeFile(SOLOMOTION));
    bad.accent.dark = "red; background: url(x)";
    expect(readThemeFile(JSON.stringify(bad)).ok).toBe(false);
  });
});

describe("compile", () => {
  it("emits the studio's own variable names and one attribute per part", () => {
    const c = compile(SOLOMOTION);
    expect(c.vars["--primary"]).toBe("#3df2a8");
    expect(c.vars["--ring"]).toBe("#3df2a899");
    expect(c.vars["--background"]).toBe("#0a0b0a");
    expect(c.vars["--control-h"]).toBe("1.75rem");
    expect(c.vars["--control-h-sm"]).toBe("1.5rem");
    expect(c.vars["--radius"]).toBe("0.75rem");
    expect(c.vars["--font-num"]).toBe("var(--font-doto), ui-monospace, 'SF Mono', monospace");
    // Doto has a floor; small numbers take the code face.
    expect(c.vars["--font-num-small"]).toBe("var(--font-geist-mono), ui-monospace, 'SF Mono', monospace");
    expect(c.vars["--label-col"]).toBe("4.75rem");
    expect(c.attrs).toEqual({
      mode: "dark",
      labels: "upper",
      range: "trail",
      measure: "ruler",
      switch: "notch",
      tabs: "playhead",
      button: "solid",
      field: "well",
      menu: "solid",
    });
  });
  it("gives each mode its own tones", () => {
    const dark = compile(SOLOMOTION, "dark");
    const light = compile(SOLOMOTION, "light");
    expect(light.vars["--primary"]).toBe("#0b8a57");
    expect(light.vars["--popover"]).toBe("#ffffff");
    expect(light.vars["--elevation-1"]).not.toBe(dark.vars["--elevation-1"]);
    expect(light.scheme).toBe("light");
  });
});

describe("registry", () => {
  it("ships the four open looks", () => {
    expect(listPresets().map((p) => p.theme.id)).toEqual(["solomotion", "solo/motion", "paper", "hardware"]);
  });
});

describe("labels", () => {
  it("makes a --var name from words", () => {
    expect(varName("Motion blur")).toBe("--motion-blur");
    expect(varName("Speed & pitch")).toBe("--speed-and-pitch");
    expect(varName("Größe")).toBe("--grosse");
    expect(varName("  ")).toBe("--value");
  });
});
