import { createId } from "./ids";
import { NO_CONTENT, NO_CROP } from "./schema/clips";
import {
  DEFAULT_CLIP_MOTION_BLUR,
  DEFAULT_FRAME_MOTION_BLUR,
  type FrameMotionBlur,
} from "./schema/motion-blur";
import { DEFAULT_FRAME_OVERFLOW } from "./schema/document";
import { CENTER_ANCHOR } from "./transform-map";
import { specFromPreset } from "./animation/presets";
import { seedCaption, type CueGrain } from "./captions";
import { DEFAULT_LAYOUT_ITEM } from "./schema/relations";
import type {
  Contour,
  CaptionSpec,
  AdjustmentClip,
  GroupClip,
  GroupMode,
  LayoutSpec,
  Asset,
  AssetOrigin,
  AssetKind,
  AudioClip,
  AudioFade,
  ClipPlayback,
  CornerRadius,
  Frame,
  FrameMode,
  ImageClip,
  NestedClip,
  Paint,
  PathClip,
  RasterClip,
  ShapeClip,
  ShapeKind,
  SoundPackId,
  StrokeStyle,
  Subpath,
  TextClip,
  TextStyle,
  Track,
  SoundVoice,
  SoundLayer,
  SoundTriggerInput,
  SoundPhase,
  TextCaret,
  MotionDocument,
  VideoClip,
  WaveformClip,
  WaveformStyle,
  TraceClip,
  TraceSpec,
} from "./schema";
import { DOCUMENT_VERSION, STAGE_BACKGROUND_THEME, soundTriggerSchema, traceSpecSchema } from "./schema";
import { emptyOverlay } from "./schema/scope";
import { BUILT_IN_SOUND_BUSES, frameSoundMixSchema, type FrameSoundMix, type SoundBus } from "./schema/sound-mix";
import { DEFAULT_FPS, normalizeFps } from "./timeline/fps";
import { mediaPaint, solidPaint, strokeStyle } from "./schema/vector";
import { PALETTE_LIBRARIES } from "./colors/libraries";
import { healContourIds } from "./vector/contour-id";

/**
 * The colour a new shape arrives in — the Atom palette's first swatch, read
 * from the library rather than restated as a hex here. Two places naming the
 * brand colour is exactly how the default and the shipped palette drift apart.
 */
export const ATOM_DEFAULT_FILL = PALETTE_LIBRARIES[0]!.colors[0]!.value;

/**
 * THE BRAND FILL — the colour anything drawn without a colour arrives in: a
 * rectangle off the tool, a closed pen path, a shape an agent makes with no
 * `fill`. It is the app's PRIMARY, so a shape drawn in SoloMotion is
 * SoloMotion's green, another product's own accent, and a user theme's accent
 * paints with it too. Every product used to draw one fixed red.
 *
 * The engine knows no theme, so the app STAMPS it (`setBrandFill`, called
 * where a theme is applied) the way a product stamps its identity; a test, a
 * worker and the exporter never draw a new shape and keep the Atom swatch.
 * One value read at creation time, so the tool, the inspector's default and
 * the API cannot each have their own idea of it.
 */
let brandFill: string = ATOM_DEFAULT_FILL;

export function setBrandFill(hex: string): void {
  if (/^#[0-9a-f]{6}$/i.test(hex)) brandFill = hex.toUpperCase();
}

export function brandFillColor(): string {
  return brandFill;
}

export function defaultTextStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  const style: TextStyle = {
    fontFamily: "Space Grotesk",
    fontSize: 96,
    fontWeight: 600,
    fauxBold: 0,
    italic: false,
    color: "#F4F2ED",
    letterSpacing: 0,
    orientation: "horizontal",
    lineHeight: 1.15,
    align: "left",
    direction: "auto",
    textEffects: [],
    decoration: "none",
    textCase: "none",
    opacity: 1,
    highlight: null,
    ...overrides,
  };
  // Clone the one remaining reference type so two styles built from the same
  // template/partial never share (and mutate) the same object.
  style.highlight = overrides.highlight ? { ...overrides.highlight } : null;
  return style;
}

export function defaultSoundVoice(overrides: Partial<SoundVoice> = {}): SoundVoice {
  // Quieter and less uniform than it was. A sound layer is scoring, not
  // foreground audio: it sits under narration and music, and 0.6 with only 35%
  // variation put every hit at nearly the same level, which is what makes a
  // repeated cue read as a machine rather than as texture.
  return { pack: "mechanical", custom: null, volume: 0.45, randomness: 0.5, pitch: 1, notes: null, kit: null, climb: "pitch", ...overrides };
}

/**
 * One stack entry, born tuned for the event it rides.
 *
 * The defaults encode taste, not just valid values. A per-unit text hit fires
 * at the START of the letter's move — that is when a keystroke happens. A
 * whole-layer or transition hit defaults to `peak`, the instant of maximum
 * velocity, because a layer's sound is describing an IMPACT and the ear places
 * an impact where the motion crests, not where it began. Getting this wrong is
 * the difference between a library that sounds designed and one that sounds
 * like everything fires on frame 0.
 */
export function makeSoundLayer(
  input: SoundTriggerInput,
  phase: SoundPhase,
  overrides: Partial<SoundVoice> & Partial<Pick<SoundLayer, "anchor" | "offsetMs" | "enabled" | "intensity">> = {},
): SoundLayer {
  const { anchor, offsetMs, enabled, intensity, ...voice } = overrides;
  const trigger = soundTriggerSchema.parse(input);
  // Fires many times: once per letter, or once per collision.
  const isUnit = trigger.kind === "text" || trigger.kind === "hit";
  return {
    id: createId("snd"),
    enabled: enabled ?? true,
    phase,
    trigger,
    anchor: anchor ?? (isUnit ? "start" : "peak"),
    offsetMs: offsetMs ?? 0,
    intensity: intensity ?? 0,
    // TWO taste rules, both derived from the trigger rather than dialled in per
    // template — which is the difference between changing this once and
    // changing it in every preset that ever ships.
    //
    // An exit that hits as hard as the entrance reads as a second entrance, so
    // out voices are born softer and lower.
    //
    // And a PER-UNIT voice fires once per letter or word (or bounce): twenty hits for one
    // line, where a layer voice fires once. Twenty hits at a layer's level is
    // the "annoying" in annoying, so a unit voice is scaled down and given more
    // variation — the loudness of a cue should follow how often it fires, and
    // only the trigger knows that.
    ...defaultSoundVoice({
      ...(phase === "out" ? { volume: 0.48, pitch: 0.85 } : {}),
      ...(isUnit ? { volume: phase === "out" ? 0.26 : 0.32, randomness: 0.6 } : {}),
      ...voice,
    }),
  };
}

/** A text clip's caret, off but tuned — see `textCaretSchema`. */
export function defaultTextCaret(overrides: Partial<TextCaret> = {}): TextCaret {
  return { enabled: false, style: "bar", width: 0.08, color: null, blinkMs: 1060, persist: false, ...overrides };
}

// ── Frames (artboards) ───────────────────────────────────────────────────────

/**
 * The single source of truth for artboard sizes — consumed by the frame tool,
 * the frame inspector and the new-project dialog. Kept free of exact-size
 * collisions so a `width×height` lookup maps to exactly one preset. User-defined
 * presets live app-level in the web layer and are merged on top of these.
 */
export type FramePresetGroup = "Vertical" | "Widescreen" | "Web";

export interface FrameSizePreset {
  id: string;
  name: string;
  width: number;
  height: number;
  group: FramePresetGroup;
  /**
   * Search-only aliases. Names are the FORMAT ("Vertical HD"), because a name
   * that lists three platforms — "Reels / Shorts / TikTok" — ages badly, reads
   * as marketing inside a tool, and pushes the size, which is the fact you
   * actually pick on, off the end of the row. The platform words still have to
   * FIND the preset, so they live here: type "tiktok" and Vertical HD comes up.
   */
  keywords?: string[];
}

export const FRAME_PRESET_GROUPS: FramePresetGroup[] = ["Vertical", "Widescreen", "Web"];

export const FRAME_SIZE_PRESETS: FrameSizePreset[] = [
  // Vertical & square lead; that's where text animation lives.
  { id: "reels", name: "Vertical HD", width: 1080, height: 1920, group: "Vertical", keywords: ["reels", "shorts", "tiktok", "story", "9:16", "phone"] },
  { id: "ig-portrait", name: "Portrait", width: 1080, height: 1350, group: "Vertical", keywords: ["instagram", "feed", "post", "4:5"] },
  { id: "square", name: "Square", width: 1080, height: 1080, group: "Vertical", keywords: ["instagram", "post", "1:1"] },
  { id: "pinterest", name: "Tall", width: 1000, height: 1500, group: "Vertical", keywords: ["pinterest", "pin", "2:3"] },
  { id: "hd", name: "HD", width: 1920, height: 1080, group: "Widescreen", keywords: ["youtube", "1080p", "full hd", "16:9"] },
  { id: "uhd-4k", name: "4K UHD", width: 3840, height: 2160, group: "Widescreen", keywords: ["youtube", "2160p", "ultra hd", "16:9"] },
  { id: "cinema", name: "Cinemascope", width: 2048, height: 858, group: "Widescreen", keywords: ["film", "anamorphic", "scope", "2.39"] },
  { id: "x-post", name: "Wide", width: 1600, height: 900, group: "Widescreen", keywords: ["x", "twitter", "post", "16:9"] },
  { id: "og-card", name: "Link card", width: 1200, height: 630, group: "Web", keywords: ["og", "opengraph", "share", "preview", "meta"] },
  { id: "x-header", name: "Banner", width: 1500, height: 500, group: "Web", keywords: ["x", "twitter", "header", "cover"] },
];

/**
 * Aspect label for a size. Reduced terms while they stay READABLE (16:9, 4:5,
 * 2:3), decimal past that — 2048×858 reduces to 1024:429, which is arithmetic,
 * not a ratio anyone recognises; the format is called 2.39:1.
 */
export function aspectRatioLabel(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "\u2014";
  const w = Math.round(width);
  const h = Math.round(height);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h) || 1;
  const a = w / g;
  const b = h / g;
  if (a <= 32 && b <= 32) return `${a}:${b}`;
  return w >= h ? `${trimRatio(w / h)}:1` : `1:${trimRatio(h / w)}`;
}

/** 2.386… → "2.39"; 2.00 → "2". */
function trimRatio(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Does a preset match a typed query? ONE matcher so every size picker — the
 * new-project list, the frame tool, whatever comes next — agrees on what
 * "1080", "9:16" and "tiktok" find. Matches the name, the group, the aliases,
 * both dimensions and the ratio label.
 */
export function framePresetMatches(
  preset: { name: string; width: number; height: number; group?: string; keywords?: string[] },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    preset.name,
    preset.group ?? "",
    ...(preset.keywords ?? []),
    `${preset.width}`,
    `${preset.height}`,
    `${preset.width}x${preset.height}`,
    `${preset.width}\u00d7${preset.height}`,
    aspectRatioLabel(preset.width, preset.height),
  ]
    .join(" ")
    .toLowerCase();
  // Every whitespace-separated term must appear, so "4k wide" narrows.
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

export interface CreateFrameInput {
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  background?: string;
  durationMs?: number | null;
  /**
   * This comp's frame rate. Omitted = {@link DEFAULT_FPS}. Callers that are
   * making a frame to sit INSIDE another (a nested/precomposed source, a
   * flipbook's drawing cell, a component master) should pass the parent's rate
   * so the child starts on the same grid its author is looking at —
   * `nestClips` in `timeline/ops.ts` does exactly that.
   */
  fps?: number;
  /**
   * This comp's shutter. Omitted = the schema default (master on).
   *
   * Callers making a frame to sit INSIDE another should pass the parent's, for
   * the identical reason they pass its `fps`: a shutter angle is a fraction of
   * a frame interval, so the two only mean anything together. Precompose in
   * particular promises the pixels do not move — a promise it would break by
   * handing back a comp that blurs differently from the one the layers came
   * out of.
   */
  motionBlur?: FrameMotionBlur;
  pageId?: string | null;
  /** Spill opacity, 0..1. See `frameSchema.overflow`; omit for the default. */
  overflow?: number;
  mode?: FrameMode;
  /** Provenance marker (e.g. "svg" for a vectorized import). */
  sourceTag?: string | null;
}

export function createFrame(input: CreateFrameInput = {}): Frame {
  return {
    id: createId("frame"),
    svgAssetId: null,
    name: input.name ?? "Frame",
    mode: input.mode ?? "timeline",
    sourceTag: input.sourceTag ?? null,
    x: input.x ?? 0,
    y: input.y ?? 0,
    width: Math.max(16, Math.round(input.width ?? 1080)),
    height: Math.max(16, Math.round(input.height ?? 1920)),
    background: input.background ?? "#0E0E11",
    fills: [],
    strokes: [],
    // Artwork that reaches past the edge is DIMMED, not hidden and not fully
    // painted — and only on the frame you are working in (see `overflow`).
    // Frames that must never crop at all (precomposed/nested comps, whose
    // content is placed by their instance) pass 1 explicitly.
    overflow: input.overflow ?? DEFAULT_FRAME_OVERFLOW,
    durationMs: input.durationMs ?? null,
    fps: normalizeFps(input.fps ?? DEFAULT_FPS),
    loop: "none",
    motionBlur: input.motionBlur ?? DEFAULT_FRAME_MOTION_BLUR,
    // A new comp is mixed safely out of the box: levelled by category, capped
    // by the limiter. Old comps are migrated to off (v86) so nothing re-mixes.
    soundMix: defaultFrameSoundMix(),
    pageId: input.pageId ?? null,
    component: null,
    instanceOf: null,
    guides: [],
    pluginData: {},
  };
}

// ── Clips ────────────────────────────────────────────────────────────────────

export interface CreateTextClipInput {
  frameId: string;
  text: string;
  startMs: number;
  durationMs?: number;
  x?: number;
  y?: number;
  /**
   * Preset id for the in-animation. Omitted or `null` = born plain: a new text
   * layer does not move until someone asks it to. This used to default to
   * "fade-up", so every path that forgot to say `null` (a font dragged out of
   * the Fonts window, "Add text" at the playhead) quietly arrived animated.
   */
  presetId?: string | null;
  style?: Partial<TextStyle>;
  /** Seed the sound stack (e.g. a template that ships with typing sound on). */
  sounds?: SoundLayer[];
  /**
   * Make this text layer a CAPTION: seed cues from the text at this grain and
   * give the focused cue a look. Omitted = an ordinary text layer.
   */
  caption?: { grain?: CueGrain; states?: Partial<CaptionSpec["states"]> };
}

export function createTextClip(input: CreateTextClipInput): TextClip {
  return {
    id: createId("clip"),
    kind: "text",
    path: null,
    fills: [],
    strokes: [],
    opacity: 1,
    blendMode: "normal",
    frameId: input.frameId,
    isStencil: false,
    fps: null,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { ...NO_CROP },
    content: { ...NO_CONTENT },
    name: input.text.slice(0, 24) || "Text",
    startMs: input.startMs,
    durationMs: input.durationMs ?? 3000,
    text: input.text,
    maxHeight: null,
    verticalAlign: "top",
    clipContent: false,
    style: defaultTextStyle(input.style),
    ranges: [],
    transform: { x: input.x ?? 0, y: input.y ?? 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
    maxWidth: null,
    effects: [],
    animations: { in: input.presetId ? specFromPreset(input.presetId) : null, out: null },
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: input.sounds ?? [],
    caret: defaultTextCaret(),
    countUps: [],
    caption: input.caption ? seedCaption(input.text, input.durationMs ?? 3000, input.caption.grain, input.caption.states) : null,
  };
}

/**
 * A caption is a TEXT clip with the caption module — so this is a preset, not a
 * kind: it seeds word cues and the default states (`defaultCaptionStates`), and
 * everything else about it (editing, ranges, box, animation) is text's.
 */
export function createCaptionClip(input: {
  frameId: string;
  text: string;
  startMs: number;
  durationMs?: number;
  x?: number;
  y?: number;
}): TextClip {
  const clip = createTextClip({
    ...input,
    durationMs: input.durationMs ?? 3000,
    presetId: null,
    style: { fontSize: 56, fontWeight: 700, color: "#FFFFFF" },
    caption: {},
  });
  clip.maxWidth = 780;
  clip.name = input.text.slice(0, 24) || "Caption";
  return clip;
}

export function createAudioClip(input: {
  frameId: string;
  startMs: number;
  durationMs?: number;
  pack?: SoundPackId;
}): AudioClip {
  return {
    id: createId("clip"),
    kind: "audio",
    frameId: input.frameId,
    name: "Sound",
    startMs: input.startMs,
    durationMs: input.durationMs ?? 500,
    source: { type: "pack", pack: input.pack ?? "pop" },
    gain: 0.8,
    fadeIn: defaultFade(),
    fadeOut: defaultFade(),
    repeatEveryMs: null,
    playback: defaultPlayback(),
    trimInMs: 0,
    soundBus: "sfx",
    keepPitch: true,
    pitchSemitones: 0,
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
}

// ── Media clips (imported assets) ────────────────────────────────────────────

interface CreateMediaClipBase {
  frameId: string;
  assetId: string;
  name?: string;
  startMs: number;
  durationMs?: number;
  x?: number;
  y?: number;
}

export function createImageClip(input: CreateMediaClipBase): ImageClip {
  return {
    id: createId("clip"),
    kind: "image",
    // The clip's own footage is its bottom fill (source: self) — so it reads as a
    // Figma image fill you can restyle/reorder/overlay. Additional fills stack above.
    fills: [mediaPaint({ type: "self" })],
    strokes: [],
    opacity: 1,
    blendMode: "normal",
    frameId: input.frameId,
    isStencil: false,
    fps: null,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { ...NO_CROP },
    content: { ...NO_CONTENT },
    assetId: input.assetId,
    name: input.name ?? "Image",
    startMs: input.startMs,
    durationMs: input.durationMs ?? 5000,
    trimInMs: 0,
    transform: { x: input.x ?? 0, y: input.y ?? 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
    maxWidth: null,
    effects: [],
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
}

export function createVideoClip(
  input: CreateMediaClipBase & { playback?: Partial<ClipPlayback> },
): VideoClip {
  return {
    id: createId("clip"),
    kind: "video",
    // Footage as the bottom fill (source: self); overlays/underlays stack around it.
    fills: [mediaPaint({ type: "self" })],
    strokes: [],
    opacity: 1,
    blendMode: "normal",
    frameId: input.frameId,
    isStencil: false,
    fps: null,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { ...NO_CROP },
    content: { ...NO_CONTENT },
    assetId: input.assetId,
    name: input.name ?? "Video",
    startMs: input.startMs,
    durationMs: input.durationMs ?? 5000,
    transform: { x: input.x ?? 0, y: input.y ?? 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
    maxWidth: null,
    effects: [],
    playback: defaultPlayback(input.playback),
    trimInMs: 0,
    volume: 1,
    muted: false,
    keepPitch: true,
    pitchSemitones: 0,
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
}

export function createAssetAudioClip(
  input: CreateMediaClipBase & { soundBus?: string },
): AudioClip {
  return {
    id: createId("clip"),
    kind: "audio",
    frameId: input.frameId,
    name: input.name ?? "Audio",
    startMs: input.startMs,
    durationMs: input.durationMs ?? 5000,
    source: { type: "asset", assetId: input.assetId },
    gain: 1,
    fadeIn: defaultFade(),
    fadeOut: defaultFade(),
    repeatEveryMs: null,
    playback: defaultPlayback(),
    trimInMs: 0,
    ...(input.soundBus ? { soundBus: input.soundBus } : {}),
    keepPitch: true,
    pitchSemitones: 0,
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
}

// ── Vector clips ─────────────────────────────────────────────────────────────

export interface CreateShapeClipInput {
  frameId: string;
  shape: ShapeKind;
  startMs: number;
  durationMs?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Polygon/star vertex count (default: star 5, else 3 — a triangle). */
  pointCount?: number;
  /**
   * The rest of a shape's parametric geometry. Every one of these was a
   * hard-coded literal in here, so a caller that wanted a rounded rect or a
   * 7-point star had to build the clip and then PATCH it — which is how the
   * tool's creation defaults and the drag preview ended up describing two
   * different shapes. A factory that can't express its own model forces every
   * caller to finish the job differently.
   */
  /** Per-corner radii (rect). */
  cornerRadius?: CornerRadius;
  /** Uniform vertex rounding (polygon/star). */
  radius?: number;
  /** Star inner radius as a ratio of the outer (0..1). */
  innerRatio?: number;
  /** Ellipse arc: where the sweep starts, in degrees. */
  arcStartDeg?: number;
  /** Ellipse arc: how far it sweeps. 360 = a full circle. */
  arcSweepDeg?: number;
  /** Ellipse arc: inner-hole radius as a fraction of the outer (0 = solid). */
  arcRatio?: number;
  /** Strings are a convenience — they wrap into a solid paint. */
  fill?: Paint | string | null;
  stroke?: StrokeStyle | null;
  name?: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalize a convenience fill input into a Paint (undefined = the fallback color). */
function asPaint(v: Paint | string | null | undefined, fallback: string | null): Paint | null {
  if (v === undefined) return fallback === null ? null : solidPaint(fallback);
  if (v === null) return null;
  return typeof v === "string" ? solidPaint(v) : v;
}

/** Convenience fill/stroke input → the new ordered list (empty = none). */
function asFills(v: Paint | string | null | undefined, fallback: string | null): Paint[] {
  const p = asPaint(v, fallback);
  return p ? [p] : [];
}
function asStrokes(v: StrokeStyle | null | undefined, fallback: StrokeStyle | null): StrokeStyle[] {
  if (v === undefined) return fallback ? [fallback] : [];
  return v ? [v] : [];
}

const SHAPE_LABEL: Record<ShapeKind, string> = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  polygon: "Polygon",
  star: "Star",
};

export function createShapeClip(input: CreateShapeClipInput): ShapeClip {
  return {
    id: createId("clip"),
    kind: "shape",
    frameId: input.frameId,
    isStencil: false,
    fps: null,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { ...NO_CROP },
    content: { ...NO_CONTENT },
    name: input.name ?? SHAPE_LABEL[input.shape],
    startMs: input.startMs,
    durationMs: input.durationMs ?? 5000,
    shape: input.shape,
    width: Math.max(1, input.width ?? 200),
    height: Math.max(1, input.height ?? 200),
    cornerRadius: input.cornerRadius ? { ...input.cornerRadius } : { tl: 0, tr: 0, br: 0, bl: 0 },
    radius: Math.max(0, input.radius ?? 0),
    pointCount: Math.max(3, Math.round(input.pointCount ?? (input.shape === "star" ? 5 : 3))),
    innerRatio: clamp(input.innerRatio ?? 0.5, 0.01, 1),
    arcStartDeg: input.arcStartDeg ?? 0,
    arcSweepDeg: clamp(input.arcSweepDeg ?? 360, 0, 360),
    arcRatio: clamp(input.arcRatio ?? 0, 0, 0.99),
    cornerOffsets: null,
    // The app's own primary (`brandFillColor`). A new rectangle is the first
    // thing anyone draws, so its colour is the app introducing itself.
    fills: asFills(input.fill, brandFillColor()),
    strokes: asStrokes(input.stroke, null),
    opacity: 1,
    blendMode: "normal",
    transform: { x: input.x ?? 0, y: input.y ?? 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
    maxWidth: null,
    effects: [],
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
}

export interface CreateAdjustmentClipInput {
  frameId: string;
  startMs: number;
  durationMs?: number;
  name?: string;
  /**
   * Opt OUT of comp-tracking. A processor fills its comp by default (see the
   * factory) — pass `false` only for a grade deliberately born as a span.
   */
  fillDuration?: boolean;
}

/**
 * Create an adjustment layer — a processor that paints nothing and grades the
 * layers it reaches through the shared `effects` stack. Born empty (add effects
 * in the inspector) with the After-Effects default scope: reach everything
 * below, no filter. Rides `visualClipBase` like every visual clip.
 *
 * It is born `fillDuration`, unlike every other kind, and that is the one thing
 * about it that is not a default but a definition: a grade is a property of the
 * COMP, not a span of footage, so "as long as the comp" is the only length it
 * has a reason to be. Tracking is the shared mechanism every fill clip already
 * uses — trimming or typing a duration flips it off (`trimClip`), and Timing's
 * Fill switch turns it back on — so a processor that has been cut short stays
 * short, and one that never was follows the comp for the rest of its life.
 */
export function createAdjustmentClip(input: CreateAdjustmentClipInput): AdjustmentClip {
  return {
    id: createId("clip"),
    kind: "adjustment",
    frameId: input.frameId,
    isStencil: false,
    fps: null,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { ...NO_CROP },
    content: { ...NO_CONTENT },
    name: input.name ?? "Adjustment",
    startMs: input.startMs,
    durationMs: input.durationMs ?? 5000,
    scope: { reach: "below", filter: { mode: "all", targetIds: [] }, source: "replace" },
    fills: [],
    strokes: [],
    opacity: 1,
    blendMode: "normal",
    transform: { x: 0, y: 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
    maxWidth: null,
    effects: [],
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: input.fillDuration ?? true,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
}

export interface CreateGroupClipInput {
  frameId: string;
  startMs: number;
  durationMs: number;
  name?: string;
  mode?: GroupMode;
  /** Born as an auto-layout container (v73). */
  layout?: LayoutSpec | null;
}

/**
 * Create a GROUP — one layer that contains others. Born inert: identity
 * transform, no paint, no effects, `pass` mode, so a fresh group renders
 * exactly as its members did a moment before it existed.
 *
 * Deliberately NOT `fillDuration`. A group's span is the union of what it holds
 * at the moment it is made, and that span is then its own to trim: it is a
 * WINDOW over its rows (`withinGroupWindow`), and a window that silently
 * re-lengthened itself to the comp would hide nothing and mean nothing.
 */
export function createGroupClip(input: CreateGroupClipInput): GroupClip {
  return {
    id: createId("group"),
    kind: "group",
    mode: input.mode ?? "pass",
    layout: input.layout ?? null,
    rig: null,
    switch: null,
    frameId: input.frameId,
    isStencil: false,
    fps: null,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { ...NO_CROP },
    content: { ...NO_CONTENT },
    name: input.name ?? "Group",
    startMs: input.startMs,
    durationMs: Math.max(1, input.durationMs),
    fills: [],
    strokes: [],
    opacity: 1,
    blendMode: "normal",
    transform: { x: 0, y: 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
    maxWidth: null,
    effects: [],
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
}

export interface CreatePathClipInput {
  frameId: string;
  /**
   * The outline. Contours may arrive BARE — every generator in core produces
   * geometry without identity — and are given ids on the way in, so no caller
   * has to mint them.
   */
  subpaths: Array<Contour | Subpath>;
  startMs: number;
  durationMs?: number;
  x?: number;
  y?: number;
  fill?: Paint | string | null;
  /** One stroke, the everyday case. */
  stroke?: StrokeStyle | null;
  /** A whole stroke STACK — what a multi-line vector brush draws. Wins over
   *  `stroke` when given, so a brush emits its lines in one call. */
  strokes?: StrokeStyle[];
  name?: string;
}

export function createPathClip(input: CreatePathClipInput): PathClip {
  const clip: PathClip = {
    id: createId("clip"),
    kind: "path",
    contourStyles: {},
    frameId: input.frameId,
    isStencil: false,
    fps: null,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { ...NO_CROP },
    content: { ...NO_CONTENT },
    name: input.name ?? "Path",
    startMs: input.startMs,
    durationMs: input.durationMs ?? 5000,
    subpaths: input.subpaths as Subpath[],
    fillRule: "nonzero",
    fills: asFills(input.fill, null),
    // The default outline exists so a bare path is VISIBLE. A path given a
    // fill already is, and a default stroke on it is a border nobody asked
    // for — a logo or icon grew a thin light edge unless `stroke: null` was
    // remembered. So the outline defaults only when there is no fill.
    strokes: input.strokes ?? asStrokes(
      input.stroke,
      input.fill ? null : strokeStyle(solidPaint("#F4F2ED"), { width: 4, cap: "round", join: "round" }),
    ),
    opacity: 1,
    blendMode: "normal",
    transform: { x: input.x ?? 0, y: input.y ?? 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
    maxWidth: null,
    effects: [],
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
  // ONE place decides what a well-formed vector layer is; every constructor
  // just hands its geometry over, and bare contours get their identity here —
  // so no caller has to know the invariant in order to satisfy it.
  healContourIds(clip);
  return clip;
}

export function createAsset(input: {
  kind: AssetKind;
  name: string;
  mime: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  fps?: number | null;
  origin?: AssetOrigin | null;
}): Asset {
  return {
    id: createId("asset"),
    kind: input.kind,
    name: input.name,
    mime: input.mime,
    bytes: input.bytes,
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: input.durationMs ?? null,
    fps: input.fps ?? null,
    folderId: null,
    origin: input.origin ?? null,
  };
}

export function defaultPlayback(overrides: Partial<ClipPlayback> = {}): ClipPlayback {
  return { speed: 1, loop: "none", reverse: false, loopLengthMs: null, ...overrides };
}

export function defaultFade(): AudioFade {
  return { durationMs: 0, curve: { kind: "preset", name: "ease-in-out" } };
}

export interface CreateNestedClipInput {
  frameId: string;
  sourceFrameId: string;
  startMs: number;
  durationMs?: number;
  x?: number;
  y?: number;
  name?: string;
  playback?: Partial<ClipPlayback>;
}

export function createNestedClip(input: CreateNestedClipInput): NestedClip {
  return {
    id: createId("clip"),
    kind: "nested",
    flat: false,
    clipContent: null,
    fills: [],
    strokes: [],
    opacity: 1,
    blendMode: "normal",
    frameId: input.frameId,
    isStencil: false,
    fps: null,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { ...NO_CROP },
    content: { ...NO_CONTENT },
    name: input.name ?? "Nested",
    startMs: input.startMs,
    durationMs: input.durationMs ?? 3000,
    sourceFrameId: input.sourceFrameId,
    trimInMs: 0,
    transform: { x: input.x ?? 0, y: input.y ?? 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
    maxWidth: null,
    effects: [],
    playback: defaultPlayback(input.playback),
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
}

export interface CreateRasterClipInput {
  frameId: string;
  /** Surface size in px — normally the drawing comp's size. */
  width: number;
  height: number;
  startMs?: number;
  durationMs?: number;
  name?: string;
  surfaceId?: string;
  /**
   * Span the whole comp regardless of `durationMs`. Opt-IN, and only true where
   * it is structurally right: inside a drawing comp (see below).
   */
  fillDuration?: boolean;
}

/**
 * A pixel paint layer — an ordinary timeline clip, born at `startMs` with a
 * normal default length, exactly like a shape or a path. You extend or trim it
 * with the same drag as everything else.
 *
 * `fillDuration` is opt-in for the ONE place it belongs: a drawing comp, where
 * the layers ARE the drawing and have no timeline life of their own. It used to
 * default to true, which made every pixel layer on a real timeline silently span
 * the whole composition and refuse to be trimmed — a clip kind behaving unlike
 * every other clip kind for a reason that only ever applied inside flipbooks.
 */
export function createRasterClip(input: CreateRasterClipInput): RasterClip {
  return {
    id: createId("clip"),
    kind: "raster",
    fills: [],
    strokes: [],
    opacity: 1,
    blendMode: "normal",
    frameId: input.frameId,
    isStencil: false,
    fps: null,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { ...NO_CROP },
    content: { ...NO_CONTENT },
    name: input.name ?? "Pixel layer",
    startMs: input.startMs ?? 0,
    durationMs: input.durationMs ?? 5000,
    surfaceId: input.surfaceId ?? createId("surface"),
    width: Math.max(1, Math.round(input.width)),
    height: Math.max(1, Math.round(input.height)),
    rev: 0,
    transform: { x: 0, y: 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
    maxWidth: null,
    effects: [],
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: input.fillDuration ?? false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
}

export interface CreateWaveformClipInput {
  frameId: string;
  /** The audio-bearing clip to visualize. */
  targetClipId: string;
  startMs: number;
  durationMs: number;
  x?: number;
  y?: number;
  name?: string;
  style?: Partial<WaveformStyle>;
}

/** Sensible default look — presets and the plugin panel override from here. */
export function defaultWaveformStyle(patch: Partial<WaveformStyle> = {}): WaveformStyle {
  return {
    template: "bars",
    mode: "spectrum",
    decay: 0.55,
    width: 960,
    height: 280,
    color: "#8b5cf6",
    color2: null,
    amplitude: 1,
    barCount: 64,
    barFill: 0.65,
    roundness: 1,
    thickness: 3,
    windowMs: 1200,
    smoothing: 0.25,
    mirror: true,
    innerRadius: 0.55,
    startAngleDeg: -90,
    spanDeg: 360,
    glow: 0,
    flipX: false,
    flipY: false,
    rotateDeg: 0,
    ...patch,
  };
}

export function createWaveformClip(input: CreateWaveformClipInput): WaveformClip {
  return {
    id: createId("clip"),
    kind: "waveform",
    fills: [],
    strokes: [],
    opacity: 1,
    blendMode: "normal",
    frameId: input.frameId,
    isStencil: false,
    fps: null,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { ...NO_CROP },
    content: { ...NO_CONTENT },
    name: input.name ?? "Waveform",
    startMs: input.startMs,
    durationMs: input.durationMs,
    targetClipId: input.targetClipId,
    style: defaultWaveformStyle(input.style),
    transform: { x: input.x ?? 0, y: input.y ?? 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
    maxWidth: null,
    effects: [],
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
}

export interface CreateTraceClipInput {
  frameId: string;
  startMs: number;
  durationMs: number;
  /** The layer followed; null/absent = the trace's own position draws (a pen). */
  sourceClipId?: string | null;
  x?: number;
  y?: number;
  name?: string;
  trace?: DeepPartialTrace;
}

/** A trace patch: any field, the ends and the ghosts field by field. */
export type DeepPartialTrace = Partial<Omit<TraceSpec, "source" | "head" | "tail" | "ghosts">> & {
  source?: Partial<TraceSpec["source"]>;
  head?: Partial<TraceSpec["head"]>;
  tail?: Partial<TraceSpec["tail"]>;
  ghosts?: Partial<TraceSpec["ghosts"]>;
};

/**
 * The default look is ScientificMotion's: an ember head (8 px, `#FF5A2E`)
 * cooling to a 1 px chalk past (`#EDE9E2`) across the whole visible trace.
 */
export function defaultTraceSpec(patch: DeepPartialTrace = {}, sourceClipId: string | null = null): TraceSpec {
  const base = traceSpecSchema.parse({
    source: { clipId: sourceClipId },
    head: { color: "#FF5A2E", width: 8, opacity: 1 },
    tail: { color: "#EDE9E2", width: 1, opacity: 0.35 },
  });
  return {
    ...base,
    ...patch,
    source: { ...base.source, ...patch.source },
    head: { ...base.head, ...patch.head },
    tail: { ...base.tail, ...patch.tail },
    ghosts: { ...base.ghosts, ...patch.ghosts },
  };
}

export function createTraceClip(input: CreateTraceClipInput): TraceClip {
  return {
    id: createId("clip"),
    kind: "trace",
    fills: [],
    strokes: [],
    opacity: 1,
    blendMode: "normal",
    frameId: input.frameId,
    isStencil: false,
    fps: null,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { ...NO_CROP },
    content: { ...NO_CONTENT },
    name: input.name ?? "Trace",
    startMs: input.startMs,
    durationMs: input.durationMs,
    trace: defaultTraceSpec(input.trace, input.sourceClipId ?? null),
    transform: { x: input.x ?? 0, y: input.y ?? 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { ...CENTER_ANCHOR } },
    maxWidth: null,
    effects: [],
    keyframes: [],
    linkGroupId: null,
    mirrorId: null,
    origin: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
  };
}

/**
 * `homeCompId` and `groupId` only matter while the track stays EMPTY — pass
 * them when creating a spare/blank lane for a specific comp ("+ Track") or
 * inside a specific group ("Add track inside"). Leave them unset for a track
 * about to receive a clip immediately; the clip's own `frameId`/`groupId`
 * scopes it from then on.
 */
export function createTrack(name?: string, homeCompId?: string | null, groupId?: string | null): Track {
  return {
    id: createId("track"),
    name: name ?? "Track",
    clips: [],
    groupId: groupId ?? null,
    transitions: [],
    muted: false,
    locked: false,
    hidden: false,
    color: null,
    heightPx: null,
    homeCompId: homeCompId ?? null,
    auto: false,
    loop: "none",
  };
}

/**
 * A track spawned AUTOMATICALLY to carry a single clip — drag past an edge,
 * drop-to-new-lane, restack, precompose, or the first-fit fallback. Flagged
 * `auto` so the opt-in empty-track prune removes ONLY these once their clip
 * leaves; a lane the user made or adopted (a 2nd clip landed) is never swept.
 * The one factory behind every auto-created carrier — never inline the flag.
 */
export function createCarrierTrack(name?: string, homeCompId?: string | null, groupId: string | null = null): Track {
  // A carrier inside a group is a ROW of that group, and says so.
  return { ...createTrack(name ?? (groupId ? "Row" : undefined), homeCompId, groupId), auto: true };
}

/** A comp's mix master with every default on — see `frameSoundMixSchema`. */
export function defaultFrameSoundMix(): FrameSoundMix {
  return frameSoundMixSchema.parse({});
}

/**
 * A new project's categories: the built-ins, with the one ducking rule nearly
 * every video wants — music gets out of the way of the voice. Migrated
 * projects get the built-ins WITHOUT it, so an old mix is never re-balanced.
 */
export function defaultSoundBuses(): SoundBus[] {
  return BUILT_IN_SOUND_BUSES.map((b) =>
    b.id === "music"
      ? { ...b, ducking: [{ id: createId("duck"), enabled: true, under: { kind: "bus", id: "voice" }, depthDb: 10, attackMs: 150, releaseMs: 500 }] }
      : { ...b, audioEffects: [], ducking: [] },
  );
}

export function createEmptyDocument(name = "Untitled"): MotionDocument {
  // The comp carries its own length (v113), as it carries its rate.
  const frame = createFrame({ name: "Frame 1", durationMs: 10000 });
  return {
    version: DOCUMENT_VERSION,
    id: createId("doc"),
    name,
    // No project-wide rate: the frame carries it (createFrame seeds DEFAULT_FPS).
    // The document's length is only the default a new comp starts from.
    durationMs: 10000,
    stageBackground: STAGE_BACKGROUND_THEME,
    frames: [frame],
    pages: [{ id: createId("page"), name: "Page 1" }],
    tracks: [
      createTrack("Track 1", frame.id),
      createTrack("Track 2", frame.id),
      createTrack("Track 3", frame.id),
    ],
    variables: [],
    variableFolders: [],
    graphs: [],
    expressions: [],
    trackers: [],
    assets: [],
    mediaFolders: [],
    presets: [],
    soundBuses: defaultSoundBuses(),
    soundPreviewVolume: 0.7,
    customSounds: [],
    markers: [],
    renderedClips: {},
    scripts: [],
    scriptFolders: [],
  };
}

/**
 * A blank canvas: the empty document with no frame, and so none of the
 * starter tracks that would belong to it. The first frame is drawn, not
 * asked for; the tracks arrive with the first layer, as they do in any comp.
 */
export function createBlankDocument(name = "Untitled"): MotionDocument {
  const doc = createEmptyDocument(name);
  doc.frames = [];
  doc.tracks = [];
  return doc;
}

/** A small demo document so the editor opens alive, not blank. */
export function createStarterDocument(): MotionDocument {
  const doc = createEmptyDocument("Welcome");
  const frameId = doc.frames[0]!.id;

  const hero = createTextClip({
    frameId,
    text: "Everything moves",
    startMs: 300,
    durationMs: 3200,
    y: -260,
    presetId: "pop-in",
    style: { fontSize: 132, fontWeight: 700 },
    sounds: [makeSoundLayer({ kind: "text" }, "in", { pack: "thock" })],
  });
  // Style the word "moves" via a range — demonstrates range-based styling out of the box.
  hero.ranges = [
    {
      id: createId("range"),
      start: 11,
      end: 16,
      overlay: { ...emptyOverlay(), props: { color: "#F5B843", italic: true } },
      animation: null,
      sounds: {},
    },
  ];

  const sub = createTextClip({
    frameId,
    text: "draw. animate. cut. ship.",
    startMs: 1400,
    durationMs: 3400,
    y: -60,
    presetId: "typewriter",
    style: { fontSize: 54, fontWeight: 400, color: "#B9B5AC", fontFamily: "JetBrains Mono" },
    sounds: [makeSoundLayer({ kind: "text" }, "in", { pack: "mechanical", volume: 0.45 })],
  });

  const caption = createCaptionClip({
    frameId,
    text: "captions that highlight word by word",
    startMs: 4200,
    durationMs: 3600,
    y: 520,
  });

  doc.tracks[0]!.clips.push(hero, sub);
  doc.tracks[1]!.clips.push(caption);
  doc.tracks[2]!.clips.push(createAudioClip({ frameId, startMs: 4200, durationMs: 400 }));

  return doc;
}
