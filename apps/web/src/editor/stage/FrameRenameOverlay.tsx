"use client";

import * as React from "react";
import { RenameInput } from "@/components/ui/rename-input";
import { useDoc, useDocStore } from "../state/document-context";
import { useStageCamera } from "../state/session";
import { TOOL_ACCENT } from "./Toolbar";
import { frameLabelAnchor, frameLabelFont, measureFrameLabel } from "./frame-label";

/** Room around the text inside the field's ring, px. */
const PAD_X = 3;
const PAD_Y = 1;
const BORDER = 1;

/**
 * Figma-style inline rename: double-click a frame's name label above the
 * artboard. The canvas stops drawing that label while this is open, and the
 * field sets its text on the label's own baseline in the label's own face
 * (`frame-label.ts`), so the name turns editable in place instead of a second
 * copy appearing beside it.
 */
export function FrameRenameOverlay({ frameId, onDone }: { frameId: string; onDone: () => void }) {
  const doc = useDoc();
  const store = useDocStore();
  const view = useStageCamera();
  const frame = doc.frames.find((f) => f.id === frameId);
  const [textWidth, setTextWidth] = React.useState(() => (frame ? measureFrameLabel(frame.name).width : 0));

  React.useEffect(() => {
    if (!frame) onDone();
  }, [frame, onDone]);
  if (!frame) return null;

  const { x, baseline } = frameLabelAnchor(frame, view);
  const { ascent, descent } = measureFrameLabel(frame.name);

  const commit = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== frame.name) {
      store.update("Rename frame", (d) => {
        const f = d.frames.find((x) => x.id === frameId);
        if (f) f.name = trimmed;
      });
    }
    onDone();
  };

  return (
    <div
      className="absolute z-10"
      style={{ left: x - PAD_X - BORDER, top: baseline - ascent - PAD_Y - BORDER }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <RenameInput
        initial={frame.name}
        onCommit={commit}
        onInput={(e) => setTextWidth(measureFrameLabel(e.currentTarget.value).width)}
        spellCheck={false}
        className="block rounded-[3px] bg-stage shadow-sm"
        style={{
          font: frameLabelFont(),
          lineHeight: `${ascent + descent}px`,
          height: ascent + descent + PAD_Y * 2 + BORDER * 2,
          width: Math.ceil(textWidth) + PAD_X * 2 + BORDER * 2 + 2,
          padding: `${PAD_Y}px ${PAD_X}px`,
          border: `${BORDER}px solid ${TOOL_ACCENT.frame}`,
          color: TOOL_ACCENT.frame,
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}
