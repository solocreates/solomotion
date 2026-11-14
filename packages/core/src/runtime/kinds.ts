/**
 * THE TASK-KIND REGISTRY — what sorts of long work this app does, and what
 * each one is allowed to cost.
 *
 * A registry rather than a union of string literals with a `switch` beside it,
 * for the reason every other registry in this codebase exists: the Safety
 * settings render one row per kind by ITERATING this, so adding a new kind of
 * slow work is one `registerTaskKind()` and it appears in the UI, in the
 * Activity window and in the crash report with a sensible budget already
 * attached. Nothing downstream enumerates the set.
 *
 * `onExpire` is the field to read twice. Not every runaway may be shot: killing
 * a render pass loses a frame, and killing a WRITE loses the file. Work that
 * is mid-way through making something durable declares `"warn"` — it still
 * shows up, still says it is taking too long, and is still cancellable by hand
 * where that is safe; it just never gets stopped by a timer that does not know
 * what it is interrupting.
 */

export type ExpiryAction = "abort" | "warn";

/**
 * How long one kind may run. Three states, spelled out, because the two-state
 * version of this (`number | null`) cannot tell "no opinion, follow the global
 * setting" from "this may legitimately run for an hour" — and collapsing those
 * two is how an export gets shot at thirty seconds.
 */
export type TaskLimit =
  | { mode: "default" }
  | { mode: "unlimited" }
  | { mode: "fixed"; ms: number };

export const LIMIT_DEFAULT: TaskLimit = { mode: "default" };
export const LIMIT_UNLIMITED: TaskLimit = { mode: "unlimited" };
export function fixedLimit(ms: number): TaskLimit {
  return { mode: "fixed", ms };
}

export interface TaskKindDef {
  /** Stable id — persisted in settings overrides, so never rename one. */
  id: string;
  /** Menu-cased name. Shown in Activity and in Safety settings. */
  label: string;
  /** Settings tooltip: what this kind COVERS, not what the limit does. */
  hint: string;
  /** This kind's wall-clock budget. See `TaskLimit`. */
  limit: TaskLimit;
  /** How long before the app says out loud that this is still going. */
  warnMs: number;
  /** What a spent budget does. See the note above. */
  onExpire: ExpiryAction;
  /** Whether a person may stop it by hand from Activity. */
  cancellable: boolean;
}

const KINDS = new Map<string, TaskKindDef>();

/** Register a kind of supervised work. Later registration of an id wins. */
export function registerTaskKind(def: TaskKindDef): TaskKindDef {
  KINDS.set(def.id, def);
  return def;
}

/** Every registered kind, in registration order. The settings list IS this. */
export function taskKinds(): readonly TaskKindDef[] {
  return [...KINDS.values()];
}

export function taskKind(id: string): TaskKindDef | undefined {
  return KINDS.get(id);
}

/**
 * The fallback for work that never declared a kind. It exists so that
 * `supervise()` can be called from anywhere — including a plugin, or a call
 * site being retrofitted in a hurry — without first editing this file. Such a
 * task is still tracked, still cancellable, still in the crash report; it just
 * inherits the global default budget.
 */
export const UNKNOWN_KIND: TaskKindDef = registerTaskKind({
  id: "task",
  label: "Task",
  hint: "Work that hasn’t declared a kind of its own.",
  limit: LIMIT_DEFAULT,
  warnMs: 2_000,
  onExpire: "abort",
  cancellable: true,
});

// ── The built-ins ────────────────────────────────────────────────────────────

registerTaskKind({
  id: "export",
  label: "Export",
  hint: "Rendering and encoding a video, image sequence, SVG or Lottie file.",
  // Unlimited on purpose: a five-minute comp legitimately takes minutes, and a
  // timer that cannot tell "long" from "stuck" would abort real exports. The
  // chunked runner keeps the app responsive throughout, so a slow export is
  // visibly slow rather than indistinguishable from a hang.
  limit: LIMIT_UNLIMITED,
  warnMs: 4_000,
  onExpire: "warn",
  cancellable: true,
});

registerTaskKind({
  id: "tracking",
  label: "Motion tracking",
  hint: "Following a feature across frames, solving a camera or finding depth — to drive a layer, a camera or an effect.",
  // A run reports its progress, keeps everything it solved when stopped, and a
  // long plate is long: a fixed deadline only ever threw away a camera solve or
  // a depth pass at its two-minute mark. It warns instead; Stop is the person's.
  limit: LIMIT_UNLIMITED,
  warnMs: 1_500,
  onExpire: "warn",
  cancellable: true,
});

registerTaskKind({
  id: "audio",
  label: "Audio processing",
  hint: "Time-stretch, pitch, reverse and the offline renders behind them.",
  limit: fixedLimit(60_000),
  warnMs: 1_500,
  onExpire: "abort",
  cancellable: true,
});

registerTaskKind({
  id: "image",
  label: "Image processing",
  hint: "Background removal, area fills and other whole-image passes.",
  limit: fixedLimit(30_000),
  warnMs: 1_000,
  onExpire: "abort",
  cancellable: true,
});

registerTaskKind({
  id: "document",
  label: "Document",
  hint: "Opening, importing and migrating a project.",
  limit: fixedLimit(60_000),
  warnMs: 1_500,
  // Warn, never shoot — for the same reason as `write`, from the other end. A
  // load half-replaces the store: the old document is gone and the new one is
  // not finished. Stopping it at a timer leaves the editor pointing at neither,
  // which is a worse outcome than a slow open. The limit still earns its place:
  // it is what turns a 90-second open into a REPORTED 90-second open.
  onExpire: "warn",
  cancellable: false,
});

registerTaskKind({
  id: "write",
  label: "Saving",
  hint: "Writing a project or a bundle to disk.",
  // Never shot by a timer: a half-written file is worse than a slow one.
  limit: LIMIT_UNLIMITED,
  warnMs: 2_000,
  onExpire: "warn",
  cancellable: false,
});

registerTaskKind({
  id: "media",
  label: "Media",
  hint: "Decoding, caching and generating previews for footage and audio.",
  limit: fixedLimit(45_000),
  warnMs: 2_500,
  onExpire: "abort",
  cancellable: true,
});

registerTaskKind({
  id: "load",
  label: "Loading",
  hint: "Code and models the app fetches the first time they're needed — the 3D engine, an effect family, a tracking model.",
  // Big models on slow links take minutes; a hung fetch is still a failure.
  limit: fixedLimit(300_000),
  warnMs: 4_000,
  onExpire: "abort",
  cancellable: false,
});
