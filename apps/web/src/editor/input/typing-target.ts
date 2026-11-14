/**
 * IS THE USER TYPING? — one predicate, one place.
 *
 * Every keyboard owner in the app has to answer this before it may claim a
 * key: the global shortcuts, the node board, the media library, the vector
 * overlay, the drawing overlay, the file manager, the variables table. It was
 * written TEN times, and the copies had already drifted — most tested
 * `e.target`, some tested `document.activeElement`, one tested only for
 * `INPUT` and only for Backspace.
 *
 * That last one is the bug this exists to make unrepresentable. The variables
 * table claimed ⌘A / ⌘C / ⌘V / ⌘D from its own container and only checked for a
 * field on Delete — so renaming a variable, the one thing every row's input is
 * there for, could not select its own text: `preventDefault` reached the field
 * before the browser did. A guard remembered for one key out of five is not a
 * guard, it is a coincidence.
 *
 * `[data-capture-keys]` is the opt-IN seam: a control that deliberately eats
 * raw keystrokes (the shortcut recorder) marks itself and counts as typing, so
 * even Space reaches it.
 */

/** True when `node` is — or sits inside — something that owns keystrokes. */
export function isTypingTarget(node: EventTarget | null | undefined): boolean {
  const el = node as HTMLElement | null | undefined;
  if (!el || typeof el.closest !== "function") return false;
  // `closest` rather than a tag test on the node itself: a contenteditable's
  // caret can be inside a nested <span>, and a field wrapped by a control
  // (combobox, cmdk input) reports the wrapper on some events.
  if (el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-capture-keys]"))
    return true;
  return el.isContentEditable === true;
}

/** True when the FOCUSED element owns keystrokes — for listeners that see no
 *  useful target (window `keydown` during a canvas drag, say). */
export function isTypingFocused(doc: Document = document): boolean {
  return isTypingTarget(doc.activeElement);
}
