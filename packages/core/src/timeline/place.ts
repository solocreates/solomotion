import type { MotionDocument, Clip, Track } from "../schema";
import { createCarrierTrack } from "../factories";
import { addClipToTrack, compDurationMs, fitsInTrack, insertTrackAtEdge, locateClip } from "./ops";
import { compRenderTimeMs } from "./fps";
import { scopeEdgeIndex } from "./groups";
import { laneBeside, settleLane } from "./lanes";

/**
 * WHERE A NEW CLIP LANDS. One door for every kind of new layer (canvas
 * creation, drops, imports, pastes, plugins), so the rule holds by
 * construction. Call inside a document update.
 *
 * The default is the SURFACE: a new layer sits on top of everything that is
 * on screen at its time — the topmost lane of its scope when that lane has
 * room here, else a fresh lane above it. It used to scan DOWNWARD for the
 * first lane with room, which put a new layer under whatever was already
 * there whenever the top lanes were busy — the layer you just made, hidden
 * behind the one you were looking at. A lane below the surface is reused
 * only when something explicitly aimed at it.
 */
export interface PlaceClipOptions {
  /** Land in this lane (the one you dropped on); no room there → a fresh lane right above it. */
  preferredTrackId?: string;
  /**
   * Drop the new clip directly ABOVE this existing clip (its own carrier track
   * inserted at the anchor's z), inheriting the anchor's group. THE unified
   * "new layer lands above the selected layer" rule — see `placeAboveSelection`.
   * Only applies when the anchor is in the SAME frame; otherwise ignored.
   */
  aboveClipId?: string;
  /**
   * The mirror of `aboveClipId` — land directly BELOW this clip. "Paint under
   * the line art" is a real placement, and without it the only way to express
   * it was a fresh bottom track, which put the fill under everything in the
   * comp rather than under the thing it was filling.
   */
  belowClipId?: string;
  /**
   * Land on a BRAND-NEW carrier track spawned at the top/bottom of the stack —
   * what dragging media past the first/last lane does. The most explicit intent
   * (the user aimed past the edge), so it wins over every other rule. Shares the
   * one `insertTrackAtEdge` primitive with the intra-timeline clip drag.
   */
  newLaneEdge?: "top" | "bottom";
  /**
   * The GROUP whose surface this is — the band a drop landed in, or the group
   * you are inside. The lanes searched are that group's rows (or minted
   * there). Omitted / null = the comp's top level. A new layer must never
   * fall into a group nobody aimed at because one of its rows had room.
   */
  groupId?: string | null;
  /**
   * The lane this clip CAME FROM — a memory, not an aim.
   *
   * A paste is a restore: the clip already had a home and the reader expects it
   * back on it. Unlike `preferredTrackId`, which is a place you pointed at and
   * so mints a lane above itself when it is busy, a home that is gone or busy
   * simply falls through to the rule below. Ignored across frames, since a lane
   * belongs to one comp.
   */
  homeTrackId?: string;
  /**
   * How to pick a lane when nothing above named one.
   *
   *  `surface` — a BIRTH. The scope's topmost lane, else a fresh one above
   *    everything: the layer you just made must be visible, and a lane further
   *    down would bury it behind what you were looking at. The default.
   *  `reuse` — a RESTORE (paste, ⌥-stamp, re-import). Topmost lane WITH ROOM
   *    at this time, scanning down; a fresh lane only when the whole stack is
   *    busy here. Nothing is being revealed, so minting a lane per paste is
   *    pure track sprawl — which is exactly what pasting beside a clip used to
   *    do, over and over, on a project with one busy top lane.
   *  `settle` — a birth that REUSES the stack (every agent verb). The same
   *    promise as `surface`, kept without minting whenever an existing lane
   *    already keeps it (`timeline/lanes.ts`): with no anchor, the lowest lane
   *    above everything on screen during the clip's span; beside an
   *    `aboveClipId` / `belowClipId` anchor, the comp's neighbouring lane when
   *    nothing on it plays then. A caller building a scene layer by layer used
   *    to leave one lane per layer — the next scene never found the last
   *    scene's lanes free, because `surface` only ever looks at the top one.
   */
  landing?: "surface" | "reuse" | "settle";
}

export function placeClip(
  d: MotionDocument,
  clip: Clip,
  opts: PlaceClipOptions | string = {},
): void {
  // Back-compat: a bare string is the preferred track id.
  const { preferredTrackId, aboveClipId, belowClipId, newLaneEdge, groupId, homeTrackId, landing } =
    typeof opts === "string" ? { preferredTrackId: opts } : (opts as PlaceClipOptions);
  const scope = groupId ?? null;
  const inScope = (t: Track) => (t.groupId ?? null) === scope;

  // ── A NEW CLIP IS BORN ON ITS COMP'S FRAME GRID ───────────────────────────
  // A comp only ever renders at grid instants (`compRenderTimeMs` / the render
  // clock in `drawFrameContent`), so a clip that begins BETWEEN two of them has
  // a first sliver nothing can address: create a layer while the playhead sits
  // mid-frame and the layer is invisible until you step forward, and a clip
  // shorter than one frame never shows at all. Flooring here — the same
  // direction, and the same function, the render clock uses — makes "at the
  // playhead" mean "on the frame you are LOOKING AT", which is the only reading
  // under which a new layer is visible the instant it exists.
  //
  // It runs BEFORE the fit tests below so placement reasons about the time the
  // clip will actually have, and it is idempotent for anything already on the grid.
  clip.startMs = compRenderTimeMs(d, clip.frameId, clip.startMs);

  // ── A LAYER BORN IN A STILL SPANS IT ──────────────────────────────────────
  // A static frame has no "at the playhead" — it is one picture — so whatever
  // lands in it is there for all of it and tracks its length. That is also
  // what makes static → timeline read right: every layer a full bar.
  if (d.frames.find((f) => f.id === clip.frameId)?.mode === "static") {
    clip.startMs = 0;
    clip.durationMs = Math.max(1, compDurationMs(d, clip.frameId));
    clip.fillDuration = true;
  }

  const fits = (t: Track) => !t.locked && fitsInTrack(t, null, clip.startMs, clip.durationMs, clip.frameId);
  const land = (track: Track) => {
    addClipToTrack(track, clip);
    track.clips.sort((a, b) => a.startMs - b.startMs);
  };
  /** A fresh carrier lane at `at`, in `group`. */
  const mint = (at: number, group: string | null) => {
    const carrier = createCarrierTrack(undefined, null, group);
    d.tracks.splice(at, 0, carrier);
    return carrier;
  };

  // Dropped past the top/bottom edge → its own fresh carrier track, no scanning.
  if (newLaneEdge) {
    addClipToTrack(insertTrackAtEdge(d, newLaneEdge, clip.frameId, scope), clip);
    return;
  }

  // "Above the selected layer": ride a fresh carrier track slotted at the
  // anchor's z, in the anchor's own container — the carrier is a row of the
  // same group, so the new clip joins it as a sibling. The one rule that covers
  // plain layers, group members, and a whole group's top. Only when the anchor
  // shares this clip's frame.
  // Above and below are ONE rule with an offset — `d.tracks[0]` is the top of
  // the stack, so "below" is the very next index. Two implementations of this
  // would be two chances to get that direction wrong.
  const anchorId = aboveClipId ?? belowClipId;
  if (anchorId && clip.kind !== "audio") {
    const loc = locateClip(d, anchorId);
    if (loc && loc.clip.kind !== "audio" && loc.clip.frameId === clip.frameId) {
      const beside = landing === "settle" ? laneBeside(d, loc.trackIndex, aboveClipId ? "above" : "below", clip) : null;
      land(beside ?? mint(loc.trackIndex + (aboveClipId ? 0 : 1), loc.track.groupId));
      return;
    }
  }

  // Aimed at a lane: land there, or — no room at this time — on a fresh lane
  // right above it. That is the z you pointed at; scanning for room elsewhere
  // would move the drop somewhere you did not.
  const preferred = preferredTrackId ? d.tracks.find((t) => t.id === preferredTrackId) : undefined;
  if (preferred) {
    land(fits(preferred) ? preferred : mint(d.tracks.indexOf(preferred), preferred.groupId ?? null));
    return;
  }

  // Back to its own lane, when it still exists and is free here. A preference,
  // not an aim: no room, and the rules below decide instead.
  if (homeTrackId) {
    const home = d.tracks.find((t) => t.id === homeTrackId);
    if (home && !home.hidden && fits(home)) return land(home);
  }

  // Audio has no z: any lane of the scope with room, else a new one at the bottom.
  if (clip.kind === "audio") {
    const free = d.tracks.find((t) => inScope(t) && fits(t));
    if (free) land(free);
    else {
      const carrier = createCarrierTrack(undefined, null, scope);
      d.tracks.push(carrier);
      land(carrier);
    }
    return;
  }

  if (landing === "settle") {
    const settled = settleLane(d, clip, scope);
    return land("track" in settled ? settled.track : mint(settled.mintAt, scope));
  }

  // A RESTORE reuses the stack: the topmost lane of the scope with room here,
  // and a fresh one only when every lane is busy at this time. See `landing`.
  if (landing === "reuse") {
    const free = d.tracks.find((t) => inScope(t) && !t.hidden && fits(t));
    return land(free ?? mint(scopeEdgeIndex(d, scope, "top"), scope));
  }

  // THE SURFACE. The scope's topmost lane when it has room here — a locked or
  // hidden top lane is not a surface, it is a lid — else a fresh lane above
  // everything in the scope. Never a lane further down: a layer placed there
  // is born behind the things above it.
  const top = d.tracks.find(inScope);
  land(top && !top.hidden && fits(top) ? top : mint(scopeEdgeIndex(d, scope, "top"), scope));
}
