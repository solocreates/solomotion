"use client";

import {
  adoptDeviceSound as adoptDeviceSoundCore,
  soundCatalog as soundCatalogCore,
  type MotionDocument,
  type CustomSoundRef,
  type DocumentStore,
  type SoundOption,
} from "@solomotion/core";
import { listAppSounds } from "./app-sounds";

/**
 * The web binding of the headless sound catalogue: it supplies the one thing
 * core cannot know — where this DEVICE keeps its saved sounds (localStorage
 * here; a file in the desktop shell). Everything else about "what sounds can
 * this project play" lives in `@solomotion/core`, so the exporter and any future
 * worker see the same list.
 */

export { SOUND_GROUP_LABELS, soundOptionId } from "@solomotion/core";
export type { SoundGroup, SoundOption } from "@solomotion/core";

export function soundCatalog(doc: MotionDocument): SoundOption[] {
  return soundCatalogCore(doc, listAppSounds());
}

export function adoptDeviceSound(store: DocumentStore, option: SoundOption): CustomSoundRef | null {
  return adoptDeviceSoundCore(store, option, listAppSounds());
}
