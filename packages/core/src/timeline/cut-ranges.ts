import type { MotionDocument } from "../schema";
import { closeGap } from "./gaps";
import { clipEnd, deleteClip, locateClip, splitClip, trimClip } from "./ops";

/**
 * CUT RANGES — take stretches of time out of a layer, and (usually) let what
 * follows fall back into the holes. The edit behind "remove the pauses", "cut
 * the ums", "lose the dead air before the punchline": a razor at both ends of
 * each range, the middle deleted, then a ripple.
 *
 * Nothing here assigns a start time. Pieces are made by `splitClip`, removed by
 * `deleteClip`, shortened by `trimClip`, and slid by `closeGap` — the movers
 * that already know what a group's bar carries, what a fill clip is and what a
 * lock means. This file only decides WHICH edits, in which order.
 *
 * Ranges run RIGHT TO LEFT, so an earlier range's times are still true when its
 * turn comes, and the original clip id always survives as the leftmost piece.
 *
 * Ripple modes:
 *  - `none` — leave the holes (a J-cut, a breath you will fill with B-roll).
 *  - `lane` — close the holes on the layer's own lane and its linked layers'.
 *  - `sync` — the whole scope keeps sync, as an NLE's sync-lock does: every
 *    lane beside it also loses the range. A layer that only overlaps the range
 *    is trimmed; one that spans it (a music bed, a background) is SHORTENED
 *    rather than cut, so the music plays on instead of jumping; captions and
 *    titles after it slide back with the words they belong to.
 */

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export type RippleMode = "none" | "lane" | "sync";

export interface CutRangesResult {
  /** The ranges actually cut, after clamping and merging, left to right. */
  cut: TimeRange[];
  removedMs: number;
  /** Pieces of the layer that remain, left to right. */
  pieces: string[];
}

const EPS = 0.5;

/** Clamp to the layer, drop slivers, merge overlaps; sorted left to right. */
export function normalizeCutRanges(ranges: readonly TimeRange[], within: TimeRange, minMs = 1): TimeRange[] {
  const clamped = ranges
    .map((r) => ({ startMs: Math.max(within.startMs, Math.min(r.startMs, r.endMs)), endMs: Math.min(within.endMs, Math.max(r.startMs, r.endMs)) }))
    .filter((r) => r.endMs - r.startMs >= minMs)
    .sort((a, b) => a.startMs - b.startMs);
  const out: TimeRange[] = [];
  for (const r of clamped) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs + EPS) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out;
}

/** Mutates `d` (call inside a document update). Throws nothing; returns what it did. */
export function cutRanges(d: MotionDocument, clipId: string, ranges: readonly TimeRange[], ripple: RippleMode = "sync"): CutRangesResult {
  const loc = locateClip(d, clipId);
  if (!loc) return { cut: [], removedMs: 0, pieces: [] };
  const frameId = loc.clip.frameId;
  const scopeGroup = loc.track.groupId ?? null;
  const cut = normalizeCutRanges(ranges, { startMs: loc.clip.startMs, endMs: clipEnd(loc.clip) });

  // The layer and everything linked to it (an a/v pair, a waveform) are razored together.
  const linkGroup = loc.clip.linkGroupId;
  const targets = new Set<string>([clipId]);
  if (linkGroup) for (const t of d.tracks) for (const c of t.clips) if (c.frameId === frameId && c.linkGroupId === linkGroup) targets.add(c.id);
  const survivors = new Set<string>();

  for (const range of [...cut].reverse()) {
    const delta = range.endMs - range.startMs;
    const lanes = new Set<string>();

    for (const id of targets) {
      const t = locateClip(d, id);
      if (!t || clipEnd(t.clip) <= range.startMs + EPS || t.clip.startMs >= range.endMs - EPS) continue;
      lanes.add(t.track.id);
      // Keep the right-hand piece; it is a survivor of this layer.
      if (clipEnd(t.clip) > range.endMs + EPS) {
        const right = splitClip(d, id, range.endMs);
        if (right) survivors.add(right);
      }
      if (t.clip.startMs < range.startMs - EPS) {
        const middle = splitClip(d, id, range.startMs);
        if (middle) deleteClip(d, middle);
      } else {
        // The range starts at this piece's head: the piece IS the middle.
        deleteClip(d, id);
        targets.delete(id);
      }
    }

    if (ripple === "sync") {
      for (const track of d.tracks) {
        if ((track.groupId ?? null) !== scopeGroup || track.locked) continue;
        for (const c of [...track.clips]) {
          if (c.frameId !== frameId || targets.has(c.id) || survivors.has(c.id)) continue;
          const s = c.startMs;
          const e = clipEnd(c);
          if (e <= range.startMs + EPS || s >= range.endMs - EPS) continue;
          if (s >= range.startMs - EPS && e <= range.endMs + EPS) deleteClip(d, c.id);
          else if (s < range.startMs && e > range.endMs) trimClip(d, c.id, "end", e - delta);
          else if (s < range.startMs) trimClip(d, c.id, "end", range.startMs);
          else trimClip(d, c.id, "start", range.endMs);
        }
        lanes.add(track.id);
      }
    }

    if (ripple !== "none") {
      for (const trackId of lanes) {
        const track = d.tracks.find((t) => t.id === trackId);
        const next = track?.clips.filter((c) => c.frameId === frameId && c.startMs >= range.endMs - EPS).sort((a, b) => a.startMs - b.startMs)[0];
        if (next) closeGap(d, { trackId, frameId, startMs: range.startMs, endMs: range.endMs, nextClipId: next.id });
      }
    }
  }

  const pieces = [...targets, ...survivors]
    .map((id) => locateClip(d, id))
    .filter((l): l is NonNullable<typeof l> => !!l && l.track.id === loc.track.id)
    .sort((a, b) => a.clip.startMs - b.clip.startMs)
    .map((l) => l.clip.id);
  return { cut, removedMs: cut.reduce((n, r) => n + r.endMs - r.startMs, 0), pieces };
}
