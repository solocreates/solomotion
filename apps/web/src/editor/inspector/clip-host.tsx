"use client";

import * as React from "react";
import type { MotionDocument, Clip } from "@solomotion/core";

/**
 * A CLIP HOST — something that is not a clip standing in for one, so a panel
 * written against a clip can edit it unchanged.
 *
 * The sound effect stack is the case that made it: a category's chain is the
 * same list of cards a clip carries, with the same palette, editor window,
 * presets and EQ curve, and forking all of that to edit a bus would be the
 * second implementation that drifts. So a category renders the SAME section
 * over a shadow clip, and this context tells the two write seams where the
 * shadow's writes go (`useClipUpdater`) and that it has no clock to key on
 * (the key controls hide).
 */
export interface ClipHost {
  /** The shadow clip's id — writes addressed to it are the host's. */
  id: string;
  /** Apply a clip-shaped mutation to the host, in one undo step. */
  write(label: string, fn: (clip: Clip, doc: MotionDocument) => void, mergeKey?: string): void;
  /** No timeline: keyframe controls render nothing. */
  timeless: boolean;
}

const ClipHostContext = React.createContext<ClipHost | null>(null);

export function ClipHostProvider({ host, children }: { host: ClipHost; children: React.ReactNode }) {
  return <ClipHostContext.Provider value={host}>{children}</ClipHostContext.Provider>;
}

/** The host standing in for `clipId`, if one is. */
export function useClipHost(clipId?: string): ClipHost | null {
  const host = React.useContext(ClipHostContext);
  return host && (clipId === undefined || host.id === clipId) ? host : null;
}
