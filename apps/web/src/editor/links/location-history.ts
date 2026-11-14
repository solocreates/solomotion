"use client";

import { platform } from "@/editor/platform";
import { formatRoute, parseRoute, type Route } from "@solomotion/core";

/**
 * BACK AND FORWARD — one interface, two adapters (ADR-links, "Location").
 *
 * The location writer (`use-url-sync`) records every place you stand; this
 * decides where that record LIVES:
 *
 *   browser  the History API. The address bar is the history, Back is the
 *            browser's own button, `popstate` moves you. Nothing to store.
 *   memory   the desktop shell, which serves one path and has no address bar.
 *            The same entries, kept here, stepped by ⌘[ / ⌘] and the mouse's
 *            back/forward buttons.
 *
 * Both record the same thing — a canonical route path — and both move you the
 * same way (`apply`), so the desktop can never drift from the web.
 */

export interface LocationHistory {
  /** A place you now stand. `push` = a navigation (Back should return here). */
  record(path: string, push: boolean): void;
  back(): void;
  forward(): void;
}

/** How a history step moves you — `goToLocation` / `followRoute`, wired in by the URL bridge. */
let apply: (route: Route) => void = () => {};
export function setHistoryApply(fn: (route: Route) => void): void {
  apply = fn;
}

function addressNow(): string {
  return `${window.location.pathname}${window.location.search}`;
}

const browser: LocationHistory = {
  record(path, push) {
    const route = parseRoute(path);
    const current = parseRoute(addressNow());
    // The router has not reached this project yet; its own push lands first
    // (and the writer is re-scheduled when it does).
    if (route.to !== "project" || current.to !== "project" || current.projectId !== route.projectId) return;
    // Keep what this build does not read (and the time a deep link carried).
    const next = formatRoute({ ...route, t: current.t, params: { ...current.params, ...route.params } });
    if (next === addressNow()) return;
    window.history[push ? "pushState" : "replaceState"](window.history.state, "", next);
  },
  back: () => window.history.back(),
  forward: () => window.history.forward(),
};

/** How many places the desktop remembers behind you. */
const MEMORY_CAP = 100;

function projectOf(path: string | undefined): string | null {
  const r = path ? parseRoute(path) : null;
  return r?.to === "project" ? r.projectId : null;
}

function createMemoryHistory(): LocationHistory {
  const entries: string[] = [];
  let index = -1;
  const step = (by: number) => {
    const at = index + by;
    if (at < 0 || at >= entries.length) return;
    index = at;
    apply(parseRoute(entries[at]!));
  };
  return {
    record(path, push) {
      // Arriving in another project is a navigation even when nothing marked it
      // (a tab click, an open from Home): the browser pushes there too.
      if (index < 0 || push || projectOf(entries[index]) !== projectOf(path)) {
        entries.splice(index + 1);
        entries.push(path);
        if (entries.length > MEMORY_CAP) entries.shift();
        index = entries.length - 1;
      } else entries[index] = path;
    },
    back: () => step(-1),
    forward: () => step(1),
  };
}

let memory: LocationHistory | null = null;

/** THE history this host keeps. */
export function locationHistory(): LocationHistory {
  if (!platform.app.isDesktop) return browser;
  return (memory ??= createMemoryHistory());
}
