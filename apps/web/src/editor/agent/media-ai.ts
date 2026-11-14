"use client";

import { z } from "zod";
import {
  ApiError,
  clipForAsset,
  createCaptionClip,
  cutRanges,
  defineCommand,
  locateClip,
  phrasesFromWords,
  placeClip,
  silencesBetween,
  type AnyCommand,
  type Asset,
  type AssetOrigin,
  type CommandRuntime,
} from "@solomotion/core";
import {
  PROVIDERS,
  alignText,
  cutout,
  generateImage,
  generateMusic,
  generateSound,
  generateSpeech,
  generateVideo,
  givesWordTimings,
  isolateVoice,
  listVoices,
  modelsFor,
  pickModel,
  transcribe,
  upscale,
  type Connection,
  type GeneratedMedia,
  type MediaCapability,
  type MediaInput,
  type TimedWord,
} from "@solomotion/agent";
import { installKnownTrack, installVoiceWords } from "../speech/speech-host";
import { sayLine, testVoicePreset } from "../speech/test-voice";
import { ttsWords } from "../speech/ai-bridge";
import { AI_FOLDER, frameAt, importBytes, mediaOf, placeAsset, placeInput, soundOf, speechChunks, swapLayerMedia, type PlaceInput } from "./media-io";

/**
 * AI MEDIA VERBS — every media job an AI can do in the editor, as ordinary
 * registry commands: the chat agent calls them as tools, the right-click AI
 * menu calls them directly, MCP clients and plugins reach the same ones.
 *
 * Each verb does four things and only these: resolve its input (a layer, an
 * asset, an attachment — `media-io`), route the job to a connection and model
 * (`pickModel`: the model that TAKES what it is handed), run the one
 * provider-agnostic generation function, and land the result — filed in the
 * Media library with its provenance, then either placed, or swapped into the
 * layer it was asked of so the layer keeps its transform, timing and effects.
 * The original media always stays; an edit points back at it.
 */

export interface GenerationRoutes {
  /** The connection serving a job, honouring the user's routing. */
  connectionFor(capability: MediaCapability): Connection | null;
  /** A model the user pinned for a job, if any. */
  modelFor?(capability: MediaCapability): string | undefined;
}

const JOB: Record<MediaCapability, string> = {
  image: "draw or edit images",
  video: "make video",
  speech: "speak",
  transcription: "transcribe",
  sound: "make sound effects",
  music: "make music",
  cutout: "remove backgrounds",
  isolate: "isolate voices",
  upscale: "upscale",
  alignment: "time lyrics to audio",
};

function route(deps: GenerationRoutes, capability: MediaCapability, needs: MediaInput = "text", preferred?: string): { connection: Connection; model: string } {
  const connection = deps.connectionFor(capability);
  if (!connection) {
    const who = PROVIDERS.filter((p) => !p.hidden && p.capabilities.includes(capability)).map((p) => p.name);
    throw new ApiError(`No connection can ${JOB[capability]} yet.`, `Tell the user to add one in Agents → Connections — ${who.join(", ")} can.`);
  }
  const pinned = preferred ?? deps.modelFor?.(capability);
  const fits = (id: string | undefined) => {
    const m = id ? modelsFor(connection, capability).find((x) => x.id === id) : undefined;
    return !!id && (!m || (m.inputs ?? ["text"]).includes(needs));
  };
  const model = pickModel(connection, capability, needs, fits(pinned) ? pinned : undefined);
  if (!model) {
    throw new ApiError(
      `${connection.label} has no model that can ${JOB[capability]} from ${needs === "text" ? "words" : `a${needs === "image" ? "n" : ""} ${needs}`}.`,
      `Route ${capability} to another connection, or name a model id.`,
    );
  }
  return { connection, model: model.id };
}

const originOf = (m: GeneratedMedia, parentAssetId: string | null): AssetOrigin => ({
  kind: "generated",
  capability: m.provenance.capability,
  provider: m.provenance.provider,
  model: m.provenance.model,
  prompt: m.provenance.prompt,
  at: m.provenance.at,
  parentAssetId,
});

const fileOf = (m: GeneratedMedia) => new File([m.blob], m.name, { type: m.mediaType });
const by = (r: { connection: Connection; model: string }) => `${r.connection.label} · ${r.model}`;
const modelInput = z.string().optional().describe("A model id to use instead of the routed default.");

/** File a result, then place it or swap it into the layer it came from. */
async function land(
  rt: CommandRuntime,
  m: GeneratedMedia,
  opts: { parentAssetId: string | null; swapInto?: string | null; place?: PlaceInput; label: string },
): Promise<{ asset: Asset; clipId: string | null }> {
  const asset = await importBytes(rt, fileOf(m), { folder: AI_FOLDER, origin: originOf(m, opts.parentAssetId) });
  if (opts.swapInto) {
    swapLayerMedia(rt, opts.swapInto, asset, opts.label);
    return { asset, clipId: opts.swapInto };
  }
  return { asset, clipId: placeAsset(rt, asset, opts.place) };
}

/** A layer that shows an image or plays a video — the ones an edit can land in. */
const swappable = (clip: { kind: string } | null, kinds: string[]) => !!clip && kinds.includes(clip.kind);

export function mediaAiCommands(deps: GenerationRoutes): AnyCommand[] {
  // ── Pictures ───────────────────────────────────────────────────────────────

  const generateImageCmd = defineCommand({
    id: "generate.image",
    summary: "Draw images from words, or EDIT one (and follow references) — filed in Media with its prompt; an edited image layer updates in place.",
    details:
      "Prompt like an art director: subject, composition, light, lens, palette, style, where text will sit. `edit` is the picture to change (a layer, asset or attachment); `references` are pictures to follow (style, a product, a face). Editing an image LAYER swaps the result in (transform, timing, effects kept; ⌘Z restores) unless `replace: false`. `transparent` asks for alpha — models that cannot draw it get a background-removal pass when one is connected.",
    effect: "write",
    input: z.object({
      prompt: z.string().min(3),
      edit: z.string().optional(),
      references: z.array(z.string()).max(8).optional(),
      aspect: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).default("1:1"),
      count: z.number().int().min(1).max(4).default(1),
      transparent: z.boolean().default(false),
      replace: z.boolean().default(true),
      model: modelInput,
      place: placeInput,
    }),
    async run(input, rt) {
      const edit = input.edit ? await mediaOf(rt, input.edit, ["image"]) : null;
      const refs = await Promise.all((input.references ?? []).map((id) => mediaOf(rt, id, ["image"])));
      const images = [...(edit ? [edit.blob] : []), ...refs.map((r) => r.blob)];
      const r = route(deps, "image", images.length ? "image" : "text", input.model);
      rt.progress?.(images.length ? "Editing…" : "Drawing…");
      let media = await generateImage({ ...r, prompt: input.prompt, aspect: input.aspect, count: input.count, images, transparent: input.transparent, signal: rt.signal, onProgress: rt.progress });
      let note: string | undefined;
      if (input.transparent && r.connection.providerId !== "openai") {
        const cut = deps.connectionFor("cutout");
        if (cut) {
          const cr = route(deps, "cutout", "image");
          rt.progress?.("Removing the background…");
          media = await Promise.all(media.map(async (m) => ({ ...(await cutout({ ...cr, media: m.blob, signal: rt.signal })), provenance: m.provenance })));
        } else note = "This model cannot draw transparency and no background-removal connection is set up; the image has a background.";
      }
      const swapInto = edit?.clip && input.replace && swappable(edit.clip, ["image"]) ? edit.clip.id : null;
      const landed = [];
      for (const [i, m] of media.entries()) {
        landed.push(await land(rt, m, { parentAssetId: edit?.assetId ?? null, swapInto: i === 0 ? swapInto : null, place: i === 0 ? input.place : undefined, label: "Edit image" }));
      }
      return {
        assets: landed.map((l) => ({ id: l.asset.id, name: l.asset.name, size: [l.asset.width, l.asset.height] })),
        ...(landed[0]?.clipId ? { clipId: landed[0].clipId, replaced: !!swapInto } : {}),
        ...(note ? { note } : {}),
        by: by(r),
      };
    },
  });

  const mediaCutout = defineCommand({
    id: "media.remove_background",
    summary: "Cut the subject out of an image or a video (alpha background). A layer updates in place; the original stays in Media.",
    effect: "write",
    input: z.object({ id: z.string().describe("Image/video layer, asset or attachment."), replace: z.boolean().default(true), model: modelInput, place: placeInput }),
    async run(input, rt) {
      const src = await mediaOf(rt, input.id, ["image", "video"]);
      const r = route(deps, "cutout", src.kind, input.model);
      rt.progress?.("Removing the background…");
      const m = await cutout({ ...r, media: src.blob, signal: rt.signal, onProgress: rt.progress });
      const swapInto = input.replace && swappable(src.clip, ["image", "video"]) ? src.clip!.id : null;
      const out = await land(rt, m, { parentAssetId: src.assetId, swapInto, place: input.place, label: "Remove background" });
      return { assetId: out.asset.id, ...(out.clipId ? { clipId: out.clipId, replaced: !!swapInto } : {}), by: by(r) };
    },
  });

  const mediaUpscale = defineCommand({
    id: "media.upscale",
    summary: "Add resolution to an image or video (2–4×). A layer updates in place and keeps its size on the canvas — only sharper.",
    effect: "write",
    input: z.object({ id: z.string(), factor: z.number().min(1.5).max(4).default(2), replace: z.boolean().default(true), model: modelInput, place: placeInput }),
    async run(input, rt) {
      const src = await mediaOf(rt, input.id, ["image", "video"]);
      const r = route(deps, "upscale", src.kind, input.model);
      rt.progress?.(`Upscaling ${input.factor}×…`);
      const m = await upscale({ ...r, media: src.blob, factor: input.factor, signal: rt.signal, onProgress: rt.progress });
      const swapInto = input.replace && swappable(src.clip, ["image", "video"]) ? src.clip!.id : null;
      const out = await land(rt, m, { parentAssetId: src.assetId, swapInto, place: input.place, label: "Upscale" });
      return { assetId: out.asset.id, size: [out.asset.width, out.asset.height], ...(out.clipId ? { clipId: out.clipId } : {}), by: by(r) };
    },
  });

  // ── Footage ────────────────────────────────────────────────────────────────

  const generateVideoCmd = defineCommand({
    id: "generate.video",
    summary: "Shoot a video from words, animate a still (`from`), or edit footage (`edit`). Takes minutes; lands in Media and, for an edit, above the source in sync.",
    details:
      "Prompt like a DP: subject and action, camera move, lens, light, mood, and sound if the model scores it (`audio`). Keep clips short (4–8 s) and cut them together. An `edit` of a video LAYER lands on the lane above, aligned to the source (same start, trim and speed) so you can compare, mask or cross-fade; the source is untouched.",
    effect: "write",
    input: z.object({
      prompt: z.string().min(3),
      from: z.string().optional().describe("An image (layer/asset/attachment) to use as the first frame."),
      edit: z.string().optional().describe("A video (layer/asset/attachment) to change."),
      aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
      durationS: z.number().min(1).max(20).optional(),
      audio: z.boolean().optional().describe("Let the model score its own sound."),
      model: modelInput,
      place: placeInput,
    }),
    async run(input, rt) {
      if (input.from && input.edit) throw new ApiError("Give `from` (a still to animate) or `edit` (footage to change), not both.");
      const still = input.from ? await mediaOf(rt, input.from, ["image"]) : null;
      const footage = input.edit ? await mediaOf(rt, input.edit, ["video"]) : null;
      const r = route(deps, "video", still ? "image" : footage ? "video" : "text", input.model);
      rt.progress?.("Submitting…");
      const m = await generateVideo({
        ...r,
        prompt: input.prompt,
        aspect: input.aspect,
        durationS: input.durationS,
        image: still?.blob,
        video: footage?.blob,
        audio: input.audio,
        signal: rt.signal,
        onProgress: rt.progress,
      });
      const asset = await importBytes(rt, fileOf(m), { folder: AI_FOLDER, origin: originOf(m, still?.assetId ?? footage?.assetId ?? null) });
      let clipId: string | null = null;
      const src = footage?.clip;
      if (src && src.kind === "video" && !input.place) {
        // Above the source, in sync with it: same start, trim, speed and length.
        rt.write("Place edited video", (d) => {
          const frame = d.frames.find((f) => f.id === src.frameId)!;
          const clip = clipForAsset(asset, { frameId: src.frameId, startMs: src.startMs }, frame);
          if (clip.kind === "video") {
            clip.trimInMs = src.trimInMs;
            clip.playback = { ...src.playback };
            clip.transform = { ...src.transform };
          }
          clip.durationMs = src.durationMs;
          placeClip(d, clip, { aboveClipId: src.id, landing: "settle" });
          clipId = clip.id;
        });
      } else clipId = placeAsset(rt, asset, input.place);
      return { assetId: asset.id, durationMs: asset.durationMs, ...(clipId ? { clipId } : {}), by: by(r) };
    },
  });

  // ── Voice and sound ────────────────────────────────────────────────────────

  const generateSpeechCmd = defineCommand({
    id: "generate.speech",
    summary: "Voice a script (text → speech) into Media, optionally onto the timeline. voices.list names the voices; voice \"test\" is the built-in offline Test Voice.",
    details:
      "Write it the way it should be SPOKEN — punctuation is pacing, a line break is a breath. `style` directs the read (\"warm, unhurried\", \"whispers\"); expressive models (Eleven v3, GPT TTS, Gemini voices) follow it. `voice: \"test\"` (or `test:bright`, `test:robo`) — and any call with no speech connection — uses the offline Test Voice, whose lip sync is exact.",
    effect: "write",
    input: z.object({ text: z.string().min(1).max(5000), voice: z.string().optional(), style: z.string().optional(), model: modelInput, place: placeInput }),
    async run(input, rt) {
      // THE TEST VOICE: `voice: "test"` (or `test:bright`, `test:robo`), or no
      // speech connection at all — offline, deterministic, and its mouth is
      // EXACT (installed as the asset's track, no analysis).
      const preset = testVoicePreset(input.voice) ?? (!input.model && !deps.connectionFor("speech") ? "warm" : null);
      if (preset) {
        rt.progress?.("Saying it…");
        const line = await sayLine(input.text, preset);
        const asset = await importBytes(rt, line.file, { folder: AI_FOLDER, origin: line.origin });
        await installKnownTrack(asset.id, line.result, line.result.words);
        const clipId = placeAsset(rt, asset, input.place);
        return { assetId: asset.id, durationMs: asset.durationMs, ...(clipId ? { clipId } : {}), by: `Test Voice · ${preset}`, lipSync: "exact" };
      }
      const r = route(deps, "speech", "text", input.model);
      rt.progress?.("Recording the voice…");
      const m = await generateSpeech({ ...r, text: input.text, voice: input.voice, style: input.style, signal: rt.signal, onProgress: rt.progress });
      const out = await land(rt, m, { parentAssetId: null, place: input.place, label: "Voiceover" });
      // A provider that timed its own words hands lip sync the ground truth.
      if (m.alignment) {
        const words = ttsWords(m.alignment);
        // On the recording too, so the exact mouth travels with the project.
        rt.write("Voice timing", (d) => {
          const a = d.assets.find((x) => x.id === out.asset.id);
          if (a && words.length) a.speech = { engine: "auto", ...a.speech, words };
        });
        await installVoiceWords(out.asset.id, words);
      }
      return { assetId: out.asset.id, durationMs: out.asset.durationMs, ...(out.clipId ? { clipId: out.clipId } : {}), by: by(r), ...(m.alignment ? { lipSync: "timed" } : {}) };
    },
  });

  const voicesList = defineCommand({
    id: "voices.list",
    summary: "The voices the speech connection offers — pick one to match the brief (\"a warm British narrator\").",
    effect: "read",
    input: z.object({ query: z.string().optional() }),
    async run(input, rt) {
      const r = route(deps, "speech");
      const q = input.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const all = await listVoices(r.connection, rt.signal);
      const hits = all.filter((v) => q.every((w) => `${v.name} ${v.description ?? ""}`.toLowerCase().includes(w)));
      return { by: r.connection.label, voices: (hits.length ? hits : all).slice(0, 60) };
    },
  });

  const generateSoundCmd = defineCommand({
    id: "generate.sound",
    summary: "Make a sound effect from words (a whoosh, a UI pop, rain on glass) into Media, optionally onto the timeline.",
    details: "Describe the sound physically: source, material, distance, room, attack and tail. 0.5–30 s; `loop` for beds.",
    effect: "write",
    input: z.object({ prompt: z.string().min(2), durationS: z.number().min(0.5).max(30).optional(), loop: z.boolean().default(false), model: modelInput, place: placeInput }),
    async run(input, rt) {
      const r = route(deps, "sound", "text", input.model);
      rt.progress?.("Designing the sound…");
      const m = await generateSound({ ...r, prompt: input.prompt, durationS: input.durationS, loop: input.loop, signal: rt.signal, onProgress: rt.progress });
      const out = await land(rt, m, { parentAssetId: null, place: input.place, label: "Sound effect" });
      return { assetId: out.asset.id, durationMs: out.asset.durationMs, ...(out.clipId ? { clipId: out.clipId } : {}), by: by(r) };
    },
  });

  const generateMusicCmd = defineCommand({
    id: "generate.music",
    summary: "Compose music from words (genre, mood, tempo, instruments, structure) into Media, optionally onto the timeline.",
    effect: "write",
    input: z.object({ prompt: z.string().min(3), durationS: z.number().min(10).max(300).default(30), instrumental: z.boolean().default(true), model: modelInput, place: placeInput }),
    async run(input, rt) {
      const r = route(deps, "music", "text", input.model);
      rt.progress?.("Composing…");
      const m = await generateMusic({ ...r, prompt: input.prompt, durationS: input.durationS, instrumental: input.instrumental, signal: rt.signal, onProgress: rt.progress });
      const out = await land(rt, m, { parentAssetId: null, place: input.place, label: "Music" });
      return { assetId: out.asset.id, durationMs: out.asset.durationMs, ...(out.clipId ? { clipId: out.clipId } : {}), by: by(r) };
    },
  });

  const audioIsolate = defineCommand({
    id: "audio.isolate",
    summary: "Clean up a voice: keep the speech, lose room echo, hum, noise and music. An audio layer updates in place; a video gets a clean voice layer linked under it and its own sound muted.",
    effect: "write",
    input: z.object({ id: z.string().describe("Audio/video layer, asset or attachment."), model: modelInput }),
    async run(input, rt) {
      const src = await mediaOf(rt, input.id, ["audio", "video"]);
      const r = route(deps, "isolate", src.kind === "video" ? "video" : "audio", input.model);
      rt.progress?.("Isolating the voice…");
      const m = await isolateVoice({ ...r, media: src.blob, signal: rt.signal, onProgress: rt.progress });
      const clip = src.clip;
      if (clip?.kind === "audio") {
        const out = await land(rt, m, { parentAssetId: src.assetId, swapInto: clip.id, label: "Clean up voice" });
        return { assetId: out.asset.id, clipId: clip.id, replaced: true, by: by(r) };
      }
      const asset = await importBytes(rt, fileOf(m), { folder: AI_FOLDER, origin: originOf(m, src.assetId) });
      if (clip?.kind !== "video") return { assetId: asset.id, by: by(r) };
      let voiceId = "";
      rt.write("Clean up voice", (d) => {
        const video = locateClip(d, clip.id)!.clip;
        if (video.kind !== "video") return;
        const frame = d.frames.find((f) => f.id === video.frameId)!;
        const voice = clipForAsset(asset, { frameId: video.frameId, startMs: video.startMs }, frame);
        if (voice.kind === "audio") {
          voice.trimInMs = video.trimInMs;
          voice.playback = { ...voice.playback, speed: video.playback.speed };
        }
        voice.durationMs = video.durationMs;
        voice.name = `${video.name} · voice`;
        // Linked, so a move or a cut takes picture and voice together.
        const link = video.linkGroupId ?? `link_${Date.now().toString(36)}`;
        video.linkGroupId = link;
        voice.linkGroupId = link;
        video.muted = true;
        placeClip(d, voice, {});
        voiceId = voice.id;
      });
      return { assetId: asset.id, voiceClipId: voiceId, videoMuted: true, by: by(r) };
    },
  });

  // ── Words ──────────────────────────────────────────────────────────────────

  /** Word-timed words of a layer/asset/attachment, in comp time for a layer. */
  async function wordsOf(rt: CommandRuntime, id: string, opts: { language?: string; keyterms?: string[]; lyrics?: string; model?: string; needTimings: boolean }) {
    const w = await soundOf(rt, id);
    if (opts.lyrics) {
      const r = route(deps, "alignment", "audio", opts.model);
      rt.progress?.("Timing the lyrics…");
      const [chunk] = await speechChunks(w, w.toMs - w.fromMs + 1);
      const t = await alignText({ ...r, audio: chunk!.blob, text: opts.lyrics, signal: rt.signal });
      return { w, r, text: t.text, language: undefined, words: t.words.map((x) => ({ ...x, startMs: w.toComp(chunk!.fromMs + x.startMs), endMs: w.toComp(chunk!.fromMs + x.endMs) })) };
    }
    let r = route(deps, "transcription", "audio", opts.model);
    if (opts.needTimings && !givesWordTimings(r.connection, r.model)) {
      const timed = modelsFor(r.connection, "transcription").find((m) => givesWordTimings(r.connection, m.id));
      if (!timed) throw new ApiError(`${by(r)} gives no word timings, which this needs.`, "Route transcription to Whisper (OpenAI, Groq), ElevenLabs Scribe or fal.");
      r = { ...r, model: timed.id };
    }
    // OpenAI's endpoints take 25 MB a request: 10 minutes of 16 kHz mono.
    const chunkMs = r.connection.providerId === "elevenlabs" || r.connection.providerId === "fal" ? 60 * 60_000 : 10 * 60_000;
    const chunks = await speechChunks(w, chunkMs);
    const words: TimedWord[] = [];
    const texts: string[] = [];
    let language: string | undefined;
    for (const [i, chunk] of chunks.entries()) {
      rt.progress?.(chunks.length > 1 ? `Transcribing ${i + 1}/${chunks.length}…` : "Transcribing…");
      const t = await transcribe({ ...r, audio: chunk.blob, language: opts.language, keyterms: opts.keyterms, signal: rt.signal });
      texts.push(t.text.trim());
      language ??= t.language;
      for (const x of t.words) words.push({ text: x.text.trim(), startMs: w.toComp(chunk.fromMs + x.startMs), endMs: w.toComp(chunk.fromMs + x.endMs) });
    }
    return { w, r, text: texts.join(" "), language, words: words.filter((x) => x.text) };
  }

  const pausesOf = (words: TimedWord[], minGapMs: number, padMs: number) => silencesBetween(words, minGapMs, padMs).map(([startMs, endMs]) => ({ startMs, endMs }));

  const mediaTranscribe = defineCommand({
    id: "media.transcribe",
    summary: "Transcribe speech (or time KNOWN lyrics/script with `lyrics`) in a layer, asset or attachment — word-timed, in comp time for a layer — optionally as caption layers.",
    details:
      "Returns the text and `pauses` ({startMs,endMs}, comp time — feed them to timeline.cut_ranges). `captions` lays the words out as one caption layer per readable phrase, word cues synced, above the source. `keyterms` spell names and jargon right. `lyrics` aligns the given text instead of recognising it (songs, a script read aloud). Words are returned only with `words: true` (they are long).",
    effect: "write",
    input: z.object({
      id: z.string(),
      language: z.string().optional(),
      keyterms: z.array(z.string()).max(50).optional(),
      lyrics: z.string().max(20_000).optional(),
      captions: z
        .object({ maxWords: z.number().int().min(1).max(12).default(4), y: z.number().optional(), style: z.record(z.string(), z.unknown()).optional() })
        .optional(),
      words: z.boolean().default(false),
      model: modelInput,
    }),
    async run(input, rt) {
      const t = await wordsOf(rt, input.id, { ...input, needTimings: !!input.captions });
      const created: string[] = [];
      if (input.captions) {
        if (!t.words.length) throw new ApiError("No words were heard, so there is nothing to caption.");
        const frame = t.w.clip ? frameAt(rt, t.w.clip.frameId) : frameAt(rt);
        const phrases = phrasesFromWords(t.words, { maxWords: input.captions.maxWords });
        rt.write("Captions from transcript", (d) => {
          for (const p of phrases) {
            const clip = createCaptionClip({ frameId: frame.id, text: p.text, startMs: p.startMs, durationMs: Math.max(1, p.endMs - p.startMs), y: input.captions!.y ?? Math.round(frame.height * 0.3) });
            if (clip.caption) clip.caption.cues = p.cues;
            if (input.captions!.style) Object.assign(clip.style, input.captions!.style);
            // Settled: consecutive phrases never overlap, so they share one lane above the video.
            placeClip(d, clip, { ...(t.w.clip && locateClip(d, t.w.clip.id) ? { aboveClipId: t.w.clip.id } : {}), landing: "settle" });
            created.push(clip.id);
          }
        });
      }
      return {
        text: t.text,
        ...(t.language ? { language: t.language } : {}),
        wordCount: t.words.length,
        pauses: pausesOf(t.words, 700, 120),
        ...(created.length ? { captionLayers: created.length, captionIds: created } : {}),
        ...(input.words ? { words: t.words } : {}),
        by: by(t.r),
      };
    },
  });

  const removePauses = defineCommand({
    id: "media.remove_pauses",
    summary: "Tighten speech: hear where the words are, then cut every pause longer than `minGapMs` (and dead air at the head and tail), rippling the comp in sync — one undo.",
    details:
      "Leaves `padMs` of air around words so cuts breathe. `ripple: sync` keeps captions and titles on their words and shortens a music bed instead of jumping it. `dryRun` returns the ranges without cutting (show the user, or hand-pick them into timeline.cut_ranges).",
    effect: "write",
    input: z.object({
      id: z.string().describe("A video or audio layer."),
      minGapMs: z.number().min(150).max(5000).default(600),
      padMs: z.number().min(0).max(500).default(120),
      ripple: z.enum(["sync", "lane", "none"]).default("sync"),
      language: z.string().optional(),
      dryRun: z.boolean().default(false),
      model: modelInput,
    }),
    async run(input, rt) {
      const loc = locateClip(rt.doc(), input.id);
      if (!loc || (loc.clip.kind !== "video" && loc.clip.kind !== "audio")) throw new ApiError("Point this at a video or audio layer on the timeline.");
      const t = await wordsOf(rt, input.id, { language: input.language, model: input.model, needTimings: true });
      if (!t.words.length) throw new ApiError("No speech was heard in that layer.");
      const start = loc.clip.startMs;
      const end = start + loc.clip.durationMs;
      const first = Math.min(...t.words.map((w) => w.startMs));
      const last = Math.max(...t.words.map((w) => w.endMs));
      const ranges = [
        ...(first - input.padMs - start >= input.minGapMs ? [{ startMs: start, endMs: first - input.padMs }] : []),
        ...pausesOf(t.words, input.minGapMs, input.padMs),
        ...(end - (last + input.padMs) >= input.minGapMs ? [{ startMs: last + input.padMs, endMs: end }] : []),
      ];
      if (!ranges.length) return { cuts: 0, removedMs: 0, note: `No pause longer than ${input.minGapMs} ms.` };
      if (input.dryRun) return { ranges, removableMs: ranges.reduce((n, x) => n + x.endMs - x.startMs, 0), by: by(t.r) };
      let res: ReturnType<typeof cutRanges> | null = null;
      rt.write("Remove pauses", (d) => {
        res = cutRanges(d, input.id, ranges, input.ripple);
      });
      const done = res as ReturnType<typeof cutRanges> | null;
      return { cuts: done?.cut.length ?? 0, removedMs: Math.round(done?.removedMs ?? 0), pieces: done?.pieces ?? [], by: by(t.r) };
    },
  });

  return [
    generateImageCmd,
    mediaCutout,
    mediaUpscale,
    generateVideoCmd,
    generateSpeechCmd,
    voicesList,
    generateSoundCmd,
    generateMusicCmd,
    audioIsolate,
    mediaTranscribe,
    removePauses,
  ];
}
