import { z } from "zod";
import type { MotionDocument, Clip, Link, LinkTarget, NodeKey } from "../../schema";
import { isVisualClip } from "../../clip-registry";
import { docIndex } from "../../query/doc-index";
import { applyRangePatch } from "../../text/ranges";
import { segmentText } from "../../text/segment";
import { parseDocKey } from "../../links/address";
import { formatLinkTarget, parseLinkTarget } from "../../links/target";
import type { AppAddress } from "../../links/address";
import { describeLink, docLinks, linkForChain, nodeByKey, resolveLink } from "../../links/resolve";
import { ApiError, defineCommand } from "../command";
import { requireClip } from "../lookup";

/**
 * LINKS — something you click that goes somewhere (ADR-links). A layer, a
 * whole text or a run of text links to a URL, a place in this project (a page,
 * a frame, a world, a component, a layer — optionally at a time), or an app
 * route (another project, a plugin). Targets are ids, so renames never break
 * them; a deleted target is reported broken, never silently dropped.
 *
 * Not to be confused with `commands/links.ts`, which is expressions and cuts —
 * values linked to other values.
 */

const openSchema = z.enum(["auto", "here", "new"]).default("auto").describe("auto: web links open a new tab, in-project links open here.");

const TARGET_HELP =
  'A URL ("https://…", "name@example.com", "+1 555 0100"), a node key ("frame:<id>", "clip:<id>", "page:<id>" — a NAME works too: "frame:Hero"), or an app path ("/plugin/icons?q=arrow", "/project/<id>?at=frame:<id>").';

/** A key whose id names nothing, read as a name instead: `frame:Hero`. Unique matches only. */
function byName(doc: MotionDocument, key: string): string | null {
  const parsed = parseDocKey(key);
  if (!parsed) return null;
  const kinds = parsed.kind === "page" ? ["page"] : parsed.kind === "frame" ? ["frame", "world", "component", "comp"] : ["layer"];
  const want = parsed.id.toLowerCase();
  const hits = docIndex(doc).filter((n) => kinds.includes(n.kind) && n.name.toLowerCase() === want);
  if (hits.length > 1) throw new ApiError(`${hits.length} things are called "${parsed.id}".`, `Use an id: ${hits.map((h) => h.key).join(", ")}.`);
  return hits[0]?.key ?? null;
}

function targetFrom(doc: MotionDocument, raw: string, atMs: number | undefined, app: AppAddress | null): LinkTarget {
  const target = parseLinkTarget(raw, { app });
  if (!target) throw new ApiError(`"${raw}" is not a link target.`, TARGET_HELP);
  if (target.kind !== "node") return target;
  const key = nodeByKey(doc, target.node) ? target.node : byName(doc, target.node);
  if (!key) throw new ApiError(`Nothing in this project is ${target.node}.`, "doc.overview and layers.list give ids.");
  return { kind: "node", node: key as NodeKey, t: atMs ?? target.t };
}

function graphemeSpan(clip: Clip, start: number | undefined, end: number | undefined): { start: number; end: number } | null {
  if (start === undefined && end === undefined) return null;
  if (clip.kind !== "text") throw new ApiError("Only a text layer has runs to link.", "Leave out start/end to link the whole layer.");
  const length = segmentText(clip.text).graphemes.length;
  const s = Math.max(0, start ?? 0);
  const e = Math.min(length, end ?? length);
  if (e <= s) throw new ApiError(`[${s}, ${e}) is empty — the text has ${length} characters.`);
  return { start: s, end: e };
}

function linkRow(doc: MotionDocument, link: Link, appName: string) {
  const r = resolveLink(doc, link);
  const { label, where } = describeLink(doc, link, appName);
  return {
    target: formatLinkTarget(link.target),
    open: link.open,
    goesTo: where ? `${label} · ${where}` : label,
    broken: r.kind === "broken" || r.kind === "blocked",
  };
}

const linkSet = (app: AppAddress | null) =>
  defineCommand({
  id: "link.set",
  summary: "Make a layer, a whole text or a run of text a link — to a URL, a place in this project, or an app route.",
  details: `${TARGET_HELP} start/end (grapheme indices, end exclusive) link a run of a text; omitted, the whole layer is the link. atMs opens a frame at that time. Linking never restyles text (no forced underline) — add decoration yourself if the design wants it. A run's link wins over its layer's.`,
  effect: "write",
  input: z.object({
    id: z.string().describe("The layer (id or unique name)."),
    target: z.string(),
    atMs: z.number().min(0).optional().describe("For a frame/layer target: the time to open it at, on that comp's clock."),
    start: z.number().int().min(0).optional(),
    end: z.number().int().min(0).optional(),
    open: openSchema,
  }),
  run(input, rt) {
    const doc = rt.doc();
    const loc = requireClip(doc, input.id);
    if (!isVisualClip(loc.clip)) throw new ApiError("Only a visible layer can be a link.");
    const link: Link = { target: targetFrom(doc, input.target, input.atMs, app), open: input.open };
    const span = graphemeSpan(loc.clip, input.start, input.end);
    rt.write("Add link", (d) => {
      const c = requireClip(d, loc.clip.id).clip;
      if (span && c.kind === "text") c.ranges = applyRangePatch(c.ranges, span.start, span.end, { link });
      else if (isVisualClip(c)) c.link = link;
    });
    return { id: loc.clip.id, span, ...linkRow(rt.doc(), link, app?.name ?? "the app") };
  },
  });

export const linkRemove = defineCommand({
  id: "link.remove",
  summary: "Remove a link from a layer or a run of text.",
  details: "With start/end, only that run stops linking. Without, the layer stops being a link at all — its own link and every run in it.",
  effect: "write",
  input: z.object({ id: z.string(), start: z.number().int().min(0).optional(), end: z.number().int().min(0).optional() }),
  run(input, rt) {
    const loc = requireClip(rt.doc(), input.id);
    const span = graphemeSpan(loc.clip, input.start, input.end);
    const changed = rt.write("Remove link", (d) => {
      const c = requireClip(d, loc.clip.id).clip;
      if (c.kind === "text") {
        const s = span ?? { start: 0, end: segmentText(c.text).graphemes.length };
        c.ranges = applyRangePatch(c.ranges, s.start, s.end, { link: null });
      }
      if (!span && isVisualClip(c)) delete c.link;
    });
    return { id: loc.clip.id, removed: changed };
  },
});

const linkList = (app: AppAddress | null) =>
  defineCommand({
  id: "link.list",
  summary: "Every link in the project (or one frame), with where each goes and whether it is broken.",
  effect: "read",
  input: z.object({ frameId: z.string().optional(), broken: z.boolean().optional().describe("true = only links whose target was deleted or is unsafe.") }),
  run(input, rt) {
    const doc = rt.doc();
    return docLinks(doc)
      .filter((l) => !input.frameId || l.frameId === input.frameId)
      .map((l) => ({ id: l.clipId, frameId: l.frameId, span: l.span, ...linkRow(doc, l.link, app?.name ?? "the app") }))
      .filter((row) => input.broken === undefined || row.broken === input.broken);
  },
  });

export const linkFollow = defineCommand({
  id: "link.follow",
  summary: "Where a layer's link goes, resolved the way a click would — without moving anyone's view.",
  details: "at = the grapheme a click lands on, for a text with run links. Returns the URL to open, or the node to stand in (use its key with session.set / view.render to go and look).",
  effect: "read",
  input: z.object({ id: z.string(), at: z.number().int().min(0).optional() }),
  run(input, rt) {
    const doc = rt.doc();
    const loc = requireClip(doc, input.id);
    const hit = linkForChain(doc, [loc.clip.id], input.at ?? null);
    if (!hit) throw new ApiError(`"${loc.clip.name}" is not a link${input.at !== undefined ? " there" : ""}.`, "link.list shows every link.");
    const r = resolveLink(doc, hit.link);
    const where =
      r.kind === "external" ? { href: r.href } : r.kind === "node" ? { node: r.node.key, name: r.node.name, kind: r.node.kind, atMs: r.t } : r.kind === "route" ? { path: hit.link.target.kind === "route" ? hit.link.target.path : "/" } : { reason: r.reason };
    return { kind: r.kind, carriedBy: hit.clipId, span: hit.span, newTab: "newTab" in r ? r.newTab : false, ...where };
  },
});

/** The link verbs. `app` is this app's own addresses (its web origin and scheme), so an agent can paste one. */
export const hyperlinkCommands = (app: AppAddress | null) => [linkSet(app), linkRemove, linkList(app), linkFollow];
