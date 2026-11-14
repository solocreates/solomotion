import type { Link, LinkTarget } from "../schema";
import { appPathOf, formatRoute, type AppAddress, formatTimeParam, isDocKey, parseRoute, parseTimeParam } from "./address";

/**
 * What a person (or an agent) typed into a link field → a `LinkTarget`.
 *
 * ONE parser for the picker's paste row, the API's `target` string and the
 * URL-to-link paste, so "https://the product's web origin/project/<this>?at=frame:x"
 * becomes the same in-project node link however it arrives — and a
 * `javascript:` href becomes nothing, wherever it arrives. Templates and
 * shared projects carry links written by someone else; the scheme allow-list
 * is the one thing between a click and a script.
 */

/** Schemes a link may leave the app through. */
export const LINK_SCHEMES: readonly string[] = ["http:", "https:", "mailto:", "tel:"];

const EMAIL = /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/;
const PHONE = /^\+?[\d][\d\s().-]{5,}$/;
const DOMAINISH = /^(localhost|[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+)(:\d+)?([/?#].*)?$/u;

/**
 * A safe external href, normalised — `example.com` → `https://example.com`,
 * `a@example.com` → `mailto:a@example.com`, `+1 555 0100` → `tel:+15550100`. Null for
 * anything that is not one of `LINK_SCHEMES` (javascript:, data:, file:, …).
 */
export function safeHref(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // Only a phone number may contain spaces; anything else with one is prose.
  if (/\s/.test(s) && !PHONE.test(s.replace(/^tel:/i, ""))) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
  if (scheme) {
    if (!LINK_SCHEMES.includes(`${scheme}:`)) {
      // `localhost:3000/x` and `example.com:8080` read as a scheme; they are hosts.
      if (DOMAINISH.test(s)) return `https://${s}`;
      return null;
    }
    if (scheme === "tel") return `tel:${s.slice(4).replace(/[^\d+]/g, "")}`;
    if ((scheme === "http" || scheme === "https") && !/^https?:\/\/[^/\s]/i.test(s)) return null;
    return s;
  }
  if (EMAIL.test(s)) return `mailto:${s}`;
  if (PHONE.test(s)) return `tel:${s.replace(/[^\d+]/g, "")}`;
  if (DOMAINISH.test(s)) return `https://${s}`;
  return null;
}

export interface ParseTargetContext {
  /** The open project's id — its own URLs become in-project node links. */
  projectId?: string | null;
  /** This app's own addresses (its web origin and desktop scheme). */
  app?: AppAddress | null;
  /** Origins that count as this app besides the web app's (the dev server). */
  origins?: readonly string[];
}

/**
 * Parse a typed target. Order matters and is the whole design:
 * a node key → an app path / this app's URL (→ a node link when it points
 * into THIS project at one node) → a safe external href → nothing.
 */
export function parseLinkTarget(input: string, ctx: ParseTargetContext = {}): LinkTarget | null {
  const s = input.trim();
  if (!s) return null;
  // `frame:abc` / `frame:abc@2.5` (an agent's shorthand for a time).
  const at = s.lastIndexOf("@");
  const keyPart = at > 0 && !s.includes("/") ? s.slice(0, at) : s;
  if (isDocKey(keyPart)) {
    const t = keyPart !== s ? parseTimeParam(s.slice(at + 1)) : null;
    return { kind: "node", node: keyPart, t };
  }
  const path = appPathOf(s, ctx.app, ctx.origins);
  if (path !== null) {
    const route = parseRoute(path);
    if (route.to === "project" && ctx.projectId && route.projectId === ctx.projectId && route.at.length === 1) {
      return { kind: "node", node: route.at[0]!, t: route.t };
    }
    return { kind: "route", path: formatRoute(route) };
  }
  const href = safeHref(s);
  return href ? { kind: "url", href } : null;
}

/**
 * Pasting over selected text LINKS it when the clipboard is one address and
 * nothing else (Docs, Notion, Slack). The bar is higher than the picker's: a
 * paste is usually prose, so only an address that says it is one — a scheme,
 * or `www.` — becomes a link. A bare word, an email in a sentence or a phone
 * number pastes as text, as you'd expect.
 */
export function pastedLinkTarget(text: string, ctx: ParseTargetContext = {}): LinkTarget | null {
  const s = text.trim();
  const own = ctx.app && s.toLowerCase().startsWith(`${ctx.app.scheme}//`);
  if (!s || /\s/.test(s) || !(own || /^(https?:\/\/|mailto:|www\.)/i.test(s))) return null;
  return parseLinkTarget(s, ctx);
}

/** A target back as the string `parseLinkTarget` reads — the API's and the field's echo. */
export function formatLinkTarget(target: LinkTarget): string {
  switch (target.kind) {
    case "url":
      return target.href;
    case "node":
      return target.t === null ? target.node : `${target.node}@${formatTimeParam(target.t)}`;
    case "route":
      return target.path;
  }
}

export function sameTarget(a: LinkTarget, b: LinkTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "url") return a.href === (b as typeof a).href;
  if (a.kind === "route") return a.path === (b as typeof a).path;
  const bn = b as typeof a;
  return a.node === bn.node && a.t === bn.t;
}

/** Equal links — what lets two adjacent ranges merge into one link span. */
export function sameLink(a: Link | null | undefined, b: Link | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.open === b.open && sameTarget(a.target, b.target);
}
