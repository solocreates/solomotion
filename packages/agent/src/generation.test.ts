import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  alignText,
  cutout,
  generateImage,
  generateMusic,
  generateSound,
  generateSpeech,
  generateVideo,
  isolateVoice,
  listVoices,
  setGenerationFetch,
  transcribe,
  upscale,
} from "./generation";
import { classifyModelId, defaultChatModel, pickModel, type Connection } from "./providers";

/**
 * Every media job through the vendors' real SDKs (openai, @google/genai,
 * @fal-ai/client) or their REST contract (ElevenLabs), against local fakes
 * that answer the way each API does. What is asserted is what would reach
 * the vendor — endpoint, fields, files — and that the answer comes back as
 * one `GeneratedMedia` shape.
 */

interface Seen {
  method: string;
  url: string;
  type: string;
  body: string;
}

let server: Server;
let base = "";
const seen: Seen[] = [];
let route: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void = (_q, _b, res) => res.writeHead(404).end();

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? "", url: req.url ?? "", type: String(req.headers["content-type"] ?? ""), body: body.toString("latin1") });
      route(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  seen.length = 0;
  setGenerationFetch(undefined);
});

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const png = () => new Blob([Buffer.from(PNG_B64, "base64")], { type: "image/png" });
const json = (res: ServerResponse, body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const bytes = (res: ServerResponse, type: string, data = Buffer.from("RIFFdata")) => res.writeHead(200, { "content-type": type }).end(data);
const conn = (providerId: string, baseUrl?: string): Connection => ({ id: providerId, providerId, label: providerId, values: { apiKey: "key", ...(baseUrl ? { baseUrl } : {}) }, createdAt: 0 });

describe("OpenAI media", () => {
  it("edits an image with references and a transparent background", async () => {
    route = (req, _b, res) => (req.url === "/v1/images/edits" ? json(res, { created: 0, data: [{ b64_json: PNG_B64 }] }) : res.writeHead(404).end());
    const [out] = await generateImage({ connection: conn("openai", `${base}/v1`), model: "gpt-image-2", prompt: "Make the sky violet", images: [png(), png()], transparent: true });
    expect(out!.mediaType).toBe("image/png");
    expect(out!.provenance).toMatchObject({ capability: "image", provider: "openai", model: "gpt-image-2", prompt: "Make the sky violet" });
    const body = seen[0]!.body;
    expect(seen[0]!.type).toContain("multipart/form-data");
    expect(body).toContain('name="background"');
    expect(body).toContain("transparent");
    expect(body.match(/name="image\[\]"/g)?.length ?? body.match(/name="image"/g)?.length).toBe(2);
  });

  it("shoots a Sora video: create → poll → download", async () => {
    let polls = 0;
    route = (req, _b, res) => {
      if (req.method === "POST" && req.url === "/v1/videos") return json(res, { id: "vid_1", object: "video", status: "queued", progress: 0 });
      if (req.url === "/v1/videos/vid_1") return json(res, { id: "vid_1", object: "video", status: ++polls > 1 ? "completed" : "in_progress", progress: 50 });
      if (req.url?.startsWith("/v1/videos/vid_1/content")) return bytes(res, "video/mp4");
      res.writeHead(404).end();
    };
    const progress: string[] = [];
    const out = await generateVideo({ connection: conn("openai", `${base}/v1`), model: "sora-2", prompt: "A slow dolly past a neon sign", durationS: 7, onProgress: (p) => progress.push(p) });
    expect(out.mediaType).toBe("video/mp4");
    const create = seen.find((s) => s.method === "POST")!;
    expect(create.body).toContain("sora-2");
    expect(create.body).toContain('"8"'.slice(1, 2)); // seconds snapped to 8
    expect(progress.some((p) => p.includes("%"))).toBe(true);
  }, 20_000);

  it("transcribes with Whisper word timings", async () => {
    route = (_q, _b, res) => json(res, { text: "Hello world", language: "english", words: [{ word: "Hello", start: 0.1, end: 0.4 }, { word: "world", start: 0.5, end: 0.9 }] });
    const t = await transcribe({ connection: conn("openai", `${base}/v1`), model: "whisper-1", audio: new Blob(["x"], { type: "audio/wav" }), keyterms: ["SoloMotion"] });
    expect(t.words).toEqual([{ text: "Hello", startMs: 100, endMs: 400 }, { text: "world", startMs: 500, endMs: 900 }]);
    expect(seen[0]!.body).toContain("verbose_json");
    expect(seen[0]!.body).toContain("SoloMotion");
  });

  it("speaks with a performance note", async () => {
    route = (_q, _b, res) => bytes(res, "audio/mpeg");
    const out = await generateSpeech({ connection: conn("openai", `${base}/v1`), model: "gpt-4o-mini-tts", text: "Welcome.", style: "warm, unhurried" });
    expect(out.mediaType).toBe("audio/mpeg");
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ voice: "marin", instructions: "warm, unhurried", input: "Welcome." });
  });
});

describe("Google media (native Gemini API)", () => {
  it("draws with Nano Banana from a reference, and voices with Gemini TTS (PCM → WAV)", async () => {
    route = (req, _b, res) => {
      if (req.url?.includes("-image") && req.url.includes(":generateContent"))
        return json(res, { candidates: [{ content: { role: "model", parts: [{ text: "Here." }, { inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }] });
      if (req.url?.includes("-tts") && req.url.includes(":generateContent"))
        return json(res, { candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.alloc(480).toString("base64") } }] } }] });
      res.writeHead(404).end();
    };
    const c = conn("google", `${base}/v1beta/openai`);
    const [img] = await generateImage({ connection: c, model: "gemini-3-pro-image-preview", prompt: "Same scene at dusk", images: [png()], aspect: "16:9" });
    expect(img!.mediaType).toBe("image/png");
    const imgReq = JSON.parse(seen[0]!.body);
    expect(seen[0]!.url).toContain("/models/gemini-3-pro-image-preview:generateContent");
    expect(imgReq.contents[0].parts[1].inlineData.mimeType).toBe("image/png");
    expect(imgReq.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(imgReq.generationConfig.imageConfig).toEqual({ aspectRatio: "16:9" });

    const voice = await generateSpeech({ connection: c, model: "gemini-2.5-flash-preview-tts", text: "Hi there", voice: "Puck", style: "cheerfully" });
    expect(voice.mediaType).toBe("audio/wav");
    const head = Buffer.from(await voice.blob.arrayBuffer()).subarray(0, 4).toString();
    expect(head).toBe("RIFF");
    expect(JSON.parse(seen[1]!.body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
  });

  it("animates a still with Veo: long-running operation → download", async () => {
    let polls = 0;
    route = (req, _b, res) => {
      if (req.url?.includes(":predictLongRunning")) return json(res, { name: "models/veo/operations/op1", done: false });
      if (req.url?.includes("operations/op1"))
        return json(res, ++polls < 2 ? { name: "models/veo/operations/op1", done: false } : { name: "op1", done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${base}/files/v1:download` } }] } } });
      if (req.url?.startsWith("/files/v1")) return bytes(res, "video/mp4");
      res.writeHead(404).end();
    };
    const out = await generateVideo({ connection: conn("google", `${base}/v1beta/openai`), model: "veo-3.1-generate-preview", prompt: "The logo breathes", image: png(), aspect: "9:16" });
    expect(out.mediaType).toBe("video/mp4");
    const submit = JSON.parse(seen[0]!.body);
    expect(submit.instances[0].image.mimeType).toBe("image/png");
    expect(submit.parameters.aspectRatio).toBe("9:16");
  }, 30_000);
});

describe("ElevenLabs", () => {
  const el = () => conn("elevenlabs", base);

  it("does voice, words, sound effects, music, isolation and lyric alignment", async () => {
    route = (req, _b, res) => {
      if (req.url === "/speech-to-text")
        return json(res, { text: "la la", language_code: "en", words: [{ text: "la", start: 0, end: 0.3, type: "word" }, { text: " ", start: 0.3, end: 0.4, type: "spacing" }, { text: "la", start: 0.4, end: 0.8, type: "word" }] });
      if (req.url === "/forced-alignment") return json(res, { words: [{ text: "Hold", start: 1, end: 1.4 }, { text: "on", start: 1.5, end: 1.9 }], characters: [], loss: 0.1 });
      if (req.url?.includes("/with-timestamps"))
        return json(res, { audio_base64: "AAAA", alignment: { characters: ["H", "i"], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.25] } });
      if (req.url === "/voices") return json(res, { voices: [{ voice_id: "v1", name: "Ada", labels: { accent: "british", use_case: "narration" } }] });
      return bytes(res, "audio/mpeg");
    };
    const audio = new Blob(["a"], { type: "audio/mpeg" });

    const speech = await generateSpeech({ connection: el(), model: "eleven_v3", text: "Hello.", style: "whispers" });
    expect(seen.at(-1)!.url).toMatch(/^\/text-to-speech\/.+\/with-timestamps\?output_format=mp3_44100_128$/);
    expect(speech.alignment?.endMs).toEqual([100, 250]);
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ text: "[whispers] Hello.", model_id: "eleven_v3" });
    expect(speech.provenance.capability).toBe("speech");

    const words = await transcribe({ connection: el(), model: "scribe_v2", audio });
    expect(words.words.map((w) => w.text)).toEqual(["la", "la"]);
    expect(seen.at(-1)!.body).toContain("scribe_v2");

    const lyrics = await alignText({ connection: el(), model: "forced-alignment", audio, text: "Hold on" });
    expect(lyrics.words).toEqual([{ text: "Hold", startMs: 1000, endMs: 1400 }, { text: "on", startMs: 1500, endMs: 1900 }]);

    await generateSound({ connection: el(), model: "eleven_text_to_sound_v2", prompt: "soft UI pop", durationS: 0.2, loop: false });
    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ text: "soft UI pop", duration_seconds: 0.5, model_id: "eleven_text_to_sound_v2" });

    await generateMusic({ connection: el(), model: "music_v1", prompt: "warm lo-fi", durationS: 20, instrumental: true });
    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ music_length_ms: 20000, force_instrumental: true, model_id: "music_v1" });

    const clean = await isolateVoice({ connection: el(), model: "voice-isolator", media: audio });
    expect(seen.at(-1)!.url).toBe("/audio-isolation");
    expect(clean.provenance.capability).toBe("isolate");

    expect(await listVoices(el())).toEqual([{ id: "v1", name: "Ada", description: "british · narration" }]);
    expect(seen.every((s) => s.url !== "/")).toBe(true);
  });
});

describe("fal (queue + storage through @fal-ai/client)", () => {
  /** A fal stand-in: storage upload, queue submit, status, result, file download. */
  function fakeFal(result: (model: string, input: Record<string, unknown>) => Record<string, unknown>) {
    const submitted: Array<{ model: string; input: Record<string, unknown> }> = [];
    let uploads = 0;
    const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    setGenerationFetch(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.includes("/storage/upload/initiate")) return answer({ upload_url: `https://upload.test/${++uploads}`, file_url: `https://cdn.test/in-${uploads}` });
      if (url.startsWith("https://upload.test/")) return new Response(null, { status: 200 });
      if (url.startsWith("https://cdn.test/out")) return new Response(Buffer.from("OUT"), { status: 200, headers: { "content-type": url.endsWith(".png") ? "image/png" : url.endsWith(".webm") ? "video/webm" : url.endsWith(".mp3") ? "audio/mpeg" : "video/mp4" } });
      const q = /^https:\/\/queue\.fal\.run\/(.+?)(\/requests\/(\w+)(\/status)?)?(\?.*)?$/.exec(url);
      if (q && method === "POST" && !q[2]) {
        const model = q[1]!;
        submitted.push({ model, input: JSON.parse(String(init?.body ?? "{}")) });
        return answer({ request_id: `r${submitted.length}`, status: "IN_QUEUE", queue_position: 0 });
      }
      if (q?.[4]) return answer({ status: "COMPLETED" });
      if (q?.[3]) {
        const s = submitted[Number(q[3].slice(1)) - 1]!;
        return answer(result(s.model, s.input));
      }
      return new Response("not faked: " + url, { status: 404 });
    });
    return submitted;
  }

  it("routes every job to the right endpoint with that endpoint's field names", async () => {
    const submitted = fakeFal((model) => {
      if (/birefnet\/v2\/video/.test(model)) return { video: { url: "https://cdn.test/out.webm" } };
      if (/birefnet|topaz\/upscale\/image/.test(model)) return { image: { url: "https://cdn.test/out.png" } };
      if (/nano-banana|flux/.test(model)) return { images: [{ url: "https://cdn.test/out.png", content_type: "image/png" }] };
      if (/scribe/.test(model)) return { text: "hi", language_code: "en", words: [{ text: "hi", start: 0.2, end: 0.5, type: "word" }] };
      if (/elevenlabs/.test(model)) return { audio: { url: "https://cdn.test/out.mp3" } };
      return { video: { url: "https://cdn.test/out.mp4" } };
    });
    const c = conn("fal");
    const image = png();
    const video = new Blob(["v"], { type: "video/mp4" });

    const [edited] = await generateImage({ connection: c, model: "fal-ai/nano-banana-pro/edit", prompt: "Remove the cup", images: [image], aspect: "4:3" });
    expect(edited!.mediaType).toBe("image/png");
    expect(submitted.at(-1)!.input).toMatchObject({ prompt: "Remove the cup", image_urls: ["https://cdn.test/in-1"], aspect_ratio: "4:3" });

    await generateVideo({ connection: c, model: "fal-ai/veo3.1/image-to-video", prompt: "Push in", image, durationS: 5 });
    expect(submitted.at(-1)).toMatchObject({ model: "fal-ai/veo3.1/image-to-video", input: { image_url: expect.stringContaining("cdn.test/in-"), duration: "4s" } });

    await generateVideo({ connection: c, model: "fal-ai/kling-video/o3/pro/video-to-video/edit", prompt: "Make it snow", video });
    expect(submitted.at(-1)!.input).toMatchObject({ video_url: expect.stringContaining("cdn.test/in-"), keep_audio: true });

    const cut = await cutout({ connection: c, model: "fal-ai/birefnet/v2", media: image });
    expect(cut.mediaType).toBe("image/png");
    const cutVideo = await cutout({ connection: c, model: "fal-ai/birefnet/v2/video", media: video });
    expect(cutVideo.mediaType).toBe("video/webm");
    expect(submitted.at(-1)!.input).toMatchObject({ video_output_type: "VP9 (.webm)" });

    await upscale({ connection: c, model: "fal-ai/topaz/upscale/image", media: image, factor: 4 });
    expect(submitted.at(-1)!.input).toMatchObject({ upscale_factor: 4 });

    const words = await transcribe({ connection: c, model: "fal-ai/elevenlabs/speech-to-text/scribe-v2", audio: new Blob(["a"], { type: "audio/wav" }) });
    expect(words.words).toEqual([{ text: "hi", startMs: 200, endMs: 500 }]);

    await generateSound({ connection: c, model: "fal-ai/elevenlabs/sound-effects/v2", prompt: "whoosh", durationS: 1 });
    expect(submitted.at(-1)!.input).toMatchObject({ text: "whoosh", duration_seconds: 1 });
    await generateSpeech({ connection: c, model: "fal-ai/elevenlabs/tts/eleven-v3", text: "Go.", voice: "Aria" });
    expect(submitted.at(-1)!.input).toMatchObject({ text: "Go.", voice: "Aria" });
    await isolateVoice({ connection: c, model: "fal-ai/elevenlabs/audio-isolation", media: video });
    expect(submitted.at(-1)!.input).toHaveProperty("video_url");
  }, 30_000);
});

describe("routing", () => {
  const fal = conn("fal");

  it("picks the model that takes what the job hands it", () => {
    expect(pickModel(fal, "image")?.id).toBe("fal-ai/nano-banana-pro");
    expect(pickModel(fal, "image", "image")?.id).toBe("fal-ai/nano-banana-pro/edit");
    expect(pickModel(fal, "video", "image")?.id).toBe("fal-ai/veo3.1/image-to-video");
    expect(pickModel(fal, "video", "video")?.id).toBe("fal-ai/kling-video/o3/pro/video-to-video/edit");
    expect(pickModel(fal, "cutout", "video")?.id).toBe("fal-ai/birefnet/v2/video");
    expect(pickModel(conn("openai"), "image", "image")?.id).toBe("gpt-image-2");
    expect(pickModel(conn("openai"), "transcription")?.id).toBe("whisper-1");
    expect(pickModel(conn("groq"), "cutout")).toBeNull();
    expect(pickModel(fal, "image", "text", "fal-ai/some-new-model")?.id).toBe("fal-ai/some-new-model");
  });

  it("prefers what the provider's live list confirms — a retired catalogue id is never the default", () => {
    const live: Connection = { ...conn("google"), extraModels: [{ id: "gemini-2.5-pro", label: "g", contextWindow: 1 }, { id: "gemini-2.5-flash-image", label: "i", contextWindow: 0, capability: "image" }] };
    expect(defaultChatModel(conn("google"))).toBe("gemini-3-pro-preview");
    expect(defaultChatModel(live)).toBe("gemini-2.5-pro");
    expect(pickModel(live, "image", "image")?.id).toBe("gemini-2.5-flash-image");
  });

  it("sorts a live model list into chat and media", () => {
    expect(classifyModelId("text-embedding-3-large").drop).toBe(true);
    expect(classifyModelId("gpt-image-2").capability).toBe("image");
    expect(classifyModelId("sora-2-pro").capability).toBe("video");
    expect(classifyModelId("veo-3.1-generate-preview").capability).toBe("video");
    expect(classifyModelId("gemini-2.5-flash-preview-tts").capability).toBe("speech");
    expect(classifyModelId("whisper-large-v3-turbo").capability).toBe("transcription");
    expect(classifyModelId("gpt-6-astra")).toEqual({});
    expect(classifyModelId("gemini-3-pro-preview")).toEqual({});
  });
});
