"use client";

import {
  buildTemplateDocument,
  instantiateTemplate,
  type MotionDocument,
  type DocumentStore,
  type LibraryItem,
  type TemplateSource,
} from "@solomotion/core";
import { BUILTIN_TEMPLATES } from "@solomotion/templates";
import { toast } from "@/lib/toast";
import { putAssetBlob } from "../assets/asset-store";
import { readBundleForImport } from "../io/motion-file";
import { installCustomFontBytes } from "../stage/render/fonts";
import { ensureDocumentFaces } from "../stage/render/system-fonts";
import { makeResident, type ProjectOrigin } from "../state/project-index";
import { createProject, createProjectId } from "../state/project-store";
import { libraryClient } from "./client";
import { ENGINE } from "@/editor/names";

/**
 * TEMPLATES IN THE APP — the one place a template becomes a project.
 *
 * A built-in is built from its script through the APP's registry (so the Test
 * Voice's `generate.speech` is there and the project opens talking); an online
 * one is a `.motion` bundle whose ids are all reissued on the way in. Either
 * way the result is saved as a new project and opened — a template never edits
 * the project you have open.
 */

/**
 * WHICH built-in templates the app offers, by id. Since 4.16 it offered none:
 * Playground and Talking characters dropped people into a project of nested
 * demos before they had made anything. Showcases like the Material library
 * ship as COMMUNITY templates instead (published projects, built from these
 * scripts). The bundle still ships them all (the mouth packs read its art);
 * offering one here is adding its id.
 *
 * The Home row, the Library's Templates shelf and online (community)
 * templates show while the list has anything in it.
 */
const OFFERED_TEMPLATES: readonly string[] = [];

export const TEMPLATES_OFFERED = OFFERED_TEMPLATES.length > 0;

export const builtinTemplates: readonly TemplateSource[] = (BUILTIN_TEMPLATES as readonly TemplateSource[]).filter((t) => OFFERED_TEMPLATES.includes(t.id));

const sourceOf = (id: string) => builtinTemplates.find((t) => t.id === id) ?? null;

/**
 * The document a built-in's card draws: built once per session with core
 * verbs only — no voice is synthesized for a poster. Shared by every card and
 * the Home row, so a template builds at most once however often it is shown.
 */
const posters = new Map<string, Promise<MotionDocument | null>>();
export function templatePreviewDoc(id: string): Promise<MotionDocument | null> {
  let hit = posters.get(id);
  if (!hit) {
    const src = sourceOf(id);
    hit = src
      ? buildTemplateDocument(src)
          .then((b) => {
            ensureDocumentFaces(b.doc);
            return b.doc;
          })
          .catch(() => null)
      : Promise.resolve(null);
    posters.set(id, hit);
  }
  return hit;
}

function open(store: DocumentStore, doc: MotionDocument, origin: ProjectOrigin | null = null): void {
  const id = createProjectId();
  ensureDocumentFaces(doc);
  void createProject(id, doc, origin);
  makeResident(store, id, doc);
}

/** Make and open a new project from a built-in template. */
export async function newProjectFromTemplate(store: DocumentStore, templateId: string): Promise<void> {
  const src = sourceOf(templateId);
  if (!src) return;
  try {
    const { agentApi } = await import("../agent/runner");
    // Built fresh, so every id is already new — and the voice's bytes are
    // already filed under the asset ids this document names.
    const { doc } = await buildTemplateDocument(src, { api: agentApi() });
    doc.name = src.name;
    open(store, doc);
  } catch (err) {
    toast.error(`Couldn't make “${src.name}”`, { description: err instanceof Error ? err.message : String(err) });
  }
}

/** Fetch an online template's bundle and open a new project from it. True once it is open. */
export async function newProjectFromOnlineTemplate(
  store: DocumentStore,
  item: LibraryItem,
  origin: ProjectOrigin | null = null,
): Promise<boolean> {
  const client = libraryClient();
  if (!client || !item.blob) return false;
  try {
    const blob = await client.blob(item);
    const bundle = await readBundleForImport(new File([blob], `${item.name}.motion`, { type: "application/zip" }));
    const { doc, assetIdMap } = instantiateTemplate(bundle.doc, { ns: ENGINE.ns, name: item.name });
    // Bytes land under the NEW ids — never the bundle's, which another project may hold.
    for (const [from, to] of Object.entries(assetIdMap)) {
      const bytes = bundle.assetBlobs.get(from);
      if (bytes) await putAssetBlob(to, bytes);
    }
    for (const f of bundle.fonts) await installCustomFontBytes(f.family, f.fileName, f.data, { weight: f.weight, italic: f.italic });
    open(store, doc, origin);
    return true;
  } catch (err) {
    toast.error(`Couldn't open “${item.name}”`, { description: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
