import { createId } from "../ids";
import type { MotionDocument, Frame } from "../schema";
import { stampedId } from "../identity";

/**
 * Document merging — fold one document into another, Blender-append style, but
 * IDEMPOTENT: re-importing the same content reuses what's already there instead
 * of stacking duplicates (two of the same voice, three of the same component…).
 *
 * The import half of the template/library foundation (its counterpart is
 * `sliceDocument`). Whatever the incoming document holds — one node or a whole
 * project — is re-homed into the target without disturbing what's there:
 *
 *   1. Nodes are matched to existing ones by a STABLE identity and REUSED when
 *      found (see below); anything new is re-identified to fresh ids so it can't
 *      collide. So importing a file twice converges — it does not accumulate.
 *   2. Pages merge BY NAME: incoming frames on a "Page 1" flow into the target's
 *      existing "Page 1"; a page with no match is created.
 *
 * Identity per node class:
 *   - frames: a stable `<ns>.origin` stamp (their id in the project they were
 *     first authored in — `sliceDocument` stamps it; it propagates across
 *     re-exports). Reusing a frame reuses its whole timeline, so its clips never
 *     duplicate either — this is what stops the "two voices / N components" bug.
 *   - assets: content signature (kind+name+bytes+mime) — the same media imported
 *     from any source resolves to one asset (and one blob).
 *   - variables: name + type.
 *
 * Every internal reference — `frameId`, `sourceFrameId`, `pageId`, `homeCompId`,
 * `groupId`, `assetId`, `linkGroupId`, `mirrorId`, `var:<id>` tokens, and ids
 * buried in plugin recipes — is rewritten in ONE pass over the serialized JSON
 * by the id map, so a reused node's references repoint at the existing copy with
 * no per-field plumbing to forget.
 */

/**
 * The pluginData key holding a frame's stable cross-project identity:
 * vendor-stamped (`<ns>.origin`, see `identity.ts`), so a frame keeps the
 * identity any product on this engine gave it.
 */
export const FRAME_ORIGIN = stampedId("", ".", "origin");

export interface MergeOptions {
  /** The writing product's namespace — the origin stamp it adds (`identity.ts`). */
  ns: string;
  /** Force incoming frames onto this page instead of matching by name. */
  intoPageId?: string;
  /** Import literal copies instead of reusing matched nodes (default: dedup on). */
  dedup?: boolean;
}

export interface MergeReport {
  framesAdded: number;
  framesReused: number;
  clipsAdded: number;
  assetsAdded: number;
  assetsReused: number;
  variablesAdded: number;
  pagesCreated: number;
  pagesMerged: number;
}

export interface MergeResult {
  doc: MotionDocument;
  report: MergeReport;
  /** old asset id → resolved id (new OR the reused existing one) — for blob migration. */
  assetIdMap: Record<string, string>;
  /** Resolved ids of every incoming frame, in order (new or reused). */
  newFrameIds: string[];
  /** Resolved ids of the TOP-LEVEL imported frames (not nested inside the import). */
  rootFrameIds: string[];
  /** Ids of frames that were freshly ADDED (excludes reused/deduped ones). */
  addedFrameIds: string[];
}

/**
 * A frame's pluginData stamped with its origin as `ns` writes it. Every origin
 * key it already carries (another product's) names the same identity, so it
 * gets the same value — the id remap must not leave one of them stale.
 */
export function withFrameOrigin(data: Frame["pluginData"], ns: string, origin: string): NonNullable<Frame["pluginData"]> {
  const out: NonNullable<Frame["pluginData"]> = { ...data };
  for (const k of Object.keys(out)) if (FRAME_ORIGIN.matches(k)) out[k] = origin;
  out[FRAME_ORIGIN.of(ns)] = origin;
  return out;
}

/** A frame's stable identity — its origin stamp, or its own id if never stamped. */
export function frameOrigin(frame: Frame): string {
  const data = frame.pluginData;
  if (data) for (const [k, v] of Object.entries(data)) if (FRAME_ORIGIN.matches(k) && typeof v === "string") return v;
  return frame.id;
}

const assetSig = (a: MotionDocument["assets"][number]): string =>
  `${a.kind}:${a.name}:${a.bytes}:${a.mime}`;
const varKey = (v: MotionDocument["variables"][number]): string => `${v.type}:${v.name}`;

function catalogueIds(doc: MotionDocument): { prefix: string; ids: string[] }[] {
  const clips = doc.tracks.flatMap((t) => t.clips);
  const linkGroups = [...new Set(clips.map((c) => c.linkGroupId).filter((v): v is string => v != null))];
  return [
    { prefix: "page", ids: doc.pages.map((p) => p.id) },
    { prefix: "frame", ids: doc.frames.map((f) => f.id) },
    { prefix: "track", ids: doc.tracks.map((t) => t.id) },
    { prefix: "clip", ids: clips.map((c) => c.id) },
    { prefix: "var", ids: doc.variables.map((v) => v.id) },
    { prefix: "fx", ids: doc.expressions.map((e) => e.id) },
    { prefix: "asset", ids: doc.assets.map((a) => a.id) },
    { prefix: "folder", ids: doc.mediaFolders.map((f) => f.id) },
    { prefix: "sound", ids: doc.customSounds.map((s) => s.id) },
    { prefix: "marker", ids: doc.markers.map((m) => m.id) },
    { prefix: "tracker", ids: doc.trackers.map((t) => t.id) },
    { prefix: "link", ids: linkGroups },
  ];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Every reference to an id, rewritten in ONE pass over the serialized document
 * (longest id first, so no id is rewritten inside a longer one). The single
 * remap both `mergeDocument` and `reissueDocumentIds` stand on.
 */
function remapIds(doc: MotionDocument, idMap: ReadonlyMap<string, string>): MotionDocument {
  let json = JSON.stringify(doc);
  const entries = [...idMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [oldId, newId] of entries) json = json.split(oldId).join(newId);
  return JSON.parse(json) as MotionDocument;
}

/**
 * A copy of `doc` with every id fresh — pages, comps, lanes, layers,
 * variables, expressions, media, markers, trackers, link groups, and the
 * document's own. What "New from template" makes: two projects from one
 * template must never share an id, above all an asset id, which keys the
 * media bytes on this device. Frame origin stamps survive (they name where a
 * comp was first authored, which is what keeps a later import idempotent).
 * `assetIdMap` (old → new) is for re-keying those bytes.
 */
export function reissueDocumentIds(doc: MotionDocument, ns: string): { doc: MotionDocument; assetIdMap: Record<string, string> } {
  const idMap = new Map<string, string>();
  for (const { prefix, ids } of catalogueIds(doc)) for (const id of ids) idMap.set(id, createId(prefix));
  const out = remapIds(doc, idMap);
  out.id = createId("doc");
  out.frames.forEach((f, i) => {
    f.pluginData = withFrameOrigin(f.pluginData, ns, frameOrigin(doc.frames[i]!));
  });
  const assetIdMap: Record<string, string> = {};
  for (const a of doc.assets) assetIdMap[a.id] = idMap.get(a.id)!;
  return { doc: out, assetIdMap };
}

/**
 * Merge `incoming` into `target`; returns the new document, a report, the asset
 * remap, and the imported frame ids. Neither input is mutated.
 */
export function mergeDocument(
  target: MotionDocument,
  incoming: MotionDocument,
  opts: MergeOptions,
): MergeResult {
  const dedup = opts.dedup ?? true;
  const idMap = new Map<string, string>();
  const reused = new Set<string>(); // incoming ids that resolve to an EXISTING target node

  // Pages map by name (or a forced target page) — always "merge", never skip.
  const mergedPageIds = new Set<string>();
  const targetPageByName = new Map(target.pages.map((p) => [p.name, p.id]));
  for (const page of incoming.pages) {
    const existing = opts.intoPageId ?? targetPageByName.get(page.name);
    if (existing) {
      idMap.set(page.id, existing);
      mergedPageIds.add(page.id);
    } else {
      idMap.set(page.id, createId("page"));
    }
  }

  // Identity-based reuse: frames by origin, assets by content, variables by name.
  if (dedup) {
    const reuse = (incomingId: string, existingId: string | undefined): void => {
      if (existingId === undefined) return;
      idMap.set(incomingId, existingId);
      reused.add(incomingId);
    };
    const frameByOrigin = new Map(target.frames.map((f) => [frameOrigin(f), f.id]));
    for (const f of incoming.frames) reuse(f.id, frameByOrigin.get(frameOrigin(f)));
    const assetBySig = new Map(target.assets.map((a) => [assetSig(a), a.id]));
    for (const a of incoming.assets) reuse(a.id, assetBySig.get(assetSig(a)));
    const varByKey = new Map(target.variables.map((v) => [varKey(v), v.id]));
    for (const v of incoming.variables) reuse(v.id, varByKey.get(varKey(v)));
  }

  // Everything else gets a fresh id.
  for (const { prefix, ids } of catalogueIds(incoming)) {
    for (const id of ids) if (!idMap.has(id)) idMap.set(id, createId(prefix));
  }

  const remapped = remapIds(incoming, idMap);

  // Restore each kept frame's STABLE origin stamp — the remap rewrote a
  // self-referential origin to the fresh id, which would break future dedup.
  for (let i = 0; i < remapped.frames.length; i++) {
    const f = remapped.frames[i]!;
    f.pluginData = withFrameOrigin(f.pluginData, opts.ns, frameOrigin(incoming.frames[i]!));
  }

  // Target ids of reused frames — their content (clips, markers) already exists.
  const reusedFrameIds = new Set(
    incoming.frames.filter((f) => reused.has(f.id)).map((f) => idMap.get(f.id)!),
  );

  const merged = clone(target);

  // Frames: append only the non-reused.
  const keptFrames = remapped.frames.filter((_, i) => !reused.has(incoming.frames[i]!.id));
  merged.frames.push(...keptFrames);

  // Tracks/clips: drop clips owned by a reused frame (already present); drop
  // tracks that end up empty and aren't a spare lane for a KEPT frame.
  const keptTracks: typeof remapped.tracks = [];
  for (const track of remapped.tracks) {
    track.clips = track.clips.filter((c) => !reusedFrameIds.has(c.frameId));
    const spareForKept =
      track.clips.length === 0 && track.homeCompId != null && !reusedFrameIds.has(track.homeCompId);
    if (track.clips.length === 0 && !spareForKept) continue;
    keptTracks.push(track);
  }
  merged.tracks.push(...keptTracks);

  // Assets / variables: append the non-reused.
  const keptAssets = remapped.assets.filter((_, i) => !reused.has(incoming.assets[i]!.id));
  merged.assets.push(...keptAssets);
  merged.variables.push(...remapped.variables.filter((_, i) => !reused.has(incoming.variables[i]!.id)));

  // Custom sounds / media folders / markers: keep only those still referenced
  // by the content we actually appended (so a full re-import — where every
  // frame was reused — leaves no orphans behind). Groups travel inside `tracks`
  // now: a group IS a clip, so it is carried, remapped and pruned by the same
  // pass as everything else on a lane.
  const keptJson = JSON.stringify({ frames: keptFrames, tracks: keptTracks, assets: keptAssets });
  // Expressions follow the same rule: an `fx:<id>` token lives inside the clips
  // we just appended, so the kept-content sweep is exactly the right test.
  merged.expressions.push(...remapped.expressions.filter((e) => keptJson.includes(e.id)));
  merged.customSounds.push(...remapped.customSounds.filter((s) => keptJson.includes(s.id)));
  merged.mediaFolders.push(...remapped.mediaFolders.filter((f) => keptJson.includes(f.id)));
  merged.markers.push(...remapped.markers.filter((m) => !reusedFrameIds.has(m.frameId)));
  // Project presets: a merge brings the incoming document's saved looks along,
  // deduped by (kind, name) so re-importing the same file never grows the list.
  {
    const have = new Set(merged.presets.map((p) => `${p.kind}\u0000${p.name}`));
    for (const p of incoming.presets) {
      const key = `${p.kind}\u0000${p.name}`;
      if (have.has(key)) continue;
      have.add(key);
      merged.presets.push(structuredClone(p));
    }
  }
  // Sound categories: bring the ones this project lacks, by id — built-ins are
  // shared ids, so they never duplicate, and a custom one keeps its routes.
  {
    const have = new Set(merged.soundBuses.map((b) => b.id));
    for (const b of remapped.soundBuses) {
      if (have.has(b.id)) continue;
      have.add(b.id);
      merged.soundBuses.push(structuredClone(b));
    }
  }
  // Trackers belong to footage: keep those whose (remapped or reused) asset is
  // in the merged project, never twice under one id.
  const haveAssets = new Set(merged.assets.map((a) => a.id));
  const haveTrackers = new Set(merged.trackers.map((t) => t.id));
  merged.trackers.push(...remapped.trackers.filter((t) => haveAssets.has(t.source.assetId) && !haveTrackers.has(t.id)));

  // Pages: append the freshly-created (non-merged) ones.
  let pagesCreated = 0;
  const existingPageIds = new Set(merged.pages.map((p) => p.id));
  for (const page of remapped.pages) {
    if (existingPageIds.has(page.id)) continue;
    merged.pages.push(page);
    existingPageIds.add(page.id);
    pagesCreated++;
  }

  const assetIdMap: Record<string, string> = {};
  for (const asset of incoming.assets) assetIdMap[asset.id] = idMap.get(asset.id)!;

  // Imported frame ids (resolved), and which of them are top-level (not nested
  // inside the import) — for the host to place/select what arrived.
  const nestedSources = new Set(
    remapped.tracks.flatMap((t) => t.clips).flatMap((c) => (c.kind === "nested" ? [c.sourceFrameId] : [])),
  );
  const newFrameIds = incoming.frames.map((f) => idMap.get(f.id)!);
  const rootFrameIds = newFrameIds.filter((id) => !nestedSources.has(id));

  return {
    doc: merged,
    report: {
      framesAdded: keptFrames.length,
      framesReused: reusedFrameIds.size,
      clipsAdded: keptTracks.reduce((n, t) => n + t.clips.length, 0),
      assetsAdded: keptAssets.length,
      assetsReused: incoming.assets.length - keptAssets.length,
      variablesAdded: merged.variables.length - target.variables.length,
      pagesCreated,
      pagesMerged: mergedPageIds.size,
    },
    assetIdMap,
    newFrameIds,
    rootFrameIds,
    addedFrameIds: keptFrames.map((f) => f.id),
  };
}
