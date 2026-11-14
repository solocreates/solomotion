/// <reference path="../types/bidi-js.d.ts" />
import bidiFactory from "bidi-js";
import type { TextDirectionSetting } from "../schema/text-style";

/**
 * Thin, precisely-typed wrapper around `bidi-js` (untyped upstream) — the
 * ONLY file in the codebase that touches its raw API. Isolating it here also
 * papers over one real footgun in its own README: `getMirroredCharactersMap`
 * takes the raw `levels` typed array, NOT the `{levels, paragraphs}` result
 * object the README's example passes — verified empirically, passing the
 * wrapper silently returns an empty map. `getReorderSegments` is the
 * opposite: it wants the full result object (reads `.paragraphs`).
 */

// eslint-disable-next-line @typescript-eslint/no-unsafe-call
const bidi = bidiFactory() as {
  getEmbeddingLevels: (
    text: string,
    direction?: "ltr" | "rtl",
  ) => { levels: Uint8Array; paragraphs: Array<{ start: number; end: number; level: number }> };
  getMirroredCharactersMap: (text: string, levels: Uint8Array, start?: number, end?: number) => Map<number, string>;
  getReorderSegments: (
    text: string,
    embeddingLevels: { levels: Uint8Array; paragraphs: Array<{ start: number; end: number; level: number }> },
    start?: number,
    end?: number,
  ) => Array<[number, number]>;
};

export interface BidiInfo {
  text: string;
  embeddingLevels: ReturnType<typeof bidi.getEmbeddingLevels>;
  /** Code-unit index → mirrored replacement char (parens/brackets under RTL). */
  mirrored: Map<number, string>;
}

/**
 * Resolve bidi embedding levels + mirrored-character map for a whole text
 * block. "auto" lets bidi-js detect direction per paragraph (UAX #9 P2/P3 —
 * first strong character); "ltr"/"rtl" force every paragraph to that base
 * level, matching a user override.
 */
export function resolveBidi(text: string, direction: TextDirectionSetting): BidiInfo {
  const explicit = direction === "auto" ? undefined : direction;
  const embeddingLevels = bidi.getEmbeddingLevels(text, explicit);
  const mirrored = bidi.getMirroredCharactersMap(text, embeddingLevels.levels);
  return { text, embeddingLevels, mirrored };
}

/** True if the code unit at `index` resolved to an RTL (odd) embedding level. */
export function isRtlAt(info: BidiInfo, codeUnitIndex: number): boolean {
  return (info.embeddingLevels.levels[codeUnitIndex]! & 1) === 1;
}

/** The mirrored replacement character at `index`, if any (e.g. "(" → ")"). */
export function mirroredCharAt(info: BidiInfo, codeUnitIndex: number): string | undefined {
  return info.mirrored.get(codeUnitIndex);
}

/**
 * Ranges of code-unit indices [start, end] (inclusive) that must be reversed,
 * in order, to turn the logical-order substring [startCU, endCU] into visual
 * order. Callers process one line at a time (bidi-js's documented usage for
 * pre-wrapped text — reordering must happen per visual line, not per
 * paragraph, once soft-wrap has split a paragraph across lines).
 */
export function visualOrderRanges(info: BidiInfo, startCU: number, endCU: number): Array<[number, number]> {
  return bidi.getReorderSegments(info.text, info.embeddingLevels, startCU, endCU);
}

/**
 * First-strong-character base direction of a string (UAX #9 P2/P3), ignoring
 * any override — used only for a UI hint ("Auto (detected RTL)").
 */
export function detectBaseDirection(text: string): "ltr" | "rtl" {
  const level = bidi.getEmbeddingLevels(text).paragraphs[0]?.level ?? 0;
  return level % 2 === 1 ? "rtl" : "ltr";
}
