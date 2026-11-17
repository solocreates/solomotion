import { z } from "zod";
import { loopModeSchema } from "./animation";
import { assetSchema, mediaFolderSchema } from "./assets";
import { clipSchema, type Clip } from "./clips";
import { transitionSchema } from "./transitions";
import { variableFolderSchema, variableSchema } from "./variables";
import { trackerSchema } from "./tracking";
import { nodeGraphSchema } from "./nodes";
import { expressionSchema } from "./expressions";
import { scriptFolderSchema, scriptSchema } from "./scripts";
import { storedPresetSchema } from "./presets";
import { paintSchema, strokeStyleSchema } from "./vector";
import { frameMotionBlurSchema } from "./motion-blur";
import { worldSpecSchema } from "./world";
import { simulationSchema } from "./physics";
import { machineSchema } from "./machines";
import { inputDefSchema, inputValuesSchema } from "./inputs";
import { BUILT_IN_SOUND_BUSES, frameSoundMixSchema, soundBusSchema } from "./sound-mix";

export const DOCUMENT_VERSION = 117;

/**
 * How visible a frame's SPILL is by default — the artwork that reaches past the
 * artboard's edge (see `frameSchema.overflow`).
 *
 * Not 0 and not 1. Zero is a trapdoor: you draw past the edge, nothing appears,
 * and the app looks broken while your work is sitting there intact. One is
 * noise: every comp on the page showing everything it has ever been given makes
 * a board nobody can read. A quarter says "that is yours, it is outside, it is
 * still here" — and it only ever shows on the frame you are working in.
 */
export const DEFAULT_FRAME_OVERFLOW = 0.25;

/**
 * `stageBackground`'s "follow the app's theme" sentinel — see the field. Not a
 * colour, so `resolveStageBackground` is the one place that turns it into one
 * (into nothing, in fact: the surface keeps its themed CSS token).
 */
export const STAGE_BACKGROUND_THEME = "theme";

/**
 * Timeline track — a Blender-style channel. Tracks are ordered top-to-bottom
 * as shown in the timeline; for rendering, higher tracks paint above lower
 * ones (NLE convention). ANY clip kind rides any track; tracks are all equal
 * and carry only workspace affordances (name, tint color, lane height).
 * Tracks are document-global — visual clips point at the frame (artboard)
 * they render into via `frameId`.
 */
export const trackSchema = z.object({
  id: z.string(),
  name: z.string(),
  clips: z.array(clipSchema),
  muted: z.boolean(),
  locked: z.boolean(),
  hidden: z.boolean(),
  /** Workspace tint for the header/lane; null = neutral. */
  color: z.string().nullable().default(null),
  /** Lane height override in px; null = the default height. */
  heightPx: z.number().min(24).max(240).nullable().default(null),
  /**
   * The comp (frame id) this track was created as a spare/empty lane for —
   * e.g. the "+ Track" button. Only consulted while the track is EMPTY: an
   * occupied track is already scoped by its clips' own `frameId` and shows in
   * whichever comp holds them. Null on tracks created already-occupied
   * (moving a clip past the last lane, precompose, etc. — they never need it).
   * This is what stops a comp's blank spare lanes leaking into every other
   * comp's timeline, including a brand-new nested/component frame.
   */
  homeCompId: z.string().nullable().default(null),
  /**
   * The GROUP whose interior this lane is (v71), or null for a lane at the
   * comp's top level.
   *
   * THE membership edge. A clip belongs to a group because it sits on one of
   * that group's rows — there is no `clip.groupId` — so a track is either a
   * lane of the comp or a row inside exactly one group, and a clip's group is
   * read off its track. Every way of putting a clip on a track therefore
   * decides its group in the same motion, which is what makes "drag it onto
   * that row" and "put it in that group" one gesture rather than two facts to
   * keep agreeing. A group's rows hold only that group's comp's clips.
   *
   * v67 introduced the field as a fallback for EMPTY lanes only, with
   * membership still on the clips; v71 made it the only answer.
   */
  groupId: z.string().nullable().default(null),
  /**
   * This lane was spawned AUTOMATICALLY to carry a single clip — dragging a clip
   * past the first/last lane, dropping media/a preset onto a fresh lane, restack,
   * precompose, or the first-fit fallback when no lane had room. Auto lanes are
   * the ONLY tracks the opt-in empty-track prune removes when their clip leaves;
   * a lane the user MADE (the default tracks, "+ Track") or ADOPTED (a second
   * clip landed on it, `addClipToTrack` clears the flag) is never swept. Legacy
   * docs default to false → nothing they hold is ever auto-deleted (safe).
   */
  auto: z.boolean().default(false),
  /**
   * Track-level loop (v32): the lane's CONTENT span (first clip start → last
   * clip end, per comp) repeats to fill the comp — the "row looping mode" of a
   * flipbook row, available to any track. `none` (default) plays clips exactly
   * where they sit. Applied by the ONE time seam (`trackLocalTime`), so
   * rendering, hit-testing and the sheet's ghost repeats all agree.
   */
  loop: loopModeSchema.default("none"),
  /**
   * Cut transitions (v42) living on this lane. A transition is a relationship
   * BETWEEN two abutted clips (or one clip and nothing), so it cannot be a clip
   * field without duplicating state on both sides of every cut — it lives here,
   * comp-scoped by its own `frameId` exactly like the clips it joins. See
   * timeline/transitions.ts for the geometry and lifecycle brain.
   */
  transitions: z.array(transitionSchema).default([]),
});
export type Track = z.infer<typeof trackSchema>;

/**
 * A ruler guide line on a frame (Figma). `axis` is the axis it's PINNED on:
 * "x" = a vertical guide at frame-local x `pos`; "y" = a horizontal guide at
 * frame-local y `pos`. Frame-local (not world) so guides ride with the artboard
 * and live in the same space as a layer's transform, which lets the one snap
 * engine treat them as just another set of candidate lines.
 */
/** Guide line style. `null` on a guide = inherit the document's default style. */
export const guideStyleSchema = z.enum(["solid", "dashed", "dotted"]);
export type GuideStyle = z.infer<typeof guideStyleSchema>;

export const frameGuideSchema = z.object({
  id: z.string(),
  axis: z.enum(["x", "y"]),
  pos: z.number(),
  /** Per-guide colour override; null = use the default guide colour. */
  color: z.string().nullable().default(null),
  /** Per-guide line style override; null = use the default guide style. */
  style: guideStyleSchema.nullable().default(null),
});
export type FrameGuide = z.infer<typeof frameGuideSchema>;

/**
 * A page (Figma-style): a named workspace holding its own frames. The canvas
 * shows one page at a time; every page's comps stay exportable. Precomposed
 * ("nested clip") source comps live on an auto-managed "Nested" page so they
 * never clutter the page you're designing on.
 */
export const pageSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * PAGE guides (D17): ruler guides dropped on the board outside any frame.
   * Same shape as a frame guide, but `pos` is in CANVAS (world) space, so they
   * stay put when frames move. Optional: absent = none, so older documents and
   * every existing page constructor need no migration (`guideOwner` fills it).
   */
  guides: z.array(frameGuideSchema).optional(),
});
export type Page = z.infer<typeof pageSchema>;

/**
 * Marks a frame as a reusable COMPONENT definition (Figma "main component").
 * Nested clips whose source is a component frame are its INSTANCES — they stay
 * in sync with the definition until detached. A plain nested clip instead
 * references a PRIVATE frame and is fully independent (true nesting). Kept as an
 * object (not a bare boolean) so components can grow descriptions/variants.
 */
export const componentMetaSchema = z.object({
  /** Author note shown on the component's library card / inspector. */
  description: z.string().default(""),
  /**
   * Groups this frame with its sibling VARIANTS into one component set (the
   * dashed box in the Components view). null = legacy/standalone: the frame is
   * its own set, resolved by `componentSetId` (setId ?? frame.id) so old
   * documents need no migration. Every variant of a set shares one setId.
   */
  setId: z.string().nullable().default(null),
  /** This variant's display name within the set ("Main", "Hover", …). */
  variantName: z.string().default("Main"),
});
export type ComponentMeta = z.infer<typeof componentMetaSchema>;

/**
 * A frame (artboard), Figma-style: a named canvas rectangle positioned on the
 * infinite stage. A document can hold many; each is independently exportable.
 * Visual clips are positioned relative to their frame's center.
 */

/** The look of a guide once its per-guide overrides fall back to the defaults. */
export interface GuideAppearance {
  color: string;
  style: GuideStyle;
}

/** Resolve a guide's on-screen look: its own override, else the doc default. */
export function resolveGuideAppearance(
  guide: { color: string | null; style: GuideStyle | null },
  defaultColor: string,
  defaultStyle: GuideStyle,
): GuideAppearance {
  return { color: guide.color ?? defaultColor, style: guide.style ?? defaultStyle };
}

/** The dash pattern (in px) for a guide style — [] = solid. */
export function guideDashPattern(style: GuideStyle): number[] {
  return style === "dashed" ? [6, 4] : style === "dotted" ? [1, 3] : [];
}

export const DEFAULT_GUIDE_COLOR = "#22C7B6";
export const DEFAULT_GUIDE_STYLE: GuideStyle = "solid";

/**
 * What a frame IS — its MODE, the one question "how does this frame's content
 * vary in time?" (v32 introduced it as `role`; v88 made it the three modes).
 *
 *  - "timeline": TIMELINE. Layers live on tracks and move with keyframes; the
 *                playhead runs. Everything before v32, and still the default.
 *  - "flipbook": FRAME BY FRAME. Its tracks are ROWS and its clips are CELLS —
 *                nested clips whose sources are frames of ANY mode (usually a
 *                static drawing, sometimes an animated one). Opening it shows
 *                the sheet instead of the raw timeline.
 *  - "static":   A STILL — a design, a thumbnail, a page, a drawing. It shows
 *                ONE instant (`stillMs`) whatever time it is asked for, so it
 *                has no timeline, nested it holds its picture, and exported it
 *                is an image. Every layer in it spans it.
 *
 * All three are comps: nesting, export, the layers panel, undo and navigation
 * walk them through the same seams. The mode changes which WORKSPACE opens
 * and, for "static", the render clock (`frameEvalTimeMs`) — never a parallel
 * container. Switching modes is `setFrameMode` (timeline/frame-mode.ts), the
 * ONE verb that keeps every switch lossless; never write `mode` directly.
 *
 * v88 renamed `role` → `mode` ("comp" → "timeline") and retired "drawing": a
 * flipbook cell's drawing was a still with a paint workspace, which is exactly
 * what "static" is. Old drawings migrated to "static" when their content
 * cannot change over time and to "timeline" otherwise, so no picture moved.
 */
export const frameModeSchema = z.enum(["timeline", "flipbook", "static"]);
export type FrameMode = z.infer<typeof frameModeSchema>;

export const frameSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Owning page; null = the document's first page. */
  pageId: z.string().nullable().default(null),
  /**
   * The frame's MODE — timeline, flipbook (frame by frame) or static. See
   * `frameModeSchema`; change it only through `setFrameMode`.
   */
  mode: frameModeSchema.default("timeline"),
  /**
   * THE STILL (v88): the instant a STATIC frame shows, in its own local ms.
   * Read only through `frameStillMs` / `frameEvalTimeMs`; meaningless (and
   * cleared) in the other modes. Absent on a static frame = 0.
   *
   * Content, not view state: it decides what the frame exports and what every
   * instance of it shows, so it is an undo step — unlike `playheadMs`. A
   * timeline switched to static keeps its clips and keys untouched and stills
   * them here, at the instant you were standing on; switching back resumes
   * there. Nothing is baked, so nothing is lost.
   */
  stillMs: z.number().min(0).optional(),
  /** Non-null = this frame is a reusable component definition (see above). */
  component: componentMetaSchema.nullable().default(null),
  /**
   * Provenance marker (v43): where this comp's content came from, when that
   * changes how the editor talks about it — today only `"svg"`, stamped on the
   * comp an imported SVG is vectorized into so the breadcrumb can call it
   * vector artwork and a future SVG toolset has a hook. A free-form string
   * rather than an enum on purpose: plugins stamp their own tags, and an
   * unknown tag simply reads as an ordinary nested comp.
   */
  sourceTag: z.string().nullable().default(null),
  /**
   * The SVG asset this comp's vectors were made from (v45), when it was made by
   * "Edit as vector". This is what lets the trip be TWO-WAY: an SVG image and
   * its vector comp are the same artwork in two representations, and neither
   * loses information, so switching back must not re-convert anything — it just
   * shows the other side. Null for every comp not born from an SVG.
   */
  svgAssetId: z.string().nullable().default(null),
  /**
   * Non-null = this frame is a LINKED INSTANCE of the component frame with this
   * id (frame-level instancing, v40). It holds no content of its own — it renders
   * the master's layers in place, and editing them (they're shared) updates the
   * master and every other instance frame live. Alt-drag / copy-paste of a
   * component frame makes another of these; Detach clears it (cloning the
   * master's content in). null = an ordinary, independent frame.
   */
  instanceOf: z.string().nullable().default(null),
  /**
   * THE COMP'S INPUTS — its public, keyable interface (Figma component
   * properties). Any comp may have them; a nested clip of it carries values as
   * `input.<id>` channels, and fields inside bind with `input:<id>` drivers.
   * Absent = none. See `components/inputs.ts` and docs/adr/characters/inputs.md.
   */
  inputs: z.array(inputDefSchema).optional(),
  /**
   * A LINKED INSTANCE frame's input overrides (`instanceOf` set). Static: a
   * frame has no keyframe tracks — key an input on a nested instance clip.
   */
  inputValues: inputValuesSchema.optional(),
  /** Top-left position on the infinite stage (world coordinates). */
  x: z.number(),
  y: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /**
   * Legacy solid background color. Kept as the base tone; when `fills` is empty
   * the frame paints this flat color. Non-empty `fills` (the unified paint list)
   * override it, so a frame can carry gradients/multiple fills like any layer.
   */
  background: z.string(),
  /**
   * Unified paint list for the artboard background (v30) — the SAME Paint model
   * (solid/linear/radial/angular, ordered + merging) and editing UI as every
   * layer. Empty = fall back to `background`. This is what lets frames have
   * gradient backgrounds through the one headless paint path.
   */
  fills: z.array(paintSchema).default([]),
  /** Unified stroke list for the artboard border (same model as any layer). */
  strokes: z.array(strokeStyleSchema).default([]),
  /**
   * HOW VISIBLE THE SPILL IS — artwork that reaches past the artboard's edge,
   * as an opacity from 0 to 1 (v69; was the boolean `clipContent`).
   *
   * A number rather than a switch, because the switch was answering two
   * questions with one bit and getting one of them wrong. "Clip content" is a
   * fact about the OUTPUT — and it never was: export has always rendered into a
   * frame-sized canvas, so the rectangle that ships is the same either way.
   * What the flag actually governed is what you can SEE while you work, and
   * that is not a yes/no. A rough drawn off the side of a shot is not content
   * and is not nothing; it is context, and you want it dimmed.
   *
   *   0    clipped — nothing outside the box, the old `clipContent: true`
   *   1    fully visible, the old `clipContent: false`
   *   0.25 the default: there, quiet, unmistakably outside
   *
   * Two further rules live in the renderer rather than here, because they are
   * facts about a VIEW and not about the document:
   *
   *   - the spill paints only on the frame you are working in. Every comp on a
   *     page showing its overflow at once is a page you cannot read;
   *   - export ignores this field entirely. It is the same promise the boolean
   *     made, kept in one fewer place.
   */
  overflow: z.number().min(0).max(1).default(DEFAULT_FRAME_OVERFLOW),
  /**
   * Per-frame duration override. null = auto: a privately-owned nested comp
   * hugs its owner clip's duration, a single-frame doc's root hugs the
   * document duration, everything else hugs its content end. See
   * `frameDurationMs` (the one brain every consumer — timeline, playback,
   * export — reads).
   */
  durationMs: z.number().positive().nullable(),
  /**
   * Where this comp's own playhead was left (v84) — After Effects keeps a
   * comp's current time in the project, and so do we. Unrelated frames never
   * share an instant: stepping into a sibling restores ITS time, and the board
   * paints every frame you are not standing in at its own. VIEW STATE: written
   * through `store.remember`, never an undo step. Absent = the first frame.
   */
  playheadMs: z.number().min(0).optional(),
  /**
   * This comp's own frame rate (v48) — a CONCRETE number, never an override of
   * some document-global rate, because there is no longer a document-global
   * rate to override. Every frame owns its grid: a 12fps flipbook, a 24fps
   * film comp and a 60fps UI comp coexist in one project and each keeps its
   * own cadence.
   *
   * Read it through `frameFps` / `compFps`, never off the frame directly, so
   * the "unknown frame id" fallback stays in one place.
   *
   * The invariant that makes nesting work: **fps never means time.** Every
   * time in the document is milliseconds, and mixing rates cannot rescale
   * anything, because a rate is only the grid the UI snaps to and the exporter
   * steps on. A 12fps flipbook nested in a 60fps comp holds each cell for
   * 83.33ms whatever the parent does; the parent samples it at 16.67ms steps
   * and simply sees the same cell five times. That is the whole composition
   * rule, and it is why this is a per-frame leaf value rather than anything
   * inherited, resolved or negotiated between parent and child.
   *
   * Non-integer on purpose: 23.976 and 29.97 are real delivery rates.
   *
   * Preprocessed rather than merely defaulted, because the OLD field was
   * `number | null` and a stray legacy `null` reaches this schema from paths
   * that never run the v48 migration — in-memory documents, merges, slice-file
   * templates and library slices, plugin-authored frames. Healing a recoverable
   * field beats refusing to open the whole project over it; the parsed type
   * still cannot be null, so nothing downstream carries a fallback.
   */
  fps: z.preprocess(
    (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 30),
    z.number().positive().max(1000),
  ),
  /**
   * This timeline's loop mode. Nested instances of the frame inherit it as their
   * default playback (a clip can still override per-instance). Default "none".
   */
  loop: loopModeSchema.default("none"),
  /**
   * THE COMP'S SHUTTER (v56) — the motion blur master switch, and the settings
   * every layer in this comp inherits unless it overrides them.
   *
   * It lives beside `fps` because it has to: a shutter angle is a FRACTION OF A
   * FRAME INTERVAL, so it is meaningless without the rate that defines one. The
   * same reasoning that made a rate per-frame makes a shutter per-frame — a
   * 12fps sheet inside a 60fps comp has a five-times-longer frame, and so a
   * 180° shutter there is a five-times-longer exposure. Nothing negotiates
   * across that boundary; each comp's shutter is a fact about its own grid.
   *
   * Defaulted ON for new comps: the significance test in `animation/motion.ts`
   * means a layer that does not move costs one subtraction, so nothing you
   * did not animate ever pays for this. Existing documents are migrated to
   * `false` (v56) so opening an old project renders it exactly as before.
   */
  motionBlur: frameMotionBlurSchema.default({}),
  /** This comp's mix master — leveler, limiter, master fader (v86). See `schema/sound-mix.ts`. */
  soundMix: frameSoundMixSchema.default({}),
  /**
   * THE 3D WORLD (v89). Present = this comp is a world: Z-up space, its clips
   * are the scene, a nested clip of it is the world seen through its active
   * camera. Absent = a flat comp, which is every comp before v89. See
   * `schema/world.ts` and docs/adr/ADR-3d.md.
   */
  world: worldSpecSchema.optional(),
  /** The comp's SIMULATION settings (v92) — gravity, start, floor and walls — for a flat comp and a world alike. Absent = defaults. */
  physics: simulationSchema.optional(),
  /** Rive-style STATE MACHINES (Characters 2.0) — see `schema/machines.ts`. Absent = none. */
  machines: z.array(machineSchema).optional(),
  /** Ruler guides on this artboard (Figma). Empty = none; default for legacy docs. */
  guides: z.array(frameGuideSchema).default([]),
  /**
   * Plugin recipes (v34) — Figma's setPluginData, keyed by plugin id. A
   * GENERATOR plugin (lip-sync, future audio-reactive builders…) stores here
   * whatever it needs to regenerate this frame's content later: source refs,
   * mappings, settings. The document schema stays closed (plugins never add
   * first-class fields); the data must be plain JSON. Plugins own their own
   * shape + versioning under their key.
   */
  pluginData: z.record(z.string(), z.unknown()).default({}),
});
export type Frame = z.infer<typeof frameSchema>;


// Variables (the typed, reusable-value table) live in ./variables. Any bindable
// slot may store a `var:<id>` token that resolves through `doc.variables`.

/**
 * The whole project. This exact shape (versioned) is what gets exported as
 * JSON and consumed by every host adapter (web renderer today; Premiere,
 * Resolve, Blender plugins later).
 *
 * v2: multiple frames (artboards); fps + duration are document-global since
 * there is one shared timeline across all frames.
 * v3: per-frame duration/fps overrides, layer groups, color variables.
 * v48: frame rate is per-frame ONLY — the document-global `fps` is gone. It
 *      and `frame.fps` were two stored fields describing one fact, and the
 *      half of the app that read the document field disagreed with the half
 *      that read the frame's whenever a comp set its own rate. See
 *      `frame.fps` for the composition rule that replaced them.
 */
/**
 * A timeline marker — a named, colored bookmark at a time in one comp's
 * timeline. Snapping treats marker times as magnets; `groupId` reserves the
 * grouping/link system without a future schema break.
 */
export const markerSchema = z.object({
  id: z.string(),
  frameId: z.string(),
  timeMs: z.number().min(0),
  name: z.string().default(""),
  color: z.string().default("#5B9CF6"),
  groupId: z.string().nullable().default(null),
});
export type TimelineMarker = z.infer<typeof markerSchema>;

/**
 * One render-in-place record, keyed by the RENDERED clip's id (v38; v80 whole
 * subtrees). The rendered clip is ordinary media in the original's slot; this
 * keeps everything needed to put the original back EXACTLY:
 *  - `originalSnapshot` — the clip itself (a group, a nested clip, a shape…);
 *  - `rows` — a group's member rows, lifted out while it is rendered;
 *  - `baseline` — the rendered clip's container as committed, so a revert can
 *    tell whether it was edited since (and carry those edits over);
 *  - `soundClipId` — the baked sound laid beside a picture that had any.
 * A nested original's comp stays in the document; the ledger counts as a
 * reference, so no collection deletes it.
 */
export const renderInPlaceMetaSchema = z.object({
  // `z.any()` so the whole clip union isn't re-expanded into the document's
  // inferred type (tsc overflows its serializer otherwise). The precise types
  // are restored on `RenderInPlaceMeta` below, which the ops use.
  originalSnapshot: z.any(),
  rows: z.array(z.any()).default([]),
  assetId: z.string(),
  soundClipId: z.string().nullable().default(null),
  baseline: z.string().default(""),
  signature: z.string(),
  renderedAt: z.number(),
});
/** Declared explicitly (not `z.infer`) so the snapshot parts are typed. */
export interface RenderInPlaceMeta {
  originalSnapshot: Clip;
  rows: Track[];
  assetId: string;
  soundClipId: string | null;
  baseline: string;
  signature: string;
  renderedAt: number;
}

export const documentSchema = z.object({
  version: z.number().int().positive(),
  id: z.string(),
  name: z.string(),
  // NO document-level `fps`. Frame rate belongs to a frame (see `frameSchema.fps`);
  // storing a project-wide one as well guaranteed the two would disagree.
  durationMs: z.number().positive(),
  /**
   * The infinite canvas colour behind every frame (Figma's page background),
   * v28.
   *
   * `STAGE_BACKGROUND_THEME` — the DEFAULT since v57 — means "whatever surround
   * the current theme wants", and it is a sentinel rather than a resolved
   * colour on purpose. A hex here is a document FACT: it survives export,
   * import, and being opened on someone else's machine, which is exactly right
   * for a project that has deliberately chosen a grey surround to judge its
   * artwork against. It is exactly wrong as a default, because then a document
   * created in the dark theme carries a near-black stage into a light one
   * forever, and switching the app's theme leaves the biggest surface on screen
   * untouched. Storing the INTENT ("follow the room") instead of the outcome is
   * what lets one value be right in both themes.
   */
  stageBackground: z.string().default(STAGE_BACKGROUND_THEME),
  /** Figma-style pages; the canvas shows one at a time. Never empty. */
  pages: z
    .array(pageSchema)
    .min(1)
    .default(() => [{ id: "page_home", name: "Page 1", guides: [] }]),
  /**
   * Every frame. MAY BE EMPTY (v88): a project is a canvas first, and deleting
   * its last frame is an ordinary edit, not an error. Anything that must land in
   * a frame creates one at that moment; nothing may assume `frames[0]` exists.
   */
  frames: z.array(frameSchema),
  tracks: z.array(trackSchema),
  /** Named, typed, reusable values (colors, paints, numbers, fonts…) — see ./variables. */
  variables: z.array(variableSchema),
  /**
   * Folders the variables are filed under — and, with a `source`, the imported
   * palette LIBRARIES. Defaulted, so every existing document gains a flat table
   * with nothing to migrate. See `variableFolderSchema` for why libraries are
   * folders rather than a second container.
   */
  variableFolders: z.array(variableFolderSchema).default([]),
  /**
   * Node graphs (v41) — a reusable table like `variables`/`trackers`. One graph
   * can be opened on the free node board AND bound to any property as an
   * expression driver (`expr:<id>`). Empty for docs that never used nodes. See
   * ./nodes for the persisted shape and ../nodes for the evaluation engine.
   */
  graphs: z.array(nodeGraphSchema).default([]),
  /**
   * Property EXPRESSIONS (v50) — the source text behind every `fx:<id>` token,
   * in a reusable table like `variables`/`graphs`. Slots store the reference,
   * never the text, so undo, serialisation, usage counting and rename all reuse
   * the machinery the other tables already have. See ./expressions.
   */
  expressions: z.array(expressionSchema).default([]),
  /**
   * Trackers (v39, re-founded v101) — what the footage knows: where a thing is
   * over time, in the media's own time and pixels. A table like `variables`;
   * any number per footage, read by followers (`clip.trackBinding`), grade
   * windows, `track()` expressions, the Track node and agents. See
   * docs/adr/ADR-tracking.md.
   */
  trackers: z.array(trackerSchema).default([]),
  /** Imported media metadata (bytes live in the app-level blob store). */
  assets: z.array(assetSchema).default([]),
  /** Media-library folders (organisation only; assets point at them by id). */
  mediaFolders: z.array(mediaFolderSchema).default([]),
  /**
   * Project-scoped presets (v45) — the document half of the ONE preset library
   * (see ../presets/library). Same shape as the app-level store; living HERE is
   * what makes a preset travel with the file. Empty for docs that never saved
   * one, so this costs nothing.
   */
  presets: z.array(storedPresetSchema).default([]),
  /**
   * The project's sound CATEGORIES (v86) — buses every clip routes into, each
   * with a fader, an effect chain, ducking and a loudness target. Project-owned
   * so a custom category travels with the file. See `schema/sound-mix.ts`.
   */
  soundBuses: z.array(soundBusSchema).default(() => BUILT_IN_SOUND_BUSES.map((b) => ({ ...b }))),
  /**
   * Audition volume for the sound picker, 0..1. Per PROJECT, because "loud
   * enough to hear over the room" is a property of the session you're working
   * in, not of any one clip — and because a picker that blasts every sound at
   * full tilt is a picker nobody clicks twice. It also seeds the volume of a
   * sound you pick, so what you auditioned is what you get.
   */
  soundPreviewVolume: z.number().min(0).max(1).default(0.7),
  /** Saved custom typing sounds (asset + hit point), selectable per clip. */
  customSounds: z
    .array(z.object({ id: z.string(), name: z.string(), assetId: z.string(), hitMs: z.number().min(0) }))
    .default([]),
  /** Timeline markers, scoped per comp. Groups come later — groupId is ready. */
  markers: z.array(markerSchema).default([]),
  /**
   * Render-in-place ledger (v38), keyed by the RENDERED clip's id. Right-click
   * → "Render in place" bakes a clip to a media asset and swaps the clip for one
   * pointing at that asset (same id/slot); this map keeps the ORIGINAL clip so
   * "Switch to original" can restore it and a re-render can reuse the same asset
   * (no zombie media). Empty for docs that never rendered in place.
   */
  renderedClips: z.record(z.string(), renderInPlaceMetaSchema).default({}),
  /**
   * The project's SCRIPTS (v94) and the folders they are filed in — JavaScript
   * run against the command API, saved with the file. See `schema/scripts.ts`.
   */
  scripts: z.array(scriptSchema).default([]),
  scriptFolders: z.array(scriptFolderSchema).default([]),
});
export type MotionDocument = z.infer<typeof documentSchema>;
