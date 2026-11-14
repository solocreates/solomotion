import type { Clip, MotionDocument } from "../schema";
import { parseVarToken, visitClipColorSlots } from "../variables";

/**
 * Color-domain helpers for the "Selection colors" panel — the color walking,
 * token parsing and CRUD now live in ../variables (the typed variable engine);
 * this file keeps only the subtree color collection/remap the panel needs.
 */

/** Every clip that renders into a frame (across all tracks). */
function clipsInFrame(doc: MotionDocument, frameId: string): Clip[] {
  const out: Clip[] = [];
  for (const track of doc.tracks) for (const clip of track.clips) if (clip.frameId === frameId) out.push(clip);
  return out;
}

/**
 * Expand a clip selection into itself + everything nested inside it: a nested
 * clip pulls in its source frame's clips (recursively, guarding frame cycles).
 * De-duped by clip id. This is the subtree the "Selection colors" panel reads
 * and remaps across.
 */
function subtreeClips(doc: MotionDocument, clipIds: readonly string[]): Clip[] {
  const byId = new Map<string, Clip>();
  for (const track of doc.tracks) for (const clip of track.clips) byId.set(clip.id, clip);
  const out: Clip[] = [];
  const seen = new Set<string>();
  const gather = (clips: Clip[], frameGuard: Set<string>) => {
    for (const clip of clips) {
      if (seen.has(clip.id)) continue;
      seen.add(clip.id);
      out.push(clip);
      if (clip.kind === "nested" && !frameGuard.has(clip.sourceFrameId)) {
        const next = new Set(frameGuard);
        next.add(clip.sourceFrameId);
        gather(clipsInFrame(doc, clip.sourceFrameId), next);
      }
    }
  };
  gather(
    clipIds.map((id) => byId.get(id)).filter((c): c is Clip => c !== undefined),
    new Set<string>(),
  );
  return out;
}

/** One distinct color used somewhere in a selection's subtree. */
export interface SubtreeColor {
  /** The stored value — a literal color OR a `var:<id>` token. */
  value: string;
  /** The variable id when `value` is a token, else null. */
  linkedId: string | null;
  /** How many slots across the subtree use it. */
  count: number;
}

/**
 * Every distinct color used across a selection and everything nested inside it
 * (groups: pass the member clip ids; nested comps recurse automatically). The
 * Figma "Selection colors" list — read-only.
 */
export function collectSubtreeColors(doc: MotionDocument, clipIds: readonly string[]): SubtreeColor[] {
  const map = new Map<string, SubtreeColor>();
  for (const clip of subtreeClips(doc, clipIds)) {
    visitClipColorSlots(clip, (value) => {
      const existing = map.get(value);
      if (existing) existing.count += 1;
      else map.set(value, { value, linkedId: parseVarToken(value), count: 1 });
      return undefined;
    });
  }
  return [...map.values()];
}

/**
 * Retint every slot equal to `from` with `to` across a selection's subtree
 * (recursing into nested comps). One undoable pass — the write half of the
 * Selection colors panel. `from`/`to` are stored values (literal or `var:` token).
 */
export function remapSubtreeColors(
  doc: MotionDocument,
  clipIds: readonly string[],
  from: string,
  to: string,
): void {
  for (const clip of subtreeClips(doc, clipIds)) {
    visitClipColorSlots(clip, (value) => (value === from ? to : undefined));
  }
}
