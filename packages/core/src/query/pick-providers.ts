import type { MotionDocument, Clip } from "../schema";
import { clipAnimatableProperties } from "../animation/clip-properties";
import { exprTypeForProperty } from "../expressions/layer-api";
import { exprTypeForVariable } from "../expressions/types";
import { clipLookup, frameClipEntries } from "../timeline/frame-index";
import { docIndex, type DocNode } from "./doc-index";
import { propertyPickKey, registerPickProvider, type PickCandidate, type PickFilter } from "./pick";

/**
 * THE BUILT-IN PICKABLE FAMILIES — each one `registerPickProvider` call.
 *
 * Layers, frames and pages are the doc index's own nodes re-projected (same
 * keys, same names, same ranking), so ⌘P, the link picker and every object
 * field still read one walk of the document. Properties and variables are
 * VALUES — they carry a type, so a pick-whip can only land on something its
 * field can hold.
 */

const asCandidate = (n: DocNode, kind: PickCandidate["kind"]): PickCandidate => ({
  key: n.key,
  kind,
  id: n.id,
  name: n.name,
  where: n.where,
  tags: n.tags,
  hay: n.hay,
  frameId: n.frameId,
  pageId: n.pageId,
  clip: n.clip,
  frame: n.frame,
  node: n.kind,
});

/** One projection per document snapshot and kind, so a picker typing over a
 *  big project filters a list instead of re-mapping one. */
function memo(project: (doc: MotionDocument) => PickCandidate[]) {
  const cache = new WeakMap<MotionDocument, { list: PickCandidate[]; byId: Map<string, PickCandidate> }>();
  const get = (doc: MotionDocument) => {
    let hit = cache.get(doc);
    if (!hit) {
      const list = project(doc);
      hit = { list, byId: new Map(list.map((c) => [c.id, c])) };
      cache.set(doc, hit);
    }
    return hit;
  };
  return { all: (doc: MotionDocument) => get(doc).list, byId: (doc: MotionDocument, id: string) => get(doc).byId.get(id) ?? null };
}

const layers = memo((doc) => docIndex(doc).flatMap((n) => (n.kind === "layer" ? [asCandidate(n, "layer")] : [])));
const FRAME_KINDS = new Set(["frame", "world", "component", "comp"]);
// A frame's doc-index kind rides as a tag too, so "worlds only" is a filter.
const frames = memo((doc) => docIndex(doc).flatMap((n) => (FRAME_KINDS.has(n.kind) ? [{ ...asCandidate(n, "frame"), tags: [...n.tags, n.kind] }] : [])));
const pages = memo((doc) => docIndex(doc).flatMap((n) => (n.kind === "page" ? [asCandidate(n, "page")] : [])));

registerPickProvider({ kind: "layer", prefix: "clip", noun: "layer", candidates: layers.all, resolve: layers.byId });
registerPickProvider({ kind: "frame", prefix: "frame", noun: "frame", candidates: frames.all, resolve: frames.byId });
registerPickProvider({ kind: "page", prefix: "page", noun: "page", candidates: pages.all, resolve: pages.byId });

// ── Properties ───────────────────────────────────────────────────────────────

/** Every animatable value of one layer, from THE enumerator — the same list
 *  `layer("X").` completes, a Layer node's sockets show and `layer_set` takes. */
const propsCache = new WeakMap<MotionDocument, Map<string, PickCandidate[]>>();
function propertiesOf(doc: MotionDocument, clip: Clip): PickCandidate[] {
  let perDoc = propsCache.get(doc);
  if (!perDoc) propsCache.set(doc, (perDoc = new Map()));
  let hit = perDoc.get(clip.id);
  if (hit) return hit;
  const layerName = clip.name || clip.kind;
  hit = clipAnimatableProperties(clip, doc).map((p) => {
    const where = `${layerName} · ${p.group}`;
    return {
      key: propertyPickKey(clip.id, p.path),
      kind: "property",
      id: `${clip.id}/${p.path}`,
      name: p.def.label,
      where,
      tags: [p.def.kind],
      hay: `${p.def.label} ${where} ${p.path}`.toLowerCase(),
      frameId: clip.frameId,
      pageId: null,
      clip,
      ownerId: clip.id,
      type: exprTypeForProperty(p.def),
      path: p.path,
      group: p.group,
    };
  });
  perDoc.set(clip.id, hit);
  return hit;
}

/** Which layers' properties a filter asks to enumerate. Properties are only
 *  ever listed per layer or per comp — a whole project's would be millions. */
function propertyHosts(doc: MotionDocument, f: PickFilter): Clip[] {
  const clipOf = clipLookup(doc);
  if (f.ofLayers) return f.ofLayers.flatMap((id) => clipOf(id) ?? []);
  if (f.frameId) return frameClipEntries(doc, f.frameId).map((e) => e.clip);
  return [];
}

registerPickProvider({
  kind: "property",
  prefix: "prop",
  noun: "property",
  candidates: (doc, f) => propertyHosts(doc, f).flatMap((clip) => propertiesOf(doc, clip)),
  resolve: (doc, id) => {
    const slash = id.indexOf("/");
    const clip = slash > 0 ? clipLookup(doc)(id.slice(0, slash)) : undefined;
    const path = id.slice(slash + 1);
    return clip ? (propertiesOf(doc, clip).find((p) => p.path === path) ?? null) : null;
  },
});

// ── Variables ────────────────────────────────────────────────────────────────

const variables = memo((doc) =>
  doc.variables.map((v) => {
    const type = exprTypeForVariable(v.type) ?? undefined;
    return {
      key: `var:${v.id}`,
      kind: "variable",
      id: v.id,
      name: v.name,
      where: "Variable",
      tags: [v.type],
      hay: `${v.name} variable ${v.type}`.toLowerCase(),
      frameId: null,
      pageId: null,
      type,
      glyph: `variable:${v.type}`,
    };
  }),
);

registerPickProvider({ kind: "variable", prefix: "var", noun: "variable", candidates: variables.all, resolve: variables.byId });
