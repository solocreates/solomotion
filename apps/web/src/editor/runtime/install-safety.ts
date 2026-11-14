"use client";

import { identity } from "@/editor/identity";
import { product } from "@/editor/product";
import {
  errors,
  errorPayloads,
  subjectLabel,
  reportError,
  diagnoseBlackBox,
  setYieldStrategy,
  snapshotBlackBox,
  supervisor,
  taskKind,
  watchdog,
  type BlackBox,
  type ErrorReport,
  type FreezeRecord,
} from "@solomotion/core";
import { pushLog, setErrorSink } from "@solomotion/platform";
import { useStatusBar } from "../state/status-bar";
import { useSession } from "../state/session";
import { APP_VERSION } from "../version";
import { useSafety } from "./safety-store";

/**
 * BOOTING THE SAFETY NET — the one place the headless runtime is plugged into
 * a real app: a heartbeat, a black box, and the two sentences a person
 * actually needs when something goes wrong.
 *
 * Everything here is a wire, not a rule. The decisions (what counts as a
 * freeze, which task is the suspect, whether a session ended badly) are all in
 * `@solomotion/core/runtime`, where they can be tested against a fake clock
 * instead of a browser.
 */

/** How often the thread checks in. Fine enough to time a freeze, idle enough to ignore. */
const BEAT_MS = 250;
/** The black box is rewritten at most this often — it is a synchronous storage write. */
const BOX_MS = 1_000;
const BOX_KEY = "tm-blackbox";
/** How long after a freeze it still explains a session that dies. */
const RECENT_FREEZE_MS = 30_000;

let installed = false;

export function installSafety(): () => void {
  if (installed || typeof window === "undefined") return () => {};
  installed = true;

  upgradeYield();
  const stopErrors = routeErrors();
  reportLastSession();

  const announced = new Set<string>();
  let lastBoxAt = 0;
  let boxWritten = false;

  const stopFreezes = watchFreezes();

  const beat = window.setInterval(() => {
    // Deadlines for bodies that cannot check their own clock, plus a flush of
    // any progress that was coalesced since the last beat.
    supervisor.pump();

    surfaceLongTasks(announced);

    // The black box only exists while there is something to explain: work in
    // flight, or a freeze recent enough to explain a kill. A freeze an hour ago
    // does not explain a tab the browser discards now, and kept the box alive
    // all session — so every unclean exit read as "ended unexpectedly".
    const lastFreeze = watchdog.freezes()[0];
    const busy =
      supervisor.running().length > 0 ||
      (lastFreeze !== undefined && performance.now() - lastFreeze.at < RECENT_FREEZE_MS);
    const t = Date.now();
    if (busy && t - lastBoxAt >= BOX_MS) {
      lastBoxAt = t;
      boxWritten = true;
      writeBox(snapshotBlackBox(APP_VERSION));
    } else if (!busy && boxWritten) {
      boxWritten = false;
      clearBox();
    }
  }, BEAT_MS);

  // A deliberate close is not a crash. A tab the browser kills from the
  // "Page unresponsive" sheet never gets here, which is exactly the asymmetry
  // that makes a surviving box mean something.
  const onHide = () => clearBox();
  window.addEventListener("pagehide", onHide);

  return () => {
    window.clearInterval(beat);
    window.removeEventListener("pagehide", onHide);
    stopFreezes();
    stopErrors();
    installed = false;
  };
}

/**
 * WHERE FREEZE EVIDENCE COMES FROM.
 *
 * Chromium (Chrome, Edge, the desktop app) reports every task that held the
 * thread over 50ms through the Long Tasks API — the exact duration of real
 * work, which a hidden window, App Nap or a sleeping laptop cannot fake,
 * because a throttled page runs nothing. There, that is the only evidence.
 *
 * Elsewhere (Safari, Firefox) the heartbeat measures its own lateness, and
 * every moment the page could not run for reasons that are not ours —
 * hidden, frozen by the browser, restored from the back-forward cache — is
 * declared to the watchdog so the gap is thrown away rather than reported.
 *
 * A freeze goes to the Console and Activity, and rides along in bug reports.
 * It never interrupts: the person was there, they felt it, and a status line
 * announcing it after the fact only makes a stable app feel shaky.
 */
function watchFreezes(): () => void {
  const types = typeof PerformanceObserver === "undefined" ? [] : (PerformanceObserver.supportedEntryTypes ?? []);
  if (types.includes("longtask")) {
    const observer = new PerformanceObserver((list) => {
      const { config } = useSafety.getState();
      if (!config.watchdog) return;
      for (const entry of list.getEntries()) {
        const freeze = watchdog.block({
          startedAt: entry.startTime,
          durationMs: entry.duration,
          freezeMs: config.freezeMs,
        });
        if (freeze) logFreeze(freeze);
      }
    });
    observer.observe({ type: "longtask", buffered: false });
    return () => observer.disconnect();
  }

  const suspend = () => watchdog.suspend();
  const events = ["visibilitychange", "freeze", "resume"] as const;
  for (const e of events) document.addEventListener(e, suspend);
  window.addEventListener("pageshow", suspend);

  const beat = window.setInterval(() => {
    const { config } = useSafety.getState();
    // A hidden page's timers are throttled to the host's taste: nothing it
    // measures while hidden is about us.
    if (document.visibilityState === "hidden" || !config.watchdog) {
      watchdog.suspend();
      return;
    }
    const freeze = watchdog.beat({ freezeMs: config.freezeMs, expectedMs: BEAT_MS });
    if (freeze) logFreeze(freeze);
  }, BEAT_MS);

  return () => {
    window.clearInterval(beat);
    for (const e of events) document.removeEventListener(e, suspend);
    window.removeEventListener("pageshow", suspend);
  };
}

/**
 * ONE PATH from any failure to the person.
 *
 * Uncaught errors and rejections are claimed from the log bus and pushed
 * through core's funnel, so everything — a thrown string from a plugin, a
 * rejected decode, a real `ExportError` — arrives normalised, fingerprinted and
 * attributed to whatever clip or effect was in scope. Only then is it shown.
 *
 * A REPEAT never interrupts. The same failure sixty times a second is one
 * status line with a counter; the alternative is an app that shouts over itself
 * precisely when it is least usable.
 */
function routeErrors(): () => void {
  setErrorSink((value, source) => reportError(value, { source }));

  const stop = errors.subscribe((report, isNew) => {
    const { error } = report;
    // Into the Console either way — the log is the record, and a repeat is a
    // data point. The error object rides along so the row can expand.
    // The code and the message make the LINE; the error itself is the payload
    // the row expands into. Passing it as an arg would print it twice.
    pushLog(
      error.severity === "warning" ? "warn" : "error",
      [`[${error.code}] ${error.message}`],
      error,
    );
    // `announce: false` means the call site already said something better.
    if (!isNew || !error.announce || error.severity === "info") return;
    useStatusBar.getState().notify({
      id: `err-${report.fingerprint}`,
      kind: error.severity === "warning" ? "warning" : "error",
      text: error.userMessage,
      description: error.subject ? subjectLabel(error.subject) : error.code,
      action: { label: "Details", onClick: () => useSession.getState().setConsoleOpen(true) },
    });
  });

  return () => {
    setErrorSink(null);
    stop();
  };
}

// ── the parts ────────────────────────────────────────────────────────────────

/**
 * `scheduler.yield()` resumes the yielding task ahead of unrelated work the
 * page has queued, so chunked slices keep their turn instead of queueing
 * behind every stray message. Where it does not exist, core's own strategy
 * stands.
 */
function upgradeYield() {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") {
    setYieldStrategy(() => scheduler.yield!());
  }
}

function logFreeze(freeze: FreezeRecord) {
  const seconds = (freeze.durationMs / 1000).toFixed(1);
  const culprit = freeze.tasks[0]?.label ?? null;
  pushLog("warn", [
    `${identity.name} stopped responding for ${seconds}s`,
    culprit ? `while: ${culprit}` : "with nothing running",
  ]);
}

/**
 * A task that outruns its kind's patience gets one status line — with a Stop
 * button where stopping is safe. This is the difference between an app that
 * seems broken and one that is visibly busy, and it costs one line each.
 */
function surfaceLongTasks(announced: Set<string>) {
  const status = useStatusBar.getState();
  const live = new Set<string>();
  const t = performance.now();

  for (const task of supervisor.running()) {
    live.add(task.id);
    const warnMs = taskKind(task.kind)?.warnMs ?? 2_000;
    if (t - task.startedAt < warnMs) continue;
    announced.add(task.id);
    status.notify({
      id: `safety-task-${task.id}`,
      kind: "loading",
      text: task.overdue ? `${task.label} — taking longer than expected` : task.label,
      description: task.note ?? task.detail,
      action: task.cancellable
        ? { label: "Stop", onClick: () => supervisor.cancel(task.id) }
        : undefined,
    });
  }

  for (const id of [...announced]) {
    if (live.has(id)) continue;
    announced.delete(id);
    status.dismiss(`safety-task-${id}`);
  }
}

// ── the black box ────────────────────────────────────────────────────────────

function writeBox(box: BlackBox) {
  try {
    window.localStorage.setItem(BOX_KEY, JSON.stringify(box));
  } catch {
    // No storage, no post-mortem. Everything else still works.
  }
}

function clearBox() {
  try {
    window.localStorage.removeItem(BOX_KEY);
  } catch {
    // ignore
  }
}

function readBox(): BlackBox | null {
  try {
    const raw = window.localStorage.getItem(BOX_KEY);
    return raw ? (JSON.parse(raw) as BlackBox) : null;
  } catch {
    return null;
  }
}

/**
 * If the last session left its black box behind, it did not close cleanly.
 * Said once, on the status bar, naming what was in flight — and then cleared,
 * so it is a report and not a recurring accusation.
 */
function reportLastSession() {
  const box = readBox();
  clearBox();
  const verdict = diagnoseBlackBox(box);
  if (!verdict.crashed) return;
  pushLog("warn", [
    "Previous session ended without closing cleanly",
    verdict.culprit ? `last activity: ${verdict.culprit}` : "",
  ]);
  useStatusBar.getState().notify({
    id: "safety-last-session",
    kind: "warning",
    text: "Last session ended unexpectedly",
    description: verdict.culprit ? `While ${verdict.culprit}` : undefined,
    // The person who just lost work is the best bug report we will get; the
    // way to send it beats a way to change settings.
    action: {
      label: "Report",
      onClick: () =>
        product.feedback.open("bug", {
          note: `Previous session ended unexpectedly${verdict.culprit ? ` while ${verdict.culprit}` : ""}.`,
        }),
    },
  });
}
