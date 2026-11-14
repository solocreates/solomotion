/**
 * THE ERROR SPINE — one base class every failure in the app inherits, so that
 * "what went wrong" is a structured fact instead of a string someone has to
 * read.
 *
 * A plain `Error` carries a message and a stack, which is enough to debug with
 * and not nearly enough to ACT on. Four questions come up every single time and
 * a string can answer none of them: is this the person's problem or ours; can
 * the app carry on; what was it doing at the time; and is this the same failure
 * we already showed them thirty seconds ago. So each is a field.
 *
 *  - **`code`** is the stable identity: `"export/encoder-failed"`. Greppable,
 *    never localised, safe to branch on. `message` is for us, and may be
 *    rewritten freely; `code` is a promise.
 *  - **`userMessage`** is the sentence a person reads. Separating the two is
 *    what stops "Cannot read properties of undefined" from reaching a toast,
 *    and stops the useful stack from being softened into uselessness for the log.
 *  - **`context`** is structured and serialisable — the clip id, the frame, the
 *    file name. It is what turns a bug report from "it crashed" into something
 *    reproducible, which is the entire point of `toJSON`.
 *  - **`fingerprint`** is what makes two occurrences of the same bug one line
 *    with a counter rather than forty lines.
 *
 * `cause` is the native ES2022 one, and `chain()` walks it. Wrapping is
 * therefore lossless: a `MediaError` raised over a `DOMException` keeps both,
 * and the report shows the whole descent.
 */

import { currentSubject, subjectLabel, subjectPath, type EntityRef } from "./subject";

export type ErrorSeverity = "info" | "warning" | "error" | "fatal";

/** Structured detail. Keep it flat, keep it serialisable — it gets JSON'd. */
export type ErrorContext = Record<string, unknown>;

export interface EngineErrorInit {
  /** Stable, greppable identity: `"domain/what-happened"`. */
  code: string;
  /** For the log and the stack. Precise, technical, ours. */
  message: string;
  /** For a person. Defaults to `message` — override it whenever that is rude. */
  userMessage?: string;
  severity?: ErrorSeverity;
  /** Can the app carry on? `false` means the session is compromised. */
  recoverable?: boolean;
  context?: ErrorContext;
  cause?: unknown;
  /** What this is about. Defaults to whatever `withSubject` has in force. */
  subject?: EntityRef;
  /**
   * Whether the funnel should interrupt the person about this. Default true.
   *
   * `false` is for a failure whose call site has ALREADY said something better
   * than the generic line — an export panel that names the format and the
   * stage it died at, say. It still logs, still fingerprints, still reaches the
   * bug report; it just does not produce a second notification saying the same
   * thing worse. Without this the choice is "tell them twice" or "lose it from
   * the record", and both are wrong.
   */
  announce?: boolean;
}

/** The serialised form — what a bug report pastes and what the black box keeps. */
export interface ErrorPayload {
  code: string;
  name: string;
  message: string;
  userMessage: string;
  severity: ErrorSeverity;
  recoverable: boolean;
  context: ErrorContext;
  at: number;
  /** What it was about — the clip, effect or plugin. */
  subject?: EntityRef;
  /** Outermost first, when the failure happened inside nested regions. */
  subjects?: EntityRef[];
  stack?: string;
  /** `cause` chain, outermost first, already flattened. */
  causes: { name: string; message: string }[];
}

export class EngineError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly severity: ErrorSeverity;
  readonly recoverable: boolean;
  readonly context: ErrorContext;
  /** Epoch ms — this one is compared across sessions, so not the monotonic clock. */
  readonly at: number;
  /**
   * What the failure is about, captured at THROW time. Ambient by default: code
   * that has never heard of subjects still reports one, because the render pass
   * or the task above it declared one. See `subject.ts`.
   */
  readonly subject: EntityRef | null;
  readonly subjects: EntityRef[];
  /** See `EngineErrorInit.announce`. */
  readonly announce: boolean;

  constructor(init: EngineErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.code = init.code;
    this.userMessage = init.userMessage ?? init.message;
    this.severity = init.severity ?? "error";
    this.recoverable = init.recoverable ?? true;
    this.context = init.context ?? {};
    this.at = Date.now();
    this.announce = init.announce ?? true;
    this.subject = init.subject ?? currentSubject();
    this.subjects = init.subject ? [init.subject] : subjectPath();
    // V8 only: drop this constructor out of the stack so the top frame is the
    // throw site, which is the frame anyone reading the report cares about.
    const capture = (Error as unknown as { captureStackTrace?: (t: object, c: unknown) => void })
      .captureStackTrace;
    capture?.(this, new.target);
  }

  /** This error, then its causes, outermost first. */
  chain(): Error[] {
    const out: Error[] = [this];
    let c: unknown = this.cause;
    // A cause cycle is rare and fatal to a naive walk; cap it rather than trust.
    while (c instanceof Error && out.length < 8 && !out.includes(c)) {
      out.push(c);
      c = (c as { cause?: unknown }).cause;
    }
    return out;
  }

  /**
   * Same failure, or a different one? Code plus the first stack frame: the
   * message alone groups unrelated bugs that share wording, and the whole stack
   * splits one bug across every line number it ever threw from.
   */
  get fingerprint(): string {
    // The subject is NOT in the fingerprint. The same blur failing on forty
    // clips is one bug, and splitting it forty ways is how a real defect hides
    // inside its own noise. Which clips were hit belongs in the report's
    // context, not in its identity.
    return `${this.code}|${topFrame(this.stack)}`;
  }

  toJSON(): ErrorPayload {
    return {
      code: this.code,
      name: this.name,
      message: this.message,
      userMessage: this.userMessage,
      severity: this.severity,
      recoverable: this.recoverable,
      context: this.context,
      at: this.at,
      subject: this.subject ?? undefined,
      subjects: this.subjects.length > 0 ? this.subjects : undefined,
      stack: this.stack,
      causes: this.chain()
        .slice(1)
        .map((e) => ({ name: e.name, message: e.message })),
    };
  }

  /** The whole thing as pasteable text — the "Copy details" payload. */
  toText(): string {
    const where = this.subjects.map(subjectLabel).join(" → ");
    const lines = [
      `${this.name} [${this.code}] ${this.message}`,
      ...(where ? [`  in: ${where}`] : []),
      ...Object.entries(this.context).map(([k, v]) => `  ${k}: ${safeJson(v)}`),
      ...this.chain()
        .slice(1)
        .map((e) => `  caused by ${e.name}: ${e.message}`),
    ];
    if (this.stack) lines.push(this.stack);
    return lines.join("\n");
  }
}

function topFrame(stack: string | undefined): string {
  if (!stack) return "";
  const line = stack.split("\n").find((l) => l.includes("at "));
  return line?.trim().slice(0, 120) ?? "";
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ── the domains ──────────────────────────────────────────────────────────────

/**
 * One subclass per part of the app that can fail in a way a person would
 * describe differently. They exist so `catch (e) { if (e instanceof MediaError) }`
 * works, and so a report can be routed without string-matching a code prefix.
 * A domain that needs no special behaviour is still worth a class: the NAME is
 * what shows up in the console, and "MediaError" says more than "Error".
 */
class DomainError extends EngineError {}

export class DocumentError extends DomainError {}
export class MediaError extends DomainError {}
export class ExportError extends DomainError {}
export class RenderError extends DomainError {}
export class StorageError extends DomainError {}
export class PluginError extends DomainError {}

/**
 * The wrapper for a value that arrived from outside the app's own vocabulary —
 * a `DOMException`, a rejected fetch, a string someone threw in 2019.
 */
export class UnknownError extends EngineError {}

/**
 * THE NORMALISER — any thrown value in, one `EngineError` out, never throwing
 * itself.
 *
 * This is the reuse point the whole system turns on. Every `catch`, every
 * `unhandledrejection`, every error boundary funnels through here, so the rest
 * of the app only ever handles one shape. An error that is already ours passes
 * through untouched, except that `context` merges — so a low-level failure can
 * be annotated on its way up ("…while exporting frame 412") without losing the
 * original code, stack or cause.
 */
export function normalizeError(value: unknown, context?: ErrorContext): EngineError {
  if (value instanceof EngineError) {
    if (context && Object.keys(context).length > 0) {
      Object.assign(value.context, context);
    }
    return value;
  }
  if (value instanceof Error) {
    const wrapped = new UnknownError({
      code: codeForNative(value),
      message: `${value.name}: ${value.message}`,
      userMessage: value.message || "Something went wrong.",
      context,
      cause: value,
    });
    // Keep the ORIGINAL throw site. A wrapper's own stack points at this
    // function, which is the least useful frame in the program.
    if (value.stack) wrapped.stack = value.stack;
    return wrapped;
  }
  return new UnknownError({
    code: "unknown/non-error",
    message: `Non-error thrown: ${safeJson(value)}`,
    userMessage: "Something went wrong.",
    context,
  });
}

/** A usable code for a native error, so even unwrapped failures group sanely. */
function codeForNative(e: Error): string {
  if (e.name === "TypeError") return "js/type-error";
  if (e.name === "RangeError") return "js/range-error";
  if (e.name === "AbortError") return "js/aborted";
  if (e.name === "QuotaExceededError") return "storage/quota-exceeded";
  if (e.name === "NotAllowedError") return "permission/denied";
  if (e.name === "DOMException") return "dom/exception";
  return "unknown/error";
}

export function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError;
}
