"use client";

import * as React from "react";
import {
  clearContourStyle,
  copySubpaths,
  overlayCount,
  roundableIn,
  setUniformCornerRadius,
  uniformCornerRadius,
  type KeyframeValue,
  type PathClip,
  type ShapeClip,
} from "@solomotion/core";
import { RotateCcw, Spline } from "lucide-react";
import { NumberInput } from "@/components/ui/number-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSession } from "../state/session";
import { commitProperty, useField } from "./animatable";
import { mergeReads, selectValue } from "./merge";
import { ofKind, usePeers } from "./selection-scope";
import { CornerRadiusRows } from "./CornerRadiusRows";
import { Half, PanelSection, PropRow } from "./controls";
import { KeyControl } from "./keyframe-controls";
import { useClipUpdater } from "./use-clip-updater";
import { StickyScopeStrip } from "./ScopeBar";

/**
 * Shape + path inspector. Every animatable field writes through
 * `commitProperty` (record mode / keyed properties get keyframes at the
 * playhead) and DISPLAYS the effective (sampled) value — the app-wide rule.
 * Structural toggles (fill on/off, stroke on/off, align, fill rule) stay
 * plain base writes.
 */

type VectorClip = ShapeClip | PathClip;

function isVector(c: { kind: string }): c is VectorClip {
  return c.kind === "shape" || c.kind === "path";
}

/** Animatable write bound to one clip: path in, keyframe-or-base out. */
function useCommit(clipId: string) {
  const update = useClipUpdater(clipId);
  return React.useCallback(
    (label: string, path: string, v: KeyframeValue, mergeKey?: string) =>
      update(label, (c) => commitProperty(c, path, v, useSession.getState().playheadMs), mergeKey),
    [update],
  );
}

export function VectorInspector({ clip }: { clip: VectorClip }) {
  // Shapes and paths selected together share their paint, not their geometry.
  const peers = usePeers(clip, isVector);
  const same = peers.every((c) => c.kind === clip.kind);
  return (
    <>
      {clip.kind === "path" && peers.length === 1 && <ContourScopeBar clip={clip} />}
      {clip.kind === "shape" && same && <ShapeGeometrySection clip={clip} />}
      {clip.kind === "path" && same && <PathMorphSection clip={clip} />}
      <PaintSection clip={clip} />
    </>
  );
}

/**
 * What the panel below is editing, when it is not the whole layer.
 *
 * Selecting one piece with the pen points the sidebar at that piece: the fields
 * show what it currently looks like — inherited from the layer until you touch
 * something — and any edit becomes an override for that piece alone. Without a
 * line saying so, a colour change that moved one petal and not the others reads
 * as a bug rather than as the feature.
 *
 * The count is derived from the overlay (`overlayCount`), so a piece that
 * overrides nothing cannot advertise a badge, and clearing the last override
 * cannot leave one behind.
 */
function ContourScopeBar({ clip }: { clip: PathClip }) {
  const address = useSession((s) => s.scopeAddress);
  const update = useClipUpdater(clip.id);
  if (address?.kind !== "contour") return null;
  const index = clip.subpaths.findIndex((c) => c.id === address.contourId);
  if (index < 0) return null;
  const count = overlayCount(clip.contourStyles[address.contourId]);

  return (
    <StickyScopeStrip>
      <Spline className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-xs">
        Piece {index + 1}
        <span className="ml-1.5 text-muted-foreground">
          {count > 0 ? `${count} override${count > 1 ? "s" : ""}` : "inherits"}
        </span>
      </span>
      {count > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Follow the layer again"
              onClick={() =>
                update("Follow the layer", (c) => {
                  if (c.kind === "path") clearContourStyle(c, address.contourId);
                })
              }
              className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3"
            >
              <RotateCcw />
            </button>
          </TooltipTrigger>
          <TooltipContent>Follow the layer again</TooltipContent>
        </Tooltip>
      )}
    </StickyScopeStrip>
  );
}

/**
 * Vector morphing: the whole outline is ONE keyframeable value. Key it at two
 * times, edit the points at each — matching structures interpolate
 * point-to-point (record mode keys node edits automatically).
 */
function PathMorphSection({ clip }: { clip: PathClip }) {
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, isPath);
  const points = mergeReads(peers, (c) => c.subpaths.reduce((sum, s) => sum + s.points.length, 0));

  /**
   * Corners, scoped by what you have SELECTED on the canvas. Nothing selected
   * rounds the whole object (Figma's object-level rounding); nodes selected
   * rounds exactly those — no second control, no mode.
   *
   * The row states how many of the scope are actually roundable, because a
   * vertex between two CURVES has no angle to round and quietly doing less than
   * you asked is the version of this feature people distrust.
   */
  const nodeKeys = useSession((s) => s.vectorNodeSelection);
  // Node picks belong to the one path being pen-edited; across a selection the
  // whole outline of each path is the scope.
  const scope = React.useMemo(() => new Set(peers.length > 1 ? [] : nodeKeys), [nodeKeys, peers.length]);
  const roundable = roundableIn(clip.subpaths, scope).length;
  const selectedTotal = scope.size;
  const radius = mergeReads(peers, (c) => uniformCornerRadius(c.subpaths, scope));
  return (
    <PanelSection id="path" title="Path" collapsible={false}>
      {/* The geometry track keys the WHOLE point set — the diamond is the control;
          the row just states the size of what it captures. Everything about how
          morphing works is a tooltip, not a wall of grey text in a 180px column. */}
      <PropRow
        label="Morph"
        hint="Key the shape here, move the points at another time, and the path tweens between them."
        keyControl={
          <KeyControl clip={clip} property="geometry" currentValue={() => copySubpaths(clip.subpaths)} />
        }
      >
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {points.mixed ? "Mixed" : `${points.value} points`}
        </span>
      </PropRow>
      {roundable > 0 && (
        <PropRow
          label="Corners"
          hint={
            selectedTotal > 0
              ? `Rounds the ${roundable} selected corner${roundable === 1 ? "" : "s"} that have an angle to round. Curved nodes have none, so they are skipped.`
              : `Rounds all ${roundable} sharp corners. Select nodes on the canvas to round only those.`
          }
        >
          <Half>
            <NumberInput
              value={radius.value}
              mixed={radius.mixed}
              min={0}
              precision={0}
              unit="px"
              onChange={(v) =>
                update(
                  "Corner radius",
                  (c) => {
                    if (c.kind === "path") setUniformCornerRadius(c.subpaths, v, scope);
                  },
                  "path-corner-radius",
                )
              }
            />
          </Half>
          {/* How many of your selection this will actually move. Silent on the
              object-level case, where "all of them" needs no counting. */}
          {selectedTotal > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {roundable}/{selectedTotal}
            </span>
          )}
        </PropRow>
      )}
    </PanelSection>
  );
}

const isShape = ofKind("shape");
const isPath = ofKind("path");

function ShapeGeometrySection({ clip }: { clip: ShapeClip }) {
  const commit = useCommit(clip.id);
  const peers = usePeers(clip, isShape);
  const width = useField(peers, "width", (c) => c.width);
  const height = useField(peers, "height", (c) => c.height);
  const radius = useField(peers, "radius", (c) => (c.shape !== "rect" ? c.radius : 0));
  const pointCount = useField(peers, "pointCount", (c) => c.pointCount);
  const innerRatio = useField(peers, "innerRatio", (c) => c.innerRatio);
  const arcStart = useField(peers, "arcStartDeg", (c) => c.arcStartDeg);
  const arcSweep = useField(peers, "arcSweepDeg", (c) => c.arcSweepDeg);
  const arcRatio = useField(peers, "arcRatio", (c) => c.arcRatio);
  // The rows below the size belong to ONE kind of shape; a rectangle and a
  // star selected together share only their size.
  const shape = mergeReads(peers, (c) => c.shape);

  const key = (property: string, currentValue: () => number) => (
    <KeyControl clip={clip} property={property} currentValue={currentValue} />
  );

  return (
    <PanelSection id="shape" title="Shape" collapsible={false}>
      <PropRow label="Size" keyControl={key("width", () => width.value)}>
        <div className="grid grid-cols-2 gap-1.5">
          <NumberInput
            label="W"
            value={width.value}
            mixed={width.mixed}
            min={1}
            precision={0}
            onChange={(v) => commit("Resize shape", "width", v, "shape-w")}
          />
          <NumberInput
            label="H"
            value={height.value}
            mixed={height.mixed}
            min={1}
            precision={0}
            onChange={(v) => commit("Resize shape", "height", v, "shape-h")}
          />
        </div>
      </PropRow>

      {shape.mixed ? null : clip.shape === "rect" ? (
        <CornerRadiusRows peers={peers} prefix="radius" read={(c) => c.cornerRadius} />
      ) : clip.shape === "ellipse" ? (
        <>
          <PropRow label="Sweep" keyControl={key("arcSweepDeg", () => arcSweep.value)}>
            <NumberInput
              value={Math.round(arcSweep.value)}
              mixed={arcSweep.mixed}
              min={0}
              max={360}
              precision={0}
              unit="°"
              onChange={(v) => commit("Arc sweep", "arcSweepDeg", v, "shape-sweep")}
            />
          </PropRow>
          <PropRow label="Start" keyControl={key("arcStartDeg", () => arcStart.value)}>
            <NumberInput
              value={Math.round(arcStart.value)}
              mixed={arcStart.mixed}
              precision={0}
              unit="°"
              onChange={(v) => commit("Arc start", "arcStartDeg", v, "shape-start")}
            />
          </PropRow>
          <PropRow label="Ratio" keyControl={key("arcRatio", () => arcRatio.value)}>
            <NumberInput
              value={Math.round(arcRatio.value * 100)}
              mixed={arcRatio.mixed}
              min={0}
              max={99}
              precision={0}
              unit="%"
              onChange={(v) => commit("Arc ratio", "arcRatio", v / 100, "shape-aratio")}
            />
          </PropRow>
        </>
      ) : (
        <>
          <PropRow label="Points" keyControl={key("pointCount", () => pointCount.value)}>
            <NumberInput
              value={pointCount.value}
              mixed={pointCount.mixed}
              min={3}
              max={60}
              precision={0}
              onChange={(v) => commit("Point count", "pointCount", Math.round(v), "shape-pts")}
            />
          </PropRow>
          <PropRow label="Radius" keyControl={key("radius", () => radius.value)}>
            <NumberInput
              value={radius.value}
              mixed={radius.mixed}
              min={0}
              precision={0}
              onChange={(v) => commit("Corner radius", "radius", v, "shape-vr")}
            />
          </PropRow>
          {clip.shape === "star" && (
            <PropRow label="Inner" keyControl={key("innerRatio", () => innerRatio.value)}>
              <NumberInput
                value={Math.round(innerRatio.value * 100)}
                mixed={innerRatio.mixed}
                min={1}
                max={100}
                precision={0}
                unit="%"
                onChange={(v) => commit("Inner ratio", "innerRatio", v / 100, "shape-ir")}
              />
            </PropRow>
          )}
        </>
      )}
    </PanelSection>
  );
}

/**
 * The one thing that belongs to the OUTLINE rather than to any paint: how a
 * self-crossing path decides what is inside it. Fill and Stroke themselves are
 * TAIL sections in the spine, shared with every other paintable kind — they
 * used to be rendered here as well, so a shape and a word put them in two
 * different places on the scroll.
 */
function PaintSection({ clip }: { clip: VectorClip }) {
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, isVector);
  const allPaths = peers.every(isPath);
  const fillRule = mergeReads(peers, (c) => (c.kind === "path" ? c.fillRule : null));

  return (
    <>
      {clip.kind === "path" && allPaths && (
        <PanelSection id="outline" title="Outline">
          <PropRow label="Fill rule" hint="How a self-crossing path decides what counts as inside.">
            <Select
              value={selectValue(fillRule)}
              onValueChange={(v) =>
                update("Fill rule", (c) => {
                  if (c.kind === "path") c.fillRule = v as PathClip["fillRule"];
                })
              }
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue placeholder="Mixed" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nonzero">Non-zero</SelectItem>
                <SelectItem value="evenodd">Even-odd</SelectItem>
              </SelectContent>
            </Select>
          </PropRow>
        </PanelSection>
      )}
    </>
  );
}
