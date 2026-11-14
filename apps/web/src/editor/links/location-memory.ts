"use client";
import { NAMES } from "@/editor/names";

/**
 * WHERE YOU WERE, per project — the last location the app stood at in each
 * one, as a canonical route path (ADR-links, "Location").
 *
 * The URL is one projection of where you are; it is not the memory of it. A
 * desktop window has no address bar, switching project tabs swaps the whole
 * document, and opening a project from Home starts from a bare `/project/<id>`
 * — in each of those the place you left was gone. Kept here, every arrival can
 * come back to it, on every platform. Per-viewer convenience, so browser
 * storage is the right home: a cleared one just means "the first page".
 */

const KEY = NAMES.storage.locations;
/** Projects remembered; the least recently visited fall off. */
const CAP = 60;

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function rememberLocation(projectId: string, path: string): void {
  try {
    const all = read();
    if (all[projectId] === path) return;
    delete all[projectId];
    all[projectId] = path; // insertion order = recency
    const ids = Object.keys(all);
    for (const id of ids.slice(0, Math.max(0, ids.length - CAP))) delete all[id];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: nothing to remember with */
  }
}

export function rememberedLocation(projectId: string): string | null {
  return read()[projectId] ?? null;
}
