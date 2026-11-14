import { normalizeError, type EngineError, type ErrorContext, type ErrorPayload } from "./errors";

/**
 * THE ERROR BUS — every failure in the app arrives here, once, and everything
 * that wants to know subscribes.
 *
 * The alternative is what most apps do: each call site decides for itself
 * whether to toast, to log, to swallow, or to rethrow. That is not a policy,
 * it is forty policies, and it is why apps show you three notifications for one
 * problem and none at all for the next. Here a `catch` does exactly one thing —
 * `reportError(e, {…})` — and the ROUTING (a status line, a console entry, a
 * row in Activity, a line in the bug report) is decided once, by subscribers.
 *
 * Deduplication is by fingerprint, because the failure mode that matters is
 * never a single throw: it is the same throw sixty times a second from a render
 * loop. One row with a counter stays readable; sixty rows are a denial of
 * service on the person trying to read them.
 */

export interface ErrorReport {
  readonly id: string;
  readonly fingerprint: string;
  readonly error: EngineError;
  /** How many times this same failure has been seen. */
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
}

const MAX_REPORTS = 100;
let seq = 0;

class ErrorBus {
  #reports: ErrorReport[] = [];
  #byPrint = new Map<string, ErrorReport>();
  #listeners = new Set<(report: ErrorReport, isNew: boolean) => void>();

  /**
   * Record a failure. Returns the normalised error so a call site can rethrow
   * the good version:  `throw errors.report(e, { clipId })`.
   */
  report(value: unknown, context?: ErrorContext): EngineError {
    const error = normalizeError(value, context);
    const fingerprint = error.fingerprint;
    const existing = this.#byPrint.get(fingerprint);
    let report: ErrorReport;
    let isNew: boolean;
    if (existing) {
      report = { ...existing, count: existing.count + 1, lastAt: Date.now(), error };
      this.#byPrint.set(fingerprint, report);
      this.#reports = [report, ...this.#reports.filter((r) => r.id !== existing.id)];
      isNew = false;
    } else {
      report = {
        id: `er_${++seq}`,
        fingerprint,
        error,
        count: 1,
        firstAt: error.at,
        lastAt: error.at,
      };
      this.#byPrint.set(fingerprint, report);
      this.#reports = [report, ...this.#reports].slice(0, MAX_REPORTS);
      isNew = true;
    }
    for (const fn of this.#listeners) fn(report, isNew);
    return error;
  }

  /** Newest first. */
  reports(): readonly ErrorReport[] {
    return this.#reports;
  }

  subscribe(fn: (report: ErrorReport, isNew: boolean) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  clear(): void {
    this.#reports = [];
    this.#byPrint.clear();
  }
}

export const errors = new ErrorBus();

/** The one call every `catch` makes. */
export function reportError(value: unknown, context?: ErrorContext): EngineError {
  return errors.report(value, context);
}

/**
 * Run something and report whatever it throws, without letting the failure
 * escape. For the genuinely optional — a thumbnail that did not generate, a
 * preference that would not parse — where the alternative is a bare
 * `catch {}` that loses the evidence forever.
 */
export function tryOrReport<T>(fn: () => T, context?: ErrorContext): T | undefined {
  try {
    return fn();
  } catch (e) {
    reportError(e, context);
    return undefined;
  }
}

// ── the bug report ───────────────────────────────────────────────────────────

/**
 * What a person needs to send us, assembled for them.
 *
 * The reason this exists is unglamorous and decisive: the difference between a
 * bug we can fix and one we cannot is almost never the person's willingness to
 * help, it is whether the paste contains the version, the platform and the last
 * forty log lines. Asking for those gets you one of the three. Putting a
 * "Copy report" button next to the failure gets you all of them, every time.
 *
 * Markdown, because it is pasteable into an issue, a chat and an email
 * unchanged. Headless, because the exporter and a test build the same text.
 */
export interface BugReportInput {
  /** The app the report is about, as its header names it. */
  appName: string;
  appVersion: string;
  /** "web · macOS · Chrome 140" — the host assembles it; core does not sniff. */
  environment: Record<string, string>;
  /** Recent log lines, oldest first, already rendered to text. */
  logs?: { ts: number; level: string; text: string }[];
  errors?: readonly ErrorReport[];
  /** What was running, and what froze. */
  tasks?: { kind: string; label: string; state: string; ms: number }[];
  freezes?: { durationMs: number; label: string | null }[];
  /** Anything the caller wants on the record — doc name, clip count, fps. */
  document?: Record<string, string | number>;
  /** What the person was doing. Optional and usually empty; still worth asking. */
  note?: string;
}

const LOG_LINES = 60;

export function buildBugReport(input: BugReportInput): string {
  const out: string[] = [`## ${input.appName} bug report`, ""];

  if (input.note?.trim()) out.push(input.note.trim(), "");

  out.push("| | |", "|---|---|", `| Version | ${input.appVersion} |`);
  for (const [k, v] of Object.entries(input.environment)) out.push(`| ${k} | ${v} |`);
  out.push(`| Reported | ${new Date().toISOString()} |`, "");

  if (input.document && Object.keys(input.document).length > 0) {
    out.push("**Document**", "");
    for (const [k, v] of Object.entries(input.document)) out.push(`- ${k}: ${v}`);
    out.push("");
  }

  const errs = input.errors ?? [];
  if (errs.length > 0) {
    out.push(`### Errors (${errs.length})`, "");
    // Only the first few in full: a report nobody scrolls to the end of has the
    // same value as no report, and the newest failure is nearly always the one.
    for (const r of errs.slice(0, 5)) {
      out.push(`**${r.error.code}**${r.count > 1 ? ` ×${r.count}` : ""}`, "", "```", r.error.toText(), "```", "");
    }
    if (errs.length > 5) {
      out.push(`_…and ${errs.length - 5} more:_ ${errs.slice(5).map((r) => r.error.code).join(", ")}`, "");
    }
  }

  const freezes = input.freezes ?? [];
  if (freezes.length > 0) {
    out.push("### Freezes", "");
    for (const f of freezes) {
      out.push(`- ${(f.durationMs / 1000).toFixed(1)}s${f.label ? ` — while ${f.label}` : ""}`);
    }
    out.push("");
  }

  const tasks = input.tasks ?? [];
  if (tasks.length > 0) {
    out.push("### Activity", "");
    for (const t of tasks) out.push(`- \`${t.kind}\` ${t.label} — ${t.state}, ${Math.round(t.ms)}ms`);
    out.push("");
  }

  const logs = input.logs ?? [];
  if (logs.length > 0) {
    out.push(`### Console (last ${Math.min(LOG_LINES, logs.length)})`, "", "```");
    for (const l of logs.slice(-LOG_LINES)) {
      out.push(`${new Date(l.ts).toISOString().slice(11, 23)} ${l.level.padEnd(5)} ${l.text}`);
    }
    out.push("```", "");
  }

  return out.join("\n");
}

/** The error list as plain data — for the black box, which must survive JSON. */
export function errorPayloads(reports: readonly ErrorReport[], limit = 10): ErrorPayload[] {
  return reports.slice(0, limit).map((r) => r.error.toJSON());
}
