import {
  FEEL_PROFILES,
  shapeCues,
  type CueEdit,
  type MouthProfile,
  type SpeechTrack,
  type VisemeCue,
  type VisemeId,
  VISEME_IDS,
} from "@solomotion/lipsync";
import type { AssetSpeech, MotionDocument, Clip, SpeechEdit } from "../schema";
import { REST_VISEME } from "./types";

/**
 * LIP-SYNC FEEL — timing beats accuracy. The engine says WHAT was said; the
 * feel pass (`shapeCues`, the package's one pure function) says how a mouth
 * ACTS it: gate breaths, keep closures, bridge short gaps, round early, merge
 * flicker, apply the hand fixes, lead, snap. This module only CHOOSES its
 * options: the mouth's kind (derived from what drives it), the voice's Feel
 * preset and Energy knob, and its hand fixes — all settings, so changing feel
 * never re-analyses (docs/adr/characters/ux.md §3).
 */

export type MouthKind = MouthProfile;

export const LIP_SYNC_FEELS = ["natural", "snappy", "relaxed", "mumble", "shout"] as const;
export type LipSyncFeel = (typeof LIP_SYNC_FEELS)[number];

export function isLipSyncFeel(v: unknown): v is LipSyncFeel {
  return typeof v === "string" && (LIP_SYNC_FEELS as readonly string[]).includes(v);
}

/** Mumble's five shapes — every other viseme folds onto its nearest. */
const MUMBLE: Record<VisemeId, VisemeId> = { X: "X", MBP: "MBP", FV: "FV", AI: "AI", E: "AI", L: "AI", S: "AI", O: "O", U: "O" };

const KIND_RANK: Record<MouthKind, number> = { drawings: 0, morph: 1, bones: 2 };

/** The slowest of several kinds (a mixed mouth moves at its heaviest part's pace). */
export function slowestKind(kinds: Iterable<MouthKind>): MouthKind {
  let out: MouthKind = "drawings";
  for (const k of kinds) if (KIND_RANK[k] > KIND_RANK[out]) out = k;
  return out;
}

/** What a channel path moves: a shape-key weight morphs, a bone moves, anything else swaps. */
export function mouthKindOfPath(path: string): MouthKind {
  if (path.startsWith("key.")) return "morph";
  if (path.startsWith("bone.")) return "bones";
  return "drawings";
}

/**
 * The kind of mouth a layer is, DERIVED: a switch swaps drawings; a group with
 * pose sets is the slowest of what its viseme sets write (any set when none
 * names the visemes vocabulary). Never stored.
 */
export function mouthKindOf(clip: Clip): MouthKind {
  if (clip.kind !== "group") return "drawings";
  const sets = clip.poses ?? [];
  if (!sets.length) return "drawings";
  const voiced = sets.filter((s) => s.vocabulary === "visemes");
  const paths = (voiced.length ? voiced : sets).flatMap((s) => s.poses.flatMap((p) => p.values.map((v) => v.path)));
  return slowestKind(paths.map(mouthKindOfPath));
}

export interface FeelInput {
  kind: MouthKind;
  fps: number;
  speech?: AssetSpeech;
}

/** The package options for a feel — presets as offsets on the kind's defaults. */
function feelOptions({ kind, fps, speech }: FeelInput) {
  const base = FEEL_PROFILES[kind];
  const f = fps > 0 ? fps : 24;
  const frame = 1000 / f;
  const feel = isLipSyncFeel(speech?.feel) ? speech!.feel : "natural";
  let leadMs = base.leadMs;
  let minHoldMs = base.minHoldMs(f);
  let energy = 1;
  if (feel === "snappy") {
    leadMs -= 20;
    minHoldMs = Math.max(33, frame);
    energy = 1.1;
  } else if (feel === "relaxed") {
    leadMs += 10;
    minHoldMs = (minHoldMs + frame) * 1.5;
    energy = 0.8;
  } else if (feel === "mumble") {
    minHoldMs += frame;
    energy = 0.5;
  } else if (feel === "shout") {
    leadMs -= 10;
    energy = 1.4;
  }
  if (typeof speech?.energy === "number" && Number.isFinite(speech.energy)) energy *= Math.max(0, speech.energy);
  return { feel, leadMs, minHoldMs, energy };
}

const isViseme = (v: string): v is VisemeId => (VISEME_IDS as readonly string[]).includes(v);

/** The stored fixes in the package's shape (`X` → rest; unknown names dropped). */
export function cueEditsOf(speech: AssetSpeech | undefined): CueEdit[] {
  const out: CueEdit[] = [];
  for (const e of speech?.edits ?? []) {
    if (e.viseme === REST_VISEME || e.viseme === "rest") out.push({ startMs: e.startMs, endMs: e.endMs, viseme: "rest" });
    else if (isViseme(e.viseme)) out.push({ startMs: e.startMs, endMs: e.endMs, viseme: e.viseme });
  }
  return out;
}

const shaped = new WeakMap<SpeechTrack, Map<string, VisemeCue[]>>();

/**
 * A track's cues as THIS mouth acts them: cleaned, hand-fixed, led and snapped
 * — once per (track, kind, fps, feel, energy, fixes), then shared by every
 * frame. Pure in its inputs, so a scrub either way and an export agree.
 */
export function actedCues(track: SpeechTrack, input: FeelInput): VisemeCue[] {
  const opts = feelOptions(input);
  const edits = cueEditsOf(input.speech);
  const key = `${input.kind}|${input.fps}|${opts.feel}|${opts.leadMs}|${opts.minHoldMs}|${opts.energy}|${JSON.stringify(edits)}`;
  let byKey = shaped.get(track);
  if (!byKey) {
    byKey = new Map();
    shaped.set(track, byKey);
  }
  let cues = byKey.get(key);
  if (!cues) {
    const source = opts.feel === "mumble" ? track.cues.map((c) => ({ ...c, viseme: MUMBLE[c.viseme] })) : track.cues;
    cues = shapeCues(source, {
      profile: input.kind,
      fps: input.fps,
      leadMs: opts.leadMs,
      minHoldMs: opts.minHoldMs,
      energy: opts.energy,
      loudness: track.energy,
      edits,
      durationMs: track.durationMs,
    });
    byKey.set(key, cues);
  }
  return cues;
}

/** The Energy knob's effective gain under the voice's feel (what `loudness()` scales by). */
export function energyGain(speech: AssetSpeech | undefined): number {
  return feelOptions({ kind: "drawings", fps: 24, speech }).energy;
}

/** Does any clip in the doc drive a channel with a speech function? (Cheap; for gates and badges.) */
export function speechFunctionIn(doc: MotionDocument): boolean {
  return doc.expressions.some((e) => /\b(lipsync|speaking|loudness)\s*\(/.test(e.source));
}

// ── Hand fixes (source time; presence overrides) ─────────────────────────────

/** Add a fix over [startMs, endMs) — fixes it fully covers are replaced. Pure. */
export function withSpeechEdit(edits: readonly SpeechEdit[] | undefined, edit: SpeechEdit): SpeechEdit[] {
  return [...(edits ?? []).filter((e) => !(e.startMs >= edit.startMs && e.endMs <= edit.endMs)), edit];
}

/** Remove every fix touching `sourceMs` — "Remove my fix", back to computed. Pure. */
export function withoutSpeechEditAt(edits: readonly SpeechEdit[] | undefined, sourceMs: number): SpeechEdit[] {
  return (edits ?? []).filter((e) => !(sourceMs >= e.startMs && sourceMs < e.endMs));
}
