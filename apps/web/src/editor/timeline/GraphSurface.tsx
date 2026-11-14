"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { usePxPerSec } from "./use-time-axes";
import { GraphPanel } from "./GraphPanel";
import { useGraphEditor } from "./graph-editor";
import { useHeaderWidth } from "./header-width";
import { activeCompId, timeToPx, timelineSpanMs } from "./timeline-utils";

/**
 * The graph editor as a STANDALONE surface.
 *
 * `GraphPanel` takes `pxPerSec`, `contentWidth` and `headerW` as props, and
 * Timeline was the only thing that computed them — which is what made the graph
 * a child of the lanes rather than a peer of them, and why Keyframes and Curves
 * could not be opened on their own.
 *
 * Every one of those three is derivable from state the graph can read for
 * itself: the zoom from the session, the span from the document, the gutter
 * from the shared `useHeaderWidth` store. Deriving them here is what lets the
 * bottom bar's three buttons behave as three independent switches. When the
 * lanes ARE up they still agree, because both read the same sources.
 */
export function GraphSurface({ fill }: { fill?: boolean }) {
  const doc = useDoc();
  const pxPerSec = usePxPerSec();
  const headerW = useHeaderWidth((s) => s.width);
  const tab = useGraphEditor((s) => s.tab);
  const setTab = useGraphEditor((s) => s.setTab);
  const compId = activeCompId(doc, useSession((s) => s.activeFrameId));

  // Same formula the lanes use, so the two content widths cannot disagree.
  const contentWidth = timeToPx(timelineSpanMs(doc, compId), pxPerSec) + 120;

  return (
    <div className={cn("min-h-0", fill ? "h-full" : "shrink-0")}>
      <GraphPanel
        tab={tab}
        onTabChange={setTab}
        pxPerSec={pxPerSec}
        contentWidth={contentWidth}
        headerW={headerW}
        fill={fill}
      />
    </div>
  );
}
