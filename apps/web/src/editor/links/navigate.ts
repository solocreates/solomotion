"use client";

import { identity } from "@/editor/identity";
import { create } from "zustand";
import { platform } from "@/editor/platform";
import {
  locateProjectRoute,
  projectRouteFor,
  resolveLink,
  webUrlOf,
  formatRoute,
  type MotionDocument,
  type DocNode,
  type DocumentStore,
  type Link,
  type NodeKey,
  type ParseTargetContext,
  type ProjectLocation,
  type Route,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { useSession } from "../state/session";
import { goToPage, switchPage } from "../state/frame-nav";
import { revealAsNavigation } from "../state/selection-reveal";
import { useAppShell } from "../state/app-shell";
import { openWorldFrame } from "../world/make-3d";
import { useWorldUi } from "../world/state";
import { usePluginWindows } from "../plugins/plugin-windows";
import { ENGINE } from "@/editor/names";

/** What "this project" and "this app" are when reading a typed or pasted address. */
export function linkParseContext(projectId = useAppShell.getState().view === "editor" ? useAppShell.getState().currentProjectId : null): ParseTargetContext {
  return { projectId, app: ENGINE, origins: typeof window === "undefined" ? [] : [window.location.origin] };
}

/**
 * GOING SOMEWHERE — the app half of links and routing (ADR-links). THE one
 * in-app navigator: ⌘P's "go to", a followed link, a pasted deep URL, browser
 * Back and an agent all end in `goToLocation`, so standing in a frame, opening
 * a world and selecting a layer happen one way whoever asked.
 *
 * Core answers WHERE (`resolveLink`, `locateProjectRoute`); this file only
 * moves the session there.
 */

/**
 * Was the last navigation one a person would expect Back to undo? Set by the
 * verbs below, read (and cleared) by the URL bridge, which then PUSHES a
 * history entry instead of replacing the current one. A selection change is
 * not a navigation; following a link, ⌘P and switching page are.
 */
export const useLinkNav = create<{
  push: boolean;
  /** A place to stand once the project being opened has loaded. */
  pending: { projectId: string; route: Route & { to: "project" } } | null;
  markPush: () => void;
  takePush: () => boolean;
  setPending: (p: { projectId: string; route: Route & { to: "project" } } | null) => void;
}>((set, get) => ({
  push: false,
  pending: null,
  markPush: () => set({ push: true }),
  takePush: () => {
    const v = get().push;
    if (v) set({ push: false });
    return v;
  },
  setPending: (pending) => set({ pending }),
}));

/**
 * Stand in a comp: a nested one is entered in its parent's context; a world
 * opens its viewport. Every verb here ends in `revealAsNavigation` — going
 * somewhere moves the canvas there, the one way every navigation does.
 */
function goToFrame(store: DocumentStore, frameId: string, t: number | null): void {
  const frame = store.getState().frames.find((f) => f.id === frameId);
  if (!frame) return;
  if (frame.world) return openWorldFrame(store, frame.id);
  const session = useSession.getState();
  session.revealFrame(frame.id, t ?? undefined);
  session.selectFrame(frame.id);
  revealAsNavigation();
}

/** Stand where layers live, with them selected (the first one's comp wins). */
function goToLayers(store: DocumentStore, layers: DocNode[], t: number | null): void {
  const first = layers[0]!.clip!;
  const ids = layers.filter((n) => n.clip?.frameId === first.frameId).map((n) => n.id);
  const home = store.getState().frames.find((f) => f.id === first.frameId);
  if (home?.world) return openWorldFrame(store, home.id, ids);
  const session = useSession.getState();
  session.revealFrame(first.frameId, t ?? undefined);
  session.select(ids);
  revealAsNavigation();
}

/**
 * Stand at a place in the OPEN project. `nodes[0]` says where; further layers
 * join the selection. Out of a world's viewport first when the target is
 * elsewhere — the reveal derives the rest of the path.
 */
export function goToLocation(store: DocumentStore, loc: Pick<ProjectLocation, "nodes" | "pageId" | "t">): void {
  const first = loc.nodes[0];
  const openWorld = useWorldUi.getState().openId;
  if (openWorld && !(first && first.kind === "world" && first.id === openWorld)) useWorldUi.getState().set({ openId: null });
  if (!first) {
    // An address that names no node is standing on a page with nothing
    // picked — the first page when it names none (the bare project URL).
    const session = useSession.getState();
    const doc = store.getState();
    switchPage(doc, loc.pageId ?? doc.pages[0]!.id);
    session.select([]);
    session.selectFrame(null);
    return;
  }
  if (first.kind === "page") return goToPage(store.getState(), first.id);
  if (loc.pageId) switchPage(store.getState(), loc.pageId);
  if (first.clip) return goToLayers(store, loc.nodes.filter((n) => n.clip), loc.t);
  if (first.frame) return goToFrame(store, first.id, loc.t);
}

/** ⌘P and the pickers: go to one node, as a navigation (Back returns). */
export function goToNode(store: DocumentStore, node: DocNode, t: number | null = null): void {
  useLinkNav.getState().markPush();
  goToLocation(store, { nodes: [node], pageId: null, t });
}

/** The open project's id, or null on Home. */
function currentProjectId(): string | null {
  const shell = useAppShell.getState();
  return shell.view === "editor" ? shell.currentProjectId : null;
}

/** Open a URL outside the app (or this app's own URL in a new tab). */
function openExternal(href: string, newTab: boolean): void {
  // The desktop shell has one window and routes window.open to the system
  // browser; leaving it in place would replace the editor with a web page.
  if (newTab || platform.app.isDesktop) window.open(href, "_blank", "noopener,noreferrer");
  else window.location.assign(href);
}

/** Follow an app route — another project, a plugin, home. */
export function followRoute(store: DocumentStore, route: Route, opts: { newTab?: boolean } = {}): void {
  switch (route.to) {
    case "home":
      useAppShell.getState().goHome();
      return;
    case "plugin":
      usePluginWindows.getState().open(route.pluginId, route.params);
      return;
    case "unknown":
      toast.error(`This link needs a newer ${identity.name}.`);
      return;
    case "project": {
      if (opts.newTab && !platform.app.isDesktop) return openExternal(formatRoute(route), true);
      useLinkNav.getState().markPush();
      if (route.projectId === currentProjectId()) {
        const loc = locateProjectRoute(store.getState(), route);
        if (loc.missing.length && !loc.nodes.length) toast.error("That part of the project was deleted.");
        return goToLocation(store, loc);
      }
      useLinkNav.getState().setPending({ projectId: route.projectId, route });
      useAppShell.getState().openProject(route.projectId);
      return;
    }
  }
}

/**
 * FOLLOW A LINK — what a click on one does, everywhere. `forceNew` is the
 * reader asking for a new tab (⌘-click while viewing).
 */
export function followLink(store: DocumentStore, link: Link, opts: { forceNew?: boolean } = {}): void {
  const doc = store.getState();
  const r = resolveLink(doc, link, { forceNew: opts.forceNew });
  switch (r.kind) {
    case "external":
      return openExternal(r.href, r.newTab);
    case "broken":
    case "blocked":
      toast.error(r.reason);
      return;
    case "route":
      return followRoute(store, r.route, { newTab: r.newTab });
    case "node": {
      const projectId = currentProjectId();
      if (r.newTab && projectId && !platform.app.isDesktop) {
        return openExternal(formatRoute(projectRouteFor(doc, projectId, [r.node.key], r.t)), true);
      }
      return goToNode(store, r.node, r.t);
    }
  }
}

/**
 * A route as a URL someone can open: this web app's own origin (the dev
 * server included), or the web app's when the desktop shell — which has no
 * address of its own — hands one out.
 */
export function appUrlFor(route: Route): string {
  return platform.app.isDesktop || !/^https?:/.test(window.location.origin) ? webUrlOf(route, ENGINE.webOrigin) : `${window.location.origin}${formatRoute(route)}`;
}

/** The shareable URL for standing at `keys` in the open project. */
export function linkUrlFor(doc: MotionDocument, keys: readonly NodeKey[], t: number | null = null): string | null {
  const projectId = currentProjectId();
  return projectId ? appUrlFor(projectRouteFor(doc, projectId, keys, t)) : null;
}

/** Copy a link to `keys` — the context menu's "Copy link". */
export async function copyLinkTo(store: DocumentStore, keys: readonly NodeKey[], t: number | null = null): Promise<void> {
  const url = linkUrlFor(store.getState(), keys, t);
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied");
  } catch {
    toast.error("Couldn't reach the clipboard.");
  }
}
