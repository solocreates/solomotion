"use client";

import { z } from "zod";
import {
  ApiError,
  clearScriptOutput,
  dropKeptOutput,
  scriptHere,
  createdSince,
  createId,
  defineCommand,
  docIds,
  findScript,
  requireFrame,
  mergeOutputs,
  runtimeFor,
  scriptCallable,
  scriptLocation,
  scriptPath,
  scriptSignature,
  type AnyCommand,
  type CommandContext,
  type CommandRegistry,
  type CommandResult,
  type DocIds,
  type ScriptHere,
  type ScriptRunMode,
} from "@solomotion/core";
import { pushLog } from "@solomotion/platform";
import { editorApiSession } from "../state/session";
import { recordFeedback } from "../agent/feedback";
import { HELP_COMMAND, sourceUrlOf, type FromWorker, type ToWorker } from "./protocol";
import { spawnScriptWorker } from "./worker";
import { useScripts, type RunLog, type RunRecord, type StoppedBy } from "./store";

/**
 * THE SCRIPT HOST — the editor half of a run.
 *
 * It owns the worker (spawned on first run, terminated on Stop and when the
 * panel closes), answers every `ac.*` call from the ONE registry, and does the
 * bookkeeping only the editor can: a saved file's previous output is taken
 * back before a `replace` run and what the run created is recorded after, all
 * inside the run's single undo step. Errors come back with the line they
 * happened on, measured from the engine's own stack.
 *
 * Runs are serial. A script is a sequence of edits to one document; two
 * interleaving would make "what this run created" a guess.
 */

/** How a script's writes read in the Undo menu. */
export const SCRIPT_ACTOR = "Script";

export interface RunRequest {
  code: string;
  /** Display path; `console` for the prompt. */
  path: string;
  repl: boolean;
  /** A saved file: enables replace/append bookkeeping. */
  scriptId?: string;
  /** Overrides the file's own `onRun` for this run (⇧⌘↵ keeps the last output). */
  mode?: ScriptRunMode;
  /** Run somewhere other than the focused comp. */
  frameId?: string;
  /** The run stops itself past this many ms. Omitted = no budget (a person has the Stop button). */
  timeoutMs?: number;
  ctx: CommandContext;
}

const MAX_LOGS = 1000;

/** The context a run started from the panel uses: one undo step per run, labelled with the file. */
export function panelRunContext(store: CommandContext["store"], path: string): CommandContext {
  return { store, actor: SCRIPT_ACTOR, historyKey: `script:${createId("run")}`, historyLabel: `Run ${path}`, session: editorApiSession() };
}

interface ActiveRun {
  record: RunRecord;
  req: RunRequest;
  inflight: Set<Promise<unknown>>;
  before: DocIds | null;
  mode: ScriptRunMode;
  replaced: number;
  /** Comps a replace could not take back yet (the project's last) — taken at settle, once the run has made others. */
  kept: string[];
  /** `ac.*` calls answered so far, and the ones being answered now (by call id). */
  calls: number;
  awaiting: Map<number, string>;
  budget?: ReturnType<typeof setTimeout>;
  finish: (r: RunRecord) => void;
}

/** A run waiting its turn — it has an id (so it can be followed or stopped) before it has a worker. */
interface QueuedRun {
  record: RunRecord;
  req: RunRequest;
  finish: (r: RunRecord) => void;
}

/** What a live run is doing right now — read on demand, never stored, so a busy run costs the panel nothing. */
export interface RunProgress {
  calls: number;
  /** The verbs it is waiting on this instant (`view.render`). */
  awaiting: string[];
}

class ScriptHost {
  private worker: Worker | null = null;
  private lineOffset = 2;
  private ready: Promise<void> | null = null;
  private active: ActiveRun | null = null;
  private waiting = new Map<string, QueuedRun>();
  private queue: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  /** The context late calls (a timer that fires after its run) are answered with. */
  private lastCtx: CommandContext | null = null;

  constructor(private readonly registry: () => CommandRegistry) {}

  /**
   * Queue a run. It has its id NOW — an agent that runs in the background
   * follows and stops it by that id while it waits behind another — and `done`
   * settles when it finishes, fails, is stopped or runs out of budget.
   */
  start(req: RunRequest): { id: string; done: Promise<RunRecord> } {
    const record: RunRecord = {
      id: createId("run"),
      path: req.path,
      repl: req.repl,
      code: req.code,
      scriptId: req.scriptId,
      status: "queued",
      startedAt: Date.now(),
      ms: 0,
      logs: [],
      dropped: 0,
      created: 0,
      replaced: 0,
      unawaited: 0,
      ...(req.timeoutMs ? { budgetMs: req.timeoutMs } : {}),
    };
    useScripts.getState().push(record);
    const done = new Promise<RunRecord>((finish) => this.waiting.set(record.id, { record, req, finish }));
    this.queue = this.queue.then(() => this.execute(record.id)).catch(() => undefined);
    return { id: record.id, done };
  }

  run(req: RunRequest): Promise<RunRecord> {
    return this.start(req).done;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  /** The live run's counters, or null when `id` is not the one running. */
  progress(id: string): RunProgress | null {
    const run = this.active;
    if (!run || run.record.id !== id) return null;
    return { calls: run.calls, awaiting: [...run.awaiting.values()] };
  }

  /** Stop whatever is running NOW — the panel's Stop. What it already wrote stays; one ⌘Z takes it back. */
  stop(): void {
    if (this.active) this.stopRun(this.active.record.id, "person");
  }

  /**
   * Stop one run by id, running or still queued. The worker is terminated
   * rather than asked: a loop that never awaits would never hear a polite
   * request, and terminating is instant whatever the script is doing. A call
   * the editor is answering at that moment finishes and is discarded.
   */
  stopRun(id: string, by: StoppedBy): RunRecord | null {
    const run = this.active;
    if (run && run.record.id === id) {
      this.terminate();
      return this.settle(run, { status: "stopped", stoppedBy: by });
    }
    const queued = this.waiting.get(id);
    if (!queued) return null;
    this.waiting.delete(id);
    const done: RunRecord = { ...queued.record, status: "stopped", stoppedBy: by };
    useScripts.getState().patch(id, (r) => ({ ...done, logs: r.logs, dropped: r.dropped }));
    queued.finish(done);
    return done;
  }

  /** Free the worker when nothing is running (the panel closed). */
  release(): void {
    if (!this.active) this.terminate();
  }

  private terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private boot(): Promise<void> {
    if (this.ready) return this.ready;
    const worker = spawnScriptWorker();
    this.worker = worker;
    const send = () => {
      const commands = this.registry().list().filter(scriptCallable).map((d) => ({ id: d.id, summary: d.summary }));
      this.post({ t: "init", commands });
    };
    this.ready = new Promise<void>((resolve) => {
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.t === "ready") {
          this.lineOffset = m.lineOffset;
          resolve();
        } else this.receive(m);
      };
    });
    send();
    // A host verb registered later (a plugin, hot reload) reaches the next line typed.
    this.unsubscribe = this.registry().subscribe(send);
    return this.ready;
  }

  private post(msg: ToWorker) {
    this.worker?.postMessage(msg);
  }

  /** Resolves when the run is over, so the next one in the queue starts after it. */
  private execute(id: string): Promise<void> {
    const queued = this.waiting.get(id);
    if (!queued) return Promise.resolve(); // stopped while it waited
    this.waiting.delete(id);
    const asked = queued.req;
    // "Here" is decided ONCE, now: the comp the person was on when they
    // pressed Run (or the one named), held for every call of the run.
    const here = scriptHere(asked.ctx.store.getState(), asked.frameId ?? asked.ctx.session.focusFrameId());
    const req: RunRequest = { ...asked, ctx: pinFocus(asked.ctx, here) };
    const record: RunRecord = { ...queued.record, ...(here ? { here: here.name } : {}), status: "running", startedAt: Date.now() };
    useScripts.getState().patch(id, (r) => ({ ...record, logs: r.logs, dropped: r.dropped }));
    useScripts.getState().setRunning(id);
    this.lastCtx = req.ctx;

    return new Promise<void>((over) => {
      const run: ActiveRun = {
        record,
        req,
        inflight: new Set(),
        before: null,
        mode: req.mode ?? "replace",
        replaced: 0,
        kept: [],
        calls: 0,
        awaiting: new Map(),
        finish: (r) => {
          queued.finish(r);
          over();
        },
      };
      this.active = run;
      if (req.timeoutMs) run.budget = setTimeout(() => this.stopRun(id, "timeout"), req.timeoutMs);
      void (async () => {
        try {
          // What a replace run takes back, and the census of what it makes, wait
          // for the worker's `compiled`: a file that does not parse leaves the
          // last run's output where it is (it used to vanish on a typo).
          await this.boot();
          if (this.active !== run) return; // stopped while booting
          this.post({ t: "run", runId: record.id, code: req.code, file: sourceUrlOf(req.path), repl: req.repl, here });
        } catch (err) {
          this.settle(run, { status: "error", error: { name: "Error", message: err instanceof Error ? err.message : String(err) } });
        }
      })();
    });
  }

  /** `replace`: take back what the last run of this file made, inside this run's undo step. */
  private prepareOwned(run: ActiveRun) {
    const { store } = run.req.ctx;
    const script = store.getState().scripts.find((s) => s.id === run.req.scriptId);
    if (!script) return;
    run.mode = run.req.mode ?? script.onRun;
    if (run.mode === "replace" && (script.output.clipIds.length || script.output.frameIds.length)) {
      runtimeFor(run.req.ctx).write("Replace script output", (d) => {
        const r = clearScriptOutput(d, script.output);
        run.replaced = r.layers + r.comps;
        run.kept = r.kept;
        const s = d.scripts.find((x) => x.id === script.id);
        if (s) s.output = { clipIds: [], frameIds: r.kept };
      });
    }
  }

  private receive(m: FromWorker) {
    const run = this.active && "runId" in m && this.active.record.id === m.runId ? this.active : null;
    switch (m.t) {
      case "compiled": {
        if (!run) return;
        if (run.req.scriptId) this.prepareOwned(run);
        // EVERY run knows what it made — a one-off as much as a saved file.
        // Counting only saved files is why every agent run said `created: 0`
        // while the half-built comps of the failed ones sat on the page.
        run.before = docIds(run.req.ctx.store.getState());
        return;
      }
      case "call": {
        const ctx = run?.req.ctx ?? this.lastCtx;
        const p = this.answer(m.command, m.input, ctx).then((result) => this.post({ t: "ret", callId: m.callId, result }));
        if (run) {
          run.calls++;
          run.awaiting.set(m.callId, m.command);
          run.inflight.add(p);
          void p.finally(() => {
            run.inflight.delete(p);
            run.awaiting.delete(m.callId);
          });
        }
        return;
      }
      case "log": {
        const target = run ?? null;
        const line = scriptLocation(m.stack, sourceUrlOf(target?.req.path ?? ""), this.lineOffset)?.line;
        const log: RunLog = { level: m.level, args: m.args, ...(line ? { line } : {}) };
        // Tee to the app console, so a script's output sits with everything else that happened.
        pushLog(m.level === "log" ? "info" : m.level, [`[${target?.req.path ?? "script"}]`, ...m.args]);
        const id = target?.record.id ?? useScripts.getState().entries.at(-1)?.id;
        if (id) queueLog(id, log);
        return;
      }
      case "done": {
        if (!run) return;
        void (async () => {
          // Calls the script fired without `await` are still landing; let them,
          // and say so — it is the single most common scripting mistake.
          const unawaited = run.inflight.size;
          await Promise.allSettled([...run.inflight]);
          if (m.ok) this.settle(run, { status: "ok", value: m.value, unawaited });
          else {
            const at = scriptLocation(m.error.stack, sourceUrlOf(run.req.path), this.lineOffset);
            this.settle(run, { status: "error", error: { ...m.error, ...(at ?? {}) }, unawaited });
          }
        })();
        return;
      }
    }
  }

  private async answer(command: string, input: unknown, ctx: CommandContext | null): Promise<CommandResult> {
    if (command === HELP_COMMAND) return { ok: true, value: helpText(this.registry(), (input as { id?: string }).id ?? "") };
    if (!ctx) return { ok: false, kind: "api", error: "No document is open." };
    const def = this.registry().get(command);
    if (def && !scriptCallable(def)) {
      return { ok: false, kind: "api", error: `${command} is not available inside a script.`, hint: "Call the verbs directly — a script is already a batch." };
    }
    const res = await this.registry().call(command, input, ctx);
    // Scripts written by chatboxes are the API's least-guided callers; what they
    // trip on is exactly what the skill and the errors should teach next. Input
    // typos are left out, as they are for the chat and MCP.
    if (!res.ok && res.kind !== "input") recordFeedback({ kind: "implicit", signal: "command-failed", command, error: res.error }, { provider: "script", model: ctx.actor });
    return res;
  }

  private settle(run: ActiveRun, patch: Partial<RunRecord>): RunRecord | null {
    if (this.active !== run) return null;
    this.active = null;
    clearTimeout(run.budget);
    flushLogs();
    const { req } = run;
    const made = run.before ? createdSince(run.before, req.ctx.store.getState()) : { clipIds: [], frameIds: [] };
    const created = made.clipIds.length + made.frameIds.length;
    if (req.scriptId && (created || run.kept.length)) {
      runtimeFor(req.ctx).write("Record script output", (d) => {
        const s = d.scripts.find((x) => x.id === req.scriptId);
        if (!s) return;
        if (run.mode === "append") {
          s.output = mergeOutputs(s.output, made);
          return;
        }
        const dropped = dropKeptOutput(d, run.kept);
        run.replaced += dropped.comps;
        s.output = mergeOutputs({ clipIds: [], frameIds: dropped.left }, made);
      });
    }
    const done: RunRecord = { ...run.record, ...patch, ms: Date.now() - run.record.startedAt, created, made, replaced: run.replaced };
    useScripts.getState().patch(done.id, (r) => ({ ...done, logs: r.logs, dropped: r.dropped }));
    useScripts.getState().setRunning(null);
    const final = { ...done, logs: useScripts.getState().entries.find((e) => e.id === done.id)?.logs ?? [] };
    run.finish(final);
    return final;
  }
}

/** The run's context with "here" fixed — a click elsewhere mid-run changes nothing. */
function pinFocus(ctx: CommandContext, here: ScriptHere | null): CommandContext {
  const frameId = here?.frameId ?? null;
  return { ...ctx, session: { ...ctx.session, focusFrameId: () => frameId } };
}

// ── Log batching ─────────────────────────────────────────────────────────────
// A loop that logs a thousand lines must not re-render the panel a thousand
// times: lines are buffered and land once per frame.

let pendingLogs = new Map<string, RunLog[]>();
let flushHandle = 0;

function queueLog(runId: string, log: RunLog) {
  (pendingLogs.get(runId) ?? pendingLogs.set(runId, []).get(runId)!).push(log);
  if (!flushHandle) flushHandle = requestAnimationFrame(flushLogs);
}

export function flushLogs() {
  if (flushHandle) cancelAnimationFrame(flushHandle);
  flushHandle = 0;
  const batch = pendingLogs;
  pendingLogs = new Map();
  for (const [id, logs] of batch) {
    useScripts.getState().patch(id, (r) => {
      const room = Math.max(0, MAX_LOGS - r.logs.length);
      return { ...r, logs: room ? [...r.logs, ...logs.slice(0, room)] : r.logs, dropped: r.dropped + Math.max(0, logs.length - room) };
    });
  }
}

// ── Help ─────────────────────────────────────────────────────────────────────

/** `ac.help()` — the namespaces; `ac.help("layer")` — its verbs; `ac.help("layer.create")` — the full shape. */
export function helpText(registry: CommandRegistry, id: string): string {
  const all = registry.list().filter(scriptCallable);
  const def = id ? registry.get(id) : undefined;
  if (def) return `${def.summary}${def.details ? `\n\n${def.details}` : ""}\n\n${scriptSignature(def, 3)}`;
  const inNs = all.filter((d) => d.id.startsWith(`${id}.`));
  if (id && inNs.length) return inNs.map((d) => `ac.${d.id}() — ${d.summary}`).join("\n");
  const namespaces = [...new Set(all.map((d) => d.id.split(".")[0]!))].sort();
  return `${id ? `No verb "${id}". ` : ""}Namespaces: ${namespaces.join(", ")}.\nac.help("layer") lists a namespace; ac.help("layer.create") shows one verb in full.`;
}

// ── The singleton, the agent's verb, DevTools ────────────────────────────────

let host: ScriptHost | null = null;

export function scriptHost(registry?: () => CommandRegistry): ScriptHost {
  if (!host) {
    if (!registry) throw new Error("The script host needs its registry on first use.");
    host = new ScriptHost(registry);
  }
  return host;
}

/** A run's log lines as plain text, in order. */
function logLines(r: RunRecord): string[] {
  return r.logs.map((l) => `${l.level === "log" ? "" : `${l.level}: `}${l.args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
}

/** How many of a run's ids a report spells out — enough to act on, never a wall. */
const MADE_IDS_SHOWN = 20;

/** Plain text of a run, for a model: what was logged, returned or thrown, and what changed. */
export function runReport(r: RunRecord, maxChars = 12_000, opts: { logs?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { runId: r.id, status: r.status, ms: r.ms, created: r.created, replaced: r.replaced };
  if (r.stoppedBy) out.stoppedBy = r.stoppedBy;
  const logs = logLines(r);
  if (opts.logs !== false && logs.length) out.logs = logs.join("\n").slice(0, maxChars);
  if (r.dropped) out.droppedLogs = r.dropped;
  if (r.value !== undefined) out.value = r.value;
  if (r.error) out.error = { message: r.error.message, ...(r.error.hint ? { hint: r.error.hint } : {}), ...(r.error.line ? { line: r.error.line } : {}) };
  if (r.unawaited) out.warning = `${r.unawaited} call(s) were still running when the script returned — await every ac.* call.`;
  // WHAT A RUN THAT DID NOT FINISH LEFT BEHIND. It stays — a long build that
  // fails at step ninety should not lose eighty-nine — but it is named, so the
  // caller decides instead of finding the debris by eye.
  if (r.status !== "ok" && r.created > 0 && r.made) {
    const ids = [...r.made.frameIds, ...r.made.clipIds];
    out.leftBehind = {
      comps: r.made.frameIds.length,
      layers: r.made.clipIds.length,
      ids: ids.slice(0, MADE_IDS_SHOWN),
      ...(ids.length > MADE_IDS_SHOWN ? { more: ids.length - MADE_IDS_SHOWN } : {}),
    };
    out.hint = "What it made stays. history.undo takes the whole run back if nothing has been done since; layers.delete / frame.delete remove pieces.";
  }
  return out;
}

/** A live run in ONE line — the cheap check while a long build runs. */
function runLine(r: RunRecord, progress: RunProgress | null): string {
  const secs = Math.round((Date.now() - r.startedAt) / 1000);
  const age = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
  const parts = [r.id, r.path, `${r.status} ${age}`];
  if (progress) {
    parts.push(`${progress.calls} calls`);
    if (progress.awaiting.length) parts.push(`awaiting ${progress.awaiting.join(", ")}`);
  }
  if (r.budgetMs) parts.push(`budget ${Math.round(r.budgetMs / 1000)}s`);
  const last = logLines(r).at(-1);
  if (last) parts.push(JSON.stringify(last.length > 120 ? `${last.slice(0, 117)}…` : last));
  return parts.join(" · ");
}

/** The default time budget an agent's run gets; a known-long build raises it. */
const AGENT_BUDGET_MS = 5 * 60_000;
const BACKGROUND_BUDGET_MS = 15 * 60_000;
const MAX_BUDGET_MS = 60 * 60_000;

/**
 * THE SCRIPT VERBS an agent drives — run (in the foreground or behind it),
 * watch, read the logs, stop. A long build used to be a black box that held
 * the agent for up to ten minutes while it kept running in the tab; now it
 * returns an id at once, is checked in a line, and is stopped by that id.
 */
export function scriptRunCommands(registry: () => CommandRegistry): AnyCommand[] {
  const host = () => scriptHost(registry);
  const find = (id: string) => {
    flushLogs();
    const r = useScripts.getState().entries.find((e) => e.id === id);
    if (!r) throw new ApiError(`No run "${id}".`, "script.runs lists the live and recent runs.");
    return r;
  };

  const run = defineCommand({
    id: "script.run",
    summary: "Run JavaScript against this API in one call — loops, math, data. Returns logs, the returned value, errors with line numbers, and what changed.",
    details:
      "Every verb is `await ac.<id>(input)` (`ac.layer.create({...})`); `console.log` is captured. It runs in the focused comp (`here` in the script; calls without a frameId land there) unless you pass `frameId`. Pass `code` for a one-off, or `script` (a saved file's path) to run it — a saved file in replace mode removes what its last run created once its code parses. Use it for anything repetitive; read references/scripting.md first. A long build: `background: true` returns a runId at once — follow it with script.runs / script.logs, stop it with script.stop. Every run has a time budget (`timeoutMs`; 5 min, 15 in the background) and stops itself past it.",
    effect: "write",
    input: z.object({
      code: z.string().optional(),
      script: z.string().optional().describe("Path or id of a saved script (script.list)."),
      frameId: z.string().optional().describe("The comp to run in (`here`); omitted = the focused comp."),
      background: z.boolean().optional().describe("Return { runId } at once; the run continues in the editor."),
      timeoutMs: z.number().int().min(1000).max(MAX_BUDGET_MS).optional().describe("Stop the run past this budget. Default 300000 (900000 in the background)."),
    }),
    async run(input, rt) {
      if (rt.actor === SCRIPT_ACTOR) throw new ApiError("A script cannot run a script.");
      const doc = rt.doc();
      const saved = input.script ? findScript(doc, input.script) : undefined;
      if (input.script && !saved) throw new ApiError(`No script "${input.script}".`, "script.list shows every path.");
      if (input.frameId) requireFrame(doc, input.frameId);
      const code = input.code ?? saved?.source;
      if (!code?.trim()) throw new ApiError("Nothing to run.", "Pass `code`, or `script` with a saved file's path.");
      const path = saved ? scriptPath(doc, saved) : "agent.js";
      const started = host().start({
        code,
        path,
        repl: false,
        ...(saved ? { scriptId: saved.id } : {}),
        ...(input.frameId ? { frameId: input.frameId } : {}),
        timeoutMs: input.timeoutMs ?? (input.background ? BACKGROUND_BUDGET_MS : AGENT_BUDGET_MS),
        // A run that outlives this request is its OWN undo step, not a piece
        // of whichever turn happened to start it.
        ctx: input.background ? { ...rt, historyKey: `script:${createId("run")}`, historyLabel: `Run ${path}` } : rt,
      });
      if (!input.background) return runReport(await started.done);
      const ahead = useScripts.getState().entries.filter((e) => e.id !== started.id && (e.status === "running" || e.status === "queued")).length;
      return { runId: started.id, status: ahead ? "queued" : "running", ...(ahead ? { behind: ahead } : {}) };
    },
  });

  const runs = defineCommand({
    id: "script.runs",
    summary: "The script runs that are live or just finished, one line each: id, file, status and age, calls made, what it is awaiting, its last log line.",
    effect: "read",
    input: z.object({}),
    async run() {
      flushLogs();
      const entries = useScripts.getState().entries.filter((e) => !e.repl);
      const live = entries.filter((e) => e.status === "running" || e.status === "queued");
      const recent = entries.filter((e) => e.status !== "running" && e.status !== "queued").slice(-5);
      return {
        live: live.map((r) => runLine(r, host().progress(r.id))),
        recent: recent.map((r) => `${r.id} · ${r.path} · ${r.status}${r.stoppedBy ? ` (${r.stoppedBy})` : ""} · ${Math.round(r.ms / 100) / 10}s · +${r.created}`),
      };
    },
  });

  const logs = defineCommand({
    id: "script.logs",
    summary: "A run's console lines since a cursor — poll a long build a few lines at a time. Pass back `next` as `since`.",
    effect: "read",
    input: z.object({
      runId: z.string(),
      since: z.number().int().min(0).optional().describe("The `next` from the last call; omitted = the last `tail` lines."),
      tail: z.number().int().min(1).max(200).optional().describe("At most this many lines (the newest). Default 20."),
    }),
    async run(input) {
      const r = find(input.runId);
      const all = logLines(r);
      const tail = input.tail ?? 20;
      const from = Math.min(all.length, input.since ?? Math.max(0, all.length - tail));
      const fresh = all.slice(from);
      const lines = fresh.slice(-tail);
      const over = r.status !== "running" && r.status !== "queued";
      return {
        status: r.status,
        lines,
        next: all.length,
        ...(fresh.length > lines.length ? { skipped: fresh.length - lines.length } : {}),
        ...(r.dropped ? { droppedLogs: r.dropped } : {}),
        // Finished: the outcome rides along, so the last poll is the report.
        ...(over ? { result: runReport(r, 0, { logs: false }) } : {}),
      };
    },
  });

  const stop = defineCommand({
    id: "script.stop",
    summary: "Stop a script run by id, running or still queued. What it already made stays and is listed.",
    effect: "read",
    input: z.object({ runId: z.string() }),
    async run(input) {
      const r = find(input.runId);
      if (r.status !== "running" && r.status !== "queued") return runReport(r, 0, { logs: false });
      const stopped = host().stopRun(r.id, "agent");
      return runReport(stopped ?? find(r.id), 0, { logs: false });
    },
  });

  return [run, runs, logs, stop];
}

/**
 * `window.ac` in the browser's own DevTools — the same verbs on the main
 * thread, for whoever already lives in that console. Real objects, not a
 * Proxy, so DevTools autocompletes them.
 */
export function exposeToDevtools(registry: () => CommandRegistry, store: () => CommandContext["store"] | null): void {
  if (typeof window === "undefined") return;
  const ac: Record<string, unknown> = {};
  for (const def of registry().list().filter(scriptCallable)) {
    const parts = def.id.split(".");
    let node = ac;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>;
    node[parts.at(-1)!] = async (input: unknown = {}) => {
      const s = store();
      if (!s) throw new Error("No document is open.");
      const res = await registry().call(def.id, input, { store: s, actor: "Console", session: editorApiSession() });
      if (!res.ok) throw new Error(`${def.id}: ${res.error}${res.hint ? `\n${res.hint}` : ""}`);
      return res.value;
    };
  }
  ac.help = (id = "") => console.info(helpText(registry(), id));
  (window as unknown as { ac: unknown }).ac = ac;
}
