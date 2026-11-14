"use client";

import * as React from "react";
import { pointerEnv } from "./pointer-env";
import { isPrintableKey } from "../state/shortcut-registry";
import { isTypingFocused } from "./typing-target";

/**
 * AUTOFOCUS THAT DOES NOT SUMMON A KEYBOARD.
 *
 * `autoFocus` on a search field is right on a desktop and wrong on a tablet,
 * and it is wrong there in a way that is hard to recover from: opening the
 * effects picker, the node menu or New Project threw the on-screen keyboard up
 * over half the surface before a single item had been seen, and the first
 * thing you had to do was dismiss it to look at the list you came for.
 *
 * The fix is not "no autofocus" — that would cost the desktop a real
 * convenience for a problem it does not have. It is to notice that autofocus
 * is standing in for two different things:
 *
 *   · SO THAT TYPING SEARCHES. Reachable without focus: listen for the first
 *     printable key and focus THEN, letting that keystroke land in the field
 *     as its first character.
 *   · so that the caret is where you are about to type. Only true when typing
 *     is what you came to do.
 *
 * So a field you came to TYPE IN (rename, a name field, an expression) keeps
 * `autoFocus`. A SEARCH or FILTER field beside a list gets this instead: no
 * caret, no keyboard, and typing still searches from the first letter.
 *
 * On a device with a real keyboard nothing changes — it focuses on mount
 * exactly as before, because there is no keyboard to summon and the caret
 * costs nothing.
 *
 * (The pattern is not new here: `FramePresets` worked this out for the New
 * Project dialog and hand-rolled it. This is that behaviour extracted so the
 * other fifteen pickers get it without fifteen copies.)
 */

/** Would focusing a text field raise a soft keyboard over the UI? */
export function softKeyboardLikely(): boolean {
  // The pointer you navigate with is coarse — a tablet or a phone. A laptop
  // with a touchscreen and a Surface with its keyboard attached both report a
  // fine primary pointer and correctly keep the caret.
  return pointerEnv().primaryCoarse;
}

/**
 * Focus `ref` on mount, or — where that would raise a keyboard — on the first
 * printable keystroke instead.
 *
 * Pass `enabled` through from the caller's `autoFocus` prop, so the decision
 * about WHETHER to focus stays with the call site and only the HOW lives here.
 */
export function useTypeToFocus(
  ref: React.RefObject<HTMLElement | null>,
  enabled = true,
): void {
  React.useEffect(() => {
    if (!enabled) return;
    if (!softKeyboardLikely()) {
      ref.current?.focus();
      return;
    }

    const onKey = (e: KeyboardEvent) => {
      // A chord is a command, not typing. Non-printable keys (arrows, Escape,
      // Tab) belong to whatever owns the list.
      if (!isPrintableKey(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      // Something else is already taking text — never steal it.
      if (isTypingFocused()) return;
      const el = ref.current;
      if (!el) return;
      // Focus WITHOUT `preventDefault`, so the keystroke that triggered this
      // lands in the field as its first character. Swallowing it makes you
      // type the first letter twice, which is worse than not focusing at all.
      el.focus();
      window.removeEventListener("keydown", onKey);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref, enabled]);
}
