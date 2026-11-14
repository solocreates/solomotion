import type { MotionDocument, Clip, Frame, Page } from "../schema";
import { clipFrameBounds, locateClip, locateFrame, type ClipLocation } from "../timeline/ops";
import { frameLayerTree, type LayerTreeNode } from "../timeline/layer-tree";
import { laneNumbers } from "../timeline/lanes";
import { INTERNAL_PAGE_ID } from "../pages";
import { nestedSourceOf } from "../components";
import { ApiError, type CommandRuntime } from "./command";

/**
 * Finding things, and saying what was found in as few tokens as it can be said.
 *
 * Every lookup failure is an `ApiError` that names what DOES exist nearby,
 * because the caller is usually a model that guessed, and "no such layer" alone
 * costs it a round trip to find out what to guess next.
 */

export function requireClip(doc: MotionDocument, id: string): ClipLocation {
  const loc = locateClip(doc, id);
  if (loc) return loc;
  const byName = doc.tracks.flatMap((t) => t.clips).filter((c) => c.name === id);
  if (byName.length === 1) return locateClip(doc, byName[0]!.id)!;
  throw new ApiError(
    `No layer with id "${id}".`,
    byName.length > 1
      ? `${byName.length} layers are named "${id}" — use an id: ${byName.map((c) => c.id).join(", ")}.`
      : "Layer ids look like clip_…/group_…. layers.list shows every layer in a comp.",
  );
}

export function requireFrame(doc: MotionDocument, id: string): Frame {
  const frame = locateFrame(doc, id) ?? doc.frames.find((f) => f.name === id) ?? null;
  if (frame) return frame;
  throw new ApiError(
    `No comp with id "${id}".`,
    `Comps here: ${visibleFrames(doc)
      .map((f) => `${f.id} (${f.name})`)
      .join(", ")}.`,
  );
}

export function requirePage(doc: MotionDocument, id: string): Page {
  const page = doc.pages.find((p) => p.id === id) ?? doc.pages.find((p) => p.name === id);
  if (page) return page;
  throw new ApiError(`No page "${id}".`, `Pages: ${doc.pages.map((p) => `${p.id} (${p.name})`).join(", ")}. page.create makes one.`);
}

/** Comps a person can see on a page — not the internal shelf of nested sources. */
export function visibleFrames(doc: MotionDocument): Frame[] {
  return doc.frames.filter((f) => f.pageId !== INTERNAL_PAGE_ID);
}

/**
 * The comp a command acts on when none is named: the one the user is looking
 * at, else the first on a page. A document with no comps is the one case
 * nothing can default, and the error says how to fix it.
 */
/**
 * "Here" — the comp a call without a `frameId` lands in: the focused one,
 * else the first the person can see. ONE rule, read by every command and by a
 * script's `here`, so the two can never point at different comps.
 */
export function hereFrame(doc: MotionDocument, focusedId: string | null): Frame | null {
  return (focusedId && locateFrame(doc, focusedId)) || visibleFrames(doc)[0] || doc.frames[0] || null;
}

export function resolveTargetFrame(rt: CommandRuntime, frameId?: string | null): Frame {
  const doc = rt.doc();
  if (frameId) return requireFrame(doc, frameId);
  const frame = hereFrame(doc, rt.session.focusFrameId());
  if (!frame) throw new ApiError("This project has no comps yet.", "Create one with frame.create.");
  return frame;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * One layer, summarised — enough to reason about layout and timing without
 * reading the whole clip. Coordinates are the document's own: comp space,
 * ORIGIN AT THE COMP'S CENTRE, +y down. `pos` is where the pivot sits (what
 * `transform.x/y` hold); `bounds` is the rotated, scaled box.
 */
export interface LayerSummary {
  id: string;
  name: string;
  kind: string;
  /** [startMs, endMs] on the comp's timeline. */
  time: [number, number];
  /** Its row on the comp's timeline, 0 = the top row of its scope (the comp, or its group). */
  lane?: number;
  pos?: [number, number];
  bounds?: [number, number, number, number];
  text?: string;
  flags?: string[];
  children?: LayerSummary[];
}

export function summarizeClip(doc: MotionDocument, clip: Clip): LayerSummary {
  const out: LayerSummary = {
    id: clip.id,
    name: clip.name,
    kind: clip.kind === "text" && clip.caption ? "caption" : clip.kind,
    time: [Math.round(clip.startMs), Math.round(clip.startMs + clip.durationMs)],
  };
  if (clip.kind !== "audio") {
    out.pos = [round(clip.transform.x), round(clip.transform.y)];
    const b = clipFrameBounds(doc, clip);
    if (b && Number.isFinite(b.minX)) out.bounds = [round(b.minX), round(b.minY), round(b.maxX), round(b.maxY)];
  }
  if (clip.kind === "text") out.text = clip.text.length > 80 ? `${clip.text.slice(0, 77)}…` : clip.text;
  const flags: string[] = [];
  if (clip.hidden) flags.push("hidden");
  if (clip.locked) flags.push("locked");
  if (clip.keyframes.some((t) => t.keys.length)) flags.push("keyed");
  if (clip.kind !== "audio") {
    if (clip.effects.length) flags.push(`fx:${clip.effects.map((e) => e.type).join("+")}`);
    if (clip.animIn) flags.push(`in:${clip.animIn.preset}`);
    if (clip.animOut) flags.push(`out:${clip.animOut.preset}`);
    if (clip.opacity < 1) flags.push(`opacity:${round(clip.opacity)}`);
  }
  if (clip.kind === "text") {
    if (clip.animations.in) flags.push(`textIn:${clip.animations.in.preset}`);
    if (clip.animations.out) flags.push(`textOut:${clip.animations.out.preset}`);
  }
  if (clip.kind === "group") {
    if (clip.layout) flags.push(`layout:${clip.layout.flow}`);
    if (clip.mode !== "pass") flags.push(`mode:${clip.mode}`);
  }
  if (clip.kind === "shape") flags.push(`shape:${clip.shape}`);
  if (clip.kind === "nested") flags.push(`inside:${nestedSourceOf(doc, clip)}`);
  if (clip.sounds.length) flags.push(`sounds:${clip.sounds.length}`);
  if (flags.length) out.flags = flags;
  return out;
}

/** A comp's layers as a tree, top of the stack first, groups holding children. */
export function summarizeTree(doc: MotionDocument, frameId: string, depth = 8): LayerSummary[] {
  const lanes = laneNumbers(doc, frameId);
  const walk = (nodes: LayerTreeNode[], level: number): LayerSummary[] =>
    nodes.map((n) => {
      const s = summarizeClip(doc, n.clip);
      s.lane = lanes.get(doc.tracks[n.trackIndex]!.id);
      if (n.type === "group") {
        s.children = level < depth ? walk(n.children, level + 1) : [];
        if (level >= depth && n.children.length) (s.flags ??= []).push(`${n.children.length} children`);
      }
      return s;
    });
  return walk(frameLayerTree(doc, frameId), 0);
}

/** A comp's audio, which the visual tree leaves out by design. */
export function summarizeAudio(doc: MotionDocument, frameId: string): LayerSummary[] {
  const lanes = laneNumbers(doc, frameId);
  return doc.tracks.flatMap((t) =>
    t.clips
      .filter((c) => c.kind === "audio" && c.frameId === frameId)
      .map((c) => ({ ...summarizeClip(doc, c), lane: lanes.get(t.id) })),
  );
}

/**
 * A clip as JSON for reading, with the bulky, rarely-useful parts folded to a
 * note the caller can expand by asking for that field. A path with a thousand
 * points or a caption with two hundred cues is not something a layout decision
 * needs to read to be made.
 */
export function clipForReading(clip: Clip, fields?: readonly string[]): Record<string, unknown> {
  const source = clip as unknown as Record<string, unknown>;
  if (fields?.length) {
    const out: Record<string, unknown> = { id: clip.id, kind: clip.kind };
    for (const f of fields) if (f in source) out[f] = source[f];
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "subpaths" && Array.isArray(value)) {
      out[key] = `‹${value.length} contour(s) — ask for fields:["subpaths"]›`;
    } else if (key === "keyframes" && Array.isArray(value) && value.length) {
      out[key] = (value as Clip["keyframes"]).map((t) => ({
        property: t.property,
        ...(t.range ? { range: t.range } : {}),
        keys: t.keys.map((k) => [Math.round(k.timeMs), k.value, easingLabel(k.easing)]),
      }));
    } else if (key === "caption" && value && typeof value === "object") {
      const cap = value as { cues?: unknown[] };
      out[key] = { ...cap, cues: `‹${cap.cues?.length ?? 0} cue(s) — ask for fields:["caption"]›` };
    } else out[key] = value;
  }
  return out;
}

function easingLabel(e: Clip["keyframes"][number]["keys"][number]["easing"]): string {
  if (e.kind === "linear" || e.kind === "hold") return e.kind;
  if (e.kind === "preset") return e.name;
  return `bezier(${e.values.join(",")})`;
}
