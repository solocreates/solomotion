import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * THE key-hint visual. One definition, so a combo looks identical wherever it
 * appears — menubar, context menus, dropdowns, tooltips, the command palette.
 *
 * It used to be re-declared per menu primitive (`ContextMenuShortcut`,
 * `DropdownMenuShortcut`, `MenubarShortcut`) in a monospace face with wide
 * tracking, which turned "⇧⌘L" into a smeared row of boxes and made ⌫ almost
 * invisible. Glyph combos are TYPOGRAPHY, not code: the UI face renders ⌘⇧⌥
 * correctly, tabular numerals keep the column steady, and `pl-6` guarantees a
 * gap so a long label never touches its hint.
 *
 * `ml-auto` is what right-aligns it inside a menu row — the caller just drops
 * it in as the last child.
 */
export function Kbd({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "ml-auto shrink-0 pl-6 text-meta tabular-nums text-fg-faint transition-colors group-focus/mi:text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A hint that is a GESTURE, not a key ("double-click", "⌥-drag"). Same slot and
 * rhythm as `Kbd`, deliberately softer — you should be able to tell at a glance
 * which hints you can press and which you have to perform.
 */
export function GestureHint({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <Kbd
      className={cn("italic text-fg-faint", className)}
      {...props}
    />
  );
}

/** The glyphs that are their own key. Everything after them is one more cap. */
const MODIFIERS = new Set(["⌘", "⇧", "⌥", "⌃", "^"]);

/**
 * Split a formatted combo into its keys: "⇧⌘L" → ["⇧", "⌘", "L"], "⌘Space" →
 * ["⌘", "Space"]. Modifiers are single glyphs by construction (see
 * `formatCombo`), so the first non-modifier starts the final key — which is why
 * multi-character keys like Space, Esc and Enter survive intact.
 */
export function splitCombo(combo: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < combo.length && MODIFIERS.has(combo[i]!)) {
    keys.push(combo[i]!);
    i += 1;
  }
  const rest = combo.slice(i).trim();
  if (rest) keys.push(rest);
  return keys;
}

/**
 * A combo as individual KEY CAPS rather than one wide pill.
 *
 * A single pill containing "⇧⌘L" is a string; three caps are three keys, which
 * is what you actually have to press — and it is the convention every OS
 * settings pane and every serious editor uses. The caps wear `material-chip`,
 * the neutral sibling of the armed `material-glass-raised`, so a keycap and a
 * selected tab are visibly the same material at two different jobs.
 */
export function KeyCaps({
  combo,
  className,
  ...props
}: { combo: string } & Omit<React.ComponentProps<"span">, "children">) {
  const keys = splitCombo(combo);
  if (!keys.length) return null;
  return (
    <span className={cn("inline-flex items-center gap-1", className)} {...props}>
      {keys.map((k, i) => (
        <kbd
          key={`${k}-${i}`}
          className={cn(
            "material-chip inline-flex items-center justify-center rounded-xs px-1.5 text-meta font-medium tabular-nums text-fg-muted",
            // Square for a single glyph, wider for a word — a "Space" cap and a
            // "⌘" cap should not be the same width.
            k.length === 1 ? "size-5" : "h-5 min-w-5",
          )}
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
