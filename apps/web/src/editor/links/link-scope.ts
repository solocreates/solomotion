"use client";

import {
  applyRangePatch,
  isVisualClip,
  locateClip,
  sameLink,
  sharedTextLink,
  textLinkAt,
  type MotionDocument,
  type DocumentStore,
  type Link,
} from "@solomotion/core";
import { useSession, type TextSelection } from "../state/session";

/**
 * WHAT A LINK EDIT TARGETS right now — the same question the Design tab, ⇧⌘U,
 * ⌘K in the text editor and the context menu all ask, answered once:
 *
 *   typing, with letters selected   → that run
 *   typing, caret inside a link     → that link's whole run (Docs, Notion)
 *   otherwise                       → the selected layers (all of them)
 */
export type LinkScope =
  | { kind: "range"; clipId: string; start: number; end: number }
  | { kind: "layers"; clipIds: string[] };

/** What the scope is read from — a view passes the values it subscribed to. */
export interface LinkScopeInputs {
  editingClipId: string | null;
  textSelection: TextSelection | null;
  selectedClipIds: string[];
}

export function currentLinkScope(doc: MotionDocument, s: LinkScopeInputs = useSession.getState()): LinkScope | null {
  if (s.editingClipId) {
    const loc = locateClip(doc, s.editingClipId);
    const sel = s.textSelection;
    if (loc?.clip.kind === "text" && sel) {
      if (sel.end > sel.start) return { kind: "range", clipId: loc.clip.id, start: sel.start, end: sel.end };
      const span = textLinkAt(loc.clip, sel.start) ?? (sel.start > 0 ? textLinkAt(loc.clip, sel.start - 1) : null);
      if (span) return { kind: "range", clipId: loc.clip.id, start: span.start, end: span.end };
    }
  }
  const ids = s.selectedClipIds.filter((id) => {
    const c = locateClip(doc, id)?.clip;
    return c && isVisualClip(c);
  });
  return ids.length ? { kind: "layers", clipIds: ids } : null;
}

/** The scope's link: the one they share, `mixed` when they disagree. */
export function linkOfScope(doc: MotionDocument, scope: LinkScope): { link: Link | null; mixed: boolean } {
  if (scope.kind === "range") {
    const clip = locateClip(doc, scope.clipId)?.clip;
    return { link: clip?.kind === "text" ? sharedTextLink(clip, scope.start, scope.end) : null, mixed: false };
  }
  const links = scope.clipIds.map((id) => {
    const c = locateClip(doc, id)?.clip;
    return c && isVisualClip(c) ? (c.link ?? null) : null;
  });
  const first = links[0] ?? null;
  const mixed = links.some((l) => !sameLink(l, first));
  return { link: mixed ? null : first, mixed };
}

/** Write (or with `null`, remove) the scope's link — one undo step. */
export function setScopeLink(store: DocumentStore, scope: LinkScope, link: Link | null): void {
  store.update(link ? "Add link" : "Remove link", (d) => {
    if (scope.kind === "range") {
      const c = locateClip(d, scope.clipId)?.clip;
      if (c?.kind === "text") c.ranges = applyRangePatch(c.ranges, scope.start, scope.end, { link });
      return;
    }
    for (const id of scope.clipIds) {
      const c = locateClip(d, id)?.clip;
      if (!c || !isVisualClip(c)) continue;
      if (link) c.link = link;
      else delete c.link;
    }
  });
}
