"use client";

import { z } from "zod";
import {
  ApiError,
  bakeMouth,
  clipLocalTimeAtSource,
  defineCommand,
  clipSourceTimeAt,
  LIP_SYNC_FEELS,
  mediaAssetOf,
  mouthHears,
  mouthOf,
  mouthsIn,
  requireClip,
  setMouthVoice,
  voiceClipNamed,
  voiceClipsIn,
  type Mouth,
  withSpeechEdit,
  withoutSpeechEditAt,
  type AnyCommand,
  type MotionDocument,
  type Clip,
  type CommandRuntime,
} from "@solomotion/core";
import { VISEME_IDS } from "@solomotion/lipsync";
import { ensureSpeechTrack, speechStatusOf } from "./speech-host";
import { setSpeechRoutes, type SpeechRoutes } from "./ai-bridge";

/**
 * LIP SYNC FOR AGENTS — the verbs behind the Voice section. A mouth talks
 * through its Lip sync behavior (core `setMouthVoice`): `speech.bind` points
 * it at a voice, the mouth follows the voice through every edit, and
 * `speech.bake` turns it into keys only when hand-keying is wanted. Cues are
 * derived; `speech.inspect` reads them.
 */

/** The mouth a picked layer means, or a refusal that lists the mouths there are. */
function requireMouth(doc: MotionDocument, picked: Clip): Mouth {
  const mouth = mouthOf(doc, picked);
  if (mouth) return mouth;
  const options = mouthsIn(doc, picked.frameId).map((m) => `${m.label} (${m.groupId})`);
  throw new ApiError(`"${picked.name}" has no mouth.`, options.length ? `Mouths here: ${options.join("; ")}.` : "Make a mouth switch whose drawings are named for visemes (switch.create), or character.bringToLife on a character that has one.");
}

const describeMouth = (m: Mouth) => ({ groupId: m.groupId, setId: m.setId, label: m.label, voice: m.voice === null ? null : m.voice || "every voice" });

/** A voice: a layer (audio or video) by id or name, or an asset id. */
function voiceOf(doc: MotionDocument, id: string): { assetId: string; clip: Clip | null } {
  if (doc.assets.some((a) => a.id === id)) return { assetId: id, clip: null };
  const clip = requireClip(doc, id).clip;
  const assetId = mediaAssetOf(clip);
  if (!assetId) throw new ApiError(`"${clip.name}" plays no recording.`, "Point at an imported audio layer, a video layer, or an asset id.");
  return { assetId, clip };
}

const voiceInput = z.string().describe("The voice: an audio/video layer id or name, or an asset id.");

export function speechCommands(routes: SpeechRoutes): AnyCommand[] {
  setSpeechRoutes(routes);

  const analyze = defineCommand({
    id: "speech.analyze",
    summary: "Hear a voice for lip sync (cached per recording) and optionally set how: engine, known script, Feel, Energy. Returns the engine used and the cue count.",
    details:
      `Engines: auto (default — Test Voice lines are exact; a script, a TTS's timing or a transcription aligns words; else listens), ${"`spectral`"} (Listen, offline), ${"`align`"} (Words: needs \`text\` or a transcription connection). Feel: ${LIP_SYNC_FEELS.join(" · ")}. Energy 1 = as heard. Settings live on the recording, so every clip of it shares them. Lip sync needs no analyze call — a bound mouth asks on its own; call this to choose, to wait, or with force to re-hear.`,
    effect: "write",
    input: z.object({
      id: voiceInput,
      engine: z.string().optional(),
      text: z.string().max(20_000).optional().describe("What the recording says, when known — alignment beats listening."),
      words: z
        .array(z.object({ text: z.string(), startMs: z.number().min(0), endMs: z.number().min(0) }))
        .optional()
        .describe("Its words with their times (source ms), when something timed them — a TTS's alignment, a transcript. The mouth is then exact; stored on the recording."),
      feel: z.enum(LIP_SYNC_FEELS).optional(),
      energy: z.number().min(0).max(3).optional(),
      force: z.boolean().default(false),
    }),
    async run(input, rt) {
      const { assetId } = voiceOf(rt.doc(), input.id);
      if (input.engine || input.text !== undefined || input.words || input.feel || input.energy !== undefined) {
        rt.write("Voice settings", (d) => {
          const a = d.assets.find((x) => x.id === assetId);
          if (!a) return;
          const s = { engine: "auto", ...a.speech };
          if (input.engine) s.engine = input.engine;
          if (input.text !== undefined) s.text = input.text || undefined;
          if (input.words) s.words = input.words.length ? input.words : undefined;
          if (input.feel) s.feel = input.feel;
          if (input.energy !== undefined) s.energy = input.energy;
          a.speech = s;
        });
      }
      rt.progress?.("Listening…");
      const track = await ensureSpeechTrack(assetId, undefined, { force: input.force });
      const st = speechStatusOf(assetId);
      if (!track) throw new ApiError(st?.note ?? "Couldn't hear a voice in this clip.");
      return {
        assetId,
        engine: track.engine,
        cues: track.cues.length,
        spokenMs: Math.round(track.cues.filter((c) => c.viseme !== "X").reduce((n, c) => n + c.endMs - c.startMs, 0)),
        words: track.words?.length ?? 0,
        ...(st?.note ? { note: st.note } : {}),
      };
    },
  });

  const inspect = defineCommand({
    id: "speech.inspect",
    summary: "Read a voice's lip-sync track: engine, status, words and viseme cues (source ms, and comp ms for a layer), hand fixes, and the mouths bound to it.",
    effect: "read",
    input: z.object({
      id: voiceInput,
      fromMs: z.number().optional().describe("Comp ms for a layer, source ms for an asset."),
      toMs: z.number().optional(),
      limit: z.number().int().min(1).max(500).default(120),
    }),
    async run(input, rt) {
      const doc = rt.doc();
      const { assetId, clip } = voiceOf(doc, input.id);
      const track = await ensureSpeechTrack(assetId);
      const asset = doc.assets.find((a) => a.id === assetId);
      const toComp = (src: number) => (clip ? Math.round(clip.startMs + clipLocalTimeAtSource(doc, clip, src)) : undefined);
      const inRange = (ms: number | undefined) => ms === undefined || ((input.fromMs === undefined || ms >= input.fromMs) && (input.toMs === undefined || ms <= input.toMs));
      const cues = (track?.cues ?? [])
        .map((c) => ({ viseme: c.viseme, startMs: Math.round(c.startMs), endMs: Math.round(c.endMs), ...(clip ? { compMs: toComp(c.startMs) } : {}) }))
        .filter((c) => inRange(clip ? c.compMs : c.startMs))
        .slice(0, input.limit);
      const bound = clip ? mouthsIn(doc, clip.frameId).filter((m) => mouthHears(m, clip)).map(describeMouth) : [];
      return {
        assetId,
        status: speechStatusOf(assetId)?.state ?? (track ? "ready" : "listening"),
        engine: track?.engine ?? asset?.speech?.engine ?? "auto",
        settings: { engine: asset?.speech?.engine ?? "auto", feel: asset?.speech?.feel ?? "natural", energy: asset?.speech?.energy ?? 1, script: !!asset?.speech?.text },
        durationMs: Math.round(track?.durationMs ?? 0),
        words: (track?.words ?? []).filter((w) => inRange(clip ? toComp(w.startMs) : w.startMs)).slice(0, input.limit).map((w) => ({ text: w.text, startMs: Math.round(w.startMs), endMs: Math.round(w.endMs) })),
        cues,
        fixes: asset?.speech?.edits ?? [],
        boundMouths: bound,
      };
    },
  });

  const bind = defineCommand({
    id: "speech.bind",
    summary: "Make a mouth talk: point a character's mouth (its viseme pose set, or a mouth switch) at a voice — live, so moving, trimming or swapping the voice re-syncs. No `voice` = every voice, whichever plays. `off: true` silences it.",
    details:
      "`target` is the character group, the mouth switch, or any layer with a viseme pose set. Writes the mouth's Lip sync behavior (adds one when there is none; a bare switch becomes a viseme set first), so its Mouth map, In pauses and Lead stay where `behaviors_*` edit them. `voice` names a voice layer in the SAME comp. Inside a component, leave `voice` out: every voice includes the instance's Voice input.",
    effect: "write",
    input: z.object({
      target: z.string(),
      voice: z.string().optional().describe("A voice layer's name or id in the mouth's comp. Omit for every voice."),
      off: z.boolean().default(false),
    }),
    run(input, rt) {
      const doc = rt.doc();
      const mouth = requireMouth(doc, requireClip(doc, input.target).clip);
      let voice: string | null = null;
      if (!input.off && input.voice) {
        const comp = requireClip(doc, mouth.groupId).clip.frameId;
        const v = voiceClipNamed(doc, comp, input.voice) ?? requireClip(doc, input.voice).clip;
        if (!mediaAssetOf(v)) throw new ApiError(`"${v.name}" plays no recording.`);
        if (v.frameId !== comp) throw new ApiError(`"${v.name}" is in another comp than the mouth.`, "Move the voice beside it, or leave `voice` out inside a component (its Voice input is heard).");
        voice = v.name;
      } else if (!input.off) voice = "";
      let at: ReturnType<typeof setMouthVoice> = null;
      rt.write(input.off ? "Stop lip sync" : "Lip sync", (d) => {
        at = setMouthVoice(d, mouth, voice);
      });
      const done = at as ReturnType<typeof setMouthVoice>;
      return { groupId: done?.groupId ?? mouth.groupId, setId: done?.setId ?? mouth.setId, behaviorId: done?.behaviorId ?? null, voice: voice === null ? null : voice || "every voice" };
    },
  });

  const bake = defineCommand({
    id: "speech.bake",
    summary: "Bake a talking mouth to keys (hold keys on its pose channel over the voice's span) for hand-keying in the dope sheet; its Lip sync behavior switches off. Moving the voice won't re-sync after.",
    effect: "write",
    input: z.object({ target: z.string(), voice: z.string().optional().describe("Default: the voice the mouth hears (for every voice, the one over it).") }),
    async run(input, rt) {
      const doc = rt.doc();
      const mouth = requireMouth(doc, requireClip(doc, input.target).clip);
      const owner = requireClip(doc, mouth.groupId).clip;
      const name = input.voice ?? mouth.voice;
      const voice = name
        ? (voiceClipNamed(doc, owner.frameId, name) ?? requireClip(doc, name).clip)
        : voiceClipsIn(doc, owner.frameId).find((c) => c.startMs < owner.startMs + owner.durationMs && c.startMs + c.durationMs > owner.startMs);
      if (!voice) throw new ApiError("No voice to bake from.", "Pass `voice`: a voice layer in the mouth's comp.");
      const assetId = mediaAssetOf(voice);
      if (!assetId) throw new ApiError(`"${voice.name}" plays no recording.`);
      rt.progress?.("Listening…");
      const track = await ensureSpeechTrack(assetId);
      if (!track) throw new ApiError(speechStatusOf(assetId)?.note ?? "Couldn't hear a voice in this clip.");
      let res: ReturnType<typeof bakeMouth> = null;
      let setId = mouth.setId;
      rt.write("Bake to keys", (d) => {
        const at = setId ? { groupId: mouth.groupId, setId } : setMouthVoice(d, mouth, voice.name);
        if (!at) return;
        setId = at.setId;
        res = bakeMouth(d, at.groupId, at.setId, voice.id);
      });
      const done = res as ReturnType<typeof bakeMouth>;
      if (!done) throw new ApiError(`"${mouth.label}" could not be baked.`);
      return { groupId: mouth.groupId, path: `pose.${setId}`, keys: done.keys, fromMs: done.fromMs, toMs: done.toMs };
    },
  });

  const fix = defineCommand({
    id: "speech.fix",
    summary: "Hand-fix the mouth over a stretch of a voice — a viseme (or rest) that wins there, stored in the recording's own time so it survives moving, trimming and re-analysis. `clear` removes the fix at that moment.",
    effect: "write",
    input: z.object({
      id: voiceInput,
      startMs: z.number().describe("Comp ms for a layer, source ms for an asset."),
      endMs: z.number().optional(),
      viseme: z.enum([...VISEME_IDS, "rest"]).optional(),
      clear: z.boolean().default(false),
    }),
    run(input, rt: CommandRuntime) {
      const doc = rt.doc();
      const { assetId, clip } = voiceOf(doc, input.id);
      const toSource = (ms: number) => (clip ? sourceAtComp(doc, clip, ms) : ms);
      const a = toSource(input.startMs);
      if (input.clear) {
        rt.write("Remove my fix", (d) => {
          const asset = d.assets.find((x) => x.id === assetId);
          if (asset) asset.speech = { engine: "auto", ...asset.speech, edits: withoutSpeechEditAt(asset.speech?.edits, a) };
        });
        return { assetId, cleared: true };
      }
      if (input.endMs === undefined || !input.viseme) throw new ApiError("A fix needs `endMs` and `viseme`.");
      const b = toSource(input.endMs);
      const [startMs, endMs] = a <= b ? [a, b] : [b, a]; // a reversed clip runs backwards
      if (!(endMs > startMs)) throw new ApiError("That stretch is empty.");
      const viseme = input.viseme === "rest" ? "X" : input.viseme;
      rt.write("Fix mouth", (d) => {
        const asset = d.assets.find((x) => x.id === assetId);
        if (asset) asset.speech = { engine: "auto", ...asset.speech, edits: withSpeechEdit(asset.speech?.edits, { startMs, endMs, viseme }) };
      });
      return { assetId, startMs: Math.round(startMs), endMs: Math.round(endMs), viseme };
    },
  });

  return [analyze, inspect, bind, bake, fix];
}

/** Comp ms → the voice's source ms (THE map), clamped into the clip. */
function sourceAtComp(doc: MotionDocument, clip: Clip, compMs: number): number {
  const local = Math.min(Math.max(0, compMs - clip.startMs), Math.max(0, clip.durationMs - 1));
  return clipSourceTimeAt(doc, clip, local);
}
