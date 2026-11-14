"use client";

import * as React from "react";
import { resolveEditContext, setStillMoment, type DocumentStore, type EditPath } from "@solomotion/core";
import { useSession } from "./session";

/** How long the playhead must sit still before its frame remembers it. */
const SETTLE_MS = 500;

/**
 * Every root frame keeps its OWN playhead (`Frame.playheadMs`) — the
 * After Effects rule: a comp's current time is saved with the project, and two
 * unrelated comps never share one.
 *
 * The session holds the live instant; this is the one writer that pins it to
 * the frame, at the two moments that matter: when you LEAVE a root (so coming
 * back restores it) and when the playhead SETTLES (so a save or a reload keeps
 * it). Never per tick — a scrub is sixty writes a second and every one would
 * wake every document reader — and never through history, because moving the
 * playhead is not an edit.
 *
 * It stores ROOT time: drilled three levels deep, the frame remembers the
 * instant its own clock was at, and re-entering maps back down the path.
 */
export function usePlayheadMemory(store: DocumentStore): void {
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pin = (path: EditPath, playheadMs: number) => {
      const doc = store.getState();
      const frame = doc.frames.find((f) => f.id === path.rootFrameId);
      if (!frame) return;
      const ctx = resolveEditContext(doc, path, playheadMs);
      const at = Math.round(Math.max(0, ctx ? ctx.conductTimeMs : playheadMs) * 1000) / 1000;
      if ((frame.playheadMs ?? 0) === at) return;
      store.remember((d) => {
        const f = d.frames.find((x) => x.id === path.rootFrameId);
        if (f) f.playheadMs = at;
      });
    };

    const unsub = useSession.subscribe((s, prev) => {
      if (s.nav.path.rootFrameId !== prev.nav.path.rootFrameId) {
        if (timer) clearTimeout(timer);
        timer = null;
        if (prev.nav.path.rootFrameId) pin(prev.nav.path, prev.playheadMs);
        return;
      }
      if (s.playing || (s.playheadMs === prev.playheadMs && s.playing === prev.playing)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const now = useSession.getState();
        if (!now.playing && now.nav.path.rootFrameId) pin(now.nav.path, now.playheadMs);
      }, SETTLE_MS);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [store]);
}

/**
 * THE PLAYHEAD BENEATH A STILL PICKS ITS MOMENT.
 *
 * A static frame shows one instant, and so does everything it nests: step into
 * a timeline inside a still and its picture is pinned to wherever the still
 * maps it (`EditContext.moment`). Scrubbing there is therefore not moving a
 * clock — it is choosing which moment the still shows, and that choice is
 * CONTENT: the still exports it and every instance of the still shows it.
 *
 * So each playhead change there becomes the edit that makes it true
 * (`setStillMoment`, a slip of the nested clip directly under the still), one
 * undo step per clip however long you scrub. When the clip cannot be made to
 * show that instant (a reversed or looping clip past its span) the playhead
 * returns to what the still actually shows — the timeline never claims a
 * moment the picture is not at.
 */
export function useStillMoments(store: DocumentStore): void {
  React.useEffect(() => {
    return useSession.subscribe((s, prev) => {
      if (s.playing || s.playheadMs === prev.playheadMs || s.nav.path !== prev.nav.path) return;
      if (s.nav.path.hops.length === 0) return;
      const doc = store.getState();
      const ctx = resolveEditContext(doc, s.nav.path, s.playheadMs);
      const moment = ctx?.moment;
      if (!ctx || !moment) return;
      let landed = false;
      store.update(
        "Pick the still's moment",
        (d) => void (landed = setStillMoment(d, moment.clipId, moment.parentTimeMs, moment.childTimeMs)),
        { mergeKey: `still-moment-${moment.clipId}` },
      );
      if (!landed) useSession.getState().setPlayhead(ctx.targetTimeMs);
    });
  }, [store]);
}
