import { describe, expect, it } from "vitest";
import { countUpObjects, countedText, countSpans, formatNumber, countFormat, mapSpanThroughCount, numberTokens } from "./count-up";
import { buildTextTimeline, epochAt } from "./schedule";

const g = (s: string) => [...s];
const LIN = { kind: "linear" } as const;

describe("numberTokens", () => {
  it("reads integers, decimals, signs, groups and non-Latin digits", () => {
    const t = numberTokens(g("I made -1,250.50 of 3 and ۱۲ then 07"));
    expect(t.map((x) => x.value)).toEqual([-1250.5, 3, 12, 7]);
    expect(t[0]).toMatchObject({ decimals: 2, groupSep: ",", start: 7, end: 16 });
    expect(t[2]!.system).toBe("persian");
    expect(t[3]!.leadingZeros).toBe(true);
  });
  it("keeps hyphens and sentence punctuation out of numbers", () => {
    expect(numberTokens(g("COVID-19.")).map((x) => x.value)).toEqual([19]);
    expect(numberTokens(g("1, 2")).map((x) => x.value)).toEqual([1, 2]);
  });
});

describe("formatNumber", () => {
  it("writes in the richer format of both ends", () => {
    const [a, b] = [numberTokens(g("0"))[0]!, numberTokens(g("12.50"))[0]!];
    expect(formatNumber(6.123, countFormat(a, b)).join("")).toBe("6.12");
    const [c, d] = [numberTokens(g("۰"))[0]!, numberTokens(g("۱۰۰"))[0]!];
    expect(formatNumber(42, countFormat(c, d)).join("")).toBe("۴۲");
    expect(formatNumber(-0.001, countFormat(a, b)).join("")).toBe("0.00");
    const [e, f] = [numberTokens(g("1,000"))[0]!, numberTokens(g("2,000,000"))[0]!];
    expect(formatNumber(1234567, countFormat(e, f)).join("")).toBe("1,234,567");
  });
});

describe("the counted view", () => {
  const from = g("I made 9 of money");
  const to = g("I made 100 money");
  const spans = countSpans(from, to, LIN, undefined);

  it("pairs the nth numbers across a key even when other words change", () => {
    expect(spans).toHaveLength(1);
    const half = countedText(from, spans, () => 0.5);
    expect(half.graphemes.join("")).toBe("I made 55 of money");
    // Both digits stand for the number's source digit.
    expect(half.source.slice(7, 9)).toEqual([7, 7]);
  });

  it("maps a range on the number over the whole number, and shifts what follows", () => {
    const view = countedText(from, spans, () => 0.5);
    expect(mapSpanThroughCount(view, 7, 8)).toEqual({ start: 7, end: 9 }); // "9" → "55"
    expect(mapSpanThroughCount(view, 9, 11)).toEqual({ start: 10, end: 12 }); // "of" moves right
    expect(mapSpanThroughCount(view, 0, 1)).toEqual({ start: 0, end: 1 });
  });

  it("does not count a switched-off number", () => {
    expect(countSpans(from, to, LIN, [{ slot: 0, enabled: false, easing: null }])).toHaveLength(0);
  });

  it("lists number objects across keys", () => {
    expect(countUpObjects(["0 / 10", "50 / 10"])).toEqual([
      { slot: 0, values: ["0", "50"], changes: true },
      { slot: 1, values: ["10", "10"], changes: false },
    ]);
  });
});

describe("the schedule counts between content keys", () => {
  const tl = buildTextTimeline(
    "",
    [
      { timeMs: 1000, text: "Score 0", easing: LIN },
      { timeMs: 2000, text: "Score 100", easing: LIN },
    ],
    5000,
  );

  it("holds the first value before the key, counts across the segment, lands on the key", () => {
    expect(epochAt(tl, 500).text).toBe("Score 0");
    expect(epochAt(tl, 1500).text).toBe("Score 50");
    expect(epochAt(tl, 2000).text).toBe("Score 100");
  });

  it("keeps the number one object across the cut — it does not re-arrive", () => {
    const after = epochAt(tl, 2500);
    // "100" inherited the arrival of "0" (epoch 0 opened at 0), not the cut at 2000.
    expect(after.enterAtMs.slice(6)).toEqual([0, 0, 0]);
  });

  it("mid-count digits carry the number's lifespan", () => {
    const mid = epochAt(tl, 1500);
    expect(mid.enterAtMs).toHaveLength(mid.seg.graphemes.length);
    expect(mid.view?.source.slice(6)).toEqual([6, 6]);
  });
});

describe("what is not a count", () => {
  it("a hold key cuts, and digits past an exact double never count (Two Balls' π wall)", () => {
    expect(countSpans(g("3"), g("31"), { kind: "hold" }, undefined)).toHaveLength(0);
    expect(countSpans(g("4502841027"), g("450284102701938521"), LIN, undefined)).toHaveLength(0);
    expect(countSpans(g("4"), g("45028410270193852133624"), LIN, undefined)).toHaveLength(0);
    expect(countSpans(g("0"), g("1000000"), LIN, undefined)).toHaveLength(1);
  });
});
