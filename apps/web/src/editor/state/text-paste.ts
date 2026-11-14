"use client";

import { isTypingTarget } from "../input/typing-target";
import { clipboardPlainText } from "./clip-actions";

/**
 * EVERY TEXT FIELD PASTES WORDS, never the app's clipboard JSON.
 *
 * One capture-phase listener for the whole document rather than an `onPaste`
 * per field: the inspector's inputs, the canvas text editor, a dialog's name
 * box and fields nobody has written yet all take the same route, so none of
 * them can forget. Only a paste whose text is one of OUR payloads is touched
 * (`clipboardPlainText`); anything else is left to the field, untouched.
 */
export function installTextPaste(): () => void {
  const onPaste = (e: ClipboardEvent) => {
    if (!isTypingTarget(e.target)) return;
    const raw = e.clipboardData?.getData("text/plain") ?? "";
    const plain = clipboardPlainText(raw);
    if (plain === raw) return;
    e.preventDefault();
    e.stopPropagation();
    // `insertText` is the paste the field would have done itself: it lands at
    // the caret, replaces the selection, fires `input` (so React sees it) and
    // is one step of the field's own undo — for inputs and contenteditables alike.
    if (plain) document.execCommand("insertText", false, plain);
  };
  window.addEventListener("paste", onPaste, true);
  return () => window.removeEventListener("paste", onPaste, true);
}
