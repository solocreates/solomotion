import { z } from "zod";
import { current } from "immer";
import { duckRuleSchema, frameSchema, groupModeSchema, layerEffectSchema, layoutSpecSchema, soundCharacterSchema, type MotionDocument, type LayerEffect, type Track } from "../../schema";
import { createLayerEffect, layerEffectTypeDef } from "../../animation/layer-effects";
import { frameEffectClip } from "../../timeline/frame-effects";
import { setFrameEffectsIn } from "../../timeline/frame-effect-edit";
import { compOwnerNested, frameDurationMs } from "../../timeline/ops";
import { createSoundBus, deleteSoundBus, makeDuckRule } from "../../audio/buses";
import { createFrame } from "../../factories";
import { duplicateFrame, makeUnique } from "../../components";
import {
  clipEnd,
  duplicateClips,
  isClipLocked,
  locateClip,
  moveClip,
  resizeFrame,
  restackClips,
  setFrameDurationMs,
  setFrameFps,
  splitClip,
  trimClip,
  deleteFrame,
  locateFrame,
} from "../../timeline/ops";
import { carryClips, pasteCarry } from "../../timeline/paste";
import { deleteLayers } from "../../timeline/delete-layers";
import { closeAllGaps } from "../../timeline/gaps";
import { cutRanges } from "../../timeline/cut-ranges";
import { canRejoinAudio, rejoinClipAudio, separateClipAudio } from "../../timeline/media-audio";
import { expandToDescendants, groupClips, scopeEdgeIndex, ungroupClips } from "../../timeline/groups";
import { addAutoLayout, removeAutoLayout } from "../../relations/layout-ops";
import { setGroupMode } from "../../timeline/group-composite";
import { compactLanes, laneAboveFor, laneBlocker, laneNumbers, type CompactResult, type LaneSpan } from "../../timeline/lanes";
import { isFlipbookFrame } from "../../drawing/flipbook";
import { setFrameMode } from "../../timeline/frame-mode";
import { frameFps, quantizeMsToFrame } from "../../timeline/fps";
import { createPage, framesOnPage, isInternalPage, moveFrameToPage, pageOfFrame, slotBesidePage } from "../../pages";
import { ApiError, defineCommand } from "../command";
import { requireClip, requireFrame, requirePage, summarizeClip, resolveTargetFrame, visibleFrames } from "../lookup";
import { applyPatchOps, formatIssues, patchOpSchema, refuseDroppedKeys } from "../patch";

/**
 * STRUCTURE AND TIME — the stack, groups, auto layout, the timeline, comps.
 *
 * Each verb here wraps a core op the editor's own gestures already use, so
 * the agent moving a clip and a person dragging it cannot mean two things.
 */

const idsInput = z.union([z.string(), z.array(z.string()).min(1)]);
const listOf = (ids: z.infer<typeof idsInput>) => (typeof ids === "string" ? [ids] : ids);

export const layersDelete = defineCommand({
  id: "layers.delete",
  summary: "Delete layers (a group takes its contents with it).",
  effect: "write",
  input: z.object({ ids: idsInput }),
  run(input, rt) {
    const ids = listOf(input.ids);
    for (const id of ids) requireClip(rt.doc(), id);
    let removed = 0;
    rt.write(ids.length > 1 ? "Delete layers" : "Delete layer", (d) => {
      const all = expandToDescendants(d, ids);
      removed = all.length;
      deleteLayers(d, all, { pruneEmptiedTracks: true });
    });
    return { removed };
  },
});

export const layersDuplicate = defineCommand({
  id: "layers.duplicate",
  summary: "Duplicate layers in place (each copy lands just above its source). Returns the new ids.",
  effect: "write",
  input: z.object({ ids: idsInput }),
  run(input, rt) {
    const ids = listOf(input.ids);
    for (const id of ids) requireClip(rt.doc(), id);
    let tops: string[] = [];
    rt.write("Duplicate", (d) => void (tops = duplicateClips(d, ids).tops));
    return { ids: tops };
  },
});

export const layersMakeUnique = defineCommand({
  id: "layers.makeUnique",
  summary: "Give nested comp layers their own copy of what they show, so editing one stops changing the comp it linked to.",
  details:
    "A nested layer's inside is `embedded` (its own), `linked` (a comp on a page, or one other layers share) or `instance` (a component) — layers.list shows it as the `inside:` flag. Linked is the default: editing the source changes every place it shows. makeUnique copies the source into this layer (embedded); the original stays where it is. A component instance becomes a plain nested comp (detach). Returns each new source comp id; a layer already embedded is skipped.",
  effect: "write",
  input: z.object({ ids: idsInput }),
  run(input, rt) {
    const ids = listOf(input.ids);
    for (const id of ids) {
      const { clip } = requireClip(rt.doc(), id);
      if (clip.kind !== "nested") throw new ApiError(`${clip.name} is not a nested comp.`, "makeUnique works on nested comp layers (kind: nested).");
    }
    const made: Record<string, string> = {};
    rt.write("Make unique", (d) => {
      for (const id of ids) {
        const frameId = makeUnique(d, id);
        if (frameId) made[id] = frameId;
      }
    });
    return { made };
  },
});

export const layersGroup = defineCommand({
  id: "layers.group",
  summary: "Group layers (same comp). Optionally make the group an AUTO LAYOUT that arranges its members.",
  details:
    "`layout` turns the group into a container: flow row/column/wrap/grid, gap, padding, alignment, hug or fixed size — see api.describe layout. `layout: {}` infers it from how the members already sit. The container's box is placed by its TOP-LEFT (layout.x/y, comp space).",
  effect: "write",
  input: z.object({
    ids: z.array(z.string()).min(1),
    name: z.string().optional(),
    layout: layoutSpecSchema.partial().optional(),
    mode: groupModeSchema
      .optional()
      .describe("How the members combine: union, subtract (the topmost cuts the rest), intersect, exclude, mask. In a 3D world union/subtract/intersect are solid booleans."),
  }),
  run(input, rt) {
    for (const id of input.ids) requireClip(rt.doc(), id);
    let groupId: string | null = null;
    rt.write("Group", (d) => {
      groupId = groupClips(d, input.ids, input.name);
      if (!groupId) throw new ApiError("Could not group those layers.", "They must be visual layers in the same comp.");
      if (input.layout && !addAutoLayout(d, groupId, input.layout)) throw new ApiError("Could not add auto layout.");
      if (input.mode && input.mode !== "pass") setGroupMode(d, groupId, input.mode);
    });
    // `id`, as every verb that makes something answers (`$0.id` in a batch); `groupId` stays for old scripts.
    return { id: groupId, groupId };
  },
});

export const layersUngroup = defineCommand({
  id: "layers.ungroup",
  summary: "Dissolve groups, keeping their members where they are.",
  effect: "write",
  input: z.object({ ids: idsInput }),
  run(input, rt) {
    const ids = listOf(input.ids);
    rt.write("Ungroup", (d) => ungroupClips(d, ids));
    return { ungrouped: ids };
  },
});

export const layoutSet = defineCommand({
  id: "layout.set",
  summary: "Turn a group's auto layout on, change it, or turn it off (baking members where they are).",
  details:
    "`layout` merges into the current spec (flow, gap, padding, alignX/alignY, width/height null = hug…). `layout: null` removes it. A member's own sizing lives in its `layoutItem` (fill/hug, absolute) — set it with layer.patch.",
  effect: "write",
  input: z.object({ groupId: z.string(), layout: layoutSpecSchema.partial().nullable() }),
  run(input, rt) {
    rt.write(input.layout ? "Auto layout" : "Remove auto layout", (d) => {
      const loc = requireClip(d, input.groupId);
      if (loc.clip.kind !== "group") throw new ApiError(`"${loc.clip.name}" is not a group.`, "layers.group first.");
      if (input.layout === null) {
        removeAutoLayout(d, input.groupId, rt.session.playheadMs());
        return;
      }
      if (!loc.clip.layout) {
        addAutoLayout(d, input.groupId, input.layout);
        return;
      }
      const next = layoutSpecSchema.safeParse({ ...current(loc.clip.layout), ...input.layout });
      if (!next.success) throw new ApiError(`Invalid layout — ${formatIssues(next.error)}.`);
      loc.clip.layout = next.data;
    });
    return { groupId: input.groupId };
  },
});

export const layersRestack = defineCommand({
  id: "layers.restack",
  summary: "Change stacking order: bring to front / send to back of their group, or place directly above/below a layer.",
  effect: "write",
  details: 'Give `to` as "front" | "back" (of the layers\' own group or comp), {above: "<layer id>"} or {below: "<layer id>"}. `above`/`below` also work on their own, without `to`.',
  input: z
    .object({
      ids: z.array(z.string()).min(1),
      // One message naming every accepted form: a bare union only ever said
      // "to: Invalid input", which left an agent guessing at the spelling.
      to: z
        .union(
          [
            z.enum(["front", "back"]),
            z.enum(["top", "bottom"]).transform((v) => (v === "top" ? "front" : "back") as "front" | "back"),
            z.object({ above: z.string() }),
            z.object({ below: z.string() }),
          ],
          { errorMap: () => ({ message: 'must be "front", "back", {above: "<layer id>"} or {below: "<layer id>"}' }) },
        )
        .optional(),
      above: z.string().optional().describe("Shorthand for to: {above: id}."),
      below: z.string().optional().describe("Shorthand for to: {below: id}."),
    })
    .refine((v) => [v.to, v.above, v.below].filter((x) => x !== undefined).length === 1, {
      message: 'Give one of to ("front", "back", {above: id}, {below: id}), above or below.',
      path: ["to"],
    }),
  run(input, rt) {
    const to = input.to ?? (input.above !== undefined ? { above: input.above } : { below: input.below! });
    rt.write("Reorder", (d) => {
      const first = requireClip(d, input.ids[0]!);
      if (typeof to === "string") {
        const scope = first.track.groupId ?? null;
        const edge = scopeEdgeIndex(d, scope, to === "front" ? "top" : "bottom");
        restackClips(d, input.ids, { trackIndex: edge, groupId: scope });
        return;
      }
      const anchorId = "above" in to ? to.above : to.below;
      const anchor = requireClip(d, anchorId);
      const index = anchor.trackIndex + ("above" in to ? 0 : 1);
      restackClips(d, input.ids, { trackIndex: index, groupId: anchor.track.groupId ?? null, frameId: anchor.clip.frameId });
    });
    return { reordered: input.ids };
  },
});

/**
 * A layer the lane could not hold at its new time, and what was in the way.
 *
 * The API's time edits land EXACTLY where asked. A person dragging into a
 * neighbour sees the clamp and adjusts; an agent reads back a number and
 * builds on it, so a move that quietly stopped short (or a trim that did
 * nothing) was a timing bug several steps later. A lane is not something the
 * caller asked about, so the lane gives way instead: the layer changes to the
 * lane just above (`laneAboveFor`) — the z a drop onto a busy lane gets — and
 * the result says so, naming the layer that was in the way.
 */
interface Relaned {
  id: string;
  lane: number | undefined;
  blockedBy: { id: string; name: string };
}

/**
 * The lane `clipId` must change to when its own is busy over `need` — one free
 * over `reach` (what the clip will occupy on it while the edit lands), or null
 * when its own lane holds `need`. Mints the lane when none is free. Mutates.
 */
function laneGivingWay(
  d: MotionDocument,
  clipId: string,
  need: LaneSpan,
  reach: LaneSpan = need,
): { track: Track; relaned: Relaned } | null {
  const loc = locateClip(d, clipId)!;
  const inTheWay = laneBlocker(loc.track, need);
  if (!inTheWay) return null;
  const track = laneAboveFor(d, loc.trackIndex, reach);
  return {
    track,
    relaned: { id: clipId, lane: laneNumbers(d, need.frameId).get(track.id), blockedBy: { id: inTheWay.id, name: inTheWay.name } },
  };
}

export const timelineMove = defineCommand({
  id: "timeline.move",
  summary: "Move layers in time — to an absolute start, or by a delta. Each layer lands exactly where asked.",
  details:
    "When a layer's own lane is busy at the new time, the layer moves to the lane just above instead (passing over what was in the way, keeping its order against everything else) and is listed under `relaned` with the layer that blocked it. Locked layers stay and are listed under `blocked`.",
  effect: "write",
  input: z.object({
    ids: z.array(z.string()).min(1),
    startMs: z.number().min(0).optional().describe("New start (comp time) for the FIRST id; the rest keep their offsets."),
    byMs: z.number().optional(),
  }),
  run(input, rt) {
    if (input.startMs === undefined && input.byMs === undefined) throw new ApiError("Give startMs or byMs.");
    const blocked: string[] = [];
    const relaned: Relaned[] = [];
    rt.write("Move in time", (d) => {
      const first = requireClip(d, input.ids[0]!).clip;
      const delta = input.byMs ?? input.startMs! - first.startMs;
      // Leading edge first, so layers moving together never block each other.
      const clips = input.ids.map((id) => requireClip(d, id).clip);
      clips.sort((a, b) => (delta > 0 ? b.startMs - a.startMs : a.startMs - b.startMs));
      for (const clip of clips) {
        const loc = locateClip(d, clip.id)!;
        if (isClipLocked(loc.track, loc.clip)) {
          blocked.push(clip.id);
          continue;
        }
        const startMs = Math.max(0, clip.startMs + delta);
        const way = laneGivingWay(d, clip.id, { frameId: clip.frameId, startMs, durationMs: clip.durationMs, id: clip.id });
        if (way) relaned.push(way.relaned);
        moveClip(d, clip.id, startMs, way?.track.id);
      }
    });
    const doc = rt.doc();
    return {
      moved: input.ids.filter((id) => !blocked.includes(id)).map((id) => summarizeClip(doc, locateClip(doc, id)!.clip).time),
      ...(relaned.length ? { relaned } : {}),
      ...(blocked.length ? { blocked, hint: "Locked — unlock the layer or its lane first." } : {}),
    };
  },
});

export const timelineTrim = defineCommand({
  id: "timeline.trim",
  summary: "Trim a layer's start and/or end to comp times. Keyframes stay at the moments they were authored for.",
  details:
    "A neighbour on the layer's lane never stops the edge: the layer moves to the lane just above and is reported under `relaned`. The edge can still stop short at the media's first frame or a 50 ms minimum — then `asked` shows what was requested.",
  effect: "write",
  input: z.object({ id: z.string(), startMs: z.number().min(0).optional(), endMs: z.number().positive().optional() }),
  run(input, rt) {
    let relaned: Relaned | null = null;
    let asked: [number, number] = [0, 0];
    rt.write("Trim", (d) => {
      const loc = requireClip(d, input.id);
      if (isClipLocked(loc.track, loc.clip)) throw new ApiError(`"${loc.clip.name}" is locked.`, "Unlock the layer or its lane first.");
      const clip = loc.clip;
      asked = [input.startMs ?? clip.startMs, input.endMs ?? clipEnd(clip)];
      if (asked[1] <= asked[0]) throw new ApiError("endMs must be after startMs.");
      // A new lane must hold the trimmed span AND the one the layer has now: it
      // changes lane first, then its edges move.
      const from = Math.min(asked[0], clip.startMs);
      const need = { frameId: clip.frameId, startMs: asked[0], durationMs: asked[1] - asked[0], id: clip.id };
      const way = laneGivingWay(d, input.id, need, { ...need, startMs: from, durationMs: Math.max(asked[1], clipEnd(clip)) - from });
      if (way) {
        relaned = way.relaned;
        moveClip(d, input.id, clip.startMs, way.track.id);
      }
      if (input.startMs !== undefined) trimClip(d, input.id, "start", input.startMs);
      if (input.endMs !== undefined) trimClip(d, input.id, "end", input.endMs);
    });
    const clip = requireClip(rt.doc(), input.id).clip;
    const time: [number, number] = [clip.startMs, clipEnd(clip)];
    const short = Math.abs(time[0] - asked[0]) > 0.5 || Math.abs(time[1] - asked[1]) > 0.5;
    return { time, ...(relaned ? { relaned } : {}), ...(short ? { asked } : {}) };
  },
});

export const timelineSplit = defineCommand({
  id: "timeline.split",
  summary: "Cut a layer in two at a comp time. Returns the id of the right-hand piece.",
  effect: "write",
  input: z.object({ id: z.string(), atMs: z.number().positive() }),
  run(input, rt) {
    let right: string | null = null;
    rt.write("Split", (d) => {
      requireClip(d, input.id);
      right = splitClip(d, input.id, input.atMs);
      if (!right) throw new ApiError("Nothing to split at that time.", "atMs must fall inside the layer.");
    });
    return { left: input.id, right };
  },
});

export const timelineCloseGaps = defineCommand({
  id: "timeline.close_gaps",
  summary: "Ripple the lanes of these layers so every gap closes — what you do after cutting pieces out.",
  details: "Pass the layers whose lanes should close up (any clip on the lane will do). Linked audio and keyframes move with their clips.",
  effect: "write",
  input: z.object({ ids: z.array(z.string()).min(1) }),
  run(input, rt) {
    let closed = 0;
    rt.write("Close gaps", (d) => {
      const lanes = new Map<string, string>();
      for (const id of input.ids) {
        const loc = requireClip(d, id);
        lanes.set(loc.track.id, loc.clip.frameId);
      }
      for (const [trackId, frameId] of lanes) if (closeAllGaps(d, trackId, frameId)) closed++;
    });
    return { lanesClosed: closed };
  },
});

export const timelineCutRanges = defineCommand({
  id: "timeline.cut_ranges",
  summary: "Take stretches of comp time out of a layer (pauses, ums, dead air) and ripple what follows back — one undo.",
  details:
    "Ranges are comp ms (media.transcribe returns `pauses` in exactly this shape). `ripple: sync` (default) keeps the comp in sync as an NLE's sync-lock does: captions and titles after a cut slide back with their words, a music bed spanning it is shortened instead of jumping. `lane` closes only this layer's lane (and linked layers'); `none` leaves holes for B-roll. Linked layers (an a/v pair) are razored together.",
  effect: "write",
  input: z.object({
    id: z.string(),
    ranges: z.array(z.object({ startMs: z.number(), endMs: z.number() })).min(1).max(500),
    ripple: z.enum(["sync", "lane", "none"]).default("sync"),
  }),
  run(input, rt) {
    let result: ReturnType<typeof cutRanges> | null = null;
    rt.write("Cut ranges", (d) => {
      requireClip(d, input.id);
      result = cutRanges(d, input.id, input.ranges, input.ripple);
      if (!result.cut.length) throw new ApiError("None of those ranges fall inside the layer.", "Ranges are comp ms; read the layer's time with layer.get.");
    });
    const r = result!;
    return { removedMs: Math.round(r.removedMs), cuts: r.cut.length, pieces: r.pieces };
  },
});

export const timelineCompact = defineCommand({
  id: "timeline.compact",
  summary: "Tidy a comp's lanes: drop empty lanes and let layers fall into free lanes below — what covers what never changes.",
  details:
    "A layer only shares a lane with layers it never plays at the same time as, and never drops under anything it overlaps, so every frame looks exactly as before. Locked, hidden, muted and looping lanes stay put and nothing crosses them. Returns the lane count before and after.",
  effect: "write",
  input: z.object({ frameId: z.string().optional().describe("Omitted = the focused comp.") }),
  run(input, rt) {
    const frame = resolveTargetFrame(rt, input.frameId);
    if (isFlipbookFrame(frame)) throw new ApiError("A flipbook's rows are its sheet — compacting would reorder its drawings.");
    let result: CompactResult | null = null;
    rt.write("Compact lanes", (d) => void (result = compactLanes(d, frame.id)));
    return result!;
  },
});

export const audioDetach = defineCommand({
  id: "audio.detach",
  summary: "Separate a video's own sound into a linked audio layer (the video is muted) — for J-cuts, L-cuts, and treating the sound on its own.",
  details:
    "The new audio layer plays the same asset in sync (same start, trim, speed). Trim or move it on its own with timeline_trim / timeline_move to lead (J) or trail (L) the picture cut; give it audio effects. audio.rejoin puts it back.",
  effect: "write",
  input: z.object({ id: z.string().describe("A video layer that still plays its own sound.") }),
  run(input, rt) {
    let audioId: string | null = null;
    rt.write("Separate audio", (d) => {
      const loc = requireClip(d, input.id);
      if (loc.clip.kind !== "video") throw new ApiError("Only a video layer carries its own sound.");
      if (loc.clip.muted) throw new ApiError("That video is muted — its sound is already separated or off.", "audio.rejoin brings a separated sound back.");
      audioId = separateClipAudio(d, input.id);
      if (!audioId) throw new ApiError("That video's sound could not be separated.");
    });
    return { audioId, videoMuted: true };
  },
});

export const audioRejoin = defineCommand({
  id: "audio.rejoin",
  summary: "Put a separated sound back into its video (the reverse of audio.detach). Pass either layer of the pair.",
  effect: "write",
  input: z.object({ id: z.string() }),
  run(input, rt) {
    rt.write("Rejoin audio", (d) => {
      requireClip(d, input.id);
      if (!canRejoinAudio(d, input.id) || !rejoinClipAudio(d, input.id)) throw new ApiError("That layer is not half of a separated video/audio pair.");
    });
    return { rejoined: true };
  },
});

const frameModeInput = z
  .enum(["timeline", "flipbook", "static"])
  .describe(
    "timeline = layers animate on a timeline; flipbook = frame-by-frame cells; static = ONE picture (a design, thumbnail, poster, page) with no timeline — it shows its still whatever time is asked, nested it holds, exported it is an image.",
  );

export const frameCreate = defineCommand({
  id: "frame.create",
  summary: "Create a frame — a timeline comp (default), a frame-by-frame flipbook, or a static design (thumbnail, poster, page) — placed beside the others on the same page.",
  effect: "write",
  input: z.object({
    name: z.string().default("Comp"),
    mode: frameModeInput.default("timeline"),
    width: z.number().int().min(16).max(8192),
    height: z.number().int().min(16).max(8192),
    background: z.string().default("#0E0E11"),
    fps: z.number().positive().max(240).default(30),
    durationMs: z.number().positive().optional(),
    pageId: z.string().optional().describe("Page to put it on (id or name); omitted = the focused comp's page."),
    overflow: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Content past the box: 0 crops it everywhere, 1 never crops it when nested. Omitted: nested instances decide by the comp — a transparent comp (a part) spills, one with a visible background windows (the layer's clipContent overrides).",
      ),
  }),
  run(input, rt) {
    // The comp to sit beside. An empty project has none — that is exactly when
    // frame.create must work, so it is optional here (not resolveTargetFrame,
    // whose "no comps yet" error would point back at this very command).
    const doc = rt.doc();
    const focused = rt.session.focusFrameId();
    const near = (focused && locateFrame(doc, focused)) || visibleFrames(doc)[0] || doc.frames[0] || null;
    let id = "";
    rt.write("Create comp", (d) => {
      const { pageId: asked, mode, ...spec } = input;
      // A comp inside a nested layer lives on no page; a new comp made while
      // looking at one belongs on the first page, never on that shelf.
      const home = near ? pageOfFrame(d, near) : d.pages[0]!.id;
      const pageId = asked ? requirePage(d, asked).id : isInternalPage(home) ? d.pages[0]!.id : home;
      // Whether a nested instance crops is `nestedClipsContent`'s call (a
      // transparent comp spills by itself); `overflow` is only said when asked.
      const frame = createFrame({ ...spec, durationMs: spec.durationMs ?? null, x: slotBesidePage(d, pageId) ?? 0, y: near?.y ?? 0, pageId });
      d.frames.push(frame);
      id = frame.id;
      if (mode !== "timeline") setFrameMode(d, frame.id, mode, { atMs: 0 });
    });
    return { id };
  },
});

export const pageCreate = defineCommand({
  id: "page.create",
  summary: "Add a page — a canvas of its own for comps — optionally moving comps onto it.",
  effect: "write",
  input: z.object({
    name: z.string().min(1),
    frameIds: z.array(z.string()).optional().describe("Comps to move onto the new page."),
  }),
  run(input, rt) {
    let id = "";
    rt.write("Add page", (d) => {
      const page = createPage(input.name);
      d.pages.push(page);
      id = page.id;
      for (const frameId of input.frameIds ?? []) moveFrameOrThrow(d, frameId, page.id);
    });
    return { id };
  },
});

export const pageUpdate = defineCommand({
  id: "page.update",
  summary: "Rename a page, or move it in the page list.",
  effect: "write",
  input: z.object({
    id: z.string().describe("The page (id or name)."),
    name: z.string().min(1).optional(),
    index: z.number().int().min(0).optional().describe("Its new position in the page list (0 = first)."),
  }),
  run(input, rt) {
    let id = "";
    rt.write("Update page", (d) => {
      const page = requirePage(d, input.id);
      id = page.id;
      if (input.name) page.name = input.name;
      if (input.index != null) {
        d.pages = d.pages.filter((p) => p.id !== page.id);
        d.pages.splice(Math.min(input.index, d.pages.length), 0, page);
      }
    });
    return { id };
  },
});

export const pageDelete = defineCommand({
  id: "page.delete",
  summary: "Delete a page. A page that still holds comps needs `moveTo` (another page) or `comps: \"delete\"`; the last page stays.",
  effect: "write",
  input: z.object({
    id: z.string().describe("The page (id or name)."),
    moveTo: z.string().optional().describe("Move its comps to this page first (id or name)."),
    comps: z.enum(["keep", "delete"]).optional().default("keep").describe("delete: its comps go with it."),
  }),
  run(input, rt) {
    rt.write("Delete page", (d) => {
      const page = requirePage(d, input.id);
      if (d.pages.length <= 1) throw new ApiError("A project keeps at least one page.", "Rename it with page.update instead.");
      const held = framesOnPage(d, page.id);
      if (held.length && input.moveTo) {
        const to = requirePage(d, input.moveTo);
        if (to.id === page.id) throw new ApiError("moveTo is the page being deleted.");
        for (const f of held) moveFrameOrThrow(d, f.id, to.id);
      } else if (held.length && input.comps === "delete") {
        if (held.length >= d.frames.length) throw new ApiError("That page holds the project's only comps.", "Move them with moveTo instead.");
        for (const f of held) deleteFrame(d, f.id);
      } else if (held.length) {
        throw new ApiError(`"${page.name}" still holds ${held.length} comp(s).`, 'Pass moveTo: "<page>" to keep them, or comps: "delete".');
      }
      d.pages = d.pages.filter((p) => p.id !== page.id);
    });
    return {};
  },
});

/** `moveFrameToPage`, with the reason it refused. */
function moveFrameOrThrow(d: MotionDocument, frameId: string, pageId: string): void {
  const frame = requireFrame(d, frameId);
  if (!moveFrameToPage(d, frame.id, requirePage(d, pageId).id)) {
    throw new ApiError(`"${frame.name}" is the inside of a nested layer and lives on no page.`, "Enter its layer to edit it.");
  }
}

export const frameUpdate = defineCommand({
  id: "frame.update",
  summary: "Change a comp: name, MODE (timeline / flipbook / static — switching is lossless), size (optionally scaling its contents), background, fps, duration, or any other field by patch.",
  effect: "write",
  input: z.object({
    id: z.string().optional().describe("Omitted = the focused comp."),
    name: z.string().optional(),
    mode: frameModeInput
      .optional()
      .describe(
        "Switch mode, losslessly. → static stills the timeline at `atMs` (clips and keys untouched); → timeline resumes there; → flipbook wraps the current content as frame 1 (a sheet that is still one frame dissolves back into layers when you leave flipbook).",
      ),
    atMs: z
      .number()
      .min(0)
      .optional()
      .describe("The frame-local instant a static frame shows: used when switching to static, or alone to move an existing still. Omitted = the frame's own current time."),
    width: z.number().int().min(16).optional(),
    height: z.number().int().min(16).optional(),
    scaleContents: z.boolean().default(false),
    background: z.string().optional(),
    fps: z.number().positive().max(240).optional(),
    durationMs: z.number().positive().optional(),
    pageId: z.string().optional().describe("Move it to this page (id or name), beside the comps already there."),
    effects: z
      .array(z.object({ type: z.string(), id: z.string().optional() }).passthrough())
      .optional()
      .describe("REPLACE the comp's own effect stack (the whole frame): cards in render order, each `{type, ...fields}` with its fields flat (catalog.get layer-effects <type>); `[]` clears it. frame.get reads it; effects.add / effects.look with the comp id add to it."),
    ops: z.array(patchOpSchema).optional().describe("Anything else on the frame (fills, guides, overflow, motionBlur…)."),
  }),
  run(input, rt) {
    const target = resolveTargetFrame(rt, input.id);
    let effectsLayerId: string | null | undefined;
    rt.write("Edit comp", (d) => {
      const frame = requireFrame(d, target.id);
      if (input.effects) effectsLayerId = setFrameEffectsIn(d, frame.id, input.effects.map(frameEffectCard))?.id ?? null;
      if (input.pageId) moveFrameOrThrow(d, frame.id, input.pageId);
      if (input.name) frame.name = input.name;
      if (input.background) frame.background = input.background;
      if (input.width || input.height) {
        resizeFrame(d, frame.id, input.width ?? frame.width, input.height ?? frame.height, { scaleContents: input.scaleContents });
      }
      if (input.mode && input.mode !== frame.mode) {
        setFrameMode(d, frame.id, input.mode, { atMs: input.atMs ?? (frame.id === rt.session.focusFrameId() ? rt.session.playheadMs() : undefined) });
      } else if (input.atMs !== undefined) {
        if (frame.mode !== "static") throw new ApiError("Only a static frame has a still to move.", 'Switch it with mode:"static" (atMs picks the instant).');
        frame.stillMs = quantizeMsToFrame(input.atMs, frameFps(d, frame));
      }
      // Length and rate have ONE door each: a lone comp's length lives on the
      // document and a privately nested comp's on its owner (`setFrameDurationMs`),
      // so an op writing `frame.durationMs` straight was accepted and then ignored.
      // Route those ops through the same setters as the named fields.
      const ops = (input.ops ?? []).filter((op) => {
        if (op.op !== "set" || typeof op.value !== "number") return true;
        if (op.path === "durationMs") return setFrameDurationMs(d, frame.id, op.value), false;
        if (op.path === "fps") return setFrameFps(d, frame.id, op.value), false;
        return true;
      });
      if (input.fps) setFrameFps(d, frame.id, input.fps);
      if (input.durationMs) setFrameDurationMs(d, frame.id, input.durationMs);
      if (ops.length) {
        const plain = structuredClone(current(frame)) as unknown as Record<string, unknown>;
        applyPatchOps(plain, ops);
        const parsed = frameSchema.safeParse(plain);
        if (!parsed.success) throw new ApiError(`That would make the comp invalid — ${formatIssues(parsed.error)}.`);
        refuseDroppedKeys(plain, parsed.data, ops);
        // A mode is not a field to overwrite: switching re-homes content (a
        // flipbook's cells) and must stay lossless, so it has one door.
        if (parsed.data.mode !== frame.mode || parsed.data.stillMs !== frame.stillMs) {
          throw new ApiError("mode and the still change through frame.update {mode, atMs}, not ops.");
        }
        Object.assign(frame, parsed.data);
      }
    });
    return { id: target.id, ...(effectsLayerId !== undefined ? { effects: frameEffectsSummary(rt.doc(), target.id) } : {}) };
  },
});

/** One card of `frame.update {effects}`: made by the type's own factory (defaults, a fresh id), its fields laid on, checked. */
function frameEffectCard(card: { type: string; id?: string } & Record<string, unknown>, i: number): LayerEffect {
  if (!layerEffectTypeDef(card.type as LayerEffect["type"])) throw new ApiError(`effects[${i}]: no layer effect "${card.type}".`, "catalog.list layer-effects names them.");
  const made = createLayerEffect(card.type as LayerEffect["type"]);
  const parsed = layerEffectSchema.safeParse({ ...made, ...card, id: card.id ?? made.id });
  if (!parsed.success) throw new ApiError(`effects[${i}] (${card.type}): ${formatIssues(parsed.error)}.`, `catalog.get layer-effects ${card.type} lists its fields.`);
  return parsed.data;
}

/**
 * A COMP'S OWN EFFECTS, as the API reads them: the cards, in render order, and
 * the layer that carries them (its "Frame effects" layer — keys on that layer
 * animate them, `lfx.<effectId>.<field>`). Null when the comp has none.
 */
function frameEffectsSummary(doc: MotionDocument, frameId: string) {
  const clip = frameEffectClip(doc, frameId);
  return clip ? { layerId: clip.id, cards: clip.effects } : null;
}

export const frameGet = defineCommand({
  id: "frame.get",
  summary: "One comp's data: size, rate, length (and whether it follows its content), mode, background, motion blur, sound mix — and its own effect stack.",
  details:
    "`effects` is the comp's own stack (the whole frame): its cards in render order and `layerId`, the \"Frame effects\" layer that carries them, or null when there are none. Change it with frame.update {effects} (`[]` clears it), effects.add / effects.look with the comp id, or effects.update on that layer.",
  effect: "read",
  input: z.object({ id: z.string().optional().describe("Omitted = the focused comp.") }),
  run(input, rt) {
    const doc = rt.doc();
    const frame = resolveTargetFrame(rt, input.id);
    return {
      ...frame,
      durationMs: frameDurationMs(doc, frame),
      // No length of its own: it ends where its last layer ends, and moves with it.
      durationFollowsContent: frame.durationMs == null && !compOwnerNested(doc, frame.id),
      fps: frameFps(doc, frame),
      effects: frameEffectsSummary(doc, frame.id),
    };
  },
});

/**
 * SOUND CATEGORIES — the project's buses. One verb for the family because an
 * agent's jobs here are few and joined: make one, tune it (fader, kind,
 * target, ducking), or remove it. Routing a layer is `layer.patch soundBus`;
 * a comp's leveler/limiter is `frame.update ops soundMix.*`.
 */
export const soundCategory = defineCommand({
  id: "sound.category",
  summary: "Create, update or delete a sound category (bus): name, kind, fader, mute/solo, loudness target, ducking. Lists them when called with no action.",
  effect: "write",
  input: z.object({
    action: z.enum(["list", "create", "update", "delete"]).default("list"),
    id: z.string().optional().describe("The category (update/delete). Built-ins: voice, music, sfx, ambience."),
    name: z.string().optional(),
    character: soundCharacterSchema.optional().describe("How the leveler hears it: voice, music, sfx, ambience."),
    color: z.string().optional(),
    volume: z.number().min(0).max(4).optional().describe("Linear fader, 1 = 0 dB."),
    muted: z.boolean().optional(),
    solo: z.boolean().optional(),
    targetLufs: z.number().min(-40).max(-6).nullable().optional(),
    ducking: z.array(duckRuleSchema.partial({ id: true })).optional().describe("Replaces its ducking rules."),
  }),
  run(input, rt) {
    if (input.action === "list") {
      return { categories: rt.doc().soundBuses.map((b) => ({ id: b.id, name: b.name, character: b.character, volume: b.volume, muted: b.muted, solo: b.solo, targetLufs: b.targetLufs, ducking: b.ducking, builtIn: b.builtIn })) };
    }
    let id = input.id ?? "";
    rt.write(`Sound category ${input.action}`, (d) => {
      if (input.action === "create") id = createSoundBus(d, { name: input.name ?? "Category", character: input.character, color: input.color });
      if (input.action === "delete") {
        if (!deleteSoundBus(d, id)) throw new ApiError(`No custom category "${id}".`, "Built-in categories cannot be deleted — mute them instead.");
        return;
      }
      const bus = d.soundBuses.find((b) => b.id === id);
      if (!bus) throw new ApiError(`No category "${id}".`, "sound.category with no action lists them.");
      if (input.name !== undefined) bus.name = input.name;
      if (input.character) bus.character = input.character;
      if (input.color) bus.color = input.color;
      if (input.volume !== undefined) bus.volume = input.volume;
      if (input.muted !== undefined) bus.muted = input.muted;
      if (input.solo !== undefined) bus.solo = input.solo;
      if (input.targetLufs !== undefined) bus.targetLufs = input.targetLufs;
      if (input.ducking) bus.ducking = input.ducking.map((r) => makeDuckRule(r.under, r));
    });
    return { id };
  },
});

export const frameDelete = defineCommand({
  id: "frame.delete",
  summary: "Delete a comp and every layer in it. A project may have no comps at all.",
  effect: "write",
  input: z.object({ id: z.string() }),
  run(input, rt) {
    requireFrame(rt.doc(), input.id);
    rt.write("Delete comp", (d) => {
      if (!deleteFrame(d, input.id)) throw new ApiError("That comp could not be deleted.");
    });
    return { deleted: input.id };
  },
});

export const historyUndo = defineCommand({
  id: "history.undo",
  summary: "Undo your own most recent edit step. Refuses to undo anything the user did.",
  effect: "write",
  input: z.object({}),
  run(_input, rt) {
    const label = rt.store.peekUndoLabel();
    if (!label || !label.startsWith(`${rt.actor} · `)) {
      throw new ApiError("The last step is not yours to undo.", "Fix forward with another edit instead.");
    }
    rt.store.undo();
    return { undid: label };
  },
});

/**
 * THE CHANNEL'S MAIN MOVE: duplicate a comp, change the words. The editor's
 * own Duplicate (the same core op), so a copy from the agent and a copy from
 * the menu are the same copy.
 */
export const frameDuplicate = defineCommand({
  id: "frame.duplicate",
  summary: "Duplicate a comp with everything in it, beside the original or on another page. Returns the new comp id.",
  details:
    "The copy is independent: its layers are new (read their ids with layers.list). A COMPONENT comp duplicates into a linked instance instead — edits to either show in both.",
  effect: "write",
  input: z.object({
    id: z.string().describe("The comp to copy."),
    name: z.string().min(1).optional(),
    pageId: z.string().optional().describe("Page to put the copy on (id or name); omitted = beside the original."),
  }),
  run(input, rt) {
    requireFrame(rt.doc(), input.id);
    let id = "";
    rt.write("Duplicate comp", (d) => {
      const source = requireFrame(d, input.id);
      id = duplicateFrame(d, source.id) ?? "";
      if (!id) throw new ApiError(`"${source.name}" could not be duplicated.`);
      const copy = requireFrame(d, id);
      if (input.name) copy.name = input.name;
      if (input.pageId) moveFrameOrThrow(d, id, input.pageId);
    });
    return { id };
  },
});

/**
 * Layers from one comp into another — copies, the originals untouched. The
 * editor's own paste (`pasteCarry`): a group arrives with everything inside it,
 * nested groups included, in stack order.
 */
export const layersCopy = defineCommand({
  id: "layers.copy",
  summary: "Copy layers into another comp (or the same one). Positions and timing are kept; returns the new ids of the layers you named.",
  details: "A group copies with everything inside it. `atMs` moves the copies' earliest start there; omitted, each keeps its own start.",
  effect: "write",
  input: z.object({
    ids: idsInput,
    toFrameId: z.string().describe("The comp to copy into."),
    atMs: z.number().min(0).optional(),
  }),
  run(input, rt) {
    const doc = rt.doc();
    const target = requireFrame(doc, input.toFrameId);
    const ids = listOf(input.ids).map((id) => requireClip(doc, id).clip.id);
    // Carried from the settled document: a carry holds the clips themselves.
    const carry = carryClips(doc, ids);
    const startMs = input.atMs ?? Math.min(...carry.clips.map((c) => c.startMs));
    let copied = new Map<string, string>();
    // Into ANOTHER comp the copies have no lane of their own to go back to,
    // and they used to fall to the bottom of the stack — under a full-frame
    // backdrop, invisible. They land in front instead, in their own order, the
    // way a new layer does. Within the same comp they stay beside their source.
    const top = ids
      .filter((id) => requireClip(doc, id).clip.frameId !== target.id)
      .sort((a, b) => requireClip(doc, a).trackIndex - requireClip(doc, b).trackIndex);
    rt.write(ids.length > 1 ? "Copy layers" : "Copy layer", (d) => {
      copied = pasteCarry(d, carry, { frameId: target.id, startMs }).idMap;
      const front = top.map((id) => copied.get(id)).filter((id): id is string => !!id && !locateClip(d, id)?.track.groupId);
      if (front.length) restackClips(d, front, { trackIndex: scopeEdgeIndex(d, null, "top"), groupId: null, frameId: target.id });
    });
    return { ids: ids.map((id) => copied.get(id)).filter((x): x is string => !!x) };
  },
});

/**
 * Take media out of the library. An asset still referenced anywhere in the
 * document (a layer, a fill, a sound, a tracker) is refused rather than left
 * dangling — the same "its id appears in the document" test the slicer uses,
 * since ids are unique tokens. The bytes stay in the store so undo is whole.
 */
export const mediaRemove = defineCommand({
  id: "media.remove",
  summary: "Remove media from the project's library — by id, or every asset nothing uses.",
  details: "Give assetIds, or unused: true. Media a layer still uses is refused and named; delete or swap those layers first.",
  effect: "write",
  input: z
    .object({
      assetIds: z.array(z.string()).min(1).optional().describe("Asset ids from media.list."),
      unused: z.boolean().optional().describe("Remove every asset nothing in the document references."),
    })
    .refine((v) => !!v.assetIds !== !!v.unused, "Give assetIds or unused: true, not both."),
  run(input, rt) {
    const doc = rt.doc();
    const rest = JSON.stringify({ ...doc, assets: [] });
    const inUse = (id: string) => rest.includes(id);
    const targets = input.unused ? doc.assets.filter((a) => !inUse(a.id)) : doc.assets.filter((a) => input.assetIds!.includes(a.id));
    if (input.assetIds) {
      const missing = input.assetIds.filter((id) => !doc.assets.some((a) => a.id === id));
      if (missing.length) throw new ApiError(`No media with id ${missing.join(", ")}.`, "media.list names them.");
      const used = targets.filter((a) => inUse(a.id));
      if (used.length) throw new ApiError(`Still in use: ${used.map((a) => `${a.name} (${a.id})`).join(", ")}.`, "Delete or swap the layers that use it first.");
    }
    if (!targets.length) return { removed: [] };
    const gone = new Set(targets.map((a) => a.id));
    rt.write(gone.size > 1 ? "Remove media" : `Remove ${targets[0]!.name}`, (d) => {
      d.assets = d.assets.filter((a) => !gone.has(a.id));
    });
    return { removed: targets.map((a) => ({ id: a.id, name: a.name })) };
  },
});

export const STRUCTURE_COMMANDS = [
  frameGet,
  mediaRemove,
  layersDelete,
  layersDuplicate,
  layersCopy,
  layersMakeUnique,
  layersGroup,
  layersUngroup,
  layoutSet,
  layersRestack,
  timelineMove,
  timelineTrim,
  timelineSplit,
  timelineCloseGaps,
  timelineCutRanges,
  timelineCompact,
  audioDetach,
  audioRejoin,
  frameCreate,
  frameDuplicate,
  pageCreate,
  pageUpdate,
  pageDelete,
  frameUpdate,
  frameDelete,
  soundCategory,
  historyUndo,
];

