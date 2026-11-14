import { describe, expect, it } from "vitest";
import { measureLoudnessDb } from "./analysis";
import { nameSounds, soundCategory, soundName, soundTags, soundWords } from "./sound-taxonomy";

describe("soundWords", () => {
  it("reads all three upstream naming conventions", () => {
    expect(soundWords("Audio/forceField_000.ogg")).toEqual(["force", "field"]);
    expect(soundWords("footstep-concrete-02.wav")).toEqual(["footstep", "concrete"]);
    expect(soundWords("Impacts/Impact Heavy 3.wav")).toEqual(["impacts", "impact", "heavy"]);
  });

  it("drops words that would tag thousands of files with nothing", () => {
    expect(soundWords("Audio/sfx/click_final_v2.wav")).toEqual(["click"]);
  });
});

describe("soundCategory", () => {
  it("prefers the file's own words over its pack's", () => {
    // A file called `error_alarm` in an interface pack is a digital alarm.
    expect(soundCategory("error_alarm.wav", ["interface", "ui"])).toBe("digital");
  });

  it("falls back to the pack when the file name says nothing", () => {
    expect(soundCategory("s_04.wav", ["interface", "ui"])).toBe("interface");
    expect(soundCategory("s_04.wav")).toBe(null);
  });

  it("resolves the overlaps that a per-category map would get backwards", () => {
    // A laser is digital, not a weapon; an explosion is a weapon, not an impact.
    expect(soundCategory("laser_gun_01.wav")).toBe("digital");
    expect(soundCategory("explosion_hit.wav")).toBe("weapon");
  });

  it("reads the plural folder upstream actually ships", () => {
    // Upstream names the folder in the plural and the file in the singular.
    // Missing this left a fifth of a real archive on no shelf at all.
    expect(soundCategory("Hits/hit_01.wav")).toBe("impact");
    expect(soundCategory("Footsteps/fs_01.wav")).toBe("foley");
    expect(soundCategory("Whooshes/w_02.wav")).toBe("whoosh");
    expect(soundCategory("Zombies/z_03.wav")).toBe("creature");
  });

  it("files a sound by what it IS, never by the genre it came from", () => {
    // `game` used to be an arm here and swallowed a quarter of the catalogue.
    // A genre is a quality now: it narrows a shelf, it is not one.
    expect(soundCategory("rpg/sword_swing.wav")).toBe("weapon");
    expect(soundCategory("retro/coin_pickup.wav")).toBe("interface");
    expect(soundCategory("rpg_pack/potion_drink.wav")).toBe("magic");
    // A pack whose only word is a genre places nothing — silence beats a
    // wrong shelf, which is what the pack-level fallback used to hand out.
    expect(soundCategory("s_04.wav", ["rpg", "retro"])).toBe(null);
  });

  it("does not stem a word into a shelf it does not belong on", () => {
    // `glass` → `glas` and `bass` → `bas` must match nothing rather than
    // something: a crude stemmer is only safe because the lookup is closed.
    expect(soundCategory("bass_tone.wav")).toBe("music");
    expect(soundCategory("dice_roll.wav")).toBe("foley");
  });
});

describe("soundTags", () => {
  it("leads with the category and keeps only words worth searching", () => {
    const tags = soundTags({ path: "Impacts/heavy_metal_impact_03.wav", packTags: ["cc0"] });
    expect(tags[0]).toBe("impact");
    expect(tags).toContain("heavy");
    expect(tags).toContain("metal");
    expect(tags).toContain("cc0");
  });

  it("publishes what the audio measured, not what the name claims", () => {
    expect(soundTags({ path: "click.wav", facts: { durationMs: 120, hitMs: 0 } })).toContain("short");
    expect(soundTags({ path: "pad.wav", facts: { durationMs: 9000, hitMs: 0 } })).toContain("long");
    // A transient a long way in is a swell, not a strike — the difference
    // between a riser and an impact, and not visible in either name.
    expect(soundTags({ path: "boom.wav", facts: { durationMs: 4000, hitMs: 1800 } })).toContain("swell");
    expect(soundTags({ path: "boom.wav", facts: { durationMs: 4000, hitMs: 5 } })).not.toContain("swell");
  });
});

describe("soundTags", () => {
  it("normalises a plural to the word the vocabulary lists", () => {
    // A tag that only matches the spelling upstream happened to use is a tag
    // with a typo in it: `#hit` has to find `hits_heavy_01`.
    const tags = soundTags({ path: "Hits/hits_heavy_01.wav" });
    expect(tags).toContain("hit");
    expect(tags).not.toContain("hits");
  });
});

describe("soundName", () => {
  it("names a sound after itself, not after every folder above it", () => {
    // Upstream repeats itself, and folding the tree in produced real rows
    // reading "Battle Battle Bow" and five identical "Essential Retro Video
    // Ga…" that no reader could tell apart.
    expect(soundName("Battle sound effects/Battle/bow.wav")).toBe("Bow");
    expect(soundName("Essential Retro Video Game Sound Effects/Misc/jingle.wav")).toBe("Jingle");
  });

  it("falls back to the folder when the file name says nothing", () => {
    expect(soundName("Footsteps/01.wav")).toBe("Footsteps");
    expect(soundName("42.wav", "Impact Sounds")).toBe("Impact Sounds");
  });

  it("uses a repeated word once", () => {
    expect(soundName("swish_swish_2.wav")).toBe("Swish");
  });
});

describe("nameSounds", () => {
  it("numbers a one-based series exactly as upstream wrote it", () => {
    // Kenney's interface pack starts at 001. Shifting it gave a shelf that
    // began at "Back 2" — the bug this function exists to make impossible.
    const got = nameSounds(["back_001.ogg", "back_002.ogg", "back_003.ogg"]);
    expect([...got.values()]).toEqual(["Back 1", "Back 2", "Back 3"]);
  });

  it("shifts a zero-based series so nobody looks for take 0", () => {
    const got = nameSounds(["drop_000.ogg", "drop_001.ogg", "drop_002.ogg"]);
    expect([...got.values()]).toEqual(["Drop 1", "Drop 2", "Drop 3"]);
  });

  it("drops a number that distinguishes nothing", () => {
    // One bong in the pack: "Bong 1" is a number that exists only because a
    // tool could not tell it was alone.
    expect(nameSounds(["bong_001.ogg"]).get("bong_001.ogg")).toBe("Bong");
  });

  it("resolves each series independently in one folder", () => {
    const got = nameSounds(["back_001.ogg", "back_002.ogg", "drop_000.ogg", "drop_001.ogg"]);
    expect(got.get("back_001.ogg")).toBe("Back 1");
    expect(got.get("drop_000.ogg")).toBe("Drop 1");
  });

  it("names a numbers-only file after its pack rather than after a digit", () => {
    expect(soundName("004.wav", "Impacts")).toBe("Impacts");
  });
});

describe("measureLoudnessDb", () => {
  const tone = (n: number, amp: number) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.sin((i / 48) * Math.PI * 2) * amp;
    return out;
  };

  it("hears a level difference peak cannot", () => {
    // Both peak at 1.0: one is a sustained tone, one is a 3 ms tick in silence.
    const sustained = tone(48000, 1);
    const tick = new Float32Array(48000);
    tick.set(tone(144, 1), 0);
    expect(measureLoudnessDb(sustained, 48000)).toBeGreaterThan(measureLoudnessDb(tick, 48000) + 6);
  });

  it("tracks amplitude in dB", () => {
    const loud = measureLoudnessDb(tone(48000, 1), 48000);
    const quiet = measureLoudnessDb(tone(48000, 0.5), 48000);
    expect(loud - quiet).toBeCloseTo(6, 0);
  });

  it("is not fooled by a long silent tail", () => {
    // A 200 ms hit padded to 3 seconds must measure as the hit, not as the
    // average of hit-and-silence — otherwise the loudest sounds read quietest.
    const padded = new Float32Array(48000 * 3);
    padded.set(tone(9600, 1), 0);
    expect(measureLoudnessDb(padded, 48000)).toBeCloseTo(measureLoudnessDb(tone(9600, 1), 48000), 0);
  });

  it("answers honestly for silence", () => {
    expect(measureLoudnessDb(new Float32Array(1000), 48000)).toBe(-Infinity);
  });
});
