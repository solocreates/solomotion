"use client";

import type { MotionDocument } from "@solomotion/core";
import { releaseSurfacesNotIn } from "../drawing/raster-store";
import { dropBoardPictures } from "../stage/render/board-pictures";
import { releaseMediaNotIn } from "../stage/render/media-cache";
import { purgeAllCaches } from "./cache-status";

/**
 * WHAT IS ON SCREEN IS WHAT IS HELD.
 *
 * The caches under the memory budget evict by LRU, which is right while you
 * work and wrong the moment you stop: close a project and its composites,
 * layer pixels and footage frames sat at their ceiling — two gigabytes by
 * default — until something else happened to need the room. The pictures they
 * are made FROM were worse: decoded stills, every frame of a GIF, video
 * elements and drawing surfaces are not budgeted at all, and nothing ever let
 * them go. Home with no project open could hold gigabytes for projects nobody
 * was looking at.
 *
 * So "what is on screen" is stated in one place — the loaded project plus any
 * preview a surface is holding (a Home card playing on hover) — and two
 * moments act on it:
 *  · the loaded project CHANGED or closed: every budgeted cache belonged to
 *    the old one, so it all goes, along with any source picture nothing on
 *    screen uses;
 *  · a preview ENDED: only its source pictures go — the loaded project's
 *    caches are still the right ones.
 */

let loaded: () => MotionDocument | null = () => null;
const previews = new Set<MotionDocument>();

function onScreen(): MotionDocument[] {
  const doc = loaded();
  return doc ? [doc, ...previews] : [...previews];
}

function sweepSources(): void {
  releaseMediaNotIn(onScreen());
  void releaseSurfacesNotIn(onScreen);
}

/** Name the loaded project's document — null while nothing is open. */
export function bindLoadedDocument(get: () => MotionDocument | null): void {
  loaded = get;
}

/** The loaded project changed or closed: let go of everything it held. */
export function releaseClosedDocument(): void {
  purgeAllCaches();
  dropBoardPictures();
  sweepSources();
}

/** Hold a document on screen beside the loaded one (a preview). Returns its release. */
export function holdPreview(doc: MotionDocument): () => void {
  previews.add(doc);
  return () => {
    if (!previews.delete(doc)) return;
    sweepSources();
  };
}
