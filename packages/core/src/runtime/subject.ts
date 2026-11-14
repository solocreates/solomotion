/**
 * THE SUBJECT — what a piece of work, or a failure, is ABOUT.
 *
 * "Something froze" is a support ticket. "The Gaussian Blur on ‘Title’ froze"
 * is a bug fix. The only difference is one structured reference, and the only
 * reason apps do not have it is that threading it through forty call sites is
 * miserable — so it gets threaded through three, and the other thirty-seven
 * report nothing.
 *
 * So it is AMBIENT. A render pass declares its subject once with
 * `withSubject()`, and every error raised beneath it — however deep, in code
 * that has never heard of this module — is tagged with it automatically.
 * Adoption cost at the leaves: zero.
 *
 * The honest limit, stated rather than hidden: the stack is SYNCHRONOUS. There
 * is no `AsyncLocalStorage` in a browser, so an `await` inside `withSubject`
 * does not carry it. That is why `TaskSpec` takes a subject of its own — the
 * supervisor re-establishes it around each chunked slice, which is exactly the
 * boundary an async operation actually has. Sync regions use the stack; async
 * ones declare it on the task. Between them there is no gap.
 */

export type SubjectKind =
  | "clip"
  | "frame"
  | "track"
  | "effect"
  | "modulator"
  | "plugin"
  | "media"
  | "node"
  | "expression"
  | "page"
  | "document";

/** A pointer at one thing in the document. Stable id first, name for humans. */
export interface EntityRef {
  kind: SubjectKind;
  id: string;
  /** What the person calls it. Denormalised on purpose — a report outlives the doc. */
  name?: string;
}

export function entityRef(kind: SubjectKind, id: string, name?: string): EntityRef {
  return name === undefined ? { kind, id } : { kind, id, name };
}

/** "Effect “Gaussian Blur”" — one line, never a sentence. */
export function subjectLabel(ref: EntityRef): string {
  const noun = ref.kind.charAt(0).toUpperCase() + ref.kind.slice(1);
  return ref.name ? `${noun} “${ref.name}”` : `${noun} ${ref.id}`;
}

/**
 * The innermost-last stack. An array rather than a single value because the
 * useful answer is usually the PATH — "plugin ‘Captions’ → clip ‘Title’ →
 * effect ‘Blur’" says where to look in a way the leaf alone does not.
 */
const stack: EntityRef[] = [];

/** The innermost subject in force, or null. */
export function currentSubject(): EntityRef | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null;
}

/** Outermost first. Copied — callers keep these on reports that outlive the frame. */
export function subjectPath(): EntityRef[] {
  return stack.slice();
}

/**
 * Declare what the enclosing SYNCHRONOUS region is about. Restores in a
 * `finally`, so a throw cannot leave the stack dirty — which would mis-attribute
 * every later error in the session and be worse than having no subject at all.
 */
export function withSubject<T>(ref: EntityRef, fn: () => T): T {
  stack.push(ref);
  try {
    return fn();
  } finally {
    stack.pop();
  }
}

/** Supervisor-facing: enter/leave without a callback, for slice boundaries. */
export function pushSubject(ref: EntityRef): void {
  stack.push(ref);
}

export function popSubject(): void {
  stack.pop();
}

/** Tests, and any host recovering from a boundary that unwound past a `finally`. */
export function resetSubjects(): void {
  stack.length = 0;
}
