import { describe, expect, it } from "vitest";
import { arabicJoinForms, glyphDirection, presentationForm, shapeArabicGraphemes } from "./arabic-shape";

const ZWJ = "‍";
const split = (s: string) => [...s];

describe("arabic joining", () => {
  it("finds each letter's form, skipping non-joiners", () => {
    // سلام: seen initial, lam medial, alef final (alef never joins forward), meem isolated.
    expect(arabicJoinForms(split("سلام"))).toEqual(["initial", "medial", "final", "isolated"]);
    // Persian عزیزم: zain is right-joining, so it ends one run and starts no join.
    expect(arabicJoinForms(split("عزیزم"))).toEqual(["initial", "final", "initial", "final", "isolated"]);
    expect(arabicJoinForms(split("ab"))).toEqual([null, null]);
  });

  it("stops a join at a zero-width non-joiner, however it is clustered", () => {
    // می‌خواهم — the segmenter clusters the ZWNJ onto the yeh it follows.
    expect(arabicJoinForms(["م", "ی\u200C", "خ", "و"])).toEqual(["initial", "final", "initial", "final"]);
    expect(arabicJoinForms(["م", "ی", "\u200C", "خ", "و"])).toEqual(["initial", "final", null, "initial", "final"]);
  });

  it("wraps letters in joiners on the sides they connect, 1:1 with graphemes", () => {
    const shaped = shapeArabicGraphemes(split("عزیزم"));
    expect(shaped).toEqual(["ع" + ZWJ, ZWJ + "ز", "ی" + ZWJ, ZWJ + "ز", "م"]);
    expect(shapeArabicGraphemes(split("hi"))).toEqual(["h", "i"]);
  });

  it("draws lam-alef as one ligated slot and leaves the alef's slot empty", () => {
    // سلام — lam is medial, so the pair keeps its joiner back to the seen.
    expect(shapeArabicGraphemes(split("سلام"))).toEqual(["س" + ZWJ, ZWJ + "لا", "", "م"]);
    // لا on its own: an isolated ligature.
    expect(shapeArabicGraphemes(split("لا"))).toEqual(["لا", ""]);
    expect(presentationForm(ZWJ + "لا")).toBe("\uFEFC");
    expect(presentationForm("لا")).toBe("\uFEFB");
    expect(presentationForm("")).toBe("");
    // A whole word: every letter in its joined presentation form, lam-alef ligated.
    expect(presentationForm("سلام")).toBe("\uFEB3\uFEFC\uFEE1");
  });

  it("joins Persian letters the presentation block has no form for", () => {
    // U+06CC Farsi yeh has forms; U+063B does not — it must still be wrapped.
    const shaped = shapeArabicGraphemes(["ب", "ػ", "ب"]);
    expect(shaped[1]).toBe(ZWJ + "ػ" + ZWJ);
  });

  it("maps a shaped grapheme to its presentation codepoint for shaper-less outlining", () => {
    expect(presentationForm("س" + ZWJ)).toBe("ﺳ");
    expect(presentationForm(ZWJ + "ل" + ZWJ)).toBe("ﻠ");
    expect(presentationForm("م")).toBe("ﻡ");
    expect(presentationForm("x")).toBe("x");
    expect(presentationForm(ZWJ + "ػ" + ZWJ)).toBe("ػ");
  });

  it("sets Arabic in an RTL context and leaves Latin alone", () => {
    expect(glyphDirection("لا")).toBe("rtl");
    expect(glyphDirection("a")).toBe("inherit");
  });
});
