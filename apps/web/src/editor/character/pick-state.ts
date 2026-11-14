import { create } from "zustand";

/**
 * A FLAT PICTURE'S two clicks of placement (ux.md §1.3): `Click the mouth`,
 * then `Click each eye` (Enter skips, Esc cancels). Points are in the
 * picture's own comp space; the stage overlay (`PickLayer`) collects them.
 * `mouth` mode is the one click that gives an existing character a mouth.
 */
export interface CharacterPick {
  pictureId: string;
  mode: "picture" | "mouth";
  step: "mouth" | "eyes";
  mouth: { x: number; y: number } | null;
  eyes: Array<{ x: number; y: number; colour?: string }>;
}

export const useCharacterPick = create<{
  pick: CharacterPick | null;
  start: (pictureId: string, mode?: CharacterPick["mode"]) => void;
  cancel: () => void;
  set: (pick: CharacterPick | null) => void;
}>((set) => ({
  pick: null,
  start: (pictureId, mode = "picture") => set({ pick: { pictureId, mode, step: "mouth", mouth: null, eyes: [] } }),
  cancel: () => set({ pick: null }),
  set: (pick) => set({ pick }),
}));
