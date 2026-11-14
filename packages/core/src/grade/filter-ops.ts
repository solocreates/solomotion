/**
 * FILTER OPS — the CSS filter functions the renderer uses, as DATA.
 *
 * The renderer used to write `ctx.filter = "blur(4px) brightness(1.2)"` at
 * every seam that wanted one. WebKit accepts that assignment, reads it back,
 * and draws unfiltered — so on every iPad browser a blur, an adjust, a glow's
 * bloom or a second drop shadow was simply absent, with nothing to search for.
 * A string is the wrong shape: it can only be handed to the one engine that
 * understands it.
 *
 * As a list of ops the same request has two executors: the GPU's own filter
 * (via `filterCss`) where the engine honours it, and a CPU one (box blur plus
 * the colour matrices below, straight from the Filter Effects spec) where it
 * does not. One description, so both agree on what "saturate 1.4" means.
 */

export type FilterOp =
  | { kind: "blur"; px: number }
  | { kind: "dropShadow"; x: number; y: number; blur: number; color: string }
  | { kind: "brightness"; amount: number }
  | { kind: "contrast"; amount: number }
  | { kind: "saturate"; amount: number }
  | { kind: "hueRotate"; deg: number }
  | { kind: "grayscale"; amount: number }
  | { kind: "sepia"; amount: number };

/** The CSS `filter` string for these ops — the GPU executor's input. */
export function filterCss(ops: readonly FilterOp[]): string {
  if (ops.length === 0) return "none";
  return ops
    .map((op) => {
      switch (op.kind) {
        case "blur":
          return `blur(${op.px}px)`;
        case "dropShadow":
          return `drop-shadow(${op.x}px ${op.y}px ${op.blur}px ${op.color})`;
        case "brightness":
          return `brightness(${op.amount})`;
        case "contrast":
          return `contrast(${op.amount})`;
        case "saturate":
          return `saturate(${op.amount})`;
        case "hueRotate":
          return `hue-rotate(${op.deg}deg)`;
        case "grayscale":
          return `grayscale(${op.amount})`;
        case "sepia":
          return `sepia(${op.amount})`;
      }
    })
    .join(" ");
}

/** Ops that do nothing are dropped, so an idle card costs no pass on either executor. */
export function isIdentityFilterOp(op: FilterOp): boolean {
  switch (op.kind) {
    case "blur":
      return op.px <= 0.05;
    case "dropShadow":
      return false;
    case "brightness":
    case "contrast":
    case "saturate":
      return Math.abs(op.amount - 1) < 1e-4;
    case "hueRotate":
      return Math.abs(op.deg % 360) < 1e-4;
    case "grayscale":
    case "sepia":
      return op.amount <= 1e-4;
  }
}

/**
 * A colour op as an affine map on NON-premultiplied RGB in 0..1:
 * `out = M · rgb + b`, clamped after each op exactly as each CSS filter
 * function is its own clamped primitive. Null for the ops that are not
 * per-pixel colour (blur, drop shadow).
 */
export interface ColorAffine {
  /** Row-major 3×3. */
  m: [number, number, number, number, number, number, number, number, number];
  b: [number, number, number];
}

export function colorAffineOf(op: FilterOp): ColorAffine | null {
  switch (op.kind) {
    case "brightness": {
      const a = Math.max(0, op.amount);
      return { m: [a, 0, 0, 0, a, 0, 0, 0, a], b: [0, 0, 0] };
    }
    case "contrast": {
      const a = Math.max(0, op.amount);
      const o = 0.5 - 0.5 * a;
      return { m: [a, 0, 0, 0, a, 0, 0, 0, a], b: [o, o, o] };
    }
    case "saturate": {
      const s = Math.max(0, op.amount);
      return {
        m: [
          0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
          0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
          0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
        ],
        b: [0, 0, 0],
      };
    }
    case "hueRotate": {
      const r = (op.deg * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      return {
        m: [
          0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
          0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
          0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
        ],
        b: [0, 0, 0],
      };
    }
    case "grayscale": {
      const s = 1 - Math.min(1, Math.max(0, op.amount));
      return {
        m: [
          0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s,
          0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s,
          0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s,
        ],
        b: [0, 0, 0],
      };
    }
    case "sepia": {
      const s = 1 - Math.min(1, Math.max(0, op.amount));
      return {
        m: [
          0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s,
          0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s,
          0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s,
        ],
        b: [0, 0, 0],
      };
    }
    default:
      return null;
  }
}

/**
 * Run a run of colour affines over RGBA bytes in place (non-premultiplied, as
 * ImageData is). Each affine clamps before the next — the CSS chain's rule.
 */
export function applyColorAffines(data: Uint8ClampedArray, affines: readonly ColorAffine[]): void {
  if (affines.length === 0) return;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    let r = data[i]! / 255;
    let g = data[i + 1]! / 255;
    let b = data[i + 2]! / 255;
    for (const { m, b: o } of affines) {
      const nr = m[0] * r + m[1] * g + m[2] * b + o[0];
      const ng = m[3] * r + m[4] * g + m[5] * b + o[1];
      const nb = m[6] * r + m[7] * g + m[8] * b + o[2];
      r = nr < 0 ? 0 : nr > 1 ? 1 : nr;
      g = ng < 0 ? 0 : ng > 1 ? 1 : ng;
      b = nb < 0 ? 0 : nb > 1 ? 1 : nb;
    }
    data[i] = r * 255;
    data[i + 1] = g * 255;
    data[i + 2] = b * 255;
  }
}
