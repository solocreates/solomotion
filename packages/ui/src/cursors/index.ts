/**
 * THE CURSOR SET. Every cursor the app shows, in the editor and on the site, is
 * defined here and nowhere else: no other file writes a `url(...)` cursor.
 *
 * Pure strings, no DOM, so it runs on a server layout and in a test as readily
 * as in a pointer handler. A value from this module is a complete CSS `cursor`
 * declaration, always ending in a keyword, so an engine that refuses the image
 * still shows a working cursor.
 *
 * The art is Figma-grade and quiet (D11): black ink, a crisp 1px white keyline,
 * a soft halo so it lifts off any ground, and NO brand colour — a cursor is an
 * instrument, not a logo. Art is drawn in px on a 24px box (the arrow is ~16px
 * tall inside it); the box is emitted at `24 × scale` px, clamped to 32 because
 * Chromium drops a larger cursor near the window's edge. The scale is UI scale
 * times the cursor-size preference — see `cursorScale` and `setCursorScale`.
 *
 * A few pieces of older art (hands, brush, timeline trims) are still drawn on a
 * 32-unit grid and placed with `legacy()`, which scales them into the 24 box and
 * thickens their strokes so the keyline is still exactly 1px.
 *
 * Angles are SCREEN degrees, y down, matching `Math.atan2(dy, dx)`: 0 is east, 90
 * is south. Resize and rotate are generated for the real angle, cached per whole
 * degree, so they never snap to the eight CSS directions.
 */

const INK = "#0B0B0D";
const KEY = "#FFFFFF";
const HALO = "rgba(0,0,0,.16)";
const HALO_SOFT = "rgba(0,0,0,.07)";

/** The design box, in px at scale 1. */
const BOX = 24;
/** Legacy art is on a 32-unit grid; this places it in the 24 box. */
const LEGACY = 0.75;

/**
 * Drawing kit. `u` is art units per screen px at scale 1: 1 for 24-box art,
 * 1/0.75 for legacy 32-grid art, so the keyline and halo stay 1px either way.
 */
const kit = (u: number) => {
  const px = (n: number) => +(n * u).toFixed(3);
  /** A closed shape: soft halo, white keyline, ink fill with a sharp ink edge. */
  const solid = (d: string): string =>
    `<g stroke-linejoin='round' stroke-linecap='round'>` +
    `<path d='${d}' fill='${HALO_SOFT}' stroke='${HALO_SOFT}' stroke-width='${px(4.4)}'/>` +
    `<path d='${d}' fill='${HALO}' stroke='${HALO}' stroke-width='${px(3.2)}'/>` +
    `<path d='${d}' fill='${KEY}' stroke='${KEY}' stroke-width='${px(2)}'/>` +
    `<path d='${d}' fill='${INK}'/></g>`;
  /** A stroke of width `w` (art units) with the same keyline. `butt` keeps hairlines square. */
  const line = (d: string, w = px(1.5), cap: "round" | "butt" = "round"): string =>
    `<g fill='none' stroke-linejoin='round' stroke-linecap='${cap}'>` +
    `<path d='${d}' stroke='${HALO_SOFT}' stroke-width='${+(w + px(4.4)).toFixed(3)}'/>` +
    `<path d='${d}' stroke='${HALO}' stroke-width='${+(w + px(3.2)).toFixed(3)}'/>` +
    `<path d='${d}' stroke='${KEY}' stroke-width='${+(w + px(2)).toFixed(3)}'/>` +
    `<path d='${d}' stroke='${INK}' stroke-width='${w}'/></g>`;
  /** A white hairline over ink: finger gaps, a nib's slit. */
  const crease = (d: string): string =>
    `<path d='${d}' fill='none' stroke='${KEY}' stroke-opacity='.9' stroke-width='${px(0.8)}' stroke-linecap='round'/>`;
  return { solid, line, crease };
};

const { solid, line, crease } = kit(1);
const old = kit(1 / LEGACY);
const legacy = (art: string): string => `<g transform='scale(${LEGACY})'>${art}</g>`;

const round = (n: number): number => Math.round(n * 100) / 100;

/** A full ring or ellipse as a path, in two arcs so the geometry cannot flip. */
const ring = (cx: number, cy: number, rx: number, ry = rx): string =>
  `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;

// ── Arrow family ─────────────────────────────────────────────────────────────

/**
 * Figma's proportions: a vertical left edge, a long right flank, a notch that
 * reads as the "heel". Tip on (4, 3), 16.2px tall, 10.8px wide. No tail.
 */
const ARROW = solid("M4 3V19.2L8.3 15.2L14.8 14.7Z");

/**
 * A badge is a small ink chip with a white keyline and a WHITE glyph, so it
 * reads on dark, light and busy grounds alike (a black hairline badge vanishes
 * on a dark canvas). Arrow badges sit below-right of the arrow, at (18.8, 18.8).
 */
const AB = [18.8, 18.8] as const;
const glyph = (d: string, w = 1.3): string =>
  `<path d='${d}' fill='none' stroke='${KEY}' stroke-width='${w}' stroke-linecap='round' stroke-linejoin='round'/>`;
const dot = (d: string): string => `<path d='${d}' fill='${KEY}'/>`;
const chip = (x: number, y: number, mark: string): string => solid(ring(x, y, 4.2)) + mark;
const sq = (x: number, y: number, h: number): string => `M${x - h} ${y - h}H${x + h}V${y + h}H${x - h}Z`;
const badges = {
  plus: (x: number, y: number) => chip(x, y, glyph(`M${x - 2.2} ${y}H${x + 2.2}M${x} ${y - 2.2}V${y + 2.2}`)),
  minus: (x: number, y: number) => chip(x, y, glyph(`M${x - 2.2} ${y}H${x + 2.2}`)),
  /** A curve with its node lifted: bend. */
  bend: (x: number, y: number) =>
    chip(x, y, glyph(`M${x - 2.6} ${y + 1.6}C${x - 1.5} ${y - 2.2} ${x + 1.5} ${y - 2.2} ${x + 2.6} ${y + 1.6}`, 1.1) + dot(sq(x, y - 1.2, 0.85))),
  /** A rounded corner: corner radius. */
  arc: (x: number, y: number) => chip(x, y, glyph(`M${x - 2} ${y + 2.2}V${y}A2 2 0 0 1 ${x} ${y - 2}H${x + 2.2}`)),
  /** A caret: corner ↔ smooth. */
  convert: (x: number, y: number) => chip(x, y, glyph(`M${x - 2.2} ${y + 1.2}L${x} ${y - 1.4}L${x + 2.2} ${y + 1.2}`)),
  close: (x: number, y: number) => chip(x, y, glyph(ring(x, y, 1.8), 1.2)),
  /** A slash leaving a node: continue from an endpoint. */
  cont: (x: number, y: number) => chip(x, y, glyph(`M${x - 0.6} ${y + 0.6}L${x + 2.2} ${y - 2.2}`) + dot(sq(x - 1.3, y + 1.3, 1.1))),
  /** A slash through a node: join onto geometry. */
  join: (x: number, y: number) => chip(x, y, glyph(`M${x - 2.3} ${y + 2.3}L${x + 2.3} ${y - 2.3}`, 1.1) + dot(sq(x, y, 1))),
  link: (x: number, y: number) => chip(x, y, glyph(`M${x - 1.8} ${y + 1.8}L${x + 1.8} ${y - 1.8}M${x - 0.6} ${y - 1.8}H${x + 1.8}V${y + 0.6}`, 1.2)),
  help: (x: number, y: number) =>
    chip(x, y, glyph(`M${x - 1.5} ${y - 1.1}C${x - 1.5} ${y - 2.2} ${x - 0.7} ${y - 2.7} ${x} ${y - 2.7}C${x + 0.9} ${y - 2.7} ${x + 1.6} ${y - 2.1} ${x + 1.6} ${y - 1.2}C${x + 1.6} ${y + 0.2} ${x} ${y + 0.1} ${x} ${y + 1}`, 1.1) +
      `<circle cx='${x}' cy='${y + 2.4}' r='.75' fill='${KEY}'/>`),
};

// ── Pen family ───────────────────────────────────────────────────────────────

/** The pen nib in local space, tip at the origin, pointing up. */
const NIB_LOCAL = "M0 0C-.9 2.8-3.4 5-3.6 7.8L-2.3 11.2H2.3L3.6 7.8C3.4 5 .9 2.8 0 0Z";
/** Tip on (4, 3), leaning so it runs down-right; the badge corner is top-right. */
const NIB =
  `<g transform='translate(4 3) rotate(-45)'>${solid(NIB_LOCAL)}${line("M-2.4 13H2.4", 1.3, "butt")}${crease("M0 1V5.6")}` +
  `<circle cx='0' cy='6.6' r='.9' fill='${KEY}'/></g>`;
/** Pen badges ride the top-right corner, clear of the nib. */
const PB = [18.6, 5.6] as const;

const pen = {
  pen: NIB,
  penAdd: NIB + badges.plus(...PB),
  penRemove: NIB + badges.minus(...PB),
  /** Convert a point: a caret (corner ↔ smooth). */
  penConvert: NIB + badges.convert(...PB),
  /** Close the run: a ring. */
  penClose: NIB + badges.close(...PB),
  /** Continue from an endpoint: a slash leaving a node. */
  penContinue: NIB + badges.cont(...PB),
  /** Join onto existing geometry: a slash through a node. */
  penJoin: NIB + badges.join(...PB),
  /** ⌘ held with the pen: bend the segment under the pointer. */
  penBend: NIB + badges.bend(...PB),
};

// ── Hands (legacy 32 grid) ───────────────────────────────────────────────────

/** Finger strokes over a palm; the fist and the open hand differ only in the strokes. */
const hand = (strokes: string, palm: string, creases: string, w = 3.6): string => {
  const p = 1 / LEGACY;
  return legacy(
    `<g fill='none' stroke-linecap='round' stroke-linejoin='round'>` +
      `<path d='${strokes}' stroke='${HALO}' stroke-width='${round(w + 3.2 * p)}'/>` +
      `<path d='${palm}' fill='${HALO}' stroke='${HALO}' stroke-width='${round(3.2 * p)}'/>` +
      `<path d='${strokes}' stroke='${KEY}' stroke-width='${round(w + 2 * p)}'/>` +
      `<path d='${palm}' fill='${KEY}' stroke='${KEY}' stroke-width='${round(2 * p)}'/>` +
      `<path d='${strokes}' stroke='${INK}' stroke-width='${w}'/>` +
      `<path d='${palm}' fill='${INK}'/></g>` +
      creases,
  );
};

const POINTER = hand(
  "M13 5V17M16.7 13V17M20.3 13.8V17M23.6 15V19M13 19L8.8 15.6",
  "M11.2 15H25.4V21.5C25.4 25 23 27.6 19.6 27.6H16.4C14.6 27.6 13.2 26.8 12.2 25.4L9.2 19.6L11.2 18Z",
  old.crease("M14.9 13.4V17.4M18.5 13.8V17.4M22 14.8V17.8"),
);
const GRAB = hand(
  "M10.4 12.4V17M14.1 7.4V16M17.8 6.6V16M21.5 8.4V16.5M25 12V19M9.4 21L6.6 17.8",
  "M8.6 15.5H26.8V21C26.8 25 24 27.8 20.4 27.8H15.8C13.8 27.8 12.2 27 11 25.4L7.8 20.8Z",
  old.crease("M12.25 12V16.8M15.95 9V16.4M19.65 9.4V16.4M23.25 12.2V17"),
);
const GRABBING = hand(
  "M10.8 13.6V17M14.4 12.2V16M18 12V16M21.6 12.4V16.4M25 14.2V19",
  "M9 14.8H26.8V21C26.8 25 24 27.4 20.4 27.4H15.8C13.8 27.4 12.2 26.8 11 25.2L8 21Z",
  old.crease("M12.6 12.6V16.6M16.2 12V16.2M19.8 12.2V16.4M23.3 13.2V17"),
);

// ── Angle-following art (centred on 12, 12) ──────────────────────────────────

/** A double-headed arrow along +x, centred on (12, 12). */
const doubleArrow = (reach = 9, head = 4.2, spread = 4, shaft = 0.95): string => {
  const l = 12 - reach;
  const r = 12 + reach;
  return solid(
    `M${l} 12L${l + head} ${12 - spread}V${12 - shaft}H${r - head}V${12 - spread}L${r} 12L${r - head} ${12 + spread}V${12 + shaft}H${l + head}V${12 + spread}Z`,
  );
};

const RESIZE = doubleArrow();
/** A 3D translate handle: slimmer, with a hollow centre so it never reads as resize. */
const MOVE_AXIS =
  doubleArrow(9, 3.8, 3.4, 0.8) + `<circle cx='12' cy='12' r='3.3' fill='${KEY}'/><circle cx='12' cy='12' r='2.3' fill='${INK}'/>`;

/** A point on the rotate cursor's arc, about its centre at (4.5, 12). */
const arcPoint = (r: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [round(4.5 + r * Math.cos(a)), round(12 + r * Math.sin(a))];
};

/**
 * An orbit around the selection's corner: an arc concave toward the box, a head
 * at each end. Drawn pointing out along +x, so `rotate(bearing)` aims it.
 */
const ROTATE_ART = (() => {
  const R = 7.5;
  const SWEEP = 58;
  const [ax, ay] = arcPoint(R, -SWEEP);
  const [bx, by] = arcPoint(R, SWEEP);
  const head = (sign: 1 | -1): string => {
    const tip = arcPoint(R, sign * (SWEEP + 27));
    const w0 = arcPoint(R - 3.5, sign * SWEEP);
    const w1 = arcPoint(R + 3.5, sign * SWEEP);
    return `M${tip[0]} ${tip[1]}L${w0[0]} ${w0[1]}L${w1[0]} ${w1[1]}Z`;
  };
  return line(`M${ax} ${ay}A${R} ${R} 0 0 1 ${bx} ${by}`, 1.8, "butt") + solid(head(1) + head(-1));
})();

// ── Timeline (legacy 32 grid) ────────────────────────────────────────────────

const COL_RESIZE = legacy(
  old.line("M15.5 6V25", 1.5, "butt") +
    old.solid("M5 15.5L10.5 11V20Z") +
    old.solid("M26 15.5L20.5 11V20Z") +
    old.line("M9 15.5H13.5M22 15.5H17.5", 1.5, "butt"),
);
const bracket = (x: number, dir: 1 | -1): string => old.line(`M${x + dir * 4} 6.5H${x}V24.5H${x + dir * 4}`, 1.8, "butt");
const trimArrows = (cx: number): string =>
  old.line(`M${cx - 6} 15.5H${cx + 6}`, 1.5, "butt") + old.solid(`M${cx - 9} 15.5L${cx - 5} 12V19Z`) + old.solid(`M${cx + 9} 15.5L${cx + 5} 12V19Z`);

// ── The set ──────────────────────────────────────────────────────────────────

/** I-beam on the half-pixel so its 1px stem is crisp. */
const IBEAM = "M8.5 4.5C9.8 4.5 10.9 4.8 11.5 5.8C12.1 4.8 13.2 4.5 14.5 4.5M8.5 19.5C9.8 19.5 10.9 19.2 11.5 18.2C12.1 19.2 13.2 19.5 14.5 19.5M11.5 5.8V18.2";
const CROSS = "M11.5 3V9M11.5 14V20M3 11.5H9M14 11.5H20";
const MAGNIFIER = line("M14.4 14.4L20 20", 2.6) + line(ring(10, 10, 5.8), 1.5);

const STATIC = {
  arrow: [ARROW, 4, 3, "default"],
  pointer: [POINTER, 10, 2, "pointer"],
  text: [line(IBEAM, 1), 11, 12, "text"],
  /** The I-beam with a wave under it: writing onto a curve. */
  textOnPath: [
    line("M8.5 2.5C9.8 2.5 10.9 2.8 11.5 3.8C12.1 2.8 13.2 2.5 14.5 2.5M8.5 14.5C9.8 14.5 10.9 14.2 11.5 13.2C12.1 14.2 13.2 14.5 14.5 14.5M11.5 3.8V13.2", 1) +
      line("M4.5 20C6.8 17 9 17 11.6 19.6C14.2 22.2 16.5 21.8 18.8 19.2", 1.3),
    11, 8, "text",
  ],
  grab: [GRAB, 12, 10, "grab"],
  grabbing: [GRABBING, 12, 11, "grabbing"],
  move: [
    solid("M12 2.5L15.4 6.5H13V11H17.5V8.6L21.5 12L17.5 15.4V13H13V17.5H15.4L12 21.5L8.6 17.5H11V13H6.5V15.4L2.5 12L6.5 8.6V11H11V6.5H8.6Z"),
    12, 12, "move",
  ],
  crosshair: [line(CROSS, 1, "butt"), 11, 11, "crosshair"],
  /** Places something new: the crosshair with a plus beside it. */
  crosshairAdd: [line("M9.5 3V7.5M9.5 11.5V16M3 9.5H7.5M11.5 9.5H16", 1, "butt") + badges.plus(...AB), 9, 9, "crosshair"],
  ...Object.fromEntries(Object.entries(pen).map(([k, art]) => [k, [art, 4, 3, "crosshair"]])) as unknown as {
    [K in keyof typeof pen]: readonly [string, number, number, string];
  },
  /** ⌘ held in vector edit: drag any point of a segment to bend the curve. */
  bend: [ARROW + badges.bend(...AB), 4, 3, "default"],
  /** A shape's corner-radius handle. Replaces the hand that used to show there. */
  cornerRadius: [ARROW + badges.arc(...AB), 4, 3, "default"],
  /** ⌥-drag duplicates. */
  copy: [ARROW + badges.plus(...AB), 4, 3, "copy"],
  /** Follow a link or make one. */
  link: [ARROW + badges.link(...AB), 4, 3, "alias"],
  help: [ARROW + badges.help(...AB), 4, 3, "help"],
  notAllowed: [line(`${ring(12, 12, 6.5)}M7.4 7.4L16.6 16.6`, 1.8), 12, 12, "not-allowed"],
  /** Scissors, open, tips meeting on the hotspot: cut a path at a point. */
  scissors: [
    line("M4.5 6L12.5 12.5L14 15.6M6 4.5L12.5 12.5L15.6 14", 1.4) +
      line(ring(15.4, 18, 2.4) + ring(18, 15.4, 2.4), 1.4),
    5, 5, "crosshair",
  ],
  /** A blade, for cutting through a path or mesh along a stroke. */
  knife: [
    legacy(old.solid("M4.5 27.5L18 8.5C19 7 21 6.6 22.4 7.6L24.4 9C25.8 10 26 12 25 13.2L16.4 18.8Z") + old.line("M22.8 6.4L26 2.8", 2.6)),
    3, 21, "crosshair",
  ],
  /** A round brush, tip on the hotspot. */
  brush: [
    legacy(
      old.line("M15.6 16.4L26.6 5.4", 2.4) +
        old.solid("M12.4 13.6L18.4 19.6L16.2 21.6C15.2 22.6 14.4 23 13.4 23L5 27C7.6 23.4 9 21 9 18.6C9 17.6 9.4 16.6 10.4 15.6Z"),
    ),
    4, 20, "crosshair",
  ],
  eraser: [
    legacy(old.solid("M5.5 21.5L18.5 8.5C19.5 7.5 21 7.5 22 8.5L27.5 14C28.5 15 28.5 16.5 27.5 17.5L18 27H11Z") + old.crease("M12 15.2L20.8 24")),
    8, 20, "crosshair",
  ],
  /** The pipette, tip on the hotspot. */
  eyedropper: [
    line("M3.5 20.5L4.8 17.4L12.6 9.6", 2) +
      solid("M11 6.8L17.2 13L15.6 14.4L9.6 8.4Z") +
      solid("M14 6.4L17 3.4C18.1 2.3 19.7 2.3 20.6 3.2C21.5 4.1 21.5 5.7 20.4 6.8L17.4 9.8Z"),
    3, 20, "crosshair",
  ],
  /** The paint bucket, pouring; the drop's foot is the hotspot. */
  fill: [
    solid("M10 3.5L18.5 12L10.6 19.9L2.1 11.4Z") + crease("M4.4 11.4H16.2") + line("M10 3.5V7.5", 1.3) +
      solid("M20 13.4C21.4 15.4 22 16.6 22 17.6A2 2 0 0 1 18 17.6C18 16.6 18.6 15.4 20 13.4Z"),
    20, 19, "cell",
  ],
  zoomIn: [MAGNIFIER + line("M7.4 10H12.6M10 7.4V12.6", 1.2, "butt"), 10, 10, "zoom-in"],
  zoomOut: [MAGNIFIER + line("M7.4 10H12.6", 1.2, "butt"), 10, 10, "zoom-out"],
  /** The timeline's seam: moves the cut between two neighbours (roll). */
  colResize: [COL_RESIZE, 12, 12, "col-resize"],
  rowResize: [`<g transform='rotate(90 11.625 11.625)'>${COL_RESIZE}</g>`, 12, 12, "row-resize"],
  /** A clip's in point. The bracket opens toward the clip. */
  trimStart: [legacy(bracket(10.5, 1) + trimArrows(19.5)), 8, 12, "ew-resize"],
  trimEnd: [legacy(bracket(20.5, -1) + trimArrows(11.5)), 15, 12, "ew-resize"],
  /** Slide what is inside a block without moving its edges. */
  slip: [legacy(bracket(3.5, 1) + bracket(27.5, -1) + trimArrows(15.5)), 12, 12, "ew-resize"],
  /** Turning the 3D view: two tilted orbits. */
  orbit: [
    `<g transform='rotate(-32 12 12)'>${line(ring(12, 12, 9, 3.9), 1.2)}</g><g transform='rotate(58 12 12)'>${line(ring(12, 12, 9, 3.9), 1.2)}</g>` +
      `<circle cx='12' cy='12' r='2.2' fill='${INK}' stroke='${KEY}' stroke-width='1'/>`,
    12, 12, "grabbing",
  ],
} as const satisfies Record<string, readonly [art: string, x: number, y: number, keyword: string]>;

export type CursorName = keyof typeof STATIC;

// ── Scale ────────────────────────────────────────────────────────────────────

/** The cursor-size preference (Settings owns the control; this is the seam). */
export type CursorSize = "small" | "default" | "large";
export const CURSOR_SIZES: Readonly<Record<CursorSize, number>> = { small: 0.85, default: 1, large: 1.3 };

/** The pure input: UI scale times the size preference. */
export const cursorScale = ({ uiScale = 1, size = "default" }: { uiScale?: number; size?: CursorSize } = {}): number => {
  const s = (Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1) * (CURSOR_SIZES[size] ?? 1);
  return Math.round(s * 100) / 100;
};

/** The emitted box in px: 24 × scale, clamped to [16, 32] (Chromium drops >32 at window edges). */
export const cursorPixels = (scale: number): number => Math.max(16, Math.min(32, Math.round(BOX * (Number.isFinite(scale) ? scale : 1))));

/** The escapes a data URL inside a double-quoted CSS `url()` needs, and no more. */
const encode = (s: string): string =>
  s.replace(/%/g, "%25").replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/"/g, "%22");

/** The SVG document for a piece of art at a pixel size. */
export const cursorSvg = (art: string, px = BOX): string =>
  `<svg xmlns='http://www.w3.org/2000/svg' width='${px}' height='${px}' viewBox='0 0 ${BOX} ${BOX}'>${art}</svg>`;

const declare = (art: string, x: number, y: number, keyword: string, scale: number): string => {
  const px = cursorPixels(scale);
  const k = px / BOX;
  return `url("data:image/svg+xml,${encode(cursorSvg(art, px))}") ${Math.round(x * k)} ${Math.round(y * k)}, ${keyword}`;
};

/** Every fixed cursor at a scale. Pure. */
export function cursorSet(scale = 1): Record<CursorName, string> {
  return Object.fromEntries(
    (Object.entries(STATIC) as Array<[CursorName, (typeof STATIC)[CursorName]]>).map(([name, [art, x, y, keyword]]) => [
      name,
      declare(art, x, y, keyword, scale),
    ]),
  ) as Record<CursorName, string>;
}

/** The raw art and hotspot of a fixed cursor — for the contact sheet and tests. */
export const cursorArt = (name: CursorName): { art: string; x: number; y: number; keyword: string } => {
  const [art, x, y, keyword] = STATIC[name];
  return { art, x, y, keyword };
};
export const CURSOR_NAMES = Object.keys(STATIC) as CursorName[];

let currentScale = 1;

/**
 * Every fixed cursor, by name, at the current scale. Each value is a complete CSS
 * `cursor` declaration. Read it at use time (a handler, a render): `setCursorScale`
 * refills it in place.
 */
export const cursors: Readonly<Record<CursorName, string>> = cursorSet(1);

const wrap = (deg: number, range: number): number => ((Math.round(deg) % range) + range) % range;
const turned = (art: string, deg: number): string => (deg === 0 ? art : `<g transform='rotate(${deg} 12 12)'>${art}</g>`);
const RESIZE_KEYWORDS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

const caches: Array<Map<number, string>> = [];
const cachedByDegree = (range: number, build: (deg: number) => string): ((deg: number) => string) => {
  const cache = new Map<number, string>();
  caches.push(cache);
  return (raw) => {
    const deg = wrap(Number.isFinite(raw) ? raw : 0, range);
    let value = cache.get(deg);
    if (!value) {
      value = build(deg);
      cache.set(deg, value);
    }
    return value;
  };
};

/** The arrow's two ends are the same, so 0 and 180 are one cursor. */
const axisKeyword = (deg: number): string => RESIZE_KEYWORDS[Math.round(deg / 45) % 4]!;

/** Resize along a screen axis: the edge's normal, or the corner's outward bisector. */
export const resizeCursor = cachedByDegree(180, (deg) => declare(turned(RESIZE, deg), 12, 12, axisKeyword(deg), currentScale));
/** Rotate, with the arc wrapped around a corner whose outward bearing is `bearingDeg`. */
export const rotateCursor = cachedByDegree(360, (deg) => declare(turned(ROTATE_ART, deg), 12, 12, "grab", currentScale));
/** Translate along one projected axis, a 3D gizmo's arrow. */
export const moveAxisCursor = cachedByDegree(180, (deg) => declare(turned(MOVE_AXIS, deg), 12, 12, "move", currentScale));

/** The art behind the angle-following cursors, for the contact sheet. */
export const angledArt = (kind: "resize" | "rotate" | "moveAxis", deg: number): string =>
  turned(kind === "resize" ? RESIZE : kind === "rotate" ? ROTATE_ART : MOVE_AXIS, wrap(deg, 360));

/** The screen bearing of a drag direction, in the degrees the cursors above take. */
export const bearingOf = (dx: number, dy: number): number => (Math.atan2(dy, dx) * 180) / Math.PI;

/** The custom property behind a fixed cursor, which `cursors.css` reads. */
const variableOf = (name: string): string => `--cursor-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * The set as CSS custom properties, for a root layout to inline (or for
 * `setCursorScale` to re-emit). `cursors.css` turns Tailwind's cursor utilities
 * and the page defaults into reads of these, with the plain keyword as the
 * fallback, so a device with no fine pointer gets exactly the browser's behaviour.
 */
export function cursorVariables(names: readonly CursorName[] = CURSOR_NAMES, scale = currentScale): string {
  const set = scale === currentScale ? cursors : cursorSet(scale);
  const body = names.map((name) => `${variableOf(name)}:${set[name]}`).join(";");
  const axes: Array<[string, number]> = [["ew", 0], ["nwse", 45], ["ns", 90], ["nesw", 135]];
  const resize = axes
    .map(([name, deg]) => `--cursor-${name}-resize:${scale === currentScale ? resizeCursor(deg) : declare(turned(RESIZE, deg), 12, 12, axisKeyword(deg), scale)}`)
    .join(";");
  return `@media (any-pointer:fine){:root{${body};${resize}}}`;
}

const STYLE_ID = "cursor-scale";

/**
 * Re-draw every cursor at `scale` (from `cursorScale`): refills `cursors`, drops
 * the angle caches, and — in a browser — re-emits the CSS variables in a style
 * tag that wins over the one the layout inlined. A no-op when nothing changed.
 */
export function setCursorScale(scale: number): void {
  const next = Number.isFinite(scale) && scale > 0 ? Math.round(scale * 100) / 100 : 1;
  if (cursorPixels(next) === cursorPixels(currentScale) && next === currentScale) return;
  currentScale = next;
  Object.assign(cursors as Record<CursorName, string>, cursorSet(next));
  for (const c of caches) c.clear();
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = cursorVariables(CURSOR_NAMES, next);
}

/** The scale the set is drawn at now. */
export const currentCursorScale = (): number => currentScale;

let lastUiScale = 1;
let lastSize: CursorSize = "default";
/**
 * The two inputs, remembered separately so the theme (UI scale) and Settings
 * (cursor size) can each set theirs without knowing the other.
 */
export function applyCursorPrefs(prefs: { uiScale?: number; size?: CursorSize }): void {
  if (prefs.uiScale !== undefined) lastUiScale = prefs.uiScale;
  if (prefs.size !== undefined) lastSize = prefs.size;
  setCursorScale(cursorScale({ uiScale: lastUiScale, size: lastSize }));
}

/** What the marketing site uses, so it does not inline the whole editor's set. */
export const SITE_CURSORS: readonly CursorName[] = ["arrow", "pointer", "text", "grab", "grabbing", "crosshair", "notAllowed", "move", "help", "copy", "colResize", "rowResize"];
