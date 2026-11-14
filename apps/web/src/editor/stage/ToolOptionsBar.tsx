"use client";

import * as React from "react";
import {
  BrushSection,
  VectorDrawSection,
  PixelPaintSection,
  EraserSection,
  FillSection,
  FillColorSection,
  LassoSection,
  PaintSettingsButton,
  StudioButton,
} from "../drawing/paint-sections";
import { PaintSettingsOpener, usePaintSettings } from "../drawing/PaintSettings";
import { useSession, type Tool } from "../state/session";
import { BarCapsule, G } from "./tool-bar-kit";
import { ToolSwitch } from "./tool-registry";
import { PenSection, ShapeSection, TextSection } from "./vector-sections";
import { FrameModeSwitch } from "../frames/frame-modes";
import { useToolDefaults } from "../state/tool-defaults";

/**
 * THE STAGE TOOL BAR — the armed tool's own options, above the canvas.
 *
 * It lives in `stage/` because it is stage chrome. It spent a release in
 * `drawing/`, which was true when only the paint tools had options and became a
 * quiet lie the moment the pen moved in; the shape and type tools never moved
 * in at all, and their settings stayed in the right panel where they did not
 * belong (see `vector-sections.tsx` for why that is a rule, not a taste).
 *
 * ── THE REGISTRY IS THE WHOLE EXTENSION POINT ──
 *
 * One map, tool → section. A tool with no entry gets NO BAR — not an empty
 * capsule, not a reserved strip. That is the correct answer for Select and
 * Hand: neither has a setting worth a permanent line across the top of the
 * artwork, and inventing one to fill the space is how a toolbar becomes
 * furniture. The band collapses completely, and the canvas gets the height
 * back — which only became true once `StageChrome` stopped rendering a
 * zero-height row for an absent bar.
 *
 * Adding options to a thirteenth tool is one row here plus one section. The
 * chrome, the scroller, the separators, the overflow door and the placement are
 * written exactly once.
 */

/**
 * The paint family's shared trailer, applied by the registry rather than by
 * each section.
 *
 * Every paint tool ends with the same two doors (the settings sheet, the Brush
 * Studio) and hosts the ONE sheet every pod's settings gesture opens. Wrapping
 * the section here rather than repeating four lines inside four sections is
 * what keeps `PaintSettingsOpener` a single host — two providers over one bar
 * would mean a pod opening a sheet that is not the one on screen.
 */
function paint(Section: React.ComponentType): React.ComponentType {
  return function PaintToolBar() {
    const settings = usePaintSettings();
    return (
      <PaintSettingsOpener value={settings.openAt}>
        <Section />
        <G>
          <PaintSettingsButton settings={settings} />
          <StudioButton />
        </G>
      </PaintSettingsOpener>
    );
  };
}

/** The frame tool draws its next frame in this mode — chosen before you draw. */
function FrameSection() {
  const mode = useToolDefaults((s) => s.frameMode);
  const setMode = useToolDefaults((s) => s.setFrameMode);
  return (
    <G>
      <FrameModeSwitch compact value={mode} onChange={setMode} />
    </G>
  );
}

/** Tool → its options section. One registry, one bar, zero per-tool chrome. */
const TOOL_SECTIONS: Partial<Record<Tool, React.ComponentType>> = {
  frame: FrameSection,
  brush: paint(BrushSection),
  eraser: paint(EraserSection),
  fill: paint(FillSection),
  lasso: paint(LassoSection),
  wand: paint(LassoSection),
  pen: PenSection,
  cut: PenSection,
  text: TextSection,
  rect: ShapeSection,
  ellipse: ShapeSection,
  triangle: ShapeSection,
  polygon: ShapeSection,
  star: ShapeSection,
};

/**
 * Does the armed tool bring a bar with it?
 *
 * Exported because the stage's chrome has to know — the project tabs rise into
 * the tool line when it is empty and sit below it when it is not. The
 * alternative is a second copy of `TOOL_SECTIONS` at the call site, and the
 * copy is what goes stale the next time a tool gains options.
 */
export function hasToolOptions(tool: Tool): boolean {
  return TOOL_SECTIONS[tool] != null;
}

/**
 * The brush family's sections for a 3D world's options row — the same pods,
 * the same settings sheet and studio as the flat bar (`paint`), without a
 * capsule of their own: the world's row composes them with its own zones.
 */
export const VectorDrawTools = paint(VectorDrawSection);
export const PixelPaintTools = paint(PixelPaintSection);
export const FillColorTools = FillColorSection;

export function ToolOptionsBar() {
  const tool = useSession((s) => s.tool);
  const Section = TOOL_SECTIONS[tool];
  if (!Section) return null;
  return (
    // The capsule never scrolls; the strip inside it does (see `BarCapsule`).
    // Its width is the zoned band's call (`chrome-layout.ts`), never its own.
    <BarCapsule>
      {/* IDENTITY, for every tool, from the registry — never from a section.
          Rendering it here means a tool that joins a family gains the switch
          without either file knowing. */}
      <G>
        <ToolSwitch />
      </G>
      <Section />
    </BarCapsule>
  );
}
