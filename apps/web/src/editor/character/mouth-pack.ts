import { createComponentInstanceClip, internalPageId, makeSwitch, placeClip, type MotionDocument } from "@solomotion/core";
import { VISEME_ORDER, VISEMES, type VisemeId } from "@solomotion/lipsync";
import { svgToComponent } from "../assets/svg-import";

/**
 * MOUTH PACKS — drawn mouths a character talks with, one drawing per viseme.
 *
 * A pack is a FOLDER of `<VISEME>.svg` files inside a built-in template, so
 * the art has one home: Pip's mouths in Talking Characters are the "Pop"
 * pack, and fixing a drawing there fixes it here. Files share the lip-sync
 * convention (a 300 × 240 viewBox centred on the mouth), so shapes swap
 * without drift. The template bundle loads only when a mouth is added.
 *
 * Each drawing becomes a component through `svgToComponent` (the app's one
 * SVG bridge), tagged `pluginData["mouth.pack"] = "<pack>:<viseme>"` so a
 * second character reuses the first one's components instead of minting
 * nine more. Edit one and every mouth of that pack follows; Make unique
 * splits a character off.
 */

export interface MouthPack {
  id: string;
  name: string;
  /** The folder, in a built-in template's files, holding `<VISEME>.svg`. */
  folder: string;
}

export const MOUTH_PACKS: readonly MouthPack[] = [{ id: "pop", name: "Pop", folder: "talking-characters/art/pip/mouth/" }];

/** The width a pack is drawn at (its viewBox). */
export const MOUTH_PACK_WIDTH = 300;

const TAG = "mouth.pack";

export interface LoadedMouthPack {
  pack: MouthPack;
  svg: Record<VisemeId, string>;
}

/** A pack's drawings, read from the template bundle (a lazy chunk). */
export async function loadMouthPack(id: string = MOUTH_PACKS[0]!.id): Promise<LoadedMouthPack> {
  const pack = MOUTH_PACKS.find((p) => p.id === id) ?? MOUTH_PACKS[0]!;
  const { BUILTIN_TEMPLATES } = await import("@solomotion/templates");
  const files = Object.assign({}, ...BUILTIN_TEMPLATES.map((t) => t.files)) as Record<string, string>;
  const svg = {} as Record<VisemeId, string>;
  for (const v of VISEME_ORDER) {
    const text = files[`${pack.folder}${v}.svg`];
    if (!text) throw new Error(`Mouth pack "${pack.name}" has no ${v} drawing`);
    svg[v] = text;
  }
  return { pack, svg };
}

/** The pack's nine components in this document — reused when present, made when not. Mutates. */
function mouthComponents(doc: MotionDocument, { pack, svg }: LoadedMouthPack): Partial<Record<VisemeId, string>> {
  const pageId = internalPageId(doc);
  const onPage = doc.frames.filter((f) => f.pageId === pageId);
  const baseY = onPage.length ? Math.max(...onPage.map((f) => f.y + f.height)) + 120 : 0;
  const out: Partial<Record<VisemeId, string>> = {};
  VISEME_ORDER.forEach((v, i) => {
    const tag = `${pack.id}:${v}`;
    const existing = doc.frames.find((f) => f.component && f.pluginData[TAG] === tag);
    if (existing) {
      out[v] = existing.id;
      return;
    }
    const info = VISEMES[v];
    const id = svgToComponent(doc, svg[v], {
      name: `Mouth · ${info.name}`,
      pageId,
      component: { description: `${info.sounds}, as in “${info.example}”` },
      pluginData: { [TAG]: tag },
      x: (i % 3) * (MOUTH_PACK_WIDTH + 60),
      y: baseY + Math.floor(i / 3) * 300,
    });
    if (id) out[v] = id;
  });
  return out;
}

/**
 * Place a pack as a mouth: one instance per viseme at (x, y) in the comp,
 * named for its viseme, made a switch called "Mouth" showing rest — the
 * shape `character.bringToLife` reads as a mouth. Returns the switch id.
 * Mutates — call inside a store update.
 */
export function placeMouth(
  doc: MotionDocument,
  loaded: LoadedMouthPack,
  at: { frameId: string; startMs: number; durationMs: number; x: number; y: number; width: number },
): string | null {
  const parts = mouthComponents(doc, loaded);
  const scale = Math.max(0.05, at.width / MOUTH_PACK_WIDTH);
  const members: string[] = [];
  for (const v of VISEME_ORDER) {
    const art = parts[v];
    const inst = art ? createComponentInstanceClip(doc, art, { frameId: at.frameId, startMs: at.startMs, durationMs: at.durationMs, x: at.x, y: at.y }) : null;
    if (!inst) continue;
    inst.name = v;
    inst.transform.scale = scale;
    placeClip(doc, inst, { landing: "surface" });
    members.push(inst.id);
  }
  return makeSwitch(doc, members, { name: "Mouth", show: "X" });
}
