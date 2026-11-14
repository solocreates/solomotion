"use client";

import {
  compRenderTimeMs,
  serializeSvgTarget,
  translateLottie,
  targetVisualClips,
  clipLocalTime,
  type ExportTarget,
  type Frame,
  type LottieGlyph,
  type LottieResult,
  type OutlinedTextPath,
  type SvgRasterPatch,
  type MotionDocument,
  bakeRelationsToKeys,
  clipAncestorGroups,
  frameDurationMs,
  frameFps,
  type LottieLayerReport,
} from "@solomotion/core";
import { drawFrameContent } from "../stage/render/draw-frame";
import { resolvedDocAt } from "@solomotion/core";
import {
  getImageForAsset,
  lockMediaForExport,
  prepareAnimatedImagesForExport,
  prepareVideoFramesForExport,
} from "../stage/render/media-cache";
import { measureTargetBounds } from "./target-bounds";
import { saveExport, type SaveSink } from "./save";
import { outlineGlyphsForLottie, outlineTextForSvg } from "./text-outline";
import { svgLinkAnchors } from "./export-links";
import { NAMES } from "@/editor/names";

/**
 * SVG + Lottie exports, app side. The headless serializer/translator live in
 * core; this file wires in what needs a browser — canvas rasterization for
 * non-vector layers, font outlining, image bytes — and downloads the result.
 */

function downloadText(save: SaveSink | undefined, text: string, filename: string, type: string): void {
  (save ?? saveExport)(new Blob([text], { type }), filename);
}

function safeName(name: string): string {
  return name.replace(/[^\w\d-]+/g, "-").replace(/^-+|-+$/g, "") || NAMES.files.fallbackName;
}

/**
 * Rasterizer for layers SVG can't hold as vectors: renders just those clips
 * (through the one draw pipeline) into a 2× PNG patch at their bounds.
 */
function makeRasterizer(doc: MotionDocument, frame: Frame, timeMs: number) {
  return (clipIds: string[]): SvgRasterPatch | null => {
    const bounds = measureTargetBounds(doc, frame, clipIds, [timeMs]);
    if (!bounds) return null;
    const scale = 2; // crisp on retina, cheap for a patch
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round(bounds.width * scale));
    canvas.height = Math.max(2, Math.round(bounds.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(canvas.width / bounds.width, canvas.height / bounds.height);
    ctx.translate(-bounds.x, -bounds.y);
    drawFrameContent(ctx, doc, frame, timeMs, { only: new Set(clipIds), transparent: true });
    return { href: canvas.toDataURL("image/png"), ...bounds };
  };
}

/** Pre-outline every text/caption clip the serializer may ask about (sync callbacks). */
async function outlineMapForSvg(
  doc: MotionDocument,
  target: ExportTarget,
  timeMs: number,
): Promise<Map<string, OutlinedTextPath[] | null>> {
  const map = new Map<string, OutlinedTextPath[] | null>();
  for (const clip of targetVisualClips(doc, target)) {
    if (clip.kind !== "text") continue;
    const localMs = clipLocalTime(clip, timeMs);
    if (localMs === null) continue;
    map.set(clip.id, await outlineTextForSvg(doc, clip, localMs));
  }
  return map;
}

export interface SvgExportOptions {
  region?: { x: number; y: number; width: number; height: number };
  includeBackground?: boolean;
  fileName?: string;
  /** The open project — an in-app link in the file becomes its web deep link. */
  projectId?: string | null;
  /** Where the file goes — default the browser's downloads (see ./save). */
  save?: SaveSink;
}

export interface SvgExportResult {
  svg: string;
  warnings: string[];
}

/** Build the SVG for a target at one instant (shared by export + preview). */
export async function buildSvg(
  doc: MotionDocument,
  target: ExportTarget,
  timeMs: number,
  options: SvgExportOptions = {},
): Promise<SvgExportResult> {
  const frame = doc.frames.find((f) => f.id === target.frameId) ?? doc.frames[0]!;
  // The instant the frame SHOWS — its still, for a static one — never the raw ask.
  timeMs = compRenderTimeMs(doc, frame.id, timeMs);
  // The instant's RESOLVED document: drivers baked, and every relation (a text
  // on a path, a laid-out row) placed — the same values the canvas painted.
  doc = resolvedDocAt(doc, timeMs, frame.id);
  const unlock = lockMediaForExport();
  try {
    await prepareAnimatedImagesForExport(doc);
    await prepareVideoFramesForExport(doc, frame, timeMs);
    const outlines = await outlineMapForSvg(doc, target, timeMs);
    const { svg, warnings } = serializeSvgTarget(doc, target, {
      timeMs,
      region: options.region,
      includeBackground: options.includeBackground,
      outlineText: (clip) => outlines.get(clip.id) ?? null,
      rasterize: makeRasterizer(doc, frame, timeMs),
    });
    return { svg, warnings };
  } finally {
    unlock();
  }
}

export async function exportSvgFile(
  doc: MotionDocument,
  target: ExportTarget,
  timeMs: number,
  options: SvgExportOptions = {},
): Promise<SvgExportResult> {
  const result = await buildSvg(doc, target, timeMs, options);
  // The file's links, over the picture. Only the standalone file: a PDF page
  // drawn from this SVG writes its own annotations (GoTo where it can).
  const picked = new Set(target.clipIds);
  const keep = picked.size ? (id: string) => picked.has(id) || clipAncestorGroups(doc, id).some((g) => picked.has(g.id)) : undefined;
  const anchors = svgLinkAnchors(doc, target.frameId, compRenderTimeMs(doc, target.frameId, timeMs), options.projectId ?? null, keep);
  if (anchors) result.svg = result.svg.replace(/<\/svg>$/, `${anchors}</svg>`);
  downloadText(options.save, result.svg, `${safeName(options.fileName ?? target.name)}.svg`, "image/svg+xml");
  return result;
}

// ── Lottie ───────────────────────────────────────────────────────────────────

export interface LottieExportOptions {
  startMs?: number;
  endMs?: number;
  region?: { x: number; y: number; width: number; height: number };
  includeBackground?: boolean;
  fileName?: string;
  /** Where the file goes — default the browser's downloads (see ./save). */
  save?: SaveSink;
}

/** Every text/caption clip reachable from the target (nested comps included). */
async function glyphMapForLottie(
  doc: MotionDocument,
  target: ExportTarget,
): Promise<Map<string, LottieGlyph[] | null>> {
  const map = new Map<string, LottieGlyph[] | null>();
  // Frames reachable through nesting from the target frame.
  const frames = new Set<string>([target.frameId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === "nested" && frames.has(clip.frameId) && !frames.has(clip.sourceFrameId)) {
          frames.add(clip.sourceFrameId);
          grew = true;
        }
      }
    }
  }
  const wanted = target.clipIds.length > 0 ? new Set(target.clipIds) : null;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "text") continue;
      if (!frames.has(clip.frameId)) continue;
      if (wanted && clip.frameId === target.frameId && !wanted.has(clip.id)) continue;
      map.set(clip.id, await outlineGlyphsForLottie(doc, clip));
    }
  }
  return map;
}

/** Data URI + intrinsic size for an image asset (Lottie image layers). */
function lottieImageProvider(doc: MotionDocument) {
  return (assetId: string): { dataUri: string; width: number; height: number } | null => {
    const asset = doc.assets.find((a) => a.id === assetId);
    const img = getImageForAsset(assetId, asset?.mime);
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return { dataUri: canvas.toDataURL("image/png"), width: img.naturalWidth, height: img.naturalHeight };
  };
}

/** Translate a target to Lottie (shared by export, preview and the report UI). */
export async function buildLottie(
  doc: MotionDocument,
  target: ExportTarget,
  options: LottieExportOptions = {},
): Promise<LottieResult> {
  const unlock = lockMediaForExport();
  try {
    // Lottie translates STRUCTURE, clip by clip, so a relation has to become
    // keys first: a member placed by a row, a text driven by its host. What
    // the bake cannot carry — glyphs on a curve, a container's own box — is
    // reported per layer below rather than dropped silently.
    const frame = doc.frames.find((f) => f.id === target.frameId) ?? doc.frames[0]!;
    const fps = frameFps(doc, frame);
    const relationNotes = relationReport(doc, frame.id);
    doc = bakeRelationsToKeys(doc, frame.id, fps, options.startMs ?? 0, options.endMs ?? frameDurationMs(doc, frame));
    await prepareAnimatedImagesForExport(doc);
    const glyphs = await glyphMapForLottie(doc, target);
    const result = translateLottie(doc, target, {
      startMs: options.startMs,
      endMs: options.endMs,
      region: options.region,
      includeBackground: options.includeBackground,
      outlineGlyphs: (clip) => glyphs.get(clip.id) ?? null,
      imageAsset: lottieImageProvider(doc),
    });
    return relationNotes.length ? { ...result, report: [...result.report, ...relationNotes] } : result;
  } finally {
    unlock();
  }
}

/** What a relation loses in Lottie, per layer — the bake keeps the placement, not the picture. */
function relationReport(doc: MotionDocument, frameId: string): LottieLayerReport[] {
  const out: LottieLayerReport[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== frameId) continue;
      if (clip.kind === "text" && clip.path) {
        out.push({ name: clip.name, kind: "text on path", status: "partial", notes: ["exports at its place on the host, as straight text — Lottie has no text-on-path."] });
      } else if (clip.kind === "group" && clip.layout && (clip.fills.length > 0 || clip.strokes.length > 0)) {
        out.push({ name: clip.name, kind: "auto layout", status: "partial", notes: ["members export where the layout put them; the container's own box (fill, stroke) is not carried."] });
      }
    }
  }
  return out;
}

export async function exportLottieFile(
  doc: MotionDocument,
  target: ExportTarget,
  options: LottieExportOptions = {},
): Promise<LottieResult> {
  const result = await buildLottie(doc, target, options);
  downloadText(
    options.save,
    JSON.stringify(result.lottie),
    `${safeName(options.fileName ?? target.name)}.json`,
    "application/json",
  );
  return result;
}
