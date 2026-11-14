"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import { Sparkles } from "lucide-react";
import { platform } from "@/editor/platform";
import { notify } from "@/components/notifications";
import { useUpdate } from "./update-store";

/** How often to re-check while the app stays open (ms). */
const POLL_MS = 30 * 60 * 1000;
/** Min gap between focus-triggered checks, so tab-flipping doesn't spam (ms). */
const FOCUS_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Headless orchestrator (renders nothing). Drives the update cadence — check on
 * start, on window focus (throttled), and on a slow interval — and pops the
 * one-time "update available" notification the first time each new version is
 * seen. Mount ONCE, high in the tree (see ClientEditor).
 */
export function UpdateChecker() {
  const check = useUpdate((s) => s.check);
  const setProgress = useUpdate((s) => s.setProgress);
  const setDialogOpen = useUpdate((s) => s.setDialogOpen);
  const apply = useUpdate((s) => s.apply);
  // Which version we've already toasted for — so we nudge once per version, not
  // on every re-check that still finds the same update pending.
  const notifiedFor = React.useRef<string | null>(null);

  // Start + interval + focus (throttled).
  React.useEffect(() => {
    void check();
    const interval = setInterval(() => void check(), POLL_MS);
    let lastFocusCheck = Date.now();
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFocusCheck < FOCUS_THROTTLE_MS) return;
      lastFocusCheck = Date.now();
      void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [check]);

  // Native install progress → store (no-op on reload hosts).
  React.useEffect(() => platform.update.onProgress(setProgress), [setProgress]);

  // First-detect notification: one card per newly-available version.
  React.useEffect(() => {
    return useUpdate.subscribe((state) => {
      if (state.phase !== "available" || !state.latest) return;
      if (notifiedFor.current === state.latest) return;
      notifiedFor.current = state.latest;
      const applyKind = state.applyKind;
      notify({
        id: "app-update", // stable id → a newer version replaces the same card
        tone: "brand",
        corner: "bottom-right",
        icon: <Sparkles />,
        title: `Update available — v${state.latest}`,
        description:
          applyKind === "install"
            ? `Install on relaunch to get the latest ${identity.name}.`
            : "Reload to switch to the latest build.",
        actions: [
          {
            label: applyKind === "install" ? "Install" : "Reload",
            onClick: () => void apply(),
          },
          { label: "Details", variant: "ghost", onClick: () => setDialogOpen(true) },
        ],
      });
    });
  }, [apply, setDialogOpen]);

  return null;
}
