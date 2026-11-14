import { describe, expect, it } from "vitest";
import {
  MIN_CUE_MS,
  activeCueIndexAt,
  buildCues,
  captionTravelAt,
  cueTextOf,
  distributeCues,
  effectiveRanges,
  mergeCueWithNext,
  normalizeCues,
  remapCuesAfterSplice,
  replaceCueText,
  selectionScope,
  spliceClipText,
  cuesAreWordGrained,
  shiftCueSplit,
  setCueTime,
  cueEdgeBounds,
  cuesMisfitClip,
  cuesOverflowClip,
  dragCueEdge,
  fitCuesToClip,
  slipCue,
  splitCue,
  stampCueStart,
} from "./index";
import { createEmptyDocument, createTextClip } from "../factories";
import { parseHexColor } from "../animation/properties";
import { parseDocument, serializeDocument } from "../io";
import { remapRangesAfterSplice } from "../text/ranges";
import { emptyOverlay, overlayStyle } from "../scope";
import type { PartialTextStyle } from "../schema";

/** An overlay's props: style fields, or dotted property paths (`highlight.color`). */
type OverlayProps = PartialTextStyle | Record<`${string}.${string}`, unknown>;
/** A one-line overlay literal — the tests care about the props, not the shape. */
const ov = (props: OverlayProps) => ({ ...emptyOverlay(), props: props as Record<string, never> });
import type { CaptionCue, TextClip } from "../schema";

const TEXT = "one two three four";

function captionClip(text = TEXT, durationMs = 4000): TextClip {
  return createTextClip({ frameId: "f", text, startMs: 0, durationMs, caption: {} });
}

describe("cue seeding", () => {
  it("cuts a string into evenly-timed word spans that exclude the whitespace", () => {
    const cues = buildCues(TEXT, 4000);
    expect(cues.map((c) => cueTextOf(TEXT, c))).toEqual(["one", "two", "three", "four"]);
    expect(cues.map((c) => c.startMs)).toEqual([0, 1000, 2000, 3000]);
    expect(cues.map((c) => c.endMs)).toEqual([1000, 2000, 3000, 4000]);
  });

  it("cuts by line and by letter from the same primitive", () => {
    expect(buildCues("ab\ncd", 100, "line").map((c) => cueTextOf("ab\ncd", c))).toEqual(["ab", "cd"]);
    expect(buildCues("ab cd", 100, "letter").length).toBe(4);
  });
});

describe("cue timing", () => {
  it("keeps touching cues touching, so a boundary drag never opens a hole", () => {
    const cues = buildCues(TEXT, 4000);
    expect(setCueTime(cues, cues[1]!.id, "start", 1500, 4000)).toBe(true);
    expect(cues[1]!.startMs).toBe(1500);
    expect(cues[0]!.endMs).toBe(1500);
    expect(cues[1]!.endMs).toBe(2000);
  });

  it("leaves real silence alone when only one side is being dragged", () => {
    const cues = buildCues("a b", 4000);
    cues[1]!.startMs = 3000; // a gap the user made on purpose
    setCueTime(cues, cues[1]!.id, "start", 2500, 4000);
    expect(cues[1]!.startMs).toBe(2500);
    expect(cues[0]!.endMs).toBe(2000); // untouched — the gap survives
  });

  it("clamps against its neighbours and its own minimum length", () => {
    const cues = buildCues(TEXT, 4000);
    setCueTime(cues, cues[1]!.id, "start", 99_000, 4000);
    expect(cues[1]!.startMs).toBe(cues[1]!.endMs - MIN_CUE_MS);
    setCueTime(cues, cues[1]!.id, "start", -5000, 4000);
    expect(cues[1]!.startMs).toBe(cues[0]!.startMs + MIN_CUE_MS);
  });

  it("tap-sync pushes only the cues that have not been tapped yet", () => {
    const cues = buildCues("a b c d", 4000);
    stampCueStart(cues, 1, 3500, 4000);
    expect(cues[1]!.startMs).toBe(3500);
    expect(cues[2]!.startMs).toBeGreaterThan(cues[1]!.startMs);
    expect(cues[3]!.startMs).toBeGreaterThan(cues[2]!.startMs);
    expect(cues[0]!.endMs).toBe(cues[1]!.startMs); // the gap behind closes
  });

  it("normalizes overlaps by pushing the later cue, never the earlier one", () => {
    const cues: CaptionCue[] = [
      { id: "b", start: 4, end: 7, startMs: 500, endMs: 1500 },
      { id: "a", start: 0, end: 3, startMs: 0, endMs: 1000 },
    ];
    const out = normalizeCues(cues, 7, 4000);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out[1]!.startMs).toBe(1000);
  });
});

describe("dragging a cue edge", () => {
  it("reaches the clip's end from the LAST cue — the wall that used to exist", () => {
    const cues = buildCues(TEXT, 4000);
    cues[3]!.endMs = 2500; // a caption seeded short, on a clip that then grew
    cues[3]!.startMs = 2000;
    expect(dragCueEdge(cues, cues[3]!.id, "end", 4000, 4000)).toBe(true);
    expect(cues[3]!.endMs).toBe(4000);
  });

  it("reaches 0 from the FIRST cue's start", () => {
    const cues = buildCues(TEXT, 4000);
    cues[0]!.startMs = 800;
    expect(dragCueEdge(cues, cues[0]!.id, "start", -500, 4000)).toBe(true);
    expect(cues[0]!.startMs).toBe(0);
  });

  it("rolls a joined neighbour, then pushes it once the gesture goes past", () => {
    const cues = buildCues(TEXT, 4000); // 0-1000 1000-2000 2000-3000 3000-4000
    dragCueEdge(cues, cues[0]!.id, "end", 1500, 4000);
    expect(cues[1]!.startMs).toBe(1500); // rolled, still gapless
    expect(cues[1]!.endMs).toBe(2000); // and shorter, not moved

    dragCueEdge(cues, cues[0]!.id, "end", 2500, 4000);
    expect(cues[1]!.startMs).toBe(2500);
    expect(cues[1]!.endMs).toBe(2500 + MIN_CUE_MS); // pushed along, at its floor
    expect(cues[2]!.startMs).toBeGreaterThanOrEqual(cues[1]!.endMs);
    expect(cues[3]!.endMs).toBeLessThanOrEqual(4000);
  });

  it("a gap absorbs the push before the neighbour feels it", () => {
    const cues = buildCues("a b", 4000);
    cues[0]!.endMs = 1000;
    cues[1]!.startMs = 3000; // deliberate silence
    dragCueEdge(cues, cues[0]!.id, "end", 2000, 4000);
    expect(cues[0]!.endMs).toBe(2000);
    expect(cues[1]!.startMs).toBe(3000); // untouched — the gap paid for it
  });

  it("never drops a cue below its minimum, however hard it is shoved", () => {
    const cues = buildCues(TEXT, 4000);
    dragCueEdge(cues, cues[0]!.id, "end", 99_000, 4000);
    for (const c of cues) expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(MIN_CUE_MS);
    expect(cues[3]!.endMs).toBe(4000);
    expect(cues.map((c) => c.startMs)).toEqual([...cues].sort((a, b) => a.startMs - b.startMs).map((c) => c.startMs));
  });

  it("bounds say what the field can actually reach", () => {
    const cues = buildCues(TEXT, 4000);
    expect(cueEdgeBounds(cues, cues[3]!.id, "end", 4000)).toEqual({ lo: 3000 + MIN_CUE_MS, hi: 4000 });
    expect(cueEdgeBounds(cues, cues[0]!.id, "start", 4000)!.lo).toBe(0);
    expect(cueEdgeBounds(cues, "nope", "end", 4000)).toBeNull();
  });

  it("slips a cue without changing how long it holds", () => {
    const cues = buildCues("a b c", 3000);
    const length = cues[1]!.endMs - cues[1]!.startMs;
    slipCue(cues, cues[1]!.id, 1500, 3000);
    expect(cues[1]!.startMs).toBe(1500);
    expect(cues[1]!.endMs - cues[1]!.startMs).toBe(length);
    expect(cues[2]!.startMs).toBeGreaterThanOrEqual(cues[1]!.endMs);
  });
});

describe("fitting cues to a clip that grew", () => {
  it("stretches the list to the clip end, keeping every cue's share", () => {
    const cues = buildCues(TEXT, 2000);
    const fitted = fitCuesToClip(cues, 12_000);
    expect(fitted[0]!.startMs).toBe(0);
    expect(fitted[fitted.length - 1]!.endMs).toBe(12_000);
    expect(fitted.map((c) => c.endMs - c.startMs)).toEqual([3000, 3000, 3000, 3000]);
  });

  it("knows when the cues and the clip disagree, in EITHER direction", () => {
    // Stranded in the head of a clip that grew.
    expect(cuesMisfitClip(buildCues(TEXT, 2000), 12_000)).toBe(true);
    // Hanging past the end of a clip that was trimmed in — those cues exist
    // but can never be spoken, and clamping them on trim would have destroyed
    // timing that trimming back out could not restore.
    expect(cuesMisfitClip(buildCues(TEXT, 12_000), 2000)).toBe(true);
    expect(cuesOverflowClip(buildCues(TEXT, 12_000), 2000)).toBe(true);
    expect(cuesOverflowClip(buildCues(TEXT, 4000), 4000)).toBe(false);
    expect(cuesMisfitClip(buildCues(TEXT, 4000), 4000)).toBe(false);
    expect(cuesMisfitClip([], 4000)).toBe(false);
  });
});

describe("cue spans", () => {
  it("cascades: lengthening one row pushes a word through every row after it", () => {
    const text = "one two three four";
    let cues = mergeCueWithNext(buildCues(text, 4000), 2); // one | two | three four
    cues = shiftCueSplit(cues, 0, 1, text);
    expect(cues.map((c) => cueTextOf(text, c))).toEqual(["one two", "three", "four"]);
    // And back — the gesture is its own inverse.
    expect(shiftCueSplit(cues, 0, -1, text).map((c) => cueTextOf(text, c)))
      .toEqual(["one", "two", "three four"]);
  });

  it("refuses to move when a row would be left with no words", () => {
    const text = "one two three four";
    const cues = buildCues(text, 4000); // four rows, four words — nothing to give
    expect(shiftCueSplit(cues, 0, 1, text)).toBe(cues);
    expect(shiftCueSplit(cues, 0, 0, text)).toBe(cues);
    expect(shiftCueSplit(cues, 3, 1, text)).toBe(cues); // no split after the last row
  });

  it("never breaks a word, however far the drag goes", () => {
    const text = "a b c d e f";
    const cues = mergeCueWithNext(mergeCueWithNext(buildCues(text, 6000), 0), 0); // a b c | d | e | f
    expect(shiftCueSplit(cues, 0, -99, text).map((c) => cueTextOf(text, c)))
      .toEqual(["a", "b", "c", "d e f"]);
  });

  it("splits and merges rows, splitting the time proportionally", () => {
    let cues = buildCues("hello", 1000);
    cues = splitCue(cues, 0, 2);
    expect(cues.map((c) => cueTextOf("hello", c))).toEqual(["he", "llo"]);
    expect(cues[0]!.endMs).toBe(400);
    cues = mergeCueWithNext(cues, 0);
    expect(cues.length).toBe(1);
    expect(cueTextOf("hello", cues[0]!)).toBe("hello");
    expect(cues[0]!.endMs).toBe(1000);
  });

  it("distributes evenly without touching the spans", () => {
    const cues = buildCues(TEXT, 4000);
    setCueTime(cues, cues[1]!.id, "start", 1500, 4000);
    const even = distributeCues(cues, 4000);
    expect(even.map((c) => c.startMs)).toEqual([0, 1000, 2000, 3000]);
    expect(even.map((c) => cueTextOf(TEXT, c))).toEqual(["one", "two", "three", "four"]);
  });
});

describe("editing the text under the cues", () => {
  it("keeps every cue's timing when a word is appended — the old rebuild bug", () => {
    const cues = buildCues(TEXT, 4000);
    const before = cues.map((c) => [c.startMs, c.endMs]);
    const edit = replaceCueText(TEXT, cues[3]!, "four five");
    const next = remapCuesAfterSplice(cues, edit.at, edit.removed, edit.inserted);
    expect(edit.text).toBe("one two three four five");
    expect(next.map((c) => [c.startMs, c.endMs])).toEqual(before);
    expect(next.map((c) => cueTextOf(edit.text, c))).toEqual(["one", "two", "three", "four five"]);
  });

  it("re-indexes later cues when an earlier row grows or shrinks", () => {
    const cues = buildCues(TEXT, 4000);
    const edit = replaceCueText(TEXT, cues[0]!, "ONE!!!");
    const next = remapCuesAfterSplice(cues, edit.at, edit.removed, edit.inserted);
    expect(next.map((c) => cueTextOf(edit.text, c))).toEqual(["ONE!!!", "two", "three", "four"]);
  });

  it("drops a cue whose text was deleted outright", () => {
    const cues = buildCues(TEXT, 4000);
    const edit = replaceCueText(TEXT, cues[1]!, "");
    const next = remapCuesAfterSplice(cues, edit.at, edit.removed, edit.inserted);
    expect(next.length).toBe(3);
  });

  it("remaps cues and style ranges through the SAME splice arithmetic", () => {
    const cues = buildCues(TEXT, 4000);
    const ranges = [{ id: "r", start: 8, end: 13, overlay: ov({ color: "#f00" }), animation: null, sounds: {} }];
    const edit = replaceCueText(TEXT, cues[0]!, "ONE!!!");
    const c = remapCuesAfterSplice(cues, edit.at, edit.removed, edit.inserted);
    const r = remapRangesAfterSplice(ranges, edit.at, edit.removed, edit.inserted);
    expect(cueTextOf(edit.text, c[2]!)).toBe("three");
    expect(edit.text.slice(r[0]!.start, r[0]!.end)).toBe("three");
  });
});

describe("a word-grained caption stays on its words", () => {
  /** Type `insert` at grapheme `at` on the canvas — what the inline editor does. */
  const type = (clip: TextClip, at: number, insert: string, remove = 0) => {
    const next = clip.text.slice(0, at) + insert + clip.text.slice(at + remove);
    spliceClipText(clip, next, { at, removed: remove, inserted: insert.length });
    return clip.caption!.cues.map((c) => cueTextOf(clip.text, c));
  };

  it("knows a word-grained caption from a hand-split one", () => {
    const clip = captionClip();
    clip.caption!.cues = buildCues(TEXT, 4000);
    expect(cuesAreWordGrained(TEXT, clip.caption!.cues)).toBe(true);
    expect(cuesAreWordGrained(TEXT, buildCues(TEXT, 4000, "letter"))).toBe(false);
    expect(cuesAreWordGrained(TEXT, [{ id: "p", start: 0, end: 7, startMs: 0, endMs: 1000 }])).toBe(false);
  });

  it("carries the cues across an inline edit at all — the bug the editor had", () => {
    const clip = captionClip();
    clip.caption!.cues = buildCues(TEXT, 4000);
    const timing = clip.caption!.cues.map((c) => [c.startMs, c.endMs]);
    // Retype the spoken word: its cue grows with it, nothing after it moves.
    expect(type(clip, 3, "!!!")).toEqual(["one!!!", "two", "three", "four"]);
    expect(clip.caption!.cues.map((c) => [c.startMs, c.endMs])).toEqual(timing);
  });

  it("letters typed at the FRONT of a word join that word's cue", () => {
    const clip = captionClip();
    clip.caption!.cues = buildCues(TEXT, 4000);
    expect(type(clip, 4, "x")).toEqual(["one", "xtwo", "three", "four"]);
    expect(clip.caption!.cues[1]).toMatchObject({ startMs: 1000, endMs: 2000 });
  });

  it("a new word typed after a cue becomes its own cue, sharing that cue's time", () => {
    const clip = captionClip();
    clip.caption!.cues = buildCues(TEXT, 4000);
    const firstId = clip.caption!.cues[0]!.id;
    expect(type(clip, 3, " new")).toEqual(["one", "new", "two", "three", "four"]);
    const [one, fresh, two] = clip.caption!.cues;
    // "one" and "new" share the first second by length; "two" is untouched,
    // and "one" keeps its identity (a focus override keyed on it survives).
    expect(one).toMatchObject({ id: firstId, startMs: 0, endMs: 500 });
    expect(fresh).toMatchObject({ startMs: 500, endMs: 1000 });
    expect(two).toMatchObject({ startMs: 1000, endMs: 2000 });
  });

  it("deleting the space between two words merges their cues", () => {
    const clip = captionClip();
    clip.caption!.cues = buildCues(TEXT, 4000);
    expect(type(clip, 3, "", 1)).toEqual(["onetwo", "three", "four"]);
    expect(clip.caption!.cues[0]).toMatchObject({ startMs: 0, endMs: 2000 });
  });

  it("leaves a word that was deliberately uncovered alone", () => {
    const clip = captionClip();
    clip.caption!.cues = buildCues(TEXT, 4000).filter((c) => cueTextOf(TEXT, c) !== "two");
    expect(type(clip, 18, " five")).toEqual(["one", "three", "four", "five"]);
  });

  it("does not re-cut a hand-split caption into words", () => {
    const clip = captionClip();
    clip.caption!.cues = [
      { id: "a", start: 0, end: 7, startMs: 0, endMs: 2000 },
      { id: "b", start: 8, end: 18, startMs: 2000, endMs: 4000 },
    ];
    expect(type(clip, 18, " five")).toEqual(["one two", "three four five"]);
  });
});

describe("what a selection means", () => {
  it("is the layer for nothing or everything, the focus for the spoken word, else a range", () => {
    const clip = captionClip();
    clip.caption!.cues = buildCues(TEXT, 4000);
    expect(selectionScope(clip, null, 0)).toEqual({ kind: "base" });
    expect(selectionScope(clip, { start: 0, end: 18 }, 0)).toEqual({ kind: "base" });
    // "two" is spoken during the second second.
    expect(selectionScope(clip, { start: 4, end: 7 }, 1500)).toEqual({ kind: "caption", state: "focus" });
    // Selecting it a second EARLY is selecting a word not yet spoken, and the
    // sidebar should offer the state that describes it rather than the span.
    expect(selectionScope(clip, { start: 4, end: 7 }, 500)).toEqual({ kind: "caption", state: "unread" });
    // Two whole unread cues still agree, so the guess holds.
    expect(selectionScope(clip, { start: 4, end: 13 }, 500)).toEqual({ kind: "caption", state: "unread" });
    // Half a cue is about those characters, whatever state they are in.
    expect(selectionScope(clip, { start: 4, end: 9 }, 1500)).toEqual({ kind: "range", start: 4, end: 9 });
    // And a run straddling the spoken word has no single state to mean.
    expect(selectionScope(clip, { start: 4, end: 13 }, 1500)).toEqual({ kind: "range", start: 4, end: 13 });
  });
});

describe("the state projection", () => {
  /** A caption whose states are explicit, so a test asserts what it set. */
  function stated(clip: TextClip, focusProps: OverlayProps, unread?: OverlayProps) {
    clip.caption!.states.focus.overlay = ov(focusProps);
    clip.caption!.states.unread.overlay = unread ? ov(unread) : emptyOverlay();
    clip.caption!.states.read.overlay = emptyOverlay();
    clip.caption!.motion.durationMs = 0;
    return clip;
  }

  it("gives every cue a range for the state it is in, not just the spoken one", () => {
    const clip = stated(captionClip(), { color: "#F5B843" }, { opacity: 0.4 });
    const at = effectiveRanges(clip, 1500); // cue 1 = "two"
    expect(at.map((r) => r.scope)).toEqual(["read", "focus", "unread", "unread"]);
    expect(overlayStyle(at[0]!.overlay)).toEqual({});
    expect(overlayStyle(at[1]!.overlay)).toMatchObject({ color: "#F5B843" });
    expect(overlayStyle(at[2]!.overlay)).toMatchObject({ opacity: 0.4 });

    const plain = createTextClip({ frameId: "f", text: TEXT, startMs: 0 });
    expect(effectiveRanges(plain, 500)).toBe(plain.ranges);
  });

  it("keeps spoken cues READ inside a gap — the state is read from time, not from an active index", () => {
    const clip = stated(captionClip(), { color: "#F5B843" }, { opacity: 0.4 });
    clip.caption!.cues = [
      { id: "a", start: 0, end: 3, startMs: 0, endMs: 500 },
      { id: "b", start: 4, end: 7, startMs: 1500, endMs: 2000 },
    ];
    // 900ms is silence. "one" has been said; "two" has not.
    expect(effectiveRanges(clip, 900).map((r) => r.scope)).toEqual(["read", "unread"]);
  });

  it("focus beats a range it overlaps; the other two states sit UNDER one", () => {
    const clip = stated(captionClip(), { color: "#F5B843" }, { color: "#888888" });
    // A permanent red run spanning "two three".
    clip.ranges = [{ id: "r", start: 4, end: 13, overlay: ov({ color: "#ff0000", italic: true }), animation: null, sounds: {} }];

    const at = effectiveRanges(clip, 1500); // cue 1 = "two" (4..7)
    const covered = at.filter((r) => r.start >= 4 && r.end <= 13);
    // The spoken slice takes the focus colour over the range's own.
    expect(overlayStyle(covered[0]!.overlay)).toMatchObject({ color: "#F5B843", italic: true });
    // "three" is unread, but the hand-made range is the more specific scope and
    // keeps its red — a backdrop must not overwrite what you selected and set.
    expect(overlayStyle(covered[1]!.overlay)).toMatchObject({ color: "#ff0000", italic: true });
  });

  it("recolouring the whole layer moves the states that said nothing and spares the ones that did", () => {
    const clip = stated(captionClip(), { color: "#F5B843" });
    clip.style.color = "#00ff00"; // the "change the whole text colour" path
    const at = effectiveRanges(clip, 500);
    expect(overlayStyle(at[0]!.overlay).color).toBe("#F5B843");
    expect(overlayStyle(at[1]!.overlay).color).toBeUndefined();
    expect(clip.style.color).toBe("#00ff00");
  });

  it("eases props across a crossing and switches structure at the halfway mark", () => {
    const clip = stated(captionClip(), { opacity: 1 }, { opacity: 0 });
    clip.caption!.motion = { durationMs: 400, easing: { kind: "linear" }, travel: false };
    // "two" takes focus at 1000; halfway through its crossing it is half lit.
    expect(overlayStyle(effectiveRanges(clip, 1200)[1]!.overlay).opacity).toBeCloseTo(0.5, 2);
    // And once the crossing is over it is the state itself, by reference — the
    // fast path that keeps a settled caption allocating nothing per frame.
    expect(effectiveRanges(clip, 1500)[1]!.overlay).toBe(clip.caption!.states.focus.overlay);
  });

  it("fades a pill the other state never declares, instead of snapping it off", () => {
    const clip = stated(captionClip(), { "highlight.color": "#F5B843" });
    clip.caption!.motion = { durationMs: 400, easing: { kind: "linear" }, travel: false };
    // "one" leaves focus at 1000 and READ says nothing about pills. Halfway
    // through the crossing the pill is half transparent — not still solid.
    const leaving = effectiveRanges(clip, 1200)[0]!;
    expect(leaving.overlay.props["highlight.color"]).toBe("#f5b84380");
    // And gone entirely once the crossing is over.
    expect(effectiveRanges(clip, 1500)[0]!.overlay.props["highlight.color"]).toBeUndefined();
  });

  it("eases a glyph colour the other state never declares toward the LAYER's colour, never through transparent", () => {
    const clip = stated(captionClip(), { color: "#FFF6E6" });
    clip.style.color = "#FFFFFF";
    clip.caption!.motion = { durationMs: 400, easing: { kind: "linear" }, travel: false };
    // "one" leaves focus at 1000 for READ, which says nothing about colour.
    const mid = parseHexColor(String(effectiveRanges(clip, 1200)[0]!.overlay.props.color))!;
    expect(mid.a).toBe(1);
    expect(mid.b).toBeGreaterThan(0xe6);
    expect(mid.b).toBeLessThan(0xff);
    // Just before it lands it is the layer's own white, and then the state's (no override): white.
    const late = parseHexColor(String(effectiveRanges(clip, 1399)[0]!.overlay.props.color))!;
    expect(late).toMatchObject({ r: 255, g: 255, a: 1 });
    expect(late.b).toBeGreaterThanOrEqual(254);
    expect(effectiveRanges(clip, 1500)[0]!.overlay.props.color).toBeUndefined();
  });

  it("inherits a range's colour under the word when there is one", () => {
    const clip = stated(captionClip(), { color: "#FFF6E6" });
    // A red run on "two"; "two" ENTERS focus at 1000, where focus beats the range.
    clip.ranges = [{ id: "r", start: 4, end: 7, overlay: ov({ color: "#ff0000" }), animation: null, sounds: {} }];
    clip.caption!.motion = { durationMs: 400, easing: { kind: "linear" }, travel: false };
    const two = effectiveRanges(clip, 1200).find((r) => r.start === 4)!;
    const mid = parseHexColor(String(two.overlay.props.color))!;
    // Halfway from the range's red to cream — opaque, not a cream fading in from nothing.
    expect(mid.a).toBe(1);
    expect(mid.r).toBe(255);
    expect(mid.g).toBeGreaterThan(0x60);
    expect(mid.g).toBeLessThan(0x90);
  });

  it("says which two words the pill is between, and stops saying it when it arrives", () => {
    const clip = stated(captionClip(), { "highlight.color": "#F5B843" });
    clip.caption!.motion = { durationMs: 400, easing: { kind: "linear" }, travel: true };
    const caption = clip.caption!;

    // Nothing to leave on the first cue, and nothing at all in the silence.
    expect(captionTravelAt(caption, 100)).toMatchObject({ from: null, t: 1 });
    expect(captionTravelAt(caption, 99_999)).toBeNull();

    // "two" takes focus at 1000: halfway through the crossing it is halfway
    // between "one" and "two", and past it the pill is simply where it is.
    const mid = captionTravelAt(caption, 1200)!;
    expect(cueTextOf(clip.text, mid.from!)).toBe("one");
    expect(cueTextOf(clip.text, mid.to)).toBe("two");
    expect(mid.t).toBeCloseTo(0.5, 2);
    expect(captionTravelAt(caption, 1600)).toMatchObject({ from: null, t: 1 });
  });

  it("hands back the same array identity for the same phase, frame after frame", () => {
    const clip = stated(captionClip(), { color: "#F5B843" });
    expect(effectiveRanges(clip, 100)).toBe(effectiveRanges(clip, 900));
    expect(effectiveRanges(clip, 100)).not.toBe(effectiveRanges(clip, 1500));
  });

  it("finds the active cue by time, and -1 in the silence", () => {
    const caption = captionClip().caption!;
    expect(activeCueIndexAt(caption, 0)).toBe(0);
    expect(activeCueIndexAt(caption, 3999)).toBe(3);
    expect(activeCueIndexAt(caption, 9999)).toBe(-1);
  });
});

describe("the v52 migration", () => {
  /** A v51 caption clip: its own kind, a word list, and a highlight style. */
  function v51WithCaption() {
    const base = createEmptyDocument();
    const raw = JSON.parse(serializeDocument(base)) as Record<string, unknown>;
    raw.version = 51;
    (raw.tracks as Array<Record<string, unknown>>)[0]!.clips = [
      {
        ...createTextClip({ frameId: base.frames[0]!.id, text: "x", startMs: 0, durationMs: 3000 }),
        kind: "caption",
        words: [
          { id: "w1", text: "hello", startMs: 0, durationMs: 1000 },
          { id: "w2", text: "there", startMs: 1000, durationMs: 900 },
          { id: "w3", text: "friend", startMs: 2000, durationMs: 1000 },
        ],
        highlightStyle: { color: "#F5B843" },
        highlightScale: 1.2,
        keyframes: [
          { id: "kt", property: "highlightScale", keys: [{ id: "k", timeMs: 0, value: 1, easing: { kind: "linear" } }] },
        ],
        text: undefined,
        ranges: undefined,
        caption: undefined,
      },
    ];
    return raw;
  }

  it("turns a caption clip into a text clip whose cues span its own words", () => {
    const doc = parseDocument(JSON.stringify(v51WithCaption()));
    const clip = doc.tracks[0]!.clips[0]!;
    expect(clip.kind).toBe("text");
    if (clip.kind !== "text") throw new Error("not text");

    // The words print exactly as they always did.
    expect(clip.text).toBe("hello there friend");
    expect(clip.caption).not.toBeNull();
    const cues = clip.caption!.cues;
    expect(cues.map((c) => cueTextOf(clip.text, c))).toEqual(["hello", "there", "friend"]);
    // And every timing survives, including the deliberate gap after "there".
    expect(cues.map((c) => [c.startMs, c.endMs])).toEqual([[0, 1000], [1000, 1900], [2000, 3000]]);
  });

  it("moves the highlight look into the focus scope, keyframes included", () => {
    const doc = parseDocument(JSON.stringify(v51WithCaption()));
    const clip = doc.tracks[0]!.clips[0]!;
    if (clip.kind !== "text") throw new Error("not text");
    expect(clip.caption!.states.focus.overlay.props).toEqual({ color: "#F5B843" });
    expect(clip.caption!.states.focus.scale).toBe(1.2);
    // The animated pop keeps animating: only its address changed.
    expect(clip.keyframes[0]!.property).toBe("focusScale");
    expect((clip as unknown as Record<string, unknown>).highlightStyle).toBeUndefined();
    expect((clip as unknown as Record<string, unknown>).words).toBeUndefined();
  });

  it("leaves an ordinary text clip alone, with no caption module", () => {
    const base = createEmptyDocument();
    const raw = JSON.parse(serializeDocument(base)) as Record<string, unknown>;
    raw.version = 51;
    (raw.tracks as Array<Record<string, unknown>>)[0]!.clips = [
      createTextClip({ frameId: base.frames[0]!.id, text: "just text", startMs: 0 }),
    ];
    const clip = parseDocument(JSON.stringify(raw)).tracks[0]!.clips[0]!;
    expect(clip.kind === "text" && clip.caption).toBeNull();
  });
});
