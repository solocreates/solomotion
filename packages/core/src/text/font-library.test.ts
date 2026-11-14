import { describe, expect, it } from "vitest";
import {
  decodeFontCatalog,
  drawableWeight,
  facetCounts,
  localFamilyMeta,
  nativeSample,
  offeredWeights,
  queryFonts,
  styleCount,
  weightRange,
} from "./font-library";

const CATALOG = JSON.stringify({
  v: 1,
  scripts: ["latin", "cyrillic", "japanese"],
  tags: ["f:Calm", "s:Geometric", "f:Playful", "s:Handwritten"],
  designers: ["Rasmus Andersson", "Someone"],
  fonts: [
    ["Inter", 0, "123456789", "123456789", 100, 900, "opsz", [0, 1], [0, 1], 0, 2016, 40],
    ["Inter Tight", 0, "123456789", "", 100, 900, "", [0], [1], 0, 2022, 5],
    ["Space Grotesk", 0, "34567", "", 300, 700, "", [0], [1], -1, 2020, 12],
    ["Lobster", 2, "4", "", 0, 0, "", [0, 1], [2], 1, 2010, 0],
    ["Caveat", 3, "4567", "", 400, 700, "", [0], [2, 3], 1, 2015, 3],
    ["Noto Sans JP", 0, "123456789", "", 100, 900, "", [2], [], -1, 2019, 20],
    ["Winter Mono", 4, "47", "", 0, 0, "", [0], [], -1, 2021, 9],
  ],
});

const all = decodeFontCatalog(CATALOG);
const byName = (n: string) => all.find((f) => f.family === n)!;

describe("decodeFontCatalog", () => {
  it("unpacks weights, italics, axes, scripts, tags and rank", () => {
    const inter = byName("Inter");
    expect(inter.weights).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(inter.italics).toHaveLength(9);
    expect(inter.variable).toEqual({ min: 100, max: 900 });
    expect(inter.axes).toEqual(["opsz"]);
    expect(inter.scripts).toEqual(["latin", "cyrillic"]);
    expect(inter.feelings).toEqual(["Calm"]);
    expect(inter.styles).toEqual(["Geometric"]);
    expect(inter.designer).toBe("Rasmus Andersson");
    expect(inter.popularity).toBe(0);
    expect(byName("Lobster").variable).toBeNull();
    expect(styleCount(inter)).toBe(18);
  });
});

describe("weights", () => {
  it("draws any weight on a variable axis, clamped to it", () => {
    const sg = byName("Space Grotesk");
    expect(drawableWeight(sg, 650)).toBe(650);
    expect(drawableWeight(sg, 900)).toBe(700);
    expect(weightRange(sg)).toEqual({ min: 300, max: 700 });
  });

  it("snaps a static family to its nearest shipped weight, ties heavier", () => {
    const wm = byName("Winter Mono");
    expect(drawableWeight(wm, 550)).toBe(700);
    expect(drawableWeight(wm, 900)).toBe(700);
    expect(drawableWeight(wm, 100)).toBe(400);
  });

  it("offers every hundred inside a variable axis", () => {
    expect(offeredWeights(byName("Space Grotesk"))).toEqual([300, 400, 500, 600, 700]);
    expect(offeredWeights(byName("Winter Mono"))).toEqual([400, 700]);
  });

  it("reads a local family's ladder from its faces", () => {
    const m = localFamilyMeta("Mine", "yours", [
      { weight: 700, italic: false },
      { weight: 400, italic: false },
      { weight: 400, italic: true },
    ]);
    expect(m.weights).toEqual([400, 700]);
    expect(m.italics).toEqual([400]);
    expect(localFamilyMeta("Empty", "system", []).weights).toEqual([400]);
  });
});

describe("queryFonts", () => {
  it("ranks exact, then prefix, then substring, then tag matches", () => {
    const names = queryFonts(all, { text: "inter" }).map((f) => f.family);
    expect(names).toEqual(["Inter", "Inter Tight", "Winter Mono"]);
  });

  it("matches a feeling or a style by word", () => {
    expect(queryFonts(all, { text: "playful" }).map((f) => f.family)).toEqual(["Lobster", "Caveat"]);
    expect(queryFonts(all, { text: "geometric tight" }).map((f) => f.family)).toEqual(["Inter Tight"]);
  });

  it("filters by facet, script and real weight", () => {
    expect(queryFonts(all, { categories: ["hand"] }).map((f) => f.family)).toEqual(["Caveat"]);
    expect(queryFonts(all, { script: "japanese" }).map((f) => f.family)).toEqual(["Noto Sans JP"]);
    // 800 is out of Space Grotesk's axis and Winter Mono's ladder.
    const heavy = queryFonts(all, { weight: 800 }).map((f) => f.family);
    expect(heavy).toContain("Inter");
    expect(heavy).not.toContain("Space Grotesk");
    expect(heavy).not.toContain("Winter Mono");
    expect(queryFonts(all, { feelings: ["Playful"], styles: ["Handwritten"] }).map((f) => f.family)).toEqual(["Caveat"]);
    expect(queryFonts(all, { italicOnly: true }).map((f) => f.family)).toEqual(["Inter"]);
  });

  it("sorts by trending with unranked families last", () => {
    const names = queryFonts(all, { sort: "trending" }).map((f) => f.family);
    expect(names[0]).toBe("Caveat");
    expect(names[names.length - 1]).toBe("Lobster");
  });

  it("counts facets", () => {
    expect(facetCounts(all, "feelings").get("Playful")).toBe(2);
    expect(facetCounts(all, "category").get("sans")).toBe(4);
  });
});

describe("nativeSample", () => {
  it("previews a family that cannot set Latin in its own script", () => {
    expect(nativeSample(byName("Noto Sans JP"))).toMatch(/日本語/);
    expect(nativeSample(byName("Inter"))).toBeNull();
    expect(nativeSample(byName("Inter"), "cyrillic")).toMatch(/Съешь/);
  });
});
