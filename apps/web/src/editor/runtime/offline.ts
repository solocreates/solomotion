"use client";

import { identity } from "@/editor/identity";
import { onLazyFailure, retryFailedLazyModules, whenIdle } from "@solomotion/core";
import { useStatusBar } from "../state/status-bar";
import { useUpdate } from "../update/update-store";
import { NAMES } from "@/editor/names";

/**
 * OFFLINE — the editor's half of ADR-offline. The worker (public/sw.js)
 * precaches every file this build ships; this module registers it, knows when
 * this build is fully on disk, and makes the network's absence visible:
 *
 *   • a lazy chunk that cannot load says so on the status bar (offline: it
 *     loads when you reconnect; online: the update check runs first, since a
 *     newer deploy is the usual reason a chunk is gone), never a silent hole;
 *   • the network coming back retries every module that gave up, so the
 *     effect a frame skipped lands and repaints without anyone asking;
 *   • the first time a device can work offline, it is told once.
 *
 * The desktop shell runs this too: it loads the live deploy, so the same
 * worker serves its chunks when the connection drops mid-session — and lets
 * it relaunch offline on the same origin (the same projects).
 */

/** This build's id (next.config.ts) — the worker is registered per build. */
export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? null;

type Readiness = "unavailable" | "preparing" | "ready";

/** Whether THIS build is fully on disk — the worker says so, per build. */
let readiness: Readiness = "unavailable";

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const ANNOUNCED_KEY = NAMES.storage.offlineReady;
const NOTICE = "offline";
const CHUNK_NOTICE = "lazy-chunk";

/**
 * Production builds on a real origin. Not the dev server (its chunks are not
 * content-hashed), not the desktop's bundled snapshot (app://, on disk
 * already), not a browser without workers (the app still runs, online).
 */
function eligible(): boolean {
  if (process.env.NODE_ENV !== "production" || !BUILD_ID) return false;
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return false;
  return location.protocol === "https:" || LOOPBACK.test(location.hostname);
}

function setReadiness(next: Readiness): void {
  if (next === readiness) return;
  readiness = next;
  if (next !== "ready") return;
  try {
    if (localStorage.getItem(ANNOUNCED_KEY)) return;
    localStorage.setItem(ANNOUNCED_KEY, "1");
  } catch {
    return;
  }
  useStatusBar.getState().notify({ kind: "success", text: `${identity.name} now works offline` });
}

function register(): void {
  const sw = navigator.serviceWorker;
  sw.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as { type?: string; builds?: string[] } | null;
    if (data?.type === NAMES.wire.offline) setReadiness(data.builds?.includes(BUILD_ID!) ? "ready" : "preparing");
  });
  setReadiness("preparing");
  // After the editor is up: the precache is a background download and must
  // never compete with the first paint for bandwidth.
  whenIdle(() => {
    void sw
      .register(`/sw.js?build=${encodeURIComponent(BUILD_ID!)}&ns=${encodeURIComponent(NAMES.caches.prefix.slice(0, -1))}`, { scope: "/", updateViaCache: "none" })
      .then(() => sw.ready)
      .then((reg) => reg.active?.postMessage({ type: NAMES.wire.offlineQuery }))
      .catch((e) => {
        console.warn("[offline] the offline worker did not register:", e);
        setReadiness("unavailable");
      });
  });
}

function onOffline(): void {
  const ready = readiness === "ready";
  useStatusBar.getState().notify({
    id: NOTICE,
    kind: ready ? "info" : "warning",
    text: ready ? `You're offline — ${identity.name} keeps working` : "You're offline — some tools haven't downloaded yet",
  });
}

function onOnline(): void {
  const bar = useStatusBar.getState();
  bar.dismiss(NOTICE);
  bar.dismiss(CHUNK_NOTICE);
  reported.clear();
  retryFailedLazyModules();
}

/** One reaction per module until the network changes — a frame re-asks every repaint. */
const reported = new Set<string>();

function onChunkMissing(id: string): void {
  if (reported.has(id)) return;
  reported.add(id);
  console.warn(`[offline] ${id} could not be loaded`);
  const retry = {
    label: "Retry",
    onClick: () => {
      reported.clear();
      retryFailedLazyModules();
    },
  };
  if (!navigator.onLine) {
    useStatusBar.getState().notify({ id: CHUNK_NOTICE, kind: "warning", text: `Offline — this part of ${identity.name} loads when you reconnect`, action: retry });
    return;
  }
  // Online and still gone: usually a newer deploy replaced it under this tab.
  // The check offers the reload that brings matching chunks; if there is no
  // newer build, the connection is the suspect.
  void useUpdate
    .getState()
    .check()
    .then(() => {
      if (useUpdate.getState().phase === "available") return;
      useStatusBar.getState().notify({ id: CHUNK_NOTICE, kind: "warning", text: `Part of ${identity.name} didn't load — check your connection`, action: retry });
    });
}

/** Boot once, from ClientEditor. Returns the teardown. */
export function installOffline(): () => void {
  if (eligible()) register();
  const stopFailures = onLazyFailure((f) => f.missingChunk && onChunkMissing(f.version ? `${f.id}@${f.version}` : f.id));
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  return () => {
    stopFailures();
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
  };
}
