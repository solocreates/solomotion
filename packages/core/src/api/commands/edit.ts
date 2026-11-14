import { z } from "zod";
import { findInputDef, coerceInputValue } from "../../components/inputs";
import { inputIdOfPath, inputPath, instanceInputDefs } from "../../components/inputs-fields";
import { current, isDraft } from "immer";
import {
  clipSchema,
  keyframeValueSchema,
  paintSchema,
  partialTextStyleSchema,
  shapeKindSchema,
  solidPaint,
  strokeStyle,
  strokeStyleSchema,
  waveformStyleSchema,
  traceEndSchema,
  traceGhostsSchema,
  traceSpecSchema,
  type StrokeStyle,
  type ScopeOverlay,
  type MotionDocument,
  type Clip,
  type KeyframeValue,
  type Paint,
} from "../../schema";
import {
  createAdjustmentClip,
  createNestedClip,
  createPathClip,
  createShapeClip,
  createTextClip,
  createWaveformClip,
  createTraceClip,
} from "../../factories";
import { clipForAsset } from "../../media/asset-clip";
import { createId } from "../../ids";
import { parseSvgPathData } from "../../vector/svg-path";
import { pivotAtPathOrigin } from "../../pivot";
import { placeClip, type PlaceClipOptions } from "../../timeline/place";
import { laneNumbers } from "../../timeline/lanes";
import { locateClip } from "../../timeline/ops";
import { silentSounds } from "../../audio/cues";
import { setGroupMode } from "../../timeline/group-composite";
import { pivotPoseAt, repivotClip } from "../../timeline/group-space";
import { compRenderTimeMs } from "../../timeline/fps";
import { clipAnimatableProperties } from "../../animation/clip-properties";
import { propertyDef } from "../../animation/properties";
import { parseLengthSpec } from "../../units/length";
import { setFieldUnit } from "../../units/resolve";
import { setClipProperty } from "../../animation/paths";
import { writeChannel } from "../../animation/channels";
import { applyRangePatch, diffAsSplice } from "../../text/ranges";
import { segmentText } from "../../text/segment";
import { spliceClipText } from "../../captions";
import { applyTemplateToClip, getTemplate } from "../../templates/model";
import { ApiError, defineCommand, type CommandRuntime } from "../command";
import { describeDropped, droppedKeys } from "../unknown-keys";
import { requireClip, requireFrame, resolveTargetFrame } from "../lookup";
import { applyPatchOps, formatIssues, patchOpSchema, refuseDroppedKeys, rootKeysOf } from "../patch";
import { fillMissingIds } from "../zod-reflect";

/**
 * CREATING AND CHANGING LAYERS.
 *
 * Three levels, from most to least opinionated, and a caller should use the
 * highest one that fits:
 *
 *   layer.create     a new layer, placed by the app's own landing rule
 *   layer.set        animatable values by PROPERTY PATH — the same paths the
 *                    inspector, keyframes, drivers and nodes use, with After
 *                    Effects semantics (a keyed property takes a key)
 *   layer.patch      anything else in the layer's data, validated against the
 *                    schema before it lands
 */

const paintInput = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe('A colour ("#FF3366", "var:<id>") or a full Paint object (see api.describe paint).');

/**
 * A field the schema does not know would be stripped by zod and the paint
 * made without it — the object arms below are records, so the registry's own
 * dropped-key check cannot see inside them. Refuse by name instead.
 */
function refuseUnknown(sent: unknown, kept: unknown, what: string, path: string): void {
  const dropped = droppedKeys(sent, kept, path);
  if (dropped.length) throw new ApiError(describeDropped(dropped), `api.describe ${what} shows every field.`);
}

function toPaint(input: z.infer<typeof paintInput>, path = "fill"): Paint {
  if (typeof input === "string") return solidPaint(input);
  const draft = { id: createId("paint"), enabled: true, opacity: 1, blendMode: "normal", ...input };
  fillMissingIds(paintSchema, draft, (prefix) => createId(prefix));
  const parsed = paintSchema.safeParse(draft);
  if (!parsed.success) throw new ApiError(`Invalid paint — ${formatIssues(parsed.error)}.`, "api.describe paint shows every paint type.");
  refuseUnknown(draft, parsed.data, "paint", path);
  return parsed.data;
}

/**
 * A stroke, as loosely as a fill: a colour (4px, centred), the shorthand
 * `{color, width}`, or the stored shape itself — `{paint, width, align, cap,
 * dash, trim…}`, which is what a model that has read the document writes.
 * The two used to differ: `fill` took a full Paint while `stroke` beside it
 * refused everything but colour and width, so a valid stroke failed and a
 * dashed or round-capped one could not be made in one call.
 */
const strokeInput = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe('A colour (4px, centred), {color, width}, or a full stroke {paint, width, align, cap, join, dash, trim…} (api.describe stroke).');

const DEFAULT_STROKE_WIDTH = 4;

function toStroke(input: z.infer<typeof strokeInput>): StrokeStyle {
  if (typeof input === "string") return strokeStyle(solidPaint(input), { width: DEFAULT_STROKE_WIDTH });
  const { color, paint, ...rest } = input;
  if (color !== undefined && paint !== undefined) throw new ApiError("A stroke takes `color` or `paint`, not both.");
  const width = typeof rest.width === "number" ? rest.width : DEFAULT_STROKE_WIDTH;
  const fill = paint !== undefined ? toPaint(paint as z.infer<typeof paintInput>, "stroke.paint") : solidPaint(typeof color === "string" ? color : "#FFFFFF");
  const draft = { ...strokeStyle(fill, { width }), ...rest, paint: fill };
  fillMissingIds(strokeStyleSchema, draft, (prefix) => createId(prefix));
  const parsed = strokeStyleSchema.safeParse(draft);
  if (!parsed.success) throw new ApiError(`Invalid stroke — ${formatIssues(parsed.error)}.`, "api.describe stroke shows every field.");
  refuseUnknown(draft, parsed.data, "stroke", "stroke");
  return parsed.data;
}

const placementInput = z
  .object({
    above: z.string().optional().describe("Land directly above this layer (joins its group)."),
    below: z.string().optional().describe("Land directly below this layer."),
    groupId: z.string().optional().describe("Land inside this group, on top of its members."),
  })
  .optional()
  .describe("Where in the stack. Omitted = on top of what is on screen at that time.");

/** Several paints at once, bottom first — what `fill`/`stroke` are the one-paint shorthand for. */
const paintLists = {
  fills: z.array(paintInput).optional().describe("Several fills, bottom first (instead of `fill`)."),
  strokes: z.array(strokeInput).optional().describe("Several strokes, bottom first (instead of `stroke`)."),
};

const common = {
  frameId: z.string().optional().describe("Comp to create in; omitted = the focused comp."),
  name: z.string().optional(),
  startMs: z.number().min(0).optional().describe("Comp time; omitted = the playhead."),
  durationMs: z.number().positive().optional(),
  x: z.number().optional().describe("Pivot x, comp space, centre origin."),
  y: z.number().optional().describe("Pivot y, comp space, centre origin (+y down)."),
  placement: placementInput,
  set: z
    .record(z.string(), keyframeValueSchema)
    .optional()
    .describe("Property-path values to apply right away (same paths as layer.set): {\"opacity\":0.8,\"rotation\":-4}."),
};

const createInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1),
    style: partialTextStyleSchema.optional().describe("Typography; see api.describe textStyle."),
    template: z.string().optional().describe("A text template id (catalog.list text-templates) — a finished look."),
    maxWidth: z.number().positive().optional().describe("Wrap width in px; omitted = one line per paragraph."),
    caption: z.boolean().optional().describe("Make it a caption (word cues + a spoken-word highlight)."),
    ...common,
  }),
  z.object({
    kind: z.literal("shape"),
    shape: shapeKindSchema,
    width: z.number().positive(),
    height: z.number().positive(),
    fill: paintInput.nullable().optional(),
    stroke: strokeInput.nullable().optional(),
    ...paintLists,
    cornerRadius: z.number().min(0).optional(),
    pointCount: z.number().int().min(3).optional(),
    innerRatio: z.number().min(0.01).max(1).optional(),
    ...common,
  }),
  z.object({
    kind: z.literal("path"),
    d: z.string().min(1).describe("SVG path data in the layer's own space, e.g. \"M0 0 C 40 -60 120 -60 160 0\". Its 0,0 is the pivot: x/y place d's origin, so every point lands where d says (an arc about 0,0 shares a circle's centre at the same x/y) and the layer turns about 0,0."),
    fill: paintInput.nullable().optional(),
    stroke: strokeInput.nullable().optional(),
    ...paintLists,
    ...common,
  }),
  z.object({
    kind: z.literal("media"),
    assetId: z.string().describe("An asset from media.list (image, video or audio)."),
    ...common,
  }),
  z.object({
    // "nested" is the layer's kind everywhere it is read (layers.list,
    // api.describe); "comp" is what this verb first called it. Both create one.
    kind: z.enum(["nested", "comp"]),
    sourceFrameId: z.string().describe("Nest this comp as a layer."),
    ...common,
  }),
  z.object({
    kind: z.literal("adjustment"),
    ...common,
  }),
  z.object({
    kind: z.literal("waveform"),
    target: z.string().describe("The audio or video layer it draws (id or name). Spans that layer unless startMs/durationMs say otherwise."),
    waveform: waveformStyleSchema.partial().optional().describe("Look: template, mode, colours, size, bars… (api.describe waveformStyle)."),
    ...common,
  }),
  z.object({
    kind: z.literal("trace"),
    source: z
      .string()
      .optional()
      .describe("The layer whose path it draws (id or name): keyed, expression-driven or a physics body. Omitted = a PEN: the trace draws its own x/y (key them or give them expressions)."),
    point: z.object({ x: z.number(), y: z.number() }).optional().describe("The traced point, local px from the source's box centre (rotates with it: a rim point of a rolling wheel draws a cycloid). Default its centre."),
    trace: z
      .object({
        lengthMs: traceSpecSchema.shape.lengthMs,
        rate: traceSpecSchema.shape.rate,
        coolMs: traceSpecSchema.shape.coolMs,
        falloff: traceSpecSchema.shape.falloff,
        cap: traceSpecSchema.shape.cap,
        head: traceEndSchema.partial(),
        tail: traceEndSchema.partial(),
        ghosts: traceGhostsSchema.partial(),
      })
      .partial()
      .optional()
      .describe("Look: head/tail {color,width,opacity} cooled by age over coolMs (null = the visible trace), lengthMs (null = whole history), ghosts {enabled,everyMs,style,size,opacity,fade,count} (api.describe trace). Default ember #FF5A2E 8px → chalk #EDE9E2 1px."),
    ...common,
  }),
]);

/** `fills` / `strokes` replace the one-paint shorthands; giving both for one side is ambiguous. */
function applyPaintLists(clip: Clip, input: { fill?: unknown; stroke?: unknown; fills?: z.infer<typeof paintInput>[]; strokes?: z.infer<typeof strokeInput>[] }): void {
  if (clip.kind === "audio") return;
  if (input.fills) {
    if (input.fill !== undefined) throw new ApiError("Give `fill` or `fills`, not both.");
    clip.fills = input.fills.map((f, i) => toPaint(f, `fills[${i}]`));
  }
  if (input.strokes) {
    if (input.stroke !== undefined) throw new ApiError("Give `stroke` or `strokes`, not both.");
    clip.strokes = input.strokes.map(toStroke);
  }
}

/**
 * Every API birth SETTLES (`PlaceClipOptions.landing`): on top of what plays
 * during its span, on a lane the comp already has when one sits at that z. An
 * agent builds a scene one layer at a time, and the surface rule left a lane
 * behind per layer — the next scene never found the last one's lanes free.
 */
function placementOf(input: z.infer<typeof placementInput>, doc: MotionDocument): PlaceClipOptions {
  const landing = "settle" as const;
  if (!input) return { landing };
  // Layers are addressable by unique name everywhere — here too ("below: \"Title\"").
  const ref = (id: string) => requireClip(doc, id).clip.id;
  if (input.above) return { aboveClipId: ref(input.above), landing };
  if (input.below) return { belowClipId: ref(input.below), landing };
  if (input.groupId) return { groupId: ref(input.groupId), landing };
  return { landing };
}

/** Validate a clip against the schema, throwing a caller-readable error. */
export function validClip(clip: unknown, what: string): Clip {
  const plain = isDraft(clip) ? current(clip) : clip;
  const parsed = clipSchema.safeParse(plain);
  if (!parsed.success) {
    throw new ApiError(`${what} would make the layer invalid — ${formatIssues(parsed.error)}.`, "api.describe <kind> shows the valid shape.");
  }
  return parsed.data;
}

/** The property paths a clip accepts, for "did you mean" errors. With the
 *  document, an instance's component inputs (`input.<id>`) are among them. */
export function knownPaths(clip: Clip, doc?: MotionDocument): Set<string> {
  return new Set(clipAnimatableProperties(clip, doc).map((p) => p.path));
}

/**
 * An instance's input may be named the way a person reads it — `input.Mood` —
 * as well as by id. With the document in hand that becomes `input.<id>`, and
 * the value is made to fit the input (clamped, snapped to a choice).
 */
export function canonicalInputWrite(clip: Clip, path: string, value: KeyframeValue, doc?: MotionDocument): { path: string; value: KeyframeValue } {
  const def = namedInput(clip, path, doc);
  if (!def) return { path, value };
  const coerced = typeof value === "number" || typeof value === "boolean" || typeof value === "string" ? coerceInputValue(def, value) : value;
  return { path: inputPath(def.id), value: coerced };
}

/** The input definition an `input.<id|name>` path names on an instance, or null. */
function namedInput(clip: Clip, path: string, doc?: MotionDocument) {
  const wanted = inputIdOfPath(path);
  if (!doc || !wanted || clip.kind !== "nested") return null;
  return findInputDef(instanceInputDefs(doc, clip), wanted) ?? null;
}

/**
 * THE path every verb that takes a property reads through: `input.Mood` →
 * `input.<id>`, anything else unchanged. `layer.set` knew names while
 * `keyframes.set` and `expression.set` refused them — one verb set, two
 * dialects. Keys and drivers are stored under the id, so a renamed input
 * keeps them.
 */
export function canonicalPath(clip: Clip, path: string, doc?: MotionDocument): string {
  const def = namedInput(clip, path, doc);
  return def ? inputPath(def.id) : path;
}

function suggest(paths: Set<string>, wanted: string): string {
  const scored = [...paths]
    .map((p) => ({ p, d: Math.min(editDistance(p, wanted), editDistance(p.split(".").pop()!, wanted.split(".").pop()!) + 1) }))
    .filter(({ p, d }) => d <= Math.max(2, wanted.length / 4) || p.includes(wanted))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6);
  return scored.length
    ? `Did you mean: ${scored.map((s) => s.p).join(", ")}?`
    : "layer.properties lists every path this layer has.";
}

/** Levenshtein distance — typo tolerance for "did you mean". */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** Refuse a property path the layer does not expose, naming the ones it does. */
export function assertPath(clip: Clip, path: string, paths: Set<string> = knownPaths(clip)): void {
  if (paths.has(path)) return;
  // A real property of layers, just not of a container: say what a group CAN
  // do rather than offering near-miss spellings of the one it cannot.
  if (clip.kind === "group" && propertyDef(path)) {
    throw new ApiError(
      `"${clip.name}" is a group, which has no "${path}" of its own.`,
      "A group moves, scales, rotates, fades and takes effects as one (layer.properties lists its paths). For anything else as a unit, layers.nest the members and animate that layer.",
    );
  }
  // A real field of the layer's data that is not animatable (a mode, an
  // option): name the verb that writes it rather than near-miss spellings.
  const stored = storedField(clip, path);
  if (stored !== undefined) {
    throw new ApiError(
      `"${path}" on "${clip.name}" is a setting, not an animatable value — layer.set only writes what can hold a keyframe.`,
      VERB_OWNED[path] ?? `layer.patch {"id":"${clip.id}","ops":[{"op":"set","path":"${path}","value":${JSON.stringify(stored)}}]} (shown with its current value).`,
    );
  }
  throw new ApiError(`"${clip.name}" has no property "${path}".`, suggest(paths, path));
}

/** The value at a dotted path of the layer's stored data, if there is one. */
function storedField(clip: Clip, path: string): unknown {
  let at: unknown = clip;
  for (const step of path.split(".")) {
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, step)) return undefined;
    at = (at as Record<string, unknown>)[step];
  }
  return at;
}

export type WriteMode = "auto" | "base" | "keyframe";

/**
 * Write animatable values onto a DRAFT clip with the app's rule: a keyed
 * property (or `keyframe` mode) takes a key at `localMs`, anything else writes
 * its resting value. The same rule `commitProperty` applies for the inspector
 * — record mode aside, which is a UI state and not an API one.
 */
/**
 * A value as the document stores it. The one translation: a path's GEOMETRY
 * may be given as SVG path data — the notation a model can actually write —
 * and becomes contours here, so morphing is "key `geometry` from one `d` to
 * another" rather than hand-built point arrays.
 */
/**
 * A LENGTH IN A UNIT — `"2spx"`, `"50fw"`, `"25%"`, `"12px"`, or bounded:
 * `"clamp(1spx, 0.2fw, 6spx)"`, `"max(1spx, 0.2fw)"`, `"min(0.2fw, 6spx)"` —
 * on any length path (`AnimatablePropertyDef.length`): records the field's
 * spec (converting its keys when the unit changes, `setFieldUnit`) and hands
 * back the number. A bare number is in whatever unit the field already has.
 */
export function withLengthUnit(clip: Clip, path: string, value: KeyframeValue, doc?: MotionDocument): KeyframeValue {
  if (typeof value !== "string") return value;
  const def = propertyDef(path);
  if (def?.kind !== "number") return value;
  // Only a string that IS a length is claimed: some number paths take names
  // (a pose, an input) and read them their own way further down.
  const len = parseLengthSpec(value);
  if (!len) return value;
  if ((len.unit !== "px" || len.bounds) && !def.length) throw new ApiError(`${path} is not a length, so it takes no unit.`, "Units go on sizes: widths, strokes, fonts, gaps, padding, effect radii (layer.properties marks them length: true).");
  setFieldUnit(doc ?? null, clip, path, len.unit, len.bounds);
  return len.value;
}

export function storedValue(path: string, value: KeyframeValue): KeyframeValue {
  if (path === "geometry" && typeof value === "string") {
    try {
      return parseSvgPathData(value);
    } catch (err) {
      throw new ApiError(`Could not read the path data for geometry: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }
  return value;
}

export function writeProperties(
  clip: Clip,
  values: Record<string, KeyframeValue>,
  localMs: number,
  mode: WriteMode = "auto",
  /** The document — lets an instance's inputs be set, by id or by name. */
  doc?: MotionDocument,
): void {
  const paths = knownPaths(clip, doc);
  for (const [given, rawGiven] of Object.entries(values)) {
    const { path, value: written } = canonicalInputWrite(clip, given, rawGiven, doc);
    assertPath(clip, path, paths);
    const raw = withLengthUnit(clip, path, written, doc);
    const value = storedValue(path, raw);
    if (mode === "base") setClipProperty(clip, path, value);
    else writeChannel(clip, path, localMs, value, { forceKey: mode === "keyframe" });
  }
}

function buildClip(input: z.infer<typeof createInput>, rt: CommandRuntime, doc: MotionDocument): Clip {
  const frame = resolveTargetFrame(rt, input.frameId);
  const startMs = input.startMs ?? rt.session.playheadMs();
  const base = { frameId: frame.id, startMs, x: input.x, y: input.y, durationMs: input.durationMs };
  switch (input.kind) {
    case "text": {
      if (input.template) {
        const template = getTemplate(input.template);
        if (!template) throw new ApiError(`No text template "${input.template}".`, "catalog.list text-templates.");
      }
      const clip = createTextClip({
        ...base,
        text: input.text,
        presetId: null,
        style: input.style as Parameters<typeof createTextClip>[0]["style"],
        caption: input.caption ? {} : undefined,
      });
      if (input.template) applyTemplateToClip(clip, getTemplate(input.template)!);
      if (input.style) Object.assign(clip.style, input.style);
      if (input.maxWidth) clip.maxWidth = input.maxWidth;
      return clip;
    }
    case "shape":
      return createShapeClip({
        ...base,
        shape: input.shape,
        width: input.width,
        height: input.height,
        fill: input.fill === undefined ? undefined : input.fill === null ? null : toPaint(input.fill),
        stroke: input.stroke ? toStroke(input.stroke) : input.stroke === null ? null : undefined,
        cornerRadius:
          input.cornerRadius !== undefined
            ? { tl: input.cornerRadius, tr: input.cornerRadius, br: input.cornerRadius, bl: input.cornerRadius }
            : undefined,
        radius: input.shape === "polygon" || input.shape === "star" ? input.cornerRadius : undefined,
        pointCount: input.pointCount,
        innerRatio: input.innerRatio,
        name: input.name,
      });
    case "path": {
      let subpaths;
      try {
        subpaths = parseSvgPathData(input.d);
      } catch (err) {
        throw new ApiError(`Could not read the path data: ${err instanceof Error ? err.message : String(err)}.`);
      }
      if (!subpaths.length) throw new ApiError("The path data has no contours.");
      const clip = createPathClip({
        ...base,
        subpaths,
        fill: input.fill === undefined ? undefined : input.fill === null ? null : toPaint(input.fill),
        stroke: input.stroke ? toStroke(input.stroke) : input.stroke === null ? null : undefined,
        name: input.name,
      });
      pivotAtPathOrigin(clip);
      return clip;
    }
    case "media": {
      const asset = doc.assets.find((a) => a.id === input.assetId || a.name === input.assetId);
      if (!asset) throw new ApiError(`No media "${input.assetId}".`, "media.list shows the project's media.");
      const clip = clipForAsset(asset, { frameId: frame.id, startMs, x: input.x, y: input.y }, { width: frame.width, height: frame.height });
      if (input.durationMs) clip.durationMs = input.durationMs;
      return clip;
    }
    case "nested":
    case "comp": {
      const source = requireFrame(doc, input.sourceFrameId);
      if (source.id === frame.id) throw new ApiError("A comp cannot contain itself.");
      return createNestedClip({ ...base, sourceFrameId: source.id, name: input.name ?? source.name });
    }
    case "adjustment":
      return createAdjustmentClip({ frameId: frame.id, startMs, durationMs: input.durationMs, name: input.name });
    case "waveform": {
      const target = requireClip(doc, input.target).clip;
      if (target.kind !== "audio" && target.kind !== "video") {
        throw new ApiError(`"${target.name}" is a ${target.kind}; a waveform draws an audio or video layer.`);
      }
      const clip = createWaveformClip({
        frameId: frame.id,
        targetClipId: target.id,
        startMs: input.startMs ?? target.startMs,
        durationMs: input.durationMs ?? target.durationMs,
        x: input.x,
        y: input.y,
        name: input.name ?? `${target.name} · Waves`,
        style: { width: Math.round(frame.width * 0.85), height: Math.round(frame.height * 0.3), ...input.waveform },
      });
      // Linked to its sound, as the Waveform studio makes it: they select,
      // move, split and delete together.
      target.linkGroupId ??= createId("link");
      clip.linkGroupId = target.linkGroupId;
      return clip;
    }
    case "trace": {
      const source = input.source ? requireClip(doc, input.source).clip : null;
      if (source && (source.kind === "audio" || source.frameId !== frame.id)) {
        throw new ApiError(`"${source.name}" is ${source.kind === "audio" ? "a sound" : "in another comp"}; a trace follows a visual layer of its own comp.`);
      }
      // Spans the shot from the playhead (or its source's start) to the comp's end.
      const from = input.startMs ?? (source ? source.startMs : startMs);
      return createTraceClip({
        frameId: frame.id,
        sourceClipId: source?.id ?? null,
        startMs: from,
        durationMs: input.durationMs ?? Math.max(1, (source ? source.startMs + source.durationMs : (frame.durationMs ?? doc.durationMs)) - from),
        x: input.x,
        y: input.y,
        name: input.name ?? (source ? `${source.name} · Trace` : "Trace"),
        trace: { ...input.trace, ...(input.point ? { source: { point: input.point } } : {}) },
      });
    }
  }
}

export const layerCreate = defineCommand({
  id: "layer.create",
  summary: "Create a layer — text, shape, path (SVG d), media from the library, a nested comp, an adjustment layer, or a trace (the path a layer, a body or an expression has drawn over the whole shot).",
  details:
    "Lands on top of what plays during its span, reusing a free lane of the comp at that z (a lane is added only when none is free), unless `placement` says otherwise. `set` applies property-path values in the same step. Returns the new id and its summary.",
  effect: "write",
  input: createInput,
  run(input, rt) {
    let id = "";
    rt.write(`Create ${input.kind}`, (d) => {
      const clip = buildClip(input, rt, d);
      if (input.name) clip.name = input.name;
      if (input.kind === "shape" || input.kind === "path") applyPaintLists(clip, input);
      // Effects, text effects, stops… arrive without ids the caller had to invent,
      // exactly as they do through layer.patch.
      fillMissingIds(clipSchema, clip as unknown as Record<string, unknown>, (prefix) => createId(prefix));
      if (input.set) writeProperties(clip, input.set, 0, "base");
      const valid = validClip(clip, "The new layer");
      placeClip(d, valid, placementOf(input.placement, d));
      id = valid.id;
    });
    const doc = rt.doc();
    const loc = locateClip(doc, id);
    const lane = loc ? laneNumbers(doc, loc.clip.frameId).get(loc.track.id) : undefined;
    // Paint ids, so a script can key what it just made: `fill.${card.fills[0]}`.
    const paints = loc && loc.clip.kind !== "audio" ? loc.clip : null;
    return {
      id,
      name: loc?.clip.name,
      startMs: loc?.clip.startMs,
      durationMs: loc?.clip.durationMs,
      lane,
      ...(paints?.fills.length ? { fills: paints.fills.map((f) => f.id) } : {}),
      ...(paints?.strokes.length ? { strokes: paints.strokes.map((f) => f.id) } : {}),
    };
  },
});

export const layerSet = defineCommand({
  id: "layer.set",
  summary: "Set animatable values by property path on one or more layers (x, y, rotation, opacity, fill.<id>.color, lfx.<id>.radius, fontSize…).",
  details:
    "mode `auto` (default) writes a keyframe at `atMs` when the property is already keyframed and the resting value otherwise; `keyframe` always keys; `base` always writes the resting value. layer.properties lists every path a layer has. `atMs` is comp time (default: the playhead). A SIZE takes a unit as text: \"2spx\" (screen px — steady at any zoom or nest scale: non-scaling strokes, glows, markers), \"50fw\"/\"10fh\" (% of the comp), \"5vw\"/\"5vh\" (% of the output, steady at any zoom), \"25%\" (of the parent box), \"12px\" (back to px). BOUND it like CSS: \"clamp(1spx, 0.2fw, 6spx)\" (grows with the frame, never under 1 or over 6 screen px), \"max(1spx, …)\", \"min(…, 6spx)\". The field keeps its unit and bounds: later bare numbers and keys are in that unit.",
  effect: "write",
  input: z.object({
    ids: z.union([z.string(), z.array(z.string()).min(1)]),
    values: z.record(z.string(), keyframeValueSchema),
    atMs: z.number().optional(),
    mode: z.enum(["auto", "base", "keyframe"]).default("auto"),
  }),
  run(input, rt) {
    const ids = typeof input.ids === "string" ? [input.ids] : input.ids;
    const at = input.atMs ?? rt.session.playheadMs();
    for (const id of ids) requireClip(rt.doc(), id);
    rt.write("Set properties", (d) => {
      for (const id of ids) {
        const loc = requireClip(d, id);
        writeProperties(loc.clip, input.values, at - loc.clip.startMs, input.mode, d);
        validClip(loc.clip, `Setting ${Object.keys(input.values).join(", ")}`);
      }
    });
    return { updated: ids.length };
  },
});

/** Named pivots, as the anchor grid in the inspector lays them out. */
const PIVOT_POINTS: Record<string, { x: number; y: number }> = {
  center: { x: 0.5, y: 0.5 },
  top: { x: 0.5, y: 0 },
  bottom: { x: 0.5, y: 1 },
  left: { x: 0, y: 0.5 },
  right: { x: 1, y: 0.5 },
  "top-left": { x: 0, y: 0 },
  "top-right": { x: 1, y: 0 },
  "bottom-left": { x: 0, y: 1 },
  "bottom-right": { x: 1, y: 1 },
};

/**
 * THE PIVOT, MOVED WITHOUT MOVING THE LAYER — the stage's crosshair drag as a
 * verb. Writing `anchor` (layer.set) moves the picture: the layer is placed by
 * its pivot, so a new pivot at the same position puts the art somewhere else,
 * which is right when that is the point and a surprise when the pivot was only
 * meant to change what it rotates and scales about. This holds the art still:
 * the position and every position KEY move by their own correction
 * (`repivotClip`), so a motion path keeps its shape on screen.
 */
export const layerPivot = defineCommand({
  id: "layer.pivot",
  summary: "Move a layer's pivot (the point it rotates and scales about) WITHOUT moving the layer — position and position keys are corrected so nothing moves on screen.",
  details:
    "`anchor` is {x, y} across the layer's own box (0..1; 0.5,0.5 = centre; outside 0..1 is beyond the box) or a name: center, top, bottom, left, right, top-left, top-right, bottom-left, bottom-right. Writing `anchor` with layer.set instead moves the picture. Works on groups (their pivot is a delta about their members' rest box).",
  effect: "write",
  input: z.object({
    ids: z.union([z.string(), z.array(z.string()).min(1)]),
    anchor: z.union([z.object({ x: z.number(), y: z.number() }), z.enum(Object.keys(PIVOT_POINTS) as [string, ...string[]])]),
    atMs: z.number().optional().describe("Comp time whose pose is held exactly (default the playhead); keys elsewhere get their own correction."),
  }),
  run(input, rt) {
    const ids = typeof input.ids === "string" ? [input.ids] : input.ids;
    const anchor = typeof input.anchor === "string" ? PIVOT_POINTS[input.anchor]! : input.anchor;
    const at = input.atMs ?? rt.session.playheadMs();
    for (const id of ids) if (requireClip(rt.doc(), id).clip.kind === "audio") throw new ApiError("A sound has no pivot.");
    const moved: Array<{ id: string; x: number; y: number; anchor: { x: number; y: number } }> = [];
    rt.write("Move pivot", (d) => {
      for (const id of ids) {
        const clip = requireClip(d, id).clip;
        const local = Math.max(0, Math.min(clip.durationMs, at - clip.startMs));
        repivotClip(d, clip, anchor, (ms) => pivotPoseAt(clip, ms), local);
        validClip(clip, "Moving the pivot");
        if (clip.kind !== "audio") moved.push({ id: clip.id, x: clip.transform.x, y: clip.transform.y, anchor: { ...clip.transform.anchor } });
      }
    });
    return { moved };
  },
});

/** Top-level fields a patch must leave to their own verb — each has invariants a raw write would break. */
const VERB_OWNED: Record<string, string> = {
  id: "Ids are permanent.",
  kind: "A layer cannot change kind; create a new one.",
  frameId: "Move a layer between comps with layers.restack.",
  text: "Use text.set — it carries styled ranges and caption cues across the edit.",
  startMs: "Use timeline.move / timeline.trim — they respect lanes and neighbours.",
  durationMs: "Use timeline.trim.",
};

export const layerPatch = defineCommand({
  id: "layer.patch",
  summary: "Edit any part of a layer's data by path (set / merge / insert / remove / move), schema-validated.",
  details:
    'For what layer.set does not cover: structure, lists, modes, non-animated options. Paths are dotted with list steps: `style.highlight`, `effects[id=lfx_1].enabled`, `fills[0]`, `strokes[-]` (append). Example: {"op":"merge","path":"style","value":{"align":"left"}}. The whole layer is re-validated; nothing lands if any op is invalid. Call api.describe first for a type you have not written before.',
  effect: "write",
  input: z.object({
    id: z.string(),
    ops: z.array(patchOpSchema).min(1),
  }),
  run(input, rt) {
    for (const key of rootKeysOf(input.ops).flatMap((k) => k.split(","))) {
      if (key in VERB_OWNED) throw new ApiError(`layer.patch cannot write "${key}".`, VERB_OWNED[key]);
    }
    rt.write("Edit layer", (d) => {
      const loc = requireClip(d, input.id);
      const plain = structuredClone(current(loc.clip)) as unknown as Record<string, unknown>;
      applyPatchOps(plain, input.ops);
      // Inserted fills, stops, effects… get ids the caller did not have to invent.
      fillMissingIds(clipSchema, plain, (prefix) => createId(prefix));
      const clip = validClip(plain, "This patch");
      refuseDroppedKeys(plain, clip, input.ops);
      const modeBefore = loc.clip.kind === "group" ? loc.clip.mode : null;
      loc.track.clips[loc.clipIndex] = clip;
      // A group's mode has one writer: entering mask/subtract/… with no stencil
      // promotes the top member, as the Combine buttons do. A raw write left
      // the group with no cutter, so it painted unoperated — cutters as solid
      // shapes over the content they were meant to cut.
      if (clip.kind === "group" && clip.mode !== modeBefore) setGroupMode(d, clip.id, clip.mode);
    });
    // A sound that rides nothing mixes to silence; say so at the write, not at the export.
    const silent = rootKeysOf(input.ops).some((k) => k.split(",").includes("sounds")) ? silentSounds([locateClip(rt.doc(), input.id)!.clip]) : [];
    return silent.length ? { updated: input.id, warning: `Silent: ${silent.map((s) => `${s.sound} — ${s.why}`).join(" ")}` } : { updated: input.id };
  },
});

export const textSet = defineCommand({
  id: "text.set",
  summary: "Replace a text or caption layer's words, carrying its styled ranges and caption cues across the edit.",
  effect: "write",
  input: z.object({ id: z.string(), text: z.string().min(1) }),
  run(input, rt) {
    rt.write("Edit text", (d) => {
      const loc = requireClip(d, input.id);
      if (loc.clip.kind !== "text") throw new ApiError(`"${loc.clip.name}" is a ${loc.clip.kind}, not text.`);
      const chars = (t: string) => segmentText(t).graphemes.map((g) => g.char);
      const splice = diffAsSplice(chars(loc.clip.text), chars(input.text));
      spliceClipText(loc.clip, input.text, splice);
    });
    return { updated: input.id };
  },
});

export const textStyle = defineCommand({
  id: "text.style",
  summary: "Style part of a text — a word, a phrase, or a character range — without touching the rest.",
  details:
    "Target with `match` (a substring; `occurrence` picks which) or `start`/`end` grapheme indices. `style` is any subset of textStyle (color, fontWeight, fontSize, italic, highlight, textEffects — a shadow, glow, extrude or echo on just these words). `strokes` OUTLINES the words (the stroke pipeline, same shape as layer.create's) and `fills` repaints them, on top of the layer's own; each replaces what this call's range added before, and [] removes it. To style the WHOLE layer use layer.patch {op:merge, path:style} or layer.set.",
  effect: "write",
  input: z.object({
    id: z.string(),
    match: z.string().optional(),
    occurrence: z.union([z.literal("all"), z.number().int().min(1)]).default(1).describe("1 = first match."),
    start: z.number().int().min(0).optional(),
    end: z.number().int().min(1).optional(),
    style: partialTextStyleSchema.default({}),
    strokes: z.array(strokeInput).optional().describe("Outlines for these words only, bottom first ([] removes them)."),
    fills: z.array(paintInput).optional().describe("Fills for these words only, bottom first ([] removes them)."),
  }),
  run(input, rt) {
    const loc = requireClip(rt.doc(), input.id);
    if (loc.clip.kind !== "text") throw new ApiError(`"${loc.clip.name}" is not a text layer.`);
    if (!Object.keys(input.style).length && !input.strokes && !input.fills) throw new ApiError("Nothing to style.", "Pass `style`, `strokes` or `fills`.");
    const spans = spansOf(loc.clip.text, input);
    const strokes = input.strokes?.map(toStroke);
    const fills = input.fills?.map((f, i) => toPaint(f, `fills[${i}]`));
    rt.write("Style text", (d) => {
      const clip = requireClip(d, input.id).clip;
      if (clip.kind !== "text") return;
      // A range's own outline and paint are its overlay's ADDITIONS — the
      // same lists the Focus tab and the range inspector write.
      const overlay = strokes || fills
        ? (ov: ScopeOverlay) => {
            // Fresh ids per range: `stroke.<id>` / `fill.<id>` key one range's list, not every match's.
            if (strokes) ov.added.strokes = strokes.map((x) => ({ ...structuredClone(x), id: createId("stroke") }));
            if (fills) ov.added.fills = fills.map((x) => ({ ...structuredClone(x), id: createId("paint") }));
          }
        : undefined;
      for (const [s, e] of spans) clip.ranges = applyRangePatch(clip.ranges, s, e, { style: input.style, overlay });
      validClip(clip, "This style");
    });
    return { styled: spans };
  },
});

/** Grapheme spans a text.style call addresses. */
function spansOf(
  text: string,
  input: { match?: string; occurrence: "all" | number; start?: number; end?: number },
): Array<[number, number]> {
  const graphemes = segmentText(text).graphemes;
  if (input.match === undefined) {
    const start = input.start ?? 0;
    const end = Math.min(input.end ?? graphemes.length, graphemes.length);
    if (end <= start) throw new ApiError(`Empty range ${start}…${end} (text has ${graphemes.length} graphemes).`);
    return [[start, end]];
  }
  // Grapheme offsets of each code-unit boundary, so a match found in the
  // string maps onto the indices ranges are stored in.
  const offsets: number[] = [];
  graphemes.forEach((g, i) => (offsets[g.stringIndex] = i));
  offsets[text.length] = graphemes.length;
  const spans: Array<[number, number]> = [];
  const needle = input.match;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    const s = offsets[at];
    const e = offsets[at + needle.length];
    if (s !== undefined && e !== undefined) spans.push([s, e]);
    from = at + Math.max(1, needle.length);
  }
  if (!spans.length) throw new ApiError(`"${needle}" does not appear in the text.`);
  if (input.occurrence === "all") return spans;
  const pick = spans[input.occurrence - 1];
  if (!pick) throw new ApiError(`Only ${spans.length} occurrence(s) of "${needle}".`);
  return [pick];
}

export const templateApply = defineCommand({
  id: "template.apply",
  summary: "Apply a text template (a finished look: type, effects, in/out animation, sound) to text layers.",
  effect: "write",
  input: z.object({ ids: z.union([z.string(), z.array(z.string()).min(1)]), templateId: z.string() }),
  run(input, rt) {
    const template = getTemplate(input.templateId);
    if (!template) throw new ApiError(`No text template "${input.templateId}".`, "catalog.list text-templates.");
    const ids = typeof input.ids === "string" ? [input.ids] : input.ids;
    rt.write(`Apply ${template.name}`, (d) => {
      for (const id of ids) {
        const clip = requireClip(d, id).clip;
        if (clip.kind !== "text") throw new ApiError(`"${clip.name}" is not a text layer.`);
        applyTemplateToClip(clip, template);
      }
    });
    return { applied: template.id, to: ids };
  },
});

/** Snap a caller's comp time onto the comp's frame grid, as every placement does. */
export function onGrid(doc: MotionDocument, frameId: string, ms: number): number {
  return compRenderTimeMs(doc, frameId, Math.max(0, ms));
}

export const EDIT_COMMANDS = [layerCreate, layerSet, layerPivot, layerPatch, textSet, textStyle, templateApply];
