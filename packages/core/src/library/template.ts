import { createCommandApi } from "../api";
import type { CommandContext } from "../api/command";
import { runtimeFor, type CommandRegistry } from "../api/registry";
import { createEmptyDocument } from "../factories";
import { createDocumentStore } from "../history/document-store";
import { parseDocument, serializeDocument } from "../io";
import { reissueDocumentIds } from "../io/merge";
import type { MotionDocument } from "../schema";
import { findScript, saveScript } from "../scripts/files";
import { createdSince, docIds } from "../scripts/output";
import { scriptHere } from "../scripts/here";
import { runScriptInProcess } from "../scripts/run-in-process";
import type { LibraryItem } from "./item";

/**
 * TEMPLATES — a whole project as a library item.
 *
 * A template is not a new kind of data. It is a PROJECT, kept to be copied:
 * the same document the editor saves, the same `.motion` bundle the File menu
 * writes. "New from template" is open-a-copy with every id reissued
 * (`reissueDocumentIds`), so two projects made from one template never share
 * an id — above all an asset id, which keys the media bytes on a device.
 *
 * Where the document comes from is the one thing that varies:
 *
 *   builtin   SHIPS AS CODE: an the app script plus the files it reads (art),
 *             built in-process on first use (`buildTemplateDocument`). The
 *             build script travels inside the project it builds, so the person
 *             can open it in the Scripts panel, change a line and re-run —
 *             code and canvas are the same thing.
 *   online    a `.motion` bundle in the catalogue (manifest payload
 *             `template`), with a poster rendered by the editor at publish.
 *
 * Both are the same `LibraryItem` on the same shelf; a builtin has its action
 * (`template`), an online one is `null` until its bundle is fetched — and
 * fetching it IS using it, because the only thing a template is for is a new
 * project.
 */

/**
 * A template that ships in the app, as source. Generated from
 * `packages/templates` (`pnpm --filter @solomotion/templates bundle`); the
 * shape is plain data so that package needs nothing from core.
 */
export interface TemplateSource {
  id: string;
  name: string;
  blurb: string | null;
  tags: string[];
  /** Bumped by hand when the build changes what it makes (keys any cache). */
  version: number;
  /** Project path of the build script, e.g. `talking-characters/build.js`. */
  entry: string;
  /** Every file the project carries: the build script and what it reads. */
  files: Record<string, string>;
}

/** The library cards for the built-in templates. They draw themselves. */
export function builtinTemplateItems(sources: readonly TemplateSource[]): LibraryItem[] {
  return sources.map((t) => ({
    id: `builtin:template:${t.id}`,
    kind: "template" as const,
    name: t.name,
    tags: [...t.tags.map((x) => x.toLowerCase()), "template"],
    blurb: t.blurb,
    source: "builtin" as const,
    publisher: null,
    preview: { type: "render" as const },
    action: { type: "template" as const, templateId: t.id },
    blob: null,
    packId: null,
    originId: null,
    createdAt: null,
  }));
}

export interface BuiltTemplate {
  doc: MotionDocument;
  logs: string[];
  /** What the build script returned. */
  value: unknown;
}

/**
 * Build a built-in template's project: a fresh document, its files saved as
 * the project's scripts, its entry script run through the command registry —
 * exactly what pressing Run on that file does, minus the worker (it is our
 * code). The empty starter comp is dropped when the script built its own.
 *
 * `api` is the registry to build through — the app passes its own, which
 * carries the host verbs (the Test Voice's `generate.speech`); without one only
 * core verbs exist and the script builds what it can (a poster needs no voice).
 */
export async function buildTemplateDocument(source: TemplateSource, opts: { api?: CommandRegistry } = {}): Promise<BuiltTemplate> {
  const start = createEmptyDocument(source.name);
  const starterId = start.frames[0]!.id;
  // A build has no history to keep: the document leaves this function whole.
  const store = createDocumentStore(start, { history: false });
  const api = opts.api ?? createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "Template",
    historyKey: `template:${source.id}`,
    historyLabel: source.name,
    session: { focusFrameId: () => starterId, playheadMs: () => 0, selection: () => [] },
  };
  store.update("Template files", (d) => {
    for (const [path, text] of Object.entries(source.files)) saveScript(d, path, text);
  });
  const code = source.files[source.entry];
  if (code === undefined) throw new Error(`Template "${source.id}" has no entry file "${source.entry}".`);
  const before = docIds(store.getState());
  // Cooperative: the build hands the thread back between commands, so the Home
  // screen that asked for a poster (or the spinner on a card being opened)
  // keeps painting while a dozen scenes are made.
  const run = await runScriptInProcess(api, ctx, code, scriptHere(store.getState(), starterId), { yieldEveryMs: 12 });
  // The ledger a person's Run keeps: re-running the build in the Scripts panel
  // replaces what this run made instead of stacking a second Pip.
  const made = createdSince(before, store.getState());
  runtimeFor(ctx).write("Record script output", (d) => {
    const s = findScript(d, source.entry);
    if (s) s.output = made;
  });

  const doc = structuredClone(store.getState()) as MotionDocument;
  const starterUsed = doc.tracks.some((t) => t.clips.some((c) => c.frameId === starterId));
  if (!starterUsed && doc.frames.length > 1) {
    doc.frames = doc.frames.filter((f) => f.id !== starterId);
    doc.tracks = doc.tracks.filter((t) => t.homeCompId !== starterId);
  }
  // Validated and normalised the way any saved project is on open.
  return { doc: parseDocument(serializeDocument(doc)), logs: run.logs, value: run.value };
}

/**
 * The document a template is published as — the project itself, minus what
 * only means something on this machine (render-in-place records point at
 * this device's renders).
 */
export function captureTemplate(doc: MotionDocument): MotionDocument {
  const out = structuredClone(doc) as MotionDocument;
  out.renderedClips = {};
  return out;
}

/**
 * A NEW project from a template's document: every id reissued, named for
 * the person. `assetIdMap` (old → new) re-keys the media bytes; a builtin
 * template has none.
 */
export function instantiateTemplate(
  template: MotionDocument,
  opts: { ns: string; name?: string },
): { doc: MotionDocument; assetIdMap: Record<string, string> } {
  const { doc, assetIdMap } = reissueDocumentIds(template, opts.ns);
  if (opts.name) doc.name = opts.name;
  return { doc, assetIdMap };
}
