"use client";

import * as React from "react";
import { Film, Image as ImageIcon, Layers2 } from "lucide-react";
import {
  FRAME_MODES,
  setFrameMode,
  type MotionDocument,
  type DocumentStore,
  type Frame,
  type FrameMode,
} from "@solomotion/core";
import { Segmented } from "@/components/ui/segmented";
import { contextOf } from "../state/navigation";
import { useSession } from "../state/session";
import { useToolDefaults } from "../state/tool-defaults";

/**
 * FRAME MODES, as the editor says them — the one vocabulary every surface that
 * names a mode reads: the switcher (inspector, frame tool, menus), the layers
 * panel's row glyphs, the breadcrumb. A mode's icon living in three files is
 * how a flipbook came to be a film strip in one place and a stack in another.
 */
export const FRAME_MODE_META: Record<
  FrameMode,
  { label: string; icon: React.ComponentType<{ className?: string }>; hint: string }
> = {
  timeline: { label: "Timeline", icon: Film, hint: "Layers move on a timeline" },
  flipbook: { label: "Flipbook", icon: Layers2, hint: "Frame by frame — draw every frame" },
  static: { label: "Static", icon: ImageIcon, hint: "One picture — a design, a thumbnail, a page" },
};

/**
 * Switch a frame's mode from the editor. The core verb (`setFrameMode`) keeps
 * the switch lossless; this adds the one thing only the session knows — the
 * instant you are standing on in that frame — so "static" stills exactly the
 * picture on screen, and "timeline" resumes on it.
 */
export function switchFrameMode(store: DocumentStore, frameId: string, mode: FrameMode): void {
  const doc = store.getState();
  const session = useSession.getState();
  const ctx = contextOf(doc, session.nav, session.playheadMs);
  const atMs = ctx?.frameTimes.get(frameId);
  const standing = ctx?.target.id === frameId;
  store.update(`Make ${FRAME_MODE_META[mode].label.toLowerCase()}`, (d) => void setFrameMode(d, frameId, mode, { atMs }));
  // Standing in it: the timeline you return to opens on the moment the still
  // was showing — the frame remembered it, the session follows.
  if (standing && mode === "timeline") {
    const resumed = store.getState().frames.find((f) => f.id === frameId)?.playheadMs;
    if (resumed !== undefined) session.setPlayhead(resumed);
  }
}

/**
 * THE way a new frame joins the document — the frame tool's drag, its size
 * presets, any "New frame" door. Born in the frame tool's chosen mode, so what
 * you pick before drawing is what you get; a flipbook arrives with its first
 * blank drawing like one made anywhere else.
 */
export function insertFrame(d: MotionDocument, frame: Frame, mode: FrameMode = useToolDefaults.getState().frameMode): void {
  d.frames.push(frame);
  if (mode !== "timeline") setFrameMode(d, frame.id, mode, { atMs: 0 });
}

/**
 * THE MODE SWITCH — the one "which mode" control, wherever a mode is chosen.
 * It is the app's Segmented control with the modes' own icons; in a toolbar it
 * goes `bare`, because the capsule it sits in is already its frame.
 */
export function FrameModeSwitch({
  value,
  onChange,
  compact,
  disabled,
  className,
}: {
  value: FrameMode;
  onChange: (mode: FrameMode) => void;
  /** Toolbar use: content width, no recess of its own. */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Segmented
      aria-label="Frame mode"
      value={value}
      onChange={onChange}
      disabled={disabled}
      stretch={!compact}
      bare={compact}
      className={className}
      options={FRAME_MODES.map((mode) => ({
        value: mode,
        label: FRAME_MODE_META[mode].label,
        icon: FRAME_MODE_META[mode].icon,
        hint: FRAME_MODE_META[mode].hint,
      }))}
    />
  );
}

/** A frame's mode switch, bound to the document. */
export function FrameModeControl({ store, frame, className }: { store: DocumentStore; frame: Frame; className?: string }) {
  return (
    <FrameModeSwitch
      value={frame.mode}
      disabled={frame.instanceOf != null}
      onChange={(mode) => switchFrameMode(store, frame.id, mode)}
      className={className}
    />
  );
}
