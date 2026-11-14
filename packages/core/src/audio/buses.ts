import { createId } from "../ids";
import type { MotionDocument, DuckRule, SoundBus, SoundCharacter, SoundTarget } from "../schema";
import { CHARACTER_TARGET_LUFS } from "./leveler";

/**
 * Sound CATEGORY operations — the one set of writes the inspector, the mixer
 * and the agent API all call, so "delete a category" cannot mean three things.
 * Mutating; call inside a document update.
 */

/** Colours new categories cycle through, clear of the built-ins'. */
const CUSTOM_BUS_COLORS = ["#ff7a90", "#f4d35e", "#4cc9f0", "#b8f28d", "#ff9f5a", "#9d8cff", "#6ee7d8"];

/** The loudness a category is levelled to: its own target, else its character's. */
export function busTargetLufs(bus: Pick<SoundBus, "targetLufs" | "character">): number {
  return bus.targetLufs ?? CHARACTER_TARGET_LUFS[bus.character];
}

export function findSoundBus(doc: MotionDocument, id: string | null | undefined): SoundBus | null {
  return id ? doc.soundBuses.find((b) => b.id === id) ?? null : null;
}

/** Add a project category. Returns its id. */
export function createSoundBus(
  doc: MotionDocument,
  input: { name: string; character?: SoundCharacter; color?: string },
): string {
  const id = createId("bus");
  const custom = doc.soundBuses.filter((b) => !b.builtIn).length;
  doc.soundBuses.push({
    id,
    name: input.name.trim() || "Category",
    character: input.character ?? "sfx",
    color: input.color ?? CUSTOM_BUS_COLORS[custom % CUSTOM_BUS_COLORS.length]!,
    volume: 1,
    muted: false,
    solo: false,
    audioEffects: [],
    ducking: [],
    targetLufs: null,
    builtIn: false,
  });
  return id;
}

/**
 * Remove a custom category. Everything routed to it falls back to its default
 * route, and every rule that ducked under it is dropped — a rule pointing at
 * nothing would silently do nothing, which is worse than being gone.
 */
export function deleteSoundBus(doc: MotionDocument, id: string): boolean {
  const bus = findSoundBus(doc, id);
  if (!bus || bus.builtIn) return false;
  doc.soundBuses = doc.soundBuses.filter((b) => b.id !== id);
  const pointsHere = (t: SoundTarget) => t.kind === "bus" && t.id === id;
  for (const b of doc.soundBuses) b.ducking = b.ducking.filter((r) => !pointsHere(r.under));
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (c.soundBus === id) delete c.soundBus;
      if (c.ducking) c.ducking = c.ducking.filter((r) => !pointsHere(r.under));
    }
  }
  return true;
}

/** Route clips into a category (null = back to their default route). */
export function setClipsSoundBus(doc: MotionDocument, clipIds: readonly string[], busId: string | null): void {
  const ids = new Set(clipIds);
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (!ids.has(c.id)) continue;
      if (busId) c.soundBus = busId;
      else delete c.soundBus;
    }
  }
}

/** A fresh ducking rule, tuned for the common case (music under a voice). */
export function makeDuckRule(under: SoundTarget, patch: Partial<Omit<DuckRule, "id" | "under">> = {}): DuckRule {
  return { id: createId("duck"), enabled: true, under, depthDb: 12, attackMs: 150, releaseMs: 500, ...patch };
}
