"use client";

/**
 * Some icon sets ship ANIMATED bodies — Material Line Icons (`line-md`) is
 * built of SMIL `<animate>` elements that draw each stroke on when the SVG
 * mounts. That is the set's animation, not ours: it replays every time a tile
 * scrolls back into view, it runs on the canvas whether or not the layer has
 * an entrance, and it cannot be timed, eased or exported. So a body is
 * SETTLED before it is shown or imported: every animation element is removed
 * and the attribute it drove is left at its final value. The layer then
 * animates exactly as the Animate tab says — Draw On or nothing.
 */

const ANIMATION_TAGS = ["animate", "animateTransform", "animateMotion", "set"];

/** True when the markup carries anything to settle — the cheap gate. */
export function svgIsAnimated(markup: string): boolean {
  return /<(animate|animateTransform|animateMotion|set)\b/.test(markup) || /@keyframes/.test(markup);
}

/** The markup with its animations resolved to their end state. */
export function settleSvg(markup: string): string {
  if (!svgIsAnimated(markup) || typeof DOMParser === "undefined") return markup;
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || doc.querySelector("parsererror")) return markup;
  for (const tag of ANIMATION_TAGS) {
    for (const el of Array.from(root.getElementsByTagName(tag))) {
      const parent = el.parentElement;
      const name = el.getAttribute("attributeName");
      const final = finalValue(el);
      if (parent && name && final !== null && tag !== "animateMotion" && tag !== "animateTransform") {
        parent.setAttribute(name, final);
      }
      el.remove();
    }
  }
  // A `<style>` that only exists to run keyframes has nothing left to do.
  for (const style of Array.from(root.getElementsByTagName("style"))) {
    if (/@keyframes/.test(style.textContent ?? "")) style.remove();
  }
  return new XMLSerializer().serializeToString(root);
}

/** Where an animation ends: `to`, else the last of `values`. */
function finalValue(el: Element): string | null {
  const to = el.getAttribute("to");
  if (to !== null) return to;
  const values = el.getAttribute("values");
  if (values !== null) {
    const parts = values.split(";").map((v) => v.trim()).filter(Boolean);
    return parts[parts.length - 1] ?? null;
  }
  return null;
}
