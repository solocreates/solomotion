import { previewStack, type MotionDocument, type Clip, type EffectPreviewStack } from "@solomotion/core";

/**
 * THE DOCUMENTS THE EFFECT PREVIEW RENDERS — "after" (the stack as the preview
 * runs it) and "before" (the same, with the card switched off).
 *
 * Structural sharing: only the path down to the edited clip is rebuilt (doc →
 * tracks → track → clips → clip → effect list), and every card the preview
 * keeps is the SAME object. That second part is load-bearing: the kept prefix
 * beneath the card is validated by card identity (`stackPrefixUnchanged`), so
 * "after", "before" and the stage's own clip all read ONE prefix.
 *
 * MEMOISED on the source document, and that is the fix for half of what made
 * the old preview heavy: it rebuilt the "before" document on every paint, so
 * the layer it drew was a new object every tick and missed every cache there
 * is. Now the same source document yields the same derived objects until
 * something is actually edited.
 *
 * Two stacks to search: the layer's `effects`, and — on a text layer — the
 * per-glyph passes on its style. The editor hands over an id; which list it
 * came from is not its business.
 */
export interface PreviewDocs {
  after: MotionDocument;
  before: MotionDocument;
}

const memo = new WeakMap<MotionDocument, Map<string, PreviewDocs>>();

export function previewDocuments(
  doc: MotionDocument,
  clipId: string,
  effectId: string,
  stack: EffectPreviewStack,
): PreviewDocs {
  let byKey = memo.get(doc);
  if (!byKey) memo.set(doc, (byKey = new Map()));
  const key = `${clipId}|${effectId}|${stack}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const after = mapClip(doc, clipId, (c) => scoped(c, effectId, stack));
  const before = mapClip(after, clipId, (c) => disableIn(c, effectId));
  const out = { after, before };
  byKey.set(key, out);
  return out;
}

function mapClip(doc: MotionDocument, clipId: string, fn: (c: Clip) => Clip): MotionDocument {
  let touched = false;
  const tracks = doc.tracks.map((track) => {
    const at = track.clips.findIndex((c) => c.id === clipId);
    if (at < 0) return track;
    const next = fn(track.clips[at]!);
    if (next === track.clips[at]) return track;
    touched = true;
    const clips = track.clips.slice();
    clips[at] = next;
    return { ...track, clips };
  });
  return touched ? { ...doc, tracks } : doc;
}

function scoped(clip: Clip, effectId: string, stack: EffectPreviewStack): Clip {
  if (clip.kind === "audio") return clip;
  const effects = previewStack(clip.effects, effectId, stack);
  return effects === clip.effects ? clip : ({ ...clip, effects } as Clip);
}

function disableIn(clip: Clip, effectId: string): Clip {
  if (clip.kind !== "audio" && clip.effects.some((e) => e.id === effectId)) {
    return {
      ...clip,
      effects: clip.effects.map((e) => (e.id === effectId ? { ...e, enabled: false } : e)),
    } as Clip;
  }
  if (clip.kind === "text" && clip.style.textEffects.some((e) => e.id === effectId)) {
    return {
      ...clip,
      style: {
        ...clip.style,
        textEffects: clip.style.textEffects.map((e) => (e.id === effectId ? { ...e, enabled: false } : e)),
      },
    };
  }
  return clip;
}
