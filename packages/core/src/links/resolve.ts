import type { MotionDocument, Clip, Link, NodeKey, TextClip } from "../schema";
import { isVisualClip } from "../clip-registry";
import { docIndex, type DocNode } from "../query/doc-index";
import { clipAncestorGroups } from "../timeline/groups";
import { INTERNAL_PAGE_ID, pageOfFrame } from "../pages";
import { parseDocKey, parseRoute, slugify, type Route } from "./address";
import { sameLink, safeHref } from "./target";

/**
 * THE LINK RESOLVER — a stored `Link` → what following it means, right now,
 * in this document. The canvas click, the Link section's chip, the PDF
 * exporter, the API's `link.follow` and the broken-link audit all ask here,
 * so "where does this go" and "is it broken" have one answer.
 */

export type LinkResolution =
  | { kind: "external"; href: string; newTab: boolean }
  | { kind: "node"; node: DocNode; t: number | null; newTab: boolean }
  | { kind: "route"; route: Route; newTab: boolean }
  | { kind: "broken"; reason: string }
  | { kind: "blocked"; reason: string };

export interface ResolveOptions {
  /** ⌘-click / a middle click: the reader asked for a new tab whatever the link says. */
  forceNew?: boolean;
}

const nodeCache = new WeakMap<MotionDocument, Map<string, DocNode>>();

/** A doc-index key → its node (internal comps included — a nested comp is a place). */
export function nodeByKey(doc: MotionDocument, key: string): DocNode | null {
  let map = nodeCache.get(doc);
  if (!map) {
    map = new Map(docIndex(doc).map((n) => [n.key, n]));
    nodeCache.set(doc, map);
  }
  return map.get(key) ?? null;
}

/** Why a key resolves to nothing, in the words the Link section shows. */
function missingReason(key: string): string {
  const kind = parseDocKey(key)?.kind;
  return kind === "page" ? "Page deleted" : kind === "frame" ? "Frame deleted" : "Layer deleted";
}

export function resolveLink(doc: MotionDocument, link: Link, opts: ResolveOptions = {}): LinkResolution {
  const t = link.target;
  const pick = (auto: boolean) => opts.forceNew || (link.open === "auto" ? auto : link.open === "new");
  switch (t.kind) {
    case "url": {
      const href = safeHref(t.href);
      if (!href) return { kind: "blocked", reason: "Only web, email and phone links open" };
      return { kind: "external", href, newTab: pick(true) };
    }
    case "node": {
      const node = nodeByKey(doc, t.node);
      if (!node) return { kind: "broken", reason: missingReason(t.node) };
      return { kind: "node", node, t: t.t, newTab: pick(false) };
    }
    case "route": {
      const route = parseRoute(t.path);
      return { kind: "route", route, newTab: pick(false) };
    }
  }
}

/** Is this link's target gone? (A blocked href counts — it can never be followed.) */
export function isBrokenLink(doc: MotionDocument, link: Link): boolean {
  const r = resolveLink(doc, link);
  return r.kind === "broken" || r.kind === "blocked";
}

// ── Where a node is, as an address ─────────────────────────────────────────

/** The page a node stands on (a page is its own). */
export function pageOfNode(doc: MotionDocument, node: DocNode): string | null {
  if (node.kind === "page") return node.id;
  if (node.pageId && node.pageId !== INTERNAL_PAGE_ID) return node.pageId;
  // A layer or comp on the internal shelf: the page of the frame showing it.
  const frame = doc.frames.find((f) => f.id === node.frameId);
  return frame ? pageOfFrame(doc, frame) : null;
}

/** The canonical project route for standing at `keys` (and `t`) — what the URL bar shows. */
export function projectRouteFor(
  doc: MotionDocument,
  projectId: string,
  keys: readonly NodeKey[],
  t: number | null = null,
  pageId?: string | null,
): Route & { to: "project" } {
  const first = keys[0] ? nodeByKey(doc, keys[0]) : null;
  const page = first ? pageOfNode(doc, first) : (pageId ?? null);
  const name = page ? doc.pages.find((p) => p.id === page)?.name : undefined;
  const slug = name ? slugify(name) || null : null;
  let at: NodeKey[] = [...keys];
  // Standing on a page: the id still rides along (the slug is only cosmetic),
  // unless the page is the first one, where the bare project URL already lands.
  if (at.length === 0 && page && page !== doc.pages[0]?.id) at = [`page:${page}`];
  if (at.length === 1 && first?.kind === "page" && page === doc.pages[0]?.id) at = [];
  return { to: "project", projectId, slug, at, t, params: {} };
}

export interface ProjectLocation {
  /** Where to stand (the first) and what to select (all layers). Empty = just the page. */
  nodes: DocNode[];
  /** The page the location is on. */
  pageId: string | null;
  t: number | null;
  /** Keys the route named that this document does not have. */
  missing: NodeKey[];
}

/**
 * A project route → a place in THIS document. Ids win; the page slug resolves
 * only when no id said where to stand (a hand-typed `/project/x/intro`), so a
 * renamed page's stale slug can never send you somewhere else.
 */
export function locateProjectRoute(doc: MotionDocument, route: Route & { to: "project" }): ProjectLocation {
  const nodes: DocNode[] = [];
  const missing: NodeKey[] = [];
  for (const key of route.at) {
    const n = nodeByKey(doc, key);
    if (n) nodes.push(n);
    else missing.push(key);
  }
  let pageId = nodes[0] ? pageOfNode(doc, nodes[0]) : null;
  if (!pageId && route.slug) {
    const want = route.slug.toLowerCase();
    pageId = doc.pages.find((p) => p.id !== INTERNAL_PAGE_ID && slugify(p.name) === want)?.id ?? null;
  }
  return { nodes, pageId, t: route.t, missing };
}

// ── Text links ──────────────────────────────────────────────────────────────

export interface LinkSpan {
  start: number;
  end: number;
  link: Link;
}

/**
 * The link runs of a text, DERIVED from its ranges: adjacent ranges carrying
 * an equal link are one run, however the styling split them. Nothing stores
 * spans, so nothing can disagree with the ranges about where a link is.
 */
export function linkSpans(clip: Pick<TextClip, "ranges">): LinkSpan[] {
  const out: LinkSpan[] = [];
  for (const r of [...clip.ranges].sort((a, b) => a.start - b.start)) {
    if (!r.link) continue;
    const last = out[out.length - 1];
    if (last && last.end === r.start && sameLink(last.link, r.link)) last.end = r.end;
    else out.push({ start: r.start, end: r.end, link: r.link });
  }
  return out;
}

/** The link on the grapheme at `index`, if any. */
export function textLinkAt(clip: Pick<TextClip, "ranges">, index: number): LinkSpan | null {
  return linkSpans(clip).find((s) => index >= s.start && index < s.end) ?? null;
}

/** The one link shared by every grapheme of [start, end) — "mixed"/none → null. */
export function sharedTextLink(clip: Pick<TextClip, "ranges">, start: number, end: number): Link | null {
  if (end <= start) return textLinkAt(clip, start)?.link ?? null;
  const spans = linkSpans(clip);
  const hit = spans.find((s) => s.start <= start && s.end >= end);
  return hit?.link ?? null;
}

// ── Which link a click means ────────────────────────────────────────────────

export interface LinkHit {
  link: Link;
  /** The layer carrying it. */
  clipId: string;
  /** Set when the link is a text run of that layer. */
  span: { start: number; end: number } | null;
}

/**
 * HTML's bubbling, for layers. `chain` is the click's target and the layers
 * hosting it, innermost first (the topmost painted layer, then the nested
 * comps it sits in, outward); `grapheme` is the letter under the pointer on
 * the innermost one when it is text. The first link met wins: the run's, then
 * the layer's own, then its groups', then the host's — so a shape on top of a
 * linked button is not a link, and a linked word inside a linked card goes
 * where the word says.
 */
export function linkForChain(
  doc: MotionDocument,
  chain: readonly string[],
  grapheme: number | null = null,
  clipOf: (id: string) => Clip | null = (id) => clipById(doc, id),
): LinkHit | null {
  for (let i = 0; i < chain.length; i++) {
    const clip = clipOf(chain[i]!);
    if (!clip) continue;
    if (i === 0 && grapheme !== null && clip.kind === "text") {
      const span = textLinkAt(clip, grapheme);
      if (span) return { link: span.link, clipId: clip.id, span: { start: span.start, end: span.end } };
    }
    if (isVisualClip(clip) && clip.link) return { link: clip.link, clipId: clip.id, span: null };
    for (const g of clipAncestorGroups(doc, clip.id)) {
      if (g.link) return { link: g.link, clipId: g.id, span: null };
    }
  }
  return null;
}

const clipCache = new WeakMap<MotionDocument, Map<string, Clip>>();
function clipById(doc: MotionDocument, id: string): Clip | null {
  let map = clipCache.get(doc);
  if (!map) {
    map = new Map();
    for (const t of doc.tracks) for (const c of t.clips) map.set(c.id, c);
    clipCache.set(doc, map);
  }
  return map.get(id) ?? null;
}

/**
 * What a press on a link does, by mode. Editing selects; ⌘ makes it a follow
 * (Word, Docs, VS Code). Viewing (the Hand tool, a reader, a presenter)
 * follows; ⌘ asks for a new tab. One policy, so a present mode is a value.
 */
export type LinkClickMode = "edit" | "view";
export function linkClickIntent(mode: LinkClickMode, mods: { mod: boolean }): "follow" | "follow-new" | null {
  if (mode === "view") return mods.mod ? "follow-new" : "follow";
  return mods.mod ? "follow" : null;
}

// ── Every link in a project ────────────────────────────────────────────────

export interface DocLink {
  clipId: string;
  frameId: string;
  /** A text run, or null for the layer's own link. */
  span: { start: number; end: number } | null;
  link: Link;
  resolution: LinkResolution;
}

/** Every link in the document, resolved — the broken-link audit and `link.list`. */
export function docLinks(doc: MotionDocument): DocLink[] {
  const out: DocLink[] = [];
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (!isVisualClip(c)) continue;
      if (c.link) out.push({ clipId: c.id, frameId: c.frameId, span: null, link: c.link, resolution: resolveLink(doc, c.link) });
      if (c.kind === "text") {
        for (const s of linkSpans(c)) {
          out.push({ clipId: c.id, frameId: c.frameId, span: { start: s.start, end: s.end }, link: s.link, resolution: resolveLink(doc, s.link) });
        }
      }
    }
  }
  return out;
}

/** A short human label for where a link goes — the chip, the callout, a toast. */
/** What a link says and where it goes, for a person. `appName` names the app itself ("Home · <app>"). */
export function describeLink(doc: MotionDocument, link: Link, appName: string): { label: string; where: string } {
  const r = resolveLink(doc, link);
  switch (r.kind) {
    case "external":
      return { label: r.href.replace(/^(https?:\/\/|mailto:|tel:)/, "").replace(/\/$/, ""), where: r.href.startsWith("mailto:") ? "Email" : r.href.startsWith("tel:") ? "Phone" : "Web" };
    case "node":
      return { label: r.node.name, where: r.node.kind === "page" ? "Page" : r.node.where };
    case "route":
      return r.route.to === "plugin"
        ? { label: r.route.pluginId, where: "Plugin" }
        : r.route.to === "project"
          ? { label: "Another project", where: "Project" }
          : r.route.to === "home"
            ? { label: "Home", where: appName }
            : { label: r.route.path, where: appName };
    case "broken":
    case "blocked":
      return { label: r.reason, where: "" };
  }
}
