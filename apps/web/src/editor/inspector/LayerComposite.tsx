"use client";

import * as React from "react";
import {
  clipBox,
  cropWindow,
  fitContent,
  isAdjustmentClip,
  isVisualClip,
  type Clip,
  type VisualClip,
} from "@solomotion/core";
import { Crop, Maximize } from "lucide-react";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { commitProperty, useField } from "./animatable";
import { mergeReads, selectValue, type Field } from "./merge";
import { usePeers } from "./selection-scope";
import { BlendSelect } from "./PaintPopover";
import { CornerRadiusRows } from "./CornerRadiusRows";
import { EdgeGlyph, type Side } from "./glyphs";
import { Half, IconToggle, Inline, Pair, PanelSection, PropRow } from "./controls";
import { KeyControl } from "./keyframe-controls";
import { useClipUpdater } from "./use-clip-updater";

/**
 * APPEARANCE — how the layer is composited and shaped, as opposed to where it
 * sits. Opacity, blend, feather, corner radius and crop used to be tacked onto
 * the bottom of Transform, which made Transform's group-keyframe diamond claim
 * opacity as a transform property and left the panel with one giant section
 * instead of two honest ones. Same fields, same paths, correct home.
 *
 * Every kind renders this — a text layer feathers and fades exactly like an
 * image does. Only the box kinds add radius/crop, because those two land at the
 * one `withBoxClip` render seam that only box layers pass through.
 */
/**
 * The kinds whose silhouette is a BOX, and so carry a crop window and per-corner
 * radii. A processor is one of them: it has no art of its own, so its box is the
 * comp it grades — which makes the crop a Resolve-style power window and the
 * radii its rounded corners (see `renderAdjustment`'s region).
 */
const BOX_KINDS: ReadonlySet<VisualClip["kind"]> = new Set([
  "image",
  "video",
  "nested",
  "raster",
  "waveform",
  "adjustment",
]);

/**
 * The kinds that have a PICTURE inside that box, and so can move it — the
 * `withBoxClip` set exactly.
 *
 * A processor is the one box kind that is not here, and the reason is the same
 * one that gives it a crop in the first place: its box IS the comp it grades,
 * so there is no art of its own to reframe. Offering the control anyway would
 * be four fields that write four properties nothing reads.
 */
const CONTENT_KINDS: ReadonlySet<VisualClip["kind"]> = new Set([
  "image",
  "video",
  "nested",
  "raster",
  "waveform",
]);

const CROP_SIDES: ReadonlyArray<{ side: Side; label: string }> = [
  { side: "top", label: "Crop top" },
  { side: "right", label: "Crop right" },
  { side: "bottom", label: "Crop bottom" },
  { side: "left", label: "Crop left" },
];


export function AppearanceSection({ clips }: { clips: Clip[] }) {
  const primary = clips.find(isVisualClip);
  if (!primary) return null;
  return (
    <PanelSection
      id="appearance"
      title="Appearance"
      defaultOpen={false}
      transfer={clips.length === 1 ? { domains: ["transform"], clipId: primary.id } : undefined}
    >
      <AppearanceRows clip={primary} />
    </PanelSection>
  );
}

const isBoxLike = (c: VisualClip) => BOX_KINDS.has(c.kind) || (c.kind === "group" && c.layout !== null);

function AppearanceRows({ clip }: { clip: VisualClip }) {
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, isVisualClip);
  const opacity = useField(peers, "opacity", (c) => c.opacity);
  const feather = useField(peers, "feather", (c) => c.feather);
  const blend = mergeReads(peers, (c) => c.blendMode);
  // A processor paints no ink of its own, so its alpha is not transparency —
  // it is the WET/DRY MIX between the graded composite and the original, which
  // is what every grading tool calls it and what `renderAdjustment` does with
  // it. Same control, same property, same keyframes: only the word changes.
  const isProcessor = peers.every(isAdjustmentClip);

  const setOpacity = (v: number) =>
    update("Opacity", (c) => commitProperty(c, "opacity", v, useSession.getState().playheadMs), "layer-opacity");

  const setBlend = (mode: string) =>
    update("Blend mode", (c) => {
      if (c.kind !== "audio") c.blendMode = mode as VisualClip["blendMode"];
    });

  const lights = mergeReads(peers, (c) => c.emitsLight === true);
  const setLight = (on: boolean) =>
    update(on ? "Emits light" : "No light", (c) => {
      if (!isVisualClip(c)) return;
      if (on) c.emitsLight = true;
      else delete c.emitsLight;
    });

  const setFeather = (v: number) =>
    update("Feather", (c) => commitProperty(c, "feather", Math.max(0, v), useSession.getState().playheadMs), "layer-feather");

  return (
    <>
      <PropRow
        label={isProcessor ? "Mix" : "Opacity"}
        hint={isProcessor ? "How much of the graded result replaces the original." : undefined}
        keyControl={<KeyControl clip={clip} property="opacity" currentValue={() => opacity.value} />}
      >
        <Pair>
          <NumberInput
            value={Math.round(opacity.value * 100)}
            mixed={opacity.mixed}
            min={0}
            max={100}
            precision={0}
            unit="%"
            onChange={(v) => setOpacity(v / 100)}
          />
          <BlendSelect value={selectValue(blend)} onChange={setBlend} className="h-7 min-w-0 text-xs" />
        </Pair>
      </PropRow>

      {/* Feather softens the layer's alpha edge — the same headless matte control
          that softens a mask stencil, a tracked blur region, or a processor's
          scope + crop window. */}
      <PropRow
        label="Feather"
        hint={
          isProcessor
            ? "Softens the edge of what this grade reaches — its scope and its crop window."
            : "Softens the layer's edge. Also softens a mask or a tracked region."
        }
        keyControl={<KeyControl clip={clip} property="feather" currentValue={() => feather.value} />}
      >
        <Half>
          <NumberInput
            value={Math.round(feather.value)}
            mixed={feather.mixed}
            min={0}
            precision={0}
            unit="px"
            onChange={setFeather}
          />
        </Half>
      </PropRow>

      {/* A light stays a light under a material (Surface's Spare lights). A
          processor paints nothing of its own, so it has nothing to emit. */}
      {!isProcessor && (
        <PropRow label="Emits light" hint="Stays clean under a material, glow and all (Surface › Spare lights).">
          <Switch checked={!lights.mixed && lights.value} onCheckedChange={setLight} aria-label="Emits light" />
        </PropRow>
      )}

      {/* Universal PER-CORNER radius — the SAME control a rectangle uses, rounding
          any box layer (image/video/drawing/nested) at the seam feather + crop use.
          A laid-out group is a box too (relations/layout.ts): its fill paints
          the container and its corners round it. */}
      {peers.every(isBoxLike) && <CornerRadiusRows peers={peers} prefix="borderRadius" read={(c) => c.borderRadius} />}
      {peers.every((c) => BOX_KINDS.has(c.kind)) && <CropRows peers={peers} />}
      {peers.every((c) => CONTENT_KINDS.has(c.kind)) && <ContentRows peers={peers} />}
    </>
  );
}

/**
 * THE PICTURE INSIDE THE WINDOW — pan, zoom and rotate the footage with the
 * crop held still (v68).
 *
 * It is the same `PropRow` / `NumberInput` / `KeyControl` kit every other
 * property uses — so these fields keyframe, take an expression, take a driver
 * and take a modulator, with nothing written here to allow it. That is the
 * whole benefit of making the picture's placement a PROPERTY rather than a
 * gesture's private arithmetic. Fit / Fill are `fitContent` in core, the same
 * function the stage's double-click uses.
 *
 * ## It shows up when it is about something
 *
 * A layer has two rotations now — the LAYER's and the PICTURE's — and on an
 * uncropped photo they do visibly the same thing, so a permanent second R field
 * five rows under the first is a trap rather than a feature. It is there when
 * there is a picture-inside-a-window to talk about: the layer is cropped, or the
 * picture has already been moved, or you are in the crop gesture right now.
 *
 * Not a collapsed accordion, because a shut section still costs a row and still
 * poses the question. The crop toggle beside it IS the way in — press it and
 * these fields appear with the handles, which is the moment they mean something.
 */
function ContentRows({ peers }: { peers: readonly VisualClip[] }) {
  const clip = peers[0]!;
  const doc = useDoc();
  const update = useClipUpdater(clip.id);
  const cropping = useSession((s) => s.cropClipId === clip.id);
  const fx = useField(peers, "content.x", (c) => c.content.x);
  const fy = useField(peers, "content.y", (c) => c.content.y);
  const fzoom = useField(peers, "content.scale", (c) => c.content.scale);
  const frot = useField(peers, "content.rotation", (c) => c.content.rotation);
  const zoom = fzoom.value;
  // Shown when ANY of them has a picture-inside-a-window to talk about.
  const cropped = peers.some((c) => c.crop.top > 0 || c.crop.right > 0 || c.crop.bottom > 0 || c.crop.left > 0);
  const reframed =
    fx.mixed || fy.mixed || fzoom.mixed || frot.mixed ||
    fx.value !== 0 || fy.value !== 0 || Math.abs(zoom - 1) > 0.0001 || frot.value !== 0 || peers.some((c) => c.content.scaleY != null);

  const set = (path: string, v: number) =>
    update("Reframe content", (c) => commitProperty(c, path, v, useSession.getState().playheadMs), `layer-${path}`);

  // The window this picture sits in, right now — core's one answer, the same
  // one the renderer clips to.
  const seat = (mode: "fit" | "fill") => {
    // Each layer seats in its OWN window — the fit is a function of its box.
    update(mode === "fill" ? "Fill crop" : "Fit in crop", (c, d) => {
      if (!isVisualClip(c)) return;
      const box = clipBox(d, c);
      const next = fitContent(box, cropWindow(c.crop, box), mode);
      const ms = useSession.getState().playheadMs;
      commitProperty(c, "content.x", Math.round(next.x), ms);
      commitProperty(c, "content.y", Math.round(next.y), ms);
      commitProperty(c, "content.scale", Number(next.scale.toFixed(4)), ms);
      commitProperty(c, "content.rotation", 0, ms);
    });
  };

  const reset = () =>
    update("Reset content", (c) => {
      const ms = useSession.getState().playheadMs;
      commitProperty(c, "content.x", 0, ms);
      commitProperty(c, "content.y", 0, ms);
      commitProperty(c, "content.scale", 1, ms);
      commitProperty(c, "content.rotation", 0, ms);
    });

  if (!cropped && !reframed && !cropping) return null;

  return (
    <PropRow
      label="Content"
      hint="Where the picture sits inside the crop — its own pan, zoom and angle. Moving it never moves the crop, and never touches the layer's transform above."
      keyControl={<KeyControl clip={clip} property="content.scale" currentValue={() => zoom} />}
    >
      <Inline
        trailing={
          <IconToggle label="Fill the crop — ⌥-click to reset" pressed={false} onClick={(e) => (e.altKey ? reset() : seat("fill"))}>
            <Maximize />
          </IconToggle>
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          <NumberInput label="X" title="Pan the picture" value={Math.round(fx.value)} mixed={fx.mixed} precision={0} onChange={(v) => set("content.x", v)} />
          <NumberInput label="Y" title="Pan the picture" value={Math.round(fy.value)} mixed={fy.mixed} precision={0} onChange={(v) => set("content.y", v)} />
          <NumberInput
            label="Z"
            title="Zoom the picture"
            value={Math.round(zoom * 100)}
            mixed={fzoom.mixed}
            precision={0}
            unit="%"
            onChange={(v) => set("content.scale", v / 100)}
          />
          <NumberInput
            label="R"
            title="Turn the picture inside the crop — not the layer"
            value={Math.round(frot.value)}
            mixed={frot.mixed}
            precision={0}
            unit="°"
            onChange={(v) => set("content.rotation", v)}
          />
        </div>
      </Inline>
    </PropRow>
  );
}

/**
 * The universal CROP — four per-side insets (Figma/DaVinci) laid out as a 2×2
 * box with an edge glyph on each field, so you read the geometry instead of
 * translating the words "top/right/bottom/left". Each field keyframes through
 * `crop.<side>`; the toggle enters the on-stage crop gesture, and ⌥-clicking it
 * resets every side — the same ⌥-to-normalise gesture the radius link uses.
 */
function CropRows({ peers }: { peers: readonly VisualClip[] }) {
  const clip = peers[0]!;
  const update = useClipUpdater(clip.id);
  const cropping = useSession((s) => s.cropClipId === clip.id);
  const field: Record<Side, Field<number>> = {
    top: useField(peers, "crop.top", (c) => c.crop.top),
    right: useField(peers, "crop.right", (c) => c.crop.right),
    bottom: useField(peers, "crop.bottom", (c) => c.crop.bottom),
    left: useField(peers, "crop.left", (c) => c.crop.left),
  };

  const set = (side: Side) => (v: number) =>
    update(
      "Crop",
      (c) => commitProperty(c, `crop.${side}`, Math.max(0, v), useSession.getState().playheadMs),
      `layer-crop-${side}`,
    );

  const reset = () =>
    update("Reset crop", (c) => {
      const ms = useSession.getState().playheadMs;
      for (const { side } of CROP_SIDES) commitProperty(c, `crop.${side}`, 0, ms);
    });

  return (
    <PropRow
      label="Crop"
      keyControl={<KeyControl clip={clip} property="crop.top" currentValue={() => field.top.value} />}
    >
      <Inline
        trailing={
          // The on-canvas crop handles belong to ONE layer; ⌥-reset is for all.
          <IconToggle
            label={peers.length > 1 ? "⌥-click to reset every crop" : "Crop on canvas — ⌥-click to reset"}
            pressed={cropping}
            onClick={(e) => {
              if (e.altKey) reset();
              else if (peers.length === 1) useSession.getState().setCropClipId(cropping ? null : clip.id);
            }}
          >
            <Crop />
          </IconToggle>
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          {CROP_SIDES.map(({ side, label }) => (
            <NumberInput
              key={side}
              label={<EdgeGlyph side={side} className="size-3" />}
              title={label}
              value={Math.round(field[side].value)}
              mixed={field[side].mixed}
              min={0}
              precision={0}
              onChange={set(side)}
            />
          ))}
        </div>
      </Inline>
    </PropRow>

  );
}
