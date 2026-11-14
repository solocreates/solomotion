import { ANIMATION_PRESETS } from "../animation/presets";
import { TRANSITION_PRESETS } from "../animation/transitions";
import { TEXT_TEMPLATES } from "../templates";
import { componentFrames } from "../components";
import { soundPackIdSchema, type MotionDocument } from "../schema";
import { SOUND_PACK_LABELS, type DeviceSound } from "../audio/sound-catalog";
import { dedupeBySubject, type LibraryItem, type LibrarySource } from "./item";
import type { LibrarySnapshot } from "./snapshot";
import { builtinTemplateItems, type TemplateSource } from "./template";

/**
 * THE LOCAL CATALOGUE — everything browsable that is already on this machine,
 * as `LibraryItem`s.
 *
 * This is the function that ends the five-tabs problem. Text looks, layer
 * animations, transitions, this project's components, this project's media and
 * every sound the app can play were six separate lists read by six separate
 * pieces of UI; here they are one list of one shape, which is why one card, one
 * search box and one drag controller can serve all of them — and why the online
 * catalogue slots in as more of the same rather than as a seventh thing.
 *
 * Pure and synchronous. `userItems` (components you saved on this device) come
 * in as an argument for exactly the reason `deviceSounds` do: where a device
 * keeps its own list is a platform question, and it is the only thing that ever
 * kept this brain out of core.
 */

/** A component the user saved on this device. The web binding persists these. */
export interface UserLibraryItem {
  id: string;
  name: string;
  /** A free-form category the user typed. Becomes a tag. */
  category: string;
  createdAt: number;
  snapshot: LibrarySnapshot;
  /** Set when this arrived from the online catalogue (see `LibraryItem.originId`). */
  originId?: string | null;
}

export interface LocalLibraryInput {
  doc: MotionDocument;
  userItems?: UserLibraryItem[];
  /** This device's saved sounds — the same list the sound picker reads. */
  deviceSounds?: DeviceSound[];
  /** The templates this build ships (`@solomotion/templates`) — passed in, like sounds. */
  templates?: readonly TemplateSource[];
}

const tag = (s: string) => s.toLowerCase().trim();

/** Built-in text looks — a whole styled, animated layer. */
export function builtinTextItems(): LibraryItem[] {
  return TEXT_TEMPLATES.map((t) => ({
    id: `builtin:text:${t.id}`,
    kind: "text" as const,
    name: t.name,
    // The look's own words come first: a facet rail is only useful if it holds
    // the vocabulary someone browses with, and "neon" or "subtitle" is what
    // they are actually after — not the word "template", which every one of a
    // hundred carries and therefore narrows nothing.
    tags: [tag(t.category), ...(t.tags ?? []).map(tag), "text"],
    blurb: t.tagline,
    source: "builtin" as const,
    publisher: null,
    preview: { type: "css" as const, animation: t.animations.in?.preset ?? "fade-up" },
    action: { type: "preset" as const, domain: "text" as const, presetId: t.id },
    blob: null,
    packId: null,
    originId: null,
    createdAt: null,
  }));
}

/** Built-in layer/text animations — a modifier, never a creator. */
export function builtinAnimationItems(): LibraryItem[] {
  return ANIMATION_PRESETS.map((p) => ({
    id: `builtin:animation:${p.id}`,
    kind: "animation" as const,
    name: p.label,
    // The CATEGORY leads, exactly as it does for transitions and text looks —
    // it is what someone browsing is actually looking for.
    //
    // Scope is tagged only when it RESTRICTS. A preset that works anywhere used
    // to carry the tag "any", which sat at the head of every facet rail (it is
    // the most common tag there is) reading like a second "All" and narrowing
    // nothing. Presence is the override, absence is the default — the same rule
    // scope overlays already follow everywhere else in the document.
    tags: [
      tag(p.category),
      ...(p.scope === "layer" ? ["layer-only"] : p.scope === "text" ? ["text-only"] : []),
      "animation",
    ],
    blurb: p.tagline ?? null,
    source: "builtin" as const,
    publisher: null,
    preview: { type: "css" as const, animation: p.id },
    action: { type: "preset" as const, domain: "animation" as const, presetId: p.id },
    blob: null,
    packId: null,
    originId: null,
    createdAt: null,
  }));
}

/** Built-in cut transitions. */
export function builtinTransitionItems(): LibraryItem[] {
  return TRANSITION_PRESETS.map((p) => ({
    id: `builtin:transition:${p.id}`,
    kind: "transition" as const,
    name: p.label,
    tags: [tag(p.category), "transition"],
    blurb: p.tagline ?? null,
    source: "builtin" as const,
    publisher: null,
    preview: { type: "css" as const, animation: p.id },
    action: { type: "preset" as const, domain: "transition" as const, presetId: p.id },
    blob: null,
    packId: null,
    originId: null,
    createdAt: null,
  }));
}

/** The synthesized sound packs. Zero bytes, always available, offline. */
export function builtinSoundItems(): LibraryItem[] {
  return soundPackIdSchema.options.map((pack) => ({
    id: `builtin:sound:${pack}`,
    kind: "sound" as const,
    name: SOUND_PACK_LABELS[pack],
    tags: ["pack", "synth", tag(SOUND_PACK_LABELS[pack])],
    blurb: null,
    source: "builtin" as const,
    publisher: null,
    // Synthesized: there is nothing to publish a waveform OF until it is
    // rendered, and rendering it is the app's job — so it draws itself.
    preview: { type: "render" as const },
    action: { type: "sound" as const, pack, assetId: null, hitMs: 0 },
    blob: null,
    packId: null,
    originId: null,
    createdAt: null,
  }));
}

/** Live component definitions in THIS document. Clicking opens, dragging places. */
export function projectComponentItems(doc: MotionDocument): LibraryItem[] {
  return componentFrames(doc).map((f) => ({
    id: `project:component:${f.id}`,
    kind: "component" as const,
    name: f.name,
    tags: ["component"],
    blurb: null,
    source: "project" as const,
    publisher: null,
    preview: { type: "render" as const },
    action: { type: "instance" as const, frameId: f.id },
    blob: null,
    packId: null,
    originId: null,
    createdAt: null,
  }));
}

/** Imported media in this document. Audio doubles as a sound, below. */
export function projectMediaItems(doc: MotionDocument): LibraryItem[] {
  return doc.assets.map((a) => ({
    id: `project:media:${a.id}`,
    kind: "media" as const,
    name: a.name,
    tags: [a.kind, "media"],
    blurb: null,
    source: "project" as const,
    publisher: null,
    preview: { type: "render" as const },
    action: { type: "asset" as const, assetId: a.id },
    blob: null,
    packId: null,
    originId: null,
    createdAt: null,
  }));
}

/**
 * Sounds this project has adopted — the ones a voice can already point at.
 * A project sound and its media-library twin are the same bytes; the adopted
 * entry wins, because it is the one that carries a hit point.
 */
export function projectSoundItems(doc: MotionDocument): LibraryItem[] {
  const out: LibraryItem[] = [];
  const seen = new Set<string>();
  for (const s of doc.customSounds) {
    seen.add(s.assetId);
    out.push({
      id: `project:sound:${s.assetId}`,
      kind: "sound",
      name: s.name,
      tags: ["sound"],
      blurb: null,
      source: "project",
      publisher: null,
      preview: { type: "render" },
      action: { type: "sound", pack: null, assetId: s.assetId, hitMs: s.hitMs },
      blob: null,
      packId: null,
      originId: null,
      createdAt: null,
    });
  }
  for (const a of doc.assets) {
    if (a.kind !== "audio" || seen.has(a.id)) continue;
    out.push({
      id: `project:sound:${a.id}`,
      kind: "sound",
      name: a.name,
      tags: ["sound", "imported"],
      blurb: null,
      source: "project",
      publisher: null,
      preview: { type: "render" },
      action: { type: "sound", pack: null, assetId: a.id, hitMs: 0 },
      blob: null,
      packId: null,
      originId: null,
      createdAt: null,
    });
  }
  return out;
}

/** Components the user saved on this device, across every project. */
export function userItems(items: UserLibraryItem[]): LibraryItem[] {
  return items.map((c) => ({
    id: `user:component:${c.id}`,
    kind: "component" as const,
    name: c.name,
    tags: [tag(c.category), "component", "saved"].filter(Boolean),
    blurb: null,
    source: (c.originId ? "downloaded" : "user") as LibrarySource,
    publisher: null,
    preview: { type: "render" as const },
    action: { type: "snapshot" as const, snapshot: c.snapshot },
    blob: null,
    packId: null,
    originId: c.originId ?? null,
    createdAt: c.createdAt,
  }));
}

/**
 * Sounds saved DEVICE-wide, across every project. This is also where a
 * downloaded library sound lands — adopting one into the device list is what
 * "downloaded" means for a sound, so there is no second store to keep in step.
 */
export function deviceSoundItems(sounds: DeviceSound[]): LibraryItem[] {
  return sounds.map((s) => ({
    id: `device:sound:${s.id}`,
    kind: "sound" as const,
    name: s.name,
    tags: ["sound", ...(s.tags ?? [])].map(tag),
    blurb: null,
    source: (s.originId ? "downloaded" : "user") as LibrarySource,
    publisher: null,
    preview: s.peaks
      ? {
          type: "peaks" as const,
          peaks: s.peaks,
          durationMs: s.durationMs ?? 0,
          hitMs: s.hitMs,
          loudnessDb: s.loudnessDb ?? null,
        }
      : { type: "render" as const },
    action: { type: "sound" as const, pack: null, assetId: s.id, hitMs: s.hitMs },
    blob: null,
    packId: null,
    originId: s.originId ?? null,
    createdAt: null,
  }));
}

/**
 * Everything local, one list. The browser renders this; the online client's
 * results are concatenated on top and ranked by the same matcher.
 */
export function localLibrary(input: LocalLibraryInput): LibraryItem[] {
  const { doc, userItems: saved = [], deviceSounds = [], templates = [] } = input;
  // ORDER IS PRECEDENCE. Two providers can answer for one subject — adopting a
  // device sound into a document makes the project's sound provider list the
  // same asset — and `dedupeBySubject` keeps the first. Device and user entries
  // come first because they carry the hit point and the published peaks that
  // the bare project asset does not.
  return dedupeBySubject([
    ...userItems(saved),
    ...deviceSoundItems(deviceSounds),
    ...projectComponentItems(doc),
    ...builtinTextItems(),
    ...builtinAnimationItems(),
    ...builtinTransitionItems(),
    ...builtinSoundItems(),
    ...builtinTemplateItems(templates),
    ...projectSoundItems(doc),
    ...projectMediaItems(doc),
  ]);
}
