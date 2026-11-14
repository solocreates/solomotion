import { describe, expect, it } from "vitest";
import { phrasesFromWords, silencesBetween } from "./transcript";

const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs });

describe("transcript → captions", () => {
  const words = [
    w("Hello", 0, 300), w("there.", 320, 600),
    w("This", 1500, 1700), w("is", 1720, 1800), w("a", 1820, 1860), w("short", 1880, 2100), w("reel", 2120, 2400),
  ];

  it("breaks on sentences, breaths and length", () => {
    const phrases = phrasesFromWords(words, { maxWords: 4 });
    expect(phrases.map((p) => p.text)).toEqual(["Hello there.", "This is a short reel"]);
    expect(phrases[1]!.startMs).toBe(1500);
  });

  it("gives each word a cue over its own graphemes, relative to the phrase", () => {
    const [first] = phrasesFromWords(words, { maxWords: 4 });
    expect(first!.cues.map((c) => [c.start, c.end])).toEqual([[0, 5], [6, 12]]);
    expect(first!.cues[1]!.startMs).toBe(320);
  });

  it("finds the pauses worth cutting", () => {
    expect(silencesBetween(words, 700)).toEqual([[720, 1380]]);
  });
});
