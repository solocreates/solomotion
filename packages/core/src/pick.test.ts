import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip } from "./factories";
import { pickContextTarget, pickSelectTarget } from "./timeline/pick";
import type { MotionDocument } from "./schema";

/** Three layers on one track, listed here bottom-first as the document holds them. */
function stackedDoc(): { doc: MotionDocument; ids: string[] } {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const track = doc.tracks[0]!;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const clip = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 1000 });
    track.clips.push(clip);
    ids.push(clip.id);
  }
  return { doc, ids };
}

const lock = (doc: MotionDocument, id: string) => {
  doc.tracks[0]!.clips.find((c) => c.id === id)!.locked = true;
};

describe("picking a layer out of a stack", () => {
  it("a locked layer is transparent to both buttons", () => {
    const { doc, ids } = stackedDoc();
    const [bottom, middle, top] = ids as [string, string, string];
    lock(doc, top);
    const stack = [top, middle, bottom]; // topmost first
    expect(pickSelectTarget(doc, stack)).toBe(middle);
    // THE BUG: right-click used to take `stack[0]` and offer Unlock on the
    // locked layer the left click had just refused to select.
    expect(pickContextTarget(doc, stack, [])).toBe(middle);
  });

  it("a right-click over the current selection keeps it, even under another layer", () => {
    const { doc, ids } = stackedDoc();
    const [bottom, middle, top] = ids as [string, string, string];
    const stack = [top, middle, bottom];
    // Selected the one underneath (a locked layer was in the way, or the user
    // picked it in the tree) — the menu must stay on it.
    expect(pickContextTarget(doc, stack, [bottom])).toBe(bottom);
    // …including when the layer above is perfectly selectable.
    expect(pickContextTarget(doc, stack, [middle])).toBe(middle);
  });

  it("a locked layer is still targetable when it is the only thing there", () => {
    const { doc, ids } = stackedDoc();
    const top = ids[2]!;
    lock(doc, top);
    // Unlock has to be reachable from somewhere.
    expect(pickContextTarget(doc, [top], [])).toBe(top);
    expect(pickSelectTarget(doc, [top])).toBeNull();
  });

  it("nothing under the pointer is nothing, not a guess", () => {
    const { doc } = stackedDoc();
    expect(pickContextTarget(doc, [], ["anything"])).toBeNull();
    expect(pickSelectTarget(doc, [])).toBeNull();
  });
});
