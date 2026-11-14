/**
 * FEEDBACK — how the agent gets better with use.
 *
 * Three kinds of signal, one schema:
 *
 *   report    the agent's own account of something it could not do or did
 *             wrong, filed through the `report_issue` tool with a severity and
 *             a verdict on whose fault it was
 *   rating    the user's thumbs on a reply, with optional reason chips
 *   implicit  what nobody types: an AI turn undone, a run stopped, a command
 *             that failed, a provider that kept retrying
 *
 * Every event carries the versions it happened under (skill, API, app) and the
 * model that was driving, so a fix can be MEASURED: bump the skill, watch that
 * fingerprint's rate fall.
 *
 * The FINGERPRINT is what turns noise into a backlog. It is derived from the
 * category, the command involved and a normalised signature of the error —
 * never from the free text — so a thousand people hitting one gap make one
 * cluster with a count of a thousand, and `priority` ranks clusters by how
 * often, how bad, how widely and how recently. Everything here is pure, so
 * the browser, the collecting endpoint and the triage script agree exactly.
 */

export type FeedbackKind = "report" | "rating" | "implicit";

export type ReportCategory =
  /** The API has no verb or field for what was needed. */
  | "api-gap"
  /** The API did something other than what its description says. */
  | "api-bug"
  /** The skill or a reference taught something wrong, stale or missing. */
  | "docs-mismatch"
  /** The agent itself misread, misplanned or misused a tool. */
  | "agent-mistake"
  /** A crash or broken behaviour in the app, seen through the console or a render. */
  | "app-bug"
  /** The user wanted something the product does not do. */
  | "feature-request";

/** Whose fault — the thing a triager needs first. */
export type Fault = "ours-api" | "ours-docs" | "ours-app" | "model" | "user" | "provider" | "unknown";

export type RatingReason = "wrong" | "incomplete" | "looks-bad" | "ignored-instructions" | "too-slow" | "broke-something" | "great";

export type ImplicitSignal = "undo-turn" | "stopped" | "command-failed" | "retries-exhausted" | "refusal";

export interface FeedbackContext {
  appVersion: string;
  apiVersion: number;
  skillVersion: string;
  provider: string;
  model: string;
  /** Anonymous per-install id — counts distinct people without knowing who. */
  installId: string;
  /** A license or account id, only when the user has one and opted in. */
  accountId?: string;
}

/**
 * What a report must say. The agent does the analysis at the moment it has
 * the context — afterwards nobody can reconstruct it — so every field is a
 * question a triager would otherwise have to ask.
 */
export interface ReportBody {
  kind: "report";
  category: ReportCategory;
  fault: Fault;
  /** 1 = cosmetic … 5 = the task could not be done at all. */
  severity: 1 | 2 | 3 | 4 | 5;
  title: string;
  /** What the agent was trying to do, in a sentence. */
  tried: string;
  /** What actually happened — the mistake or the gap. */
  happened: string;
  /** What should have happened: the result the user wanted. */
  expected: string;
  /** The fix, in API or skill terms: "a verb that…", "the skill should say…". */
  suggestion?: string;
  command?: string;
  error?: string;
}

export type FeedbackBody =
  | ReportBody
  | { kind: "rating"; up: boolean; reasons: RatingReason[]; comment?: string }
  | { kind: "implicit"; signal: ImplicitSignal; command?: string; error?: string };

export type FeedbackEvent = FeedbackBody & {
  id: string;
  at: number;
  context: FeedbackContext;
  fingerprint: string;
};

/** Strip what differs between instances of one problem: ids, numbers, quoted names. */
export function normalizeSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(clip|group|frame|lfx|tfx|afx|fx|paint|key|ktrack|cue|asset|m|sub|call)_[a-z0-9_-]+/g, "<id>")
    .replace(/"[^"]{0,80}"/g, "<s>")
    .replace(/-?\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** FNV-1a, 32-bit, as 8 hex chars — stable across runtimes, no crypto needed. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function fingerprintOf(e: FeedbackBody): string {
  switch (e.kind) {
    case "report":
      return `r-${e.category}-${hash(`${e.command ?? ""}|${normalizeSignature(e.error ?? e.title)}`)}`;
    case "rating":
      return `t-${e.up ? "up" : "down"}-${[...e.reasons].sort().join("+") || "none"}`;
    case "implicit":
      return `i-${e.signal}-${hash(`${e.command ?? ""}|${normalizeSignature(e.error ?? "")}`)}`;
  }
}

/**
 * A CLUSTER is also the storage unit. The collector keeps one per fingerprint
 * — counters, tallies and the newest few samples — and drops the rest, so what
 * is stored grows with the number of DISTINCT problems, not with usage. A
 * million people hitting one gap cost one row and a counter.
 */
export interface FeedbackCluster {
  fingerprint: string;
  kind: FeedbackKind;
  /** A representative title — the first report's, or the signal's name. */
  title: string;
  count: number;
  installs: number;
  maxSeverity: number;
  firstAt: number;
  lastAt: number;
  models: Record<string, number>;
  skillVersions: Record<string, number>;
  /** The newest examples (up to `SAMPLE_CAP`), for whoever fixes it. */
  samples: FeedbackEvent[];
  priority: number;
}

/** How much a kind of event weighs before severity is known. */
function baseSeverity(e: FeedbackEvent): number {
  if (e.kind === "report") return e.severity;
  if (e.kind === "rating") return e.up ? 0 : e.reasons.includes("broke-something") ? 4 : 2.5;
  return e.signal === "undo-turn" ? 3 : e.signal === "retries-exhausted" ? 2 : e.signal === "command-failed" ? 2 : 1.5;
}

/**
 * Rank a cluster: severity dominates, breadth (distinct installs) beats raw
 * count (one frustrated person retrying twenty times is one person), and
 * recency decays over two weeks so fixed problems sink on their own.
 */
export function priority(c: Pick<FeedbackCluster, "count" | "installs" | "maxSeverity" | "lastAt">, now = Date.now()): number {
  const ageDays = Math.max(0, (now - c.lastAt) / 86_400_000);
  const recency = Math.exp(-ageDays / 14);
  const breadth = Math.log2(1 + c.installs) * 2 + Math.log2(1 + c.count);
  return Math.round(c.maxSeverity ** 2 * breadth * recency * 10) / 10;
}

export const SAMPLE_CAP = 20;

/**
 * Fold one event into its stored cluster — what the collecting endpoint runs
 * per upload, so it never needs the history to stay current.
 */
export function foldIntoCluster(
  cluster: FeedbackCluster | null,
  e: FeedbackEvent,
  seenInstall: boolean,
  now = Date.now(),
): FeedbackCluster {
  const base: FeedbackCluster = cluster ?? {
    fingerprint: e.fingerprint,
    kind: e.kind,
    title: titleOf(e),
    count: 0,
    installs: 0,
    maxSeverity: 0,
    firstAt: e.at,
    lastAt: e.at,
    models: {},
    skillVersions: {},
    samples: [],
    priority: 0,
  };
  const model = `${e.context.provider}/${e.context.model}`;
  const next: FeedbackCluster = {
    ...base,
    count: base.count + 1,
    installs: base.installs + (seenInstall ? 0 : 1),
    maxSeverity: Math.max(base.maxSeverity, baseSeverity(e)),
    lastAt: Math.max(base.lastAt, e.at),
    models: { ...base.models, [model]: (base.models[model] ?? 0) + 1 },
    skillVersions: { ...base.skillVersions, [e.context.skillVersion]: (base.skillVersions[e.context.skillVersion] ?? 0) + 1 },
    samples: [e, ...base.samples].slice(0, SAMPLE_CAP),
  };
  next.priority = priority(next, now);
  return next;
}

function titleOf(e: FeedbackEvent): string {
  return e.kind === "report" ? e.title : e.kind === "rating" ? `${e.up ? "👍" : "👎"} ${e.reasons.join(", ") || "no reason"}` : e.signal;
}

export function clusterFeedback(events: FeedbackEvent[], now = Date.now()): FeedbackCluster[] {
  const byPrint = new Map<string, { events: FeedbackEvent[]; installs: Set<string> }>();
  for (const e of events) {
    const slot = byPrint.get(e.fingerprint) ?? { events: [], installs: new Set<string>() };
    slot.events.push(e);
    slot.installs.add(e.context.installId);
    byPrint.set(e.fingerprint, slot);
  }
  const clusters: FeedbackCluster[] = [];
  for (const [fingerprint, { events: list, installs }] of byPrint) {
    list.sort((a, b) => b.at - a.at);
    const first = list[list.length - 1]!;
    const tally = (key: (e: FeedbackEvent) => string) =>
      list.reduce<Record<string, number>>((acc, e) => ((acc[key(e)] = (acc[key(e)] ?? 0) + 1), acc), {});
    const cluster: FeedbackCluster = {
      fingerprint,
      kind: first.kind,
      title: titleOf(first),
      count: list.length,
      installs: installs.size,
      maxSeverity: Math.max(...list.map(baseSeverity)),
      firstAt: first.at,
      lastAt: list[0]!.at,
      models: tally((e) => `${e.context.provider}/${e.context.model}`),
      skillVersions: tally((e) => e.context.skillVersion),
      samples: list.slice(0, SAMPLE_CAP),
      priority: 0,
    };
    cluster.priority = priority(cluster, now);
    clusters.push(cluster);
  }
  return clusters.sort((a, b) => b.priority - a.priority);
}

/**
 * What leaves the device when sharing is on: the event minus anything that
 * could carry the user's content beyond what they wrote into feedback itself.
 * Free text is capped; nothing from the document is ever attached.
 */
export function redactForUpload(e: FeedbackEvent): FeedbackEvent {
  const cap = (s: string | undefined, n: number) => (s ? s.slice(0, n) : s);
  const context = { ...e.context, accountId: undefined };
  if (e.kind === "report") {
    return { ...e, context, title: cap(e.title, 160)!, tried: cap(e.tried, 800)!, happened: cap(e.happened, 1500)!, expected: cap(e.expected, 800)!, suggestion: cap(e.suggestion, 1000), error: cap(e.error, 500) };
  }
  if (e.kind === "rating") return { ...e, context, comment: cap(e.comment, 1000) };
  return { ...e, context, error: cap(e.error, 500) };
}
