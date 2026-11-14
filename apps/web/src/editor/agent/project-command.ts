"use client";

import { identity } from "@/editor/identity";
import { z } from "zod";
import {
  ApiError,
  collectAssetIds,
  compOwnerNested,
  defineCommand,
  frameDurationMs,
  isInternalPage,
  landingFrameId,
  sliceDocument,
  type AnyCommand,
  type MotionDocument,
  type CommandRuntime,
} from "@solomotion/core";
import { BROWSER_DOWNLOAD, requireDelivery, SAVE_TO_DESCRIPTION } from "./media-io";
import { fileFromSource, fileSourceInput, type FileSource } from "./attachments";
import { getAssetBlob, hasAssetBlob } from "../assets/asset-store";
import { mergeIntoProject } from "../io/slice-file";
import { useAppShell } from "../state/app-shell";
import { getProjectDocument, listProjects, type ProjectRecord } from "../state/project-store";
import { useAgent } from "./store";
import { flushSurfaces } from "../drawing/raster-store";
import { readBundleForImport, writeMotionBundle } from "../io/motion-file";
import { openFileAsProject } from "../state/open-project";
import { toast } from "@/lib/toast";
import { downloadBlob, safeName } from "../io/file-handle-store";
import { getPublisher } from "../library/publisher-identity";
import { bundleProject, publisherPacks, sendToLibrary, slug } from "../library/publish";
import { ENGINE } from "@/editor/names";

/** The files a project opens or imports from, as an agent is told them. */
const PROJECT_FILE_EXTS = [...new Set([".motion", identity.sliceExt, ".json"])].join(", ");

/**
 * THE AGENT'S SAVE — the project as a `.motion` bundle, written by the same
 * `writeMotionBundle` File ▸ Save uses, so the file an agent keeps is the file
 * the menu makes and opens the same way.
 *
 * It lands where `export.render`'s files do: on the agent's machine through
 * the bridge (`saveTo`), or in the browser's downloads. It never touches the
 * user's own ⌘S location — that remembered file is theirs, and an agent
 * filing a copy into a production folder must not redirect the next ⌘S.
 */
const projectSave = defineCommand({
  id: "project.save",
  summary: "Save the whole project as a .motion bundle (File ▸ Save's file), with its media embedded — to a path on your machine or the browser's downloads.",
  details:
    "Keep a film's project file beside its renders: `saveTo` a folder ending in / (or a path ending .motion). `includeMedia: false` writes the document and an inventory only (small, but it opens with missing media elsewhere). The result names any media whose bytes are not on this device — those are listed in the bundle but cannot be embedded. Does not change the user's own ⌘S location.",
  effect: "read",
  input: z.object({
    includeMedia: z.boolean().default(true),
    name: z.string().optional().describe("File name without extension; default the project's name."),
    saveTo: z.string().optional().describe(SAVE_TO_DESCRIPTION),
  }),
  async run(input, rt) {
    const deliver = input.saveTo !== undefined ? requireDelivery(rt) : null;
    // Paint surfaces flush their pixels first, exactly as File ▸ Save does.
    await flushSurfaces();
    const doc = rt.doc();
    const name = `${safeName(input.name ?? doc.name)}.motion`;
    const blob = await writeMotionBundle(doc, { includeMedia: input.includeMedia });
    const where = deliver
      ? await deliver({ name, bytes: new Uint8Array(await blob.arrayBuffer()), path: input.saveTo! })
      : (downloadBlob(blob, name), BROWSER_DOWNLOAD);
    const ids = collectAssetIds(doc);
    const present = input.includeMedia ? await Promise.all(ids.map((id) => hasAssetBlob(id))) : [];
    const missing = input.includeMedia ? ids.filter((_, i) => !present[i]).map((id) => doc.assets.find((a) => a.id === id)?.name ?? id) : [];
    return {
      saved: { name, bytes: blob.size },
      where,
      mediaIncluded: input.includeMedia,
      ...(missing.length ? { missingMedia: missing } : {}),
    };
  },
});

// ── Other projects ──────────────────────────────────────────────────────────
//
// An agent sees the project open in front of the person — and, once they turn
// it on (Agents ▸ Use your agent app ▸ "Agents can open your other projects"),
// every other project on this device: to find a brand kit in "First" and bring
// its comps and media into "New" instead of rebuilding them from a script.
//
// Reading only ever: another project is never written. What comes in arrives
// through `mergeIntoProject`, File ▸ Import's own path — ids re-issued, media
// deduplicated by content, an identical comp imported twice reused, not
// copied — as ONE undo step of the agent's turn.

const ACCESS_OFF =
  "Reading the user's other projects is switched off. Ask them to turn on \"Agents can open your other projects\" in Agents ▸ Use your agent app — it stays off unless they choose it.";

function requireProjectAccess(): void {
  if (!useAgent.getState().settings.projectAccess) throw new ApiError(ACCESS_OFF);
}

/** A live project by id or exact name (case-insensitive). The open one is not "another". */
async function otherProject(ref: string): Promise<{ record: ProjectRecord; doc: MotionDocument }> {
  const live = (await listProjects()).filter((p) => !p.deletedAt);
  const want = ref.trim().toLowerCase();
  const record = live.find((p) => p.id === ref) ?? live.find((p) => p.name.trim().toLowerCase() === want);
  if (!record) throw new ApiError(`No project "${ref}" on this device.`, "project.list shows them.");
  if (record.id === useAppShell.getState().currentProjectId) throw new ApiError(`"${record.name}" is the project that is open.`, "Its comps are already here: doc.overview.");
  const doc = await getProjectDocument(record.id);
  if (!doc) throw new ApiError(`"${record.name}" has no document to read.`);
  return { record, doc };
}

/** The comps a person would call the project's own: on a page, not a layer's private inside. */
const rootComps = (doc: MotionDocument) => doc.frames.filter((f) => !isInternalPage(f.pageId) && !compOwnerNested(doc, f.id));

/** What a project holds, comp by comp — what `project.list {id}` and `project.open` answer with. */
const compSummary = (doc: MotionDocument) =>
  rootComps(doc).map((f) => ({
    id: f.id,
    name: f.name,
    size: [f.width, f.height],
    durationMs: Math.round(frameDurationMs(doc, f)),
    layers: doc.tracks.reduce((n, t) => n + t.clips.filter((c) => c.frameId === f.id).length, 0),
    ...(f.component ? { component: true } : {}),
  }));

const projectList = defineCommand({
  id: "project.list",
  summary: "The user's OTHER projects on this device (needs their OK in settings) — with `id`, what one holds: its comps, components and media, to bring in with project.import.",
  details: "Newest first. The open project is marked `open`. Reads only; another project is never changed.",
  effect: "read",
  input: z.object({
    id: z.string().optional().describe("A project (id or exact name) to look inside."),
  }),
  async run(input) {
    requireProjectAccess();
    if (input.id) {
      const { record, doc } = await otherProject(input.id);
      return {
        project: { id: record.id, name: record.name },
        comps: compSummary(doc),
        media: doc.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
      };
    }
    const open = useAppShell.getState().currentProjectId;
    const projects = (await listProjects())
      .filter((p) => !p.deletedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100)
      .map((p) => ({ id: p.id, name: p.name, updated: new Date(p.updatedAt).toISOString().slice(0, 16), size: [p.width, p.height], ...(p.id === open ? { open: true } : {}) }));
    return { projects };
  },
});

/** A file source was named (localPath, its bytes, an attachment or a url). */
const namesFile = (input: FileSource) => !!(input.localFile || input.localPath || input.attachmentId || input.url);

/** What one project file holds, read for merging: the document, its media bytes, its fonts. */
type Incoming = Awaited<ReturnType<typeof readBundleForImport>> & { from: string };

const projectImport = defineCommand({
  id: "project.import",
  summary: `Copy comps (with everything they use: nested comps, components, media, variables) or media into the open project — from another of the user's projects, or from a project file (${PROJECT_FILE_EXTS}) on your machine, attached, or at a URL.`,
  details:
    "Give `from` (a project id or exact name, project.list) or a file (`localPath`, `attachmentId` or `url`). `comps` names comps by id or name and `media` media items; from a file, leaving both out brings every comp it has. Ids are re-issued; media already here (same file) and a comp imported before are reused, not duplicated. One undo step. Returns the new comp ids and media ids. To work IN a file instead of copying from it, project.open.",
  effect: "write",
  input: z.object({
    from: z.string().optional(),
    ...fileSourceInput,
    comps: z.array(z.string()).optional(),
    media: z.array(z.string()).optional(),
  }),
  async run(input, rt) {
    if (!!input.from === namesFile(input)) throw new ApiError("Name one source: `from` (another project) or a file (localPath, attachmentId or url).");
    let incoming: Incoming;
    if (input.from) {
      requireProjectAccess();
      if (!input.comps?.length && !input.media?.length) throw new ApiError("Nothing to bring.", "Name `comps` or `media` (project.list {id} shows what it holds).");
      const { record, doc } = await otherProject(input.from);
      // Its bytes are in this device's media store already, under its own ids (read below).
      incoming = { doc, assetBlobs: new Map(), fonts: [], from: record.name };
    } else {
      const file = await fileFromSource(input);
      incoming = { ...(await readBundleForImport(file)), from: file.name };
    }
    const everything = !input.comps?.length && !input.media?.length;
    return bringIn(rt, incoming, everything ? rootComps(incoming.doc).map((f) => f.id) : (input.comps ?? []), input.media ?? []);
  },
});

/**
 * Merge the named comps (with everything they reach) and media of a document
 * into the open project, through `mergeIntoProject` — File ▸ Import's own path.
 */
async function bringIn(rt: CommandRuntime, src: Incoming, compRefs: readonly string[], mediaRefs: readonly string[]) {
  const { doc, from } = src;
  const pick = <T extends { id: string; name: string }>(all: readonly T[], refs: readonly string[], what: string) =>
    refs.map((ref) => {
      const hit = all.find((x) => x.id === ref) ?? all.find((x) => x.name.trim().toLowerCase() === ref.trim().toLowerCase());
      if (!hit) throw new ApiError(`"${from}" has no ${what} "${ref}".`, `It has: ${all.map((x) => x.name).slice(0, 30).join(", ") || "none"}.`);
      return hit;
    });
  const comps = pick(doc.frames, compRefs, "comp");
  const media = pick(doc.assets, mediaRefs, "media");
  if (!comps.length && !media.length) throw new ApiError(`"${from}" has no comps or media to bring.`);

  // Comps come with everything they reach (the export slice); media alone ride an empty shell.
  const incoming: MotionDocument = comps.length
    ? sliceDocument(doc, { frameIds: comps.map((f) => f.id) }, ENGINE.ns)
    : { ...doc, pages: [], frames: [], tracks: [], variables: [], expressions: [], markers: [], trackers: [], customSounds: [], mediaFolders: [], assets: [] };
  for (const a of media) if (!incoming.assets.some((x) => x.id === a.id)) incoming.assets.push(structuredClone(a));

  const assetBlobs = new Map<string, Blob>();
  const missing: string[] = [];
  for (const a of incoming.assets) {
    // The file's own bytes, else this device's under that id (another project, a same-device .json).
    const blob = src.assetBlobs.get(a.id) ?? (await getAssetBlob(a.id));
    if (blob) assetBlobs.set(a.id, blob);
    else missing.push(a.name);
  }

  const merged = await mergeIntoProject({ doc: rt.doc, write: (label, recipe) => void rt.write(label, recipe) }, incoming, {
    assetBlobs,
    fonts: src.fonts,
    label: `Bring in from ${from}`,
  });
  return {
    from,
    comps: merged.rootFrameIds.map((id) => ({ id, name: rt.doc().frames.find((f) => f.id === id)?.name ?? id, ...(merged.addedRoots.includes(id) ? {} : { reused: true }) })),
    media: incoming.assets.map((a) => ({ id: merged.assetIdMap[a.id] ?? a.id, name: a.name })),
    ...(missing.length ? { missingMedia: missing, note: "These are listed but their files are not in the source or on this device." } : {}),
  };
}

// ── Opening another project ─────────────────────────────────────────────────
//
// An agent may change which project is open, in front of the person: one of
// theirs (the same switch as reading them) or a project file, which becomes a
// NEW project on this device and reads nothing of theirs. It goes through the
// app's one door (`makeResident`), which saves the project being left first,
// so nothing is lost. The link belongs to the tab, not the project, and an
// open is an in-page route, so the agent's link and turn carry straight on.
// The person is told who opened what, with one click back.

/** How long an open by id may take before the call gives up (the loader's own deadline is 15 s). */
const OPEN_WAIT_MS = 20_000;

/** Resolves once `id` is the open project; rejects when the open ends anywhere else. */
function whenOpened(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const s = useAppShell.getState();
      if (s.currentProjectId === id && s.pendingProjectId === null && s.view === "editor") return done(resolve);
      if (s.pendingProjectId !== id && s.currentProjectId !== id) done(() => reject(new ApiError("The project did not open.", "The editor says why in its status bar; project.list shows what is on this device.")));
    };
    const timer = setTimeout(() => done(() => reject(new ApiError("The project took too long to open."))), OPEN_WAIT_MS);
    const unsub = useAppShell.subscribe(check);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      unsub();
      fn();
    };
    check();
  });
}

const projectOpen = defineCommand({
  id: "project.open",
  summary: `Make another project the open one, in front of the user: one of their projects (\`id\`, needs their OK in settings), or a project file (${PROJECT_FILE_EXTS}) — on your machine, attached, or at a URL — opened as a NEW project.`,
  details:
    "The project you leave is saved first, and your link stays; every call after this works in the opened project, so ids from the previous one no longer resolve. The user sees the switch and can go back with one click. Returns the project and its comps. To copy comps INTO the open project instead, project.import.",
  effect: "write",
  input: z.object({
    id: z.string().optional().describe("One of the user's projects (id or exact name, project.list)."),
    ...fileSourceInput,
  }),
  async run(input, rt) {
    if (!!input.id === namesFile(input)) throw new ApiError("Name one project: `id` (one of the user's) or a file (localPath, attachmentId or url).");
    const left = { id: useAppShell.getState().currentProjectId, name: rt.doc().name };
    let missing: string[] = [];
    if (input.id) {
      requireProjectAccess();
      const { record } = await otherProject(input.id);
      useAppShell.getState().openProject(record.id);
      await whenOpened(record.id);
    } else {
      const file = await fileFromSource(input);
      const opened = await openFileAsProject(rt.store, file);
      missing = opened.missingAssetIds;
    }
    const doc = rt.doc();
    const id = useAppShell.getState().currentProjectId;
    toast.info(`${rt.actor} opened “${doc.name}”`, {
      ...(left.id ? { action: { label: `Back to “${left.name}”`, onClick: () => useAppShell.getState().openProject(left.id!) } } : {}),
    });
    return {
      project: { id, name: doc.name },
      ...(left.id ? { left: left } : {}),
      comps: compSummary(doc),
      ...(missing.length ? { missingMedia: missing.map((a) => doc.assets.find((x) => x.id === a)?.name ?? a), note: "These are listed in the file but their media was not embedded." } : {}),
    };
  },
});

/**
 * THE AGENT'S PUBLISH — the open project onto the library's Community shelf,
 * through the same bundle, poster and request as Library ▸ Publish
 * (`library/publish.ts`), under the publisher keypair already saved on this
 * device. No keypair, no publish: an agent never holds or types a secret.
 *
 * It writes the item into the content repo the dev server points at; shipping
 * it to everyone is `pnpm library:publish` on that machine. Republishing the
 * same name replaces the item (a new version: copies made from the old one
 * stay theirs).
 */
const projectPublish = defineCommand({
  id: "project.publish",
  summary: "Publish the open project to the library's Community shelf as a template, under the publisher saved in this app.",
  details:
    "Outward-facing: ask the user before you call it. The card's poster is `frameId` at `atMs` (default: the comp the project opens on, at 0) — make that a still cover. Tag `heavy` when the project is expensive to render: its card then stays still on hover. Writes into the content repo; `pnpm library:publish` on the developer's machine ships it.",
  effect: "read",
  input: z.object({
    name: z.string().min(1).optional().describe("The card's title; default the project's name."),
    blurb: z.string().max(140).describe("One line under the title."),
    tags: z.array(z.string()).default([]),
    description: z.string().optional(),
    pack: z.string().default("community").describe("A pack this publisher owns (`community` is the shelf)."),
    frameId: z.string().optional().describe("The comp the poster is taken from."),
    atMs: z.number().min(0).default(0),
  }),
  async run(input, rt) {
    const publisher = getPublisher();
    if (!publisher) throw new ApiError("No publisher is saved in this app.", "Ask the user to publish once from Library ▸ Publish (it remembers their id and secret), then call this again.");
    const { available, packs } = await publisherPacks(publisher);
    if (!available) throw new ApiError("This app cannot publish: its server has no content repo.", "Publishing runs on the developer's machine (LIBRARY_CONTENT_DIR).");
    const pack = packs.find((p) => p.id === input.pack);
    if (!pack) throw new ApiError(`"${input.pack}" is not a pack this publisher owns.`, `Owned: ${packs.map((p) => p.id).join(", ") || "none"}.`);
    if (pack.kind !== "template") throw new ApiError(`"${pack.id}" holds ${pack.kind}s, not projects.`);
    await flushSurfaces();
    const doc = rt.doc();
    const frameId = input.frameId ?? landingFrameId(doc);
    const frame = doc.frames.find((f) => f.id === frameId);
    if (!frame) throw new ApiError(`No comp ${frameId}.`, "doc.overview lists them.");
    const name = (input.name ?? doc.name).trim();
    const { blob, poster } = await bundleProject(doc, frame, input.atMs);
    const tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase().replace(/^#/, "")).filter(Boolean))];
    const res = await sendToLibrary(
      publisher,
      { id: pack.id, title: pack.title, kind: "template" },
      { fileName: `${slug(name)}.motion`, name, tags, blurb: input.blurb.trim() || null, description: input.description?.trim() || null },
      blob,
      poster,
    );
    toast.info(`${rt.actor} published “${name}” to ${pack.title}`);
    return {
      ...res,
      bytes: blob.size,
      poster: poster ? { from: frame.name, atMs: input.atMs, size: [poster.width, poster.height] } : null,
      next: "Written to the content repo. `pnpm library:publish` in the app's repo ships it to everyone.",
    };
  },
});

export const projectCommands: AnyCommand[] = [projectSave, projectList, projectImport, projectOpen, projectPublish];
