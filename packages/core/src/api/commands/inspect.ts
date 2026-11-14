import { z } from "zod";
import type { MotionDocument, Clip, TextClip } from "../../schema";
import { textFacesReady } from "../../text/measure";
import { clipsUnderGroup } from "../../timeline/groups";
import {
  assetSchema,
  captionSpecSchema,
  clipSchema,
  documentSchema,
  easingSchema,
  frameSchema,
  keyframeTrackSchema,
  layerAnimationSpecSchema,
  layerEffectSchema,
  layoutItemSchema,
  layoutSpecSchema,
  paintSchema,
  soundLayerSchema,
  traceSpecSchema,
  strokeStyleSchema,
  textEffectSchema,
  textStyleSchema,
  animationSpecSchema,
  audioEffectSchema,
} from "../../schema";
import { modulatorSchema } from "../../schema/modulators";
import { clipAnimatableProperties } from "../../animation/clip-properties";
import { getClipProperty } from "../../animation/paths";
import { propertyHasKeys, sampleKeyframes } from "../../animation/keyframes";
import { compFps } from "../../timeline/fps";
import { positionOrigin } from "../../timeline/group-space";
import { clipNaturalSize, emptyTrackCount, frameDurationMs } from "../../timeline/ops";
import { frameLanes } from "../../timeline/layer-tree";
import { ApiError, defineCommand } from "../command";
import {
  clipForReading,
  requireClip,
  summarizeAudio,
  summarizeTree,
  resolveTargetFrame,
  visibleFrames,
} from "../lookup";
import { keysAt, schemaAt, schemaSignature } from "../zod-reflect";
import { formatLengthSpec } from "../../units/length";

/**
 * READING — how a caller finds out what is there before it changes anything.
 *
 * Ordered from cheap to expensive: the overview is a paragraph, a layer list is
 * a page, a layer's full JSON is as long as it has to be. The skill tells an
 * agent to climb that ladder only as far as the task needs.
 */

export const docOverview = defineCommand({
  id: "doc.overview",
  summary: "The project at a glance: comps, where the user is, what is selected, media count.",
  details:
    "Call this first. Coordinates everywhere in the API are comp space with the ORIGIN AT THE COMP'S CENTRE and +y down; a 1080×1920 comp spans x −540…540, y −960…960. Times are milliseconds.",
  effect: "read",
  input: z.object({}),
  run(_input, rt) {
    const doc = rt.doc();
    const focus = rt.session.focusFrameId();
    return {
      name: doc.name,
      comps: visibleFrames(doc).map((f) => ({
        id: f.id,
        name: f.name,
        size: [f.width, f.height],
        fps: f.fps,
        durationMs: Math.round(frameDurationMs(doc, f)),
        background: f.background,
        mode: f.mode,
        layers: doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === f.id).length,
        ...(f.id === focus ? { focused: true } : {}),
      })),
      pages: doc.pages.map((p) => ({ id: p.id, name: p.name })),
      playheadMs: Math.round(rt.session.playheadMs()),
      selection: [...rt.session.selection()],
      media: doc.assets.length,
      variables: doc.variables.length,
    };
  },
});

export const layersList = defineCommand({
  id: "layers.list",
  summary: "A comp's layers as a tree (top of the stack first) with time, position, bounds and flags.",
  details:
    "`pos` is the pivot (transform.x/y); `bounds` is [minX,minY,maxX,maxY] of the rotated, scaled box — both comp space, centre origin. `lane` is the layer's timeline row (0 = top of its comp or group). Flags name effects, animations, keyframes and layout at a glance; a nested comp says `inside:embedded|linked|instance` (see layers.makeUnique).",
  effect: "read",
  input: z.object({
    frameId: z.string().optional().describe("Comp id; omitted = the focused comp."),
    depth: z.number().int().min(0).max(12).default(8).describe("How deep into groups to expand."),
    audio: z.boolean().default(true).describe("Include audio clips (listed separately)."),
  }),
  run(input, rt) {
    const doc = rt.doc();
    const frame = resolveTargetFrame(rt, input.frameId);
    const empty = emptyTrackCount(doc, frame.id);
    return {
      comp: {
        id: frame.id,
        name: frame.name,
        size: [frame.width, frame.height],
        fps: compFps(doc, frame.id),
        lanes: frameLanes(doc, frame.id).length,
        ...(empty ? { emptyLanes: empty } : {}),
      },
      layers: summarizeTree(doc, frame.id, input.depth),
      ...(input.audio ? { audio: summarizeAudio(doc, frame.id) } : {}),
    };
  },
});

/** The text layers a box is laid out from: the layer itself, or a group's members. */
function textClipsOf(doc: MotionDocument, clip: Clip): TextClip[] {
  const ids = new Set(clip.kind === "group" ? clipsUnderGroup(doc, clip.id) : [clip.id]);
  const out: TextClip[] = [];
  for (const t of doc.tracks) for (const c of t.clips) if (c.kind === "text" && ids.has(c.id)) out.push(c);
  return out;
}

export const layerGet = defineCommand({
  id: "layer.get",
  summary: "One layer's full data as JSON (bulky parts folded; ask for them by field).",
  details:
    "`box` is the layer's measured size before scale — a text layer's laid-out glyphs, a path's outline, a shape's size — so you can place things against it without a probe render. A GROUP also gets `pivot`: the point its scale and rotation happen about (the centre of what it holds, by its anchor), in its parent's space (the comp's for a top-level group), at the playhead. A group's `transform.x/y` is an OFFSET from where its members rest, not a position: a member at q lands at pivot + (x, y) + scale·(q − pivot). To zoom by s keeping comp point P still: x = (1 − s)·(P.x − pivot.x), same for y.",
  effect: "read",
  input: z.object({
    id: z.string(),
    fields: z.array(z.string()).optional().describe("Only these top-level fields, unfolded. `box` and a group's `pivot` work here too."),
  }),
  async run(input, rt) {
    const wantsBox = !input.fields?.length || input.fields.includes("box");
    const at = rt.doc();
    // A text box is a layout in its real face — wait for the face, not for luck.
    if (wantsBox) await textFacesReady(at, textClipsOf(at, requireClip(at, input.id).clip));
    const doc = rt.doc();
    const clip = requireClip(doc, input.id).clip;
    const out = clipForReading(clip, input.fields);
    // Derived, never stored: the same measure every gizmo and pivot uses.
    const size = wantsBox ? clipNaturalSize(doc, clip) : null;
    if (size) out.box = { width: round1(size.width), height: round1(size.height) };
    // A group's pivot is derived from what it holds (`positionOrigin`, the term
    // every surface adds to a group's x/y) — the number a camera move needs.
    if (clip.kind === "group" && (!input.fields?.length || input.fields.includes("pivot"))) {
      const local = Math.min(clip.durationMs, Math.max(0, rt.session.playheadMs() - clip.startMs));
      const pivot = positionOrigin(doc, clip, local);
      out.pivot = { x: round1(pivot.x), y: round1(pivot.y) };
    }
    return out;
  },
});

export const layerProperties = defineCommand({
  id: "layer.properties",
  summary: "Every animatable property this layer exposes, with its current value — the paths layer.set and keyframes.set take.",
  details:
    "This is the layer's live API: effect fields, paint stops, typography, transform, audio, layout — each with the exact path, its kind, range and whether it is keyframed. Values are read at `atMs` (comp time; default the playhead).",
  effect: "read",
  input: z.object({
    id: z.string(),
    atMs: z.number().optional(),
    group: z.string().optional().describe("Only one group, e.g. Transform, Typography, or an effect's name."),
  }),
  run(input, rt) {
    const clip = requireClip(rt.doc(), input.id).clip;
    const local = Math.max(0, Math.min(clip.durationMs, (input.atMs ?? rt.session.playheadMs()) - clip.startMs));
    const sampled = sampleKeyframes(clip.keyframes, local);
    const rows = clipAnimatableProperties(clip, rt.doc())
      .filter((p) => !input.group || p.group.toLowerCase() === input.group.toLowerCase() || p.groupId === input.group)
      .map((p) => {
        const keyed = propertyHasKeys(clip.keyframes, p.path);
        // An instance's input it never overrode reads its definition's default.
        const value = (keyed ? sampled[p.path] : getClipProperty(clip, p.path)) ?? (p.groupId === "inputs" ? p.def.identity : undefined);
        const range =
          p.def.min !== undefined || p.def.max !== undefined ? [p.def.min ?? null, p.def.max ?? null] : undefined;
        return {
          path: p.path,
          label: p.def.label,
          group: p.group,
          kind: p.def.kind,
          value: typeof value === "number" ? Math.round(value * 1000) / 1000 : (value ?? null),
          ...(range ? { range } : {}),
          ...(keyed ? { keyed: true } : {}),
          // A size: it takes a unit (layer.set {path: "2spx"}); the value above is in `unit`.
          ...(p.def.length ? { length: true, ...(clip.units?.[p.path] ? { unit: clip.units[p.path]!.unit, as: formatLengthSpec(typeof value === "number" ? value : 0, clip.units[p.path]) } : {}) } : {}),
        };
      });
    return { id: clip.id, kind: clip.kind, properties: rows };
  },
});

export const mediaList = defineCommand({
  id: "media.list",
  summary: "The project's media library: assets with kind, size, duration and folder.",
  effect: "read",
  input: z.object({
    kind: z.enum(["image", "video", "audio", "svg", "any"]).default("any"),
    query: z.string().optional().describe("Case-insensitive name filter."),
  }),
  run(input, rt) {
    const doc = rt.doc();
    const folders = new Map(doc.mediaFolders.map((f) => [f.id, f.name] as const));
    const q = input.query?.toLowerCase();
    return doc.assets
      .filter((a) => input.kind === "any" || a.kind === input.kind)
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .map((a) => {
        const row = a as Record<string, unknown>;
        return {
          id: a.id,
          name: a.name,
          kind: a.kind,
          ...(typeof row.width === "number" ? { size: [row.width, row.height] } : {}),
          ...(typeof row.durationMs === "number" ? { durationMs: Math.round(row.durationMs as number) } : {}),
          ...(typeof row.folderId === "string" ? { folder: folders.get(row.folderId) ?? row.folderId } : {}),
        };
      });
  },
});

/**
 * Every type the document is made of, by the name a caller would use for it.
 * Adding an entry here is how a new schema becomes describable — nothing else
 * needs to know it exists.
 */
const DESCRIBABLE = {
  clip: clipSchema,
  frame: frameSchema,
  document: documentSchema,
  asset: assetSchema,
  paint: paintSchema,
  stroke: strokeStyleSchema,
  textStyle: textStyleSchema,
  textEffect: textEffectSchema,
  layerEffect: layerEffectSchema,
  audioEffect: audioEffectSchema,
  textAnimation: animationSpecSchema,
  layerAnimation: layerAnimationSpecSchema,
  keyframeTrack: keyframeTrackSchema,
  easing: easingSchema,
  layout: layoutSpecSchema,
  layoutItem: layoutItemSchema,
  caption: captionSpecSchema,
  modulator: modulatorSchema,
  sound: soundLayerSchema,
  trace: traceSpecSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

const CLIP_KINDS: readonly Clip["kind"][] = [
  "text",
  "group",
  "audio",
  "nested",
  "image",
  "video",
  "shape",
  "path",
  "waveform",
  "trace",
  "raster",
  "adjustment",
];

export const apiDescribe = defineCommand({
  id: "api.describe",
  summary: "The exact shape of any document type, read from the live schema — never out of date.",
  details:
    "`type` is a layer kind (text, shape, path, image, video, group, audio, nested, waveform, raster, adjustment) or one of: " +
    Object.keys(DESCRIBABLE).join(", ") +
    ". `path` drills in: `style`, `effects[]`, `fills[]`, `effects[type=glass]`. Fields ending in ? are optional; `= x` is the default. Use it before layer.patch on anything you have not written before.",
  effect: "read",
  input: z.object({
    type: z.string(),
    path: z.string().optional(),
    depth: z.number().int().min(1).max(5).default(2),
  }),
  run(input) {
    const root: z.ZodTypeAny | undefined = (CLIP_KINDS as readonly string[]).includes(input.type)
      ? schemaAt(clipSchema, `[kind=${input.type}]`) ?? undefined
      : (DESCRIBABLE as Record<string, z.ZodTypeAny>)[input.type];
    if (!root) {
      throw new ApiError(
        `Unknown type "${input.type}".`,
        `Types: ${[...CLIP_KINDS, ...Object.keys(DESCRIBABLE)].join(", ")}.`,
      );
    }
    const target = input.path ? schemaAt(root, input.path) : root;
    if (!target) {
      throw new ApiError(`No path "${input.path}" on ${input.type}.`, `Top-level fields: ${keysAt(root).join(", ")}.`);
    }
    return schemaSignature(target, { depth: input.depth });
  },
});

export const INSPECT_COMMANDS = [docOverview, layersList, layerGet, layerProperties, mediaList, apiDescribe];

const round1 = (n: number) => Math.round(n * 10) / 10;
