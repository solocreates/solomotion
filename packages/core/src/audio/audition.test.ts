import { describe, expect, it } from "vitest";
import {
  auditionGain,
  ceilingGain,
  guardTrimDb,
  ended,
  emptyQueue,
  evictTargets,
  playAt,
  preloadAhead,
  preloadTargets,
  retarget,
  step,
  type AuditionQueue,
  type PreloadCandidate,
  type PreloadPolicy,
} from "./audition";
import { soundDropPlan, type SoundDropSubject } from "./sound-drop";

const queue = (ids: string[], at: number, extra: Partial<AuditionQueue> = {}): AuditionQueue => ({
  ids,
  at,
  loop: "off",
  streak: 0,
  ...extra,
});

describe("audition queue", () => {
  it("wraps in both directions", () => {
    const q = queue(["a", "b", "c"], 2);
    expect(step(q, 1).at).toBe(0);
    expect(step(queue(["a", "b", "c"], 0), -1).at).toBe(2);
  });

  it("starts from the top on next with nothing armed", () => {
    expect(step(emptyQueue(), 1).at).toBe(-1);
    expect(step(queue(["a", "b"], -1), 1).at).toBe(0);
  });

  it("keeps playing the SAME sound when the list is re-sorted", () => {
    const q = playAt(queue(["a", "b", "c"], -1), "b");
    expect(q.at).toBe(1);
    // Reverse the list; "b" moved but is still what is playing.
    expect(retarget(q, ["c", "b", "a"]).at).toBe(1);
    expect(retarget(q, ["c", "a", "b"]).at).toBe(2);
  });

  it("breaks the run when the armed sound is filtered away", () => {
    const q = queue(["a", "b"], 1, { streak: 3 });
    const gone = retarget(q, ["a"]);
    expect(gone.at).toBe(-1);
    expect(gone.streak).toBe(0);
  });

  it("a deliberate click restarts the run rather than continuing it", () => {
    expect(playAt(queue(["a", "b"], 0, { streak: 5 }), "b").streak).toBe(1);
  });

  it("honours the loop mode when a sound ends", () => {
    const q = queue(["a", "b"], 0);
    expect(ended({ ...q, loop: "off" })).toMatchObject({ play: false });
    // Stopping keeps the row armed, so space plays it again.
    expect(ended({ ...q, loop: "off" }).queue.at).toBe(0);
    expect(ended({ ...q, loop: "one" })).toMatchObject({ play: true });
    expect(ended({ ...q, loop: "one" }).queue.at).toBe(0);
    const all = ended({ ...q, loop: "all" });
    expect(all.play).toBe(true);
    expect(all.queue.at).toBe(1);
  });
});

describe("preload policy", () => {
  const policy: PreloadPolicy = {
    enabled: true,
    maxAhead: 4,
    maxDurationMs: 15_000,
    budgetBytes: 1000,
  };
  const facts = (ids: string[], f: PreloadCandidate): Map<string, PreloadCandidate> =>
    new Map(ids.map((id) => [id, f]));

  it("leans forward exactly as far as the run is long, up to the cap", () => {
    expect(preloadAhead(0, policy)).toBe(0);
    expect(preloadAhead(1, policy)).toBe(1);
    expect(preloadAhead(3, policy)).toBe(3);
    expect(preloadAhead(99, policy)).toBe(4);
  });

  it("fetches nothing when turned off", () => {
    expect(preloadAhead(9, { ...policy, enabled: false })).toBe(0);
    expect(
      preloadTargets(
        {
          queue: queue(["a", "b"], 0, { streak: 5 }),
          facts: facts(["a", "b"], { durationMs: 100, bytes: 10 }),
          warm: new Set(),
          warmBytes: 0,
        },
        { ...policy, enabled: false },
      ),
    ).toEqual([]);
  });

  it("wants the next rows in order, skipping what is already warm", () => {
    const got = preloadTargets(
      {
        queue: queue(["a", "b", "c", "d"], 0, { streak: 3 }),
        facts: facts(["a", "b", "c", "d"], { durationMs: 500, bytes: 10 }),
        warm: new Set(["b"]),
        warmBytes: 10,
      },
      policy,
    );
    expect(got).toEqual(["c", "d"]);
  });

  it("refuses long sounds — a 3-minute ambience is not the next click", () => {
    const got = preloadTargets(
      {
        queue: queue(["a", "b", "c"], 0, { streak: 3 }),
        facts: new Map([
          ["b", { durationMs: 180_000, bytes: 10 }],
          ["c", { durationMs: 400, bytes: 10 }],
        ]),
        warm: new Set(),
        warmBytes: 0,
      },
      policy,
    );
    expect(got).toEqual(["c"]);
  });

  it("stops at the byte budget rather than filling memory", () => {
    const got = preloadTargets(
      {
        queue: queue(["a", "b", "c", "d"], 0, { streak: 4 }),
        facts: facts(["a", "b", "c", "d"], { durationMs: 500, bytes: 400 }),
        warm: new Set(),
        warmBytes: 300,
      },
      policy,
    );
    // 1000 − 300 warm = 700 left; one 400 KB fits, the second does not.
    expect(got).toEqual(["b"]);
  });

  it("evicts the least recently heard, never what is in use", () => {
    const entries = new Map([
      ["old", { bytes: 100, heardAt: 1 }],
      ["mid", { bytes: 100, heardAt: 2 }],
      ["new", { bytes: 100, heardAt: 3 }],
    ]);
    expect(evictTargets(entries, new Set(), 400)).toEqual([]);
    expect(evictTargets(entries, new Set(), 150)).toEqual(["old", "mid"]);
    expect(evictTargets(entries, new Set(["old"]), 150)).toEqual(["mid", "new"]);
  });
});

describe("ear guard", () => {
  const guard = { enabled: true, ceilingDb: -18 };

  it("leaves a quiet sound completely alone — a ceiling, not a normaliser", () => {
    expect(ceilingGain(-30, -18)).toBe(1);
    expect(ceilingGain(-18, -18)).toBe(1);
    expect(ceilingGain(-Infinity, -18)).toBe(1);
  });

  it("ducks a loud sound by exactly its excess", () => {
    // 6 dB over the ceiling → −6 dB of correction ≈ 0.501.
    expect(ceilingGain(-12, -18)).toBeCloseTo(0.501, 3);
    expect(guardTrimDb(-12, guard)).toBeCloseTo(-6, 5);
    expect(guardTrimDb(-30, guard)).toBe(0);
    expect(guardTrimDb(-12, { ...guard, enabled: false })).toBe(0);
  });

  it("keeps two loud sounds in their real order", () => {
    // The louder of two still plays louder after the guard: only the excess is
    // removed, so the reason you are auditioning survives.
    const a = auditionGain(1, -10, guard);
    const b = auditionGain(1, -14, guard);
    expect(a).toBeLessThan(b);
  });

  it("keeps the volume slider working on loud files", () => {
    // Halving the volume halves the result, guard or no guard — the bug a
    // `min()` would cause is that 50 % and 100 % sound identical here.
    expect(auditionGain(0.5, -6, guard)).toBeCloseTo(auditionGain(1, -6, guard) / 2, 6);
    expect(auditionGain(1, -6, { ...guard, enabled: false })).toBe(1);
  });
});

describe("sound drop plan", () => {
  const subject: SoundDropSubject = { durationMs: 2000, hitMs: 300, loudnessDb: -12 };

  it("lands the transient on the drop point, not the first sample", () => {
    expect(soundDropPlan(subject, 5000).startMs).toBe(4700);
  });

  it("takes the alignment as far as it can rather than going negative", () => {
    expect(soundDropPlan(subject, 100).startMs).toBe(0);
  });

  it("starts the file at the drop point when alignment is off", () => {
    const plan = soundDropPlan(subject, 5000, {
      fadeInMs: 0,
      fadeOutMs: 0,
      gainDb: 0,
      pitchSemitones: 0,
      alignHit: false,
      matchAuditionLevel: false,
    });
    expect(plan.startMs).toBe(5000);
  });

  it("never lets the two fades overlap", () => {
    const plan = soundDropPlan({ durationMs: 200, hitMs: 0, loudnessDb: -12 }, 0, {
      fadeInMs: 500,
      fadeOutMs: 500,
      gainDb: 0,
      pitchSemitones: 0,
      alignHit: true,
      matchAuditionLevel: false,
    });
    expect(plan.fadeIn.durationMs).toBe(100);
    expect(plan.fadeOut.durationMs).toBe(100);
  });

  it("carries the guard's correction onto the clip only when asked", () => {
    const opts = {
      fadeInMs: 0,
      fadeOutMs: 0,
      gainDb: 0,
      pitchSemitones: 0,
      alignHit: true,
      matchAuditionLevel: true,
    };
    const guard = { enabled: true, ceilingDb: -18 };
    // −12 dB measured against a −18 dB ceiling is 6 dB over.
    expect(soundDropPlan(subject, 0, opts, guard).gain).toBeCloseTo(0.501, 3);
    expect(soundDropPlan(subject, 0, { ...opts, matchAuditionLevel: false }, guard).gain).toBe(1);
    // Unmeasured: no correction rather than a guess.
    expect(soundDropPlan({ ...subject, loudnessDb: null }, 0, opts, guard).gain).toBe(1);
  });
});
