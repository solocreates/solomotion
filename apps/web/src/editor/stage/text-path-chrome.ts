"use client";

import {
  basisOfTransform,
  clipBox,
  hostContour,
  hostLocalTime,
  hostPolylinesAt,
  isPathHost,
  isPathText,
  locateClip,
  mapLocal,
  nearestOnOutline,
  offsetForArcLength,
  pathAnchorPose,
  pathHostOf,
  sampleKeyframes,
  sampledTransform,
  unmapLocal,
  type MotionDocument,
  type LayerBasis,
  type OutlineHit,
  type PathHostClip,
  type PathTextClip,
  type Polyline,
  type TextClip,
  type Transform,
  type Vec2,
} from "@solomotion/core";
import { peekDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { resolvedDocAt } from "@solomotion/core";
import { activeCompId } from "../timeline/timeline-utils";
import { layerSpace, type EditSpace } from "./edit-space";
import { sampledPathSpec } from "./render/text-on-path";
import type { ClipHitRect } from "./render/draw-frame";

/**
 * TEXT ON A PATH — the stage's chrome, headless: which outline is under the
 * text tool, where a bound text's grip sits, and where a drag along the curve
 * lands. The canvas draws what these return; the gesture writes what they
 * compute. Nothing here paints or listens.
 *
 * Every mapping goes through ONE space: a host's outline is authored in its
 * own local coordinates, so the pointer is taken there (`HostSpace.toLocal`)
 * and answers come back out (`toWorld`). The space is built from the RESOLVED
 * document, so a host that is itself a member of a laid-out row is where the
 * row put it, not where its stored x/y says.
 */

/** A host's local space ⇄ world, at the playhead. */
export interface HostSpace {
  host: PathHostClip;
  space: EditSpace;
  pose: Transform;
  basis: LayerBasis;
  polylines: Polyline[];
  toLocal(world: Vec2): Vec2;
  toWorld(local: Vec2): Vec2;
  /** Host-local → canvas px, for drawing chrome on the overlay. */
  toScreen(local: Vec2): Vec2;
  /** Local units per screen px, along the host's (mean) scale. */
  pxToLocal: number;
}

/** The document every stage answer about a relation reads — resolved at the playhead. */
export function stageDoc(): MotionDocument | null {
  const raw = peekDoc();
  if (!raw) return null;
  const s = useSession.getState();
  return resolvedDocAt(raw, s.playheadMs, activeCompId(raw, s.activeFrameId));
}

export function hostSpaceOf(hostId: string, doc: MotionDocument | null = stageDoc()): HostSpace | null {
  if (!doc) return null;
  const host = locateClip(doc, hostId)?.clip;
  if (!isPathHost(host)) return null;
  const space = layerSpace(host.id, doc);
  if (!space) return null;
  const playhead = useSession.getState().playheadMs;
  const localMs = hostLocalTime(host, playhead);
  const pose = sampledTransform(host, localMs);
  const basis = basisOfTransform(pose, clipBox(doc, host));
  const meanScale = (Math.abs(basis.scale) + Math.abs(basis.scaleY)) / 2 || 1;
  return {
    host,
    space,
    pose,
    basis,
    polylines: hostPolylinesAt(host, localMs),
    toLocal: (world) => {
      const fl = space.fromWorld(world);
      return unmapLocal(fl.x - pose.x, fl.y - pose.y, basis);
    },
    toWorld: (local) => {
      const d = mapLocal(local.x, local.y, basis);
      return space.toWorld({ x: pose.x + d.x, y: pose.y + d.y });
    },
    toScreen: (local) => {
      const d = mapLocal(local.x, local.y, basis);
      return space.toScreen({ x: pose.x + d.x, y: pose.y + d.y });
    },
    pxToLocal: space.pxToLocal / meanScale,
  };
}

/** What the text tool found under the pointer: a host, its outline hit, and the space. */
export interface OutlineTarget {
  hostSpace: HostSpace;
  hit: OutlineHit;
}

/**
 * The outline under the pointer, within `tolerancePx`, among the layers the
 * renderer painted this frame — nearest wins. Uses the painted hit rects as a
 * cheap first pass so a comp of two hundred shapes costs two hundred rectangle
 * tests and a handful of real distance queries.
 */
export function outlineUnderPointer(
  world: Vec2,
  hitRects: readonly ClipHitRect[],
  tolerancePx: number,
  viewScale: number,
): OutlineTarget | null {
  const doc = stageDoc();
  if (!doc) return null;
  const tolWorld = tolerancePx / Math.max(1e-6, viewScale);
  let best: OutlineTarget | null = null;
  let bestPx = Infinity;
  // Topmost painted last → walk backwards so ties go to the layer on top.
  for (let i = hitRects.length - 1; i >= 0; i--) {
    const r = hitRects[i]!;
    // Reject by the rect's circumscribed circle, grown by the tolerance.
    const reach = Math.hypot(r.width, r.height) / 2 + tolWorld;
    if (Math.hypot(world.x - r.cx, world.y - r.cy) > reach) continue;
    const clip = locateClip(doc, r.clipId)?.clip;
    if (!isPathHost(clip)) continue;
    const hs = hostSpaceOf(clip.id, doc);
    if (!hs) continue;
    const hit = nearestOnOutline(hs.polylines, hs.toLocal(world));
    if (!hit) continue;
    // Compare in screen px so a scaled-down host is as easy to catch as a big one.
    const px = hit.dist / hs.pxToLocal;
    if (px <= tolerancePx && px < bestPx) {
      best = { hostSpace: hs, hit };
      bestPx = px;
    }
  }
  return best;
}

/** The bound text's ride, resolved: its host space and the contour it sits on. */
export function pathTextRide(clip: TextClip, doc: MotionDocument | null = stageDoc()): { hs: HostSpace; pl: Polyline; text: PathTextClip } | null {
  if (!isPathText(clip) || !doc) return null;
  const host = pathHostOf(doc, clip);
  if (!host) return null;
  const hs = hostSpaceOf(host.id, doc);
  if (!hs) return null;
  const pl = hostContour(hs.polylines, clip.path.contour);
  return pl ? { hs, pl, text: clip } : null;
}

/** Where the grip sits on screen: the run's anchor point on the curve, and its tangent. */
export function pathTextGrip(clip: TextClip, doc: MotionDocument | null = stageDoc()): { local: Vec2; world: Vec2; angle: number; ride: NonNullable<ReturnType<typeof pathTextRide>> } | null {
  const ride = pathTextRide(clip, doc);
  if (!ride) return null;
  const s = useSession.getState();
  const localMs = Math.max(0, Math.min(clip.durationMs, s.playheadMs - clip.startMs));
  const kf = sampleKeyframes(clip.keyframes, localMs);
  const spec = sampledPathSpec(ride.text, kf);
  const anchor = pathAnchorPose(ride.pl, spec);
  const world = ride.hs.toWorld(anchor);
  // The tangent's screen angle: map a unit step along it.
  const ahead = ride.hs.toWorld({ x: anchor.x + Math.cos(anchor.angle), y: anchor.y + Math.sin(anchor.angle) });
  return { local: anchor, world, angle: Math.atan2(ahead.y - world.y, ahead.x - world.x), ride };
}

/**
 * The offset (laps) that puts the run's anchor under the pointer — the slide
 * gesture's one line. `near` keeps the answer on the lap the drag began on.
 */
export function offsetUnderPointer(ride: NonNullable<ReturnType<typeof pathTextRide>>, world: Vec2, near: number): number {
  const hit = nearestOnOutline([ride.pl], ride.hs.toLocal(world));
  if (!hit) return near;
  return offsetForArcLength(hit.d, ride.pl.length, near);
}
