import type { AdjustmentClip, Clip, ClipKind, ClipPlayback, VisualClip } from "./schema";

/**
 * The clip capability registry — ONE place that declares, per kind, what a clip
 * can do. Instead of scattering `kind === "audio"` / `kind === "nested"` checks
 * across the codebase, call these helpers. Adding a clip kind (image, video,
 * vector…) means one schema variant + one entry here; the generic machinery
 * (selection, snapping, keyframes, the shared context menu) needs no changes.
 */
export interface ClipKindMeta {
  kind: ClipKind;
  label: string;
  /** Renders into a frame and carries a transform (everything except audio). */
  visual: boolean;
  /**
   * Wraps a source with its own intrinsic duration, played through `playback`
   * (speed + loop). Nested comps today; imported video/audio will set this too,
   * reusing the exact same time-remap foundation (`sourceTimeAt`).
   */
  sourceBacked: boolean;
  /**
   * A PROCESSOR layer (v39): it paints no content of its own, it re-processes
   * the pixels it reaches (adjustment layers). It still rides `visualClipBase`
   * (transform, effects, opacity, blend, layer tree) — the renderer just runs
   * it through the adjustment path instead of a per-kind draw, and surfaces
   * that want "real" drawable layers (thumbnails, some pickers) skip it.
   */
  processor?: boolean;
  /**
   * The most a clip of this kind can show as a POSTER on the timeline (and in
   * any other surface that wants a picture of a clip — see `preview/poster`):
   *
   *  - `"strip"` — its picture changes over its own span, so it reads as a
   *    filmstrip cut at source-frame boundaries;
   *  - `"still"` — one picture is the whole truth about it;
   *  - `"none"` — a poster would say nothing this clip's existing chrome does
   *    not already say better (an audio clip has its waveform, a text clip has
   *    its words, an adjustment layer has its hazard sheen).
   *
   * A CEILING, not the answer: `clipPosterSource` narrows it per instance, so
   * a static PNG on the `"strip"`-capable image kind resolves to a still while
   * an animated GIF on the same kind resolves to a strip. Declaring the
   * ceiling here is what keeps "can this kind be previewed at all" a one-line
   * registry fact instead of a condition repeated in every preview surface.
   */
  poster: PosterMode;
  /** A 3D-only kind (v89) — see `isSpatialClip`. */
  spatial?: boolean;
}

/** @see ClipKindMeta.poster */
export type PosterMode = "strip" | "still" | "none";

export const CLIP_KINDS: Record<ClipKind, ClipKindMeta> = {
  // Text IS its content: the words already print on the clip, and a 40px
  // picture of them is strictly less readable than the string. A caption is a
  // text clip carrying the caption module — not a kind of its own (v52).
  text: { kind: "text", label: "Text", visual: true, sourceBacked: false, poster: "none" },
  // Audio has a waveform, which is the right picture of a sound.
  audio: { kind: "audio", label: "Audio", visual: false, sourceBacked: true, poster: "none" },
  // A GROUP contains other layers. It paints nothing itself — its picture IS
  // its members, which are on screen already — so a poster would only ever
  // duplicate the rows beneath it.
  group: { kind: "group", label: "Group", visual: true, sourceBacked: false, poster: "none" },
  // Visual non-text kinds ride text tracks (generic visual carriers).
  nested: { kind: "nested", label: "Nested", visual: true, sourceBacked: true, poster: "strip" },
  // Still by default; an animated GIF/APNG/WebP resolves to a strip.
  image: { kind: "image", label: "Image", visual: true, sourceBacked: false, poster: "strip" },
  video: { kind: "video", label: "Video", visual: true, sourceBacked: true, poster: "strip" },
  // Parametric vector layers get NO poster, and the reason is worth keeping:
  // their look is a handful of animatable properties, so a fill that animates
  // from red to blue has no single true picture — a still thumbnail would show
  // one instant and go on showing it, which reads as a bug rather than as a
  // simplification. Cutting a strip instead would mean a full isolated render
  // per tile to say something the clip's own colour and name already say. They
  // are the one kind where the honest preview is no preview.
  shape: { kind: "shape", label: "Shape", visual: true, sourceBacked: false, poster: "none" },
  path: { kind: "path", label: "Path", visual: true, sourceBacked: false, poster: "none" },
  // Procedural: reads time from its TARGET clip's playback, owns none itself.
  // Its picture IS a waveform of a sound it does not own — the target audio
  // clip's own strip already shows that, so a second copy is noise.
  waveform: { kind: "waveform", label: "Waveform", visual: true, sourceBacked: false, poster: "none" },
  // Procedural like the waveform: its picture is the path its source has
  // drawn up to now, which no single poster states.
  trace: { kind: "trace", label: "Trace", visual: true, sourceBacked: false, poster: "none" },
  // A paint surface (pixels live app-side, keyed by surfaceId; see schema).
  // Unlike the vector kinds above, its picture is pixels a user DREW: it does
  // not vary with time, and a thumbnail of it is the only way to tell two
  // paint layers apart.
  raster: { kind: "raster", label: "Pixel layer", visual: true, sourceBacked: false, poster: "still" },
  // A processor: grades the layers it reaches, paints no content of its own —
  // so it has no picture to show, only the layers below it, which are not its.
  adjustment: { kind: "adjustment", label: "Adjustment", visual: true, sourceBacked: false, processor: true, poster: "none" },
  // THE 3D KINDS (v89). They live in worlds (`frame.world`) and are drawn by
  // the world engine, never by a 2D painter. No posters: a mesh's look is
  // parametric like a shape's, and a camera or light has no picture of its own.
  mesh: { kind: "mesh", label: "Mesh", visual: true, sourceBacked: false, poster: "none", spatial: true },
  camera: { kind: "camera", label: "Camera", visual: true, sourceBacked: false, poster: "none", spatial: true },
  light: { kind: "light", label: "Light", visual: true, sourceBacked: false, poster: "none", spatial: true },
  empty: { kind: "empty", label: "Controller", visual: true, sourceBacked: false, poster: "none", spatial: true },
};

/**
 * A 3D-ONLY kind: meaningful inside a world and nowhere else (mesh, camera,
 * light, controller). Every 2D surface that walks visual clips asks this once instead of
 * listing kinds — the 2D renderer skips them, the world engine draws them.
 */
export function isSpatialClip(clip: Clip): boolean {
  return CLIP_KINDS[clip.kind].spatial === true;
}

export function clipKindMeta(clip: Clip): ClipKindMeta {
  return CLIP_KINDS[clip.kind];
}

/** A visual clip renders into a frame with a transform (text, nested, media…). */
export function isVisualClip(clip: Clip): clip is VisualClip {
  return CLIP_KINDS[clip.kind].visual;
}

/**
 * A processor layer re-grades the pixels it reaches instead of painting content
 * (adjustment layers). The one check every surface uses to branch on "this layer
 * has no drawable content of its own" — the renderer runs it through the
 * adjustment path, thumbnails/asset pickers skip it, the inspector shows scope.
 */
export function isAdjustmentClip(clip: Clip): clip is AdjustmentClip {
  return clip.kind === "adjustment";
}

/**
 * How a resize gesture edits this clip (Figma's two resize modes) — the single
 * source of truth for BOTH the gesture (which property to write) and the chrome
 * (dashed box = native geometry edit, solid = transform scale):
 *
 *  - "shape": the drag edits the shape's own `width`/`height`, so corner radii,
 *    stroke widths and vertices keep their true pixel size instead of being
 *    stretched. The default for parametric shapes.
 *  - "text": the drag edits the text box's wrap width (`maxWidth`) — words
 *    reflow, the glyphs don't scale. The default for text.
 *  - null: the clip has no intrinsic editable geometry (image/video/nested/…),
 *    so a resize can only scale the whole layer's transform.
 *
 * Holding ⌘/Ctrl OVERRIDES a native mode back to a plain transform scale, so
 * every layer can also be scaled as one object (all props — shadows, strokes,
 * radii — scale together). That override is applied by the caller, not here.
 */
export function nativeResizeKind(clip: Clip): "shape" | "text" | "layout" | null {
  if (clip.kind === "shape") return "shape";
  if (clip.kind === "text") return "text";
  // A laid-out group DECLARES its box (relations/layout.ts): dragging its edge
  // sets a width or a height — fixing a hugging axis — never a scale.
  if (clip.kind === "group" && clip.layout) return "layout";
  return null;
}


/**
 * The playback (speed + loop) of a source-backed clip, or null for the rest.
 * An image clip only carries `playback` when its asset is animated (gif/
 * apng/webp) — the import path seeds it then; a static image never has one,
 * so this naturally returns null and every playback-aware surface hides.
 */
export function clipPlaybackOf(clip: Clip): ClipPlayback | null {
  switch (clip.kind) {
    case "nested":
    case "video":
      return clip.playback;
    case "audio":
      return clip.source.type === "asset" ? clip.playback : null;
    case "image":
      return clip.playback ?? null;
    default:
      return null;
  }
}

/**
 * Write a playback patch to a source-backed clip (no-op for the rest). An
 * image clip lazily gets its `playback` object on the FIRST write — covers
 * a doc where an animated image somehow has none yet (defensive; the normal
 * path seeds it at import).
 */
export function setClipPlayback(clip: Clip, patch: Partial<ClipPlayback>): void {
  if (clip.kind === "nested" || clip.kind === "video" || clip.kind === "audio") {
    Object.assign(clip.playback, patch);
    return;
  }
  if (clip.kind === "image") {
    clip.playback ??= { speed: 1, loop: "loop", reverse: false, loopLengthMs: null };
    Object.assign(clip.playback, patch);
  }
}
