"use client";

import * as React from "react";
import { FileText, Orbit, Palette, Smile, Sparkles, Target, Volume2, Waypoints } from "lucide-react";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { inspectorTabs, type InspectorTab } from "./shared-inspector";

/**
 * PROPERTIES' SECTIONS — Design, Effects, Animate, Sound … — described once.
 *
 * They belong to Properties, not to the right rail. They used to exist only
 * as right-rail items, so Properties anywhere else (a region's tab strip, a
 * floating or OS window) had no way to reach Effects or Sound at all. Now the
 * rail and Properties' own section bar read this one hook: on a rail the rail
 * carries them; anywhere else the panel does (`InspectorSectionBar`).
 *
 * Which sections exist follows the selection (`inspectorTabs`, the same brain
 * the panel renders from), which is also why their ORDER is not the user's to
 * sort: a list that grows and shrinks with every click cannot hold a
 * hand-made order. They move as one block, with Properties.
 */
export interface InspectorSection {
  key: InspectorTab | "project";
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  hint: string;
  /** The section the panel is SHOWING (the stored one, or its fallback). */
  active: boolean;
}

export const SECTION_META: Record<InspectorTab, { name: string; icon: InspectorSection["icon"]; hint: string }> = {
  design: { name: "Design", icon: Palette, hint: "Transform, appearance, type" },
  character: { name: "Character", icon: Smile, hint: "Face, voice, life and rig" },
  effects: { name: "Effects", icon: Sparkles, hint: "The layer's effect stack" },
  animate: { name: "Animate", icon: Waypoints, hint: "In/out animation and keyframes" },
  track: { name: "Track", icon: Target, hint: "Track motion in footage, or follow a track" },
  physics: { name: "Physics", icon: Orbit, hint: "Bodies, joints, fields and the simulation" },
  sound: { name: "Sound", icon: Volume2, hint: "Gain, EQ and voice" },
  cues: { name: "Cues", icon: Volume2, hint: "Caption cues" },
};

export function useInspectorSections(): InspectorSection[] {
  const doc = useDoc();
  const selectedIds = useSession((s) => s.selectedClipIds);
  const selectedFrames = useSession((s) => s.selectedFrameIds);
  const stored = useSession((s) => s.inspectorTab);

  const clips = React.useMemo(() => {
    const found = [];
    for (const track of doc.tracks) for (const clip of track.clips) if (selectedIds.includes(clip.id)) found.push(clip);
    return found;
  }, [doc, selectedIds]);

  // A FRAME has two faces: its design and its sound (the comp's mix master).
  const tabs: readonly InspectorTab[] = clips.length ? inspectorTabs(clips, doc) : selectedFrames.length ? ["design", "sound"] : [];
  // With nothing selected the panel shows the PROJECT — say so, or the rail
  // is a column of nothing beside a panel full of something.
  if (!tabs.length) return [{ key: "project", name: "Project", icon: FileText, hint: "Document settings and variables", active: true }];
  // The panel falls back to the first section when the stored one is not
  // offered; the armed item has to agree with what is drawn.
  const shown = tabs.includes(stored as InspectorTab) ? stored : tabs[0];
  return tabs.map((t) => ({ key: t, ...SECTION_META[t], active: t === shown }));
}
