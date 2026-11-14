"use client";

import {
  createFrame,
  createId,
  createPathClip,
  createTrack,
  cssColorToHex,
  cssDeclarationsFor,
  parseCssRules,
  parseDeclarations,
  parseSvgPathData,
  resolveStyleProp,
  separateRegions,
  stackPaintOrder,
  solidPaint,
  strokeStyle,
  subpathBounds,
  translateSubpaths,
  type Clip,
  createGroupClip,
  type GroupClip,
  type MotionDocument,
  type CssRule,
  type ElementFacts,
  type FillRule,
  type GradientStop,
  type Paint,
  type PathPoint,
  type StrokeStyle,
  type Contour,
  type Track,
} from "@solomotion/core";

/**
 * SVG → editable vector layers. Each drawable element (path, rect, circle,
 * ellipse, polygon, polyline, line, <use>) becomes a PATH clip with its
 * fill/stroke, transforms flattened into the points — fully editable with the
 * pen tool afterwards.
 *
 * Styling is resolved DETERMINISTICALLY (core `svg-style`): the full SVG cascade
 * — inherited values, presentation attributes, `<style>` class/id/tag rules and
 * inline `style` — computed from strings, NOT a live DOM mount + getComputedStyle
 * (which was fragile: mount timing, the inherited-`visibility` trap, global
 * `<style>` pollution). Detection is purely structural, so ANY shape in ANY SVG
 * is found even when styling can't be resolved. `url(#…)` fills resolve their
 * gradient definitions into our Paint gradients; fill/stroke opacity folds into
 * the color's alpha; dash/cap/join carry over; `currentColor` resolves to color.
 */

/** Presentation properties we read, all inheritable except `opacity`. */
const INHERITED_PROPS = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "color",
  "visibility",
] as const;

/** The resolved style of an element after the cascade (string values). */
type ResolvedStyle = Record<string, string | undefined>;

interface DrawableShape {
  subpaths: Contour[];
  fill: Paint | null;
  fillRule: FillRule;
  stroke: StrokeStyle | null;
  name: string;
}

interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function mul(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function applyMat(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** Parse an SVG `transform` list (translate/scale/rotate/matrix/skewX/skewY). */
function parseTransform(value: string | null): Mat {
  if (!value) return IDENTITY;
  let m = IDENTITY;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) {
    const args = match[2]!.split(/[\s,]+/).filter(Boolean).map(Number);
    const [a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0] = args;
    switch (match[1]) {
      case "translate":
        m = mul(m, { ...IDENTITY, e: a0, f: args.length > 1 ? a1 : 0 });
        break;
      case "scale":
        m = mul(m, { ...IDENTITY, a: a0, d: args.length > 1 ? a1 : a0 });
        break;
      case "rotate": {
        const rad = (a0 * Math.PI) / 180;
        const rot: Mat = { a: Math.cos(rad), b: Math.sin(rad), c: -Math.sin(rad), d: Math.cos(rad), e: 0, f: 0 };
        if (args.length > 2) {
          m = mul(m, { ...IDENTITY, e: a1, f: a2 });
          m = mul(m, rot);
          m = mul(m, { ...IDENTITY, e: -a1, f: -a2 });
        } else {
          m = mul(m, rot);
        }
        break;
      }
      case "matrix":
        m = mul(m, { a: a0, b: a1, c: a2, d: a3, e: a4, f: a5 });
        break;
      case "skewX":
        m = mul(m, { ...IDENTITY, c: Math.tan((a0 * Math.PI) / 180) });
        break;
      case "skewY":
        m = mul(m, { ...IDENTITY, b: Math.tan((a0 * Math.PI) / 180) });
        break;
    }
  }
  return m;
}

function transformSubpaths(subpaths: Contour[], m: Mat): void {
  const tp = (p: { x: number; y: number }) => {
    const t = applyMat(m, p.x, p.y);
    p.x = t.x;
    p.y = t.y;
  };
  for (const sub of subpaths) {
    for (const p of sub.points) {
      tp(p);
      if (p.hIn) tp(p.hIn);
      if (p.hOut) tp(p.hOut);
    }
  }
}

const KAPPA = 0.5522847498307936;

function ellipseSubpath(cx: number, cy: number, rx: number, ry: number): Contour {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const pts: PathPoint[] = [
    { x: cx, y: cy - ry, hIn: { x: cx - kx, y: cy - ry }, hOut: { x: cx + kx, y: cy - ry } },
    { x: cx + rx, y: cy, hIn: { x: cx + rx, y: cy - ky }, hOut: { x: cx + rx, y: cy + ky } },
    { x: cx, y: cy + ry, hIn: { x: cx + kx, y: cy + ry }, hOut: { x: cx - kx, y: cy + ry } },
    { x: cx - rx, y: cy, hIn: { x: cx - rx, y: cy + ky }, hOut: { x: cx - rx, y: cy - ky } },
  ];
  return { closed: true, points: pts };
}

function corner(x: number, y: number): PathPoint {
  return { x, y, hIn: null, hOut: null };
}

// ── Styling (deterministic cascade, no live DOM) ─────────────────────────────

function fractionOf(raw: string | null | undefined, fallback: number): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return fallback;
  return raw.trim().endsWith("%") ? v / 100 : v;
}

/** Element facts (tag/id/class) a `<style>` selector matches against. */
function factsOf(el: Element): ElementFacts {
  return {
    tag: el.tagName.toLowerCase(),
    id: el.getAttribute("id"),
    classes: (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
  };
}

/**
 * Resolve an element's full presentation style through the cascade, folding in
 * the parent's inherited style. Precedence (low→high): inherited < presentation
 * attribute < `<style>` rule < inline `style`.
 */
function resolveStyle(el: Element, rules: CssRule[], inherited: ResolvedStyle): ResolvedStyle {
  const css = cssDeclarationsFor(factsOf(el), rules);
  const inline = parseDeclarations(el.getAttribute("style") ?? "");
  const own: ResolvedStyle = {};
  // Every property in play, plus opacity (non-inherited, handled by caller).
  for (const prop of [...INHERITED_PROPS, "opacity", "display"]) {
    const v = resolveStyleProp(prop, {
      inherited: prop === "opacity" || prop === "display" ? undefined : inherited[prop],
      presentationAttr: el.getAttribute(prop),
      cssRuleValue: css[prop],
      inlineStyleValue: inline[prop],
    });
    if (v !== undefined) own[prop] = v;
  }
  return own;
}

/** Resolve `currentColor` against the cascaded `color` (default black). */
function resolveCurrentColor(value: string | undefined, style: ResolvedStyle): string | undefined {
  if (value === undefined) return undefined;
  return /^currentcolor$/i.test(value.trim()) ? style.color ?? "#000000" : value;
}

/** Resolve a gradient element (following href templates) into our Paint. */
function gradientPaint(el: Element, root: Element, rules: CssRule[], alphaMul: number): Paint | null {
  // Stops may live on a referenced template (<linearGradient href="#base">).
  let stopSource: Element | null = el;
  const seen = new Set<Element>();
  while (stopSource && stopSource.querySelectorAll("stop").length === 0 && !seen.has(stopSource)) {
    seen.add(stopSource);
    const href: string | null = stopSource.getAttribute("href") ?? stopSource.getAttribute("xlink:href");
    stopSource = href?.startsWith("#") ? root.querySelector(`[id="${href.slice(1)}"]`) : null;
  }
  const stopEls = stopSource ? Array.from(stopSource.querySelectorAll("stop")) : [];
  if (stopEls.length === 0) return null;

  const stops: GradientStop[] = stopEls.map((s, i) => {
    const css = cssDeclarationsFor(factsOf(s), rules);
    const inline = parseDeclarations(s.getAttribute("style") ?? "");
    const stopColorRaw =
      inline["stop-color"] ?? css["stop-color"] ?? s.getAttribute("stop-color") ?? "#000";
    const stopOpacity = inline["stop-opacity"] ?? css["stop-opacity"] ?? s.getAttribute("stop-opacity");
    const alpha = fractionOf(stopOpacity, 1) * alphaMul;
    return {
      id: createId("stop"),
      offset: Math.min(1, Math.max(0, fractionOf(s.getAttribute("offset"), i / Math.max(1, stopEls.length - 1)))),
      color: cssColorToHex(stopColorRaw, alpha) ?? "#000000",
    };
  });
  if (stops.length === 1) return solidPaint(stops[0]!.color);

  const entry = { id: createId("paint"), enabled: true, opacity: 1, blendMode: "normal" as const };
  const tag = el.tagName.toLowerCase();
  if (tag === "radialgradient") {
    const cx = fractionOf(el.getAttribute("cx"), 0.5);
    const cy = fractionOf(el.getAttribute("cy"), 0.5);
    const r = fractionOf(el.getAttribute("r"), 0.5);
    return { ...entry, type: "radial", stops, start: { x: cx, y: cy }, end: { x: cx + r, y: cy } };
  }
  const x1 = fractionOf(el.getAttribute("x1"), 0);
  const y1 = fractionOf(el.getAttribute("y1"), 0.5);
  const x2 = fractionOf(el.getAttribute("x2"), 1);
  const y2 = fractionOf(el.getAttribute("y2"), 0.5);
  return { ...entry, type: "linear", stops, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
}

/** A resolved fill/stroke value ("none" | color | currentColor | url(#…)) → Paint. */
function paintFrom(value: string | undefined, style: ResolvedStyle, root: Element, rules: CssRule[], alphaMul: number): Paint | null {
  const raw = resolveCurrentColor(value, style);
  const v = (raw ?? "").trim();
  if (!v || v === "none") return null;
  if (alphaMul <= 0.003) return null;
  const url = /^url\(["']?#([^"')]+)["']?\)/.exec(v);
  if (url) {
    const def = root.querySelector(`[id="${url[1]}"]`);
    if (def && /gradient$/i.test(def.tagName)) return gradientPaint(def, root, rules, alphaMul);
    // A paint-server we can't represent (pattern/filter) — fall back to any
    // second value (`fill: url(#p) red`) or leave unpainted.
    const fallback = v.slice(url[0].length).trim();
    return fallback ? paintFrom(fallback, style, root, rules, alphaMul) : null;
  }
  const hex = cssColorToHex(v, alphaMul);
  return hex ? solidPaint(hex) : null;
}

const SKIP_TAGS = new Set(["defs", "symbol", "clippath", "mask", "marker", "pattern", "style", "title", "desc", "metadata", "filter", "lineargradient", "radialgradient", "script", "foreignobject"]);
const SHAPE_TAGS = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline", "line"]);

/** Hidden by the RESOLVED cascade (display:none / visibility:hidden)? */
function styleHidden(style: ResolvedStyle): boolean {
  if (style.display === "none") return true;
  const vis = style.visibility;
  return vis === "hidden" || vis === "collapse";
}

/** Turn ONE drawable element into subpaths (geometry only), or null. */
function elementSubpaths(el: Element, tag: string): Contour[] | null {
  const num = (name: string, fallback = 0) => parseFloat(el.getAttribute(name) ?? "") || fallback;
  if (tag === "path") {
    const d = el.getAttribute("d");
    if (!d) return null;
    try {
      const s = parseSvgPathData(d);
      return s.length > 0 ? s : null;
    } catch {
      return null;
    }
  }
  if (tag === "rect") {
    const x = num("x");
    const y = num("y");
    const w = num("width");
    const h = num("height");
    return w > 0 && h > 0
      ? [{ closed: true, points: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] }]
      : null;
  }
  if (tag === "circle") {
    const r = num("r");
    return r > 0 ? [ellipseSubpath(num("cx"), num("cy"), r, r)] : null;
  }
  if (tag === "ellipse") {
    const rx = num("rx");
    const ry = num("ry");
    return rx > 0 && ry > 0 ? [ellipseSubpath(num("cx"), num("cy"), rx, ry)] : null;
  }
  if (tag === "polygon" || tag === "polyline") {
    const raw = (el.getAttribute("points") ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
    const pts: PathPoint[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) pts.push(corner(raw[i]!, raw[i + 1]!));
    return pts.length >= 2 ? [{ closed: tag === "polygon", points: pts }] : null;
  }
  if (tag === "line") {
    return [{ closed: false, points: [corner(num("x1"), num("y1")), corner(num("x2"), num("y2"))] }];
  }
  return null;
}

/** Read fill/stroke/rule off an element's RESOLVED style into a DrawableShape. */
function shapeFrom(
  el: Element,
  tag: string,
  subpaths: Contour[],
  m: Mat,
  root: Element,
  rules: CssRule[],
  style: ResolvedStyle,
  groupAlpha: number,
): DrawableShape {
  const noFillDefault = tag === "line" || tag === "polyline";
  // Default SVG fill is black; only "none" removes it. For open shapes (line /
  // polyline) there's no default fill.
  const fillRaw = style.fill ?? (noFillDefault ? "none" : "#000");
  const fill = paintFrom(fillRaw, style, root, rules, fractionOf(style["fill-opacity"], 1) * groupAlpha);
  const strokePaint = paintFrom(style.stroke ?? "none", style, root, rules, fractionOf(style["stroke-opacity"], 1) * groupAlpha);
  const scaleAvg = (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2 || 1;
  const dashRaw = style["stroke-dasharray"];
  const dash = !dashRaw || dashRaw === "none"
    ? []
    : dashRaw.split(/[\s,]+/).map((v) => (parseFloat(v) || 0) * scaleAvg).slice(0, 2);
  const cap = style["stroke-linecap"];
  const join = style["stroke-linejoin"];
  return {
    subpaths,
    fill,
    fillRule: style["fill-rule"] === "evenodd" ? "evenodd" : "nonzero",
    stroke:
      strokePaint !== null
        ? strokeStyle(strokePaint, {
            width: Math.max(0.1, (parseFloat(style["stroke-width"] ?? "1") || 1) * scaleAvg),
            align: "center",
            cap: cap === "round" ? "round" : cap === "square" ? "square" : "butt",
            join: join === "round" ? "round" : join === "bevel" ? "bevel" : "miter",
            dash: dash.filter((v) => v > 0),
          })
        : null,
    name: el.getAttribute("id") || el.getAttribute("class") || tag,
  };
}

/**
 * The root SVG's viewBox→viewport transform, so extracted geometry lands at the
 * SVG's REAL rendered size (a viewBox of 200×300 shown at width=1667 must scale
 * ~8×, else the vectors come out tiny next to the original image). Honors
 * preserveAspectRatio's meet/slice + xMid/yMid the common way.
 */
function rootViewportMatrix(svg: Element): Mat {
  const vb = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
  if (vb.length !== 4) return IDENTITY;
  const [vx = 0, vy = 0, vw = 0, vh = 0] = vb;
  if (!(vw > 0 && vh > 0)) return IDENTITY;
  const wAttr = parseFloat(svg.getAttribute("width") ?? "");
  const hAttr = parseFloat(svg.getAttribute("height") ?? "");
  const w = Number.isFinite(wAttr) && wAttr > 0 ? wAttr : vw;
  const h = Number.isFinite(hAttr) && hAttr > 0 ? hAttr : vh;
  const par = (svg.getAttribute("preserveAspectRatio") ?? "xMidYMid meet").trim().toLowerCase();
  let sx = w / vw;
  let sy = h / vh;
  let tx = -vx * sx;
  let ty = -vy * sy;
  if (par !== "none") {
    const s = par.includes("slice") ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = s;
    tx = -vx * s + (w - vw * s) / 2; // xMid
    ty = -vy * s + (h - vh * s) / 2; // yMid
  }
  return { a: sx, b: 0, c: 0, d: sy, e: tx, f: ty };
}

/**
 * Extract drawable shapes from SVG markup (flattened transforms + resolved
 * cascade). Pure parse — NO live DOM mount / getComputedStyle. Detection is
 * structural, so ANY shape in ANY SVG is found; styling is resolved from the
 * cascade so `<style>` classes, inline styles, presentation attributes,
 * inheritance and currentColor all apply. Never throws — returns what it can.
 */
export function parseSvgDrawables(svgText: string): { shapes: DrawableShape[] } | null {
  // Tolerate a leading BOM / whitespace / XML prolog before <svg>.
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg" || parsed.querySelector("parsererror")) return null;

  // Gather every <style> block's rules once (source order preserved).
  const rules: CssRule[] = [];
  for (const styleEl of Array.from(root.querySelectorAll("style"))) {
    rules.push(...parseCssRules(styleEl.textContent ?? ""));
  }

  const rootM = rootViewportMatrix(root);

  const collect = (respectHidden: boolean): DrawableShape[] => {
    const out: DrawableShape[] = [];
    const walk = (el: Element, ctm: Mat, depth: number, inherited: ResolvedStyle, parentAlpha: number) => {
      if (depth > 96) return;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      const style = resolveStyle(el, rules, inherited);
      if (respectHidden && styleHidden(style)) return;
      const m = mul(ctm, parseTransform(el.getAttribute("transform")));
      // opacity is NOT inherited but compounds visually down the tree.
      const alpha = parentAlpha * fractionOf(style.opacity, 1);
      // Only inheritable props flow to children (opacity/display do not).
      const childInherited: ResolvedStyle = {};
      for (const p of INHERITED_PROPS) if (style[p] !== undefined) childInherited[p] = style[p];

      if (tag === "use") {
        const href = el.getAttribute("href") ?? el.getAttribute("xlink:href");
        const ref = href?.startsWith("#") ? root.querySelector(`[id="${href.slice(1)}"]`) : null;
        if (ref) {
          const x = parseFloat(el.getAttribute("x") ?? "0") || 0;
          const y = parseFloat(el.getAttribute("y") ?? "0") || 0;
          walk(ref, mul(m, { ...IDENTITY, e: x, f: y }), depth + 1, childInherited, alpha);
        }
        return;
      }

      if (SHAPE_TAGS.has(tag)) {
        const subpaths = elementSubpaths(el, tag);
        if (subpaths) {
          transformSubpaths(subpaths, m);
          out.push(shapeFrom(el, tag, subpaths, m, root, rules, style, alpha));
          return;
        }
      }
      for (const child of Array.from(el.children)) walk(child, m, depth + 1, childInherited, alpha);
    };
    // The ROOT is part of the cascade. Lucide, Feather and Tabler put the whole
    // look on `<svg>` itself — `fill="none" stroke="currentColor"
    // stroke-width="2"` and the `color` currentColor resolves to — and a walk
    // that started its children from an empty style imported every one of
    // them black and filled.
    const rootStyle = resolveStyle(root, rules, {});
    const rootInherited: ResolvedStyle = {};
    for (const p of INHERITED_PROPS) if (rootStyle[p] !== undefined) rootInherited[p] = rootStyle[p];
    for (const child of Array.from(root.children)) walk(child, rootM, 0, rootInherited, fractionOf(rootStyle.opacity, 1));
    return out;
  };

  let shapes = collect(true);
  // Future-safe: if honoring hidden markup found nothing, import EVERYTHING
  // drawable rather than failing — a shape is always better than an error.
  if (shapes.length === 0) shapes = collect(false);
  return { shapes: separateShapes(shapes) };
}

/**
 * Split every parsed element into the pieces it actually IS.
 *
 * Illustrator, Figma and most icon exporters happily merge a whole logo into
 * one `<path d="M…Z M…Z M…Z">`. Imported as written, that is one opaque layer:
 * you cannot recolour the dot of the `i`, animate one petal, or morph a single
 * shape — the artwork arrives as a picture rather than as artwork.
 *
 * `separateRegions` is the whole fix. A hole stays with the outline it is a
 * hole in (a hole has no colour of its own); everything genuinely disjoint
 * becomes its own layer, and therefore gets its own fill, stroke, transform,
 * effects, morph, trim and keyframes for free, because it is a `path` clip and
 * that is simply what a clip has.
 *
 * Done HERE, at the parse seam, so both import paths — drop-onto-a-frame and
 * make-a-component — inherit it and neither has to know it happened. Style is
 * shared by construction: every piece of one element was one element, so it
 * carries that element's fill, stroke and fill rule.
 */
function separateShapes(shapes: DrawableShape[]): DrawableShape[] {
  const out: DrawableShape[] = [];
  for (const shape of shapes) {
    const regions = separateRegions(shape.subpaths, shape.fillRule);
    if (regions.length <= 1) {
      out.push(shape);
      continue;
    }
    regions.forEach((region, i) => {
      out.push({ ...shape, subpaths: region.contours, name: `${shape.name} ${i + 1}` });
    });
  }
  return out;
}

export interface SvgImportTarget {
  frameId: string;
  startMs: number;
  durationMs?: number;
  x?: number;
  y?: number;
}

/**
 * Turn SVG markup into path clips around the drop point (relative layout
 * preserved; 2+ elements arrive grouped — the group clip leads the list and
 * `members` names what belongs on its rows). Returns null when nothing drawable.
 */
export function svgToClips(
  svgText: string,
  fileName: string,
  target: SvgImportTarget,
): { clips: Clip[]; group: GroupClip | null; members: string[] } | null {
  const parsed = parseSvgDrawables(svgText);
  if (!parsed || parsed.shapes.length === 0) return null;

  // Overall bounds → the drop point becomes the artwork's center.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of parsed.shapes) {
    const b = subpathBounds(s.subpaths);
    if (!b) continue;
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  if (!Number.isFinite(minX)) return null;
  const allCx = (minX + maxX) / 2;
  const allCy = (minY + maxY) / 2;

  const baseName = fileName.replace(/\.[^.]+$/, "");
  // 2+ shapes arrive as ONE group — a clip like any other, so it is placed on
  // a lane with the paths rather than pushed into a side table.
  const group =
    parsed.shapes.length > 1
      ? createGroupClip({
          frameId: target.frameId,
          startMs: target.startMs,
          durationMs: target.durationMs ?? 5000,
          name: baseName || "SVG",
        })
      : null;

  const clips: Clip[] = parsed.shapes.map((shape, i) => {
    // Each clip's geometry re-centers on its own bounds; the offset moves into
    // the transform so layers move/rotate around their own middle.
    const b = subpathBounds(shape.subpaths)!;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    translateSubpaths(shape.subpaths, -cx, -cy);
    const clip = createPathClip({
      frameId: target.frameId,
      subpaths: shape.subpaths,
      startMs: target.startMs,
      durationMs: target.durationMs,
      x: Math.round((target.x ?? 0) + (cx - allCx)),
      y: Math.round((target.y ?? 0) + (cy - allCy)),
      fill: shape.fill,
      stroke: shape.stroke,
      name: parsed.shapes.length > 1 ? `${baseName} / ${shape.name}-${i + 1}` : baseName || "Path",
    });
    clip.fillRule = shape.fillRule;
    return clip;
  });

  // SVG document order is bottom→top and every placement primitive takes its
  // clips topmost-first, so the list is turned around HERE rather than at each
  // caller — the same conversion `svgComponentFrame` makes below, and the same
  // one a vector split makes. The group leads regardless: it is the container,
  // not a layer in the stack, and it keeps the slot the artwork is replacing.
  const stacked = stackPaintOrder(clips);
  // Membership is the ROW's: once the caller has placed the clips it hands
  // `members` to `moveClipsToScope(doc, members, group.id)`.
  return { clips: group ? [group, ...stacked] : stacked, group, members: group ? stacked.map((c) => c.id) : [] };
}

export interface SvgComponentTarget {
  name: string;
  pageId: string;
  /** Frame size; defaults to the SVG's viewBox size. */
  width?: number;
  height?: number;
  background?: string;
  /** Mark the frame a reusable component with this description. */
  component?: { description: string };
  /** Extra pluginData to stamp on the frame (e.g. a lipsync viseme tag). */
  pluginData?: Record<string, unknown>;
  /** Canvas position of the frame. */
  x?: number;
  y?: number;
}

/** A `viewBox` (or width/height fallback) as an origin + size. */
function parseSvgViewBox(svgText: string): { x: number; y: number; width: number; height: number } {
  const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(svgText);
  if (vb) {
    const [x = 0, y = 0, width = 0, height = 0] = vb[1]!.split(/[\s,]+/).map(Number);
    if (width > 0 && height > 0) return { x, y, width, height };
  }
  const w = Number(/\bwidth\s*=\s*["']([\d.]+)["']/i.exec(svgText)?.[1]);
  const h = Number(/\bheight\s*=\s*["']([\d.]+)["']/i.exec(svgText)?.[1]);
  return { x: 0, y: 0, width: w > 0 ? w : 300, height: h > 0 ? h : 240 };
}

/**
 * Turn SVG markup into a real COMPONENT frame — the reusable, headless bridge
 * for adopting ANY svg (a mouth pack, an icon set, a template) as editable
 * layers. Same accurate parser as `svgToClips`, but laid out in the SVG's OWN
 * viewBox space (recentered so the viewBox center is the frame center), so
 * multiple SVGs from one pack align on a shared frame — not on each shape's
 * bounds. Each shape is a path layer on its OWN private track (homed to the
 * frame), stacked in the RIGHT z-order: the timeline paints track 0 on top, and
 * SVG document order is bottom→top, so the last element wins the top track.
 * Mutates `doc`; returns the new frame id (or null when nothing is drawable).
 */
export function svgToComponent(doc: MotionDocument, svgText: string, target: SvgComponentTarget): string | null {
  const parsed = parseSvgDrawables(svgText);
  if (!parsed || parsed.shapes.length === 0) return null;

  const view = parseSvgViewBox(svgText);
  const frame = createFrame({
    name: target.name,
    width: target.width ?? view.width,
    height: target.height ?? view.height,
    background: target.background ?? "#00000000",
    overflow: 1,
    pageId: target.pageId,
  });
  // A fresh SVG component is the main variant of its own new set.
  if (target.component) {
    frame.component = { description: target.component.description, setId: frame.id, variantName: "Main" };
  }
  if (target.pluginData) Object.assign(frame.pluginData, target.pluginData);
  if (target.x !== undefined) frame.x = target.x;
  if (target.y !== undefined) frame.y = target.y;
  doc.frames.push(frame);

  // Path clips position relative to the frame CENTER, so shift every shape so
  // the viewBox center lands there — the fixed-frame alignment across a pack.
  const cx = view.x + view.width / 2;
  const cy = view.y + view.height / 2;
  const tracks: Track[] = parsed.shapes.map((shape) => {
    translateSubpaths(shape.subpaths, -cx, -cy);
    const clip = createPathClip({
      frameId: frame.id,
      subpaths: shape.subpaths,
      startMs: 0,
      x: 0,
      y: 0,
      name: shape.name,
      fill: shape.fill,
      stroke: shape.stroke,
    });
    clip.fillRule = shape.fillRule;
    clip.fillDuration = true; // a component's layers always span it
    const track = createTrack(shape.name, frame.id); // homeCompId = frame → private
    track.clips = [clip];
    return track;
  });
  // Document order is bottom→top; track index 0 renders on top → last shape first.
  doc.tracks.splice(0, 0, ...stackPaintOrder(tracks));
  return frame.id;
}
