"use client";

/**
 * OS WINDOWS on the web/PWA: `window.open` of a same-origin blank page, the
 * editor rendered into it through `createPortal` (`OsWindowHost.tsx`). One JS
 * realm, one set of stores — nothing to sync, because nothing is copied.
 *
 * What a portal into another document needs, and gets here:
 *   • STYLES — the child has none. Every <style> and <link rel=stylesheet>
 *     is cloned in, and a MutationObserver keeps mirroring the ones Next/HMR
 *     and Tailwind add later; the root's attributes (theme, glass, density
 *     variables) are copied and kept in sync, because every token hangs off
 *     `:root`.
 *   • KEYS — shortcuts are bound on the MAIN window. Keydowns in the child
 *     are re-dispatched there (unless a field in the child is typing), so
 *     ⌘Z, space-to-play and the rest work wherever the editor is.
 *   • CLOSING — the child's `pagehide` (the user closed it) calls `onClose`,
 *     and the editor returns HOME. The main window unloading closes children.
 *
 * Tauri: `WebviewWindow` is a separate webview with its own realm — a portal
 * cannot reach it, so the support check returns "none" and the menu hides
 * the entry. Shipping it needs a state-sync protocol (out of scope).
 */

import { identity } from "@/editor/identity";
import type { Bounds } from "./layout-tree";
import type { OsWindowHandle, OsWindowSupport } from "./window-host";
import { NAMES } from "@/editor/names";

export function osWindowSupport(): OsWindowSupport {
  if (typeof window === "undefined") return "none";
  // Tauri injects these; its webviews do not share a realm.
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI__ || w.__TAURI_INTERNALS__) return "none";
  // An installed iOS PWA cannot open a second window at all.
  const standaloneIOS = (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (standaloneIOS) return "none";
  return "portal";
}

function copyStyles(from: Document, to: Document): MutationObserver {
  const clone = (node: Node) => {
    if (node instanceof HTMLStyleElement || (node instanceof HTMLLinkElement && node.rel === "stylesheet")) {
      const copy = to.importNode(node, true) as HTMLElement;
      // A relative href must resolve against the opener's URL.
      if (copy instanceof HTMLLinkElement && node instanceof HTMLLinkElement) copy.href = node.href;
      copy.dataset.mirrored = "1";
      to.head.appendChild(copy);
    }
  };
  from.querySelectorAll("style, link[rel='stylesheet']").forEach(clone);
  const mo = new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(clone);
  });
  mo.observe(from.head, { childList: true });
  return mo;
}

function syncRootAttributes(from: HTMLElement, to: HTMLElement): MutationObserver {
  const copy = () => {
    for (const a of Array.from(to.attributes)) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
    for (const a of Array.from(from.attributes)) to.setAttribute(a.name, a.value);
  };
  copy();
  const mo = new MutationObserver(copy);
  mo.observe(from, { attributes: true });
  return mo;
}

const TYPING = "input, textarea, select, [contenteditable='true'], [contenteditable='']";

export function openOsWindow(opts: { key: string; title: string; bounds: Bounds; onClose: () => void }): OsWindowHandle | null {
  if (osWindowSupport() !== "portal") return null;
  const { bounds } = opts;
  const features = `popup=yes,width=${Math.round(bounds.width)},height=${Math.round(bounds.height)},left=${Math.round(window.screenX + bounds.x)},top=${Math.round(window.screenY + bounds.y)}`;
  const child = window.open("", NAMES.wire.osWindow(opts.key), features);
  if (!child) return null;
  const doc = child.document;
  doc.title = `${opts.title} — ${identity.name}`;
  // A blank page has no viewport / charset; give it the same as ours.
  if (!doc.querySelector("meta[charset]")) {
    const m = doc.createElement("meta");
    m.setAttribute("charset", "utf-8");
    doc.head.appendChild(m);
  }
  const styles = copyStyles(document, doc);
  const root = syncRootAttributes(document.documentElement, doc.documentElement);
  doc.body.className = document.body.className;
  doc.body.style.margin = "0";
  doc.body.style.height = "100vh";
  doc.body.style.overflow = "hidden";
  doc.body.style.background = "var(--background)";
  const container = doc.createElement("div");
  container.style.height = "100%";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  doc.body.appendChild(container);

  const forward = (e: KeyboardEvent) => {
    const t = e.target as Element | null;
    if (t?.closest?.(TYPING)) return;
    const copy = new KeyboardEvent(e.type, e);
    window.dispatchEvent(copy);
    if (copy.defaultPrevented) e.preventDefault();
  };
  child.addEventListener("keydown", forward);
  child.addEventListener("keyup", forward);

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    styles.disconnect();
    root.disconnect();
    window.removeEventListener("pagehide", closeChild);
    opts.onClose();
  };
  const closeChild = () => {
    try {
      child.close();
    } catch {
      // already gone
    }
  };
  child.addEventListener("pagehide", finish);
  window.addEventListener("pagehide", closeChild);

  return {
    container,
    window: child,
    close: () => {
      // Closing from our side is not "the user closed it": tear down without
      // the return-home callback, which the caller is already handling.
      closed = true;
      styles.disconnect();
      root.disconnect();
      window.removeEventListener("pagehide", closeChild);
      closeChild();
    },
    focus: () => child.focus(),
  };
}
