import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge has to be TOLD about the design system's own utilities.
 *
 * It decides which classes conflict from names it knows. `text-meta`,
 * `text-body`, `text-title` (the v5 redesign type scale) and `text-2xs` are not
 * Tailwind defaults, so it filed them under "text COLOUR" — the catch-all for
 * an unknown `text-*` — and `cn("text-body text-fg-muted")` kept only the
 * colour. The size silently vanished at every call site that set both, which
 * is every call site. Same for the v4 variable shorthand `h-(--control-h)`:
 * unknown, so a caller's `h-6` could never override it.
 */
const isCssVar = (v: string) => /^\(--[\w-]+(,.+)?\)$/.test(v);

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["3xs", "2xs", "meta", "body", "label", "title", "heading", "display"] }],
      h: [{ h: [isCssVar] }],
      w: [{ w: [isCssVar] }],
      size: [{ size: [isCssVar] }],
      "min-w": [{ "min-w": [isCssVar] }],
      "min-h": [{ "min-h": [isCssVar] }],
      "max-w": [{ "max-w": [isCssVar] }],
      "max-h": [{ "max-h": [isCssVar] }],
    },
  },
});

/** Merge conditional class names, de-duplicating conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
