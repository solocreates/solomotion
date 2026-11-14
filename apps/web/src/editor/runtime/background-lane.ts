"use client";

import { createBackgroundLane, type BackgroundLane } from "@solomotion/core";
import { useSession } from "../state/session";

/**
 * THE app's background lane — core's rule (`runtime/background.ts`) wired to
 * the two facts only the app knows: is the person interacting, and does the
 * foreground own the thread (playback; a hidden tab, where a thumbnail is
 * work nobody will see).
 *
 * Every optional producer takes its permits here. A second lane would be a
 * second opinion about how much of the main thread is spare, and two
 * producers each "only using a third" is two thirds.
 */
let lane: BackgroundLane | null = null;

export function backgroundLane(): BackgroundLane {
  if (lane) return lane;
  lane = createBackgroundLane({
    isBusy: () =>
      useSession.getState().playing || (typeof document !== "undefined" && document.visibilityState === "hidden"),
  });
  if (typeof window !== "undefined") {
    const note = () => lane!.noteInput();
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", note, opts);
    window.addEventListener("keydown", note, opts);
    window.addEventListener("wheel", note, opts);
    // A drag is input; a hover is not — a cursor resting over the timeline must
    // not starve its own thumbnails.
    window.addEventListener("pointermove", (e) => e.buttons !== 0 && note(), opts);
  }
  return lane;
}
