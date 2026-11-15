"use client";

import * as React from "react";
import { Box, Circle, Component, Crosshair, FileText, Film, Frame as FrameIcon, Hash, Move, Palette, ToggleLeft, Type, type LucideIcon } from "lucide-react";
import type { DocNode, ExprType, PickCandidate, VariableType } from "@solomotion/core";
import { cn } from "@/lib/utils";
import { ClipKindIcon } from "../ui/clip-icon";
import { VARIABLE_TYPE_META } from "../inspector/variables/variable-meta";

/**
 * ONE icon for anything pickable. A layer reads as its kind (the timeline's
 * own icon), a frame as what it is, a value as its type. A family registered
 * from outside the app's core set (`registerPickProvider` — trackers) names a
 * `glyph` and maps it here once with `registerPickGlyph`.
 */

const FRAME_ICON: Record<string, LucideIcon> = { page: FileText, frame: FrameIcon, world: Box, component: Component, comp: Film };
const TYPE_ICON: Record<ExprType, LucideIcon> = { float: Hash, vec2: Move, color: Palette, bool: ToggleLeft, string: Type, layer: FrameIcon, track: Crosshair };

const glyphs = new Map<string, React.ComponentType<{ className?: string }>>([["tracker", Crosshair]]);

export function registerPickGlyph(glyph: string, icon: React.ComponentType<{ className?: string }>): () => void {
  glyphs.set(glyph, icon);
  return () => glyphs.delete(glyph);
}

const isVariableType = (t: string): t is VariableType => t in VARIABLE_TYPE_META;

/** What a glyph is chosen from — a candidate has all of it. */
export type GlyphSource = Pick<PickCandidate, "kind" | "clip" | "node" | "glyph" | "type">;

/** A doc-index node (⌘P, the link picker) as a glyph source. */
export function docNodeGlyph(n: DocNode): GlyphSource {
  return { kind: n.kind === "layer" ? "layer" : n.kind === "page" ? "page" : "frame", clip: n.clip, node: n.kind };
}

export function PickGlyph({ candidate, className }: { candidate: GlyphSource; className?: string }) {
  if (candidate.kind === "layer" && candidate.clip) return <ClipKindIcon clip={candidate.clip} className={className} />;
  if (candidate.kind === "frame" || candidate.kind === "page") {
    const Icon = FRAME_ICON[candidate.node ?? candidate.kind] ?? FrameIcon;
    return <Icon className={cn(className, candidate.node === "component" && "text-(--kind-component)")} />;
  }
  if (candidate.glyph?.startsWith("variable:")) {
    const t = candidate.glyph.slice("variable:".length);
    const Icon = isVariableType(t) ? VARIABLE_TYPE_META[t].icon : Hash;
    return <Icon className={className} />;
  }
  const Registered = candidate.glyph ? glyphs.get(candidate.glyph) : undefined;
  if (Registered) return <Registered className={className} />;
  const Icon = candidate.type ? TYPE_ICON[candidate.type] : Circle;
  return <Icon className={className} />;
}
