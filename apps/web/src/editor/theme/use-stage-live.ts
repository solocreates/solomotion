"use client";

import * as React from "react";
import { useSession } from "../state/session";

/**
 * Marks the root `data-stage-live="1"` whenever the canvas is repainting every
 * frame — which today means playback.
 *
 * This exists for exactly one CSS rule: `.material-glass` drops its
 * `backdrop-filter` while the flag is set. A backdrop filter re-samples and
 * re-blurs everything beneath it on every frame that anything beneath it
 * repaints, so glass over a still canvas is free and glass over a PLAYING
 * canvas is several large blur passes at 60fps — the difference between a nice
 * material and a hot laptop.
 *
 * Only the blur is dropped; the tint, rim, specular and shadow all stay, so the
 * capsule keeps its exact geometry and colour weight and the transition is not
 * visible. Cheaper than it looks, too: toggling one attribute on <html> is a
 * single style recalc at the START and END of playback, not per frame.
 *
 * A DOM attribute rather than React state on purpose — the flag has to reach
 * chrome that is portalled to <body> (menus, floating windows) and must not
 * re-render the tree at the moment playback begins.
 */
export function useStageLive(): void {
  const live = useSession((s) => s.playing);

  React.useEffect(() => {
    const root = document.documentElement;
    if (live) root.dataset.stageLive = "1";
    else delete root.dataset.stageLive;
    return () => {
      delete root.dataset.stageLive;
    };
  }, [live]);
}
