/**
 * THE PROVIDER CATALOGUE — every AI service the app knows how to talk to, as
 * data.
 *
 * Almost every model API in the world speaks one of two dialects: Anthropic's
 * Messages API or OpenAI's Chat Completions (which Gemini, Grok, DeepSeek,
 * Mistral, Groq, OpenRouter, Together, Fireworks, Ollama and LM Studio all
 * mirror). So a provider is not code — it is a base URL, a way to
 * authenticate, a dialect, and what it can do. Adding one is an entry here; a
 * provider nobody listed is the `custom` entry with a URL typed in.
 *
 * Capabilities are what let one connection serve several jobs: the same OpenAI
 * key that chats can also draw an image, speak a line and transcribe a voice
 * over. The app asks "who can do `speech`?" and never "is this ElevenLabs?".
 *
 * Model lists here are a starting point, not the truth: providers that expose
 * a models endpoint are refreshed live from the Setup dialog, and any id can
 * be typed in by hand.
 */

export type Dialect = "anthropic" | "openai";

/**
 * What a connection can do. `chat` drives the agent; the rest are media jobs,
 * each one function in `generation.ts` with one result shape:
 *  - image: draw or edit a picture          - video: shoot or edit footage
 *  - speech: text → voice                   - transcription: voice → word-timed text
 *  - sound: a sound effect from words       - music: a score from words
 *  - cutout: remove the background (image or video)
 *  - isolate: strip noise and music from a voice
 *  - upscale: add resolution (image or video)
 *  - alignment: time a KNOWN text (lyrics, a script) to its audio
 */
export type Capability =
  | "chat"
  | "image"
  | "video"
  | "speech"
  | "transcription"
  | "sound"
  | "music"
  | "cutout"
  | "isolate"
  | "upscale"
  | "alignment";

export type MediaCapability = Exclude<Capability, "chat">;

export const MEDIA_CAPABILITIES: readonly MediaCapability[] = [
  "image",
  "video",
  "speech",
  "transcription",
  "sound",
  "music",
  "cutout",
  "isolate",
  "upscale",
  "alignment",
];

/** What a media model takes besides words. */
export type MediaInput = "text" | "image" | "video" | "audio";

export type AuthKind =
  /** A key the user pastes. Stored on their device, sent only to the provider. */
  | "apiKey"
  /** A local server with no auth (Ollama, LM Studio). */
  | "none"
  /** Signed in with the product's own account — for a hosted, subscription-billed model. */
  | "account";

export interface ModelDef {
  id: string;
  label: string;
  /** Tokens the model can read in one request — drives the context meter. */
  contextWindow: number;
  maxOutput?: number;
  vision?: boolean;
  /** Exposes a thinking/reasoning stream the UI can show. */
  reasoning?: boolean;
  /** A short honest line for the picker. */
  note?: string;
  /** For generation models: which capability this id serves. Omitted = chat. */
  capability?: MediaCapability;
  /**
   * What the model consumes (default: words only). An edit endpoint takes
   * `image`; an image-to-video one `image`; a video cut-out `video`. The router
   * picks the first model that takes what the job hands it.
   */
  inputs?: MediaInput[];
}

export interface ProviderField {
  key: "apiKey" | "baseUrl" | "organization" | "apiVersion" | "voiceId";
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
}

export interface ProviderDef {
  id: string;
  name: string;
  /** One line under the name in the picker. */
  blurb: string;
  dialect: Dialect | null;
  auth: AuthKind;
  baseUrl?: string;
  fields: ProviderField[];
  capabilities: Capability[];
  models: ModelDef[];
  defaultModel?: string;
  /** Where to get a key. */
  keysUrl?: string;
  /** GET {baseUrl}/models works, so the model list can refresh live. */
  listsModels?: boolean;
  /** Runs on the user's machine: the URL must be reachable from the browser. */
  local?: boolean;
  /** Hidden until the product turns it on (a product's hosted model). */
  hidden?: boolean;
}

const K = 1000;
const M = 1_000_000;

const keyField = (placeholder: string): ProviderField => ({
  key: "apiKey",
  label: "API key",
  placeholder,
  secret: true,
  required: true,
});

const baseUrlField = (placeholder: string, required = false): ProviderField => ({
  key: "baseUrl",
  label: "Endpoint",
  placeholder,
  required,
});

const LIST: ProviderDef[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    blurb: "Claude — the strongest agent for long, careful edits.",
    dialect: "anthropic",
    auth: "apiKey",
    baseUrl: "https://api.anthropic.com",
    fields: [keyField("sk-ant-…")],
    capabilities: ["chat"],
    keysUrl: "https://console.anthropic.com/settings/keys",
    listsModels: true,
    defaultModel: "claude-opus-5-5",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", contextWindow: 1 * M, maxOutput: 128 * K, vision: true, reasoning: true, note: "Newest Opus — the default" },
      { id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 1 * M, maxOutput: 128 * K, vision: true, reasoning: true, note: "Best balance of craft and speed" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1", contextWindow: 1 * M, maxOutput: 128 * K, vision: true, reasoning: true, note: "Most capable; slower, pricier" },

      { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 1 * M, maxOutput: 128 * K, vision: true, reasoning: true, note: "Fast and sharp" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200 * K, maxOutput: 64 * K, vision: true, reasoning: true, note: "Quick edits, sub-agents" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    blurb: "GPT models, plus images, voice and transcription on one key.",
    dialect: "openai",
    auth: "apiKey",
    baseUrl: "https://api.openai.com/v1",
    fields: [keyField("sk-…"), { key: "organization", label: "Organization", placeholder: "org-… (optional)" }],
    capabilities: ["chat", "image", "video", "speech", "transcription"],
    keysUrl: "https://platform.openai.com/api-keys",
    listsModels: true,
    defaultModel: "gpt-6-astra",
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra", contextWindow: 400 * K, maxOutput: 128 * K, vision: true, reasoning: true, note: "OpenAI's flagship" },
      { id: "gpt-6-sol", label: "GPT-6 Sol", contextWindow: 400 * K, maxOutput: 128 * K, vision: true, reasoning: true },
      { id: "gpt-6-luna", label: "GPT-6 Luna", contextWindow: 400 * K, maxOutput: 128 * K, vision: true, reasoning: true, note: "Fast and light" },
      { id: "gpt-5.5", label: "GPT-5.5", contextWindow: 400 * K, maxOutput: 128 * K, vision: true, reasoning: true },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini", contextWindow: 400 * K, maxOutput: 128 * K, vision: true, reasoning: true },
      { id: "gpt-image-2", label: "GPT Image 2", contextWindow: 0, capability: "image", inputs: ["text", "image"], note: "Draws and edits; up to 16 references" },
      { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare", contextWindow: 0, capability: "image", inputs: ["text", "image"] },
      { id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst", contextWindow: 0, capability: "image", inputs: ["text", "image"] },
      { id: "sora-2", label: "Sora 2", contextWindow: 0, capability: "video", inputs: ["text", "image", "video"] },
      { id: "sora-2-pro", label: "Sora 2 Pro", contextWindow: 0, capability: "video", inputs: ["text", "image", "video"] },
      { id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS", contextWindow: 0, capability: "speech", note: "Takes a performance note" },
      { id: "whisper-1", label: "Whisper", contextWindow: 0, capability: "transcription", note: "Word timings — what captions need" },
      { id: "gpt-transcribe", label: "GPT Transcribe", contextWindow: 0, capability: "transcription", note: "Most accurate text; no word timings" },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    blurb: "Gemini to chat, plus Nano Banana images, Veo video and Gemini voices on one key.",
    dialect: "openai",
    auth: "apiKey",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    fields: [keyField("AIza…")],
    capabilities: ["chat", "image", "video", "speech"],
    keysUrl: "https://aistudio.google.com/app/apikey",
    listsModels: true,
    defaultModel: "gemini-3-pro-preview",
    models: [
      { id: "gemini-3-pro-preview", label: "Gemini 3 Pro", contextWindow: 1 * M, maxOutput: 64 * K, vision: true, reasoning: true },
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", contextWindow: 1 * M, maxOutput: 64 * K, vision: true, reasoning: true },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", contextWindow: 1 * M, maxOutput: 64 * K, vision: true, reasoning: true },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", contextWindow: 1 * M, maxOutput: 64 * K, vision: true, reasoning: true },
      { id: "gemini-3-pro-image-preview", label: "Nano Banana Pro", contextWindow: 0, capability: "image", inputs: ["text", "image"], note: "Draws and edits; strong at text in images" },
      { id: "gemini-2.5-flash-image", label: "Nano Banana", contextWindow: 0, capability: "image", inputs: ["text", "image"] },
      { id: "imagen-4.0-generate-001", label: "Imagen 4", contextWindow: 0, capability: "image" },
      { id: "veo-3.1-generate-preview", label: "Veo 3.1", contextWindow: 0, capability: "video", inputs: ["text", "image"] },
      { id: "veo-3.1-fast-generate-preview", label: "Veo 3.1 Fast", contextWindow: 0, capability: "video", inputs: ["text", "image"] },
      { id: "gemini-2.5-pro-preview-tts", label: "Gemini Pro voice", contextWindow: 0, capability: "speech", note: "Takes a performance note" },
      { id: "gemini-2.5-flash-preview-tts", label: "Gemini Flash voice", contextWindow: 0, capability: "speech" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    blurb: "Hundreds of models behind one key.",
    dialect: "openai",
    auth: "apiKey",
    baseUrl: "https://openrouter.ai/api/v1",
    fields: [keyField("sk-or-…")],
    capabilities: ["chat"],
    keysUrl: "https://openrouter.ai/keys",
    listsModels: true,
    defaultModel: "anthropic/claude-opus-5",
    models: [
      { id: "anthropic/claude-opus-5", label: "Claude Opus 5", contextWindow: 1 * M, vision: true, reasoning: true },
      { id: "openai/gpt-5", label: "GPT-5", contextWindow: 400 * K, vision: true, reasoning: true },
      { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", contextWindow: 1 * M, vision: true, reasoning: true },
    ],
  },
  {
    id: "xai",
    name: "xAI",
    blurb: "Grok models.",
    dialect: "openai",
    auth: "apiKey",
    baseUrl: "https://api.x.ai/v1",
    fields: [keyField("xai-…")],
    capabilities: ["chat"],
    keysUrl: "https://console.x.ai",
    listsModels: true,
    defaultModel: "grok-4",
    models: [{ id: "grok-4", label: "Grok 4", contextWindow: 256 * K, vision: true, reasoning: true }],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    blurb: "Low-cost reasoning models.",
    dialect: "openai",
    auth: "apiKey",
    baseUrl: "https://api.deepseek.com/v1",
    fields: [keyField("sk-…")],
    capabilities: ["chat"],
    keysUrl: "https://platform.deepseek.com/api_keys",
    listsModels: true,
    defaultModel: "deepseek-chat",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat", contextWindow: 128 * K },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner", contextWindow: 128 * K, reasoning: true },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    blurb: "European frontier models.",
    dialect: "openai",
    auth: "apiKey",
    baseUrl: "https://api.mistral.ai/v1",
    fields: [keyField("…")],
    capabilities: ["chat"],
    keysUrl: "https://console.mistral.ai/api-keys",
    listsModels: true,
    defaultModel: "mistral-large-latest",
    models: [
      { id: "mistral-large-latest", label: "Mistral Large", contextWindow: 128 * K, vision: true },
      { id: "mistral-medium-latest", label: "Mistral Medium", contextWindow: 128 * K, vision: true },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    blurb: "Open models at very high speed.",
    dialect: "openai",
    auth: "apiKey",
    baseUrl: "https://api.groq.com/openai/v1",
    fields: [keyField("gsk_…")],
    capabilities: ["chat", "transcription"],
    keysUrl: "https://console.groq.com/keys",
    listsModels: true,
    defaultModel: "openai/gpt-oss-120b",
    models: [
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", contextWindow: 131 * K, reasoning: true },
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", contextWindow: 128 * K },
      { id: "whisper-large-v3-turbo", label: "Whisper v3 Turbo", contextWindow: 0, capability: "transcription" },
    ],
  },
  {
    id: "together",
    name: "Together AI",
    blurb: "Open-weight models, hosted.",
    dialect: "openai",
    auth: "apiKey",
    baseUrl: "https://api.together.xyz/v1",
    fields: [keyField("…")],
    capabilities: ["chat"],
    keysUrl: "https://api.together.ai/settings/api-keys",
    listsModels: true,
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    models: [{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B Turbo", contextWindow: 128 * K }],
  },
  {
    id: "ollama",
    name: "Ollama",
    blurb: "Models running on this computer. Free and private.",
    dialect: "openai",
    auth: "none",
    baseUrl: "http://localhost:11434/v1",
    fields: [baseUrlField("http://localhost:11434/v1")],
    capabilities: ["chat"],
    listsModels: true,
    local: true,
    defaultModel: "qwen3",
    models: [
      { id: "qwen3", label: "Qwen 3", contextWindow: 32 * K, reasoning: true },
      { id: "llama3.3", label: "Llama 3.3", contextWindow: 128 * K },
    ],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    blurb: "Any local model LM Studio is serving.",
    dialect: "openai",
    auth: "none",
    baseUrl: "http://localhost:1234/v1",
    fields: [baseUrlField("http://localhost:1234/v1")],
    capabilities: ["chat"],
    listsModels: true,
    local: true,
    models: [],
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    blurb: "Voices, transcripts, sound effects, music, voice clean-up and lyric timing.",
    dialect: null,
    auth: "apiKey",
    baseUrl: "https://api.elevenlabs.io/v1",
    fields: [keyField("sk_…"), { key: "voiceId", label: "Default voice", placeholder: "Voice ID (optional)" }],
    capabilities: ["speech", "transcription", "sound", "music", "isolate", "alignment"],
    keysUrl: "https://elevenlabs.io/app/settings/api-keys",
    defaultModel: "eleven_v3",
    models: [
      { id: "eleven_v3", label: "Eleven v3", contextWindow: 0, capability: "speech", note: "Most expressive; takes [whispers]-style tags" },
      { id: "eleven_multilingual_v2", label: "Multilingual v2", contextWindow: 0, capability: "speech" },
      { id: "eleven_flash_v2_5", label: "Flash v2.5", contextWindow: 0, capability: "speech", note: "Fastest" },
      { id: "scribe_v2", label: "Scribe v2", contextWindow: 0, capability: "transcription", note: "Word timings, 90+ languages" },
      { id: "eleven_text_to_sound_v2", label: "Sound effects v2", contextWindow: 0, capability: "sound" },
      { id: "music_v1", label: "Eleven Music", contextWindow: 0, capability: "music" },
      { id: "voice-isolator", label: "Voice isolator", contextWindow: 0, capability: "isolate", inputs: ["audio", "video"] },
      { id: "forced-alignment", label: "Forced alignment", contextWindow: 0, capability: "alignment", inputs: ["audio"] },
    ],
  },
  {
    id: "fal",
    name: "fal",
    blurb: "Every media model on one key — Nano Banana, FLUX.2, Veo, Kling, Sora, background removal, upscaling, ElevenLabs.",
    dialect: null,
    auth: "apiKey",
    baseUrl: "https://queue.fal.run",
    fields: [keyField("…:…")],
    capabilities: ["image", "video", "speech", "transcription", "sound", "music", "cutout", "isolate", "upscale"],
    keysUrl: "https://fal.ai/dashboard/keys",
    defaultModel: "fal-ai/nano-banana-pro",
    // Ids and input fields checked against @fal-ai/client's typed endpoint map.
    models: [
      { id: "fal-ai/nano-banana-pro", label: "Nano Banana Pro", contextWindow: 0, capability: "image" },
      { id: "fal-ai/nano-banana-pro/edit", label: "Nano Banana Pro · edit", contextWindow: 0, capability: "image", inputs: ["image"] },
      { id: "fal-ai/flux-2-pro", label: "FLUX.2 pro", contextWindow: 0, capability: "image" },
      { id: "fal-ai/flux-2-pro/edit", label: "FLUX.2 pro · edit", contextWindow: 0, capability: "image", inputs: ["image"] },
      { id: "fal-ai/veo3.1", label: "Veo 3.1", contextWindow: 0, capability: "video" },
      { id: "fal-ai/veo3.1/image-to-video", label: "Veo 3.1 · from image", contextWindow: 0, capability: "video", inputs: ["image"] },
      { id: "fal-ai/kling-video/v3/pro/text-to-video", label: "Kling 3 Pro", contextWindow: 0, capability: "video" },
      { id: "fal-ai/kling-video/v3/pro/image-to-video", label: "Kling 3 Pro · from image", contextWindow: 0, capability: "video", inputs: ["image"] },
      { id: "fal-ai/kling-video/o3/pro/video-to-video/edit", label: "Kling O3 · edit video", contextWindow: 0, capability: "video", inputs: ["video"] },
      { id: "fal-ai/sora-2/text-to-video", label: "Sora 2", contextWindow: 0, capability: "video" },
      { id: "fal-ai/birefnet/v2", label: "BiRefNet v2", contextWindow: 0, capability: "cutout", inputs: ["image"] },
      { id: "fal-ai/birefnet/v2/video", label: "BiRefNet v2 · video", contextWindow: 0, capability: "cutout", inputs: ["video"] },
      { id: "fal-ai/topaz/upscale/image", label: "Topaz · image", contextWindow: 0, capability: "upscale", inputs: ["image"] },
      { id: "fal-ai/topaz/upscale/video", label: "Topaz · video", contextWindow: 0, capability: "upscale", inputs: ["video"] },
      { id: "fal-ai/elevenlabs/tts/eleven-v3", label: "Eleven v3 voice", contextWindow: 0, capability: "speech" },
      { id: "fal-ai/elevenlabs/speech-to-text/scribe-v2", label: "Scribe v2", contextWindow: 0, capability: "transcription" },
      { id: "fal-ai/elevenlabs/sound-effects/v2", label: "Sound effects v2", contextWindow: 0, capability: "sound" },
      { id: "fal-ai/elevenlabs/music", label: "Eleven Music", contextWindow: 0, capability: "music" },
      { id: "fal-ai/elevenlabs/audio-isolation", label: "Voice isolator", contextWindow: 0, capability: "isolate", inputs: ["audio", "video"] },
    ],
  },
  {
    id: "custom",
    name: "Custom endpoint",
    blurb: "Anything that speaks the OpenAI API — vLLM, LiteLLM, Azure, a gateway.",
    dialect: "openai",
    auth: "apiKey",
    fields: [baseUrlField("https://my-gateway.example.com/v1", true), { ...keyField("Key (if it needs one)"), required: false }],
    capabilities: ["chat"],
    listsModels: true,
    models: [],
  },
];

/**
 * A provider a product brings (a hosted model behind its own account, say).
 * The list above is every provider ANY build offers; a product adds its own
 * once, at boot, and every lookup sees it.
 */
export function registerProvider(def: ProviderDef): void {
  if (!LIST.some((p) => p.id === def.id)) LIST.push(def);
}

/**
 * Who is calling, for providers that ask callers to identify themselves
 * (OpenRouter's app attribution). The app sets it once; unset sends nothing.
 */
let attribution: { name: string; url: string } | null = null;
export function setAppAttribution(app: { name: string; url: string } | null): void {
  attribution = app;
}
export function appAttribution(): { name: string; url: string } | null {
  return attribution;
}

/** Every provider this build offers: the shared list plus any a product registered. */
export const PROVIDERS: readonly ProviderDef[] = LIST;

export function providerDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * A CONNECTION — one provider, configured. The user can hold several (a work
 * key and a personal one, a local model beside a cloud one); every chat names
 * which it runs on.
 */
export interface Connection {
  id: string;
  providerId: string;
  /** What the user calls it; defaults to the provider's name. */
  label: string;
  /** Field values: apiKey, baseUrl, organization… */
  values: Partial<Record<ProviderField["key"], string>>;
  /** Models the user added by hand or refreshed live — merged over the catalogue's. */
  extraModels?: ModelDef[];
  /** The chat model this connection opens with. */
  defaultModel?: string;
  createdAt: number;
  /** Last successful test, so the UI can show a quiet "connected" state. */
  verifiedAt?: number;
}

export function connectionModels(c: Connection): ModelDef[] {
  const def = providerDef(c.providerId);
  const base = def?.models ?? [];
  const extra = (c.extraModels ?? []).filter((m) => !base.some((b) => b.id === m.id));
  return [...base, ...extra];
}

export function chatModels(c: Connection): ModelDef[] {
  return connectionModels(c).filter((m) => !m.capability);
}

export function modelsFor(c: Connection, capability: MediaCapability): ModelDef[] {
  return confirmedFirst(c, connectionModels(c).filter((m) => m.capability === capability));
}

/**
 * Catalogue entries the provider's live list has confirmed come first; the
 * rest follow. Catalogues age — a live list is the truth once it exists, so a
 * retired id is never the one picked by default.
 */
function confirmedFirst(c: Connection, models: ModelDef[]): ModelDef[] {
  const live = new Set((c.extraModels ?? []).map((m) => m.id));
  if (!live.size || !providerDef(c.providerId)?.listsModels) return models;
  return [...models.filter((m) => live.has(m.id)), ...models.filter((m) => !live.has(m.id))];
}

/**
 * THE MEDIA ROUTER'S MODEL CHOICE: the model the caller named, else the first
 * that takes what the job hands it (a still to animate → an image-input video
 * model). `null` when the connection has no model for the job.
 */
export function pickModel(c: Connection, capability: MediaCapability, needs: MediaInput = "text", preferred?: string): ModelDef | null {
  const all = modelsFor(c, capability);
  if (preferred) return all.find((m) => m.id === preferred) ?? { id: preferred, label: preferred, contextWindow: 0, capability };
  const takes = (m: ModelDef) => (m.inputs ?? ["text"]).includes(needs);
  return all.find(takes) ?? null;
}

/** The chat model a connection opens with — the user's pick, else the first the live list confirms. */
export function defaultChatModel(c: Connection): string | undefined {
  if (c.defaultModel) return c.defaultModel;
  const def = providerDef(c.providerId);
  const ordered = confirmedFirst(c, chatModels(c));
  const preferred = def?.defaultModel && ordered.find((m) => m.id === def.defaultModel);
  const live = new Set((c.extraModels ?? []).map((m) => m.id));
  if (preferred && (!live.size || live.has(preferred.id))) return preferred.id;
  return ordered[0]?.id ?? def?.defaultModel;
}

/**
 * What a model id from a live list is for. Providers list everything they
 * serve under one endpoint — chat, drawing, voices, embeddings — and only the
 * chat ones belong in the chat picker.
 */
export function classifyModelId(id: string): { capability?: MediaCapability; inputs?: MediaInput[]; drop?: true } {
  const s = id.toLowerCase();
  if (/embed|moderation|realtime|search-preview|computer-use|aqa|-audio-preview|^gpt-audio|babbage|davinci|rerank|guard/.test(s)) return { drop: true };
  if (/whisper|transcribe|scribe|speech-to-text/.test(s)) return { capability: "transcription" };
  if (/tts|text-to-speech/.test(s)) return { capability: "speech" };
  if (/(^|[-/])(sora|veo)|video/.test(s)) return { capability: "video", inputs: ["text", "image"] };
  if (/imagen|dall-e/.test(s)) return { capability: "image" };
  if (/gpt-image|chatgpt-image|-image(-|$)|flux|nano-banana/.test(s)) return { capability: "image", inputs: ["text", "image"] };
  return {};
}

/** The model's context window, or a conservative guess for an id nobody catalogued. */
export function contextWindowOf(c: Connection, modelId: string): number {
  return connectionModels(c).find((m) => m.id === modelId)?.contextWindow || 128 * K;
}

/**
 * Whether the model can take images. A catalogued model answers from its entry;
 * a model the catalogue has never heard of (a live list, a custom endpoint) is
 * assumed to see — sending it a render is the useful default, and a refusal
 * surfaces as an ordinary error.
 */
export function seesImages(c: Connection, modelId: string): boolean {
  const entry = providerDef(c.providerId)?.models.find((m) => m.id === modelId);
  return entry ? !!entry.vision : true;
}

export function baseUrlOf(c: Connection): string {
  const def = providerDef(c.providerId);
  return (c.values.baseUrl?.trim() || def?.baseUrl || "").replace(/\/+$/, "");
}
