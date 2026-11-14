import type { MotionDocument, Frame, Track } from "../schema";
import { frameClipEntries } from "../timeline/frame-index";
import { isSettledDocument } from "../timeline/settled";

/**
 * WHAT A COMP'S PICTURE DEPENDS ON — as one token that changes exactly when the
 * picture could.
 *
 * The board (the free-form canvas) shows many comps at once, and while you look
 * around it none of them changes. A renderer that redraws every comp from its
 * vectors on every pan is what made a page of five heavy comps lock the browser;
 * the fix is to keep each comp as a PICTURE and redraw one only when its token
 * moves (Figma's model: retained pictures, invalidated by dependency).
 *
 * The token is made of IDENTITIES of the immutable document data the comp
 * draws from, so computing it never looks inside a clip:
 *
 *  - the comp itself, minus what only places it on the board (`x`, `y`), names
 *    it, or remembers its playhead — dragging a comp around the board, renaming
 *    it or scrubbing elsewhere must not repaint it (time is keyed separately);
 *  - every clip on it, and a PROJECTION of every track those clips sit on
 *    (visibility, group, loop, transitions). Tracks are document-global lanes,
 *    so a track's identity changes when ANY clip on it changes — keying on it
 *    would let an edit in one comp repaint every comp sharing a lane;
 *  - recursively, every comp it nests (instances, flipbook cells, scenes);
 *  - every document-level table other than frames/tracks/pages (variables,
 *    assets, components, trackers… and whatever is added next), by identity —
 *    enumerating them would be the list that silently forgets the next one.
 *
 * `frames` and `clipIds` are the comp's whole dependency set, for callers that
 * must refuse a picture while something inside it is being edited.
 *
 * Memoised per SETTLED document (see `settled.ts`): computed once per snapshot,
 * whatever number of times a tick asks.
 */
export interface CompPictureDeps {
  readonly signature: string;
  readonly frames: ReadonlySet<string>;
  readonly clipIds: ReadonlySet<string>;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(o: unknown): number {
  if (o === null || typeof o !== "object") return 0;
  let v = ids.get(o);
  if (v === undefined) {
    v = nextId++;
    ids.set(o, v);
  }
  return v;
}

const BOARD_ONLY: ReadonlySet<string> = new Set(["x", "y", "name", "playheadMs", "pageId", "guides", "pluginData"]);
const NOT_A_TABLE: ReadonlySet<string> = new Set(["frames", "tracks", "pages", "id", "name", "version"]);

function frameToken(frame: Frame | undefined): string {
  if (!frame) return "∅";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(frame)) {
    if (BOARD_ONLY.has(k)) continue;
    parts.push(`${k}=${v !== null && typeof v === "object" ? `#${idOf(v)}` : String(v)}`);
  }
  return parts.join(",");
}

function trackToken(track: Track): string {
  const { hidden, groupId, loop, transitions } = track as Track & { loop?: unknown; transitions?: unknown; groupId?: unknown };
  return `${track.id}:${hidden ? 1 : 0}:${String(groupId ?? "")}:${idOf(loop)}:${idOf(transitions)}`;
}

const memo = new WeakMap<MotionDocument, Map<string, CompPictureDeps>>();

export function compPictureDeps(doc: MotionDocument, frameId: string): CompPictureDeps {
  let perDoc: Map<string, CompPictureDeps> | undefined;
  if (isSettledDocument(doc)) {
    perDoc = memo.get(doc);
    if (!perDoc) memo.set(doc, (perDoc = new Map()));
    const hit = perDoc.get(frameId);
    if (hit) return hit;
  }
  const frames = new Set<string>();
  const clipIds = new Set<string>();
  const parts: string[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (!NOT_A_TABLE.has(k) && v !== null && typeof v === "object") parts.push(`${k}#${idOf(v)}`);
  }
  const byId = new Map(doc.frames.map((f) => [f.id, f] as const));
  const visit = (fid: string) => {
    if (frames.has(fid)) return;
    frames.add(fid);
    parts.push(`[${fid}|${frameToken(byId.get(fid))}`);
    for (const e of frameClipEntries(doc, fid)) {
      clipIds.add(e.clip.id);
      parts.push(`${idOf(e.clip)}@${trackToken(e.track)}`);
      if (e.clip.kind === "nested") visit(e.clip.sourceFrameId);
    }
    parts.push("]");
  };
  visit(frameId);
  const out: CompPictureDeps = { signature: parts.join(";"), frames, clipIds };
  perDoc?.set(frameId, out);
  return out;
}
