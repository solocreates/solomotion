/**
 * "Ask AI" from anywhere in the editor, without importing the agent. The
 * context menu, a toolbar or a shortcut puts a draft here and opens the panel;
 * the composer (inside the lazy agent chunk) takes it when it mounts or the
 * moment it is already open. Zero dependencies, so the editor's main bundle
 * gains a dozen lines instead of the agent.
 */
let pending: string | null = null;
const listeners = new Set<(text: string) => void>();

export function askAgent(draft: string): void {
  if (listeners.size) for (const l of listeners) l(draft);
  else pending = draft;
}

export function onAsk(listener: (text: string) => void): () => void {
  listeners.add(listener);
  if (pending !== null) {
    listener(pending);
    pending = null;
  }
  return () => listeners.delete(listener);
}
