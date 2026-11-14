"use client";

import {
  collectFontFamilies,
  createNestedClip,
  mergeDocument,
  sliceDocument,
  type MotionDocument,
  type DocumentStore,
  type SliceSelection,
  presetBundleExt,
  isPresetBundleText,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { putAssetBlob } from "../assets/asset-store";
import { importFilesAsClips, type ImportTarget } from "../assets/import";
import { placeClip } from "@solomotion/core";
import { installCustomFontBytes } from "../stage/render/fonts";
import { ensureDocumentFaces } from "../stage/render/system-fonts";
import { useSession } from "../state/session";
import { downloadBlob, safeName } from "./file-handle-store";
import { importPresetFile } from "../presets/PresetTransferDialog";
import { readBundleForImport, writeMotionBundle } from "./motion-file";
import { ENGINE } from "@/editor/names";
import { identity } from "@/editor/identity";

/**
 * slice files — the ONE headless flow for exporting a slice of a project
 * (a node, a few layers, a page of frames) and importing one back. It rides
 * entirely on the two core primitives (`sliceDocument` / `mergeDocument`) and
 * the existing `.motion` bundle writer, so every entry point — File menu, the
 * sidebar export section, the top-bar export menu — calls these same two
 * functions. A "template" is just a project slice; nothing here is bespoke.
 *
 * File extension: the product's `sliceExt` (`.motion` in SoloMotion); the reader also accepts a full `.motion` bundle or
 * a bare `.json` document, so any project the app saves can be merged in.
 */

const DATA_EXT = identity.sliceExt;

/** What the current selection means for a data export, with a human label. */
export interface ExportScope {
  selection: SliceSelection;
  /** e.g. "2 frames", "3 layers", "this frame" — for menu labels/toasts. */
  label: string;
  /** How many top-level nodes are in scope (0 = nothing selected). */
  count: number;
}

/**
 * Resolve what to export from the live selection: chosen frames win, else chosen
 * layers, else the active frame (so the action is never a dead end). Read
 * straight from the session so every caller agrees.
 */
export function currentExportScope(doc: MotionDocument): ExportScope {
  return exportScopeOf(useSession.getState(), doc.frames[0]?.id ?? null);
}

/** What an export scope is made of, so a view can subscribe to exactly these. */
export interface ExportScopeInputs {
  selectedFrameIds: string[];
  selectedClipIds: string[];
  activeFrameId: string | null;
}

/** The pure rule behind `currentExportScope`, for views that subscribe to its inputs. */
export function exportScopeOf(s: ExportScopeInputs, firstFrameId: string | null): ExportScope {
  if (s.selectedFrameIds.length) {
    const n = s.selectedFrameIds.length;
    return { selection: { frameIds: s.selectedFrameIds }, label: `${n} frame${n > 1 ? "s" : ""}`, count: n };
  }
  if (s.selectedClipIds.length) {
    const n = s.selectedClipIds.length;
    return { selection: { clipIds: s.selectedClipIds }, label: `${n} layer${n > 1 ? "s" : ""}`, count: n };
  }
  if (s.activeFrameId) return { selection: { frameIds: [s.activeFrameId] }, label: "this frame", count: 1 };
  if (firstFrameId) return { selection: { frameIds: [firstFrameId] }, label: "this frame", count: 1 };
  return { selection: { frameIds: [] }, label: "nothing yet", count: 0 };
}

/** Slice the given selection, pack it (media included), and download it. */
export async function exportSelectionAsFile(
  store: DocumentStore,
  selection: SliceSelection,
  opts: { name?: string } = {},
): Promise<boolean> {
  const doc = store.getState();
  let slice: MotionDocument;
  try {
    slice = sliceDocument(doc, selection, ENGINE.ns);
  } catch (err) {
    toast.error((err as Error).message);
    return false;
  }
  const blob = await writeMotionBundle(slice, { includeMedia: true });
  const baseName = opts.name ?? (slice.frames.length === 1 ? slice.frames[0]!.name : doc.name);
  downloadBlob(blob, `${safeName(baseName)}${DATA_EXT}`);
  const n = slice.frames.length;
  toast.success(`Exported ${n} frame${n > 1 ? "s" : ""} · media included`);
  return true;
}

/**
 * Where a dropped slice file should land. Omit for a plain merge (frames flow
 * to their pages by name). Given `onPage`, the freshly-added top-level frames
 * are placed at a canvas point (stage drop); given `intoComp`, they're nested as
 * instances in a comp at a time (timeline drop).
 */
export interface ImportPlacement {
  onPage?: { pageId: string; world: { x: number; y: number } };
  intoComp?: { frameId: string; startMs: number; trackId?: string };
}

/** Move freshly-added root frames onto a page so their group's top-left sits at `world`. */
function positionRootsOnPage(
  d: MotionDocument,
  rootIds: string[],
  onPage: NonNullable<ImportPlacement["onPage"]>,
): void {
  const roots = d.frames.filter((f) => rootIds.includes(f.id));
  if (roots.length === 0) return;
  const minX = Math.min(...roots.map((f) => f.x));
  const minY = Math.min(...roots.map((f) => f.y));
  const dx = Math.round(onPage.world.x - minX);
  const dy = Math.round(onPage.world.y - minY);
  for (const f of roots) {
    f.x += dx;
    f.y += dy;
    f.pageId = onPage.pageId;
  }
}

/** Nest each imported root frame as a fresh instance clip in a comp. */
function nestRootsInComp(
  d: MotionDocument,
  rootIds: string[],
  intoComp: NonNullable<ImportPlacement["intoComp"]>,
): void {
  for (const rootId of rootIds) {
    const frame = d.frames.find((f) => f.id === rootId);
    if (!frame) continue;
    const clip = createNestedClip({
      frameId: intoComp.frameId,
      sourceFrameId: rootId,
      startMs: intoComp.startMs,
      durationMs: frame.durationMs ?? undefined,
      name: frame.name,
    });
    placeClip(d, clip, { preferredTrackId: intoComp.trackId });
  }
}

/**
 * Merge a slice file into the OPEN project (Blender-style, idempotent).
 * Re-ids/dedups/remaps via `mergeDocument`, migrates media bytes to their
 * resolved ids, installs fonts, and optionally places what arrived at the drop
 * point. Undoable — the whole thing is one history step.
 */
export async function importSliceFile(
  store: DocumentStore,
  file: File,
  placement?: ImportPlacement,
): Promise<void> {
  const { doc: incoming, assetBlobs, fonts } = await readBundleForImport(file);
  const merged = await mergeIntoProject(projectTarget(store), incoming, { assetBlobs, fonts, placement, label: `Import ${identity.name} file` });
  // Make what arrived obvious. Timeline drops placed instance clips, so leave
  // the frame selection alone there.
  if (!placement?.intoComp && merged.addedRoots.length) useSession.getState().selectFrames(merged.addedRoots);
  toast.success(importSummary(merged.report, placement, merged.rootFrameIds.length));
}

/** What a merge brought, for the caller to report or select. */
export interface ProjectMerge {
  report: ReturnType<typeof mergeDocument>["report"];
  rootFrameIds: string[];
  /** The top-level comps that are NEW here (a reused one is not). */
  addedRoots: string[];
  assetIdMap: Record<string, string>;
}

/**
 * MERGE A DOCUMENT INTO THE OPEN PROJECT — the one path for everything that
 * brings comps and media in from elsewhere: a dropped slice file, and an
 * agent copying from another of the user's projects (`project.import`).
 * Re-ids/dedups/remaps via `mergeDocument`, moves media bytes to their resolved
 * ids, installs fonts, and optionally places what arrived. One history step.
 */
/** Where a merge lands: the open document, and the write that records it (an agent's carries its turn's undo step). */
export interface MergeTarget {
  doc(): MotionDocument;
  write(label: string, recipe: (draft: MotionDocument) => void): void;
}

/** A store as a merge target — a person's import is its own undo step. */
export function projectTarget(store: DocumentStore): MergeTarget {
  return { doc: () => store.getState(), write: (label, recipe) => void store.update(label, recipe) };
}

export async function mergeIntoProject(
  target: MergeTarget,
  incoming: MotionDocument,
  opts: {
    assetBlobs?: ReadonlyMap<string, Blob>;
    fonts?: Awaited<ReturnType<typeof readBundleForImport>>["fonts"];
    placement?: ImportPlacement;
    label: string;
  },
): Promise<ProjectMerge> {
  const { placement } = opts;
  const { doc: merged, report, assetIdMap, rootFrameIds, addedFrameIds } = mergeDocument(target.doc(), incoming, { ns: ENGINE.ns });

  // Bytes must land under the RESOLVED ids before anything reads them.
  for (const [oldId, blob] of opts.assetBlobs ?? []) await putAssetBlob(assetIdMap[oldId] ?? oldId, blob);
  for (const font of opts.fonts ?? []) {
    await installCustomFontBytes(font.family, font.fileName, font.data, {
      weight: font.weight,
      italic: font.italic,
    });
  }

  const addedSet = new Set(addedFrameIds);
  const addedRoots = rootFrameIds.filter((id) => addedSet.has(id));

  target.write(opts.label, (d) => {
    d.pages = merged.pages;
    d.frames = merged.frames;
    d.tracks = merged.tracks;
    d.variables = merged.variables;
    d.assets = merged.assets;
    d.mediaFolders = merged.mediaFolders;
    d.customSounds = merged.customSounds;
    d.markers = merged.markers;
    // Stage drop: place only the NEW top-level frames (never move a reused one).
    if (placement?.onPage && addedRoots.length) positionRootsOnPage(d, addedRoots, placement.onPage);
    // Timeline drop: nest EVERY root as a fresh instance (reused defs → new instance,
    // not a duplicate component — Figma-style).
    if (placement?.intoComp) nestRootsInComp(d, rootFrameIds, placement.intoComp);
  });
  ensureDocumentFaces(merged);
  return { report, rootFrameIds, addedRoots, assetIdMap };
}

/** Human summary that names reuse honestly (so a re-import reads as a no-op, not a mystery). */
function importSummary(
  report: ReturnType<typeof mergeDocument>["report"],
  placement: ImportPlacement | undefined,
  rootCount: number,
): string {
  if (placement?.intoComp) {
    const n = rootCount;
    const suffix = report.framesReused ? " · components reused" : "";
    return `Placed ${n} instance${n > 1 ? "s" : ""}${suffix}`;
  }
  if (report.framesAdded === 0 && report.framesReused > 0) return "Already in this project — reused, not duplicated";
  const parts = [`${report.framesAdded} frame${report.framesAdded > 1 ? "s" : ""}`];
  if (report.assetsAdded) parts.push(`${report.assetsAdded} media`);
  if (report.framesReused) parts.push(`${report.framesReused} reused`);
  if (report.pagesMerged) parts.push(`${report.pagesMerged} page${report.pagesMerged > 1 ? "s" : ""} merged`);
  return `Imported ${parts.join(" · ")}`;
}

const PRESETS_EXT = presetBundleExt(ENGINE.ns);
const DATA_EXTS = [...new Set([DATA_EXT, ".motion", ".json", PRESETS_EXT])];

/**
 * A preset bundle, if that is what this is — opened in the import dialog and
 * reported as handled. Only text-shaped files are sniffed, and only for the
 * format marker, so dropping a 2GB video costs nothing.
 */
async function maybeImportPresetBundle(file: File): Promise<boolean> {
  const name = file.name.toLowerCase();
  const couldBe = name.endsWith(PRESETS_EXT) || name.endsWith(".json");
  if (!couldBe) return false;
  let head = "";
  try {
    head = await file.slice(0, 4096).text();
  } catch {
    return false;
  }
  if (!isPresetBundleText(head)) return false;
  await importPresetFile(file);
  return true;
}

/** Is this a project, template or slice file (vs. plain media)? */
export function isSliceFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return DATA_EXTS.some((ext) => name.endsWith(ext));
}

/**
 * The ONE drop/import entry point: split a file set into slice files
 * (merged, placed at the drop) and plain media (imported as clips) — so the same
 * stage/timeline/File-menu listeners handle both without caring which is which.
 */
export async function importDroppedFiles(
  store: DocumentStore,
  files: File[],
  ctx: { media: ImportTarget; data?: ImportPlacement },
): Promise<void> {
  // PRESET BUNDLES come off first. They are `.json` too, so the extension
  // cannot separate them — the FORMAT FIELD does, which is exactly why the
  // bundle carries one. Routing them here rather than giving presets their own
  // drop listener is what makes "drop it on the app" mean one thing.
  const rest: File[] = [];
  for (const file of files) {
    if (await maybeImportPresetBundle(file)) continue;
    rest.push(file);
  }
  files = rest;

  const data = files.filter(isSliceFile);
  const media = files.filter((f) => !isSliceFile(f));
  if (media.length) await importFilesAsClips(store, media, ctx.media);
  for (const file of data) {
    await importSliceFile(store, file, ctx.data).catch((err) =>
      toast.error("Couldn't import file", { description: (err as Error).message }),
    );
  }
}

/** Prompt for any importable file (media or slice data) and bring it in. */
export function pickAndImportFiles(store: DocumentStore, mediaTarget: ImportTarget): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = `image/*,video/*,audio/*,${DATA_EXTS.join(",")},application/zip`;
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    if (files.length) void importDroppedFiles(store, files, { media: mediaTarget });
  };
  input.click();
}
