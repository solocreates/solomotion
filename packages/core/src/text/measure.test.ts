import { afterEach, describe, expect, it } from "vitest";
import { setTextBoxMeasurer } from "./measure";
import { clipBox } from "../timeline/ops";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument, createTextClip } from "../factories";
import { anchorLocal } from "../transform-map";
import type { TextClip } from "../schema";

/** A stand-in for the real layout engine: 10px per character, one line. */
function fakeMeasurer(): void {
  setTextBoxMeasurer((_doc, clip) => ({
    width: clip.kind === "text" ? Math.max(1, clip.text.length * 10) : 100,
    height: 40,
    cx: 0,
    cy: 0,
  }));
}

afterEach(() => setTextBoxMeasurer(null));

function textDoc(text: string) {
  const doc = createEmptyDocument();
  const clip = createTextClip({ frameId: doc.frames[0]!.id, text, startMs: 0 });
  doc.tracks[0]!.clips.push(clip);
  return { doc, clip: clip as TextClip };
}

describe("the text box has one answer", () => {
  it("prefers the app's measurement over the built-in approximation", () => {
    const { doc, clip } = textDoc("Hello");
    const guessed = clipBox(doc, clip);
    fakeMeasurer();
    expect(clipBox(doc, clip).width).toBe(50);
    // …and without a measurer (a worker, an export before fonts load) the
    // approximation still answers rather than throwing.
    setTextBoxMeasurer(null);
    expect(clipBox(doc, clip)).toEqual(guessed);
  });
});

/** A store holding one text clip, edited the way every surface edits it. */
function textStore(text: string, anchor: { x: number; y: number }) {
  const { doc, clip } = textDoc(text);
  clip.transform.anchor = anchor;
  const store = createDocumentStore(doc);
  const live = () => store.getState().tracks[0]!.clips[0] as TextClip;
  const edit = (fn: (c: TextClip) => void) => store.update("edit", (d) => fn(d.tracks[0]!.clips[0] as TextClip));
  return { store, live, edit };
}

describe("a content edit never moves the words — whoever writes it", () => {
  it("keeps the pivot's LOCAL POINT when an auto-width box grows", () => {
    fakeMeasurer();
    const { live, edit, store } = textStore("Hi", { x: 3, y: 0.5 });
    const before = anchorLocal(live().transform.anchor, clipBox(store.getState(), live()));
    edit((c) => {
      c.text = "Hi there, this is much longer";
    });
    const after = anchorLocal(live().transform.anchor, clipBox(store.getState(), live()));
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    // The stored fraction MUST have changed — that is what kept the point.
    expect(live().transform.anchor.x).not.toBe(3);
  });

  it("holds through a typography edit too (a font, a size), not only typing", () => {
    setTextBoxMeasurer((_doc, clip) => ({ width: clip.kind === "text" ? clip.style.letterSpacing * 10 + 100 : 100, height: 40, cx: 0, cy: 0 }));
    const { live, edit, store } = textStore("Hi", { x: 0, y: 0.5 });
    const before = anchorLocal(live().transform.anchor, clipBox(store.getState(), live()));
    edit((c) => {
      c.style.letterSpacing = 20;
    });
    expect(anchorLocal(live().transform.anchor, clipBox(store.getState(), live())).x).toBeCloseTo(before.x, 9);
    // …and undo takes the rebase back with the edit.
    store.undo();
    expect(live().transform.anchor).toEqual({ x: 0, y: 0.5 });
  });

  it("leaves a centred pivot alone (nothing to correct)", () => {
    fakeMeasurer();
    const { live, edit } = textStore("Hi", { x: 0.5, y: 0.5 });
    edit((c) => {
      c.text = "Hi there";
    });
    expect(live().transform.anchor).toEqual({ x: 0.5, y: 0.5 });
  });

  it("stands aside for a BOX edit, which keeps the fraction", () => {
    fakeMeasurer();
    const { live, edit } = textStore("Hi", { x: 1, y: 0.5 });
    edit((c) => {
      c.text = "Hi there";
      c.maxWidth = 300;
    });
    expect(live().transform.anchor).toEqual({ x: 1, y: 0.5 });
  });

  it("stands aside when the write set the pivot itself", () => {
    fakeMeasurer();
    const { live, edit } = textStore("Hi", { x: 1, y: 0.5 });
    edit((c) => {
      c.text = "Hi there";
      c.transform.anchor = { x: 0.25, y: 0.5 };
    });
    expect(live().transform.anchor).toEqual({ x: 0.25, y: 0.5 });
  });

  it("rebases a KEYFRAMED pivot too, so animated frames don't drift apart", () => {
    fakeMeasurer();
    const { live, edit, store } = textStore("Hi", { x: 2, y: 0.5 });
    store.update("key", (d) => {
      d.tracks[0]!.clips[0]!.keyframes = [
        {
          id: "ax",
          property: "anchor.x",
          range: null,
          keys: [
            { id: "k1", timeMs: 0, value: 2, easing: { kind: "linear" } },
            { id: "k2", timeMs: 500, value: 0, easing: { kind: "linear" } },
          ],
        },
      ];
    });
    const box0 = clipBox(store.getState(), live());
    const points = live().keyframes[0]!.keys.map((k) => anchorLocal({ x: k.value as number, y: 0.5 }, box0).x);
    edit((c) => {
      c.text = "Hi there, this is much longer";
    });
    const box1 = clipBox(store.getState(), live());
    live().keyframes[0]!.keys.forEach((k, i) => {
      expect(anchorLocal({ x: k.value as number, y: 0.5 }, box1).x).toBeCloseTo(points[i]!, 9);
    });
  });
});
