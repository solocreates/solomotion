import { createId } from "../ids";
import { healContourIds } from "../vector/contour-id";
import { adoptInternalFrames, INTERNAL_PAGE_ID, NESTED_PAGE_NAME } from "../pages";
import {
  documentSchema,
  DOCUMENT_VERSION,
  isGradientPaint,
  mediaPaint,
  STAGE_BACKGROUND_THEME,
  type MotionDocument,
} from "../schema";
import { pruneExpressions, withLiveExpressions } from "../expressions/document";
import { createImageClip } from "../factories";
import { countUpObjects } from "../text/count-up";
import { SEQUENCE_MIME } from "../media/sequence";
import { contentVariesInTime } from "../timeline/frame-mode";
import { TRACKER_COLORS } from "../tracking/palette";

export * from "./motion";
export * from "./slice";
export * from "./merge";

/**
 * Import/export. The exported JSON *is* the document schema — versioned,
 * validated, and migrated on the way in. This file format is the contract
 * every host adapter (web, Premiere, Resolve, Blender) reads.
 */

export class DocumentParseError extends Error {
  constructor(message: string, public readonly issues?: unknown) {
    super(message);
    this.name = "DocumentParseError";
  }
}

export function serializeDocument(doc: MotionDocument): string {
  return JSON.stringify(withLiveExpressions(doc), null, 2);
}

/** What a migration may need from the product reading the file (identity.ts). */
interface MigrationContext {
  /** The reading product's namespace; only a step that mints a stamped id asks. */
  ns(): string;
}
type Migration = (raw: Record<string, unknown>, ctx: MigrationContext) => Record<string, unknown>;

/**
 * Version migrations, applied in order from the file's version up to current.
 * `migrations[n]` upgrades a version-n document to version n+1.
 */
const migrations: Record<number, Migration> = {
  /**
   * v76 → v77: TRACKING IS A CONTOUR, NOT A CLIP; COLOUR IS A GRAPH.
   *
   * A tracker used to keep its shape in a real shape clip parked on a carrier
   * lane above the footage, which is why every tracked project grew junk lanes
   * and why a region could only ever be a rectangle or an ellipse. The tracker
   * now owns its geometry, so the handle is converted into the region and then
   * REMOVED — but only when it is still a pure handle: default name, bound to
   * this tracker, carrying no effects of its own. Anything a person has since
   * made their own stays put as an ordinary shape layer.
   *
   * The three tracker MODES collapse into a region (any shape) plus a matching
   * METHOD, `manual: boolean` becomes a pinned CHANNEL LIST, and the reference
   * frame keeps whatever it had.
   */
  76: (raw) => {
    type Rec = Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const doc = raw as Rec;
    const trackers = Array.isArray(doc.trackers) ? (doc.trackers as Rec[]) : [];
    const tracks = Array.isArray(doc.tracks) ? (doc.tracks as Rec[]) : [];

    const allClips = (): Rec[] =>
      tracks.flatMap((t) => (Array.isArray(t.clips) ? (t.clips as Rec[]) : []));
    const findClip = (id: string): Rec | undefined => allClips().find((c) => c.id === id);

    /** A closed rectangle or ellipse contour centred on the origin. */
    const contour = (kind: string, w: number, h: number): Rec => {
      const hw = Math.max(1, w / 2);
      const hh = Math.max(1, h / 2);
      const pt = (x: number, y: number, hIn: Rec | null = null, hOut: Rec | null = null) => ({ x, y, hIn, hOut });
      if (kind === "ellipse") {
        const k = 0.5522847498;
        return {
          id: `sub_m77_${Math.random().toString(36).slice(2, 9)}`,
          closed: true,
          points: [
            pt(0, -hh, { x: -hw * k, y: -hh }, { x: hw * k, y: -hh }),
            pt(hw, 0, { x: hw, y: -hh * k }, { x: hw, y: hh * k }),
            pt(0, hh, { x: hw * k, y: hh }, { x: -hw * k, y: hh }),
            pt(-hw, 0, { x: -hw, y: hh * k }, { x: -hw, y: -hh * k }),
          ],
        };
      }
      return {
        id: `sub_m77_${Math.random().toString(36).slice(2, 9)}`,
        closed: true,
        points: [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)],
      };
    };

    const removeHandles = new Set<string>();

    doc.trackers = trackers.map((t) => {
      const cfg = (t.config ?? {}) as Rec;
      const mode = typeof cfg.mode === "string" ? cfg.mode : "region";
      const channels = (cfg.channels ?? {}) as Rec;
      const handleId = typeof t.handleClipId === "string" ? t.handleClipId : null;
      const handle = handleId ? findClip(handleId) : undefined;

      // The handle is chrome only when it still looks like the one we made.
      const handleName = typeof handle?.name === "string" ? handle.name : "";
      const handleEffects = Array.isArray(handle?.effects) ? (handle!.effects as unknown[]) : [];
      const isPureHandle =
        !!handle &&
        handleEffects.length === 0 &&
        (handleName === "Track region" || handleName === "Color track");
      if (isPureHandle && handleId) removeHandles.add(handleId);

      let shape = "ellipse";
      let subpaths: Rec[];
      let feather = num(handle?.feather, 0);
      if (mode === "shape" && Array.isArray(cfg.subpaths) && cfg.subpaths.length > 0) {
        shape = "path";
        // Old shape tracks stored source-px contours; re-centre them about their
        // own bounds so the pose on the samples carries the position.
        const subs = cfg.subpaths as Rec[];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const sub of subs) {
          for (const p of (sub.points as Rec[]) ?? []) {
            const x = num(p.x, 0), y = num(p.y, 0);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
        const cx = Number.isFinite(minX) ? (minX + maxX) / 2 : 0;
        const cy = Number.isFinite(minY) ? (minY + maxY) / 2 : 0;
        const shift = (p: Rec): Rec => ({
          x: num(p.x, 0) - cx,
          y: num(p.y, 0) - cy,
          hIn: p.hIn ? { x: num((p.hIn as Rec).x, 0) - cx, y: num((p.hIn as Rec).y, 0) - cy } : null,
          hOut: p.hOut ? { x: num((p.hOut as Rec).x, 0) - cx, y: num((p.hOut as Rec).y, 0) - cy } : null,
        });
        subpaths = subs.map((sub) => ({
          id: sub.id ?? `sub_m77_${Math.random().toString(36).slice(2, 9)}`,
          closed: true,
          points: ((sub.points as Rec[]) ?? []).map(shift),
        }));
      } else if (mode === "color") {
        subpaths = [contour("ellipse", 44, 44)];
      } else {
        const box = (cfg.box ?? {}) as Rec;
        shape = cfg.elliptical === true ? "ellipse" : "rect";
        subpaths = [contour(shape, num(box.width, 80), num(box.height, 80))];
        if (feather === 0) feather = Math.round(Math.min(num(box.width, 80), num(box.height, 80)) * 0.1);
      }

      const solveChannels: string[] = ["position"];
      if (channels.scale === true || mode === "color") solveChannels.push("scale");
      if (channels.rotation === true) solveChannels.push("rotation");

      const samples = Array.isArray(t.samples) ? (t.samples as Rec[]) : [];
      return {
        id: t.id,
        name: t.name,
        sourceClipId: t.sourceClipId,
        region: { shape, subpaths, feather, expand: 0, invert: false },
        solve: {
          method: mode === "color" ? "color" : "luma",
          colors: Array.isArray(cfg.colors) ? cfg.colors : [],
          channels: solveChannels,
          accuracy: 0.5,
          detail: 16,
          adaptive: true,
        },
        samples: samples.map((s) => ({
          timeMs: num(s.timeMs, 0),
          x: num(s.x, 0),
          y: num(s.y, 0),
          scale: num(s.scale, 1),
          scaleY: null,
          rotation: num(s.rotation, 0),
          warp: null,
          confidence: num(s.confidence, 1),
          // A `manual` sample only ever fixed the POSITION, so that is the one
          // channel it may claim — pinning more than the user actually placed
          // would freeze measurements they never touched.
          pinned: s.manual === true ? ["position"] : [],
        })),
        referenceMs: num(t.referenceMs, 0),
        analysis: t.analysis ?? null,
        dirty: true,
      };
    });

    // A binding's channels become a list, matching `pinned` and `solve`.
    for (const clip of allClips()) {
      const b = clip.trackBinding as Rec | null | undefined;
      if (!b) continue;
      const ch = (b.channels ?? {}) as Rec;
      const list: string[] = [];
      if (ch.position !== false) list.push("position");
      if (ch.scale === true) list.push("scale");
      if (ch.rotation === true) list.push("rotation");
      b.channels = list;
    }

    if (removeHandles.size > 0) {
      for (const track of tracks) {
        if (!Array.isArray(track.clips)) continue;
        track.clips = (track.clips as Rec[]).filter((c) => !removeHandles.has(c.id as string));
      }
      // A carrier lane that existed only to hold a handle goes with it.
      doc.tracks = tracks.filter(
        (t) => !(Array.isArray(t.clips) && t.clips.length === 0 && (t.name === "Track region" || t.name === "Color track")),
      );
    }

    return { ...doc, version: 77 };
  },
  /**
   * v77 → v78: a caption's single FOCUS scope becomes three STATES.
   *
   * "The word being spoken" was the only styleable state a caption had, so
   * "already said" and "still to come" were both just the layer — and the
   * karaoke look everyone wants (faded ahead, solid behind, lit in the middle)
   * was not expressible at all. The focus payload moves verbatim into
   * `states.focus`; the other two are born EMPTY, so every existing caption
   * looks exactly as it did. The faded-ahead default is for new captions only
   * (`defaultCaptionStates`) — a migration that restyled documents would be a
   * migration that edited people's work.
   */
  77: (raw) => ({
    ...raw,
    tracks: mapClips(raw.tracks, (clip) => {
      const caption = clip.caption as Record<string, unknown> | null | undefined;
      if (!caption) return clip;
      const empty = () => ({
        overlay: { props: {}, removed: [], added: { effects: [], fills: [], strokes: [], textEffects: [] } },
        animation: null,
        scale: 1,
      });
      caption.states = {
        unread: empty(),
        focus: caption.focus ?? empty(),
        read: empty(),
      };
      delete caption.focus;
      caption.motion = { durationMs: 160, easing: { kind: "preset", name: "ease-out" }, travel: false };
      return clip;
    }),
    version: 78,
  }),
  /**
   * v78 → v79: RENDER IN PLACE REACHES EVERY LAYER. Nested clips gain `bake`
   * (null — nothing was baked) and assets gain the `render` kind. Purely
   * additive; the schema's defaults fill it, so this only moves the number.
   */
  78: (raw) => ({ ...raw, version: 79 }),
  /**
   * v79 → v80: RENDER IN PLACE HANDS BACK MEDIA. v79 kept a render as a `bake`
   * on a nested wrapper, drawn from a `render` asset. The render is now an
   * ordinary image-sequence asset (the container format is the same bytes), so
   * `render` assets become sequence images, and a wrapper whose original was
   * deleted gets the sequence as a clip INSIDE its comp — exactly the picture
   * it drew. A wrapper that kept its original just draws its original again.
   * Visual clips gain `fps` (null: follow the comp) — defaulted by the schema.
   */
  79: (raw, ctx) => {
    type Rec = Record<string, unknown>;
    const assets = Array.isArray(raw.assets) ? (raw.assets as Rec[]) : [];
    for (const a of assets) {
      if (a.kind === "render") {
        a.kind = "image";
        a.mime = SEQUENCE_MIME.of(ctx.ns());
      }
    }
    const frames = Array.isArray(raw.frames) ? (raw.frames as Rec[]) : [];
    const tracks = Array.isArray(raw.tracks) ? (raw.tracks as Rec[]) : [];
    const added: Rec[] = [];
    for (const track of tracks) {
      for (const clip of (track.clips as Rec[] | undefined) ?? []) {
        const bake = clip.bake as Rec | null | undefined;
        delete clip.bake;
        if (!bake || bake.keptOriginal !== false || clip.kind !== "nested") continue;
        const source = frames.find((f) => f.id === clip.sourceFrameId);
        const asset = assets.find((a) => a.id === bake.assetId);
        if (!source || !asset) continue;
        const fps = typeof source.fps === "number" ? source.fps : typeof raw.fps === "number" ? raw.fps : 30;
        asset.fps = fps;
        added.push({
          id: createId("track"),
          name: "Render",
          muted: false,
          locked: false,
          hidden: false,
          homeCompId: source.id,
          clips: [
            {
              ...createImageClip({ frameId: source.id as string, assetId: asset.id as string, startMs: 0, durationMs: (asset.durationMs as number) ?? 1000 }),
              name: String(asset.name ?? "Render"),
              playback: { speed: 1, loop: "none", reverse: false, loopLengthMs: null },
            },
          ],
          transitions: [],
        });
      }
    }
    return { ...raw, tracks: [...tracks, ...added], version: 80 };
  },
  // v1 → v2: single `frame` config becomes `frames[]` (artboards); fps and
  // duration move to the document root; visual clips gain `frameId`; captions
  // gain the same in/out `animations` contract as text clips.
  1: (raw) => {
    const frame = (raw.frame ?? {}) as Record<string, unknown>;
    const frameId = createId("frame");
    const tracks = Array.isArray(raw.tracks)
      ? (raw.tracks as Array<Record<string, unknown>>).map((track) => ({
          ...track,
          clips: Array.isArray(track.clips)
            ? (track.clips as Array<Record<string, unknown>>).map((clip) => {
                if (clip.kind === "audio") return { keyframes: [], ...clip };
                const upgraded: Record<string, unknown> = { ...clip, frameId };
                if (clip.kind === "caption" && upgraded.animations === undefined) {
                  upgraded.animations = { in: null, out: null };
                }
                return upgraded;
              })
            : [],
        }))
      : [];
    return {
      ...raw,
      version: 2,
      fps: typeof frame.fps === "number" ? frame.fps : 30,
      durationMs: typeof frame.durationMs === "number" ? frame.durationMs : 10000,
      frames: [
        {
          id: frameId,
          name: "Frame 1",
          x: 0,
          y: 0,
          width: typeof frame.width === "number" ? frame.width : 1080,
          height: typeof frame.height === "number" ? frame.height : 1920,
          background: typeof frame.background === "string" ? frame.background : "#0E0E11",
        },
      ],
      frame: undefined,
      tracks,
    };
  },
  // v2 → v3: frames gain duration/fps overrides, visual clips gain groupId,
  // the document gains layer groups and color variables.
  2: (raw) => ({
    ...raw,
    version: 3,
    frames: Array.isArray(raw.frames)
      ? (raw.frames as Array<Record<string, unknown>>).map((f) => ({
          durationMs: null,
          fps: null,
          ...f,
        }))
      : raw.frames,
    tracks: Array.isArray(raw.tracks)
      ? (raw.tracks as Array<Record<string, unknown>>).map((track) => ({
          ...track,
          clips: Array.isArray(track.clips)
            ? (track.clips as Array<Record<string, unknown>>).map((clip) =>
                clip.kind === "audio" ? clip : { groupId: null, ...clip },
              )
            : [],
        }))
      : raw.tracks,
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    colorVariables: Array.isArray(raw.colorVariables) ? raw.colorVariables : [],
  }),
  // v3 → v4: keyframe tracks gain an optional `range` (grapheme slice) so text
  // properties can be keyframed per-range. Existing tracks are whole-clip; the
  // schema default (null) fills them, so this is just a version stamp.
  3: (raw) => ({ ...raw, version: 4 }),
  // v4 → v5: the single `shadow`/`stroke` on a style become entries in the new
  // ordered `effects` stack (multiple, keyframeable). `highlight` stays as-is.
  4: (raw) => ({ ...raw, version: 5, tracks: migrateEffects4to5((raw as { tracks?: unknown }).tracks) }),
  // v5 → v6: the `nested` clip kind (source-backed, with playback) is additive —
  // existing documents have none, so this is a version stamp.
  5: (raw) => ({ ...raw, version: 6 }),
  // v6 → v7: styles gain `decoration` (underline/strikethrough) and `textCase`;
  // both default via the schema, so this is a version stamp.
  6: (raw) => ({ ...raw, version: 7 }),
  // v7 → v8: frames gain a `loop` mode (default via schema) — version stamp.
  7: (raw) => ({ ...raw, version: 8 }),
  // v8 → v9: `frameId` moves into the clip base — EVERY clip (audio included)
  // now belongs to a composition. Existing audio clips join the first frame.
  8: (raw) => {
    const frames = raw.frames as Array<{ id?: unknown }> | undefined;
    const rootId = Array.isArray(frames) && typeof frames[0]?.id === "string" ? frames[0].id : "";
    return {
      ...raw,
      version: 9,
      tracks: Array.isArray(raw.tracks)
        ? (raw.tracks as Array<Record<string, unknown>>).map((track) => ({
            ...track,
            clips: Array.isArray(track.clips)
              ? (track.clips as Array<Record<string, unknown>>).map((clip) =>
                  typeof clip.frameId === "string" ? clip : { ...clip, frameId: rootId },
                )
              : [],
          }))
        : raw.tracks,
    };
  },
  // v9 → v10: the document gains `assets` and the image/video/asset-audio clip
  // kinds; audio clips gain playback + trimIn. All schema-defaulted — stamp.
  9: (raw) => ({ ...raw, version: 10 }),
  // v10 → v11: the vector engine's `shape` and `path` clip kinds (additive) —
  // version stamp.
  10: (raw) => ({ ...raw, version: 11 }),
  // v11 → v12: paint engine — vector `fill` strings become solid Paint objects
  // and stroke `color` becomes `paint`.
  11: (raw) => {
    const doc = raw as { tracks?: Array<{ clips?: Array<Record<string, unknown>> }> };
    for (const track of doc.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (clip.kind !== "shape" && clip.kind !== "path") continue;
        if (typeof clip.fill === "string") clip.fill = { type: "solid", color: clip.fill };
        const stroke = clip.stroke as Record<string, unknown> | null | undefined;
        if (stroke && typeof stroke.color === "string" && stroke.paint === undefined) {
          stroke.paint = { type: "solid", color: stroke.color };
          delete stroke.color;
        }
      }
    }
    return { ...raw, version: 12 };
  },
  // v12 → v13: trim paths on vector clips (schema-defaulted) — stamp.
  12: (raw) => ({ ...raw, version: 13 }),
  // v13 → v14: layer effects on every visual clip (schema-defaulted) — stamp.
  13: (raw) => ({ ...raw, version: 14 }),
  // v14 → v15: custom typing sounds + project sound presets (schema-defaulted) — stamp.
  14: (raw) => ({ ...raw, version: 15 }),
  // v15 → v16: timeline markers (schema-defaulted) — stamp.
  15: (raw) => ({ ...raw, version: 16 }),
  // v17: unified Blender-style tracks — `kind` dropped (any clip on any
  // track); tracks gain workspace color + lane height (schema defaults).
  16: (raw) => {
    const tracks = (raw as { tracks?: unknown }).tracks;
    if (Array.isArray(tracks)) {
      for (const t of tracks) {
        if (t && typeof t === "object") delete (t as Record<string, unknown>).kind;
      }
    }
    return { ...raw, version: 17 };
  },
  // v18: Figma-style pages (schema defaults fill the first page; frames'
  // pageId defaults to null = first page).
  17: (raw) => ({ ...raw, version: 18 }),
  // v19: link groups (clip base `linkGroupId`, schema default null) and the
  // procedural `waveform` clip kind — both additive, schema-defaulted. Stamp.
  18: (raw) => ({ ...raw, version: 19 }),
  // v20: frames gain `component` (null default) — a frame flagged as a reusable
  // component definition. Additive, schema-defaulted. Stamp.
  19: (raw) => ({ ...raw, version: 20 }),
  // v21: clips gain `fill` (false default) — auto-track the comp duration.
  // Additive, schema-defaulted. Stamp.
  20: (raw) => ({ ...raw, version: 21 }),
  // v22: frames gain `clipContent` (false default) — Figma-style content
  // clipping, off by default so frames don't crop overflow. Schema-defaulted. Stamp.
  21: (raw) => ({ ...raw, version: 22 }),
  // v23: tracks gain `homeCompId` — an EMPTY track only shows in the comp it
  // was made a spare lane for, instead of every comp in the document (the
  // "zombie empty tracks in a fresh nested/component frame" bug). Existing
  // empty tracks predate the concept of "which comp asked for this spare
  // lane" — the closest true answer is the document's root frame, since that
  // was the only comp in play before nesting/components existed to add more.
  // Occupied tracks don't need it (their clips' own frameId already scopes
  // them), so they're left null.
  22: (raw) => {
    const frames = raw.frames as Array<{ id?: unknown }> | undefined;
    const rootId = Array.isArray(frames) && typeof frames[0]?.id === "string" ? frames[0].id : null;
    const tracks = raw.tracks as Array<Record<string, unknown>> | undefined;
    return {
      ...raw,
      version: 23,
      tracks: Array.isArray(tracks)
        ? tracks.map((t) => {
            const clips = Array.isArray(t.clips) ? t.clips : [];
            return clips.length === 0 ? { ...t, homeCompId: rootId } : t;
          })
        : tracks,
    };
  },
  // v24: media-library folders — document gains `mediaFolders` and assets gain
  // `folderId` (both schema-defaulted: [] and null = library root). Additive. Stamp.
  23: (raw) => ({ ...raw, version: 24 }),
  // v25: Figma paint model. A vector's single `fill`/`stroke` become ORDERED
  // LISTS (`fills`/`strokes`); each entry gains a stable `id` + `opacity` +
  // `blendMode`. Existing paint keyframe tracks are re-addressed under the new
  // entry id (`fill` → `fill.<id>`, `stroke.width` → `stroke.<id>.width`, …) so
  // animations survive. Layer `opacity`/`blendMode` on non-vector visual clips
  // are schema-defaulted (no rewrite needed).
  24: (raw) => {
    const tracks = raw.tracks as Array<{ clips?: Array<Record<string, unknown>> }> | undefined;
    for (const track of tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (clip.kind !== "shape" && clip.kind !== "path") continue;
        const fill = clip.fill as Record<string, unknown> | null | undefined;
        const stroke = clip.stroke as Record<string, unknown> | null | undefined;

        const fillId = fill ? createId("paint") : null;
        clip.fills = fill ? [{ ...fill, id: fillId, opacity: 1, blendMode: "normal" }] : [];
        delete clip.fill;

        let strokeId: string | null = null;
        if (stroke) {
          strokeId = createId("stroke");
          const innerPaint = stroke.paint as Record<string, unknown> | undefined;
          if (innerPaint && innerPaint.id === undefined) {
            innerPaint.id = createId("paint");
            innerPaint.opacity ??= 1;
            innerPaint.blendMode ??= "normal";
          }
          clip.strokes = [{ ...stroke, id: strokeId, opacity: 1, blendMode: "normal" }];
        } else {
          clip.strokes = [];
        }
        delete clip.stroke;

        // Re-address the clip's paint keyframe tracks under the new entry ids.
        const kfs = clip.keyframes as Array<{ property: string }> | undefined;
        if (Array.isArray(kfs)) {
          for (const kf of kfs) {
            if (fillId && (kf.property === "fill" || kf.property.startsWith("fill."))) {
              kf.property = kf.property === "fill" ? `fill.${fillId}` : `fill.${fillId}.${kf.property.slice(5)}`;
            } else if (strokeId && kf.property.startsWith("stroke.")) {
              kf.property = `stroke.${strokeId}.${kf.property.slice(7)}`;
            }
          }
        }
      }
    }
    return { ...raw, version: 25 };
  },
  // v26: composite groups — layer groups gain `mode` ("pass" default = plain
  // group) and visual clips gain `isStencil` (false default). Both schema-defaulted:
  // every existing group stays a plain group. Stamp.
  25: (raw) => ({ ...raw, version: 26 }),
  // v27: whole-layer in/out animations (`animIn`/`animOut` on every visual
  // clip). Schema-defaulted to null — no rewrite needed.
  26: (raw) => ({ ...raw, version: 27 }),
  // v28: document `stageBackground` (the infinite-canvas colour behind frames).
  // Schema-defaulted to the editor's stage tone — no rewrite needed. Stamp.
  27: (raw) => ({ ...raw, version: 28 }),
  // v29: unified gradient geometry — the old `angleDeg` (linear) and `cx/cy/r`
  // (radial) collapse into the shared normalized `start`/`end` handle pair that
  // every gradient type now uses. Convert in place so saved gradients keep
  // their look; text gradients (`style.fill`) are new and schema-defaulted.
  28: (raw) => {
    const doc = raw as { tracks?: unknown };
    if (Array.isArray(doc.tracks)) {
      for (const track of doc.tracks) {
        const clips = (track as { clips?: unknown }).clips;
        if (!Array.isArray(clips)) continue;
        for (const clip of clips) migrateClipGradients(clip as Record<string, unknown>);
      }
    }
    return { ...raw, version: 29 };
  },
  // v30: UNIFIED PAINT — `fills`/`strokes` move onto every visual clip (was
  // vector-only) and frames gain `fills`. All schema-defaulted to [] (a frame
  // still paints its `background` when empty), so existing docs need no rewrite.
  29: (raw) => ({ ...raw, version: 30 }),
  // v31: universal `audioMix` (mute + master volume) on every clip — the ONE
  // fader the headless audio inventory applies to every sound source (text
  // cues, audio/video, nested comps). Schema-defaulted to unity/unmuted, so
  // existing docs sound identical. Stamp.
  30: (raw) => ({ ...raw, version: 31 }),
  // v32: DRAWING MODE foundations — frames gain `role` (comp/drawing/flipbook),
  // tracks gain `loop` (flipbook row looping), clips gain `mirrorId` (layer
  // lineage across duplicated cells), and the `raster` clip kind arrives (new
  // union variant — absent from old docs by definition). All schema-defaulted,
  // so existing docs parse and render identically. Stamp.
  31: (raw) => ({ ...raw, version: 32 }),
  // v33: flipbook `durationMs` becomes a plain editable override (null = auto,
  // hugs content — see `frameDurationMs`) instead of being force-synced to
  // content end after every sheet edit (`reconcileFlipbookDuration`, removed).
  // Every existing flipbook's `durationMs` was kept EXACTLY at its content end
  // by that function, so nulling it wherever it still matches is lossless:
  // existing flipbooks keep reading as "auto" (identical playback/export)
  // until the user drags the sheet's end bar to pin a length.
  32: (raw) => {
    const doc = raw as { tracks?: unknown; frames?: unknown };
    const tracks = Array.isArray(doc.tracks) ? (doc.tracks as Array<{ clips?: unknown }>) : [];
    const frames = Array.isArray(doc.frames) ? (doc.frames as Array<Record<string, unknown>>) : [];
    for (const f of frames) {
      if (f.role !== "flipbook" || typeof f.durationMs !== "number") continue;
      let end = 0;
      for (const track of tracks) {
        const clips = Array.isArray(track.clips) ? (track.clips as Array<Record<string, unknown>>) : [];
        for (const clip of clips) {
          if (clip.frameId !== f.id) continue;
          const s = typeof clip.startMs === "number" ? clip.startMs : 0;
          const d = typeof clip.durationMs === "number" ? clip.durationMs : 0;
          end = Math.max(end, s + d);
        }
      }
      if (end === f.durationMs) f.durationMs = null;
    }
    return { ...raw, version: 33 };
  },
  // v34: frames grow `pluginData` (generator recipes, Figma setPluginData
  // style). Schema-defaulted to {}, so existing docs parse unchanged. Stamp.
  33: (raw) => ({ ...raw, version: 34 }),
  // v35: the color-only `colorVariables` table becomes the typed `variables`
  // table (color/number/font…). Existing color variables carry over with
  // `type: "color"`; `var:<id>` tokens are unchanged, so linked slots keep
  // resolving. The old key is dropped.
  34: (raw) => {
    const { colorVariables, ...rest } = raw as Record<string, unknown> & { colorVariables?: unknown };
    const colors = Array.isArray(colorVariables) ? colorVariables : [];
    return {
      ...rest,
      version: 35,
      variables: colors.map((v) => ({ ...(v as Record<string, unknown>), type: "color" })),
    };
  },
  // v36: the fixed 3-band `eq {low,mid,high}` on audio clips becomes a
  // parametric BAND LIST (RBJ biquads). Existing EQ is converted 1:1 to three
  // bands (low shelf@200 / peak@1000 Q0.7 / high shelf@4000) so it sounds
  // identical, and any `eq.low|mid|high` keyframe tracks are re-addressed onto
  // the new band ids (`eq.<id>.gain`) so animations survive. Bypassed EQ
  // (`eq: null`) stays null.
  35: (raw) => {
    const tracks = raw.tracks as Array<{ clips?: Array<Record<string, unknown>> }> | undefined;
    for (const track of tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (clip.kind !== "audio") continue;
        const eq = clip.eq as { low?: number; mid?: number; high?: number } | null | undefined;
        if (!eq || Array.isArray(eq)) continue; // bypass or already migrated
        const lowId = createId("eqband");
        const midId = createId("eqband");
        const highId = createId("eqband");
        clip.eq = [
          { id: lowId, type: "lowshelf", freqHz: 200, gainDb: eq.low ?? 0, q: 0.707, enabled: true },
          { id: midId, type: "peaking", freqHz: 1000, gainDb: eq.mid ?? 0, q: 0.707, enabled: true },
          { id: highId, type: "highshelf", freqHz: 4000, gainDb: eq.high ?? 0, q: 0.707, enabled: true },
        ];
        const kfs = clip.keyframes as Array<{ property?: unknown }> | undefined;
        for (const t of kfs ?? []) {
          if (t.property === "eq.low") t.property = `eq.${lowId}.gain`;
          else if (t.property === "eq.mid") t.property = `eq.${midId}.gain`;
          else if (t.property === "eq.high") t.property = `eq.${highId}.gain`;
        }
      }
    }
    return { ...raw, version: 36 };
  },
  // v37: audio clips gain `role` (voice/music/sfx/none), `keepPitch` (default
  // true — speed no longer shifts pitch by default) and `pitchSemitones`; video
  // clips gain `keepPitch` + `pitchSemitones`. All schema-defaulted, so existing
  // docs parse unchanged (keep-pitch on, no pitch shift, role none). Stamp.
  36: (raw) => ({ ...raw, version: 37 }),
  // v38: document gains the `renderedClips` render-in-place ledger (default {}).
  // Additive, schema-defaulted — stamp.
  37: (raw) => ({ ...raw, version: 38 }),
  // v39: motion tracking — document gains the `trackers` table (default []) and
  // every visual clip gains `trackBinding` (default null). Additive, all
  // schema-defaulted, so existing docs parse untouched (no trackers, nothing
  // bound). Stamp.
  38: (raw) => ({ ...raw, version: 39 }),
  // v40: box border radius went PER-CORNER (was a single number) so one
  // Corner-radius control + on-stage handles serve boxes AND shapes. Convert
  // every clip's numeric `borderRadius` to the {tl,tr,br,bl} shape.
  39: (raw) => {
    const doc = raw as { tracks?: Array<{ clips?: Array<Record<string, unknown>> }> };
    for (const track of doc.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        const r = clip.borderRadius;
        if (typeof r === "number") clip.borderRadius = { tl: r, tr: r, br: r, bl: r };
      }
    }
    return { ...raw, version: 40 };
  },
  // v41: document gains `graphs` (node graphs — the board + expression system).
  // Schema-defaulted ([]) — additive, so this is a version stamp.
  40: (raw) => ({ ...raw, version: 41 }),
  // v41 → v42: tracks gain `transitions` — cut effects between abutted clips.
  // Additive and schema-defaulted to an empty list; existing documents have
  // none, so this is a version stamp.
  41: (raw) => ({ ...raw, version: 42 }),
  // v43: source comps stop living on the auto-managed "Nested" page — they move
  // to the off-page INTERNAL shelf, so they can never appear as free-standing
  // artboards or as a page you have to file things on. Frames also gain
  // `sourceTag` (provenance), defaulted by the schema.
  42: (raw) => {
    if (!Array.isArray(raw.pages) || !Array.isArray(raw.frames)) return { ...raw, version: 43 };
    const pages = raw.pages as Array<Record<string, unknown>>;
    const legacy = new Set(
      pages.filter((p) => p.name === NESTED_PAGE_NAME).map((p) => p.id as string),
    );
    if (legacy.size === 0) return { ...raw, version: 43 };
    const frames = raw.frames as Array<Record<string, unknown>>;
    return {
      ...raw,
      version: 43,
      pages: pages.filter((p) => !legacy.has(p.id as string)),
      frames: frames.map((f) =>
        typeof f.pageId === "string" && legacy.has(f.pageId) ? { ...f, pageId: INTERNAL_PAGE_ID } : f,
      ),
    };
  },
  // v44: every transform gains a PIVOT (`anchor`, normalized to the layer's own
  // box). The identity — `{0.5, 0.5}`, the box center — is exactly how layers
  // behaved before pivots existed and is what the schema defaults to, so there
  // is nothing to rewrite. The stamp exists so a v44 file (which may carry a
  // MOVED pivot, and would silently render wrong) is refused by older apps.
  43: (raw) => ({ ...raw, version: 44 }),
  // v45: the document gains `presets` — the project-scoped half of the shared
  // preset library (app-level presets live outside the file). Additive and
  // schema-defaulted to [], so this is a version stamp.
  44: (raw) => ({ ...raw, version: 45 }),
  // v46: the analog effect family — `filmDamage`, `scanlines` and `noise` join
  // the layer-effect union, and `grain` gains the shared temporal clock plus
  // aspect/softness/chroma/blend. Every added field is schema-defaulted, and
  // the clock's defaults reproduce the OLD frozen grain closely enough that an
  // existing project opens looking like itself (it now animates, which is the
  // point — the previous behaviour was the bug, not the contract). So there is
  // nothing to rewrite; the stamp exists so a v46 file carrying a card a v45
  // app has never heard of is refused loudly instead of failing inside zod.
  45: (raw) => ({ ...raw, version: 46 }),
  // v47: a text clip's typing sound splits by ANIMATION PHASE — `sound` goes
  // from one flat voice to `{ in, out }` (and a range's override likewise), so
  // text can be heard leaving and can leave with a different character than it
  // arrived with. The old flat voice WAS the entrance voice, so it moves to
  // `in` verbatim; `out` is seeded from it, disabled, so nothing starts making
  // a noise it never used to make.
  //
  // Also v47: animation specs gain `delayMs` + `jitterMs` / `scatterPx` /
  // `scatterDeg` (per-unit humanisation), and text clips gain a `caret`. All
  // schema-defaulted to 0 / off — the exact metronome every existing document
  // already plays, with no cursor — so there is nothing to rewrite.
  46: (raw) => {
    const doc = raw as { tracks?: Array<{ clips?: Array<Record<string, unknown>> }> };
    for (const track of doc.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (clip.kind !== "text") continue;
        const flat = clip.sound as Record<string, unknown> | undefined;
        if (flat && !("in" in flat)) {
          clip.sound = { in: flat, out: { ...flat, enabled: false } };
        }
        for (const r of (clip.ranges as Array<Record<string, unknown>>) ?? []) {
          const rs = r.sound as Record<string, unknown> | null | undefined;
          if (rs && !("in" in rs) && !("out" in rs)) r.sound = { in: rs };
        }
      }
    }
    return { ...raw, version: 47 };
  },
  // v48: frame rate becomes per-frame and ONLY per-frame. `doc.fps` and the
  // nullable `frame.fps` override were two stored fields for one fact, and
  // they disagreed in practice: the exporter and the flipbook read the frame's
  // rate, while the timeline ruler, the curve/dope-sheet grids, the frame-step
  // shortcuts, marker snapping and the node `frame` input all read the
  // document's — so a 12fps comp still snapped and stepped on a 30fps grid.
  //
  // Every frame is seeded with the rate it EFFECTIVELY had (its own override,
  // else the document's), so a migrated project behaves exactly as it did, and
  // `doc.fps` is dropped: with no second field there is nothing left to fall
  // out of sync.
  47: (raw) => {
    const doc = raw as { fps?: unknown; frames?: Array<Record<string, unknown>> };
    const docFps = typeof doc.fps === "number" && doc.fps > 0 ? doc.fps : 30;
    for (const frame of doc.frames ?? []) {
      const own = frame.fps;
      frame.fps = typeof own === "number" && own > 0 ? own : docFps;
    }
    const next = { ...raw, version: 48 } as Record<string, unknown>;
    delete next.fps;
    return next;
  },
  // v49: a PATH's pivot is finally a fraction of the outline you can SEE.
  //
  // The pivot has always been "a fraction of the layer's box", but the box was
  // read as extent-only, so it was implicitly anchored to the clip's ORIGIN. For
  // every other kind that is the same thing (their geometry is authored about
  // the origin); for a path it stopped being true the moment a node was dragged,
  // because the outline is free to wander. Result: the nine-point picker's
  // "top-left" landed in the middle of edited art, and — the reported bug — a
  // node drag slid the whole layer, since it silently redefined the box the
  // fraction referred to.
  //
  // Nothing about the ART changes here, and nothing needs to: each path's stored
  // fraction is simply re-expressed against its outline's real box so it names
  // the same local point it did before. A pivot left at the default may come out
  // as something other than 0.5/0.5 — that is not a moved pivot, it is the
  // honest reading of where the old one always was on a wandered outline.
  48: (raw) => {
    const doc = raw as { tracks?: Array<{ clips?: Array<Record<string, unknown>> }> };
    for (const track of doc.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        if (clip.kind !== "path") continue;
        const box = legacyPathBox(clip.subpaths);
        if (!box || (box.cx === 0 && box.cy === 0)) continue;
        // OLD: local = (a - 0.5) * extent. NEW: local = centre + (a - 0.5) * extent.
        const shift = (a: unknown, centre: number, extent: number): number =>
          typeof a === "number" && Math.abs(extent) > 1e-6 ? a - centre / extent : (a as number);
        const t = clip.transform as Record<string, unknown> | undefined;
        const anchor = t?.anchor as { x?: unknown; y?: unknown } | undefined;
        if (anchor) {
          anchor.x = shift(anchor.x, box.cx, box.width);
          anchor.y = shift(anchor.y, box.cy, box.height);
        }
        for (const trk of (clip.keyframes as Array<Record<string, unknown>>) ?? []) {
          const axis = trk.property === "anchor.x" ? "x" : trk.property === "anchor.y" ? "y" : null;
          if (!axis) continue;
          for (const k of (trk.keys as Array<Record<string, unknown>>) ?? []) {
            k.value = axis === "x" ? shift(k.value, box.cx, box.width) : shift(k.value, box.cy, box.height);
          }
        }
      }
    }
    return { ...raw, version: 49 };
  },
  // v50 adds `doc.expressions` (the `fx:<id>` source table). The field has a
  // schema default, so nothing needs rewriting here — the step exists so the
  // version moves, and an older app opening a v50 file refuses it loudly rather
  // than silently dropping every expression on the next save.
  49: (raw) => ({ ...raw, version: 50 }),
  /**
   * v51 — THE SOUND STACK. `TextClip.sound: { in, out }` (one voice per phase,
   * text only) becomes `clip.sounds: SoundLayer[]` (any number of voices, any
   * clip kind, each bound to an event by `trigger`).
   *
   * Only phases that were actually ENABLED become entries. The old shape kept
   * a fully-tuned but disabled OUT voice on every text clip ever created, and
   * carrying those across would give every document in existence a stack of
   * silent rows to scroll past — the migration would be technically lossless
   * and practically awful. A disabled voice held no information the defaults
   * don't already provide.
   *
   * Range overrides move from `range.sound: { in?, out? }` to
   * `range.sounds: { [layerId]: patch }`, keyed by the entries just minted, so
   * a range that re-voiced "the in sound" still re-voices the same hit.
   */
  50: (raw) => {
    let n = 0;
    const nextId = () => `snd_m${(n++).toString(36)}`;
    for (const track of (raw.tracks as Array<Record<string, unknown>>) ?? []) {
      for (const clip of (track.clips as Array<Record<string, unknown>>) ?? []) {
        const old = clip.sound as Record<string, Record<string, unknown>> | undefined;
        delete clip.sound;
        if (clip.kind !== "text") continue;
        const layers: Array<Record<string, unknown>> = [];
        /** Old layer id per phase, so range overrides can be re-keyed onto it. */
        const idFor: Record<string, string> = {};
        for (const phase of ["in", "out"] as const) {
          const v = old?.[phase];
          if (!v || v.enabled !== true) continue;
          const id = nextId();
          idFor[phase] = id;
          layers.push({
            id,
            enabled: true,
            phase,
            trigger: { kind: "text" },
            // Per-unit hits fired at the start of the unit's move before v51,
            // and must keep doing so — `peak` is the better default for NEW
            // sounds, never a silent retiming of documents that already exist.
            anchor: "start",
            offsetMs: 0,
            pack: v.pack ?? "mechanical",
            custom: v.custom ?? null,
            volume: v.volume ?? 0.6,
            randomness: v.randomness ?? 0.35,
            pitch: v.pitch ?? 1,
          });
        }
        clip.sounds = layers;
        for (const r of (clip.ranges as Array<Record<string, unknown>>) ?? []) {
          const rs = r.sound as Record<string, Record<string, unknown>> | null | undefined;
          delete r.sound;
          const map: Record<string, unknown> = {};
          for (const phase of ["in", "out"] as const) {
            const patch = rs?.[phase];
            const id = idFor[phase];
            // An override for a phase whose clip-level voice was off has
            // nothing left to patch — it was already inert, since the walker
            // only visited enabled voices.
            if (patch && id) map[id] = patch;
          }
          r.sounds = map;
        }
      }
    }
    return { ...raw, version: 51 };
  },

  /**
   * v52 — A CAPTION IS A TEXT CLIP. `kind: "caption"` and its `CaptionWord[]`
   * are gone; a caption is now `kind: "text"` carrying `clip.caption`, whose
   * cues are grapheme SPANS of the clip's own text.
   *
   * The words concatenate (space-separated) into the text they always printed
   * as, so nothing on screen moves, and each word's span is where it landed in
   * that string — which is what buys captions everything text already had:
   * double-click editing, per-letter ranges, a wrap box that re-flows instead
   * of scaling, glyph animation, templates, variables. `highlightStyle` and
   * `highlightScale` become the FOCUS scope (`caption.focus`), and the
   * `highlightScale` keyframe path is renamed with them so an animated pop
   * keeps animating.
   */
  51: (raw) => {
    for (const track of (raw.tracks as Array<Record<string, unknown>>) ?? []) {
      for (const clip of (track.clips as Array<Record<string, unknown>>) ?? []) {
        for (const t of (clip.keyframes as Array<Record<string, unknown>>) ?? []) {
          if (t.property === "highlightScale") t.property = "focusScale";
        }
        if (clip.kind !== "caption") continue;
        const words = (clip.words as Array<Record<string, unknown>>) ?? [];
        const parts: string[] = [];
        const cues: Array<Record<string, unknown>> = [];
        let cursor = 0;
        for (const w of words) {
          const text = String(w.text ?? "");
          const length = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
          const startMs = Number(w.startMs ?? 0);
          cues.push({
            id: String(w.id ?? createId("cue")),
            start: cursor,
            end: cursor + length,
            startMs,
            endMs: startMs + Math.max(1, Number(w.durationMs ?? 0)),
          });
          parts.push(text);
          cursor += length + 1; // the joining space belongs to no cue
        }
        clip.kind = "text";
        clip.text = parts.join(" ");
        clip.ranges = [];
        clip.caption = {
          cues,
          focus: {
            style: clip.highlightStyle ?? {},
            animation: null,
            scale: Number(clip.highlightScale ?? 1) || 1,
          },
        };
        delete clip.words;
        delete clip.highlightStyle;
        delete clip.highlightScale;
      }
    }
    return { ...raw, version: 52 };
  },
  // v52 → v53: a path clip's `capture` track becomes a `geometry` track.
  //
  // Vector layers briefly recorded themselves through `capture`, the pixel
  // frame-by-frame channel, with subpath arrays as the snapshot values. That was
  // one fact stored under two rules: `geometry` is the outline channel, and it
  // already had record mode, per-key easing, the curve editor and undo. The
  // values are identical, so the fix is the property name — and a recording made
  // under the old rule comes back as a morph, which is what it should have been.
  52: (raw) => {
    for (const track of (raw.tracks as Array<Record<string, unknown>>) ?? []) {
      for (const clip of (track.clips as Array<Record<string, unknown>>) ?? []) {
        if (clip.kind !== "path") continue;
        const tracks = (clip.keyframes as Array<Record<string, unknown>>) ?? [];
        for (const t of tracks) {
          if (t.property === "capture") t.property = "geometry";
        }
        // A clip that already morphed would now carry two `geometry` tracks;
        // fold the converted keys into the original and drop the duplicate.
        const geo = tracks.filter((t) => t.property === "geometry");
        if (geo.length > 1) {
          const [first, ...rest] = geo as Array<Record<string, unknown>>;
          const keys = (first!.keys as unknown[]) ?? [];
          for (const dup of rest) keys.push(...(((dup.keys as unknown[]) ?? [])));
          (keys as Array<Record<string, unknown>>).sort(
            (a, b) => Number(a.timeMs ?? 0) - Number(b.timeMs ?? 0),
          );
          first!.keys = keys;
          clip.keyframes = tracks.filter((t) => !rest.includes(t));
        }
        delete clip.captureCrossfade;
      }
    }
    return { ...raw, version: 53 };
  },
  /**
   * v53 → v54: THE PER-GLYPH EFFECT STACK IS GONE. A text layer's effects move
   * onto `clip.effects`, where every other layer's already live.
   *
   * There were two effect systems, and five of the six glyph cards were the
   * layer card drawn a second time, worse — a Glow whose "Size" meant a canvas
   * shadow blur next to a Glow whose "Size" meant bloom spread. The two that
   * had no layer twin (`stroke`, `longShadow`) were promoted into the layer
   * registry as silhouette passes, so nothing is lost and both now work on
   * shapes, paths and images too.
   *
   * The stack PREPENDS: glyph effects painted inside the text render, before
   * any layer effect saw the layer, and stack order is pass order — appending
   * would quietly reorder a document that stacked both.
   *
   * Keyframes move with their effect. The instance id is kept, so a track is
   * re-pointed by swapping its prefix (`fx.` → `lfx.`); only glow renames a
   * field (`blur` → `size`), and only glow needs a value carried across.
   *
   * RANGE-scoped effect overrides are dropped, deliberately. They styled a span
   * of graphemes, and a layer pass has no way to say "these four letters" — so
   * the alternatives were to lose them or to silently apply a three-character
   * glow to the whole layer. Losing them is the smaller lie, and the honest one.
   */
  53: (raw) => {
    /** One glyph effect → one layer effect. Same id, so keyframes follow. */
    const promote = (fx: Record<string, unknown>): Record<string, unknown> | null => {
      const id = typeof fx.id === "string" ? fx.id : null;
      if (!id) return null;
      const enabled = fx.enabled !== false;
      const num = (k: string, fallback: number) => (typeof fx[k] === "number" ? (fx[k] as number) : fallback);
      const str = (k: string, fallback: string) => (typeof fx[k] === "string" ? (fx[k] as string) : fallback);
      switch (fx.type) {
        // Identical shapes — the duplicates that started all this.
        case "shadow":
        case "innerShadow":
          return { id, type: fx.type, enabled, color: str("color", "#00000088"), x: num("x", 0), y: num("y", 0), blur: num("blur", 0) };
        case "blur":
          return { id, type: "blur", enabled, radius: num("radius", 0) };
        // The glyph glow was a canvas shadow: one colour, blur as the spread.
        // That is `solid` mode exactly; `auto` is the new default, not a
        // reinterpretation of what this document already looked like.
        case "glow":
          return {
            id, type: "glow", enabled, mode: "solid", color: str("color", "#4cc3e0"),
            size: num("blur", 24), intensity: 0.8, saturation: 1.6, brightness: 1.1, inner: false,
          };
        // `strokeText` with a plain lineWidth straddles the outline, so the
        // faithful position is `center` — `outside` would double its weight.
        case "stroke":
          return { id, type: "stroke", enabled, color: str("color", "#000000"), width: num("width", 4), position: "center", softness: 0 };
        // Stepped solid copies, no falloff — `fade: 0` is what it looked like.
        case "longShadow":
          return { id, type: "longShadow", enabled, color: str("color", "#00000055"), angle: num("angle", 45), length: num("length", 24), fade: 0 };
        default:
          return null;
      }
    };

    for (const track of (raw.tracks as Array<Record<string, unknown>>) ?? []) {
      for (const clip of (track.clips as Array<Record<string, unknown>>) ?? []) {
        const style = clip.style as Record<string, unknown> | undefined;
        // Range overrides lose their effects wherever they appear.
        for (const range of (clip.ranges as Array<Record<string, unknown>>) ?? []) {
          const rs = range.style as Record<string, unknown> | undefined;
          if (rs) delete rs.effects;
        }
        const glyphFx = (style?.effects as Array<Record<string, unknown>>) ?? [];
        if (style) delete style.effects;
        if (glyphFx.length === 0) continue;

        const promoted = glyphFx.map(promote).filter((e): e is Record<string, unknown> => e !== null);
        const kept = new Set(promoted.map((e) => e.id as string));
        clip.effects = [...promoted, ...((clip.effects as unknown[]) ?? [])];

        // Re-point the tracks of everything that made the trip; drop the rest,
        // since a keyframe addressing an effect that no longer exists is a
        // ghost the curve editor would still draw a row for.
        const keys = (clip.keyframes as Array<Record<string, unknown>>) ?? [];
        clip.keyframes = keys.filter((t) => {
          const path = typeof t.property === "string" ? t.property : "";
          if (!path.startsWith("fx.")) return true;
          const [, id, field] = path.split(".");
          if (!id || !field || !kept.has(id)) return false;
          const renamed = promoted.find((e) => e.id === id)?.type === "glow" && field === "blur" ? "size" : field;
          t.property = `lfx.${id}.${renamed}`;
          return true;
        });
      }
    }
    return { ...raw, version: 54 };
  },

  /**
   * v55 — EQ stops being a field and becomes a CARD.
   *
   * `clip.eq: AudioEqBand[] | null` was a special case: the only audio
   * processing in the document, with its own nullable field, its own keyframe
   * namespace and its own bespoke code path in the conductor, the bake and the
   * exporter. Now sound has a real effect stack, so the equaliser is one entry
   * in it and everything that was special about it is ordinary.
   *
   * The bands keep their ids, so a keyframed curve survives: the tracks are
   * re-pointed `eq.<bandId>.<f>` → `afx.<fxId>.band.<bandId>.<f>`. A null `eq`
   * means the user had it bypassed, and bypassed is not the same as absent —
   * we would rather drop a flat curve nobody was hearing than resurrect one
   * they had switched off.
   */
  54: (raw) => {
    for (const track of (raw.tracks as Array<Record<string, unknown>>) ?? []) {
      for (const clip of (track.clips as Array<Record<string, unknown>>) ?? []) {
        const stack = ((clip.audioEffects as unknown[]) ?? []) as Array<Record<string, unknown>>;
        const bands = clip.eq;
        delete clip.eq;
        if (!Array.isArray(bands) || bands.length === 0) {
          clip.audioEffects = stack;
          continue;
        }
        const fxId = createId("afx");
        clip.audioEffects = [{ id: fxId, type: "eq", enabled: true, bands }, ...stack];

        const ids = new Set(
          bands.map((b) => (b as Record<string, unknown>).id).filter((id): id is string => typeof id === "string"),
        );
        const keys = (clip.keyframes as Array<Record<string, unknown>>) ?? [];
        clip.keyframes = keys.filter((t) => {
          const path = typeof t.property === "string" ? t.property : "";
          if (!path.startsWith("eq.")) return true;
          const [, bandId, field] = path.split(".");
          // A track for a band that no longer exists is a ghost the curve
          // editor would still draw a row for.
          if (!bandId || !field || !ids.has(bandId)) return false;
          t.property = `afx.${fxId}.band.${bandId}.${field}`;
          return true;
        });
      }
    }
    return { ...raw, version: 55 };
  },

  /**
   * v56 — MOTION BLUR arrives, and every existing project must render exactly
   * as it did yesterday.
   *
   * The schema defaults a comp's shutter ON (see `frameMotionBlurSchema`),
   * because a layer that does not move costs one subtraction and the feature is
   * worthless if nobody ever sees it. But a default is for documents being
   * CREATED. Applying it to documents that already exist would silently restyle
   * finished work — every fast layer in every old project would start smearing,
   * and the render they signed off on would no longer be the render they get.
   *
   * So the master switch is written OFF here, explicitly, once per frame. That
   * is the whole migration: the three-level resolution (layer × comp × render
   * setting) means one false at the comp level is sufficient to hold an entire
   * old project still, and per-layer `motionBlur` can take its schema default
   * on every clip without touching a thing. One field per frame instead of one
   * per clip — and turning a project on later is one switch, not a sweep.
   */
  55: (raw) => {
    for (const frame of (raw.frames as Array<Record<string, unknown>>) ?? []) {
      frame.motionBlur = { ...(frame.motionBlur as object | undefined), enabled: false };
    }
    return { ...raw, version: 56 };
  },
  /*
   * v57: the stage surround learns to FOLLOW THE THEME.
   *
   * `stageBackground` used to default to `#0d0d10` — the dark theme's stage
   * tone, frozen into every document ever created. Switch the app to a light
   * theme and the single biggest surface on screen stayed near-black, because
   * a document colour is a document colour and no theme may touch it.
   *
   * Every document that still carries that exact literal is carrying a DEFAULT,
   * not a decision: nothing in the UI ever offered `#0d0d10` as a swatch, so
   * the only way to hold it is to never have opened the picker. Those convert
   * to the sentinel and start following the room. A stage the user actually
   * picked — any other value, including a variable token — is a choice and is
   * left exactly as it is.
   */
  56: (raw) => ({
    ...raw,
    stageBackground: raw.stageBackground === "#0d0d10" ? STAGE_BACKGROUND_THEME : raw.stageBackground,
    version: 57,
  }),

  /**
   * v57 → v58: TRIM MOVES ONTO THE STROKE.
   *
   * Trim used to sit on the vector CLIP, where it trimmed every stroke at once.
   * Once strokes became a list that was two places describing one fact — "how
   * much of the outline is inked" — and it made the medium's signature move (two
   * strokes chasing each other around one shape) unrepresentable. Each stroke
   * now owns its window, so the clip's single one is copied onto every stroke it
   * used to govern, along with any keyframes that animated it.
   *
   * A vector with no strokes simply loses the field: a trim that inked nothing
   * was already invisible, so nothing is lost that anyone could see.
   */
  /**
   * v58 → v59 — a RANGE and a caption's FOCUS stop carrying a bare
   * `PartialTextStyle` and start carrying a `ScopeOverlay`.
   *
   * Every typographic key becomes a prop at its own property path, which is
   * why the highlight pill fans out into four: an overlay is flat by design so
   * that one field can be overridden without dragging its three siblings along
   * — the exact thing a nested object cannot express.
   */
  /**
   * v59 → v60 — TEXT EFFECTS return, per glyph, on the style.
   *
   * Purely additive: `textEffects` defaults to `[]`, so an old document opens
   * with none and there is nothing to move. The bump exists so a v60 document
   * (which CAN carry them) is refused by an older build rather than silently
   * losing them.
   */
  59: (raw) => ({ ...raw, version: 60 }),

  /**
   * v60 → v61: A STROKE LEARNS WHAT SIZE IT WAS DESIGNED AT.
   *
   * Every px-dimensioned stage of the stroke pipeline — dash, wave, roughness,
   * scatter spread, offset — was stored absolutely, so nothing recorded how big
   * the line was MEANT to be and nothing could scale with it. Dragging a 2px
   * dashed, wobbling line up to 40px kept the 6/4 dashes and the 3px wobble,
   * which at that weight is a plain fat line: the same data, the design gone.
   *
   * Stamping each stroke's CURRENT width as its design width changes nothing on
   * screen (the factor is exactly 1 for every existing document) and makes the
   * next width edit scale the whole look. Opting out is a per-stroke decision
   * from here on, not a property of when the file was made.
   */
  /**
   * v61 → v62: A CONTOUR GETS A NAME IT KEEPS.
   *
   * Every gesture in the node editor addresses a contour by INDEX, which is
   * correct while you drag a point and wrong the instant anything structural
   * happens — a split, a join, a knife cut, a delete, a paste, a boolean all
   * renumber the list under a live selection. An id is what a selection, a
   * clipboard, a morph correspondence and an undo step can hold across those.
   *
   * Purely additive: nothing about the geometry, the paint or the fill rule
   * moves, so a v61 document opens pixel-identical.
   */
  /**
   * v63 — a contour can say "like my layer, except…".
   *
   * `PathClip.contourStyles` maps a contour id to a `ScopeOverlay`: the same
   * shape a text range and a caption focus already carry, so per-piece styling
   * inherits the contract the document already has (presence is an override,
   * absence is inheritance) instead of inventing a second one.
   *
   * Purely additive, and the schema's own `.default({})` would fill it anyway —
   * the step exists so the version chain has no gap. A v62 document opens
   * pixel-identical: an empty map means every contour inherits, which is what
   * every contour did before there was anything to inherit from.
   */
  /**
   * v63 → v64: A GRADE IS AS LONG AS THE COMP.
   *
   * An adjustment layer is a property of the composite, not a span of footage,
   * so its length has never had a reason to be anything but "the whole comp".
   * It was born at a flat 5000ms anyway, which meant the frame's own effects
   * silently stopped grading two thirds of the way through a 15s comp, and
   * lengthening the comp left the grade where it was.
   *
   * `fillDuration` — the tracking every clip inside a nested comp already uses
   * — is the answer, so this is a DEFAULT changing, not a mechanism arriving.
   * Only processors that already cover their comp are switched on: one that was
   * deliberately trimmed to a section stays exactly where the edit left it,
   * which is the same promise `trimClip` makes to every other fill clip.
   */
  /**
   * v64 → v65: WHETHER A GRADE CONSUMES WHAT IT GRADES BECOMES A CHOICE.
   *
   * The renderer replaced the plate when the adjustment had no matte and laid
   * over it when it had one. Two behaviours derived from a field that was
   * chosen for something else entirely — so a transformed grade moved the whole
   * frame, but the moment you scoped it to one layer that layer stayed put with
   * its graded copy floating beside it, and nothing in the panel said why.
   *
   * `scope.source` says it outright. Stamping each existing clip with the
   * behaviour it HAD (`filter: "all"` → replace, scoped → over) means every
   * document opens pixel-identical; from here the switch is the user's.
   */
  64: (raw) => ({
    ...raw,
    version: 65,
    tracks: mapClips(raw.tracks, (clip) => {
      if (clip.kind !== "adjustment") return clip;
      const scope = (clip.scope ?? {}) as Record<string, unknown>;
      const filter = (scope.filter ?? {}) as Record<string, unknown>;
      const mode = typeof filter.mode === "string" ? filter.mode : "all";
      return { ...clip, scope: { ...scope, source: mode === "all" ? "replace" : "over" } };
    }),
  }),

  63: (raw) => {
    const frames = Array.isArray(raw.frames) ? (raw.frames as Array<Record<string, unknown>>) : [];
    const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);
    const docDuration = num(raw.durationMs, 0);
    // The comp's span, from raw JSON: the document's when it is the only frame,
    // its own override, else however far its content reaches (`frameDurationMs`).
    const compEnd = (frameId: string): number => {
      if (frames.length === 1) return docDuration;
      const own = frames.find((f) => f.id === frameId)?.durationMs;
      if (typeof own === "number") return own;
      let end = 0;
      for (const track of Array.isArray(raw.tracks) ? (raw.tracks as Array<Record<string, unknown>>) : []) {
        for (const c of Array.isArray(track.clips) ? (track.clips as Array<Record<string, unknown>>) : []) {
          if (c.frameId !== frameId || c.kind === "adjustment") continue;
          end = Math.max(end, num(c.startMs, 0) + num(c.durationMs, 0));
        }
      }
      return end;
    };
    return {
      ...raw,
      version: 64,
      tracks: mapClips(raw.tracks, (clip) => {
        if (clip.kind !== "adjustment" || clip.fillDuration === true) return clip;
        const covers =
          num(clip.startMs, 0) <= 0 &&
          num(clip.startMs, 0) + num(clip.durationMs, 0) >= compEnd(clip.frameId as string) - 1;
        return covers ? { ...clip, fillDuration: true } : clip;
      }),
    };
  },

  62: (raw) => ({
    ...raw,
    version: 63,
    tracks: mapClips(raw.tracks, (clip) => (clip.kind === "path" ? { ...clip, contourStyles: {} } : clip)),
  }),

  61: (raw) => ({
    ...raw,
    version: 62,
    tracks: mapClips(raw.tracks, (clip) => {
      if (clip.kind !== "path") return clip;
      for (const sub of (clip.subpaths as Array<Record<string, unknown>>) ?? []) {
        sub.id = createId("sub");
      }
      return clip;
    }),
  }),

  /**
   * v68 — the picture gets a transform of its own, inside the crop window.
   *
   * Purely additive, and the identity default is exactly right for every clip
   * that exists: before this, moving the picture inside a crop was the layer's
   * own `x`/`y` shifting while the insets absorbed the same amount back, and
   * that arrangement still renders identically — it is a position and four
   * insets that happen to say what they say. Nothing to rewrite; the new field
   * simply gives the NEXT such move somewhere honest to live.
   */
  /**
   * v71 — CONTAINMENT IS THE ROW.
   *
   * A clip used to say which group it was in (`clip.groupId`), and a group's
   * rows were whatever lanes sat directly beneath the group's own lane, kept
   * contiguous by a compaction pass. The lane had become the group: the bar
   * could not leave its row, and every edit had to keep the run honest.
   *
   * Now a track carries the membership (`track.groupId`) and a clip is in a
   * group because it sits on one of that group's rows. Each existing lane is
   * scoped by the ONE group its clips already agreed on; a lane that somehow
   * held clips of two groups (a healing state, never a supported one) is split
   * so each part has one answer. The group clip itself stays exactly where it
   * was — on a lane of its parent scope — so nothing changes where anything
   * paints. `clip.groupId` is then dropped.
   */
  /**
   * v72 → v73: RELATIONS — text on a path, and auto layout (`schema/relations.ts`).
   *
   * Purely additive: `text.path`, `group.layout`, `clip.layoutItem` and
   * `style.orientation` all default to "not related / horizontal", so an
   * existing document opens pixel-identical with nothing to rewrite. The bump
   * exists so an older app refuses a file that carries a relation rather than
   * silently drawing its text straight and its rows unarranged.
   */
  /**
   * v73 → v74: a keyframe's time may fall OUTSIDE its clip.
   *
   * Nothing to rewrite — `timeMs` merely stopped being clamped at 0
   * (`keyframeSchema`), so every existing document is already valid. The bump
   * exists so an older app refuses a file whose keys sit before the head rather
   * than failing validation with a number it has no way to explain.
   */
  /**
   * v74 → v75: PROVENANCE — `clip.origin` (`schema/provenance.ts`).
   *
   * Purely additive and defaulted to null, so every existing document opens
   * unchanged; the artwork it holds simply has no recorded source, which is
   * the truth about it. The bump exists so an older app refuses a file that
   * carries a provenance record rather than dropping it on the floor and
   * re-saving without it — the one failure a licence audit cannot recover from.
   */
  74: (raw) => ({ ...raw, version: 75 }),

  /**
   * v75 → v76: LIQUID GLASS is rebuilt on a distance field, and LIGHTNING
   * learns to follow real geometry.
   *
   * Glass: the v45 card was a blurred-alpha bevel wearing a glass name —
   * `thickness/curvature/specular/roughness/sheen/shade/edge*` described a
   * 2015 emboss. The rebuilt card keeps every field that still means
   * something (`depth` IS the old thickness; the light angle, frost, ior,
   * inset, coverage, tint, ripple and quality carry straight across) and
   * derives the rest: refraction from the old curvature, the light's
   * intensity from the old specular, its splay from the old roughness, the
   * bezel profile from the old `concave`, and `paint` — how much of the
   * layer's own fill shows — as the inverse of the old transmission. Keyframe
   * tracks, modulator targets and expression drivers on renamed fields move
   * with them; tracks on deleted fields are dropped, because there is no
   * longer anything they could drive.
   *
   * Lightning: `edge` mode is now `outline` (it follows the actual vector
   * geometry where there is any), `branches` doubled as the arc count in
   * edge/burst modes and now `count` says that on its own.
   */
  75: (raw) => {
    type Rec = Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const GLASS_RENAME: Record<string, string> = {
      thickness: "depth",
      specular: "light",
      roughness: "splay",
      specularColor: "lightColor",
      transmission: "paint",
    };
    const GLASS_DROPPED = new Set([
      "curvature", "lightElevation", "sheen", "sheenColor", "edgeWidth", "edgeIntensity", "edgeColor",
      "shade", "shadeColor", "concave",
    ]);
    const migrateGlass = (fx: Rec): void => {
      const old = { ...fx };
      const next: Rec = {
        id: fx.id, type: "glass", enabled: fx.enabled ?? true,
        refraction: Math.min(1, 0.45 + 0.5 * num(old.curvature, 0.55)),
        depth: num(old.thickness, 28),
        dispersion: num(old.dispersion, 0.15),
        frost: num(old.frost, 10),
        lightAngle: num(old.lightAngle, -55),
        light: Math.min(2, num(old.specular, 1) * 0.8),
        splay: Math.min(1, num(old.roughness, 0.22) * 1.5),
        lightColor: typeof old.specularColor === "string" ? old.specularColor : "#ffffff",
        profile: old.concave === true ? "concave" : "squircle",
        ior: num(old.ior, 1.45),
        inset: num(old.inset, 0),
        coverage: Math.max(0.02, Math.min(1, num(old.coverage, 0.35))),
        mix: num(old.mix, 1),
        paint: Math.max(0, Math.min(1, 1 - num(old.transmission, 0.92))),
        tintColor: typeof old.tintColor === "string" ? old.tintColor : "#ffffff",
        tint: num(old.tint, 0.06),
        saturation: num(old.saturation, 1.12),
        brightness: num(old.brightness, 1.02),
        noise: num(old.noise, 0.04),
        noiseScale: num(old.noiseScale, 1),
        ripple: num(old.ripple, 0),
        rippleScale: num(old.rippleScale, 2),
        ripplePhase: num(old.ripplePhase, 0),
        rippleSpeed: num(old.rippleSpeed, 0),
        quality: num(old.quality, 1),
        edgeOnly: old.edgeOnly === true,
      };
      for (const k of Object.keys(fx)) delete fx[k];
      Object.assign(fx, next);
    };
    const migrateLightning = (fx: Rec): void => {
      if (fx.mode === "edge") fx.mode = "outline";
      if (typeof fx.count !== "number") {
        fx.count = fx.mode === "outline" || fx.mode === "burst" ? Math.max(1, num(fx.branches, 5)) : 1;
      }
      if (typeof fx.span !== "number") fx.span = fx.mode === "outline" ? 0.5 : 1;
      if (typeof fx.offset !== "number") fx.offset = 0;
      if (typeof fx.drift !== "number") fx.drift = 0;
      if (typeof fx.flicker !== "number") fx.flicker = 0;
    };
    // `lfx.<id>.<field>` → the renamed path, or null when the field is gone.
    const glassIds = new Set<string>();
    const rewritePath = (path: string): string | null => {
      const m = /^lfx\.([^.]+)\.([^.]+)$/.exec(path);
      if (!m || !glassIds.has(m[1]!)) return path;
      const field = m[2]!;
      if (GLASS_DROPPED.has(field)) return null;
      const to = GLASS_RENAME[field];
      return to ? `lfx.${m[1]}.${to}` : path;
    };
    mapClips(raw.tracks, (clip) => {
      const effects = Array.isArray(clip.effects) ? (clip.effects as Rec[]) : [];
      glassIds.clear();
      for (const fx of effects) {
        if (!fx || typeof fx !== "object") continue;
        if (fx.type === "glass") {
          glassIds.add(String(fx.id));
          migrateGlass(fx);
        } else if (fx.type === "lightning") {
          migrateLightning(fx);
        }
      }
      if (glassIds.size === 0) return clip;
      if (Array.isArray(clip.keyframes)) {
        const kept: Rec[] = [];
        for (const kf of clip.keyframes as Rec[]) {
          const to = typeof kf.property === "string" ? rewritePath(kf.property) : kf.property;
          if (to === null) continue;
          kf.property = to;
          kept.push(kf);
        }
        clip.keyframes = kept;
      }
      if (Array.isArray(clip.modulators)) {
        const kept: Rec[] = [];
        for (const mod of clip.modulators as Rec[]) {
          const to = typeof mod.target === "string" ? rewritePath(mod.target) : mod.target;
          if (to === null) continue;
          mod.target = to;
          kept.push(mod);
        }
        clip.modulators = kept;
      }
      if (clip.drivers && typeof clip.drivers === "object") {
        const next: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(clip.drivers as Record<string, unknown>)) {
          const to = rewritePath(k);
          if (to !== null) next[to] = v;
        }
        clip.drivers = next;
      }
      return clip;
    });
    return { ...raw, version: 76 };
  },

  73: (raw) => ({ ...raw, version: 74 }),

  72: (raw) => ({ ...raw, version: 73 }),

  /**
   * v71 → v72: a text effect's colour SOURCE is a field, not a null.
   *
   * `color: null` meant "follow the glyph". That was the same fact the layer
   * glow spells as `mode: auto`, encoded as an absence — so it could not be
   * keyframed, could not be a registry field, and every surface had to know
   * the special case. Now `source: "text" | "custom"` says it, and `color` is
   * always a string. The migration visits every place a per-glyph stack can
   * live: the style, each range's overlay, and a caption's focus overlay.
   */
  71: (raw) => {
    type Rec = Record<string, unknown>;
    const fix = (list: unknown) => {
      if (!Array.isArray(list)) return;
      for (const fx of list as Rec[]) {
        if (!fx || typeof fx !== "object" || "source" in fx) continue;
        if (fx.color === null || fx.color === undefined) {
          fx.source = "text";
          fx.color = "#ffffff";
        } else {
          fx.source = "custom";
        }
      }
    };
    const fixStyle = (style: unknown) => {
      if (style && typeof style === "object") fix((style as Rec).textEffects);
    };
    const fixOverlay = (ov: unknown) => {
      const added = ov && typeof ov === "object" ? (ov as Rec).added : undefined;
      if (added && typeof added === "object") fix((added as Rec).textEffects);
    };
    mapClips(raw.tracks, (clip) => {
      if (clip.kind !== "text") return clip;
      fixStyle(clip.style);
      for (const r of (clip.ranges as Rec[] | undefined) ?? []) fixOverlay(r?.overlay);
      const focus = (clip.caption as Rec | undefined)?.focus as Rec | undefined;
      if (focus) {
        fixOverlay(focus.overlay);
        // Pre-v59 captions carried a plain partial style on the focus.
        fixStyle(focus.style);
      }
      return clip;
    });
    return { ...raw, version: 72 };
  },

  70: (raw) => {
    type Rec = Record<string, unknown>;
    const tracks = Array.isArray(raw.tracks) ? (raw.tracks as Rec[]) : [];
    const frameOf = new Map<string, string>();
    for (const track of tracks) {
      const clips = Array.isArray(track.clips) ? (track.clips as Rec[]) : [];
      for (const clip of clips) {
        if (clip.kind === "group" && typeof clip.id === "string") frameOf.set(clip.id, String(clip.frameId));
      }
    }
    const out: Rec[] = [];
    for (const track of tracks) {
      const clips = Array.isArray(track.clips) ? (track.clips as Rec[]) : [];
      // Bucket by the group the clip claimed; audio and top-level clips share
      // the null bucket. The first bucket keeps the lane's identity.
      const buckets = new Map<string | null, Rec[]>();
      for (const clip of clips) {
        const gid = clip.kind !== "audio" && typeof clip.groupId === "string" && frameOf.has(clip.groupId) ? clip.groupId : null;
        const list = buckets.get(gid) ?? [];
        list.push(clip);
        buckets.set(gid, list);
      }
      const order = [...buckets.keys()];
      // An empty lane keeps the scope it already declared (v67).
      const own = order.length === 0 ? (typeof track.groupId === "string" ? track.groupId : null) : order[0]!;
      const scoped = (gid: string | null, list: Rec[], id: string): Rec => ({
        ...track,
        id,
        groupId: gid,
        homeCompId: gid ? frameOf.get(gid) ?? track.homeCompId ?? null : track.homeCompId ?? null,
        clips: list.map((c) => {
          const clip = { ...c };
          delete clip.groupId;
          return clip;
        }),
      });
      out.push(scoped(own, buckets.get(own) ?? [], String(track.id)));
      for (const gid of order.slice(1)) {
        out.push({ ...scoped(gid, buckets.get(gid)!, `${track.id}_${gid}`), auto: true, transitions: [] });
      }
    }
    return { ...raw, version: 71, tracks: out };
  },

  /**
   * v70: the PAGE CANVAS frame is gone.
   *
   * It held layers that belonged to no artboard, and it was the wrong shape for
   * the idea: a level's canvas is its own frame's space carried past its edges
   * (see `frame.overflow`), not a second container beside it. Anything parked
   * on one moves to the first artboard on its page, keeping its WORLD position
   * — the canvas was centred on the world origin, so the shift is the artboard's
   * own centre.
   */
  69: (raw) => {
    const frames = Array.isArray(raw.frames) ? (raw.frames as Array<Record<string, unknown>>) : [];
    const canvases = frames.filter((f) => f.role === "canvas");
    if (canvases.length === 0) return { ...raw, version: 70 };
    const gone = new Set(canvases.map((f) => String(f.id)));
    const homeFor = new Map<string, Record<string, unknown>>();
    for (const canvas of canvases) {
      const home = frames.find((f) => f.pageId === canvas.pageId && !gone.has(String(f.id)));
      if (home) homeFor.set(String(canvas.id), home);
    }
    const tracks = Array.isArray(raw.tracks) ? (raw.tracks as Array<Record<string, unknown>>) : [];
    for (const track of tracks) {
      const clips = Array.isArray(track.clips) ? (track.clips as Array<Record<string, unknown>>) : [];
      for (const clip of clips) {
        const home = homeFor.get(String(clip.frameId));
        if (!home) continue;
        clip.frameId = home.id;
        const t = clip.transform as Record<string, unknown> | undefined;
        if (t && typeof t.x === "number" && typeof t.y === "number") {
          t.x -= Number(home.x ?? 0) + Number(home.width ?? 0) / 2;
          t.y -= Number(home.y ?? 0) + Number(home.height ?? 0) / 2;
        }
      }
      track.clips = clips.filter((c) => !gone.has(String(c.frameId)));
    }
    return { ...raw, version: 70, frames: frames.filter((f) => !gone.has(String(f.id))), tracks };
  },
  /**
   * v69: a frame's `clipContent` boolean becomes an `overflow` OPACITY.
   *
   * Migrated faithfully rather than to the new default — `false` meant "show
   * the spill", which is 1, and `true` meant "clip", which is 0. A document
   * that opens looking different from how it was saved is a worse bug than an
   * inconsistent default, so existing frames keep exactly what they had and
   * only NEW frames are born at `DEFAULT_FRAME_OVERFLOW`.
   */
  68: (raw) => ({
    ...raw,
    version: 69,
    frames: Array.isArray(raw.frames)
      ? raw.frames.map((f) => {
          const frame = { ...(f as Record<string, unknown>) };
          frame.overflow = frame.clipContent === true ? 0 : 1;
          delete frame.clipContent;
          return frame;
        })
      : raw.frames,
  }),
  67: (raw) => ({ ...raw, version: 68 }),

  /**
   * v67 — a lane can say which GROUP it was made inside.
   *
   * Purely additive: the zod default (`null`) is exactly right for every lane
   * that exists today, since none of them was made inside a group.
   */
  66: (raw) => ({ ...raw, version: 67 }),

  /**
   * v66 — a GROUP becomes a CLIP.
   *
   * `doc.groups` was a table of `{id, name, mode, parentId}` rows: a group had
   * no span, so it could not be trimmed or take a transition; no transform,
   * paint or effects, because none of that machinery is reachable from a table
   * row; and its nesting lived in `parentId` while its membership lived on the
   * clips, so two structures answered "what is in this group".
   *
   * Each row becomes a `kind: "group"` clip on its OWN lane, inserted directly
   * above the group's topmost member — which is exactly where the old renderer
   * placed the group node, so every existing document composites identically.
   * Member `groupId`s already point at the group's id and are untouched; a
   * group's `parentId` simply becomes its own `groupId`, collapsing the two
   * structures into one edge.
   *
   * The span is the union of what the group holds, so every member starts out
   * matching the group and therefore FOLLOWS it on the first trim (see
   * `timeline/group-time.ts`) — the migrated behaviour is the one a person
   * would expect from a group they had just drawn around those layers.
   */
  65: (raw) => {
    const groups = (Array.isArray(raw.groups) ? raw.groups : []) as Array<Record<string, unknown>>;
    const tracks = (Array.isArray(raw.tracks) ? raw.tracks : []) as Array<Record<string, unknown>>;
    if (groups.length === 0) {
      const { groups: _dropped, ...rest } = raw;
      return { ...rest, version: 66 };
    }

    const parentOf = new Map<string, string | null>(
      groups.map((g) => [String(g.id), (g.parentId as string | null) ?? null]),
    );
    const ancestry = (gid: string | null): string[] => {
      const out: string[] = [];
      const seen = new Set<string>();
      let g = gid;
      while (g && parentOf.has(g) && !seen.has(g)) {
        seen.add(g);
        out.push(g);
        g = parentOf.get(g) ?? null;
      }
      return out;
    };

    // Where each group's members sit: topmost lane, comp, and time span.
    interface Placement { laneIndex: number; frameId: string; startMs: number; endMs: number }
    const placement = new Map<string, Placement>();
    tracks.forEach((track, laneIndex) => {
      const clips = (Array.isArray(track.clips) ? track.clips : []) as Array<Record<string, unknown>>;
      for (const clip of clips) {
        if (clip.kind === "audio" || typeof clip.groupId !== "string") continue;
        const startMs = typeof clip.startMs === "number" ? clip.startMs : 0;
        const endMs = startMs + (typeof clip.durationMs === "number" ? clip.durationMs : 0);
        for (const gid of ancestry(clip.groupId)) {
          const at = placement.get(gid);
          if (!at) {
            placement.set(gid, { laneIndex, frameId: String(clip.frameId ?? ""), startMs, endMs });
          } else {
            at.startMs = Math.min(at.startMs, startMs);
            at.endMs = Math.max(at.endMs, endMs);
          }
        }
      }
    });

    // Outer groups first, so a parent's lane lands above its child's.
    const live = groups
      .filter((g) => placement.has(String(g.id)))
      .sort((a, b) => ancestry(String(a.id)).length - ancestry(String(b.id)).length);

    const lanesBefore = new Map<number, Array<Record<string, unknown>>>();
    for (const g of live) {
      const id = String(g.id);
      const at = placement.get(id)!;
      const lane = {
        id: `track_${id}`,
        name: String(g.name ?? "Group"),
        clips: [groupClip66(id, g, at)],
        muted: false,
        locked: false,
        hidden: false,
        color: null,
        heightPx: null,
        homeCompId: at.frameId,
        auto: true,
        loop: "none",
        transitions: [],
      };
      const bucket = lanesBefore.get(at.laneIndex) ?? [];
      bucket.push(lane);
      lanesBefore.set(at.laneIndex, bucket);
    }

    const next: unknown[] = [];
    tracks.forEach((track, i) => {
      for (const lane of lanesBefore.get(i) ?? []) next.push(lane);
      next.push(track);
    });
    for (const lane of lanesBefore.get(tracks.length) ?? []) next.push(lane);

    // v66 also makes the boolean modes read `isStencil`, which they never did.
    // Their old rule was implicit — the BOTTOM member was the base and
    // everything above it cut — so stamp exactly that as roles, and the
    // migrated document paints the picture it painted yesterday.
    const boolModes = new Set(["subtract", "intersect", "exclude"]);
    for (const g of live) {
      if (!boolModes.has(String(g.mode))) continue;
      const id = String(g.id);
      const members: Array<Record<string, unknown>> = [];
      for (const track of tracks) {
        const clips = (Array.isArray(track.clips) ? track.clips : []) as Array<Record<string, unknown>>;
        for (const clip of clips) if (clip.groupId === id) members.push(clip);
      }
      // `tracks` is top→bottom, so the last one collected is the bottom base.
      members.slice(0, -1).forEach((m) => { m.isStencil = true; });
    }

    const { groups: _dropped, ...rest } = raw;
    return { ...rest, version: 66, tracks: next };
  },

  60: (raw) => ({
    ...raw,
    version: 61,
    tracks: mapClips(raw.tracks, (clip) => {
      // The layer's own strokes AND every scope overlay's added strokes — a
      // range or caption stroke is as much a stroke as the layer's.
      const stamp = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const s of list as Array<Record<string, unknown>>) {
          if (s && typeof s === "object" && s.baseWidth === undefined) {
            s.baseWidth = typeof s.width === "number" ? s.width : null;
          }
        }
      };
      stamp(clip.strokes);
      const overlays = [
        ...((clip.ranges as Array<{ overlay?: { added?: { strokes?: unknown } } }> | undefined) ?? []).map((r) => r.overlay),
        (clip.caption as { focus?: { overlay?: { added?: { strokes?: unknown } } } } | undefined)?.focus?.overlay,
      ];
      for (const ov of overlays) stamp(ov?.added?.strokes);
      return clip;
    }),
  }),
  58: (raw) => ({
    ...raw,
    version: 59,
    tracks: mapClips(raw.tracks, (clip) => {
      const toOverlay = (style: Record<string, unknown> | undefined) => {
        const props: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(style ?? {})) {
          if (k === "highlight") {
            if (v && typeof v === "object") {
              for (const [hk, hv] of Object.entries(v as Record<string, unknown>)) props[`highlight.${hk}`] = hv;
            }
            continue;
          }
          if (v !== undefined) props[k] = v;
        }
        return { props, removed: [], added: { effects: [], fills: [], strokes: [] } };
      };
      for (const range of (clip.ranges as Array<Record<string, unknown>>) ?? []) {
        range.overlay = toOverlay(range.style as Record<string, unknown> | undefined);
        delete range.style;
      }
      const caption = clip.caption as Record<string, unknown> | undefined;
      const focus = caption?.focus as Record<string, unknown> | undefined;
      if (focus) {
        focus.overlay = toOverlay(focus.style as Record<string, unknown> | undefined);
        delete focus.style;
      }
      return clip;
    }),
  }),
  57: (raw) => ({
    ...raw,
    tracks: mapClips(raw.tracks, (clip) => {
      const trim = clip.trim as { start?: number; end?: number; offset?: number } | undefined;
      delete clip.trim;
      const strokes = Array.isArray(clip.strokes) ? (clip.strokes as Array<Record<string, unknown>>) : [];
      if (!trim || strokes.length === 0) {
        stripTrimTracks(clip);
        return clip;
      }
      const window = { start: trim.start ?? 0, end: trim.end ?? 1, offset: trim.offset ?? 0 };
      for (const s of strokes) s.trim = { ...window };
      // Re-address the clip's trim keyframes onto every stroke that inherits it.
      const tracks = Array.isArray(clip.keyframes) ? (clip.keyframes as Array<Record<string, unknown>>) : [];
      const moved: Array<Record<string, unknown>> = [];
      for (const t of tracks) {
        const field = TRIM_FIELDS.find((f) => t.property === f);
        if (!field) continue;
        for (const s of strokes) moved.push({ ...t, property: `stroke.${String(s.id)}.${field}` });
      }
      stripTrimTracks(clip);
      if (moved.length > 0) {
        clip.keyframes = [...(clip.keyframes as unknown[]), ...moved];
      }
      return clip;
    }),
    version: 58,
  }),
  /**
   * v80 → v81: GENERATED MEDIA KNOWS WHERE IT CAME FROM. Assets gain `origin`
   * (null — imported, not generated). Purely additive; the schema default
   * fills it, so this only moves the number.
   */
  80: (raw) => ({ ...raw, version: 81 }),
  /**
   * v81 → v82: FAUX BOLD IS ITS OWN CONCEPT. Text styles gain `fauxBold` (0 —
   * none), extra ink laid on top of whatever weight the face draws. The Bold
   * button used to write `fontWeight: 700`, so every existing "bold" text is a
   * real 700 and stays one; nothing to convert. Additive; the schema default
   * fills it.
   */
  81: (raw) => ({ ...raw, version: 82 }),
  /**
   * v82 → v83: NUMBERS COUNT BETWEEN CONTENT KEYS. A number whose value
   * changes between two `text` keys now counts across the segment by default.
   * Every document written before this CUT instead, and an old project must
   * play exactly as it was made — so each text clip with keyed content gets
   * every number slot it holds written out as switched off. New numbers, and
   * anything the user switches on, count.
   */
  82: (raw) => ({ ...raw, tracks: mapTextClips82(raw.tracks), version: 83 }),
  /**
   * v83 → v84: EVERY COMP KEEPS ITS OWN PLAYHEAD. Frames gain an optional
   * `playheadMs` — view state saved with the project, so sibling scenes stop
   * sharing one instant. Absent means the first frame, which is where every
   * older project opened anyway. Additive; nothing to convert.
   */
  83: (raw) => ({ ...raw, version: 84 }),
  /**
   * v84 → v85: ONE NAME, ONE FIELD. The Stroke card's `position` select
   * (inside/center/outside) shared its key with Shine's and Lightning's number,
   * so the property registry — which resolves `lfx.<id>.<field>` by name —
   * refused the contested name for EVERY card: a shine's position could not be
   * keyed at all. Stroke's is now `placement` (tracks follow). And a moving
   * shine that still sits on the old default (0.5, unkeyed) starts from the
   * edge, so it stops popping in mid-layer and idling off it for half a pass.
   */
  84: (raw) => ({
    ...raw,
    tracks: mapLayerEffects84(raw.tracks),
    presets: Array.isArray(raw.presets)
      ? (raw.presets as Array<Record<string, unknown>>).map((p) =>
          p.kind === "effect:stroke" && p.data && typeof p.data === "object"
            ? { ...p, data: legacyStrokePatch(p.data as Record<string, unknown>) }
            : p,
        )
      : raw.presets,
    version: 85,
  }),
  /**
   * v85 → v86: CATEGORIES ARE BUSES. Audio clips' closed `role` becomes a
   * route into `doc.soundBuses` (the ids are the old role names, so voice /
   * music / sfx carry straight across; "none" routes by default). Every comp
   * gains a mix master — migrated with the leveler and limiter OFF, so an old
   * project sounds exactly as it did until someone turns them on.
   */
  85: (raw) => ({
    ...raw,
    tracks: Array.isArray(raw.tracks)
      ? (raw.tracks as Array<Record<string, unknown>>).map((t) =>
          Array.isArray(t.clips)
            ? {
                ...t,
                clips: (t.clips as Array<Record<string, unknown>>).map((c) => {
                  if (c.kind !== "audio" || !("role" in c)) return c;
                  const { role, ...rest } = c;
                  return role === "voice" || role === "music" || role === "sfx" ? { ...rest, soundBus: role } : rest;
                }),
              }
            : t,
        )
      : raw.tracks,
    frames: Array.isArray(raw.frames)
      ? (raw.frames as Array<Record<string, unknown>>).map((f) => ({
          ...f,
          soundMix: f.soundMix ?? { volume: 1, leveler: { enabled: false }, limiter: { enabled: false } },
        }))
      : raw.frames,
    version: 86,
  }),
  /**
   * v86 → v87: FRAME SLIPS ARE A SWITCH. Film damage gains `splices` (off by
   * default — a one-frame lurch reads as a broken render to anyone who did not
   * ask for it). A card that already slipped — a non-zero or keyed `jump` —
   * keeps slipping, so an old project plays exactly as it was made.
   */
  86: (raw) => ({ ...raw, tracks: mapFilmDamage86(raw.tracks), version: 87 }),
  /**
   * v87 → v88: FRAME MODES. `role` becomes `mode` (comp → timeline, flipbook
   * stays) and "drawing" retires into "static" — see `migrateFrameModes88`.
   */
  87: (raw) => migrateFrameModes88(raw),
  /**
   * v88 → v89: THE THIRD DIMENSION. Transforms gain optional `z`, `rotationX`,
   * `rotationY`, `scaleZ`; frames gain an optional `world`; clips gain the
   * `mesh`, `camera`, `light` and `empty` kinds and optional `constraints` and
   * `extrude`; path points an optional `z`. Absent is
   * identity everywhere, so every existing project is already a correct v89
   * project and renders byte for byte. The bump exists so a v89 file — which
   * may hold a world — fails loudly on an app that cannot draw one.
   */
  88: (raw) => ({ ...raw, version: 89 }),
  /**
   * v89 → v90: RIGGING. Groups gain an optional `rig` (bones) and layers an
   * optional `bind`; absent is "no rig" and "bound automatically", so every
   * v89 project is already a correct v90 one. The bump makes a file with a rig
   * fail loudly on an app that would drop its bones.
   */
  89: (raw) => ({ ...raw, version: 90 }),
  /**
   * v90 → v91: CHARACTERS. Bones gain a drawn shape, a colour and channel
   * limits (controls, sliders, pads); groups an optional `switch` (one member
   * shows at a time). All defaulted, so a v90 project is a correct v91 one.
   */
  90: (raw) => ({ ...raw, version: 91 }),
  /**
   * v91 → v92: PHYSICS FOR EVERY LAYER. A body (`physics`), a field and joints
   * move onto every visual layer (a mesh's body is already in that place), and
   * a world's physics settings become the comp's own `physics` — the one
   * simulation block a flat comp has too. Gravity was signed along +Z; it is a
   * downward pull now, so it flips; the ground becomes the floor.
   */
  91: (raw) => {
    const frames = Array.isArray(raw.frames) ? (raw.frames as Array<Record<string, unknown>>) : [];
    return {
      ...raw,
      version: 92,
      frames: frames.map((f) => {
        const world = f.world as Record<string, unknown> | null | undefined;
        const old = world?.physics as { gravity?: number; ground?: boolean; groundZ?: number; startMs?: number } | undefined;
        if (!world || !old) return f;
        const { physics: _drop, ...rest } = world;
        void _drop;
        return {
          ...f,
          world: rest,
          physics: { gravity: -(old.gravity ?? -981), startMs: old.startMs ?? 0, floor: old.ground ?? true, floorAt: old.groundZ ?? 0 },
        };
      }),
    };
  },
  /**
   * v92 → v93: FORCES ARE A STACK. A layer's one `field` becomes the first card
   * of `forces` (any number, repeats allowed, each with a stable id), and its
   * keys, modulators and drivers move from `field.<k>` to `force.<id>.<k>`. The
   * id is derived from the layer's, so the step is deterministic. Bodies gain
   * `follow` (0 — free, as before), which the schema default fills.
   */
  92: (raw) => ({
    ...raw,
    version: 93,
    tracks: mapClips(raw.tracks, (clip) => {
      const field = clip.field as Record<string, unknown> | undefined;
      if (!field) return clip;
      const id = `force_${String(clip.id)}`;
      delete clip.field;
      clip.forces = [{ ...field, id }];
      const move = (p: string) => (p.startsWith("field.") ? `force.${id}.${p.slice(6)}` : p);
      if (Array.isArray(clip.keyframes)) for (const kf of clip.keyframes as Array<Record<string, unknown>>) if (typeof kf.property === "string") kf.property = move(kf.property);
      if (Array.isArray(clip.modulators)) for (const m of clip.modulators as Array<Record<string, unknown>>) if (typeof m.target === "string") m.target = move(m.target);
      if (clip.drivers && typeof clip.drivers === "object") clip.drivers = Object.fromEntries(Object.entries(clip.drivers as Record<string, unknown>).map(([k, v]) => [move(k), v]));
      return clip;
    }),
  }),
  /**
   * v93 → v94: SCRIPTS. Two new tables (`scripts`, `scriptFolders`), both
   * defaulted empty by the schema — nothing to move.
   */
  93: (raw) => ({ ...raw, version: 94 }),
  /**
   * v94 → v95: CHARACTERS 2.0. Groups gain pose sets (`poses`), bones gain
   * constraints (look · track), paths and meshes gain shape keys, frames gain
   * component inputs and state machines, audio assets gain speech settings and
   * hand fixes. Every field is optional with its absence meaning "none", so a
   * v94 project is already a correct v95 one; the bump marks files that may
   * carry them (an older app would drop them on load).
   */
  94: (raw) => ({ ...raw, version: 95 }),
  /**
   * v95 → v96: A BLINK RIDES ON THE EYES' OWN CHOICE. `blink()` was bound as
   * `if(blink(4) > 0, "Closed", "Open")`, which hard-coded the open eyes: a
   * pose picked on the Face pad changed nothing. It now ends in `#value` (the
   * channel's own keys or base), with that base set to the old open name — so
   * the picture is identical, and picks start working. A channel that carries
   * keys is left alone: the driver hid them, and `#value` would surface them.
   */
  95: (raw) => migrateRidingBlink96(raw),
  /**
   * v96 → v97: BEHAVIORS ARE THINGS (Characters 3.0). Make character wired its
   * life as hidden expressions and modulators; each becomes a behavior on the
   * character, listed, tunable and deletable, with the same picture:
   * `if(blink(e[, l]) > 0, "Closed", #value|"Open")` on a pose set → Blink;
   * `lipsync(...)` on a pose set → Lip sync; `n + a * loudness(...)` on a part's
   * rotation → Nod with voice; the `alive-breathe` modulators → Breathe. An
   * expression is dropped only when nothing else still reads it. Everything
   * else stays a driver.
   */
  96: (raw) => migrateBehaviors97(raw),
  /**
   * v97 → v98: LINKS. Visual clips and text ranges gain an optional `link`
   * (absent = none) — a v97 project has none, so this only moves the number
   * (and marks files an older app would strip links from).
   */
  97: (raw) => ({ ...raw, version: 98 }),
  /**
   * v98 → v99: HOLD KEYS. An easing may be `{kind: "hold"}` — the value waits
   * for the next key, then cuts. Nothing stored changes; the bump exists so a
   * document holding one fails loudly on an app that cannot play it, instead of
   * failing validation with an unreadable error.
   */
  98: (raw) => ({ ...raw, version: 99 }),
  /**
   * v99 → v100: CARDS CAN HOLD STILL. Every self-moving card gained `animate`;
   * grain, noise and rough edges now arrive still. Each one already in a
   * project moved, so it is written `animate: true` and keeps moving.
   */
  99: (raw) => ({ ...migrateStillCards100(raw), version: 100 }),
  /**
   * v100 → v101: A TRACKER BELONGS TO ITS FOOTAGE. `sourceClipId` + clip-local
   * sample times become `source: {kind: "asset"}` + SOURCE times, so a split,
   * retimed or duplicated clip keeps its track. Times are carried through the
   * clip's trim and constant speed; a reversed or ramped clip's old track lands
   * approximately and a re-solve settles it. A tracker on something that is not
   * media (it could never have been analysed) is dropped with its followers'
   * bindings and the grade windows that named it.
   */
  100: (raw) => ({ ...migrateTrackers101(raw), version: 101 }),
  /**
   * v101 → v102: PARTICLES. Any layer may carry `emitters` (a stack, like its
   * forces). Nothing to rewrite — absent means none — but an app that does not
   * know them must refuse the file rather than open it and save it back
   * without its particles.
   */
  101: (raw) => ({ ...raw, version: 102 }),
  /**
   * v102 → v103: PARTICLES ARE THEIR OWN PICTURE. A layer's opacity no longer
   * reaches its particles (a word fading in sheds sparks before it shows, an
   * invisible collider sparks); each emitter has its own keyable `opacity`.
   * Carried over so nothing that shipped changes: a carrier's opacity — its
   * value, its keys, its driver — becomes each of its emitters'.
   */
  102: (raw) => ({ ...migrateEmitterOpacity103(raw), version: 103 }),
  /**
   * v103 → v104: SOUND SETS AND THE CLIMAX. A sound voice may play `notes`
   * (a scale, an order, a span), a stack entry has a keyable `intensity`, a
   * hit trigger a `rise` (keys | hits), and five tuned packs exist. All absent
   * means what v102 played — one tone, intensity 0, keys — so nothing is
   * rewritten; an app that cannot voice a scale must refuse the file rather
   * than save it back as a flat repeated tone.
   */
  103: (raw) => ({ ...raw, version: 104 }),
  /**
   * v104 → v105: RECORDED KITS AND A CLIMAX OF WEIGHT. A voice may be a `kit`
   * of recorded takes (round-robin, velocity layers, each retuned from its
   * `root` to the note it plays) and may `climb` by weight instead of pitch
   * (the register stays, notes damp, a low weight joins, hits sit where they
   * struck). Absent = no kit, `pitch` — what v104 played — so nothing is
   * rewritten.
   */
  104: (raw) => ({ ...raw, version: 105 }),
  /**
   * v105 → v106: NOTHING PASSES THROUGH A WALL. The solver splits a step that
   * would carry a body past ¾ of its radius (`physics.guard`, default on). A
   * comp that already simulates keeps `guard: false`, so a saved scene — and
   * everything built on where its bodies are — replays exactly as it did.
   */
  105: (raw) => ({ ...keepStepping106(raw), version: 106 }),
  /**
   * v106 → v107: COSMOS. A force may be a `gravity` well (inverse-square
   * `mass`, a `horizon` that swallows, frame-dragging `spin`, a softened
   * `core`). Absent fields are their defaults and no v106 force is a well, so
   * nothing is rewritten — but an app that does not know a well must refuse
   * the file rather than drop it on save.
   */
  106: (raw) => ({ ...raw, version: 107 }),
  /**
   * v107 → v108: a glow may fall off like LIGHT (`glowFalloff: "light"`, a
   * core-heavy lens bloom). Absent = `even`, today's single halo, so nothing
   * is rewritten — but an older app would drop the field on save and turn
   * every star back into a faint ring, so it must refuse the file.
   */
  107: (raw) => ({ ...raw, version: 108 }),
  /**
   * v108 → v109: TEXTURE. A `surface` layer effect (a material: paper, kraft,
   * black card, linen, canvas, felt, cardboard, crumpled); halftone may lay
   * its `paper` under any ink and pixelate has a `board` behind its cells
   * (absent = off / clear — what v108 drew); and a whole-frame effects clip's
   * `fps` now holds the frame it covers (posterize time). Nothing is
   * rewritten. A v108 frame-effects clip given its own rate (its Timing row
   * allowed it) stepped only its own keys; it now holds the picture under it
   * on the same beat, which is what that rate on the frame's look meant. An
   * older app would drop a surface card on save, so it must refuse the file.
   */
  108: (raw) => ({ ...raw, version: 109 }),
  /**
   * v109 → v110: TRACE, a layer kind (`kind: "trace"`) that draws where a
   * point has been over the whole shot. No v109 document holds one, so
   * nothing is rewritten — but an older app cannot read the kind and must
   * refuse the file rather than fail on it.
   */
  109: (raw) => ({ ...raw, version: 110 }),
  /**
   * v110 → v111: halftone may print as a RISO (`mode: "riso"`: the picture
   * separated into two inks, `ink2Color`, its drum `misregister` px off), and
   * three more Surface materials (watercolour paper, clay, blueprint) with the
   * Texture looks built on them (Claymation, Blueprint, Engraving,
   * Watercolour). Nothing is rewritten — but an older app cannot read the new
   * mode or materials and would drop the card on save, so it must refuse the
   * file.
   */
  110: (raw) => ({ ...raw, version: 111 }),
  /**
   * v111 → v112: the MATERIAL ENGINE on the Surface card — thirteen materials
   * with a body, sheen, glow or flow (foil, chrome, neon, stained glass,
   * frosted glass, crystal, soap film, ferrofluid, kintsugi, tufted rug, CRT
   * phosphor, rice paper, marbling), newsprint, wood and graph paper; the
   * `body`/`sheen`/`glow`/`flow` dials, a `to`/`morph`/`morphStyle` morph
   * between two materials, the `blind` colour mode and a negative (pressed)
   * `lift`. Nothing is rewritten: the new dials default to 0 in the schema,
   * so a card saved before keeps the flat look it was approved with. But an
   * older app cannot read any of it and would drop the card on save, so it
   * must refuse the file.
   */
  111: (raw) => ({ ...raw, version: 112 }),
  // v113: a comp's length has ONE home, the comp. A project with one comp used
  // to keep that comp's length on the DOCUMENT (`durationMs`), and the moment a
  // second comp was added the same comp read its own (unset) length instead and
  // silently began hugging its content — "6174" went 26000 → 26650 that way.
  // The lone comp's length moves onto it: identical playback and export.
  // Also new at v113, nothing to rewrite: a layer's `emitsLight` and Surface's
  // `lightsFrom` (Spare lights from light layers) — an older app would drop
  // them on save, so it must refuse the file.
  112: (raw) => {
    const doc = raw as { frames?: unknown; durationMs?: unknown };
    const frames = Array.isArray(doc.frames) ? (doc.frames as Array<Record<string, unknown>>) : [];
    if (frames.length !== 1 || frames[0]!.durationMs != null || typeof doc.durationMs !== "number") return { ...raw, version: 113 };
    return { ...raw, frames: [{ ...frames[0]!, durationMs: doc.durationMs }], version: 113 };
  },
  // v114: RELATIONAL UNITS — `clip.units`, a path → unit map beside `drivers`
  // (`stroke.<id>.width: "spx"`, `fontSize: "fw"`). Nothing is rewritten: a
  // field with no unit is in comp px, as every field was. An older app would
  // drop the map on save and every relational size would collapse to its raw
  // number, so it must refuse the file.
  113: (raw) => ({ ...raw, version: 114 }),
  // v115: a Surface card may carry ITS OWN TEXTURE (`texture`, an image asset
  // id, with `textureColor` and `textureTiling`). Nothing is rewritten: an
  // empty texture is the material's own pattern, as before. An older app
  // would drop the texture on save, so it must refuse the file.
  114: (raw) => ({ ...raw, version: 115 }),
  // v116: a dots / squares pattern's `aspect` means what it says — rows sit
  // `spacing · aspect` apart. Before, the two-row tile was one period tall, so
  // rows sat at HALF that (aspect 1 drew a 2:1 lattice, aspect 2 a square
  // one). Every such pattern, and every key on its `pattern.aspect`, is
  // halved: the picture is identical.
  115: (raw) => ({ ...(migrateLatticeAspect116(raw) as Record<string, unknown>), version: 116 }),
  // v117: text sits in the MIDDLE of its line box (`style.baseline`, see
  // `text/line-box.ts`). Every text style saved before was laid out with the
  // fixed 0.78 em baseline and is stamped `fixed`, so nothing moves; new text
  // is `centered`.
  116: (raw) => ({ ...(stampFixedBaseline117(raw) as Record<string, unknown>), version: 117 }),
};

/** See step 116 → 117. A whole text style can sit on a clip, a caption, a
 *  preset or a component; a partial one (a range, a caption state) has no
 *  `lineHeight` + `align` pair and is left alone. */
function stampFixedBaseline117(raw: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    if ("fontFamily" in out && "fontSize" in out && "lineHeight" in out && "align" in out && !("baseline" in out)) out.baseline = "fixed";
    return out;
  };
  return walk(raw);
}

/** See step 115 → 116. Walks the whole document: a pattern paint can sit on a
 *  clip, a stroke, a comp background, a variable or a preset. */
function migrateLatticeAspect116(raw: unknown): unknown {
  type Rec = Record<string, unknown>;
  const rec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const twoRow = (p: unknown): p is Rec & { pattern: Rec } =>
    rec(p) && p.type === "pattern" && rec(p.pattern) && (p.pattern.kind === "dots" || p.pattern.kind === "squares");
  // 0.1 is the schema's floor; below 0.2 the old picture cannot be kept exactly.
  const half = (v: unknown) => (typeof v === "number" ? Math.max(0.1, v / 2) : v);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!rec(v)) return v;
    const out: Rec = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    if (twoRow(v)) out.pattern = { ...(out.pattern as Rec), aspect: half(v.pattern.aspect ?? 1) };
    if (Array.isArray(v.keyframes)) {
      const paths = new Set<string>();
      for (const f of list(v.fills)) if (twoRow(f)) paths.add(`fill.${String(f.id)}.pattern.aspect`);
      for (const s of list(v.strokes)) if (rec(s) && twoRow(s.paint)) paths.add(`stroke.${String(s.id)}.pattern.aspect`);
      if (paths.size)
        out.keyframes = (out.keyframes as unknown[]).map((t) =>
          rec(t) && paths.has(String(t.property)) ? { ...t, keys: list(t.keys).map((k) => (rec(k) ? { ...k, value: half(k.value) } : k)) } : t,
        );
    }
    return out;
  };
  return walk(raw);
}

/** See step 105 → 106: every comp with a body keeps its one-step simulation. */
function keepStepping106(raw: Record<string, unknown>): Record<string, unknown> {
  type Rec = Record<string, unknown>;
  if (!Array.isArray(raw.frames) || !Array.isArray(raw.tracks)) return raw;
  const simulating = new Set<string>();
  for (const t of raw.tracks as Rec[]) for (const c of (Array.isArray(t.clips) ? t.clips : []) as Rec[]) if (c.physics && typeof c.frameId === "string") simulating.add(c.frameId);
  if (!simulating.size) return raw;
  return { ...raw, frames: (raw.frames as Rec[]).map((f) => (simulating.has(String(f.id)) ? { ...f, physics: { ...((f.physics as Rec | undefined) ?? {}), guard: false } } : f)) };
}

/** See step 102 → 103. */
function migrateEmitterOpacity103(raw: Record<string, unknown>): Record<string, unknown> {
  type Rec = Record<string, unknown>;
  if (!Array.isArray(raw.tracks)) return raw;
  const carry = (clip: Rec): Rec => {
    const emitters = Array.isArray(clip.emitters) ? (clip.emitters as Rec[]) : [];
    if (!emitters.length) return clip;
    const opacity = typeof clip.opacity === "number" ? clip.opacity : 1;
    const keyframes = Array.isArray(clip.keyframes) ? (clip.keyframes as Rec[]) : [];
    const keyed = keyframes.filter((t) => t.property === "opacity" && !t.range);
    const drivers = clip.drivers && typeof clip.drivers === "object" ? (clip.drivers as Record<string, string>) : null;
    const driver = drivers?.opacity;
    if (opacity === 1 && !keyed.length && !driver) return clip;
    const ids = emitters.map((e) => String(e.id));
    return {
      ...clip,
      emitters: emitters.map((e) => ({ ...e, opacity })),
      keyframes: [...keyframes, ...ids.flatMap((id) => keyed.map((t) => ({ ...t, id: `${String(t.id)}-${id}`, property: `emit.${id}.opacity` })))],
      ...(driver && { drivers: { ...drivers, ...Object.fromEntries(ids.map((id) => [`emit.${id}.opacity`, driver])) } }),
    };
  };
  return { ...raw, tracks: (raw.tracks as Rec[]).map((t) => (Array.isArray(t.clips) ? { ...t, clips: (t.clips as Rec[]).map(carry) } : t)) };
}

/** See step 100 → 101. */
function migrateTrackers101(raw: Record<string, unknown>): Record<string, unknown> {
  type Rec = Record<string, unknown>;
  const trackers = Array.isArray(raw.trackers) ? (raw.trackers as Rec[]) : [];
  if (trackers.length === 0) return raw;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const clips = new Map<string, Rec>();
  if (Array.isArray(raw.tracks))
    for (const t of raw.tracks as Rec[])
      if (Array.isArray(t.clips)) for (const c of t.clips as Rec[]) clips.set(String(c.id), c);

  const dropped = new Set<string>();
  const kept: Rec[] = [];
  trackers.forEach((t, i) => {
    const clip = clips.get(String(t.sourceClipId));
    const assetId = clip && (clip.kind === "video" || clip.kind === "image") && typeof clip.assetId === "string" ? clip.assetId : null;
    if (!clip || !assetId) {
      dropped.add(String(t.id));
      return;
    }
    const still = clip.kind === "image";
    const trimIn = num(clip.trimInMs, 0);
    const speed = Math.abs(num((clip.playback as Rec | undefined)?.speed, 1)) || 1;
    const toSource = (ms: unknown) => (still ? num(ms, 0) : Math.max(0, trimIn + num(ms, 0) * speed));
    const samples = (Array.isArray(t.samples) ? (t.samples as Rec[]) : []).map((s) => ({ ...s, timeMs: toSource(s.timeMs) }));
    const analysis = t.analysis && typeof t.analysis === "object" ? (t.analysis as Rec) : null;
    const { sourceClipId: _drop, ...rest } = t;
    void _drop;
    kept.push({
      ...rest,
      kind: "region",
      color: TRACKER_COLORS[i % TRACKER_COLORS.length],
      source: { kind: "asset", assetId },
      via: String(clip.id),
      samples,
      referenceMs: toSource(t.referenceMs),
      analysis: analysis
        ? {
            version: num(analysis.version, 0),
            engine: typeof analysis.engine === "string" ? analysis.engine : "cpu",
            coverage: samples.length ? [[samples[0]!.timeMs, samples[samples.length - 1]!.timeMs]] : [],
            at: num(analysis.at, 0),
          }
        : null,
    });
  });
  if (dropped.size === 0) return { ...raw, trackers: kept };

  // Followers and grade windows that named a dropped tracker let go of it.
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Rec = {};
    for (const [k, v] of Object.entries(node as Rec)) {
      if (k === "trackBinding" && v && typeof v === "object" && dropped.has(String((v as Rec).trackerId))) out[k] = null;
      else if (k === "windows" && Array.isArray(v))
        out[k] = (v as Rec[])
          .filter((w) => !(((w.source as Rec | undefined)?.type === "tracker" || (w.source as Rec | undefined)?.type === "depth") && dropped.has(String((w.source as Rec).trackerId))))
          .map(walk);
      else out[k] = walk(v);
    }
    return out;
  };
  return { ...(walk({ ...raw, trackers: [] }) as Rec), trackers: kept };
}

/** See step 99 → 100. The three cards whose default flipped, wherever an `effects` list holds them. */
function migrateStillCards100(raw: Record<string, unknown>): Record<string, unknown> {
  const FLIPPED = new Set(["grain", "noise", "roughenEdges"]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] =
        k === "effects" && Array.isArray(v)
          ? v.map((fx) => {
              const card = walk(fx) as Record<string, unknown>;
              return card && FLIPPED.has(String(card.type)) && card.animate === undefined ? { ...card, animate: true } : card;
            })
          : walk(v);
    }
    return out;
  };
  return walk(raw) as Record<string, unknown>;
}

/** See step 96 → 97. */
function migrateBehaviors97(raw: Record<string, unknown>): Record<string, unknown> {
  const Q = String.raw`"((?:[^"\\]|\\.)*)"`;
  const VOICE = String.raw`(?:${Q}|input\(\s*"(?:[^"\\]|\\.)*"\s*\))`;
  const BLINK = new RegExp(String.raw`^if\(blink\(\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)\s*>\s*0\s*,\s*${Q}\s*,\s*(#value|${Q})\s*\)$`);
  const LIP = new RegExp(String.raw`^lipsync\(\s*${VOICE}\s*\)$`);
  const NOD = new RegExp(String.raw`^(?:(-?[\d.]+)\s*\+\s*)?(-?[\d.]+)\s*\*\s*loudness\(\s*${VOICE}\s*\)$`);
  const unq = (s: string | undefined) => (s === undefined ? "" : (JSON.parse(`"${s}"`) as string));
  const expressions = Array.isArray(raw.expressions) ? (raw.expressions as Array<Record<string, unknown>>) : [];
  const sourceOf = new Map(expressions.map((e) => [String(e.id), typeof e.source === "string" ? e.source.trim() : ""]));
  // Who is whose character: the nearest enclosing group with a rig or pose sets.
  const clips = new Map<string, Record<string, unknown>>();
  const parentOf = new Map<string, string | null>();
  if (Array.isArray(raw.tracks))
    for (const t of raw.tracks as Array<Record<string, unknown>>)
      for (const c of (Array.isArray(t.clips) ? t.clips : []) as Array<Record<string, unknown>>) {
        clips.set(String(c.id), c);
        parentOf.set(String(c.id), typeof t.groupId === "string" ? t.groupId : null);
      }
  const isCharacter = (c: Record<string, unknown> | undefined) => c?.kind === "group" && (!!c.rig || (Array.isArray(c.poses) && c.poses.length > 0));
  const characterOf = (id: string): string | null => {
    const seen = new Set<string>();
    for (let at: string | null = id; at && !seen.has(at); at = parentOf.get(at) ?? null) {
      seen.add(at);
      if (isCharacter(clips.get(at))) return at;
    }
    return null;
  };
  const added = new Map<string, Array<Record<string, unknown>>>();
  const push = (characterId: string, b: Record<string, unknown>) => {
    const list = added.get(characterId) ?? [];
    list.push({ id: `bhv_${characterId.replace(/[^a-z0-9]/gi, "").slice(-10)}${list.length}${String(b.type).slice(0, 3)}`, enabled: true, ...b });
    added.set(characterId, list);
  };
  const dropped = new Set<string>();
  const unbind = (clip: Record<string, unknown>, path: string, id: string) => {
    const drivers = { ...(clip.drivers as Record<string, unknown>) };
    delete drivers[path];
    clip.drivers = Object.keys(drivers).length ? drivers : undefined;
    dropped.add(id);
  };
  for (const clip of clips.values()) {
    const drivers = clip.drivers as Record<string, unknown> | undefined;
    for (const [path, token] of Object.entries(drivers ?? {})) {
      const id = typeof token === "string" && token.startsWith("fx:") ? token.slice(3) : null;
      const src = id ? sourceOf.get(id) : undefined;
      if (!id || !src) continue;
      const set = path.startsWith("pose.") && clip.kind === "group" && Array.isArray(clip.poses) ? (clip.poses as Array<Record<string, unknown>>).find((s) => `pose.${s.id}` === path) : undefined;
      if (set) {
        const blink = BLINK.exec(src);
        if (blink) {
          const keyed = Array.isArray(clip.keyframes) && (clip.keyframes as Array<Record<string, unknown>>).some((k) => k.property === path && Array.isArray(k.keys) && k.keys.length > 0);
          if (blink[4] !== "#value" && !keyed) set.show = unq(blink[5]);
          push(String(clip.id), { type: "blink", set: set.id, closed: unq(blink[3]), half: "", every: Number(blink[1]), length: blink[2] ? Math.round(Number(blink[2]) * 1000) : 120, variance: 40, doubles: 17, seed: 0 });
          unbind(clip, path, id);
          continue;
        }
        const lip = LIP.exec(src);
        if (lip) {
          push(String(clip.id), { type: "lipSync", set: set.id, voice: unq(lip[1]), rest: "", lead: 0, pausesShowKeys: false });
          unbind(clip, path, id);
        }
        continue;
      }
      if (path === "rotation") {
        const nod = NOD.exec(src);
        const owner = nod ? characterOf(String(clip.id)) : null;
        if (nod && owner) {
          const base = Number(nod[1] ?? 0);
          const transform = clip.transform as Record<string, unknown> | undefined;
          if (transform && typeof transform.rotation === "number" && base) transform.rotation = base;
          push(owner, { type: "nod", layer: owner === clip.id ? "" : clip.id, channel: "rotation", voice: unq(nod[3]), amount: Number(nod[2]) });
          unbind(clip, path, id);
        }
      }
    }
    const mods = clip.modulators as Array<Record<string, unknown>> | undefined;
    const breathe = mods?.find((m) => m.id === "alive-breathe");
    const owner = breathe ? characterOf(String(clip.id)) : null;
    if (breathe && owner) {
      const amount = Math.round(Number(breathe.amount ?? 0.006) * 2 * 1000) / 10;
      const rate = Math.round(Number(breathe.rate ?? 1 / 3.6) * 60 * 10) / 10;
      push(owner, { type: "breathe", layer: owner === clip.id ? "" : clip.id, channel: "scaleY", amount, rate, phase: 0, keepBottom: true });
      clip.modulators = mods!.filter((m) => m.id !== "alive-breathe" && m.id !== "alive-breathe-y");
      if (!(clip.modulators as unknown[]).length) delete clip.modulators;
    }
  }
  if (!added.size) return { ...raw, version: 97 };
  for (const [id, list] of added) {
    const g = clips.get(id)!;
    g.behaviors = [...((g.behaviors as unknown[]) ?? []), ...list];
  }
  // An expression goes only when no driver anywhere still names it.
  const still = new Set<string>();
  for (const c of clips.values()) for (const token of Object.values((c.drivers as Record<string, unknown>) ?? {})) if (typeof token === "string" && token.startsWith("fx:")) still.add(token.slice(3));
  return { ...raw, expressions: expressions.filter((e) => !dropped.has(String(e.id)) || still.has(String(e.id))), version: 97 };
}

/** See step 95 → 96. */
function migrateRidingBlink96(raw: Record<string, unknown>): Record<string, unknown> {
  const BLINK = /^if\(blink\(([\d.]+)\) > 0, ("(?:[^"\\]|\\.)*"), "((?:[^"\\]|\\.)*)"\)$/;
  const expressions = Array.isArray(raw.expressions) ? (raw.expressions as Array<Record<string, unknown>>) : [];
  const rides = new Map<string, { source: string; open: string }>();
  for (const e of expressions) {
    const m = typeof e.source === "string" ? BLINK.exec(e.source.trim()) : null;
    if (m) rides.set(String(e.id), { source: `if(blink(${m[1]}) > 0, ${m[2]}, #value)`, open: m[3]! });
  }
  if (!rides.size) return { ...raw, version: 96 };
  const binds = new Map<string, number>();
  const safe = new Map<string, boolean>();
  mapClips(raw.tracks, (clip) => {
    const drivers = clip.drivers as Record<string, unknown> | undefined;
    for (const [path, token] of Object.entries(drivers ?? {})) {
      const id = typeof token === "string" && token.startsWith("fx:") ? token.slice(3) : null;
      const ride = id ? rides.get(id) : undefined;
      if (!id || !ride) continue;
      binds.set(id, (binds.get(id) ?? 0) + 1);
      const keyed = Array.isArray(clip.keyframes) && (clip.keyframes as Array<Record<string, unknown>>).some((k) => k.property === path && Array.isArray(k.keys) && k.keys.length > 0);
      const set = path.startsWith("pose.") && Array.isArray(clip.poses) ? (clip.poses as Array<Record<string, unknown>>).find((s) => `pose.${s.id}` === path) : undefined;
      const sw = path === "switch" && clip.switch && typeof clip.switch === "object" ? (clip.switch as Record<string, unknown>) : undefined;
      const ok = !keyed && (!!set || !!sw);
      safe.set(id, (safe.get(id) ?? true) && ok);
    }
    return clip;
  });
  // Only an expression every binding of which can ride is rewritten (one source, many fields).
  const rewrite = new Set([...rides.keys()].filter((id) => (binds.get(id) ?? 0) > 0 && safe.get(id)));
  if (!rewrite.size) return { ...raw, version: 96 };
  for (const e of expressions) if (rewrite.has(String(e.id))) e.source = rides.get(String(e.id))!.source;
  // The base takes the old open name, for exactly the expressions that changed.
  mapClips(raw.tracks, (clip) => {
    for (const [path, token] of Object.entries((clip.drivers as Record<string, unknown> | undefined) ?? {})) {
      const id = typeof token === "string" && token.startsWith("fx:") ? token.slice(3) : null;
      if (!id || !rewrite.has(id)) continue;
      const set = path.startsWith("pose.") && Array.isArray(clip.poses) ? (clip.poses as Array<Record<string, unknown>>).find((s) => `pose.${s.id}` === path) : undefined;
      const sw = path === "switch" ? (clip.switch as Record<string, unknown> | undefined) : undefined;
      if (set ?? sw) (set ?? sw)!.show = rides.get(id)!.open;
    }
    return clip;
  });
  return { ...raw, version: 96 };
}

/**
 * v87 → v88. A drawing was a flipbook cell's still with a paint workspace; a
 * static frame is that, plus a promise — it shows ONE instant. An old drawing
 * becomes static only when its content provably cannot change over time
 * (`contentVariesInTime`, asked of the typed document); one whose layers move,
 * boil or appear mid-hold becomes a timeline cell, so it renders exactly as it
 * did. If the document cannot be read typed here, every drawing becomes a
 * timeline — the answer that can never change a picture.
 */
function migrateFrameModes88(raw: Record<string, unknown>): Record<string, unknown> {
  const frames = Array.isArray(raw.frames) ? (raw.frames as Array<Record<string, unknown>>) : [];
  const modeOf = (role: unknown) => (role === "flipbook" ? "flipbook" : role === "drawing" ? "static" : "timeline");
  const next: Array<Record<string, unknown>> = frames.map(({ role, ...f }) => ({ ...f, mode: modeOf(role), ...(role === "drawing" ? { stillMs: 0 } : {}) }));
  const drawings = new Set(frames.filter((f) => f.role === "drawing").map((f) => f.id as string));
  if (drawings.size > 0) {
    const typed = documentSchema.safeParse({ ...raw, frames: next, version: 88 });
    for (const f of next) {
      if (!drawings.has(f.id as string)) continue;
      const moves = !typed.success || contentVariesInTime(typed.data, f.id as string);
      if (moves) {
        f.mode = "timeline";
        delete f.stillMs;
      }
    }
  }
  return { ...raw, frames: next, version: 88 };
}

/** A stroke card or preset patch written before v85: `position` → `placement`. */
export function legacyStrokePatch<T extends Record<string, unknown>>(fx: T): T {
  if (!("position" in fx) || "placement" in fx) return fx;
  const { position, ...rest } = fx;
  return { ...rest, placement: position } as unknown as T;
}

/** v86→v87: a film-damage card that slipped keeps slipping (`splices: true`). */
function mapFilmDamage86(tracks: unknown): unknown {
  if (!Array.isArray(tracks)) return tracks;
  const visit = (clip: Record<string, unknown>): Record<string, unknown> => {
    if (!Array.isArray(clip.effects)) return clip;
    const keyed = new Set(
      (Array.isArray(clip.keyframes) ? (clip.keyframes as Array<Record<string, unknown>>) : []).map((t) => String(t.property)),
    );
    let touched = false;
    const effects = (clip.effects as Array<Record<string, unknown>>).map((fx) => {
      if (fx.type !== "filmDamage" || "splices" in fx) return fx;
      const slipped = Number(fx.jump ?? 0) > 0 || keyed.has(`lfx.${String(fx.id)}.jump`);
      touched = true;
      return { ...fx, splices: slipped };
    });
    return touched ? { ...clip, effects } : clip;
  };
  return tracks.map((t: Record<string, unknown>) =>
    Array.isArray(t.clips) ? { ...t, clips: (t.clips as Array<Record<string, unknown>>).map(visit) } : t,
  );
}

/** v84→v85: stroke `position` → `placement` (with its tracks); un-idle old default shines. */
function mapLayerEffects84(tracks: unknown): unknown {
  if (!Array.isArray(tracks)) return tracks;
  const visit = (clip: Record<string, unknown>): Record<string, unknown> => {
    if (!Array.isArray(clip.effects)) return clip;
    const keyframes = Array.isArray(clip.keyframes) ? (clip.keyframes as Array<Record<string, unknown>>) : [];
    const keyed = new Set(keyframes.map((t) => String(t.property)));
    const strokeIds = new Set<string>();
    const effects = (clip.effects as Array<Record<string, unknown>>).map((fx) => {
      if (fx.type === "stroke") {
        strokeIds.add(String(fx.id));
        return legacyStrokePatch(fx);
      }
      if (fx.type === "shine" && fx.position === 0.5 && Number(fx.duration ?? 1.6) > 0 && !keyed.has(`lfx.${String(fx.id)}.position`)) {
        return { ...fx, position: 0 };
      }
      return fx;
    });
    const renamed = strokeIds.size
      ? keyframes.map((t) => {
          const m = /^lfx\.([^.]+)\.position$/.exec(String(t.property));
          return m && strokeIds.has(m[1]!) ? { ...t, property: `lfx.${m[1]}.placement` } : t;
        })
      : keyframes;
    return { ...clip, effects, ...(Array.isArray(clip.keyframes) ? { keyframes: renamed } : {}) };
  };
  return tracks.map((t: Record<string, unknown>) =>
    Array.isArray(t.clips) ? { ...t, clips: (t.clips as Array<Record<string, unknown>>).map(visit) } : t,
  );
}

/** v82→v83: freeze every number slot of keyed content as "cuts at the key". */
function mapTextClips82(tracks: unknown): unknown {
  if (!Array.isArray(tracks)) return tracks;
  const visit = (clip: Record<string, unknown>): Record<string, unknown> => {
    if (clip.kind !== "text") return clip;
    const keyframes = Array.isArray(clip.keyframes) ? (clip.keyframes as Array<Record<string, unknown>>) : [];
    const track = keyframes.find((t) => t.property === "text" && !t.range);
    const keys = Array.isArray(track?.keys) ? (track!.keys as Array<{ value?: unknown }>) : [];
    const texts = keys.map((k) => k.value).filter((v): v is string => typeof v === "string");
    if (texts.length < 2) return clip;
    const slots = countUpObjects(texts).length;
    return { ...clip, countUps: Array.from({ length: slots }, (_, slot) => ({ slot, enabled: false, easing: null })) };
  };
  return tracks.map((t: Record<string, unknown>) =>
    Array.isArray(t.clips) ? { ...t, clips: (t.clips as Array<Record<string, unknown>>).map(visit) } : t,
  );
}


/** One migrated group row as a v66 group CLIP. Written out in full rather than
 *  leaning on zod defaults: a migration that only half-populates a new clip
 *  kind fails validation on the documents that need it most. */
function groupClip66(
  id: string,
  row: Record<string, unknown>,
  at: { frameId: string; startMs: number; endMs: number },
): Record<string, unknown> {
  return {
    id,
    kind: "group",
    name: String(row.name ?? "Group"),
    mode: typeof row.mode === "string" ? row.mode : "pass",
    frameId: at.frameId,
    groupId: (row.parentId as string | null) ?? null,
    startMs: at.startMs,
    durationMs: Math.max(1, at.endMs - at.startMs),
    keyframes: [],
    linkGroupId: null,
    fillDuration: false,
    locked: false,
    hidden: false,
    mirrorId: null,
    audioMix: { volume: 1, muted: false },
    motionBlur: { enabled: true, override: null },
    audioEffects: [],
    sounds: [],
    transform: { x: 0, y: 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, anchor: { x: 0.5, y: 0.5 } },
    fills: [],
    strokes: [],
    maxWidth: null,
    effects: [],
    opacity: 1,
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    blendMode: "normal",
    isStencil: false,
    animIn: null,
    animOut: null,
    trackBinding: null,
  };
}

/** Apply `fn` to every raw clip in every track, in place. Migrations that touch
 *  clips all wrote this loop by hand; it is one function now. */
function mapClips(tracks: unknown, fn: (clip: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (!Array.isArray(tracks)) return tracks;
  for (const track of tracks) {
    const clips = (track as { clips?: unknown }).clips;
    if (!Array.isArray(clips)) continue;
    for (let i = 0; i < clips.length; i++) clips[i] = fn(clips[i] as Record<string, unknown>);
  }
  return tracks;
}

const TRIM_FIELDS = ["trim.start", "trim.end", "trim.offset"] as const;

/** Drop the clip-level trim tracks the v57 migration has re-addressed. */
function stripTrimTracks(clip: Record<string, unknown>): void {
  if (!Array.isArray(clip.keyframes)) return;
  clip.keyframes = (clip.keyframes as Array<Record<string, unknown>>).filter(
    (t) => !TRIM_FIELDS.some((f) => t.property === f),
  );
}

/**
 * The v49 migration's own outline-bounds reader. Deliberately NOT `pathBox`
 * from core: migrations run on RAW json that has not been through zod yet, and
 * a shared helper typed on the parsed schema would either lie about that or
 * quietly drag the whole vector module into the parser's hot path. It counts
 * bezier handles exactly as `subpathBounds` does, so the box it reports is the
 * one the running app will resolve the migrated pivot against.
 */
function legacyPathBox(
  subpaths: unknown,
): { width: number; height: number; cx: number; cy: number } | null {
  if (!Array.isArray(subpaths)) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sub of subpaths) {
    for (const pt of (sub as { points?: Array<Record<string, unknown>> })?.points ?? []) {
      const pts = [pt, pt.hIn, pt.hOut].filter(
        (q): q is { x: number; y: number } =>
          !!q && typeof (q as { x?: unknown }).x === "number" && typeof (q as { y?: unknown }).y === "number",
      );
      for (const q of pts) {
        minX = Math.min(minX, q.x);
        minY = Math.min(minY, q.y);
        maxX = Math.max(maxX, q.x);
        maxY = Math.max(maxY, q.y);
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { width: maxX - minX, height: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** Old `angleDeg`/`cx`/`cy`/`r` → the unified `start`/`end` handle points. */
function migrateGradientPaint(paint: Record<string, unknown>): void {
  if (!paint || typeof paint !== "object") return;
  if (paint.type === "linear" && typeof paint.angleDeg === "number") {
    const rad = (paint.angleDeg * Math.PI) / 180;
    const dx = Math.cos(rad) / 2;
    const dy = Math.sin(rad) / 2;
    paint.start = { x: 0.5 - dx, y: 0.5 - dy };
    paint.end = { x: 0.5 + dx, y: 0.5 + dy };
  } else if (paint.type === "radial") {
    const cx = typeof paint.cx === "number" ? paint.cx : 0.5;
    const cy = typeof paint.cy === "number" ? paint.cy : 0.5;
    const r = typeof paint.r === "number" ? paint.r : 0.5;
    paint.start = { x: cx, y: cy };
    paint.end = { x: cx + r, y: cy };
  }
  delete paint.angleDeg;
  delete paint.cx;
  delete paint.cy;
  delete paint.r;
}

/** Migrate every fill/stroke gradient on a raw clip. */
function migrateClipGradients(clip: Record<string, unknown>): void {
  if (Array.isArray(clip.fills)) for (const f of clip.fills) migrateGradientPaint(f as Record<string, unknown>);
  if (Array.isArray(clip.strokes)) {
    for (const s of clip.strokes) {
      const paint = (s as { paint?: unknown }).paint;
      if (paint) migrateGradientPaint(paint as Record<string, unknown>);
    }
  }
}

/** Fold a style's legacy single shadow/stroke into the effect stack. */
function styleToEffects(style: Record<string, unknown>): void {
  const effects: Array<Record<string, unknown>> = Array.isArray(style.effects) ? style.effects : [];
  const shadow = style.shadow as { color: string; x: number; y: number; blur: number } | null | undefined;
  if (shadow) effects.push({ id: createId("fx"), type: "shadow", enabled: true, ...shadow });
  const stroke = style.stroke as { color: string; width: number } | null | undefined;
  if (stroke) effects.push({ id: createId("fx"), type: "stroke", enabled: true, ...stroke });
  delete style.shadow;
  delete style.stroke;
  style.effects = effects;
}

/** Walk every style-bearing object in the tracks and migrate its effects. */
function migrateEffects4to5(tracks: unknown): unknown {
  if (!Array.isArray(tracks)) return tracks;
  for (const track of tracks) {
    const clips = (track as { clips?: unknown }).clips;
    if (!Array.isArray(clips)) continue;
    for (const clip of clips) {
      const c = clip as Record<string, unknown>;
      if (c.style && typeof c.style === "object") styleToEffects(c.style as Record<string, unknown>);
      if (Array.isArray(c.ranges)) {
        for (const r of c.ranges) {
          const rr = r as { style?: unknown };
          if (rr.style && typeof rr.style === "object") styleToEffects(rr.style as Record<string, unknown>);
        }
      }
      if (c.highlightStyle && typeof c.highlightStyle === "object") {
        styleToEffects(c.highlightStyle as Record<string, unknown>);
      }
    }
  }
  return tracks;
}

/**
 * Read a document file. `ns` is the reading product's namespace: the one
 * migration that mints a vendor-stamped id (v79 → v80, identity.ts) mints it
 * as theirs, and refuses rather than guess when no namespace was given. An
 * app always passes it; a document of this version never needs it.
 */
export function parseDocument(json: string, ns?: string): MotionDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new DocumentParseError("File is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new DocumentParseError("This file isn't a project.");
  }

  let data = raw as Record<string, unknown>;
  let version = typeof data.version === "number" ? data.version : 0;
  if (version > DOCUMENT_VERSION) {
    throw new DocumentParseError(
      `This file was made with a newer version (v${version}). Update the app to open it.`,
    );
  }
  while (version < DOCUMENT_VERSION) {
    const migrate = migrations[version];
    if (!migrate) throw new DocumentParseError(`No migration path from document version ${version}.`);
    data = migrate(data, {
      ns: () => {
        if (!ns) throw new DocumentParseError(`Upgrading a v${version} document needs the reading app's namespace.`);
        return ns;
      },
    });
    version = data.version as number;
  }

  const result = documentSchema.safeParse(data);
  if (!result.success) {
    throw new DocumentParseError("Document failed validation.", result.error.issues);
  }
  dedupeVectorIds(result.data);
  seedMediaFills(result.data);
  // Belt-and-braces for documents that skipped the v43 migration path (in-memory
  // docs, merges, templates): the internal shelf is idempotent to adopt.
  adoptInternalFrames(result.data);
  // Expressions are anonymous rows a field points at, so a deleted clip or a
  // detached field can orphan one. Sweeping on load means a document heals
  // itself on the next open instead of carrying dead text forever.
  pruneExpressions(result.data);
  return result.data;
}

/**
 * Heal pre-v42 documents: an image/video clip's footage is now its bottom fill
 * (a `media` paint sourced from the clip itself), so it reads as a Figma image
 * fill you can restyle/overlay. Clips saved before that carry no such fill —
 * seed one so old projects adopt the model transparently. Runs on every load
 * (idempotent: a clip that already has a `self` fill is left untouched).
 */
function seedMediaFills(doc: MotionDocument): void {
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "image" && clip.kind !== "video") continue;
      const hasSelf = clip.fills.some((f) => f.type === "media" && f.source.type === "self");
      if (!hasSelf) clip.fills.unshift(mediaPaint({ type: "self" }));
    }
  }
}

/** Reissue any repeat id in a list in place (first occurrence keeps the id). */
function dedupeIds<T extends { id: string }>(list: T[], prefix: string): void {
  const seen = new Set<string>();
  for (const entry of list) {
    if (seen.has(entry.id)) entry.id = createId(prefix);
    seen.add(entry.id);
  }
}

/**
 * Guarantee every vector clip's fill/stroke entries (and each gradient's stops)
 * carry a UNIQUE id within their list. A duplicate id — a hazard left by older
 * in-progress documents — breaks React keys, dnd-kit reordering, and the whole
 * id-addressed keyframe system at once. We reissue the repeat entry in place;
 * its keyframes (addressed by the shared id) stay bound to the first entry,
 * which is the only unambiguous reading, and the duplicate simply starts clean.
 */
function dedupeVectorIds(doc: MotionDocument): void {
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      // Contour ids have to be unique before anything addresses them, and a
      // document can arrive half-formed from a merge, a template, a plugin or a
      // hand-edited file — not only from a migration.
      if (clip.kind === "path") healContourIds(clip);
      if (clip.kind !== "shape" && clip.kind !== "path") continue;
      dedupeIds(clip.fills, "paint");
      dedupeIds(clip.strokes, "stroke");
      for (const fill of clip.fills) if (isGradientPaint(fill)) dedupeIds(fill.stops, "stop");
      for (const stroke of clip.strokes) {
        if (isGradientPaint(stroke.paint)) dedupeIds(stroke.paint.stops, "stop");
      }
    }
  }
}
