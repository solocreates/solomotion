import type { MotionDocument, Clip } from "../schema";
import { SOURCE_TOKEN_PREFIXES } from "../binding/source";
import { layerContentRefs } from "../timeline/layer-content";
import { bakeSourceOf } from "./resolved-doc";

/**
 * DOES THIS LAYER'S PICTURE READ A TOKEN AT PAINT TIME?
 *
 * A reference reaches a layer two ways, and they are not equally visible:
 *
 *  - Through the clip's `drivers` map. The bake (`resolvedDocAt`) writes the
 *    value into a FRESH CLONE of the clip at every instant, so the clip object
 *    itself says the picture changed — any cache keyed on identity is right for
 *    free, and untouched clips keep theirs.
 *  - Through a bindable SLOT holding `var:` / `fx:` / `expr:` / `input:`. That
 *    is resolved by the painter, at the ambient clock, from document tables —
 *    the clip object is the same at every instant while its colour, size or
 *    font moves. Identity cannot see that.
 *
 * Only the second makes a layer's pixels unkeepable by identity, so it is
 * asked PER LAYER. It used to be answered per DOCUMENT — one expression
 * anywhere refused the whole project's layer cache, and a template whose
 * scenes scroll hills and jitter riso passes by expression re-rendered every
 * halftone and boil in every comp on every repaint.
 *
 * A container (group, nested comp) reads a token when anything it is made of
 * does (`layerContentRefs`, the same walk its cache refs use). Answered on the
 * RAW document: the bake rewrites driven values, never slots, so a token is in
 * the same place in both — and the memo survives every per-instant bake.
 */
export function pictureReadsSlotTokens(doc: MotionDocument, clip: Clip): boolean {
  if (clip.kind !== "group" && clip.kind !== "nested") return clipHoldsSlotToken(clip);
  const raw = bakeSourceOf(doc);
  let memo = containerMemo.get(raw);
  if (!memo) containerMemo.set(raw, (memo = new Map()));
  const hit = memo.get(clip.id);
  if (hit !== undefined) return hit;
  const reads = clipHoldsSlotToken(clip) || layerContentRefs(raw, clip).some((r) => isClip(r) && clipHoldsSlotToken(r));
  memo.set(clip.id, reads);
  return reads;
}

const containerMemo = new WeakMap<MotionDocument, Map<string, boolean>>();
const leafMemo = new WeakMap<Clip, boolean>();

/** A clip's own slots, at any depth — every field, so a bindable slot added
 *  tomorrow is covered without being listed. `drivers` is the bake's, skipped. */
function clipHoldsSlotToken(clip: Clip): boolean {
  let v = leafMemo.get(clip);
  if (v === undefined) {
    v = false;
    for (const k in clip) {
      if (k !== "drivers" && holdsToken((clip as Record<string, unknown>)[k])) {
        v = true;
        break;
      }
    }
    leafMemo.set(clip, v);
  }
  return v;
}

function holdsToken(value: unknown): boolean {
  if (typeof value === "string") return SOURCE_TOKEN_PREFIXES.some((p) => value.startsWith(p));
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(holdsToken);
  for (const k in value as Record<string, unknown>) if (holdsToken((value as Record<string, unknown>)[k])) return true;
  return false;
}

function isClip(r: unknown): r is Clip {
  return typeof r === "object" && r !== null && "kind" in r && "frameId" in r && "id" in r;
}
