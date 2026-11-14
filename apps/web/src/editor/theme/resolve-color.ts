/**
 * A CSS colour → `#rrggbb[aa]`, as the browser itself resolves it.
 *
 * Theme tones are DERIVED (`color-mix(in oklab, …)`), which is right for CSS
 * and useless to code that paints with a hex: a canvas ruler, the 3D world's
 * clear colour, a brush thumbnail. Rather than re-implement colour mixing in
 * JS (a second answer to "what colour is the stage?" that would drift), ask the
 * browser: set the colour on a probe, let it compute, paint one pixel, read it.
 */
let probe: HTMLSpanElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

export function resolveCssColor(value: string, fallback = "#000000"): string {
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return value.toLowerCase();
  if (typeof document === "undefined") return fallback;
  try {
    if (!probe) {
      probe = document.createElement("span");
      probe.style.display = "none";
      document.body.appendChild(probe);
    }
    if (!ctx) ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx) return fallback;
    probe.style.color = "";
    probe.style.color = value;
    const computed = getComputedStyle(probe).color;
    if (!computed) return fallback;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = computed;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
    // getImageData is un-premultiplied, so a 7% hairline keeps its hue.
    const rgb = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
    return a >= 255 ? rgb : `${rgb}${hex2(a)}`;
  } catch {
    return fallback;
  }
}
