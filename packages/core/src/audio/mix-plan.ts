import type {
  MotionDocument,
  Clip,
  LevelerSettings,
  LimiterSettings,
  SoundBus,
  SoundCharacter,
  SoundPackId,
  SoundTarget,
} from "../schema";
import { INTERNAL_PAGE_ID } from "../pages";
import { frameDurationMs } from "../timeline/ops";
import { buildSoundCues, collectCompMedia, type MediaAudioSegment, type SoundCue } from "./cues";
import { dbToGain } from "./envelope";
import { audibleSpans, energyToLufs, integratedLoudness, maxMomentaryLoudness, type LoudnessTable } from "./loudness";
import { levelerTargetLufs, levelerTrimDb, measureKindOf, streamLoudness, TEXTURE_OFFSET_DB } from "./leveler";
import { duckCurve, duckGainAt, multiplyDucks, type DuckCurve, type DuckSpan } from "./ducking";

/**
 * THE MIX PLAN — one headless answer to "what does the mix do to every sound
 * in this comp", read verbatim by live playback AND the exporter.
 *
 * It resolves, once per document revision: each category's effective fader
 * (mute and solo applied), its ducking curve, whether the dialogue leveler runs
 * on it; each occurrence's route, leveler trim and clip-rule ducks. The engines
 * then only build nodes and move gains — neither re-derives a rule, which is
 * what keeps what you hear and what you export the same mix.
 *
 * Loudness comes through a PORT: the app measures assets off the main work and
 * answers null until it has. A sound not measured yet plays untrimmed and is
 * counted in `pending`, so the leveler fills in progressively instead of
 * blocking playback — and the exporter awaits every measurement first.
 */

export interface LoudnessSource {
  /** An asset's block table, or null while it is still being measured. */
  asset(assetId: string): LoudnessTable | null;
  /** One hit of a synth pack at volume 1, momentary LUFS — null until measured. */
  pack(pack: SoundPackId): number | null;
}

/** The export dialog's switch — overrides a comp's own leveler for one render. */
export interface MixOverride {
  leveler?: boolean;
  strength?: number;
}

/**
 * The document as one render should hear it: `frameId`'s leveler overridden.
 * A transform, not a parameter, so every render path — offline bounce, live
 * AAC capture, WAV — reads the comp's mix exactly as it always does and none
 * of them had to learn a new argument.
 */
export function withMixOverride(doc: MotionDocument, frameId: string, override: MixOverride): MotionDocument {
  if (override.leveler === undefined && override.strength === undefined) return doc;
  return {
    ...doc,
    frames: doc.frames.map((f) =>
      f.id !== frameId
        ? f
        : {
            ...f,
            soundMix: {
              ...f.soundMix,
              leveler: {
                ...f.soundMix.leveler,
                ...(override.leveler !== undefined ? { enabled: override.leveler } : {}),
                ...(override.strength !== undefined ? { strength: override.strength } : {}),
              },
            },
          },
    ),
  };
}

export interface PlannedBus {
  bus: SoundBus;
  /** Fader × mute × solo, linear. */
  gain: number;
  /** This category's own ducking, or null. */
  duck: DuckCurve | null;
  /** The dialogue leveler runs on it (voice character, leveler on, "even out speech"). */
  evenSpeech: boolean;
  /** Anything in this comp routes here. */
  used: boolean;
}

export interface MixPlan {
  frameId: string;
  durationMs: number;
  /** Master fader, linear. */
  volume: number;
  /** Null = no limiter on the master. */
  limiter: LimiterSettings | null;
  /** The leveler as it applies to this plan. */
  leveler: LevelerSettings;
  buses: ReadonlyMap<string, PlannedBus>;
  /** Unrouted sounds (no category) — muted when any category is soloed. */
  unroutedGain: number;
  /** A route naming a deleted category plays unrouted. */
  route(bus: string | null): string | null;
  /** Leveler trim for one occurrence, linear (1 = untouched / not measured yet). */
  segmentTrim(seg: MediaAudioSegment): number;
  /** Clip-rule ducks for one occurrence, or null. */
  segmentDuck(seg: MediaAudioSegment): DuckCurve | null;
  /** Everything the plan adds to one cue, linear: its trim × its clip ducks. */
  cueGain(cue: SoundCue): number;
  /** Sounds still being measured — the leveler is partial until this is 0. */
  pending: number;
  missingAssets: ReadonlySet<string>;
  missingPacks: ReadonlySet<SoundPackId>;
}

/** The key one occurrence is known by — matches the engines' voice keys. */
export function segmentKey(seg: MediaAudioSegment): string {
  return `${seg.clip.id}:${Math.round(seg.atMs)}`;
}

/** The stream a cue's loudness is judged in — see `SoundCue.stream`. */
const streamKey = (cue: SoundCue) => `${cue.stream}|${cue.kit ?? cue.custom?.assetId ?? cue.pack}`;

/** How long a fired cue counts as "playing" for a duck. */
const CUE_SPAN_MS = 80;
/** Two hits within one momentary window make a stream (texture), not a one-shot. */
const MOMENTARY_MS = 400;

function staticGain(seg: MediaAudioSegment): number {
  const own = seg.clip.kind === "audio" ? seg.clip.gain : seg.clip.volume;
  return Math.max(0, own) * seg.gainScale;
}

/** The SOURCE span an occurrence plays, ms into its asset. */
function sourceSpan(seg: MediaAudioSegment, table: LoudnessTable): [number, number] {
  if (seg.loop !== "none") return [0, table.energy.length * table.blockMs];
  return [seg.trimInMs, seg.trimInMs + seg.outputDurationMs * Math.max(0.01, seg.speed)];
}

function matches(target: SoundTarget, bus: string | null, clipId: string, path: readonly string[]): boolean {
  return target.kind === "bus" ? bus === target.id : clipId === target.id || path.includes(target.id);
}

export function buildMixPlan(doc: MotionDocument, frameId: string, loudness: LoudnessSource): MixPlan {
  const frame = doc.frames.find((f) => f.id === frameId);
  const mix = frame?.soundMix;
  const leveler: LevelerSettings =
    mix?.leveler ?? { enabled: false, mode: "category", strength: 0.8, tameLoud: true, liftQuiet: false, evenSpeech: true };
  const durationMs = frame ? frameDurationMs(doc, frame) : doc.durationMs;
  const byId = new Map(doc.soundBuses.map((b) => [b.id, b] as const));
  const route = (bus: string | null): string | null => (bus && byId.has(bus) ? bus : null);
  const characterOf = (bus: string | null): SoundCharacter | null => (bus ? byId.get(bus)?.character ?? null : null);

  const segments = collectCompMedia(doc, frameId).map((s) => ({ ...s, bus: route(s.bus) }));
  const cues = buildSoundCues(doc, 0, Math.max(durationMs, 1), frameId).map((c) => ({ ...c, bus: route(c.bus) }));

  const missingAssets = new Set<string>();
  const missingPacks = new Set<SoundPackId>();

  // ── Leveler: media, measured as heard (source × its own gain × faders above). ──
  const segTrim = new Map<string, number>();
  if (leveler.enabled) {
    for (const seg of segments) {
      const table = loudness.asset(seg.assetId);
      if (!table) {
        missingAssets.add(seg.assetId);
        continue;
      }
      const character = characterOf(seg.bus);
      const [from, to] = sourceSpan(seg, table);
      const source = measureKindOf(character) === "peak" ? maxMomentaryLoudness(table, from, to) : integratedLoudness(table, from, to);
      const heard = source + 20 * Math.log10(Math.max(1e-6, staticGain(seg)));
      const target = levelerTargetLufs(character, leveler, seg.bus ? byId.get(seg.bus)!.targetLufs : null);
      segTrim.set(segmentKey(seg), dbToGain(levelerTrimDb(heard, target, leveler)));
    }
  }

  // ── Leveler: cues, judged as a STREAM per source (a keystroke vs a stampede). ──
  const cueTrim = new Map<string, number>();
  if (leveler.enabled) {
    const groups = new Map<string, SoundCue[]>();
    for (const cue of cues) {
      const key = streamKey(cue);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(cue);
    }
    for (const [key, group] of groups) {
      const first = group[0]!;
      let single: number | null;
      if (first.custom) {
        // A kit's takes are one sound: judged by its loudest take, every take measured.
        single = null;
        let known = true;
        for (const id of new Set(group.flatMap((c) => (c.custom ? [c.custom.assetId] : [])))) {
          const table = loudness.asset(id);
          if (!table) {
            missingAssets.add(id);
            known = false;
            continue;
          }
          const l = maxMomentaryLoudness(table, 0, table.energy.length * table.blockMs);
          single = single === null ? l : Math.max(single, l);
        }
        if (!known) single = null;
      } else {
        single = loudness.pack(first.pack);
        if (single === null) missingPacks.add(first.pack);
      }
      if (single === null) continue;
      const times = group.map((c) => c.timeMs).sort((a, b) => a - b);
      let dense = 1;
      for (let i = 0, j = 0; i < times.length; i++) {
        while (times[i]! - times[j]! > MOMENTARY_MS) j++;
        dense = Math.max(dense, i - j + 1);
      }
      const rms = Math.sqrt(group.reduce((s, c) => s + c.volume * c.volume, 0) / group.length);
      const heard = streamLoudness(single, rms, dense);
      const character = characterOf(first.bus);
      const base = levelerTargetLufs(character, leveler, first.bus ? byId.get(first.bus)!.targetLufs : null);
      const target = dense >= 2 ? base + TEXTURE_OFFSET_DB : base;
      cueTrim.set(key, dbToGain(levelerTrimDb(heard, target, leveler)));
    }
  }

  // ── Ducking: triggers → audible spans in OUTPUT time. ──
  const spansOf = (target: SoundTarget, exclude: (bus: string | null, clipId: string, path: readonly string[]) => boolean): DuckSpan[] => {
    const out: DuckSpan[] = [];
    for (const seg of segments) {
      if (!matches(target, seg.bus, seg.clip.id, seg.path) || exclude(seg.bus, seg.clip.id, seg.path)) continue;
      const table = loudness.asset(seg.assetId);
      if (!table || seg.loop !== "none") {
        out.push({ from: seg.atMs, to: seg.atMs + seg.outputDurationMs });
        continue;
      }
      const speed = Math.max(0.01, seg.speed);
      const [from, to] = sourceSpan(seg, table);
      for (const s of audibleSpans(table, from, to)) {
        out.push({ from: seg.atMs + (s.from - seg.trimInMs) / speed, to: seg.atMs + (s.to - seg.trimInMs) / speed });
      }
    }
    for (const cue of cues) {
      if (!matches(target, cue.bus, cue.clipId, cue.path) || exclude(cue.bus, cue.clipId, cue.path)) continue;
      out.push({ from: cue.timeMs, to: cue.timeMs + CUE_SPAN_MS });
    }
    return out;
  };

  const solo = doc.soundBuses.some((b) => b.solo);
  const used = new Set<string>([...segments, ...cues].flatMap((o) => (o.bus ? [o.bus] : [])));
  const buses = new Map<string, PlannedBus>();
  for (const bus of doc.soundBuses) {
    const rules = bus.ducking.filter((r) => r.enabled && r.depthDb > 0);
    const curves = used.has(bus.id)
      ? rules.map((r) => duckCurve(spansOf(r.under, (b) => b === bus.id), r, durationMs))
      : [];
    buses.set(bus.id, {
      bus,
      gain: bus.muted || (solo && !bus.solo) ? 0 : bus.volume,
      duck: multiplyDucks(curves.filter((c) => c.gains.some((g) => g < 0.999))),
      evenSpeech: leveler.enabled && leveler.evenSpeech && bus.character === "voice",
      used: used.has(bus.id),
    });
  }

  // ── Clip-owned ducks: a rule on a clip covers every occurrence inside it. ──
  const clipById = new Map<string, Clip>();
  for (const t of doc.tracks) for (const c of t.clips) if (c.ducking?.length) clipById.set(c.id, c);
  const clipCurves = new Map<string, DuckCurve>();
  for (const [id, clip] of clipById) {
    const curves = clip.ducking!
      .filter((r) => r.enabled && r.depthDb > 0)
      .map((r) => duckCurve(spansOf(r.under, (_b, cid, path) => cid === id || path.includes(id)), r, durationMs));
    const combined = multiplyDucks(curves);
    if (combined) clipCurves.set(id, combined);
  }
  const ownerCurves = (clipId: string, path: readonly string[]): DuckCurve | null => {
    if (clipCurves.size === 0) return null;
    const hits = [clipId, ...path].flatMap((id) => {
      const c = clipCurves.get(id);
      return c ? [c] : [];
    });
    return multiplyDucks(hits);
  };

  return {
    frameId,
    durationMs,
    volume: mix?.volume ?? 1,
    limiter: mix?.limiter.enabled ? mix.limiter : null,
    leveler,
    buses,
    unroutedGain: solo ? 0 : 1,
    route,
    segmentTrim: (seg) => segTrim.get(segmentKey(seg)) ?? 1,
    segmentDuck: (seg) => ownerCurves(seg.clip.id, seg.path),
    cueGain: (cue) =>
      (cueTrim.get(streamKey(cue)) ?? 1) *
      duckGainAt(ownerCurves(cue.clipId, cue.path), cue.timeMs),
    pending: missingAssets.size + missingPacks.size,
    missingAssets,
    missingPacks,
  };
}

/**
 * Who is IN each category, project-wide — the category panel's member list.
 * Walks every comp that sits on a page (each is somebody's root), so a sound
 * inside a nested comp is listed under the category its route resolves to,
 * inherited tags included. One entry per clip, however often it is instanced.
 */
export function soundBusMembers(doc: MotionDocument): Map<string | null, string[]> {
  return soundInventory(doc).members;
}

/**
 * Every clip that MAKES or CONTAINS sound, project-wide — what a ducking rule
 * can name as its trigger. Containers (a nested comp holding a voice) are in
 * it too, because "duck under that scene" is a thing people mean.
 */
export function soundSourceClips(doc: MotionDocument): string[] {
  return soundInventory(doc).sources;
}

/** Both of the above from ONE walk — for a surface that shows members and offers triggers. */
export function soundInventory(doc: MotionDocument): { members: Map<string | null, string[]>; sources: string[] } {
  const out = new Map<string | null, Set<string>>();
  const sources = new Set<string>();
  const add = (bus: string | null, clipId: string, path: readonly string[]) => {
    (out.get(bus) ?? out.set(bus, new Set()).get(bus)!).add(clipId);
    sources.add(clipId);
    for (const id of path) sources.add(id);
  };
  const known = new Set(doc.soundBuses.map((b) => b.id));
  for (const frame of doc.frames) {
    if (frame.pageId === INTERNAL_PAGE_ID) continue;
    const end = Math.max(1, frameDurationMs(doc, frame));
    for (const s of collectCompMedia(doc, frame.id)) add(s.bus && known.has(s.bus) ? s.bus : null, s.clip.id, s.path);
    for (const c of buildSoundCues(doc, 0, end, frame.id)) add(c.bus && known.has(c.bus) ? c.bus : null, c.clipId, c.path);
  }
  return { members: new Map([...out].map(([k, v]) => [k, [...v]])), sources: [...sources] };
}

/**
 * THE MIX AT AN INSTANT, without playing it — each category's momentary
 * loudness at `atMs` (and the master's under the key `"master"`), from the
 * measured tables and the plan. It is what the mixer shows while PARKED:
 * scrub, and the meters say how loud this moment is, the way a DAW's meter
 * would if you played from here. Continuous media only — a fired cue is a
 * transient with no "level at an instant". LUFS; -Infinity for silence.
 */
export function mixLevelsAt(
  doc: MotionDocument,
  plan: MixPlan,
  loudness: LoudnessSource,
  atMs: number,
): Map<string, number> {
  const energy = new Map<string, number>();
  const add = (key: string, e: number) => energy.set(key, (energy.get(key) ?? 0) + e);
  let master = 0;
  for (const seg of collectCompMedia(doc, plan.frameId)) {
    const local = atMs - seg.atMs;
    if (local < 0 || local >= seg.outputDurationMs) continue;
    const table = loudness.asset(seg.assetId);
    if (!table || table.energy.length === 0) continue;
    const span = table.energy.length * table.blockMs;
    let src = seg.trimInMs + local * Math.max(0.01, seg.speed);
    if (seg.loop !== "none" && span > 0) src %= span;
    const e = table.energy[Math.min(table.energy.length - 1, Math.floor(src / table.blockMs))] ?? 0;
    const route = plan.route(seg.bus);
    const planned = route ? plan.buses.get(route) : undefined;
    const g =
      staticGain(seg) *
      plan.segmentTrim(seg) *
      duckGainAt(plan.segmentDuck(seg), atMs) *
      (planned ? planned.gain * duckGainAt(planned.duck, atMs) : plan.unroutedGain);
    const heard = e * g * g;
    add(route ?? "unrouted", heard);
    master += heard;
  }
  const out = new Map<string, number>();
  for (const [k, e] of energy) out.set(k, energyToLufs(e));
  out.set("master", energyToLufs(master * plan.volume * plan.volume));
  return out;
}
