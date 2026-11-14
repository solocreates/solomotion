"use client";

import {
  AudioLines,
  Bone,
  Box,
  ToggleRight,
  Camera,
  Globe,
  Lightbulb,
  Move3d,
  Sun,
  Brush,
  Captions,
  Clapperboard,
  Contrast,
  Film,
  Group as GroupIcon,
  Image as ImageIcon,
  PenTool,
  Shapes,
  Spline,
  Type,
  type LucideIcon,
} from "lucide-react";
import { isCaptionClip, type Clip } from "@solomotion/core";
import { cn } from "@/lib/utils";

/**
 * ONE clip-kind → icon map, shared by the timeline clips, the inspector and the
 * layers/library surfaces so a kind always reads the same everywhere. Kind
 * accent colors live alongside (used for the tinted icon in the inspector).
 */
export const CLIP_KIND_ICON: Record<Clip["kind"], LucideIcon> = {
  text: Type,
  audio: AudioLines,
  nested: Film,
  group: GroupIcon,
  image: ImageIcon,
  video: Clapperboard,
  shape: Shapes,
  path: PenTool,
  waveform: AudioLines,
  trace: Spline,
  raster: Brush,
  adjustment: Contrast,
  mesh: Box,
  camera: Camera,
  light: Lightbulb,
  empty: Move3d,
};

/**
 * The icon for one CLIP — the kind's, except that a text layer carrying the
 * caption module reads as a caption. Kind alone stopped being the whole answer
 * in v52; asking here keeps every surface agreeing about what a layer IS.
 */
export function clipIcon(clip: Clip): LucideIcon {
  if (clip.kind === "light") return clip.light.type === "sun" ? Sun : clip.light.type === "environment" ? Globe : Lightbulb;
  // A rig and a switch are groups that DO something: they read as what they are.
  if (clip.kind === "group" && clip.rig) return Bone;
  if (clip.kind === "group" && clip.switch) return ToggleRight;
  return isCaptionClip(clip) ? Captions : CLIP_KIND_ICON[clip.kind];
}

export function ClipKindIcon({
  kind,
  clip,
  className,
}: {
  kind?: Clip["kind"];
  clip?: Clip;
  className?: string;
}) {
  const Icon = clip ? clipIcon(clip) : CLIP_KIND_ICON[kind ?? "text"];
  return <Icon className={cn("size-3.5 shrink-0", className)} />;
}
