"use client";

import { cursors } from "@solomotion/ui/cursors";
import * as React from "react";
import {
  apply,
  compToSource,
  contourAtPose,
  isTrackAnchor,
  pathCommands,
  poseOf,
  posePoint,
  sampleTracker,
  unposePoint,
  type MotionDocument,
  type DocumentStore,
  type RegionPose,
  type TrackChannel,
  type Tracker,
  type RegionTracker,
  type CameraTracker,
  type DepthTracker,
  cameraPlatePoints,
  readDepthFrame,
} from "@solomotion/core";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useStageCamera, useParkedPlayhead, useTransportRunning } from "../state/session";
import { useTrackRuns } from "../tracking/track-runs";
import { pinTrackAt, startTrack, trackedClipOf, trackViewAt } from "../tracking/track-controller";
import { usePickMode } from "../pick/pick-mode";
import { capturePointer } from "../input/capture-pointer";
import { claimPointer, subscribePointerEnd } from "../input/pointer-gestures";
import { frameSpace } from "./edit-space";
import { useCameraPoints } from "../tracking/camera-points";
import { useDepthView } from "../tracking/depth-controller";
import { useDepthStoreVersion } from "../tracking/depth-store";

const EMPTY_POINTS: number[] = [];

/**
 * THE TRACKERS ON STAGE — the outlines you actually see and drag.
 *
 * Which ones are drawn is a question of what you are doing, answered once:
 *
 *   the Track tab on footage   every tracker of that footage, each in its own
 *                              colour, named; click one to make it the active one
 *   picking a tracker          every tracker on screen, as pick targets (the
 *                              path carries `data-pick-key`, so the pick mode
 *                              needs no stage code to find it)
 *   a run in progress          that tracker, riding its latest measurement
 *   otherwise                  the active tracker, or the one the selection is
 *                              about (the footage it was drawn on, a follower)
 *
 * The ACTIVE one gets the rig and a motion trail coloured by confidence:
 *
 *   drag the body      pins POSITION at this frame
 *   drag a corner      pins SCALE (⇧ frees the aspect)
 *   drag the dial      pins ROTATION
 *   drag a vertex      pins SHAPE — the outline itself, this frame only
 *
 * Every one is a per-CHANNEL pin, so fixing where it is leaves the solver free
 * to keep measuring how big it is. Letting go RE-SOLVES THE NEIGHBOURHOOD —
 * the frames between the anchors either side of the fix — so one correction
 * repairs the run around it instead of one frame (`tracking/run.ts`, `around`).
 */

type Grab =
  | { kind: "body" }
  | { kind: "scale"; corner: 0 | 1 | 2 | 3 }
  | { kind: "rotate" }
  | { kind: "vertex"; sub: number; index: number };

type Role = "edit" | "live" | "show" | "pick";

const HANDLE_R = 5;
/** How far the trail reaches either side of now, source ms. */
const TRAIL_MS = 1500;

export function TrackOverlay() {
  const doc = useDoc();
  const store = useDocStore();
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const activeTrackerId = useSession((s) => s.activeTrackerId);
  const trackTab = useSession((s) => s.inspectorTab === "track");
  const picking = usePickMode((s) => !!s.request?.filter.kinds.includes("tracker"));
  const runs = useTrackRuns((s) => s.runs);
  const playheadMs = useParkedPlayhead();
  // An editing overlay is for a still frame: the canvas draws the motion.
  const playing = useTransportRunning();
  const view = useStageCamera();
  const showDepth = useDepthView((s) => s.show);

  const shown = React.useMemo(() => {
    const out = new Map<string, Role>();
    const add = (t: Tracker | undefined, role: Role) => {
      if (t && !out.has(t.id)) out.set(t.id, role);
    };
    const byId = (id: string | null) => (id ? doc.trackers.find((t) => t.id === id) : undefined);
    for (const id of Object.keys(runs)) add(byId(id), "live");
    if (picking) for (const t of doc.trackers) add(t, "pick");
    add(byId(activeTrackerId), "edit");
    const sel = new Set(selectedClipIds);
    const selected = doc.tracks.flatMap((tr) => tr.clips).filter((c) => sel.has(c.id));
    if (trackTab) {
      const assets = new Set(selected.flatMap((c) => (c.kind === "video" || c.kind === "image" ? [c.assetId] : [])));
      for (const t of doc.trackers) if (assets.has(t.source.assetId)) add(t, "show");
    }
    if (out.size === 0) {
      for (const t of doc.trackers) if (t.via && sel.has(t.via)) add(t, "show");
      for (const c of selected) if ("trackBinding" in c && c.trackBinding) add(byId(c.trackBinding.trackerId), "show");
    }
    return [...out];
  }, [doc, selectedClipIds, activeTrackerId, trackTab, picking, runs]);

  if (playing || shown.length === 0) return null;
  return (
    <svg className="absolute inset-0 h-full w-full" style={{ pointerEvents: "none" }}>
      {shown.map(([id, role]) => {
        const tracker = doc.trackers.find((t) => t.id === id)!;
        if (tracker.kind === "depth") return showDepth && role === "edit" ? <DepthPreview key={id} doc={doc} tracker={tracker} playheadMs={playheadMs} view={view} /> : null;
        if (tracker.kind === "camera") return <CameraPoints key={id} doc={doc} tracker={tracker} playheadMs={playheadMs} view={view} pickable={trackTab && (role === "edit" || role === "show")} />;
        return <TrackerShape key={id} doc={doc} store={store} tracker={tracker} role={role} active={id === activeTrackerId} playheadMs={playheadMs} view={view} live={runs[id]?.live ?? null} />;
      })}
    </svg>
  );
}

/**
 * A CAMERA SOLVE ON THE PLATE — its points, projected through the solved
 * camera at this frame onto the footage. Where a dot sits on the feature it
 * came from, the solve agrees with the picture; dots that slide off are where
 * it does not (After Effects' track points, read the same way).
 */
/**
 * A DEPTH MAP OVER ITS FOOTAGE — near is light, far is dark — laid on the
 * plate through the same placement the overlay maps a track through, so you
 * see exactly what Fog, Lens blur and Behind will read.
 */
function DepthPreview({ doc, tracker, playheadMs, view }: { doc: MotionDocument; tracker: DepthTracker; playheadMs: number; view: { tx: number; ty: number; scale: number } }) {
  const navPath = useSession((s) => s.nav.path);
  useDepthStoreVersion();
  const tracked = trackedClipOf(doc, tracker);
  const frame = tracked ? doc.frames.find((f) => f.id === tracked.frameId) : null;
  const footage = trackViewAt(doc, tracker, playheadMs);
  const map = footage ? readDepthFrame(tracker, footage.sourceMs) : null;
  const href = React.useMemo(() => {
    if (!map) return null;
    const c = document.createElement("canvas");
    c.width = map.width;
    c.height = map.height;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(map.width, map.height);
    for (let i = 0; i < map.data.length; i++) {
      const g = map.data[i]! >> 8;
      img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = g;
      img.data[4 * i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }, [map]);
  const asset = tracked && (tracked.kind === "video" || tracked.kind === "image") ? doc.assets.find((a) => a.id === tracked.assetId) : null;
  if (!tracked || !frame || !footage || !map || !href || !asset?.width || !asset.height) return null;
  const space = frameSpace(frame.id, doc, { path: navPath, playheadMs });
  const toScreen = (src: { x: number; y: number }) => {
    const fp = apply(footage.toComp, src);
    const world = space ? space.toWorld(fp) : { x: frame.x + frame.width / 2 + fp.x, y: frame.y + frame.height / 2 + fp.y };
    return { x: view.tx + world.x * view.scale, y: view.ty + world.y * view.scale };
  };
  // Map px → screen as one affine, from three points.
  const kx = asset.width / map.width;
  const ky = asset.height / map.height;
  const o = toScreen({ x: 0, y: 0 });
  const ex = toScreen({ x: kx, y: 0 });
  const ey = toScreen({ x: 0, y: ky });
  return (
    <image
      href={href}
      width={map.width}
      height={map.height}
      opacity={0.92}
      preserveAspectRatio="none"
      transform={`matrix(${ex.x - o.x} ${ex.y - o.y} ${ey.x - o.x} ${ey.y - o.y} ${o.x} ${o.y})`}
      style={{ imageRendering: "auto" }}
    />
  );
}

function CameraPoints({
  doc,
  tracker,
  playheadMs,
  view,
  pickable,
}: {
  doc: MotionDocument;
  tracker: CameraTracker;
  playheadMs: number;
  view: { tx: number; ty: number; scale: number };
  pickable: boolean;
}) {
  const navPath = useSession((s) => s.nav.path);
  const picked = useCameraPoints((s) => (s.trackerId === tracker.id ? s.points : EMPTY_POINTS));
  const tracked = trackedClipOf(doc, tracker);
  const frame = tracked ? doc.frames.find((f) => f.id === tracked.frameId) : null;
  const footage = trackViewAt(doc, tracker, playheadMs);
  const s = tracker.solution;
  if (!tracked || !frame || !footage || !s) return null;
  const space = frameSpace(frame.id, doc, { path: navPath, playheadMs });
  const dots = cameraPlatePoints(tracker, footage.sourceMs);
  const on = new Set(picked);
  return (
    <g>
      {dots.map((p) => {
        const fp = apply(footage.toComp, p);
        const world = space ? space.toWorld(fp) : { x: frame.x + frame.width / 2 + fp.x, y: frame.y + frame.height / 2 + fp.y };
        const cx = view.tx + world.x * view.scale;
        const cy = view.ty + world.y * view.scale;
        const sel = on.has(p.index);
        return (
          <g key={p.index}>
            {pickable && (
              // A wider invisible target than the dot: a 4 px dot is not a target.
              <circle
                cx={cx}
                cy={cy}
                r={7}
                fill="transparent"
                style={{ pointerEvents: "auto", cursor: cursors.pointer }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  useSession.getState().setActiveTracker(tracker.id);
                  useCameraPoints.getState().toggle(tracker.id, p.index, e.shiftKey || e.metaKey);
                }}
              />
            )}
            <circle cx={cx} cy={cy} r={sel ? 4 : 2.2} fill={sel ? "#ffffff" : tracker.color} fillOpacity={0.92} stroke={sel ? tracker.color : "rgba(0,0,0,0.55)"} strokeWidth={sel ? 2 : 0.75} style={{ pointerEvents: "none" }} />
          </g>
        );
      })}
    </g>
  );
}

function TrackerShape({
  doc,
  store,
  tracker,
  role,
  active,
  playheadMs,
  view,
  live,
}: {
  doc: MotionDocument;
  store: DocumentStore;
  tracker: RegionTracker;
  role: Role;
  active: boolean;
  playheadMs: number;
  view: { tx: number; ty: number; scale: number };
  live: { x: number; y: number; scale: number; rotation: number } | null;
}) {
  const navPath = useSession((s) => s.nav.path);
  const ref = React.useRef<SVGGElement>(null);
  const [grab, setGrab] = React.useState<Grab | null>(null);
  // The gesture's truth lives in a ref: a release must know a drag happened
  // even when a state update from elsewhere landed first.
  const grabRef = React.useRef<Grab | null>(null);
  const startRef = React.useRef<{ pose: RegionPose; frame: { x: number; y: number }; pinned?: boolean } | null>(null);
  const setGesture = (g: Grab | null) => {
    grabRef.current = g;
    setGrab(g);
  };
  // A pointer that is LOST (a portal, a blur, a second finger) aborts; a
  // normal release is the release handler's, which re-solves around the fix.
  React.useEffect(
    () =>
      subscribePointerEnd((_id, reason) => {
        if (reason === "up") return;
        grabRef.current = null;
        startRef.current = null;
        setGrab(null);
      }),
    [],
  );

  const tracked = trackedClipOf(doc, tracker);
  const frame = tracked ? doc.frames.find((f) => f.id === tracked.frameId) : null;
  const footage = trackViewAt(doc, tracker, playheadMs);
  if (!tracked || !frame || !footage) return null;

  const sample = sampleTracker(tracker, footage.sourceMs);
  const base: RegionPose = sample ? poseOf(sample) : { x: 0, y: 0, scale: 1, scaleY: null, rotation: 0, warp: null };
  const pose: RegionPose = role === "live" && live ? { ...base, x: live.x, y: live.y, scale: live.scale, rotation: live.rotation, warp: null } : base;
  const editable = role === "edit" || (active && role === "show");
  const pinnedHere = sample != null && isTrackAnchor(sample) && Math.abs(sample.timeMs - footage.sourceMs) < 1;
  const color = tracker.color;

  // source px → frame-centre → world → screen. The frame-centre→world leg is
  // the frame's own chain, never its page x/y: a tracked clip inside a nested
  // comp is painted through the instance, not at the source frame's shelf slot.
  const space = frameSpace(frame.id, doc, { path: navPath, playheadMs });
  const toScreen = (src: { x: number; y: number }) => {
    const fp = apply(footage.toComp, src);
    const world = space ? space.toWorld(fp) : { x: frame.x + frame.width / 2 + fp.x, y: frame.y + frame.height / 2 + fp.y };
    return { x: view.tx + world.x * view.scale, y: view.ty + world.y * view.scale };
  };
  const fmt = (p: { x: number; y: number }) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;

  const contours = contourAtPose(tracker.region, pose);
  const d = pathCommands(contours)
    .map((c) =>
      c.type === "M" || c.type === "L"
        ? `${c.type}${fmt(toScreen(c))}`
        : c.type === "C"
          ? `C${fmt(toScreen({ x: c.x1, y: c.y1 }))} ${fmt(toScreen({ x: c.x2, y: c.y2 }))} ${fmt(toScreen(c))}`
          : "Z",
    )
    .join(" ");
  const centre = toScreen({ x: pose.x, y: pose.y });

  // The rig's corners come from the region's LOCAL bounds through the pose, so
  // they sit on the shape however it is rotated.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sub of tracker.region.subpaths)
    for (const p of sub.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  const posed = (p: { x: number; y: number }) => toScreen(posePoint(p, pose));
  const corners = Number.isFinite(minX) ? [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }].map(posed) : [];
  const dial = Number.isFinite(minY) ? posed({ x: 0, y: minY * 1.35 }) : centre;
  // Too small on screen for handles: they would bury the very thing you are
  // looking at. The body still drags; zoom in for scale and rotation.
  const onScreen = corners.length ? Math.max(Math.hypot(corners[1]!.x - corners[0]!.x, corners[1]!.y - corners[0]!.y), Math.hypot(corners[3]!.x - corners[0]!.x, corners[3]!.y - corners[0]!.y)) : 0;
  const rig = editable && onScreen >= 32;
  const labelAt = corners.length ? corners.reduce((a, b) => (b.y < a.y ? b : a)) : centre;

  /** A screen point back into the footage's source pixels. */
  const toSource = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = (ref.current?.ownerSVGElement ?? ref.current)!.getBoundingClientRect();
    const w = { x: (e.clientX - rect.left - view.tx) / view.scale, y: (e.clientY - rect.top - view.ty) / view.scale };
    const fp = space ? space.fromWorld(w) : { x: w.x - (frame.x + frame.width / 2), y: w.y - (frame.y + frame.height / 2) };
    return compToSource(footage, fp);
  };

  const begin = (e: React.PointerEvent, g: Grab) => {
    e.stopPropagation();
    e.preventDefault();
    // Stationary-first: the press IS the commitment, so claim it now or the
    // app-wide long press opens a context menu on top of the drag.
    claimPointer(e.pointerId, "drag");
    capturePointer(e.target as Element, e.pointerId);
    startRef.current = { pose, frame: toSource(e) };
    setGesture(g);
  };

  const move = (e: React.PointerEvent) => {
    const grab = grabRef.current;
    if (!grab || !startRef.current) return;
    const start = startRef.current;
    const now = toSource(e);
    const mergeKey = `track-pin-${tracker.id}-${grab.kind}`;
    const pin = (channels: TrackChannel[], patch: Parameters<typeof pinTrackAt>[4]) => {
      start.pinned = true;
      pinTrackAt(store, tracker.id, playheadMs, channels, patch, mergeKey);
    };
    if (grab.kind === "body") return pin(["position"], { x: start.pose.x + (now.x - start.frame.x), y: start.pose.y + (now.y - start.frame.y) });
    if (grab.kind === "scale") {
      const d0 = Math.hypot(start.frame.x - start.pose.x, start.frame.y - start.pose.y);
      const d1 = Math.hypot(now.x - start.pose.x, now.y - start.pose.y);
      if (d0 < 1) return;
      const k = Math.max(0.05, d1 / d0);
      // ⇧ frees the aspect — a subject wide but not tall (a car, a sign) is the
      // case a uniform-only region can never fit.
      if (e.shiftKey) {
        const sy = start.pose.scaleY ?? start.pose.scale;
        const kx = Math.abs(now.x - start.pose.x) / Math.max(1, Math.abs(start.frame.x - start.pose.x));
        const ky = Math.abs(now.y - start.pose.y) / Math.max(1, Math.abs(start.frame.y - start.pose.y));
        return pin(["scale"], { scale: start.pose.scale * kx, scaleY: sy * ky });
      }
      return pin(["scale"], { scale: start.pose.scale * k, scaleY: start.pose.scaleY == null ? null : start.pose.scaleY * k });
    }
    if (grab.kind === "rotate") {
      const a0 = Math.atan2(start.frame.y - start.pose.y, start.frame.x - start.pose.x);
      const a1 = Math.atan2(now.y - start.pose.y, now.x - start.pose.x);
      return pin(["rotation"], { rotation: start.pose.rotation + ((a1 - a0) * 180) / Math.PI });
    }
    // A vertex moves in REGION-LOCAL space, so the nudge survives a later
    // scale change instead of being the wrong size the moment the object nears.
    const before = unposePoint(start.frame, start.pose);
    const after = unposePoint(now, start.pose);
    const flat = tracker.region.subpaths.flatMap((s, si) => s.points.map((_, pi) => ({ si, pi })));
    const at = flat.findIndex((v) => v.si === grab.sub && v.pi === grab.index);
    if (at < 0) return;
    const warp = flat.map((_, i) => {
      const w = start.pose.warp?.[i] ?? { x: 0, y: 0 };
      return i === at ? { x: w.x + (after.x - before.x), y: w.y + (after.y - before.y) } : w;
    });
    pin(["shape"], { warp });
  };

  const end = (e: React.PointerEvent) => {
    // A press that moved nothing pinned nothing — no re-solve for a click.
    const corrected = grabRef.current !== null && !!startRef.current?.pinned;
    setGesture(null);
    startRef.current = null;
    // Released already (a cancelled touch, a lost capture) is not an error.
    const el = e.target as Element;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    // The fix becomes an anchor; the frames around it re-solve onto it.
    if (corrected && tracker.analysis?.coverage.length) void startTrack(store, tracker.id, { kind: "around", ms: footage.sourceMs });
  };

  const handleProps = (g: Grab) => ({
    style: { pointerEvents: "auto" as const, cursor: grab ? cursors.grabbing : cursors.grab },
    onPointerDown: (e: React.PointerEvent) => begin(e, g),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  });

  // Not the active one: a click makes it so (the Track tab's list, on the canvas).
  const activate =
    role === "show" && !active
      ? {
          style: { pointerEvents: "auto" as const, cursor: cursors.pointer },
          onPointerDown: (e: React.PointerEvent) => {
            e.stopPropagation();
            useSession.getState().setActiveTracker(tracker.id);
          },
        }
      : {};

  return (
    <g ref={ref}>
      {editable && <Trail tracker={tracker} nowMs={footage.sourceMs} toScreen={toScreen} />}
      {/* The outline. Dashed while stale, so "needs re-solving" is a property of
          the thing itself rather than a sentence in a panel. */}
      <path
        d={d}
        fill={color}
        fillOpacity={editable ? 0.1 : role === "pick" ? 0.14 : 0.04}
        stroke={color}
        strokeOpacity={editable || role !== "show" ? 1 : 0.7}
        strokeWidth={editable ? 1.5 : 1.25}
        strokeDasharray={tracker.dirty && role !== "live" ? "5 4" : undefined}
        {...(role === "pick" ? { "data-pick-key": `tracker:${tracker.id}`, style: { pointerEvents: "auto" } } : editable ? handleProps({ kind: "body" }) : activate)}
      />

      {/* Centre crosshair — the point a follower actually rides. */}
      <g stroke={color} strokeWidth={1.5} fill="none" opacity={0.9}>
        <line x1={centre.x - 12} y1={centre.y} x2={centre.x - 4} y2={centre.y} />
        <line x1={centre.x + 4} y1={centre.y} x2={centre.x + 12} y2={centre.y} />
        <line x1={centre.x} y1={centre.y - 12} x2={centre.x} y2={centre.y - 4} />
        <line x1={centre.x} y1={centre.y + 4} x2={centre.x} y2={centre.y + 12} />
      </g>

      {/* A name on every tracker but the one you are editing — on a plate with
          three, colour alone is a legend nobody wrote down. */}
      {!editable && (
        <text x={labelAt.x} y={labelAt.y - 6} fill={color} fontSize={10.5} fontWeight={500} style={{ userSelect: "none", paintOrder: "stroke", stroke: "rgb(0 0 0 / 0.55)", strokeWidth: 3 }}>
          {tracker.name}
        </text>
      )}

      {rig && (
        <>
          {/* Rotation dial, tethered so the reach reads as part of the rig. */}
          <line x1={centre.x} y1={centre.y} x2={dial.x} y2={dial.y} stroke={color} strokeWidth={1} opacity={0.5} />
          <circle cx={dial.x} cy={dial.y} r={HANDLE_R} fill="var(--background)" stroke={color} strokeWidth={1.5} {...handleProps({ kind: "rotate" })} />
          {corners.map((c, i) => (
            <rect key={`c${i}`} x={c.x - HANDLE_R} y={c.y - HANDLE_R} width={HANDLE_R * 2} height={HANDLE_R * 2} fill="var(--background)" stroke={color} strokeWidth={1.5} {...handleProps({ kind: "scale", corner: i as 0 | 1 | 2 | 3 })} />
          ))}
          {/* Vertices only when the solve bends the outline — a rig that offers
              a gesture the solver will overwrite is a lie. */}
          {tracker.solve.channels.includes("shape") &&
            contours.flatMap((c, si) =>
              c.points.map((p, pi) => {
                const s = toScreen(p);
                return <circle key={`v${si}-${pi}`} cx={s.x} cy={s.y} r={HANDLE_R - 1} fill={color} stroke="var(--background)" strokeWidth={1.5} {...handleProps({ kind: "vertex", sub: si, index: pi })} />;
              }),
            )}
        </>
      )}

      {/* A fixed frame is visible on the canvas, not only in a list. */}
      {pinnedHere && role !== "live" && <circle cx={centre.x} cy={centre.y} r={3} fill={color} stroke="var(--background)" strokeWidth={1.5} />}
    </g>
  );
}

/**
 * Where it has been and where it goes, a second and a half each way, each
 * step tinted by how sure the match was — so a shaky stretch is visible before
 * you scrub to it. Drawn through TODAY's placement of the footage, which is
 * what a trail means on a moving plate.
 */
function Trail({ tracker, nowMs, toScreen }: { tracker: RegionTracker; nowMs: number; toScreen: (p: { x: number; y: number }) => { x: number; y: number } }) {
  const near = tracker.samples.filter((s) => Math.abs(s.timeMs - nowMs) <= TRAIL_MS);
  if (near.length < 2) return null;
  const pts = near.map((s) => ({ ...toScreen({ x: s.x, y: s.y }), c: isTrackAnchor(s) ? 1 : s.confidence, ahead: s.timeMs > nowMs }));
  return (
    <g fill="none" strokeWidth={1.5} strokeLinecap="round">
      {pts.slice(1).map((p, i) => {
        const a = pts[i]!;
        const tone = Math.min(a.c, p.c);
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={p.x}
            y2={p.y}
            stroke={tone >= 0.7 ? tracker.color : tone >= 0.45 ? "#FBBF24" : "#F87171"}
            strokeOpacity={p.ahead ? 0.35 : 0.75}
          />
        );
      })}
    </g>
  );
}
