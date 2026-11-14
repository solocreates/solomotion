"use client";

import { ENGINE } from "@/editor/names";
import * as React from "react";
import { usePathname } from "next/navigation";
import { platform } from "@/editor/platform";
import {
  appPathOf,
  collectFontFamilies,
  formatRoute,
  locateProjectRoute,
  nodeByKey,
  parseRoute,
  projectRouteFor,
  type DocumentStore,
  type NodeKey,
  type Route,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { entityRef, supervise } from "@solomotion/core";
import { getProject, getProjectDocument, loadProjectIndex } from "./project-store";
import { flushAutosave } from "./autosave";
import { bindDocumentStore, makeResident, reconcileOpenedName } from "./project-index";
import { useAppShell } from "./app-shell";
import { useSession } from "./session";
import { ensureDocumentFaces } from "../stage/render/system-fonts";
import { followRoute, goToLocation, useLinkNav } from "../links/navigate";
import { locationHistory, setHistoryApply } from "../links/location-history";
import { rememberLocation, rememberedLocation } from "../links/location-memory";
import { useWorldUi } from "../world/state";

/** The address bar's path + query, as the app reads a route from it. */
function addressNow(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** Does a project route say where to stand, beyond "this project"? */
function namesAPlace(route: Route): route is Route & { to: "project" } {
  return route.to === "project" && (route.at.length > 0 || route.slug !== null);
}

/**
 * Stand where the arrival asked to, once a project has loaded. In order:
 * a followed cross-project link's place → the deep link this page was opened
 * on → where you last were in this project → (nothing: the first page).
 * Synchronous, right after the reset, so the location writer's first look
 * already sees the place and never overwrites a deep link with the default.
 */
function standAtArrival(store: DocumentStore, projectId: string): void {
  const pending = useLinkNav.getState().pending;
  let route: (Route & { to: "project" }) | null = pending?.projectId === projectId ? pending.route : null;
  if (pending) useLinkNav.getState().setPending(null);
  if (!route && !platform.app.isDesktop) {
    const fromUrl = parseRoute(addressNow());
    if (fromUrl.to === "project" && fromUrl.projectId === projectId && namesAPlace(fromUrl)) route = fromUrl;
  }
  if (!route) {
    const remembered = rememberedLocation(projectId);
    const back = remembered ? parseRoute(remembered) : null;
    if (back && back.to === "project" && back.projectId === projectId) route = back;
  }
  if (!route) return;
  const loc = locateProjectRoute(store.getState(), route);
  if (loc.missing.length && !loc.nodes.length) toast.error("That part of the project was deleted.");
  goToLocation(store, loc);
}

/** At most this many layers ride in a URL — a selection, not a dump. */
const URL_SELECTION_CAP = 12;

/**
 * Where you are, as doc-index keys: an open world, else the selection, else
 * the comp you have entered (a root frame is just the board, and the page says
 * that already).
 */
function locationKeys(store: DocumentStore): NodeKey[] {
  const doc = store.getState();
  const s = useSession.getState();
  const world = useWorldUi.getState().openId;
  if (world) return [`frame:${world}`];
  if (s.selectedClipIds.length) return s.selectedClipIds.slice(0, URL_SELECTION_CAP).map((id) => `clip:${id}` as const);
  if (s.selectedFrameIds.length) return s.selectedFrameIds.slice(0, URL_SELECTION_CAP).map((id) => `frame:${id}` as const);
  const active = s.activeFrameId ? nodeByKey(doc, `frame:${s.activeFrameId}`) : null;
  return active && active.kind === "comp" ? [active.key as NodeKey] : [];
}

/**
 * Bridges the URL and `useAppShell`'s {view, currentProjectId} — useAppShell
 * stays the ONE brain for "which screen / which project" (every existing
 * enterEditor/goHome call site keeps working unchanged); this hook is a thin
 * two-way sync, not a second source of truth.
 *
 * URL -> store: fires on a route change the store didn't already cause itself
 * (deep link, refresh, browser back/forward) and loads the project.
 * store -> URL: any enterEditor/goHome call (new project, import, Home open,
 * "go home") pushes the matching /project/[id] or / URL once it has already
 * taken effect locally, so it never races the load it triggers.
 */
/** How long opening a project may take before we give up and go Home. A big project parses in well under this. */
const OPEN_DEADLINE_MS = 15_000;

/** The one way out of a failed open: say why, drop its tab, go Home, nothing left pending. */
function abandonOpen(projectId: string, message: string): void {
  toast.error(message);
  const shell = useAppShell.getState();
  shell.closeTab(projectId);
  useAppShell.getState().goHome();
  // The editor's status bar is not on Home — say it where the user lands.
  useAppShell.getState().setHomeNotice(message);
}

export function useUrlSync(store: DocumentStore): void {
  // The project is read from the ADDRESS with the app's one route grammar, not
  // from the router's matched segments: every route renders the same shell
  // (the editor lives in the root layout), so the address is the whole truth —
  // and a shell served for any path (the offline worker's copy, ADR-offline)
  // still opens the project its URL names.
  const pathname = usePathname();
  const route = parseRoute(pathname);
  const urlProjectId = route.to === "project" ? route.projectId : null;

  const pendingProjectId = useAppShell((s) => s.pendingProjectId);

  /**
   * The id we last wrote INTO the URL. The router hears a push asynchronously,
   * so for a render or two after an in-app switch `usePathname` still reports
   * the previous project — and reading the URL as a source of truth in that
   * window made the app load the project it had just left, then load the new
   * one again (the T2 → T1 → T2 flicker). This ref lets the URL effect recognise its own echo
   * and ignore it.
   */
  const reflectingRef = React.useRef<string | null>(null);

  // ── URL → REQUEST ─────────────────────────────────────────────────────────
  // The URL never loads anything itself. It is one more caller of
  // `openProject`, exactly like clicking a tab, so there is a SINGLE request
  // channel (`pendingProjectId`) and a single loader below. Two sources of
  // truth updating on different clocks is what produced the flicker.
  React.useEffect(() => {
    const shell = useAppShell.getState();
    if (reflectingRef.current !== null) {
      // Still waiting for the router to catch up with what we wrote.
      if (urlProjectId !== reflectingRef.current) return;
      reflectingRef.current = null;
      return;
    }
    if (!urlProjectId) {
      // The desktop shell serves one static path, so `urlProjectId` is always
      // null there — an empty URL is not a request to go home, or opening any
      // project would immediately bounce back out of it.
      if (!platform.app.isDesktop && shell.view === "editor") shell.goHome();
      return;
    }
    if (urlProjectId === shell.currentProjectId) {
      if (shell.view !== "editor") shell.openProject(urlProjectId);
      return;
    }
    if (urlProjectId === shell.pendingProjectId) return;
    shell.openProject(urlProjectId);
  }, [urlProjectId]);

  // ── REQUEST → DOCUMENT ────────────────────────────────────────────────────
  // The one loader. Watches only `pendingProjectId`, so it cannot be re-armed
  // by a lagging URL.
  React.useEffect(() => {
    if (!pendingProjectId) return;
    const loadedId = useAppShell.getState().currentProjectId;

    if (pendingProjectId === loadedId) {
      useAppShell.getState().enterEditor(pendingProjectId);
      standAtArrival(store, pendingProjectId);
      return;
    }

    let cancelled = false;
    // Supervised: opening a project reads IndexedDB, migrates the document,
    // rebuilds every font face and replaces the store — the single heaviest
    // thing the app does, and until now the one the watchdog could only report
    // as an anonymous freeze. Named here, it shows up in Activity while it runs
    // and IN the freeze report if it blocks.
    void supervise(
      {
        kind: "document",
        label: "Open project",
        subject: entityRef("document", pendingProjectId),
      },
      async () => {
      // The open has ONE deadline and ONE way out. A record that is missing, a
      // document that will not parse, or a storage read that never answers
      // (IndexedDB blocked or corrupted after a crash) all land on Home with a
      // message — the loading screen can never stay up.
      const work = (async () => {
        // The outgoing project is on disk before the next one is read: the
        // autosave's flush (never rejects), the same one `makeResident` runs.
        await flushAutosave(store);
        const record = await getProject(pendingProjectId);
        if (cancelled) return "cancelled" as const;
        if (!record) return "missing" as const;
        let doc;
        try {
          doc = await getProjectDocument(pendingProjectId);
        } catch {
          return "unreadable" as const;
        }
        if (cancelled) return "cancelled" as const;
        if (!doc) return "missing" as const;
        ensureDocumentFaces(doc);
        reconcileOpenedName(doc, record.name);
        makeResident(store, pendingProjectId, doc);
        standAtArrival(store, pendingProjectId);
        return "opened" as const;
      })();
      const deadline = new Promise<"timeout">((resolve) => window.setTimeout(() => resolve("timeout"), OPEN_DEADLINE_MS));
      const outcome = await Promise.race([work, deadline]).catch(() => "unreadable" as const);
      if (cancelled || outcome === "cancelled") return;
      if (outcome === "opened") return useAppShell.getState().setSwitching(false);
      // A late answer after a timeout must not yank the user back out of Home.
      if (outcome === "timeout") cancelled = true;
      abandonOpen(
        pendingProjectId,
        outcome === "missing"
          ? "This project isn't in this browser — it may have been deleted, or made somewhere else."
          : outcome === "timeout"
            ? "This project took too long to open, so you're back Home. Try opening it again."
            : "Couldn't open this project — it may be from a newer version.",
      );
      },
    ).catch(() => {
      // The body already toasts and closes the tab on its own failures; this
      // is here so the supervised promise can never become an unhandled
      // rejection, which would surface as a full-page error overlay for a
      // problem the loader has already handled gracefully.
    });
    return () => {
      cancelled = true;
    };
  }, [pendingProjectId, store]);

  // ── THE PROJECT INDEX ─────────────────────────────────────────────────────
  // Names are derived, not synced (`project-index`): bind the one store so the
  // resident's name is followed live, and read every record's metadata once.
  React.useEffect(() => {
    void loadProjectIndex();
    return bindDocumentStore(store);
  }, [store]);

  // ── STORE → URL ───────────────────────────────────────────────────────────
  React.useEffect(() => {
    return useAppShell.subscribe((state, prev) => {
      // The desktop shell has no address bar and its static bundle can't serve
      // arbitrary /project/<id> paths — the store is the sole driver there, so
      // skip URL reflection entirely. The web app (the product's web origin) is a real
      // Worker that renders deep paths on demand, so it keeps shareable URLs.
      if (platform.app.isDesktop) return;
      if (state.view === prev.view && state.currentProjectId === prev.currentProjectId) return;
      const id = state.view === "editor" ? state.currentProjectId : null;
      const target = id ? `/project/${id}` : "/";
      // Already standing somewhere in that project (a deep link): leave it be.
      if (target === pathname || (id && pathname.startsWith(`${target}/`))) return;
      reflectingRef.current = id;
      // A history entry, not a router navigation: the segments render nothing,
      // so a navigation would only fetch an empty server payload — and with no
      // network, fall back to reloading the page. Next keeps `usePathname` and
      // Back in step with native pushState.
      window.history.pushState(null, "", target);
    });
  }, [pathname]);

  // ── LOCATION → MEMORY + URL ───────────────────────────────────────────────
  // Where you stand IN the project (ADR-links): the page, and `at` = the
  // selection, the comp you entered or the open world. ONE writer, every
  // platform: it remembers the place per project (a tab switch, a reopen, a
  // desktop restart come back to it) and records it in this host's history —
  // the address bar on the web, a memory on the desktop (`location-history`).
  // A navigation (a followed link, ⌘P, a page switch) PUSHES, so Back returns;
  // a selection change REPLACES, so history is not a click log.
  const scheduleRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    let timer: number | undefined;
    let lastPage = useSession.getState().activePageId;
    let lastProject = useAppShell.getState().currentProjectId;
    const write = () => {
      timer = undefined;
      const shell = useAppShell.getState();
      const projectId = shell.currentProjectId;
      if (shell.view !== "editor" || !projectId || shell.switching) return;
      const path = formatRoute(projectRouteFor(store.getState(), projectId, locationKeys(store), null, useSession.getState().activePageId));
      rememberLocation(projectId, path);
      locationHistory().record(path, useLinkNav.getState().takePush());
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(write, 120);
    };
    scheduleRef.current = schedule;
    const offSession = useSession.subscribe((s, prev) => {
      // Switching page is a navigation; the reset a project load does is not
      // (the open already pushed its own entry).
      const shell = useAppShell.getState();
      if (s.activePageId !== lastPage) {
        if (shell.currentProjectId === lastProject && !shell.switching) useLinkNav.getState().markPush();
        lastPage = s.activePageId;
      }
      lastProject = shell.currentProjectId;
      if (
        s.activePageId !== prev.activePageId ||
        s.activeFrameId !== prev.activeFrameId ||
        s.selectedClipIds !== prev.selectedClipIds ||
        s.selectedFrameIds !== prev.selectedFrameIds
      ) schedule();
    });
    const offWorld = useWorldUi.subscribe((s, prev) => {
      if (s.openId !== prev.openId) schedule();
    });
    return () => {
      window.clearTimeout(timer);
      scheduleRef.current = null;
      offSession();
      offWorld();
    };
  }, [store]);
  // The router landing on a project's bare URL (an open from Home) is the
  // writer's cue to say where in it you are.
  React.useEffect(() => {
    scheduleRef.current?.();
  }, [pathname]);

  // ── BACK / FORWARD → LOCATION ─────────────────────────────────────────────
  // How a history step moves you, for both histories (`location-history.ts`).
  // Inside the open project it stands you there; another project opens and
  // `standAtArrival` places you. Never a push on top: Forward would be lost.
  React.useEffect(() => {
    const step = (route: Route) => {
      const shell = useAppShell.getState();
      if (route.to === "project" && route.projectId === shell.currentProjectId && shell.view === "editor") {
        goToLocation(store, locateProjectRoute(store.getState(), route));
      } else if (platform.app.isDesktop) {
        // The web reaches another project through the URL → REQUEST path above.
        followRoute(store, route);
      }
      useLinkNav.setState({ push: false });
    };
    setHistoryApply(step);
    if (platform.app.isDesktop) {
      // A browser steps on the mouse's back/forward buttons by itself; the
      // desktop window is told to here.
      const onMouse = (e: MouseEvent) => {
        if (e.button !== 3 && e.button !== 4) return;
        e.preventDefault();
        if (e.button === 3) locationHistory().back();
        else locationHistory().forward();
      };
      window.addEventListener("mouseup", onMouse);
      return () => {
        window.removeEventListener("mouseup", onMouse);
        setHistoryApply(() => {});
      };
    }
    const onPop = () => step(parseRoute(addressNow()));
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      setHistoryApply(() => {});
    };
  }, [store]);

  // ── THE OS'S ADDRESS BAR ──────────────────────────────────────────────────
  // `<ns>://project/<id>/…` from another app (desktop), read by the same
  // grammar as every other address and followed by the same navigator.
  React.useEffect(
    () =>
      platform.deepLink.onOpen((url) => {
        const path = appPathOf(url, ENGINE);
        if (path !== null) followRoute(store, parseRoute(path));
      }),
    [store],
  );
}