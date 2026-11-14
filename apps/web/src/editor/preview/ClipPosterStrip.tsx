"use client";

import * as React from "react";
import { clipPictureRevision, compContentRevision, type MotionDocument, type Clip, type PosterTile } from "@solomotion/core";
import { useDocWhen } from "../state/document-context";
import { posterAt, posterNearest, releasePosterDemand } from "./poster-cache";
import { postersVisibleAt, useClipPoster, useMediaVersion, useOnScreen, usePosterPaint, useStripWindow, type StripWindow } from "./use-poster";

/** What this clip's pictures are drawn from, as one string (the poster store's own revision rule). */
function stripRevision(doc: MotionDocument, clip: Clip): string {
  if (clip.kind === "nested") return compContentRevision(doc, clip.sourceFrameId);
  if (clip.kind === "image" || clip.kind === "video") return "";
  return clipPictureRevision(doc, clip.id);
}

/**
 * A clip's pictures, painted into the clip body on the timeline.
 *
 * ONE canvas per clip, not one element per tile: a wide clip at a deep zoom can
 * carry dozens of tiles, and dozens of DOM nodes per clip across dozens of
 * clips is how a timeline stops scrolling smoothly. The canvas repaints only
 * when its inputs change — the plan, the store's version, or its own size —
 * and playback changes none of those, so the performance contract ("playback
 * never re-renders React") holds without this component knowing about
 * playback at all.
 *
 * What it draws, in one pass per tile:
 *  - the picture, COVER-fitted into the tile so faces are not letterboxed;
 *  - a slight dim over a HELD stretch, so the frozen tail of a clip dragged
 *    past the end of its media is visible instead of silently identical.
 *
 * And nothing else. Frames butt against each other with no rule between them,
 * because being different pictures is already what separates them; the loop
 * boundaries and the media run-out are drawn once by the clip's own chrome
 * (`SourceCycleMarks`), which is also what keeps them visible when previews
 * are switched off.
 *
 * Tiles with no picture yet are simply skipped: the clip's own colour shows
 * through and fills in as pictures arrive, which reads as loading. A grid of
 * grey placeholder boxes would read as breakage.
 *
 * The canvas spans only the WINDOW (`useStripWindow`) — the part of the clip on
 * screen, padded — never the whole clip: a 35 s clip at a deep zoom is a
 * canvas tens of thousands of pixels wide, and every tile outside the screen
 * is a render nobody asked for. Each paint re-declares exactly the pictures it
 * still needs (`releasePosterDemand` then `posterAt`), so a strip that leaves
 * the screen or unmounts withdraws its work instead of leaving it queued.
 */
export function ClipPosterStrip({
  clip,
  pxPerSec,
  heightPx,
}: {
  clip: Clip;
  pxPerSec: number;
  /** The lane's rendered height — the poster tier and the visibility floor. */
  heightPx: number;
}) {
  // A strip re-renders when its PICTURE can have changed — the revision the
  // poster store keys it by — or the comps and media its plan reads. Not when a
  // neighbouring layer moves: that was every strip, on every drag move.
  const doc = useDocWhen((d) => [d.frames, d.assets, postersVisibleAt(heightPx) ? stripRevision(d, clip) : ""]);
  const mediaVersion = useMediaVersion();
  const [hostRef, onScreen] = useOnScreen<HTMLDivElement>();
  const stripWindow = useStripWindow(clip.startMs, clip.durationMs, pxPerSec);
  const plan = useClipPoster(doc, clip, pxPerSec, heightPx, mediaVersion, onScreen ? stripWindow : null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  // This strip's identity as a DEMANDER of pictures.
  const owner = React.useRef({}).current;
  React.useEffect(() => () => releasePosterDemand(owner), [owner]);

  // Repaints ride the store's own signal, not React state: a hundred pictures
  // landing repaints a hundred canvases and re-renders nothing.
  usePosterPaint(() => {
    releasePosterDemand(owner);
    const canvas = canvasRef.current;
    if (!canvas || !plan || !stripWindow) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    paintStrip(ctx, canvas, {
      doc,
      clip,
      tiles: plan.tiles,
      source: plan.source,
      window: stripWindow,
      heightPx,
      pxPerSec,
      owner,
    });
  }, [doc, clip, plan, stripWindow, heightPx, pxPerSec]);

  // The host div always mounts: it is what the intersection observer watches,
  // so a clip scrolling into view can be noticed at all.
  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0 overflow-hidden rounded-md" aria-hidden>
      {plan && stripWindow && (
        <canvas
          ref={canvasRef}
          className="absolute inset-y-0 h-full"
          style={{ opacity: 0.55, left: stripWindow.fromPx, width: stripWindow.toPx - stripWindow.fromPx }}
        />
      )}
    </div>
  );
}

interface PaintInput {
  doc: MotionDocument;
  clip: Clip;
  tiles: PosterTile[];
  source: NonNullable<ReturnType<typeof useClipPoster>>["source"];
  /** The span of the clip this canvas covers, in clip-local px. */
  window: StripWindow;
  heightPx: number;
  pxPerSec: number;
  owner: object;
}

function paintStrip(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  input: PaintInput,
): void {
  const { doc, clip, tiles, source, window: win, heightPx, pxPerSec, owner } = input;
  const widthPx = Math.max(1, win.toPx - win.fromPx);
  const dpr = Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  const backingW = Math.max(1, Math.round(widthPx * dpr));
  const backingH = Math.max(1, Math.round(heightPx * dpr));
  if (canvas.width !== backingW) canvas.width = backingW;
  if (canvas.height !== backingH) canvas.height = backingH;
  // Clip-local px → this canvas: it starts at the window's left edge.
  ctx.setTransform(dpr, 0, 0, dpr, -win.fromPx * dpr, 0);
  ctx.clearRect(win.fromPx, 0, widthPx, heightPx);

  const pxPerMs = pxPerSec / 1000;
  for (const tile of tiles) {
    const x = tile.startMs * pxPerMs;
    const w = Math.max(1, (tile.endMs - tile.startMs) * pxPerMs);
    const req = { doc, clip, source, sourceMs: tile.sourceMs, heightPx };
    // Its own picture, or — while that is being made — the nearest one already
    // made, so a zoom refines the strip instead of blanking it.
    const picture = posterAt(req, owner) ?? posterNearest(req);
    if (picture) {
      // A tile is as wide as its span, which for a still or a held stretch can
      // be the whole clip. Repeat the picture at its natural aspect across the
      // span rather than stretching it: a filmstrip of one frame is what every
      // reference tool shows for a still, and a stretched face is not a face.
      drawCover(ctx, picture, x, w, heightPx);
    }
    // No divider between tiles, deliberately. A filmstrip's frames are already
    // separated by the only thing that should separate them — being different
    // pictures — and ruling a line between them turns a continuous band of
    // footage into a row of stamps. The structure a user actually cannot see
    // from the pixels (where a loop repeats, where the media runs out) is drawn
    // ONCE by the clip's own chrome, not per tile.
    if (tile.held) {
      // The source has run out and this stretch is one frozen picture. Dimmed
      // rather than labelled: the clip already says how long it is, and the
      // question a user has here is "is anything still happening".
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x, 0, w, heightPx);
    }
  }
}

/**
 * Draw `picture` across a span, COVER-fitted and repeated.
 *
 * Cover rather than contain because a poster is a recognition aid: filling the
 * lane height and cropping the sides is how a face stays a face at 48px.
 * Repeating rather than stretching because a tile's WIDTH is a duration, not a
 * shape — a still image's tile spans its whole clip, and stretching one frame
 * across ten seconds of timeline is a smear, not a preview.
 */
function drawCover(
  ctx: CanvasRenderingContext2D,
  picture: ImageBitmap,
  x: number,
  spanW: number,
  h: number,
): void {
  const tileW = Math.max(1, (picture.width / picture.height) * h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, 0, spanW, h);
  ctx.clip();
  for (let dx = 0; dx < spanW; dx += tileW) {
    ctx.drawImage(picture, x + dx, 0, tileW, h);
  }
  ctx.restore();
}
