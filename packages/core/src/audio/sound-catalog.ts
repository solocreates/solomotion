import { createId } from "../ids";
import type { DocumentStore } from "../history/document-store";
import type { MotionDocument, CustomSoundRef, SoundPackId, SoundVoice } from "../schema";
import { soundPackIdSchema } from "../schema";

/**
 * A sound saved DEVICE-wide (outside any document). Where that list is kept is
 * a platform question — localStorage on the web, a file in the desktop shell —
 * so the catalogue takes it as an argument rather than reaching for `window`.
 * That is the only thing that kept this brain out of core.
 */
export interface DeviceSound {
  id: string;
  name: string;
  hitMs: number;
  mime: string;
  bytes: number;
  durationMs: number | null;
  /** Free tags — carried over from the library entry a download came from. */
  tags?: string[];
  /** Published waveform, so a card draws before the bytes are decoded. */
  peaks?: number[] | null;
  /**
   * Measured perceived loudness in dB. Kept alongside the peaks because the
   * ear guard needs it to audition a sound you already own, exactly as it
   * needs the manifest's copy for one you do not.
   */
  loudnessDb?: number | null;
  /** The online library item this was downloaded from (`LibraryItem.originId`). */
  originId?: string | null;
}

/** Display names for the synthesized packs — the one place they are spelled. */
export const SOUND_PACK_LABELS: Record<SoundPackId, string> = {
  mechanical: "Mechanical",
  soft: "Soft",
  vintage: "Vintage",
  thock: "Thock",
  digital: "Digital",
  pop: "Pop",
  marimba: "Marimba",
  kalimba: "Kalimba",
  glass: "Glass",
  pluck: "Pluck",
  wood: "Wood",
};

/**
 * THE catalogue of selectable sounds.
 *
 * A hit sound could come from four places — a synth pack, this project's saved
 * sounds, the device-wide library, or any audio asset sitting in the media
 * library — and each place used to be discovered separately at the one call
 * site that cared, with the media library not discovered at all. Here they are
 * ONE list of one shape, so a picker (or a preset browser, or a plugin) asks a
 * single question and gets every sound the app can play.
 *
 * Headless on purpose: no React, no canvas. The UI decides how to draw a row;
 * this decides what the rows ARE.
 */

export type SoundGroup = "packs" | "project" | "device" | "library";

export const SOUND_GROUP_LABELS: Record<SoundGroup, string> = {
  packs: "Built-in packs",
  project: "This project",
  device: "All my projects",
  library: "Media library",
};

export interface SoundOption {
  /** Stable selection key: `pack:<id>` or `asset:<assetId>`. */
  id: string;
  group: SoundGroup;
  name: string;
  /** Exactly one of these is set — packs synthesize, everything else decodes. */
  pack: SoundPackId | null;
  assetId: string | null;
  /** ms into the file where the sound strikes (0 for packs, which start at 0). */
  hitMs: number;
  durationMs: number | null;
  /**
   * True when choosing this option must first pull the sound into the project
   * (adopt a device sound, or give a library asset a hit point). The picker
   * uses it to decide between "select" and "open the hit-point editor".
   */
  needsAdoption: boolean;
}

/** The selection key for whatever a voice currently points at. */
export function soundOptionId(
  value: Pick<SoundVoice, "pack" | "custom">,
): string {
  return value.custom ? `asset:${value.custom.assetId}` : `pack:${value.pack}`;
}

/**
 * Every sound this document can play right now, in display order. Sounds
 * already adopted by the project WIN over their device/library twins — the same
 * bytes must never appear twice under two names.
 */
export function soundCatalog(doc: MotionDocument, deviceSounds: DeviceSound[] = []): SoundOption[] {
  const out: SoundOption[] = [];
  const seen = new Set<string>();
  const take = (o: SoundOption) => {
    if (seen.has(o.id)) return;
    seen.add(o.id);
    out.push(o);
  };

  for (const pack of soundPackIdSchema.options) {
    take({
      id: `pack:${pack}`,
      group: "packs",
      name: SOUND_PACK_LABELS[pack],
      pack,
      assetId: null,
      hitMs: 0,
      durationMs: null,
      needsAdoption: false,
    });
  }

  for (const s of doc.customSounds) {
    const asset = doc.assets.find((a) => a.id === s.assetId);
    take({
      id: `asset:${s.assetId}`,
      group: "project",
      name: s.name,
      pack: null,
      assetId: s.assetId,
      hitMs: s.hitMs,
      durationMs: asset?.durationMs ?? null,
      needsAdoption: false,
    });
  }

  for (const s of deviceSounds) {
    take({
      id: `asset:${s.id}`,
      group: "device",
      name: s.name,
      pack: null,
      assetId: s.id,
      hitMs: s.hitMs,
      durationMs: s.durationMs,
      // The bytes are on this device but the DOCUMENT doesn't know about them
      // yet; picking one has to write the asset entry so the project stays
      // self-contained (and exports/opens elsewhere).
      needsAdoption: true,
    });
  }

  for (const a of doc.assets) {
    if (a.kind !== "audio") continue;
    take({
      id: `asset:${a.id}`,
      group: "library",
      name: a.name,
      pack: null,
      assetId: a.id,
      hitMs: 0,
      durationMs: a.durationMs,
      // An imported track has no hit point yet — the moment it strikes is a
      // judgement call, so picking one opens the same editor an import does.
      needsAdoption: true,
    });
  }

  return out;
}

/**
 * Adopt a DEVICE sound into this document: copy its metadata into `assets` and
 * register it under `customSounds`, pointing at the same blob id. Returns the
 * ref to select. Library assets are NOT handled here — they need a hit point,
 * which is a decision, not a copy.
 */
export function adoptDeviceSound(
  store: DocumentStore,
  option: SoundOption,
  deviceSounds: DeviceSound[],
): CustomSoundRef | null {
  if (option.group !== "device" || !option.assetId) return null;
  const app = deviceSounds.find((s) => s.id === option.assetId);
  if (!app) return null;
  let ref: CustomSoundRef = { assetId: app.id, hitMs: app.hitMs };
  store.update("Use custom sound", (d) => void (ref = adoptDeviceSoundInto(d, app)));
  return ref;
}

/**
 * The DOCUMENT half of adopting a device sound — for a caller that writes
 * through its own transaction (an agent's command is one undo step under its
 * own name). Idempotent: an asset or registration already there is kept.
 */
export function adoptDeviceSoundInto(d: MotionDocument, app: DeviceSound): CustomSoundRef {
  if (!d.assets.some((a) => a.id === app.id)) {
    d.assets.push({
      id: app.id,
      kind: "audio",
      name: app.name,
      mime: app.mime,
      bytes: app.bytes,
      width: null,
      height: null,
      durationMs: app.durationMs,
      fps: null,
      folderId: null,
      origin: null,
    });
  }
  if (!d.customSounds.some((c) => c.assetId === app.id)) {
    d.customSounds.push({
      id: createId("csnd"),
      name: app.name,
      assetId: app.id,
      hitMs: app.hitMs,
    });
  }
  return { assetId: app.id, hitMs: app.hitMs };
}
