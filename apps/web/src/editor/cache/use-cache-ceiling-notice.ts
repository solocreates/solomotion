"use client";

import * as React from "react";
import { cachesAtCeiling, framesCacheOn, isRollingCache, subscribeCacheStatus } from "./cache-status";
import { useSession } from "../state/session";
import { useStatusBar } from "../state/status-bar";

/**
 * THE CACHE FILLED UP — said once, with the one thing that fixes it.
 *
 * Under Auto nothing needs saying: Auto opens at the tier whose range fits
 * (`tierFittingMemory`). A PINNED tier is a person's explicit choice, and at
 * Full it is also the choice most likely to be forgotten — a gigabyte of cache
 * is a few seconds of a portrait comp. So when the rendered-frames cache
 * reaches its ceiling under a pinned tier, the status bar says which cache
 * filled and offers Auto. Once per filling: it re-arms only after the cache
 * has room again, so a full cache is one message, not a stream of them.
 */
const NOTICE_ID = "cache-ceiling";

export function useCacheCeilingNotice(): void {
  React.useEffect(() => {
    let armed = true;
    return subscribeCacheStatus(() => {
      // The PLAYBACK cache — frames or layers, whichever is on.
      const playbackId = framesCacheOn() ? "comp" : "layer";
      const full = cachesAtCeiling().find((p) => p.id === playbackId);
      if (!full) {
        // Room again: the warning is no longer true, so it stops being said.
        if (!armed) useStatusBar.getState().dismiss(NOTICE_ID);
        armed = true;
        return;
      }
      const setting = useSession.getState().previewResolution;
      if (!armed || setting === "auto") return;
      armed = false;
      useStatusBar.getState().notify({
        id: NOTICE_ID,
        kind: "warning",
        text: isRollingCache() ? "Cache full — older frames are being let go" : "Cache full — new frames aren't being kept",
        description: `Preview is pinned to ${setting}. Auto picks the sharpest resolution that fits.`,
        action: {
          label: "Use Auto",
          onClick: () => {
            useSession.getState().setPreviewResolution("auto");
            useStatusBar.getState().notify({ kind: "success", text: "Preview set to Auto" });
          },
        },
      });
    });
  }, []);
}
