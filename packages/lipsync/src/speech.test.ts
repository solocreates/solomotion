import { describe, expect, it } from "vitest";
import { phonemize, pronounce, wordPhonemes } from "./g2p/index";
import { fromElevenLabsAlignment, runSpeechEngine, speechEngine, type SpeechWord, type VisemeCue } from "./index";

const arpa = (w: string) => pronounce(w).phonemes.map((p) => p.phoneme).join(" ");

/** Contract every engine's cues must meet. */
function expectContract(cues: VisemeCue[], durationMs: number) {
  expect(cues[0]!.startMs).toBe(0);
  expect(cues[cues.length - 1]!.endMs).toBeCloseTo(durationMs, 6);
  for (let i = 0; i < cues.length; i++) {
    expect(cues[i]!.endMs).toBeGreaterThan(cues[i]!.startMs);
    if (i > 0) {
      expect(cues[i]!.startMs).toBe(cues[i - 1]!.endMs);
      expect(cues[i]!.viseme).not.toBe(cues[i - 1]!.viseme);
    }
  }
}

describe("G2P (English)", () => {
  // CMUdict pronunciations, stress ignored.
  const KNOWN: Record<string, string> = {
    // dictionary
    the: "DH AH", of: "AH V", one: "W AH N", people: "P IY P AH L", women: "W IH M AH N", "don't": "D OW N T",
    // morphology over the dictionary
    walked: "W AO K T", talking: "T AO K IH NG", friends: "F R EH N D Z", "voice's": "V OY S IH Z", "couldn't": "K UH D AH N T", "doors": "D AO R Z",
    // letter-to-sound rules
    cat: "K AE T", dog: "D AA G", fish: "F IH SH", bird: "B ER D", jump: "JH AH M P", stop: "S T AA P", sing: "S IH NG",
    think: "TH IH NG K", ship: "SH IH P", chip: "CH IH P", plan: "P L AE N", green: "G R IY N", sweet: "S W IY T",
    street: "S T R IY T", rain: "R EY N", train: "T R EY N", boat: "B OW T", moon: "M UW N", cake: "K EY K",
    bike: "B AY K", hope: "HH OW P", cute: "K Y UW T", nation: "N EY SH AH N", phone: "F OW N", knife: "N AY F",
    write: "R AY T", judge: "JH AH JH", quick: "K W IH K", table: "T EY B AH L", simple: "S IH M P AH L",
    rabbit: "R AE B IH T", happy: "HH AE P IY", flag: "F L AE G", black: "B L AE K", shop: "SH AA P",
    // known misses of the 1976 rules — kept in the list so the rate is honest
    brown: "B R AW N", city: "S IH T IY", window: "W IH N D OW", garden: "G AA R D AH N", zebra: "Z IY B R AH",
  };

  it("matches CMUdict on a known word list (measured rate ≥ 88%)", () => {
    const words = Object.keys(KNOWN);
    const hits = words.filter((w) => arpa(w) === KNOWN[w]);
    const rate = hits.length / words.length;
    // Measured: 47/52 = 90.4%. Misses: judge (JH AH D JH), brown, window, garden, zebra.
    expect(rate).toBeGreaterThanOrEqual(0.88);
    for (const w of ["the", "people", "walked", "voice's", "cat", "nation", "rabbit"]) expect(arpa(w)).toBe(KNOWN[w]);
  });

  it("normalises numbers, symbols, casing, contractions and punctuation", () => {
    const text = (s: string) => phonemize(s).map((t) => (t.kind === "word" ? t.text : t.mark)).join(" ");
    expect(text("I have 42 cats, 3.5 dogs and $5.")).toBe("I have forty two cats , three point five dogs and five dollars .");
    expect(text("Born 1999, on the 21st at 10:05?")).toBe("Born nineteen ninety nine , on the twenty first at ten oh five ?");
    expect(text("1,200 2007 50% 1980s")).toBe("one thousand two hundred two thousand seven fifty percent nineteen eighties");
    expect(pronounce("FBI").source).toBe("spell");
    expect(pronounce("NASA").source).not.toBe("spell");
    expect(phonemize("SoloMotion").filter((t) => t.kind === "word").map((t) => t.text)).toEqual(["Solo", "Motion"]);
    expect(wordPhonemes("you're").map((p) => p.phoneme)).toEqual(["Y", "UH", "R"]);
    expect(wordPhonemes("Zxqvbnm").length).toBeGreaterThan(0); // unknown → rules, never empty
  });
});

describe("align engine", () => {
  const words: SpeechWord[] = [
    { text: "Hello", startMs: 100, endMs: 450 },
    { text: "big", startMs: 470, endMs: 700 }, // 20ms gap: the mouth holds
    { text: "world", startMs: 1100, endMs: 1500 }, // 400ms pause: rest
  ];

  it("times phonemes inside words; short gaps hold, pauses rest", async () => {
    const t = await runSpeechEngine("align", { words, durationMs: 1800 });
    expectContract(t.cues, 1800);
    expect(t.phonemes!.find((p) => p.phoneme === "B")!.startMs).toBe(470);
    expect(t.cues.find((c) => c.startMs <= 460 && c.endMs > 460)!.viseme).not.toBe("X");
    expect(t.cues.find((c) => c.startMs <= 900 && c.endMs > 900)!.viseme).toBe("X");
    expect(t.cues.some((c) => c.viseme === "MBP")).toBe(true); // b
    expect(t.cues.some((c) => c.viseme === "L")).toBe(true); // l
    expect(t.energy.values.length).toBe(180);
  });

  it("survives zero-length, overlapping and unsorted words", async () => {
    const messy: SpeechWord[] = [
      { text: "world", startMs: 900, endMs: 900 },
      { text: "hello", startMs: 0, endMs: 600 },
      { text: "big", startMs: 500, endMs: 800 },
      { text: "  ", startMs: 10, endMs: 20 },
      { text: "nan", startMs: Number.NaN, endMs: 5 },
    ];
    const t = await runSpeechEngine("align", { words: messy, durationMs: 1200 });
    expectContract(t.cues, 1200);
    expect(t.words!.map((w) => w.text)).toEqual(["hello", "big", "world"]);
    expect(t.words![2]!.endMs - t.words![2]!.startMs).toBeGreaterThanOrEqual(60);
    for (let i = 1; i < t.words!.length; i++) expect(t.words![i]!.startMs).toBeGreaterThanOrEqual(t.words![i - 1]!.endMs);
  });

  it("takes timed phonemes (ARPAbet/IPA via the remote bridge) and ElevenLabs character timing", async () => {
    const t = await runSpeechEngine("align", {
      phonemes: [
        { phoneme: "M", startMs: 0, endMs: 80 },
        { phoneme: "AA", stress: 1, startMs: 80, endMs: 250 },
      ],
    });
    expect(t.cues.map((c) => c.viseme)).toEqual(["MBP", "AI"]);

    const el = fromElevenLabsAlignment({
      characters: [..."Hi, you"],
      character_start_times_seconds: [0, 0.08, 0.15, 0.2, 0.3, 0.38, 0.45],
      character_end_times_seconds: [0.08, 0.15, 0.2, 0.3, 0.38, 0.45, 0.6],
    });
    expect(el.kind).toBe("characters");
    const { remoteToInput } = await import("./remote");
    const words2 = remoteToInput(el).input.words!;
    expect(words2.map((w) => [w.text, w.startMs, w.endMs])).toEqual([["Hi,", 0, 200], ["you", 300, 600]]);
    const t2 = await runSpeechEngine("align", { words: words2 });
    expect(t2.cues.at(-1)!.viseme).toBe("U");
  });

  it("is linear: 50k words align in well under 2 s", async () => {
    const vocab = ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dogs", "1999", "can't"];
    const big: SpeechWord[] = [];
    for (let i = 0; i < 50_000; i++) big.push({ text: vocab[i % vocab.length]!, startMs: i * 300, endMs: i * 300 + 250 });
    const t0 = performance.now();
    const t = await runSpeechEngine("align", { words: big });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(t.cues.length).toBeGreaterThan(100_000);
    const broken = t.cues.findIndex((c, i) => c.endMs <= c.startMs || (i > 0 && c.startMs !== t.cues[i - 1]!.endMs));
    expect(broken).toBe(-1);
  });

  it("declares what it needs and refuses without it", async () => {
    expect(speechEngine("align")!.kind).toBe("align");
    await expect(runSpeechEngine("align", {})).rejects.toThrow(/transcript/);
  });
});
