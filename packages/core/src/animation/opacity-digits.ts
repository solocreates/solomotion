/**
 * The Photoshop / Figma / After Effects digit gesture for opacity: with layers
 * selected, tapping a number key sets their alpha. One digit is tens (`5` →
 * 50%), and a second digit typed quickly refines it to an exact value (`5`
 * then `2` → 52%). `0` alone means 100% — the "put it back" key — while `00`
 * means fully transparent.
 *
 * It is a tiny state machine and it belongs here, not in a keydown handler:
 * the same rule has to serve the shortcut dispatcher, a future numeric HUD and
 * any test, and "how long counts as quickly" must have exactly one answer.
 *
 * Usage: keep one `OpacityDigitBuffer` per surface, feed it every digit, and
 * write `result.percent`. The buffer decides on its own whether the keystroke
 * starts a new value or extends the one before it.
 */

/** How long a second digit may lag behind the first and still join it (ms). */
export const OPACITY_DIGIT_WINDOW_MS = 900;

export interface OpacityDigitBuffer {
  /** The digits typed so far in the current run, "" when idle. */
  readonly digits: string;
  /** When the last digit landed, in ms on the caller's clock. */
  readonly atMs: number;
}

export const emptyOpacityDigits: OpacityDigitBuffer = { digits: "", atMs: -Infinity };

export interface OpacityDigitResult {
  /** The opacity to write, 0..100. */
  readonly percent: number;
  /** Feed this back in as the buffer for the next keystroke. */
  readonly next: OpacityDigitBuffer;
}

/**
 * Fold one digit into the buffer and read off the opacity it means.
 *
 * The rules, in the order they apply:
 *   • Outside the window, or once two digits have already landed, the digit
 *     starts a fresh run.
 *   • A lone digit d is d × 10 — except `0`, which is 100 (the reset).
 *   • A second digit makes the pair literal: `0`+`5` = 5, `2`+`5` = 25,
 *     `0`+`0` = 0, `1`+`0` = 10.
 *
 * `1` then `0` giving 10 rather than 100 is deliberate and is what both
 * Photoshop and Figma do — `0` on its own is how you get back to 100.
 */
export function pushOpacityDigit(
  buffer: OpacityDigitBuffer,
  digit: string,
  nowMs: number,
): OpacityDigitResult | null {
  if (!/^[0-9]$/.test(digit)) return null;

  const continuing =
    buffer.digits.length === 1 && nowMs - buffer.atMs <= OPACITY_DIGIT_WINDOW_MS;
  const digits = continuing ? buffer.digits + digit : digit;

  // A two-digit run is the literal number; a lone digit is tens, and 0 is the
  // "back to opaque" key rather than "invisible" (which is `00`).
  const percent = digits.length === 2 ? Number(digits) : digit === "0" ? 100 : Number(digit) * 10;

  return { percent, next: { digits, atMs: nowMs } };
}

/** True when `key` is a plain digit the gesture should claim. */
export function isOpacityDigitKey(key: string): boolean {
  return key.length === 1 && key >= "0" && key <= "9";
}
