"use client";

import {
  DEFAULT_LAYOUT_ITEM,
  commandsToSvgPath,
  cornerPoint,
  effectiveText,
  locateClip,
  pathCommands,
  propertyDef,
  effectiveRanges,
  evaluateClipPose,
  evaluateTextGlyphs,
  segmentTextCached,
  solidPaint,
  GLYPH_IDENTITY,
  type DocumentStore,
  type LottieGlyph,
  type OutlinedTextPath,
  type PathClip,
  type PathCommand,
  type Contour,
  adoptContours,
  type TextClip,
  type MotionDocument,
  resolveColor,
  resolveTextStyle,
  type PathGlyphPose,
  presentationForm,
} from "@solomotion/core";
import { NO_CONTENT, NO_CROP } from "@solomotion/core";
import type { Font, PathCommand as OtCommand } from "opentype.js";
import { platform } from "@/editor/platform";
import { fauxBoldOutset, layoutTextClip, type LaidGlyph } from "../stage/render/text-layout";
import { planTextOnPath } from "../stage/render/text-on-path";
import { getCustomFontBlob, notifyFontsChanged } from "../stage/render/fonts";

/**
 * Text outlining — the ONE facility that turns live text into real vector
 * geometry. Everything that needs "text as paths" goes through here:
 *
 *  - SVG export (a true vector SVG never ships <text> that needs the font)
 *  - Lottie export (glyph shape groups, animation baked around each glyph)
 *  - "Convert text to path" (a text clip becomes an editable path clip)
 *
 * Glyph positions come from the SAME canvas layout the renderer paints with
 * (`layoutTextClip`), so outlines land pixel-exact on what
 * the user sees. Outlines come from opentype.js over real font binaries:
 * custom uploads parse directly from their stored bytes; Google families are
 * fetched as TTF through /api/font (browsers can only get woff2 themselves).
 * Both the parser and the fonts load lazily — nobody pays until they outline.
 */

// ── Font resolution ──────────────────────────────────────────────────────────

const fontCache = new Map<string, Promise<Font | null>>();

async function loadFont(family: string, weight: number, italic: boolean): Promise<Font | null> {
  const key = `${family}|${weight}|${italic ? 1 : 0}`;
  let cached = fontCache.get(key);
  if (!cached) {
    cached = (async () => {
      const opentype = await import("opentype.js");
      // Local faces first — their bytes are authoritative, and asking BY FACE is
      // what makes an export of bold text outline the bold file. Keyed by family
      // alone, this resolved every weight to the one blob the family happened to
      // have, so every export silently outlined the regular.
      const custom = await getCustomFontBlob(family, weight, italic);
      if (custom) {
        try {
          return opentype.parse(custom.data);
        } catch {
          return null;
        }
      }
      try {
        // Font binary comes through the platform bridge (web hits the /api/font
        // proxy). NOTE: the static desktop build has no /api/font, so this
        // returns null there for now — a desktop-side font fetch is a TODO.
        const bytes = await platform.net.fetchFont({ family, weight, italic });
        if (!bytes) return null;
        return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      } catch {
        return null;
      }
    })();
    fontCache.set(key, cached);
    // Publish into the SYNCHRONOUS map and wake the canvas. A frame that had to
    // fall back can now draw the real outline.
    void cached.then((font) => {
      readyFonts.set(key, font);
      if (font) notifyFontsChanged([family]);
    });
  }
  return cached;
}

/**
 * Fonts already parsed and resident, keyed exactly as `fontCache` is.
 *
 * The renderer runs on a frame budget and cannot await a network font, so it
 * asks THIS, paints whatever it can, and repaints when `notifyFontsChanged`
 * reports the outline landed. `null` is a remembered failure — a font we tried
 * and could not parse — so we never re-request it every frame.
 */
const readyFonts = new Map<string, Font | null>();

/**
 * One glyph's outline in the renderer's own space, or `null` if the font is not
 * resident yet (in which case the load is kicked off and the caller falls back).
 *
 * This is what lets a TEXT stroke run the same pipeline a path's does: trim,
 * wave, taper and endpoint markers all need real geometry, and `strokeText`
 * cannot supply any of it. `x`/`y` are the glyph's baseline origin — the same
 * pair handed to `strokeText`, so the outline lands exactly on the rasterized
 * glyph it replaces.
 */
export function glyphCommandsIfReady(
  char: string,
  style: { fontFamily: string; fontWeight: number; italic: boolean; fontSize: number },
  x: number,
  y: number,
): PathCommand[] | null {
  const key = `${style.fontFamily}|${style.fontWeight}|${style.italic ? 1 : 0}`;
  if (!readyFonts.has(key)) {
    void loadFont(style.fontFamily, style.fontWeight, style.italic);
    return null;
  }
  const font = readyFonts.get(key);
  if (!font) return null;
  const subpaths = glyphSubpaths(font, char, x, y, style.fontSize);
  return subpaths && pathCommands(subpaths);
}

/**
 * One glyph's contours, or `null` when this font has no glyph for this
 * codepoint.
 *
 * The `null` is the whole point. opentype.js answers a missing codepoint with
 * `.notdef` — an EMPTY path, not an error — and an empty array is perfectly
 * truthy, so every caller happily took its geometry branch and drew nothing at
 * all. A stroke vanished; an SVG export shipped invisible paths; convert-to-path
 * produced an empty shape.
 *
 * Arabic walks into this constantly, and not because Arabic is special: we
 * address glyphs by their PRESENTATION FORM (U+FE70–FEFF — the shaper picks
 * initial/medial/final so each letter can be drawn on its own), and many fonts
 * encode only the base letters and do their joining through OpenType GSUB
 * features instead. Those fonts can rasterize the form through the browser but
 * cannot hand us its outline. Saying so lets each caller degrade honestly —
 * back to `strokeText`, back to live `<text>` — instead of silently emitting
 * nothing.
 */
function glyphSubpaths(font: Font, char: string, x: number, y: number, size: number): Contour[] | null {
  // Layout hands us SHAPED graphemes — Arabic letters wrapped in zero-width
  // joiners for the browser's shaper. opentype.js reads the cmap and shapes
  // nothing for a lone glyph, so it gets the presentation-form codepoint.
  const path = font.getPath(presentationForm(char), x, y, size);
  const subpaths = otCommandsToSubpaths(path.commands as OtCommand[]);
  return subpaths.length > 0 ? subpaths : null;
}

/** Turn and carry a glyph's contours to its pose on the curve. */
function placeOnCurve(subpaths: Contour[] | null, pose: PathGlyphPose): Contour[] | null {
  if (!subpaths) return null;
  const cos = Math.cos(pose.angle);
  const sin = Math.sin(pose.angle);
  const map = (p: { x: number; y: number }) => ({ x: pose.x + p.x * cos - p.y * sin, y: pose.y + p.x * sin + p.y * cos });
  return subpaths.map((c) => ({
    ...c,
    points: c.points.map((pt) => ({
      ...pt,
      ...map(pt),
      hIn: pt.hIn ? map(pt.hIn) : null,
      hOut: pt.hOut ? map(pt.hOut) : null,
    })),
  }));
}

// ── Outline geometry ─────────────────────────────────────────────────────────

/**
 * opentype path commands → our Contour model (quadratics raised to cubics).
 *
 * A glyph's contours are CLOSED, always: a font has no open outline. CFF fonts
 * say so with `Z`; TrueType ones (most Google fonts) do not — opentype.js ends
 * a `glyf` contour by starting the next one, back on its first point. Taking
 * that literally made every outlined word a set of open paths: a body
 * collided as its box (physics keeps closed contours only), and a stroke on
 * converted text broke at each contour's start.
 */
function otCommandsToSubpaths(cmds: OtCommand[]): Contour[] {
  const subpaths: Contour[] = [];
  let current: Contour | null = null;
  let last = { x: 0, y: 0 };
  const close = () => {
    if (current) subpaths.push(closeContour(current));
    current = null;
  };
  for (const c of cmds) {
    if (c.type === "M") {
      close();
      current = { closed: false, points: [cornerPoint(c.x, c.y)] };
      last = { x: c.x, y: c.y };
    } else if (!current) {
      continue;
    } else if (c.type === "L") {
      current.points.push(cornerPoint(c.x, c.y));
      last = { x: c.x, y: c.y };
    } else if (c.type === "C") {
      const prev = current.points[current.points.length - 1]!;
      prev.hOut = { x: c.x1, y: c.y1 };
      const p = cornerPoint(c.x, c.y);
      p.hIn = { x: c.x2, y: c.y2 };
      current.points.push(p);
      last = { x: c.x, y: c.y };
    } else if (c.type === "Q") {
      // Quadratic → cubic: control points at 2/3 toward the quad control.
      const prev = current.points[current.points.length - 1]!;
      prev.hOut = { x: last.x + (2 / 3) * (c.x1 - last.x), y: last.y + (2 / 3) * (c.y1 - last.y) };
      const p = cornerPoint(c.x, c.y);
      p.hIn = { x: c.x + (2 / 3) * (c.x1 - c.x), y: c.y + (2 / 3) * (c.y1 - c.y) };
      current.points.push(p);
      last = { x: c.x, y: c.y };
    } else if (c.type === "Z") {
      close();
    }
  }
  close();
  return subpaths;
}

/**
 * A contour as a closed loop: the segment back to the start is implied by
 * `closed`, so a last point sitting on the first is the same point drawn
 * twice — it folds into the first, keeping the handle it arrived with.
 */
function closeContour(contour: Contour): Contour {
  const pts = contour.points;
  const first = pts[0];
  const end = pts[pts.length - 1];
  if (pts.length > 1 && first && end && Math.abs(first.x - end.x) < 1e-6 && Math.abs(first.y - end.y) < 1e-6) {
    first.hIn = end.hIn;
    pts.pop();
  }
  return { ...contour, closed: true };
}

// Empty is not drawable either: an alef folded into its lam-alef ligature
// (`shapeArabicGraphemes`) keeps its slot with nothing to draw.
const isDrawable = (g: LaidGlyph) => g.char !== "\n" && !/^\s*$/.test(g.char);

interface OutlinedGlyph {
  glyph: LaidGlyph;
  subpaths: Contour[];
  /** Resolved fill color of the glyph's style. */
  fill: string;
  /** Style opacity (animation opacity composes on top). */
  styleOpacity: number;
}

// A scratch 2D context for the layout pass (same measuring the renderer uses).
let measureCtx: CanvasRenderingContext2D | null = null;
function layoutCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    measureCtx = canvas.getContext("2d")!;
  }
  return measureCtx;
}

/** Layout + outline every drawable glyph of a text clip at one instant. */
async function outlineClipGlyphs(
  doc: MotionDocument,
  clip: TextClip,
  localMs: number,
): Promise<OutlinedGlyph[] | null> {
  const ctx = layoutCtx();
  const rStyle = resolveTextStyle(doc, clip.style);
  const text = effectiveText(clip, localMs);
  const layout = layoutTextClip(
    ctx, clip, undefined, text === clip.text ? undefined : text, rStyle,
    effectiveRanges(clip, localMs),
  );

  // A text on a path: each glyph's outline is drawn at the origin and carried
  // to its pose on the curve — the same poses the canvas painted it at, in
  // the host's space, which is the layer's own space while bound.
  const onPath = planTextOnPath(doc, clip, layout, localMs, evaluateClipPose(clip, localMs).sampled);

  const out: OutlinedGlyph[] = [];
  for (let i = 0; i < layout.glyphs.length; i++) {
    const g = layout.glyphs[i]!;
    if (!isDrawable(g)) continue;
    const pose = onPath?.poses[i];
    if (onPath && (!pose || !pose.visible)) continue;
    const font = await loadFont(g.style.fontFamily, g.style.fontWeight, g.style.italic);
    if (!font) return null; // one unavailable font fails the whole outline — caller falls back
    // A glyph the font cannot draw fails the outline for the same reason an
    // unavailable font does, and must fail the same way: a caller that gets a
    // list back believes it, and would export a word as invisible paths.
    const subpaths = pose
      ? placeOnCurve(glyphSubpaths(font, g.char, -g.width / 2, 0, g.style.fontSize), pose)
      : glyphSubpaths(font, g.char, g.x, g.y, g.style.fontSize);
    if (!subpaths) return null;
    out.push({
      glyph: g,
      subpaths,
      fill: resolveColor(doc, g.style.color),
      styleOpacity: g.style.opacity,
    });
  }
  return out;
}

// ── Public surfaces ──────────────────────────────────────────────────────────

/**
 * SVG export callback: the clip's glyphs as filled outline paths at one
 * instant, with per-glyph animation (typing, fades, slides) applied — the
 * exported frame matches the canvas exactly.
 */
export async function outlineTextForSvg(
  doc: MotionDocument,
  clip: TextClip,
  localMs: number,
): Promise<OutlinedTextPath[] | null> {
  const glyphs = await outlineClipGlyphs(doc, clip, localMs);
  if (!glyphs) return null;
  const pose = evaluateClipPose(clip, localMs);
  const seg = segmentTextCached(effectiveText(clip, localMs));
  const visuals = evaluateTextGlyphs(clip, seg, localMs);

  const out: OutlinedTextPath[] = [];
  for (const og of glyphs) {
    const vis = visuals[og.glyph.graphemeIndex] ?? GLYPH_IDENTITY;
    const alpha = vis.opacity * og.styleOpacity * pose.opacity;
    if (alpha <= 0.001) continue;
    // Per-glyph animation transform (dx/dy/scale/rotation around the glyph center).
    let subpaths = og.subpaths;
    if (vis.dx !== 0 || vis.dy !== 0 || vis.scale !== 1 || vis.rotation !== 0) {
      const cx = og.glyph.x + og.glyph.width / 2 + vis.dx;
      const cy = og.glyph.y + vis.dy;
      const rad = (vis.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const ox = og.glyph.x + og.glyph.width / 2;
      const oy = og.glyph.y;
      const tx = (x: number, y: number) => {
        const lx = (x - ox) * vis.scale;
        const ly = (y - oy) * vis.scale;
        return { x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos };
      };
      subpaths = og.subpaths.map((sub) => ({
        closed: sub.closed,
        points: sub.points.map((p) => ({
          ...tx(p.x, p.y),
          hIn: p.hIn ? tx(p.hIn.x, p.hIn.y) : null,
          hOut: p.hOut ? tx(p.hOut.x, p.hOut.y) : null,
        })),
      }));
    }
    // Faux bold is the glyph's own paint stroked round its edge — the same
    // silhouette the canvas lays (`inkGlyph`), scaled with the glyph's pose.
    const outset = fauxBoldOutset(og.glyph.style) * vis.scale;
    out.push({
      d: commandsToSvgPath(pathCommands(subpaths)),
      fill: og.fill,
      fillRule: "nonzero",
      opacity: Math.min(1, alpha),
      ...(outset > 0 ? { stroke: { color: og.fill, width: outset * 2 } } : {}),
    });
  }
  return out;
}

/**
 * Lottie export callback: the clip's glyph outlines with anchors — the core
 * translator bakes per-glyph animation around them.
 */
export async function outlineGlyphsForLottie(
  doc: MotionDocument,
  clip: TextClip,
): Promise<LottieGlyph[] | null> {
  const glyphs = await outlineClipGlyphs(doc, clip, clip.durationMs);
  if (!glyphs) return null;
  return glyphs.map((og) => ({
    subpaths: og.subpaths,
    fill: og.fill,
    anchor: { x: og.glyph.x + og.glyph.width / 2, y: og.glyph.y },
    outset: fauxBoldOutset(og.glyph.style),
  }));
}

/**
 * "Convert text to path": the whole clip's outlines as one subpath list in
 * clip-local space (the caller builds the path clip + swaps it in).
 */
export async function textToSubpaths(
  doc: MotionDocument,
  clip: TextClip,
): Promise<{ subpaths: Contour[]; fill: string; glyphs: GlyphContours[] } | null> {
  const glyphs = await outlineClipGlyphs(doc, clip, 0);
  if (!glyphs || glyphs.length === 0) return null;
  let at = 0;
  return {
    subpaths: glyphs.flatMap((g) => g.subpaths),
    fill: glyphs[0]!.fill,
    glyphs: glyphs.map((g) => {
      const from = at;
      at += g.subpaths.length;
      return { char: g.glyph.char, graphemeIndex: g.glyph.graphemeIndex, from, count: g.subpaths.length };
    }),
  };
}

/** Which run of the outline's contours one character drew — a dot, a vowel mark, a counter. */
export interface GlyphContours {
  char: string;
  graphemeIndex: number;
  /** Index of its first contour in the outline. */
  from: number;
  count: number;
}

/**
 * Replace a text clip with an equivalent editable path clip IN PLACE — same id,
 * track slot, timing, transform, group, effects, paint, and every key, driver
 * and modulator a path can still read (its motion, its effects' fields, a
 * world body's thickness, surface and modifiers); only the typography's own go.
 * It is a change of representation, as Blender's Convert is: whatever pointed
 * at the layer still points at it. Returns the id, or null when the font
 * couldn't be outlined.
 */
export async function convertTextClipToPath(store: DocumentStore, clipId: string): Promise<string | null> {
  const plan = await planTextToPath(() => store.getState(), clipId);
  if (!plan) return null;
  store.update("Convert text to path", plan.apply);
  return clipId;
}

/**
 * The conversion in two halves: the outline (async — fonts load) and the edit
 * (sync, for whoever owns the write: the stage's store.update, or an agent
 * verb's own undo step). `glyphs` says which contours each character drew.
 */
export async function planTextToPath(
  read: () => MotionDocument,
  clipId: string,
): Promise<{ apply: (d: MotionDocument) => void; glyphs: GlyphContours[] } | null> {
  const doc = read();
  const loc = locateClip(doc, clipId);
  if (!loc || loc.clip.kind !== "text") return null;
  const outline = await textToSubpaths(doc, loc.clip);
  if (!outline) return null;
  const readable = (path: string) => propertyDef(path)?.appliesTo.includes("path") ?? false;
  // Cloned from the committed document (frozen plain data), never the draft.
  const now = locateClip(read(), clipId)?.clip;
  if (!now || now.kind !== "text") return null;
  const src = structuredClone(now);
  const apply = (d: MotionDocument) => {
    const live = locateClip(d, clipId);
    if (!live || live.clip.kind !== "text") return;
    const pathClip: PathClip = {
      id: src.id,
      kind: "path",
      contourStyles: {},
      layoutItem: src.layoutItem ?? { ...DEFAULT_LAYOUT_ITEM },
      name: src.name,
      frameId: src.frameId,
      trackBinding: src.trackBinding,
      audioEffects: [],
      motionBlur: src.motionBlur,
      feather: 0,
      borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      crop: { ...NO_CROP },
      content: { ...NO_CONTENT },
      startMs: src.startMs,
      durationMs: src.durationMs,
      keyframes: src.keyframes.filter((t) => !t.range && readable(t.property)),
      ...(src.drivers && { drivers: Object.fromEntries(Object.entries(src.drivers).filter(([path]) => readable(path))) }),
      ...(src.modulators && { modulators: src.modulators.filter((m) => readable(m.target)) }),
      linkGroupId: src.linkGroupId,
      mirrorId: src.mirrorId,
      origin: src.origin,
      fillDuration: src.fillDuration,
      locked: src.locked,
      hidden: src.hidden,
      audioMix: src.audioMix,
      transform: src.transform,
      maxWidth: null,
      effects: src.effects,
      opacity: src.opacity,
      blendMode: src.blendMode,
      isStencil: src.isStencil,
      fps: null,
      animIn: src.animIn,
      sounds: src.sounds,
      animOut: src.animOut,
      // A world body stays the body it was: thick, lit and modified the same.
      ...(src.constraints && { constraints: src.constraints }),
      ...(src.extrude && { extrude: src.extrude }),
      ...(src.material && { material: src.material }),
      ...(src.modifiers && { modifiers: src.modifiers }),
      subpaths: [],
      fillRule: "nonzero",
      // Paint SURVIVES the conversion. A converted layer that came back black
      // and strokeless was the same layer only in outline: every gradient, every
      // stacked line and every dash the user had built was silently thrown away,
      // and undo was the only way to learn that.
      fills: src.fills.length > 0 ? src.fills : [solidPaint(outline.fill)],
      strokes: src.strokes,
    };
    adoptContours(pathClip, outline.subpaths);
    live.track.clips[live.clipIndex] = pathClip;
  };
  return { apply, glyphs: outline.glyphs };
}
