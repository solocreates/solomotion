import { useAppShell } from "../state/app-shell";
import { displayName, projectNameOf, useProjectIndex } from "../state/project-index";
import { hasUnsavedChanges, subscribeUnsaved } from "../state/autosave";
import { product } from "../product";

/**
 * THE WINDOW TITLE — `<project> — <product>` in the editor, the product on Home
 * (v5 redesign, D2).
 *
 * There is no tab strip (D2 revised), so the OS title bar,
 * the browser tab and the window switcher are where a project's name lives
 * outside the app. It was always the product's name, which made five windows of the app
 * indistinguishable in ⌘-Tab and in the browser's tab list.
 *
 * Derived, never held: the same two stores the tab strip reads (which screen,
 * which project; the project's live name), so the title cannot disagree with
 * the logo menu. A `•` leads while autosave has changes not yet on disk.
 * Installed once, at module scope — idempotent, no React lifecycle.
 */
let installed = false;

export function titleFor(view: "home" | "editor", name: string | null, unsaved = false): string {
  return view === "editor" && name !== null ? `${unsaved ? "• " : ""}${displayName(name)} — ${product.name}` : product.name;
}

export function installDocumentTitle(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const apply = () => {
    const { view, currentProjectId } = useAppShell.getState();
    const name = currentProjectId ? projectNameOf(useProjectIndex.getState(), currentProjectId) : null;
    const next = titleFor(view, name, hasUnsavedChanges());
    if (document.title !== next) document.title = next;
  };
  useAppShell.subscribe(apply);
  useProjectIndex.subscribe(apply);
  subscribeUnsaved(apply);
  apply();
}
