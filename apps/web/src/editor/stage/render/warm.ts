"use client";

import { type MotionDocument } from "@solomotion/core";
import { warmImages } from "./media-cache";
import { warmSurfaces } from "../../drawing/raster-store";
import { loadWorldEngine } from "../../world/loader";

/**
 * Kick the decodes a freshly-opened document needs, ONCE per document.
 *
 * Images and raster surfaces stream in lazily, so the first draw of a clip
 * that was never on screen paints blank and self-heals only on the next pass.
 * Warming them when the document appears costs one decode each and removes
 * that flash.
 *
 * Video is deliberately NOT warmed. There used to be an idle look-ahead loop
 * here that walked the whole comp while paused, seeking every video element
 * across its file to bank cache cells. It is gone, and it should not come
 * back, for two reasons:
 *
 *  - It could never pay. `resolvePicture` returns the LIVE element for every
 *    rolling-forward frame by design, so forward playback never reads a cached
 *    cell. The cells that ARE read — scrub revisits, reverse playback, timeline
 *    posters — are already banked for free by the passive tiers (rolling proxy
 *    capture off frames the decoder was presenting anyway, plus a capture on
 *    every scrub settle). It spent decode, GPU and cache budget on a paused
 *    editor for a hit rate near zero.
 *  - It was the only thing that made a PAUSED element wander, and every
 *    "two owners of one currentTime" bug this pipeline has ever had traces
 *    back to that. A paused editor is now quiescent: no seeks, no captures,
 *    no invalidations, nothing to revalidate.
 *
 * The one background job left is the explicit, user-asked-for "Cache clip now"
 * (`cacheClipFootprint`), which owns its element through `VideoEntry.borrowed`.
 */
let warmedDoc: MotionDocument | null = null;

export function warmDocument(doc: MotionDocument): void {
  if (doc === warmedDoc) return;
  warmedDoc = doc;
  warmImages(doc);
  warmSurfaces(doc);
  // A project with a 3D world starts fetching the engine now, so its board
  // picture is there by the time anyone looks.
  if (doc.frames.some((f) => f.world)) void loadWorldEngine().catch(() => {});
}
