import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARKIT_MOUTH_SHAPES,
  ARKIT_VISEME_WEIGHTS,
  PHONEMES,
  VISEME_IDS,
  fromAlphabet,
  labelsToCues,
  listVisemeAlphabets,
  normalizeCues,
  overlayCues,
  phonemesToCues,
  quantizeCues,
  settingsKey,
  speechCacheKey,
  speechEngine,
  toAlphabet,
  type VisemeCue,
  type VisemeId,
} from "./index";

const here = dirname(fileURLToPath(import.meta.url));

/** The original O(n²) labelsToCues — the fast one must match it exactly. */
function referenceLabelsToCues(labels: VisemeId[], hopMs: number, minCueMs: number): VisemeCue[] {
  if (labels.length === 0) return [];
  interface Run { start: number; end: number; viseme: VisemeId }
  let runs: Run[] = [];
  for (let i = 0; i < labels.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.viseme === labels[i]) last.end = i + 1;
    else runs.push({ start: i, end: i + 1, viseme: labels[i]! });
  }
  const minFrames = Math.max(1, Math.round(minCueMs / hopMs));
  for (let changed = true; changed && runs.length > 1; ) {
    changed = false;
    let idx = -1;
    let len = Infinity;
    for (let i = 0; i < runs.length; i++) {
      const n = runs[i]!.end - runs[i]!.start;
      if (n < minFrames && n < len) { idx = i; len = n; }
    }
    if (idx >= 0) {
      const prev = runs[idx - 1];
      const next = runs[idx + 1];
      const into = !prev ? next! : !next ? prev : prev.end - prev.start >= next.end - next.start ? prev : next;
      if (into === prev) prev.end = runs[idx]!.end;
      else into.start = runs[idx]!.start;
      runs.splice(idx, 1);
      runs = runs.filter((r, i) => {
        const p = runs[i - 1];
        if (p && p.viseme === r.viseme) { p.end = r.end; return false; }
        return true;
      });
      changed = true;
    }
  }
  return runs.map((r) => {
    let agree = 0;
    for (let i = r.start; i < r.end; i++) if (labels[i] === r.viseme) agree++;
    return { startMs: Math.round(r.start * hopMs), endMs: Math.round(r.end * hopMs), viseme: r.viseme, confidence: agree / (r.end - r.start) };
  });
}

describe("labelsToCues (heap) matches the reference exactly", () => {
  it("on 300 random label streams", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let trial = 0; trial < 300; trial++) {
      const labels: VisemeId[] = [];
      const n = 1 + Math.floor(rnd() * 200);
      while (labels.length < n) {
        const v = VISEME_IDS[Math.floor(rnd() * (2 + (trial % 7)))]!;
        const run = 1 + Math.floor(rnd() * 12);
        for (let k = 0; k < run; k++) labels.push(v);
      }
      const min = [10, 30, 60, 90][trial % 4]!;
      expect(labelsToCues(labels, 10, min)).toEqual(referenceLabelsToCues(labels, 10, min));
    }
  });
});

describe("cue contract helpers", () => {
  it("normalizeCues sorts, resolves overlaps (later wins), fills gaps, covers the duration", () => {
    const out = normalizeCues(
      [
        { startMs: 200, endMs: 400, viseme: "O", confidence: 1 },
        { startMs: 0, endMs: 300, viseme: "AI", confidence: 1 },
        { startMs: 500, endMs: 500, viseme: "E", confidence: 1 }, // zero length dropped
      ],
      600,
    );
    expect(out.map((c) => [c.startMs, c.endMs, c.viseme])).toEqual([
      [0, 200, "AI"], [200, 400, "O"], [400, 600, "X"],
    ]);
  });

  it("phonemesToCues: diphthong split, H takes the next vowel, silence rests", () => {
    const cues = phonemesToCues([
      { phoneme: "HH", startMs: 0, endMs: 60 },
      { phoneme: "UW", startMs: 60, endMs: 200 },
      { phoneme: "SIL", startMs: 200, endMs: 300 },
      { phoneme: "AY", startMs: 300, endMs: 500 },
    ]);
    expect(cues.map((c) => c.viseme)).toEqual(["U", "X", "AI", "E"]);
    expect(cues[0]).toMatchObject({ startMs: 0, endMs: 200 });
  });

  it("overlayCues: an edit wins its range; rest is rest, never a stretch", () => {
    const base = normalizeCues([{ startMs: 0, endMs: 300, viseme: "AI", confidence: 1 }]);
    const out = overlayCues(base, [{ startMs: 100, endMs: 200, viseme: "rest" }]);
    expect(out.map((c) => c.viseme)).toEqual(["AI", "X", "AI"]);
  });

  it("quantizeCues keeps a closure that would round away", () => {
    const out = quantizeCues(
      [
        { startMs: 0, endMs: 205, viseme: "AI", confidence: 1 },
        { startMs: 205, endMs: 225, viseme: "MBP", confidence: 1 },
        { startMs: 225, endMs: 500, viseme: "O", confidence: 1 },
      ],
      40,
    );
    expect(out.some((c) => c.viseme === "MBP" && c.endMs - c.startMs === 40)).toBe(true);
    for (const c of out) expect(c.startMs % 40).toBe(0);
  });
});

describe("cache keys", () => {
  it("defaults fold in: {} and explicit defaults share a slot; any change moves it", () => {
    const e = speechEngine("spectral")!;
    expect(speechCacheKey("a", e, {})).toBe(speechCacheKey("a", e, { minCueMs: 60, smoothing: 2, sensitivity: 0.5 }));
    expect(speechCacheKey("a", e, { minCueMs: 61 })).not.toBe(speechCacheKey("a", e, {}));
    expect(settingsKey({ b: 1, a: "x", c: undefined })).toBe("a=x;b=1");
  });
});

describe("alphabets", () => {
  it("are total over the canonical nine and round-trip", () => {
    const alphabets = listVisemeAlphabets();
    expect(alphabets.map((a) => a.id)).toEqual(expect.arrayContaining(["rhubarb", "preston-blair", "disney-12", "oculus"]));
    for (const a of alphabets) {
      const ids = new Set(a.shapes.map((s) => s.id));
      for (const v of VISEME_IDS) {
        const shape = toAlphabet(a.id, v)!;
        expect(ids.has(shape)).toBe(true);
        expect(fromAlphabet(a.id, shape)).toBe(v);
      }
      for (const s of a.shapes) expect(a.toViseme[s.id]).toBeDefined();
      for (const p of Object.keys(PHONEMES) as (keyof typeof PHONEMES)[]) {
        expect(ids.has(toAlphabet(a.id, PHONEMES[p].viseme, p)!)).toBe(true);
      }
    }
    expect(fromAlphabet("preston-blair", "w-q")).toBe("U");
    expect(toAlphabet("oculus", "S", "K")).toBe("kk");
  });

  it("ARKit weights cover every viseme with in-range known shapes", () => {
    for (const v of VISEME_IDS) {
      for (const [k, w] of Object.entries(ARKIT_VISEME_WEIGHTS[v])) {
        expect(ARKIT_MOUTH_SHAPES).toContain(k);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
    expect(ARKIT_VISEME_WEIGHTS.AI.jawOpen!).toBeGreaterThan(ARKIT_VISEME_WEIGHTS.E.jawOpen!);
    expect(ARKIT_VISEME_WEIGHTS.U.mouthPucker!).toBeGreaterThan(0.5);
  });
});

describe("lazy entries", () => {
  it("the root's STATIC import graph holds no engine implementation, dictionary or synth", () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      // Static `import … from "./x"` / `export … from "./x"` only — `import("./x")` is lazy.
      for (const m of src.matchAll(/^(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/gms)) {
        walk(resolve(dirname(file), m[1]!) + ".ts");
      }
      for (const m of src.matchAll(/^import\s+"(\.[^"]+)"/gm)) walk(resolve(dirname(file), m[1]!) + ".ts");
    };
    walk(resolve(here, "index.ts"));
    const rel = [...seen].map((f) => f.slice(here.length + 1)).sort();
    expect(rel).toContain("builtins.ts");
    for (const f of rel) expect(f).not.toMatch(/^(dsp|spectral|engines\/spectral|g2p\/|align\/|voice\/)/);
    const bytes = rel.reduce((n, f) => n + readFileSync(resolve(here, f)).length, 0);
    expect(bytes).toBeLessThan(120_000); // source bytes, comments included
  });
});
