import { createId } from "../ids";
import type { MotionDocument, Clip, Frame, Track } from "../schema";
import { frameOrigin, withFrameOrigin } from "./merge";

/**
 * Document slicing — carve a SELF-CONTAINED sub-document out of a project.
 *
 * This is the export half of the template/library foundation. A slice is a
 * valid `MotionDocument` in its own right (same schema, same version), so the
 * ordinary bundle writer packs its media and the ordinary parser validates it —
 * a "template" is nothing more special than a small project. Its counterpart is
 * `mergeDocument`, which folds a slice back into another project.
 *
 * The whole point is that a slice is COMPLETE: whatever the chosen nodes need to
 * render — nested comps, component definitions, assets, fonts, variables,
 * groups, custom sounds — is walked transitively and carried along, so the file
 * "just works" anywhere it lands. Ids are left UNTOUCHED here; reconciliation
 * (re-id, page merge, reference remap) is `mergeDocument`'s job on the way in.
 */

export interface SliceSelection {
  /** Frames/components exported whole — every clip on them comes along. */
  frameIds?: string[];
  /**
   * Individual clips (layers) exported on their own. Their host frame comes
   * along as a shell carrying only these clips (plus anything they depend on),
   * so "export two layers of a busy frame" doesn't drag the other 48.
   */
  clipIds?: string[];
}

const clipsOfFrame = (doc: MotionDocument, frameId: string): Clip[] =>
  doc.tracks.flatMap((t) => t.clips.filter((c) => c.frameId === frameId));

/**
 * Compute the transitive closure of frames and clips a selection needs. A
 * nested clip pulls its source frame in WHOLE (a comp only renders complete),
 * which recursively pulls that comp's own nested sources, component
 * definitions, and so on.
 */
function resolveScope(doc: MotionDocument, sel: SliceSelection): { frames: Set<string>; clips: Set<string> } {
  const wholeFrames = new Set(sel.frameIds ?? []);
  const clips = new Set<string>(sel.clipIds ?? []);

  // Explicit clips bring their host frame in as a shell.
  const shellFrames = new Set<string>();
  if (sel.clipIds?.length) {
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clips.has(clip.id)) shellFrames.add(clip.frameId);
      }
    }
  }

  // Whole frames contribute all their clips.
  for (const fid of wholeFrames) for (const clip of clipsOfFrame(doc, fid)) clips.add(clip.id);

  // Fixpoint: every kept nested clip pulls its source frame in whole.
  let changed = true;
  while (changed) {
    changed = false;
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (!clips.has(clip.id) || clip.kind !== "nested") continue;
        const src = clip.sourceFrameId;
        if (wholeFrames.has(src)) continue;
        wholeFrames.add(src);
        for (const c of clipsOfFrame(doc, src)) clips.add(c.id);
        changed = true;
      }
    }
  }

  return { frames: new Set([...wholeFrames, ...shellFrames]), clips };
}

/** Every layer a comp draws, its nested comps' included (the slice's closure) — what a render of it needs ready. */
export function layersDrawnBy(doc: MotionDocument, frameId: string): Clip[] {
  const { clips } = resolveScope(doc, { frameIds: [frameId] });
  return doc.tracks.flatMap((t) => t.clips.filter((c) => clips.has(c.id)));
}

/** Deep structural clone via JSON — the doc is JSON by contract. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Extract a self-contained sub-document for the selected nodes. Throws if the
 * selection resolves to no frames (a slice must have at least one, like any
 * document). The returned document is a fresh deep copy — never aliases the
 * source — and carries a new document id (it is a template, not the project).
 */
export function sliceDocument(doc: MotionDocument, sel: SliceSelection, ns: string): MotionDocument {
  const scope = resolveScope(doc, sel);
  if (scope.frames.size === 0) {
    throw new Error("Nothing to export — the selection resolved to no frames.");
  }

  const firstPageId = doc.pages[0]!.id;
  const frames: Frame[] = doc.frames
    .filter((f) => scope.frames.has(f.id))
    .map((f) => {
      const copy = clone(f);
      copy.pageId = f.pageId ?? firstPageId; // pin null → first page
      // Stamp a stable cross-project identity so a re-import is recognized and
      // reused instead of duplicated (frameOrigin keeps an existing stamp).
      copy.pluginData = withFrameOrigin(copy.pluginData, ns, frameOrigin(f));
      return copy;
    });

  // Keep each track's kept clips; drop tracks that end up empty UNLESS they are
  // a spare lane homed to a kept frame (preserving the comp's lane layout).
  const tracks: Track[] = [];
  for (const track of doc.tracks) {
    const keptClips = track.clips.filter((c) => scope.clips.has(c.id));
    const isKeptSpareLane = track.clips.length === 0 && track.homeCompId != null && scope.frames.has(track.homeCompId);
    if (keptClips.length === 0 && !isKeptSpareLane) continue;
    tracks.push({ ...clone(track), clips: clone(keptClips) });
  }

  // Dependency detection: an id referenced anywhere in the kept structure (a
  // clip's assetId, a `var:<id>` token, a groupId, a custom-sound id) appears
  // verbatim in its JSON. Ids are unique high-entropy tokens, so a substring
  // scan is a sound, format-agnostic "is this referenced?" test — the same
  // principle the merge relies on.
  const scopeJson = JSON.stringify({ frames, tracks });
  const referenced = (id: string): boolean => scopeJson.includes(id);

  const customSounds = doc.customSounds.filter((s) => referenced(s.id));
  const soundAssetIds = new Set(customSounds.map((s) => s.assetId));
  // A tracker belongs to its footage: an asset that travels takes its trackers along.
  const assets = doc.assets.filter((a) => referenced(a.id) || soundAssetIds.has(a.id));
  const assetIds = new Set(assets.map((a) => a.id));

  // Media folders: every folder in the ancestor chain of a kept asset.
  const keepFolder = new Set<string>();
  for (const asset of assets) {
    let fid = asset.folderId;
    while (fid && !keepFolder.has(fid)) {
      keepFolder.add(fid);
      fid = doc.mediaFolders.find((f) => f.id === fid)?.parentId ?? null;
    }
  }
  const mediaFolders = doc.mediaFolders.filter((f) => keepFolder.has(f.id));

  const variables = doc.variables.filter((v) => referenced(v.id));
  // Trackers travel with their footage, so a sliced plate arrives still tracked.
  // One whose footage stays behind is dropped even if a follower named it — it
  // would have nothing to read — and the follower simply stops following.
  const trackers = doc.trackers.filter((t) => assetIds.has(t.source.assetId));
  const markers = doc.markers.filter((m) => scope.frames.has(m.frameId));

  const pageIds = new Set(frames.map((f) => f.pageId ?? firstPageId));
  let pages = doc.pages.filter((p) => pageIds.has(p.id));
  if (pages.length === 0) pages = [doc.pages[0]!];

  return clone({
    version: doc.version,
    id: createId("doc"),
    name: doc.name,
    durationMs: doc.durationMs,
    stageBackground: doc.stageBackground,
    pages,
    frames,
    tracks,
    variables,
    // Folders follow their variables: a slice that kept the folder rows
    // for variables it dropped would render a palette full of holes.
    variableFolders: doc.variableFolders.filter((f) =>
      variables.some((v) => v.folderId === f.id),
    ),
    // A slice carries no node graphs yet — expression drivers reference clips by
    // id and are wired in a later phase; extraction stays value-safe until then.
    graphs: [],
    // Expressions ride along whole. They are cheap text, a sliced field must not
    // lose the expression driving it, and `parseDocument` prunes whatever the
    // slice didn't actually reference the moment the file is opened.
    expressions: doc.expressions,
    trackers,
    assets,
    mediaFolders,
    // Presets are project-scoped assets: a slice of a document carries the
    // whole library so an exported piece still applies its own looks.
    presets: doc.presets,
    // Categories too: a clip routed to "Foley" must still find Foley when the
    // piece lands in another project.
    soundBuses: doc.soundBuses,
    // The audition volume is a working preference, so a slice carries it over
    // — paste into a fresh project and the picker still behaves as you set it.
    soundPreviewVolume: doc.soundPreviewVolume,
    customSounds,
    markers,
    // A slice never carries render-in-place records — they reference the source
    // doc's clips/assets, not the extracted subset.
    renderedClips: {},
    // Scripts stay with the project that owns them: their output records name
    // the source doc's layers, and a slice is a piece of artwork, not a workspace.
    scripts: [],
    scriptFolders: [],
  });
}
