import { baseUrlOf, providerDef, type Connection, type MediaCapability } from "./providers";
import { AbortedError, classify, sleep } from "./retry";

/**
 * GENERATION — every media job an AI can do for an editor: draw and edit
 * pictures, shoot and edit footage, speak, transcribe, time known lyrics, make
 * sound effects and music, cut subjects out, clean up voices, add resolution.
 *
 * The app never asks "is this ElevenLabs?"; it asks for `speech` and gets bytes
 * back. Each capability is ONE function with ONE result shape; each provider is
 * one arm inside it. So the host verb that files a result in the Media
 * library, stamps its provenance and places it on the timeline is written
 * once, whoever made it — and the chat agent, the right-click menu, MCP
 * clients and plugins all reach these through that one verb.
 *
 * Field names and model ids were checked against each vendor's official SDK
 * types (openai 7.23, @google/genai 2.24, @fal-ai/client 1.10's endpoint map,
 * @elevenlabs/elevenlabs-js 2.69). The SDKs load on first use.
 */

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface GeneratedMedia {
  blob: Blob;
  mediaType: string;
  /** A filename to import it under. */
  name: string;
  /** What made it — recorded on the asset so its history is never a mystery. */
  provenance: { capability: MediaCapability; provider: string; model: string; prompt: string; at: number };
  /**
   * Speech only: the provider's own timing of what it said, per character, in
   * ms from the start of the audio — when it returns one (ElevenLabs
   * `with-timestamps`). Lip sync takes it as ground truth.
   */
  alignment?: { characters: string[]; startMs: number[]; endMs: number[] };
}

interface JobBase {
  connection: Connection;
  model: string;
  signal?: AbortSignal;
  /** "Queued (#3) · 12s", "Generating · 40%" — for a status line. */
  onProgress?: (text: string) => void;
}

export type Aspect = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";

export interface ImageRequest extends JobBase {
  prompt: string;
  aspect?: Aspect;
  count?: number;
  /** Pictures to edit or follow — the first is the one being edited. */
  images?: Blob[];
  /** Ask for an alpha background where the model can draw one. */
  transparent?: boolean;
}

export interface VideoRequest extends JobBase {
  prompt: string;
  aspect?: "16:9" | "9:16" | "1:1";
  durationS?: number;
  /** A still to animate from (the first frame). */
  image?: Blob;
  /** Footage to edit. */
  video?: Blob;
  /** Let the model score its own sound (Veo, Kling, Sora do). */
  audio?: boolean;
}

export interface SpeechRequest extends JobBase {
  text: string;
  voice?: string;
  /** A performance note: "warm, unhurried", "whispering". */
  style?: string;
}

export interface TranscribeRequest extends JobBase {
  audio: Blob;
  language?: string;
  /** Names and jargon to spell right. */
  keyterms?: string[];
}

export interface AlignRequest extends JobBase {
  audio: Blob;
  /** The words that are sung or spoken — lyrics, a script. */
  text: string;
}

export interface SoundRequest extends JobBase {
  prompt: string;
  durationS?: number;
  loop?: boolean;
}

export interface MusicRequest extends JobBase {
  prompt: string;
  durationS?: number;
  instrumental?: boolean;
}

/** Cut-out, voice isolation, upscaling: one medium in, the same kind out. */
export interface MediaJobRequest extends JobBase {
  media: Blob;
  /** Upscale factor. */
  factor?: number;
}

export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface Transcript {
  text: string;
  /** Word timings in ms from the start of the audio, when the provider gives them. */
  words: TimedWord[];
  language?: string;
}

export interface Voice {
  id: string;
  name: string;
  /** "warm · british · narration" */
  description?: string;
}

// ── Transport ────────────────────────────────────────────────────────────────

let transport: typeof fetch | undefined;

/**
 * Route every generation request through another fetch — tests, and a hosted
 * relay for providers that refuse browser requests.
 */
export function setGenerationFetch(f: typeof fetch | undefined): void {
  transport = f;
}
const http: typeof fetch = (input, init) => (transport ?? globalThis.fetch)(input, init);

export function canDo(connection: Connection, capability: MediaCapability): boolean {
  return providerDef(connection.providerId)?.capabilities.includes(capability) ?? false;
}

function need(c: Connection, capability: MediaCapability): void {
  if (!canDo(c, capability)) throw new Error(`${c.label} cannot do ${capability}.`);
}

const notWired = (c: Connection, what: string) => new Error(`${what} through ${c.label} is not available — route it to another connection.`);

async function openai(c: Connection) {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey: c.values.apiKey ?? "", baseURL: baseUrlOf(c), dangerouslyAllowBrowser: true, maxRetries: 2, fetch: http });
}

async function google(c: Connection) {
  const { GoogleGenAI } = await import("@google/genai");
  // The chat connection points at Gemini's OpenAI-compatible path; the native
  // API (images, Veo, voices) lives at the same host.
  const baseUrl = baseUrlOf(c).replace(/\/v1beta\/openai$/, "") || undefined;
  return new GoogleGenAI({ apiKey: c.values.apiKey ?? "", httpOptions: baseUrl ? { baseUrl } : undefined });
}

async function fal(c: Connection) {
  const { createFalClient } = await import("@fal-ai/client");
  return createFalClient({ credentials: c.values.apiKey ?? "", suppressLocalCredentialsWarning: true, fetch: http });
}

type FalClient = Awaited<ReturnType<typeof fal>>;

/** Submit to fal's queue, report progress, return the result. */
async function falRun(client: FalClient, model: string, input: Record<string, unknown>, job: JobBase): Promise<Record<string, unknown>> {
  const started = Date.now();
  try {
    const res = await client.subscribe(model, {
      input,
      abortSignal: job.signal,
      onQueueUpdate: (s) => {
        const secs = Math.round((Date.now() - started) / 1000);
        const q = s as { status: string; queue_position?: number };
        job.onProgress?.(q.status === "IN_QUEUE" ? `Queued${q.queue_position != null ? ` (#${q.queue_position})` : ""} · ${secs}s` : `Generating · ${secs}s`);
      },
    });
    return res.data as Record<string, unknown>;
  } catch (err) {
    if (job.signal?.aborted) throw new AbortedError();
    const e = err as { status?: number; body?: unknown; message?: string };
    throw classify({ status: e.status, message: e.body ? JSON.stringify(e.body).slice(0, 400) : e.message });
  }
}

const falUpload = (client: FalClient, blob: Blob) => client.storage.upload(blob);

/** The file a fal result carries: `images[0]`, `image`, `video` or `audio`. */
function falFiles(out: Record<string, unknown>): Array<{ url: string; content_type?: string }> {
  const images = out.images as Array<{ url: string; content_type?: string }> | undefined;
  if (images?.length) return images;
  for (const key of ["image", "video", "audio"]) {
    const f = out[key] as { url?: string; content_type?: string } | undefined;
    if (f?.url) return [{ url: f.url, content_type: f.content_type }];
  }
  throw new Error("The provider finished without a file.");
}

async function fetchBlob(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<Blob> {
  const res = await http(url, { signal, headers });
  if (!res.ok) throw classify({ status: res.status, message: `Could not download the result (${res.status}).` });
  return res.blob();
}

async function elevenFetch(c: Connection, path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const res = await http(`${baseUrlOf(c)}${path}`, {
    ...init,
    signal,
    headers: { "xi-api-key": c.values.apiKey ?? "", ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw classify({ status: res.status, message: (await res.text()).slice(0, 400) });
  return res;
}

// ── Bytes ────────────────────────────────────────────────────────────────────

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const b64ToBlob = (b64: string, type: string) => new Blob([b64ToBytes(b64) as BlobPart], { type });

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Raw 16-bit PCM (Gemini's voice output) → a WAV file every player opens. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const text = (o: number, s: string) => [...s].forEach((ch, i) => header.setUint8(o + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  header.setUint32(4, 36 + pcm.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, channels, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * channels * 2, true);
  header.setUint16(32, channels * 2, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, pcm.length, true);
  return new Blob([header.buffer, pcm as BlobPart], { type: "audio/wav" });
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg" };
const extOf = (type: string, fallback: string) => EXT[type.split(";")[0]!] ?? fallback;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "generated";

function media(job: JobBase, capability: MediaCapability, prompt: string, blob: Blob, fallbackType: string, suffix = ""): GeneratedMedia {
  const type = blob.type && blob.type !== "application/octet-stream" ? blob.type.split(";")[0]! : fallbackType;
  const typed = blob.type === type ? blob : new Blob([blob], { type });
  return {
    blob: typed,
    mediaType: type,
    name: `${slug(prompt)}${suffix}.${extOf(type, fallbackType.split("/")[1] ?? "bin")}`,
    provenance: { capability, provider: job.connection.providerId, model: job.model, prompt, at: Date.now() },
  };
}

const nearest = (v: number, options: number[]) => options.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
const kindOf = (b: Blob) => (b.type.startsWith("video/") ? "video" : b.type.startsWith("audio/") ? "audio" : "image");
const asFile = (b: Blob, stem: string) => new File([b], `${stem}.${extOf(b.type, "bin")}`, { type: b.type || "application/octet-stream" });

/** Fit a still to exactly `w×h` (cover) — Sora wants its reference at the output size. */
async function coverTo(blob: Blob, w: number, h: number): Promise<Blob> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return blob;
  const bmp = await createImageBitmap(blob);
  if (bmp.width === w && bmp.height === h) return blob;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  const s = Math.max(w / bmp.width, h / bmp.height);
  ctx.drawImage(bmp, (w - bmp.width * s) / 2, (h - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
  return canvas.convertToBlob({ type: "image/png" });
}

// ── Images ───────────────────────────────────────────────────────────────────

export async function generateImage(req: ImageRequest): Promise<GeneratedMedia[]> {
  need(req.connection, "image");
  const n = Math.max(1, Math.min(4, req.count ?? 1));
  const images = req.images ?? [];
  const pid = req.connection.providerId;
  const suffix = (i: number) => (n > 1 ? `-${i + 1}` : "");

  if (pid === "openai") {
    const api = await openai(req.connection);
    const size = req.aspect === "16:9" || req.aspect === "4:3" ? "1536x1024" : req.aspect === "9:16" || req.aspect === "3:4" ? "1024x1536" : "1024x1024";
    const alpha = req.transparent ? { background: "transparent" as const, output_format: "png" as const } : {};
    const res = images.length
      ? await api.images.edit(
          { model: req.model, prompt: req.prompt, n, size, image: images.map((b, i) => asFile(b, `input-${i + 1}`)), input_fidelity: "high", ...alpha },
          { signal: req.signal },
        )
      : await api.images.generate({ model: req.model, prompt: req.prompt, n, size, ...alpha }, { signal: req.signal });
    return (res.data ?? []).filter((d) => d.b64_json).map((d, i) => media(req, "image", req.prompt, b64ToBlob(d.b64_json!, "image/png"), "image/png", suffix(i)));
  }

  if (pid === "google") {
    const ai = await google(req.connection);
    if (/imagen/.test(req.model)) {
      if (images.length) throw new Error("Imagen draws from words only — pick a Nano Banana (Gemini image) model to edit a picture.");
      const res = await ai.models.generateImages({
        model: req.model,
        prompt: req.prompt,
        config: { numberOfImages: n, aspectRatio: req.aspect ?? "1:1", abortSignal: req.signal },
      });
      return (res.generatedImages ?? [])
        .filter((g) => g.image?.imageBytes)
        .map((g, i) => media(req, "image", req.prompt, b64ToBlob(g.image!.imageBytes!, g.image!.mimeType ?? "image/png"), "image/png", suffix(i)));
    }
    const inline = await Promise.all(images.map(async (b) => ({ inlineData: { mimeType: b.type || "image/png", data: await blobToBase64(b) } })));
    const out: GeneratedMedia[] = [];
    for (let i = 0; i < n; i++) {
      const res = await ai.models.generateContent({
        model: req.model,
        contents: [{ role: "user", parts: [{ text: req.prompt }, ...inline] }],
        config: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: req.aspect ?? "1:1" }, abortSignal: req.signal },
      });
      const got = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
      if (!got?.data) throw new Error(res.text?.trim() || "The model answered without an image.");
      out.push(media(req, "image", req.prompt, b64ToBlob(got.data, got.mimeType ?? "image/png"), "image/png", suffix(i)));
    }
    return out;
  }

  if (pid === "fal") {
    const client = await fal(req.connection);
    const urls = await Promise.all(images.map((b) => falUpload(client, b)));
    const out = await falRun(
      client,
      req.model,
      {
        prompt: req.prompt,
        num_images: n,
        // Families disagree on how to ask for a shape; each ignores the other's field.
        aspect_ratio: req.aspect ?? "1:1",
        image_size: falSize(req.aspect),
        output_format: "png",
        ...(urls.length ? { image_urls: urls, image_url: urls[0] } : {}),
      },
      req,
    );
    return Promise.all(falFiles(out).map(async (f, i) => media(req, "image", req.prompt, await fetchBlob(f.url, req.signal), f.content_type ?? "image/png", suffix(i))));
  }
  throw notWired(req.connection, "Images");
}

function falSize(aspect: Aspect | undefined): string {
  return aspect === "16:9" ? "landscape_16_9" : aspect === "9:16" ? "portrait_16_9" : aspect === "4:3" ? "landscape_4_3" : aspect === "3:4" ? "portrait_4_3" : "square_hd";
}

// ── Video ────────────────────────────────────────────────────────────────────

export async function generateVideo(req: VideoRequest): Promise<GeneratedMedia> {
  need(req.connection, "video");
  const pid = req.connection.providerId;
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);

  if (pid === "openai") {
    const api = await openai(req.connection);
    const size = req.aspect === "9:16" ? "720x1280" : "1280x720";
    const [w, h] = size.split("x").map(Number) as [number, number];
    const seconds = String(nearest(req.durationS ?? 8, [4, 8, 12])) as "4" | "8" | "12";
    let job = req.video
      ? await api.videos.edit({ prompt: req.prompt, video: asFile(req.video, "source") }, { signal: req.signal })
      : await api.videos.create(
          {
            model: req.model,
            prompt: req.prompt,
            seconds,
            size,
            ...(req.image ? { input_reference: asFile(await coverTo(req.image, w, h), "first-frame") } : {}),
          },
          { signal: req.signal },
        );
    while (job.status === "queued" || job.status === "in_progress") {
      req.onProgress?.(job.status === "queued" ? `Queued · ${secs()}s` : `Generating · ${Math.round(job.progress ?? 0)}% · ${secs()}s`);
      if (secs() > 20 * 60) throw new Error("Gave up after 20 minutes.");
      await sleep(5000, req.signal);
      job = await api.videos.retrieve(job.id, { signal: req.signal });
    }
    if (job.status !== "completed") throw new Error(job.error?.message ?? "The video failed on the provider.");
    const content = await api.videos.downloadContent(job.id, undefined, { signal: req.signal });
    return media(req, "video", req.prompt, await content.blob(), "video/mp4");
  }

  if (pid === "google") {
    if (req.video) throw new Error("Veo animates words and stills — pick a video-edit model (fal: Kling O3 edit, OpenAI: Sora) to change footage.");
    const ai = await google(req.connection);
    let op = await ai.models.generateVideos({
      model: req.model,
      source: {
        prompt: req.prompt,
        ...(req.image ? { image: { imageBytes: await blobToBase64(req.image), mimeType: req.image.type || "image/png" } } : {}),
      },
      config: {
        numberOfVideos: 1,
        aspectRatio: req.aspect === "9:16" ? "9:16" : "16:9",
        ...(req.durationS ? { durationSeconds: nearest(req.durationS, [4, 6, 8]) } : {}),
        abortSignal: req.signal,
      },
    });
    while (!op.done) {
      req.onProgress?.(`Generating · ${secs()}s`);
      if (secs() > 20 * 60) throw new Error("Gave up after 20 minutes.");
      await sleep(8000, req.signal);
      op = await ai.operations.getVideosOperation({ operation: op });
    }
    if (op.error) throw new Error(String((op.error as { message?: string }).message ?? "The video failed on the provider."));
    const video = op.response?.generatedVideos?.[0]?.video;
    if (!video) throw new Error(op.response?.raiMediaFilteredReasons?.[0] ?? "The provider finished without a video.");
    const blob = video.videoBytes
      ? b64ToBlob(video.videoBytes, video.mimeType ?? "video/mp4")
      : await fetchBlob(video.uri!, req.signal, { "x-goog-api-key": req.connection.values.apiKey ?? "" });
    return media(req, "video", req.prompt, blob, "video/mp4");
  }

  if (pid === "fal") {
    const client = await fal(req.connection);
    const image = req.image ? await falUpload(client, req.image) : undefined;
    const video = req.video ? await falUpload(client, req.video) : undefined;
    const d = req.durationS;
    const duration =
      d == null
        ? undefined
        : /veo/.test(req.model)
          ? `${nearest(d, [4, 6, 8])}s`
          : /sora/.test(req.model)
            ? String(nearest(d, [4, 8, 12, 16, 20]))
            : /kling/.test(req.model)
              ? String(Math.max(3, Math.min(15, Math.round(d))))
              : String(Math.round(d));
    const out = await falRun(
      client,
      req.model,
      {
        prompt: req.prompt,
        aspect_ratio: req.aspect ?? "16:9",
        ...(duration ? { duration } : {}),
        ...(req.audio != null ? { generate_audio: req.audio } : {}),
        // Image-to-video endpoints name their still `image_url` (Veo, Sora) or `start_image_url` (Kling).
        ...(image ? { image_url: image, start_image_url: image } : {}),
        ...(video ? { video_url: video, keep_audio: true } : {}),
      },
      req,
    );
    const f = falFiles(out)[0]!;
    return media(req, "video", req.prompt, await fetchBlob(f.url, req.signal), f.content_type ?? "video/mp4");
  }
  throw notWired(req.connection, "Video");
}

// ── Speech ───────────────────────────────────────────────────────────────────

/** ElevenLabs' stock narrator, used when a connection names no voice. */
const ELEVEN_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";

/** Eleven v3 is directed with inline audio tags; older models ignore a style note. */
const directed = (model: string, text: string, style?: string) => (style && /v3/.test(model) ? `[${style}] ${text}` : text);

export async function generateSpeech(req: SpeechRequest): Promise<GeneratedMedia> {
  need(req.connection, "speech");
  const pid = req.connection.providerId;

  if (pid === "openai") {
    const api = await openai(req.connection);
    const res = await api.audio.speech.create(
      { model: req.model, voice: req.voice || "marin", input: req.text, response_format: "mp3", ...(req.style ? { instructions: req.style } : {}) },
      { signal: req.signal },
    );
    return media(req, "speech", req.text, new Blob([await res.arrayBuffer()], { type: "audio/mpeg" }), "audio/mpeg");
  }

  if (pid === "elevenlabs") {
    const voice = req.voice || req.connection.values.voiceId || ELEVEN_DEFAULT_VOICE;
    // `with-timestamps`: the same audio plus the voice's own character timing,
    // which lip sync uses as ground truth instead of guessing from the sound.
    const res = await elevenFetch(
      req.connection,
      `/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: directed(req.model, req.text, req.style), model_id: req.model }) },
      req.signal,
    );
    const body = (await res.json()) as {
      audio_base64: string;
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null;
    };
    const out = media(req, "speech", req.text, b64ToBlob(body.audio_base64, "audio/mpeg"), "audio/mpeg");
    const a = body.alignment;
    return a?.characters?.length
      ? { ...out, alignment: { characters: a.characters, startMs: a.character_start_times_seconds.map((t) => t * 1000), endMs: a.character_end_times_seconds.map((t) => t * 1000) } }
      : out;
  }

  if (pid === "google") {
    const ai = await google(req.connection);
    const res = await ai.models.generateContent({
      model: req.model,
      contents: [{ role: "user", parts: [{ text: req.style ? `Say it ${req.style}: ${req.text}` : req.text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice || "Kore" } } },
        abortSignal: req.signal,
      },
    });
    const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!data?.data) throw new Error("The model answered without audio.");
    const rate = Number(/rate=(\d+)/.exec(data.mimeType ?? "")?.[1] ?? 24000);
    const blob = /wav|mpeg|mp3|ogg/.test(data.mimeType ?? "") ? b64ToBlob(data.data, data.mimeType!) : pcmToWav(b64ToBytes(data.data), rate);
    return media(req, "speech", req.text, blob, "audio/wav");
  }

  if (pid === "fal") {
    const client = await fal(req.connection);
    const out = await falRun(client, req.model, { text: directed(req.model, req.text, req.style), ...(req.voice ? { voice: req.voice } : {}) }, req);
    const f = falFiles(out)[0]!;
    return media(req, "speech", req.text, await fetchBlob(f.url, req.signal), f.content_type ?? "audio/mpeg");
  }
  throw notWired(req.connection, "Speech");
}

/** Voices a speech connection offers — so "a warm British narrator" can be matched to an id. */
export async function listVoices(c: Connection, signal?: AbortSignal): Promise<Voice[]> {
  switch (c.providerId) {
    case "elevenlabs": {
      const res = await elevenFetch(c, "/voices", { method: "GET" }, signal);
      const body = (await res.json()) as { voices: Array<{ voice_id: string; name: string; labels?: Record<string, string>; description?: string | null }> };
      return body.voices.map((v) => ({ id: v.voice_id, name: v.name, description: [...Object.values(v.labels ?? {}), v.description].filter(Boolean).join(" · ") || undefined }));
    }
    case "openai":
      return OPENAI_VOICES.map(([id, description]) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), description }));
    case "google":
      return GEMINI_VOICES.map(([id, description]) => ({ id, name: id, description }));
    case "fal":
      return FAL_ELEVEN_VOICES.map((n) => ({ id: n, name: n }));
    default:
      return [];
  }
}

const OPENAI_VOICES: Array<[string, string]> = [
  ["marin", "natural, warm — the best all-rounder"],
  ["cedar", "natural, deep"],
  ["alloy", "neutral"],
  ["ash", "clear, confident"],
  ["ballad", "soft, expressive"],
  ["coral", "bright, friendly"],
  ["echo", "calm"],
  ["sage", "measured"],
  ["shimmer", "light, upbeat"],
  ["verse", "dynamic"],
];

const GEMINI_VOICES: Array<[string, string]> = [
  ["Kore", "firm"], ["Puck", "upbeat"], ["Charon", "informative"], ["Zephyr", "bright"], ["Fenrir", "excitable"],
  ["Leda", "youthful"], ["Orus", "firm"], ["Aoede", "breezy"], ["Callirrhoe", "easy-going"], ["Autonoe", "bright"],
  ["Enceladus", "breathy"], ["Iapetus", "clear"], ["Umbriel", "easy-going"], ["Algieba", "smooth"], ["Despina", "smooth"],
  ["Erinome", "clear"], ["Algenib", "gravelly"], ["Rasalgethi", "informative"], ["Laomedeia", "upbeat"], ["Achernar", "soft"],
  ["Alnilam", "firm"], ["Schedar", "even"], ["Gacrux", "mature"], ["Pulcherrima", "forward"], ["Achird", "friendly"],
  ["Zubenelgenubi", "casual"], ["Vindemiatrix", "gentle"], ["Sadachbia", "lively"], ["Sadaltager", "knowledgeable"], ["Sulafat", "warm"],
];

const FAL_ELEVEN_VOICES = ["Rachel", "Aria", "Roger", "Sarah", "Laura", "Charlie", "George", "Callum", "River", "Liam", "Charlotte", "Alice", "Matilda", "Will", "Jessica", "Eric", "Chris", "Brian", "Daniel", "Lily", "Bill"];

// ── Transcription and alignment ──────────────────────────────────────────────

/** Whether this model returns word timings (what captions and pause removal need). */
export function givesWordTimings(c: Connection, model: string): boolean {
  if (c.providerId === "elevenlabs" || c.providerId === "fal") return true;
  return /whisper/.test(model);
}

type ScribeWord = { text: string; start: number; end: number; type?: string };
const scribeWords = (words: ScribeWord[] | undefined): TimedWord[] =>
  (words ?? []).filter((w) => w.type == null || w.type === "word").map((w) => ({ text: w.text, startMs: w.start * 1000, endMs: w.end * 1000 }));

export async function transcribe(req: TranscribeRequest): Promise<Transcript> {
  need(req.connection, "transcription");
  const pid = req.connection.providerId;
  const file = asFile(req.audio, "audio");

  if (pid === "elevenlabs") {
    const form = new FormData();
    form.append("file", file);
    form.append("model_id", req.model);
    form.append("timestamps_granularity", "word");
    if (req.language) form.append("language_code", req.language);
    for (const k of req.keyterms ?? []) form.append("keyterms", k);
    const res = await elevenFetch(req.connection, "/speech-to-text", { method: "POST", body: form }, req.signal);
    const body = (await res.json()) as { text: string; language_code?: string; words?: ScribeWord[] };
    return { text: body.text, language: body.language_code, words: scribeWords(body.words) };
  }

  if (pid === "fal") {
    const client = await fal(req.connection);
    const out = await falRun(
      client,
      req.model,
      { audio_url: await falUpload(client, req.audio), ...(req.language ? { language_code: req.language } : {}), ...(req.keyterms?.length ? { keyterms: req.keyterms } : {}) },
      req,
    );
    return { text: String(out.text ?? ""), language: out.language_code as string | undefined, words: scribeWords(out.words as ScribeWord[] | undefined) };
  }

  // OpenAI and every mirror of its audio endpoint (Groq, a gateway).
  const api = await openai(req.connection);
  const wordLevel = /whisper/.test(req.model);
  const res = (await api.audio.transcriptions.create(
    {
      file,
      model: req.model,
      ...(req.language ? { language: req.language } : {}),
      ...(wordLevel
        ? { response_format: "verbose_json", timestamp_granularities: ["word", "segment"], ...(req.keyterms?.length ? { prompt: req.keyterms.join(", ") } : {}) }
        : { response_format: "json", ...(req.keyterms?.length && /gpt-transcribe/.test(req.model) ? { keywords: req.keyterms } : {}) }),
    },
    { signal: req.signal },
  )) as { text: string; language?: string; words?: Array<{ word: string; start: number; end: number }> };
  return { text: res.text, language: res.language, words: (res.words ?? []).map((w) => ({ text: w.word, startMs: w.start * 1000, endMs: w.end * 1000 })) };
}

/** Time a KNOWN text to its audio, word by word — lyrics, a script read aloud. */
export async function alignText(req: AlignRequest): Promise<Transcript> {
  need(req.connection, "alignment");
  if (req.connection.providerId !== "elevenlabs") throw notWired(req.connection, "Alignment");
  const form = new FormData();
  form.append("file", asFile(req.audio, "audio"));
  form.append("text", req.text);
  const res = await elevenFetch(req.connection, "/forced-alignment", { method: "POST", body: form }, req.signal);
  const body = (await res.json()) as { words: Array<{ text: string; start: number; end: number }> };
  return { text: req.text, words: body.words.filter((w) => w.text.trim()).map((w) => ({ text: w.text.trim(), startMs: w.start * 1000, endMs: w.end * 1000 })) };
}

// ── Sound effects and music ──────────────────────────────────────────────────

export async function generateSound(req: SoundRequest): Promise<GeneratedMedia> {
  need(req.connection, "sound");
  const duration = req.durationS != null ? Math.max(0.5, Math.min(30, req.durationS)) : undefined;
  const body = { text: req.prompt, prompt_influence: 0.4, ...(duration ? { duration_seconds: duration } : {}), ...(req.loop ? { loop: true } : {}) };
  if (req.connection.providerId === "elevenlabs") {
    const res = await elevenFetch(
      req.connection,
      "/sound-generation?output_format=mp3_44100_128",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, model_id: req.model }) },
      req.signal,
    );
    return media(req, "sound", req.prompt, await res.blob(), "audio/mpeg");
  }
  if (req.connection.providerId === "fal") {
    const client = await fal(req.connection);
    const f = falFiles(await falRun(client, req.model, body, req))[0]!;
    return media(req, "sound", req.prompt, await fetchBlob(f.url, req.signal), f.content_type ?? "audio/mpeg");
  }
  throw notWired(req.connection, "Sound effects");
}

export async function generateMusic(req: MusicRequest): Promise<GeneratedMedia> {
  need(req.connection, "music");
  const lengthMs = Math.round(Math.max(10, Math.min(300, req.durationS ?? 30)) * 1000);
  const body = { prompt: req.prompt, music_length_ms: lengthMs, ...(req.instrumental ? { force_instrumental: true } : {}) };
  if (req.connection.providerId === "elevenlabs") {
    const res = await elevenFetch(
      req.connection,
      "/music?output_format=mp3_44100_128",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, model_id: req.model }) },
      req.signal,
    );
    return media(req, "music", req.prompt, await res.blob(), "audio/mpeg");
  }
  if (req.connection.providerId === "fal") {
    const client = await fal(req.connection);
    const f = falFiles(await falRun(client, req.model, body, req))[0]!;
    return media(req, "music", req.prompt, await fetchBlob(f.url, req.signal), f.content_type ?? "audio/mpeg");
  }
  throw notWired(req.connection, "Music");
}

// ── Cut-out, voice isolation, upscaling ──────────────────────────────────────

/** Remove the background from an image (→ PNG with alpha) or a video (→ WebM with alpha). */
export async function cutout(req: MediaJobRequest): Promise<GeneratedMedia> {
  need(req.connection, "cutout");
  if (req.connection.providerId !== "fal") throw notWired(req.connection, "Background removal");
  const client = await fal(req.connection);
  const url = await falUpload(client, req.media);
  const isVideo = kindOf(req.media) === "video";
  const out = await falRun(
    client,
    req.model,
    isVideo
      ? { video_url: url, refine_foreground: true, video_output_type: "VP9 (.webm)", video_quality: "high" }
      : { image_url: url, refine_foreground: true, output_format: "png" },
    req,
  );
  const f = falFiles(out)[0]!;
  return media(req, "cutout", "cutout", await fetchBlob(f.url, req.signal), isVideo ? "video/webm" : "image/png");
}

/** Keep the voice, lose the room, the hum and the music. */
export async function isolateVoice(req: MediaJobRequest): Promise<GeneratedMedia> {
  need(req.connection, "isolate");
  if (req.connection.providerId === "elevenlabs") {
    const form = new FormData();
    form.append("audio", asFile(req.media, "source"));
    const res = await elevenFetch(req.connection, "/audio-isolation", { method: "POST", body: form }, req.signal);
    return media(req, "isolate", "voice", await res.blob(), "audio/mpeg");
  }
  if (req.connection.providerId === "fal") {
    const client = await fal(req.connection);
    const url = await falUpload(client, req.media);
    const f = falFiles(await falRun(client, req.model, kindOf(req.media) === "video" ? { video_url: url } : { audio_url: url }, req))[0]!;
    return media(req, "isolate", "voice", await fetchBlob(f.url, req.signal), f.content_type ?? "audio/mpeg");
  }
  throw notWired(req.connection, "Voice isolation");
}

export async function upscale(req: MediaJobRequest): Promise<GeneratedMedia> {
  need(req.connection, "upscale");
  if (req.connection.providerId !== "fal") throw notWired(req.connection, "Upscaling");
  const client = await fal(req.connection);
  const url = await falUpload(client, req.media);
  const isVideo = kindOf(req.media) === "video";
  const factor = Math.max(1, Math.min(4, req.factor ?? 2));
  const out = await falRun(client, req.model, isVideo ? { video_url: url, upscale_factor: factor, H264_output: true } : { image_url: url, upscale_factor: factor, output_format: "png" }, req);
  const f = falFiles(out)[0]!;
  return media(req, "upscale", `upscaled-${factor}x`, await fetchBlob(f.url, req.signal), isVideo ? "video/mp4" : "image/png");
}
