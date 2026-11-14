"use client";

import { characterOf, isBodyKind, isSpatialClip, mediaAssetOf, type CameraClip, type LightClip, type MeshClip, type PathClip } from "@solomotion/core";
import { SoundAnalysisSection } from "../audio/SoundAnalysisSection";
import {
  CameraSection,
  DepthOfFieldSection,
  ConstraintsSection,
  GeometrySection,
  LightSection,
  LinesSection,
  MaterialSection,
  PartsSection,
  Transform3dSection,
  isWorldClip,
  ThicknessSection,
  LineArtSection,
  LatticeSection,
  ControllerSection,
  TextureSection,
} from "./World3dSections";
import { ModifierStackSection } from "./ModifierStackSection";
import * as React from "react";
import {
  clipProvenance,
  isAdjustmentClip as isProcessor,
  isVisualClip,
  nestedIsAudioOnly,
  type MotionDocument,
  type Clip,
  isLayoutMember,
  isPathText,
  type GroupClip,
  type ScopeAddress,
  type TextClip,
  type VisualClip,
  type EmptyClip,
} from "@solomotion/core";
import { inStill, type InspectorTab } from "./shared-inspector";
import { AlignSection } from "./AlignSection";
import { CombineSection } from "./CombineSection";
import { AdjustmentInspector } from "./AdjustmentInspector";
import { CaptionCues } from "./CaptionCues";
import { ExportSection } from "../export/ExportSection";
import { FillSection, StrokeSection } from "./PaintList";
import { LayerEffectsSection } from "./LayerEffectsSection";
import { MediaInspector, PlaybackSection } from "./MediaInspector";
import { MotionBlurSection } from "./MotionBlurSection";
import { LinkSection } from "../links/LinkEditor";
import { FollowSection, FootageTrackers } from "../tracking/TrackPanel";
import { TextPathSection } from "./TextPathSection";
import { AutoLayoutSection, LayoutItemSection } from "./AutoLayoutSection";
import { NestedInspector } from "./NestedInspector";
import { SelectionColorsSection } from "./SelectionColors";
import { SoundOutputSection, SoundVoicesSection, SoundEmptyNote } from "./SoundSections";
import { SoundMixSection } from "./mix/SoundMixSection";
import { SoundStackSection } from "./SoundStack";
import { AudioEffectsSection, clipCarriesAudioEffects } from "./audio-effects/AudioEffectsSection";
import { PanelSection } from "./controls";
import { ScopeOverridesSection, ScopeTabs } from "./ScopeBar";
import { TextInspector } from "./TextInspector";
import { TextEffectsForScope } from "./TextEffectsSection";
import { ComponentSection } from "./ComponentSection";
import { SelectionScope } from "./selection-scope";
import { TransformSection } from "./TransformSection";
import { AppearanceSection } from "./LayerComposite";
import { VectorInspector } from "./VectorInspector";
import { WaveformInspector } from "./WaveformInspector";
import { TraceInspector } from "./TraceInspector";
import { LayerAnimateSection } from "./LayerAnimate";
import { TimingSection } from "./TimingSection";
import { SourceSection } from "./SourceSection";
import { BodySection, EmitterStackSection, ForceStackSection, JointsSection, SimulationSection } from "../physics/lazy";
import { FollowsSection, RigSections, SwitchSection, followsBones } from "../rig/RigSections";
import { lazyComponent } from "@/editor/lazy-component";

/**
 * THE SIDEBAR SPINE.
 *
 * Every layer's inspector used to be one long `&&` ladder in Inspector.tsx —
 * twenty conditions deciding, per kind, what to render and in what order. Which
 * meant the order WAS the ladder: a shape's panel and a text's panel agreed
 * about Transform only because two lines happened to sit in the same place, and
 * a new kind meant reading all twenty to find where it belonged.
 *
 * A section is a value now, and the spine is three slots:
 *
 *      head    what EVERY layer has and you reach for constantly
 *              (align · transform · appearance)
 *      kind    what makes THIS layer what it is — the reason you selected it
 *      tail    what every layer has and you reach for occasionally
 *              (fill · stroke · motion blur · timing · export)
 *
 * The shape of that is deliberate. Opening a text layer should show you TEXT
 * before it shows you a fifth copy of X/Y, and the common frame around it
 * should sit in the same two places on every kind so your eye stops hunting.
 * Transform is collapsed by default for the same reason: it is the section you
 * most often want present and least often want open.
 *
 * Adding a kind is `applies` + `render`, in one array, in one file. Nothing
 * switches on `clip.kind` outside a section's own `applies`.
 *
 * ONE PANEL FOR ANY SELECTION. A section renders against the primary clip and
 * the `SelectionScope` around the spine makes it edit, and show, all of them
 * (see `selection-scope.tsx`). So `applies` asks "does EVERY selected layer
 * have this?" — `all(...)` — and a selection of three rectangles gets the
 * rectangle's panel, fields and all, with "Mixed" where they differ. The few
 * sections that are about one layer by nature (a tracker, a cue list, a text
 * selection) say `one` and give their reason.
 */

/** The Face pad is its own chunk: thumbnails, menus and pose ops load when a character is selected. */
const FacePad = lazyComponent("FacePad", () => import("../character/FacePad").then((m) => ({ default: m.FacePad })));
const VoiceSection = lazyComponent("VoiceSection", () => import("../speech/VoiceSection").then((m) => ({ default: m.VoiceSection })));
const BehaviorsSection = lazyComponent("BehaviorsSection", () => import("../character/BehaviorsSection").then((m) => ({ default: m.BehaviorsSection })));
/** Shape keys: their own chunk, loaded when a path or mesh is selected. */
const ShapeKeysSection = lazyComponent("ShapeKeysSection", () => import("../shape-keys/ShapeKeysSection").then((m) => ({ default: m.ShapeKeysSection })));

/** Where each part of the Character tab sits (`order` within slot "kind"). Others mount at their number. */
export const CHARACTER_SECTION_ORDER = { face: 10, voice: 20, behaviors: 30, rig: 90 } as const;

export interface SectionCtx {
  /** The whole selection. One clip is a selection of one — no second path. */
  clips: Clip[];
  /** The primary (last-picked) clip: what a single-subject section edits. */
  clip: Clip;
  doc: MotionDocument;
  tab: InspectorTab;
  multi: boolean;
  visual: VisualClip[];
  /** Every tab this selection offers, in order — `home` is the first. */
  tabs: InspectorTab[];
}

export type SectionSlot = "head" | "kind" | "tail";

/**
 * Which tab a section belongs to. `"home"` means the layer's FIRST available
 * tab — Design for anything visual, Sound for an audio clip. Timing and Export
 * are the reason it exists: they belong to the layer, not to a tab, and pinning
 * them to Design made them vanish for a kind that has no Design tab. That is a
 * property of the SELECTION, so the registry resolves it rather than every
 * section re-deriving "am I home?".
 */
export type SectionTab = InspectorTab | "home";

export interface InspectorSectionDef {
  /** Stable id — also the section's ANCHOR and its open-state memory cell. */
  id: string;
  slot: SectionSlot;
  tab: SectionTab;
  /** Rank within the slot. Sparse, so a new section fits between two. */
  order: number;
  /**
   * TRUE when this section edits the SCOPE rather than the layer — the words
   * being spoken, the ones still to come, a text selection, a vector contour.
   *
   * This is the third fact about a section, beside where it sits and in which
   * tab, and it buys the one layout law the whole sidebar now obeys:
   *
   *     shared sections  ·  THE SCOPE TABS  ·  scoped sections
   *
   * The strip is not placed by any panel. `LayerSections` drops it at the
   * boundary this flag describes, in every tab, so Design, Effects, Animate
   * and Sound are laid out by one rule instead of four agreements. What the
   * tabs mean is therefore always the same: everything above is true of the
   * layer whatever you pick; everything below changes when you pick.
   *
   * Absent means shared, because most sections are.
   */
  scoped?: boolean;
  /**
   * WHICH scopes this section means anything for. Omitted = every scope the
   * layer offers.
   *
   * This is what stops the strip being a prank. A caption state has no SOUNDS
   * — "tick on every word as it highlights" is a question about when a voice
   * fires, which the slot table owns — so offering Unread / Focus / Read in
   * the Sound tab would hand someone three buttons that reveal an empty panel.
   * The strip offers the union of what its region's sections actually claim,
   * and renders nothing at all when that union is empty, so a chip you can
   * press is always a chip with something behind it.
   */
  scopes?: ReadonlyArray<ScopeAddress["kind"]>;
  applies: (ctx: SectionCtx) => boolean;
  render: (ctx: SectionCtx) => React.ReactNode;
}

const one = (ctx: SectionCtx) => !ctx.multi;
const many = (ctx: SectionCtx) => ctx.multi;
/** Every selected layer passes — the gate for a section that edits them all. */
const all = (test: (c: Clip) => boolean) => (ctx: SectionCtx) => ctx.clips.every(test);
const visual = all(isVisualClip);
const allText = all((c) => c.kind === "text");
/** Every selected layer lives on a clock — false for a layer in a still. */
const timed = (ctx: SectionCtx) => !ctx.clips.some((c) => inStill(ctx.doc, c));
const kindIs =
  (...kinds: Clip["kind"][]) =>
  (c: Clip) =>
    kinds.includes(c.kind);

/** Every selected layer stands in a 3D world. */
const inWorld = (ctx: SectionCtx) => ctx.clips.every((c) => isWorldClip(ctx.doc, c));
const oneOf =
  <K extends Clip["kind"]>(kind: K) =>
  (ctx: SectionCtx) =>
    one(ctx) && ctx.clip.kind === kind;
/** One mesh that is a surface — not a lattice cage, which is a guide with no look of its own. */
const surfaceMesh = (ctx: SectionCtx) => oneOf("mesh")(ctx) && !(ctx.clip as MeshClip).lattice;
/** One lattice cage. */
const cage = (ctx: SectionCtx) => oneOf("mesh")(ctx) && !!(ctx.clip as MeshClip).lattice;

/**
 * Sections that only mean something on the FLAT canvas — 2D alignment, the 2D
 * transform box, booleans, tracking, auto layout. In a world the 3D sections
 * stand in for them; listing both would hand people two Transform panels that
 * disagree about what Y means.
 */
const FLAT_ONLY = new Set(["align", "transform", "motion-track", "text-path", "auto-layout", "layout-item", "motion-blur"]);
/** And those a 3D-native object (mesh, camera, light) has no use for. A mesh's
 *  strokes ARE used — they draw its edges (see `LinesSection`). */
const NOT_ON_SPATIAL = new Set(["appearance", "colors", "effects"]);

export const LAYER_SECTIONS: InspectorSectionDef[] = [
  // ── 3D (v89): a world object shows its own properties, Blender's way ──────
  {
    id: "transform-3d",
    slot: "head",
    tab: "design",
    order: 20,
    applies: (ctx) => visual(ctx) && inWorld(ctx),
    render: (ctx) => <Transform3dSection clips={ctx.visual} />,
  },
  {
    id: "camera",
    slot: "kind",
    tab: "design",
    order: 40,
    applies: oneOf("camera"),
    render: (ctx) => <CameraSection clip={ctx.clip as CameraClip} doc={ctx.doc} />,
  },
  {
    id: "camera-dof",
    slot: "kind",
    tab: "design",
    order: 40.5,
    applies: oneOf("camera"),
    render: (ctx) => <DepthOfFieldSection clip={ctx.clip as CameraClip} doc={ctx.doc} />,
  },
  {
    id: "light",
    slot: "kind",
    tab: "design",
    order: 40,
    applies: oneOf("light"),
    render: (ctx) => <LightSection clip={ctx.clip as LightClip} />,
  },
  {
    id: "geometry",
    slot: "kind",
    tab: "design",
    order: 40,
    applies: surfaceMesh,
    render: (ctx) => <GeometrySection clip={ctx.clip as MeshClip} />,
  },
  {
    id: "lattice",
    slot: "kind",
    tab: "design",
    order: 40,
    applies: cage,
    render: (ctx) => <LatticeSection clip={ctx.clip as MeshClip} doc={ctx.doc} />,
  },
  {
    id: "material",
    slot: "kind",
    tab: "design",
    order: 42,
    // A mesh's, or any 2D layer's in a world — one surface model for both.
    applies: (ctx) => ctx.clips.length > 0 && inWorld(ctx) && (surfaceMesh(ctx) || ctx.clips.every((c) => isBodyKind(c.kind))),
    render: (ctx) => <MaterialSection clips={ctx.visual} />,
  },
  {
    id: "parts",
    slot: "kind",
    tab: "design",
    order: 43,
    applies: surfaceMesh,
    render: (ctx) => <PartsSection clip={ctx.clip as MeshClip} />,
  },
  {
    // Geometry passes, under the picture passes — the way glyph effects sit
    // under layer effects on a text. Same card stack, a different domain.
    id: "modifiers",
    slot: "kind",
    tab: "effects",
    order: 46,
    // Blender's rule: everything in a world has a stack — meshes and 2D layers alike.
    applies: (ctx) => ctx.clips.length > 0 && inWorld(ctx) && ctx.clips.every((c) => c.kind === "mesh" || isBodyKind(c.kind)),
    render: (ctx) => <ModifierStackSection clips={ctx.visual} />,
  },
  {
    id: "lines",
    slot: "tail",
    tab: "design",
    order: 62,
    applies: (ctx) => surfaceMesh(ctx) && ctx.clip.kind === "mesh" && ctx.clip.strokes.length > 0,
    render: (ctx) => <LinesSection clip={ctx.clip as MeshClip} />,
  },
  {
    id: "texture",
    slot: "kind",
    tab: "design",
    order: 42.5,
    applies: surfaceMesh,
    render: (ctx) => <TextureSection clip={ctx.clip as MeshClip} doc={ctx.doc} />,
  },
  // ── physics (v92): a body, its joints, its forces, the comp's simulation ───
  {
    id: "physics-body",
    slot: "kind",
    tab: "physics",
    order: 40,
    applies: (ctx) => visual(ctx) && ctx.clips.every((c) => c.kind !== "adjustment" && c.kind !== "camera" && c.kind !== "light"),
    render: (ctx) => <BodySection clips={ctx.visual} />,
  },
  {
    id: "physics-joints",
    slot: "kind",
    tab: "physics",
    order: 41,
    applies: (ctx) => one(ctx) && visual(ctx) && !!(ctx.clip as VisualClip).physics,
    render: (ctx) => <JointsSection clip={ctx.clip as VisualClip} />,
  },
  {
    id: "physics-forces",
    slot: "kind",
    tab: "physics",
    order: 42,
    applies: (ctx) => visual(ctx) && ctx.clips.every((c) => c.kind !== "adjustment" && c.kind !== "camera" && c.kind !== "light"),
    render: (ctx) => <ForceStackSection clips={ctx.visual} />,
  },
  {
    id: "physics-emitters",
    slot: "kind",
    tab: "physics",
    order: 43,
    applies: (ctx) => visual(ctx) && ctx.clips.every((c) => c.kind !== "adjustment" && c.kind !== "camera" && c.kind !== "light") && !ctx.doc.frames.find((f) => f.id === ctx.clips[0]!.frameId)?.world,
    render: (ctx) => <EmitterStackSection clips={ctx.visual} />,
  },
  {
    id: "physics-sim",
    slot: "tail",
    tab: "physics",
    order: 70,
    applies: (ctx) => ctx.clips.length > 0 && ctx.clips.every((c) => c.frameId === ctx.clips[0]!.frameId) && !!ctx.doc.frames.find((f) => f.id === ctx.clips[0]!.frameId),
    render: (ctx) => <SimulationSection frame={ctx.doc.frames.find((f) => f.id === ctx.clips[0]!.frameId)!} />,
  },
  {
    id: "controller",
    slot: "kind",
    tab: "design",
    order: 40,
    applies: oneOf("empty"),
    render: (ctx) => <ControllerSection clip={ctx.clip as EmptyClip} />,
  },
  {
    id: "solid-depth",
    slot: "kind",
    tab: "design",
    order: 41,
    applies: (ctx) => ctx.clips.length > 0 && inWorld(ctx) && ctx.clips.every((c) => isBodyKind(c.kind)),
    render: (ctx) => <ThicknessSection clips={ctx.visual} />,
  },
  {
    id: "line-art",
    slot: "kind",
    tab: "design",
    order: 41.5,
    applies: (ctx) => ctx.clips.length > 0 && inWorld(ctx) && ctx.clips.every((c) => isBodyKind(c.kind)),
    render: (ctx) => <LineArtSection clips={ctx.visual} />,
  },
  {
    id: "constraints",
    slot: "tail",
    tab: "design",
    order: 58,
    applies: (ctx) => one(ctx) && visual(ctx) && inWorld(ctx),
    render: (ctx) => <ConstraintsSection clip={ctx.visual[0]!} doc={ctx.doc} />,
  },

  // ── head: the frame around every layer ─────────────────────────────────────
  {
    id: "align",
    slot: "head",
    tab: "design",
    order: 10,
    // A processor has no box to align — it spans its comp by definition, so
    // every button in this section is a no-op on one.
    applies: (ctx) => visual(ctx) && !ctx.visual.some(isProcessor),
    render: () => <AlignSection />,
  },
  {
    id: "combine",
    slot: "head",
    tab: "design",
    order: 15,
    // A GROUP is a selection of one now, so the boolean vocabulary has to be
    // reachable from the single-layer panel — it used to be hardcoded into the
    // multi-select branch only, back when you could not select a group at all.
    // The section decides its own eligibility (`selectionCompositeInfo`), so
    // this is just "offer it wherever a layer is selected".
    applies: visual,
    render: () => <CombineSection />,
  },
  {
    id: "text-path",
    slot: "head",
    tab: "design",
    order: 18,
    // Stands in for Transform: a bound text's placement is its host's.
    // One: a bound text's placement is its host path's, and each has its own.
    applies: (ctx) => one(ctx) && isPathText(ctx.clip),
    render: (ctx) => <TextPathSection clip={ctx.clip as TextClip} />,
  },
  // ── THE CHARACTER TAB (ux.md §2.3) — one section per part, top to bottom:
  //    Face 10 · Voice 20 · Life 30 · Rig 90. Voice and Life mount here from their own modules at those orders (slot "kind",
  //    tab "character", `characterOf(ctx.doc, ctx.clip.id)` is the subject).
  {
    id: "face",
    slot: "kind",
    tab: "character",
    order: CHARACTER_SECTION_ORDER.face,
    applies: (ctx) => one(ctx) && !!characterOf(ctx.doc, ctx.clip.id),
    render: (ctx) => (
      <React.Suspense fallback={null}>
        <FacePad character={characterOf(ctx.doc, ctx.clip.id)!} />
      </React.Suspense>
    ),
  },
  {
    id: "voice",
    slot: "kind",
    tab: "character",
    order: CHARACTER_SECTION_ORDER.voice,
    applies: (ctx) => one(ctx) && !!characterOf(ctx.doc, ctx.clip.id),
    render: (ctx) => (
      <React.Suspense fallback={null}>
        <VoiceSection character={characterOf(ctx.doc, ctx.clip.id)!} />
      </React.Suspense>
    ),
  },
  {
    id: "behaviors",
    slot: "kind",
    tab: "character",
    order: CHARACTER_SECTION_ORDER.behaviors,
    applies: (ctx) => one(ctx) && !!characterOf(ctx.doc, ctx.clip.id),
    render: (ctx) => (
      <React.Suspense fallback={null}>
        <BehaviorsSection character={characterOf(ctx.doc, ctx.clip.id)!} />
      </React.Suspense>
    ),
  },
  {
    id: "rig",
    slot: "kind",
    tab: "character",
    order: CHARACTER_SECTION_ORDER.rig,
    applies: (ctx) => one(ctx) && ctx.clip.kind === "group" && !!ctx.clip.rig,
    render: (ctx) => <RigSections clip={ctx.clip as GroupClip} />,
  },
  // ── a switch and how a piece follows its bones stay with the layer (Design) ──
  {
    id: "switch",
    slot: "kind",
    tab: "design",
    order: 38.5,
    applies: (ctx) => one(ctx) && ctx.clip.kind === "group" && !!ctx.clip.switch,
    render: (ctx) => <SwitchSection clip={ctx.clip as GroupClip} />,
  },
  {
    id: "follows",
    slot: "kind",
    tab: "design",
    order: 39,
    applies: (ctx) => one(ctx) && visual(ctx) && followsBones(ctx.doc, ctx.clip),
    render: (ctx) => <FollowsSection clip={ctx.clip} />,
  },
  {
    id: "auto-layout",
    slot: "head",
    tab: "design",
    order: 19,
    applies: (ctx) => one(ctx) && ctx.clip.kind === "group" && ctx.clip.layout !== null,
    render: (ctx) => <AutoLayoutSection clip={ctx.clip as GroupClip} />,
  },
  {
    id: "layout-item",
    slot: "head",
    tab: "design",
    order: 21,
    applies: (ctx) => one(ctx) && visual(ctx) && isLayoutMember(ctx.doc, ctx.clip.id) !== null,
    render: (ctx) => <LayoutItemSection clip={ctx.visual[0]!} />,
  },
  {
    id: "transform",
    slot: "head",
    tab: "design",
    order: 20,
    applies: (ctx) => visual(ctx) && !(one(ctx) && isPathText(ctx.clip)),
    render: (ctx) => <TransformSection clips={ctx.visual} />,
  },
  {
    id: "appearance",
    slot: "head",
    tab: "design",
    order: 30,
    applies: visual,
    render: (ctx) => <AppearanceSection clips={ctx.visual} />,
  },

  // ── kind: the reason you selected this layer ───────────────────────────────
  {
    id: "text-content",
    slot: "kind",
    tab: "design",
    order: 40,
    // The words, whether they are captioned, how they cross between states,
    // and the box it all sits in. None of that changes with the scope.
    applies: allText,
    render: (ctx) => <TextInspector clip={ctx.clip as TextClip} tab="design-shared" />,
  },
  {
    id: "overrides",
    slot: "kind",
    tab: "design",
    order: 5,
    scoped: true,
    // FIRST thing under the strip: you just said which words you mean, and
    // this says what is already different about them.
    applies: allText,
    render: () => <ScopeOverridesSection />,
  },
  {
    id: "text-style",
    slot: "kind",
    tab: "design",
    order: 40,
    scoped: true,
    applies: allText,
    render: (ctx) => <TextInspector clip={ctx.clip as TextClip} tab="design" />,
  },
  {
    id: "vector",
    slot: "kind",
    tab: "design",
    order: 40,
    applies: all(kindIs("shape", "path")),
    render: (ctx) => <VectorInspector clip={ctx.clip as never} />,
  },
  {
    // Below the outline it morphs (Blender's Shape Keys panel under the mesh data).
    id: "shape-keys",
    slot: "kind",
    tab: "design",
    order: 41.5,
    applies: (ctx) =>
      one(ctx) && (ctx.clip.kind === "path" || (ctx.clip.kind === "mesh" && (ctx.clip.geometry.type === "mesh" || !!ctx.clip.shapeKeys?.length))),
    render: (ctx) => (
      <React.Suspense fallback={null}>
        <ShapeKeysSection clip={ctx.clip as PathClip | MeshClip} />
      </React.Suspense>
    ),
  },
  {
    id: "media",
    slot: "kind",
    tab: "design",
    order: 40,
    applies: all(kindIs("image", "video")),
    render: (ctx) => <MediaInspector clip={ctx.clip as never} />,
  },
  {
    id: "nested",
    slot: "kind",
    tab: "design",
    order: 40,
    applies: all(kindIs("nested")),
    render: (ctx) => <NestedInspector clip={ctx.clip as never} />,
  },
  {
    id: "waveform",
    slot: "kind",
    tab: "design",
    order: 40,
    applies: all(kindIs("waveform")),
    render: (ctx) => <WaveformInspector clip={ctx.clip as never} />,
  },
  {
    id: "trace",
    slot: "kind",
    tab: "design",
    order: 40,
    applies: all(kindIs("trace")),
    render: (ctx) => <TraceInspector clip={ctx.clip as never} />,
  },
  {
    id: "adjustment",
    slot: "kind",
    tab: "design",
    order: 40,
    applies: all(kindIs("adjustment")),
    render: (ctx) => <AdjustmentInspector clip={ctx.clip as never} />,
  },
  // NOTE: an audio clip has no section of its own here. It reaches
  // `AudioInspector` through `sound-voices` — an audio clip IS the voice under
  // itself, so `collectSoundLeaves` returns it and the voices section renders
  // it flush. A second entry drew the whole inspector twice.
  {
    id: "playback",
    slot: "tail",
    tab: "sound",
    order: 55,
    applies: (ctx) => ctx.clips.every((c) => c.kind === "nested" && nestedIsAudioOnly(ctx.doc, c)),
    render: (ctx) => <PlaybackSection clip={ctx.clip} />,
  },

  // ── tail: the frame around every layer, part two ───────────────────────────
  //
  // Paint is common to every visual kind, so it lives HERE rather than being
  // re-rendered inside the text panel and the vector panel — two copies that
  // sat in different places, so switching from a shape to a word moved Fill
  // 300px up the scroll for no reason a person could name.
  {
    id: "fill",
    slot: "tail",
    tab: "design",
    order: 60,
    scoped: true,
    // A selection of paintable layers edits its fills as one list: the
    // entries every layer shares, Mixed where they disagree, every write
    // replayed onto each layer (see `useMultiClipPaintHost`).
    applies: all(isPaintable),
    render: (ctx) => <FillSection clips={ctx.clips as never} />,
  },
  {
    id: "stroke",
    slot: "tail",
    tab: "design",
    order: 61,
    scoped: true,
    applies: all(isPaintable),
    render: (ctx) => <StrokeSection clips={ctx.clips as never} />,
  },
  {
    // Any visible layer can be a link; while typing, the selected run.
    id: "link",
    slot: "tail",
    tab: "design",
    order: 65,
    applies: (ctx) => visual(ctx) && !ctx.visual.some(isProcessor),
    render: () => <LinkSection />,
  },
  {
    id: "motion-blur",
    slot: "tail",
    tab: "design",
    order: 70,
    // The shutter declines processors outright (`paintClipShutter`) — an
    // adjustment has no moving ink to smear, it grades whatever is under it.
    applies: (ctx) => visual(ctx) && timed(ctx) && !ctx.visual.some(isProcessor),
    render: (ctx) => <MotionBlurSection clip={ctx.visual[0]!} />,
  },
  // ── Track ──────────────────────────────────────────────────────────────────
  {
    id: "track-footage",
    slot: "kind",
    tab: "track",
    order: 10,
    // A tracker is drawn on ONE footage layer's own pixels.
    applies: (ctx) => one(ctx) && (ctx.clip.kind === "video" || ctx.clip.kind === "image"),
    render: (ctx) => <FootageTrackers clip={ctx.visual[0]!} />,
  },
  {
    id: "track-follow",
    slot: "kind",
    tab: "track",
    order: 20,
    applies: (ctx) => one(ctx) && visual(ctx) && !ctx.visual.some(isProcessor),
    render: (ctx) => <FollowSection clip={ctx.visual[0]!} />,
  },
  {
    id: "colors",
    slot: "tail",
    tab: "design",
    order: 80,
    applies: (ctx) => visual(ctx) && !ctx.clips.some(isProcessor),
    render: (ctx) => <SelectionColorsSection clipIds={ctx.clips.map((c) => c.id)} />,
  },
  {
    id: "component-multi",
    slot: "tail",
    tab: "design",
    order: 85,
    // Detach any instances in a multi-selection. Creating one lives in the
    // header, beside Duplicate, for every selection.
    applies: many,
    render: (ctx) => <ComponentSection clips={ctx.clips} />,
  },
  {
    id: "timing",
    slot: "tail",
    tab: "home",
    order: 90,
    applies: timed,
    render: (ctx) => <TimingSection clip={ctx.clip} />,
  },
  {
    id: "source",
    slot: "tail",
    tab: "home",
    order: 92,
    // Only a layer that came from somewhere has a source to show — and it is
    // that one layer's history, so it is shown for one.
    applies: (ctx) => one(ctx) && clipProvenance(ctx.doc, ctx.clip) !== null,
    render: (ctx) => <SourceSection clip={ctx.clip} />,
  },
  {
    id: "export",
    slot: "tail",
    tab: "home",
    order: 95,
    applies: () => true,
    render: (ctx) => <ExportSection clipIds={ctx.clips.map((c) => c.id)} />,
  },

  // ── the other tabs ─────────────────────────────────────────────────────────
  {
    id: "effects",
    slot: "kind",
    tab: "effects",
    order: 40,
    applies: visual,
    render: (ctx) => <LayerEffectsSection clips={ctx.visual} flush />,
  },
  {
    id: "text-effects",
    slot: "kind",
    tab: "effects",
    order: 45,
    scoped: true,
    /**
     * The per-glyph stack, under the strip, writing wherever it points.
     *
     * It used to be pinned to the LAYER here and apologise for it in a
     * comment — the Effects tab hid the strip, so a scoped write would have
     * changed the document without saying so. The strip is placed by the
     * shared/scoped boundary now, which means this tab has one, which means
     * the honest thing is simply possible: layer passes above the line,
     * per-glyph passes below it, and "a glow on the spoken word only" is
     * where anyone would look for it.
     */
    applies: (ctx) => ctx.clips.every((c) => c.kind === "text"),
    render: (ctx) => <TextEffectsForScope clips={ctx.clips as TextClip[]} />,
  },
  {
    id: "animate",
    slot: "kind",
    tab: "animate",
    order: 40,
    applies: allText,
    render: (ctx) => <TextInspector clip={ctx.clip as TextClip} tab="animate-shared" />,
  },
  {
    id: "animate-scoped",
    slot: "kind",
    tab: "animate",
    order: 45,
    scoped: true,
    applies: allText,
    render: (ctx) => <TextInspector clip={ctx.clip as TextClip} tab="animate" />,
  },
  {
    id: "animate-layer",
    slot: "kind",
    tab: "animate",
    order: 40,
    // A text layer's panel carries these same items inside its own accordion.
    applies: (ctx) => visual(ctx) && !allText(ctx),
    render: (ctx) => <LayerAnimateSection clip={ctx.visual[0]!} />,
  },
  // ── Sound: the SAME three slots as Design ──────────────────────────────────
  //
  // It had three shapes before, one per kind — which is why a caption's Sound
  // tab was a single empty box while a nested comp's was five sections. The
  // fader every clip carries, and the voices underneath it, now show on all of
  // them, because `audioMix` gates a text layer's fired sounds exactly as it
  // gates a video's dialogue (see `audio/cues.ts`).
  {
    id: "sound-output",
    slot: "head",
    tab: "sound",
    order: 10,
    applies: () => true,
    render: (ctx) => <SoundOutputSection clip={ctx.clip} />,
  },
  {
    // Where the sound GOES — its category and what it ducks under. Every kind
    // that makes or contains sound, so it rides the spine, not a kind panel.
    id: "sound-mix",
    slot: "head",
    tab: "sound",
    order: 12,
    applies: () => true,
    render: (ctx) => <SoundMixSection clip={ctx.clip} />,
  },
  {
    id: "sound-stack",
    slot: "kind",
    tab: "sound",
    order: 40,
    // ONE stack for every kind, text included. The text branch used to route
    // through `TextInspector` so it could swap itself for a range editor —
    // which meant selecting three characters HID the layer's sounds, the same
    // bug the Animate tab had. The range's own sounds are a scoped section
    // below the strip now, and this is simply what the layer fires.
    //
    // One: a stack is a LIST of entries with their own ids, and two layers'
    // lists share none of them — there is no "Mixed" for a list that differs
    // in length. Each layer's is one click away in the Layers list below.
    applies: (ctx) => one(ctx) && ctx.clip.kind !== "audio",
    render: (ctx) => (
      <PanelSection
        id="sound-stack"
        title="Sounds"
        collapsible={false}
        hint="What this layer FIRES — as opposed to audio it contains."
      >
        <SoundStackSection clip={ctx.clip} />
      </PanelSection>
    ),
  },
  {
    id: "sound-scoped",
    slot: "kind",
    tab: "sound",
    order: 45,
    scoped: true,
    // A RANGE only. A caption state carries no sounds by design, so offering
    // Unread / Focus / Read here would be three buttons onto an empty panel.
    scopes: ["range"],
    applies: allText,
    render: (ctx) => <TextInspector clip={ctx.clip as TextClip} tab="sound" />,
  },
  {
    id: "sound-voices",
    slot: "kind",
    tab: "sound",
    order: 50,
    applies: () => true,
    render: (ctx) => <SoundVoicesSection clips={ctx.clips} />,
  },
  {
    id: "sound-empty",
    slot: "kind",
    tab: "sound",
    order: 51,
    applies: (ctx) => !ctx.clips.some((c) => c.kind === "audio" || c.kind === "text"),
    render: (ctx) => <SoundEmptyNote clips={ctx.clips} />,
  },
  {
    // What the recording is MADE of — for anything that plays one, audio or a
    // video's sound — and the ways in: a visualizer, an expression, a node.
    // One: an analysis belongs to one recording.
    id: "sound-analysis",
    slot: "tail",
    tab: "sound",
    order: 58,
    applies: (ctx) => one(ctx) && mediaAssetOf(ctx.clip) !== null,
    render: (ctx) => <SoundAnalysisSection clip={ctx.clip} assetId={mediaAssetOf(ctx.clip)!} />,
  },
  {
    id: "sound-fx",
    slot: "tail",
    tab: "sound",
    order: 60,
    // The chain belongs to the clip that OWNS the bus — a comp's mix or a
    // video's dialogue. An audio clip reaches the same section through
    // `AudioInspector`, so it is never drawn twice.
    // One, for the stack's reason: a chain is a list of cards with their own ids.
    applies: (ctx) => one(ctx) && ctx.clip.kind !== "audio" && clipCarriesAudioEffects(ctx.clip),
    render: (ctx) => <AudioEffectsSection clip={ctx.clip} />,
  },
  {
    id: "cues",
    slot: "kind",
    tab: "cues",
    order: 40,
    // One: a cue list is timed against one layer's words.
    applies: (ctx) => one(ctx) && ctx.clip.kind === "text",
    render: (ctx) => <CaptionCues clip={ctx.clip as TextClip} />,
  },
];

function isPaintable(clip: Clip): boolean {
  return (
    clip.kind === "shape" ||
    clip.kind === "path" ||
    clip.kind === "text" ||
    clip.kind === "image" ||
    clip.kind === "video" ||
    // A GROUP paints too, and differently from all of the above: its fill is
    // worn OVER the picture its members make and its stroke runs around that
    // picture's silhouette, rather than either applying per member. Both
    // resolve in the renderer, so the same two sections drive them.
    clip.kind === "group" ||
    // A MESH is coloured by its fills too — solid, gradient or image across its
    // surface — so a 3D object takes colour from the very same section.
    clip.kind === "mesh"
  );
}

const SLOT_RANK: Record<SectionSlot, number> = { head: 0, kind: 1, tail: 2 };

/**
 * The sections this context wants, in spine order. The whole layout, derived.
 *
 * SCOPED SORTS LAST, ahead of slot and order. That is what makes the strip's
 * promise structural rather than a convention: with one boundary index, a
 * single unscoped section ordered after a scoped one would be drawn below the
 * tabs and would quietly claim to belong to the selected state. Sorting on the
 * flag first means the partition cannot be got wrong by anyone adding a
 * section later — the shared half is everything above the line, always,
 * because there is nothing else it could be.
 */
export function sectionsFor(ctx: SectionCtx): InspectorSectionDef[] {
  const home = ctx.tabs[0] ?? "design";
  const world = ctx.clips.length > 0 && inWorld(ctx);
  const spatial = ctx.clips.some(isSpatialClip);
  return LAYER_SECTIONS.filter(
    (s) =>
      (s.tab === "home" ? home : s.tab) === ctx.tab &&
      !(world && FLAT_ONLY.has(s.id)) &&
      // A mesh keeps its Effects: they run on its own render (draw-frame's world branch).
      !(spatial && NOT_ON_SPATIAL.has(s.id) && !(s.id === "effects" && ctx.clips.every((c) => c.kind === "mesh"))) &&
      s.applies(ctx),
  ).sort((a, b) => SLOT_RANK[a.slot] - SLOT_RANK[b.slot] || a.order - b.order);
}

/**
 * Render a context's sections as THREE runs, in this order:
 *
 *     head + kind, shared   ·   [ TABS + everything scoped ]   ·   tail, shared
 *
 * The middle run is a REGION, not a boundary. A boundary was the first shape
 * and it was wrong in a way you could see: sorting every scoped section last
 * pushed Motion blur, Timing and Export — which belong to the layer and always
 * did — below a strip that claims everything under it belongs to the selected
 * word. Export is not a property of the word being spoken.
 *
 * As a region it is also the strip's own scroll container, so `sticky` pins it
 * exactly while its sections are on screen and lets it go when they end. The
 * promise ("this is what the sections under me are editing") is then true for
 * as long as the strip is visible, which is the only way a sticky header can
 * be honest about a middle-of-the-panel section.
 */
export function LayerSections(ctx: SectionCtx) {
  const sections = sectionsFor(ctx);
  const scoped = sections.filter((s) => s.scoped);
  const lead = sections.filter((s) => !s.scoped && s.slot !== "tail");
  const trail = sections.filter((s) => !s.scoped && s.slot === "tail");
  const draw = (list: InspectorSectionDef[]) =>
    list.map((s) => <React.Fragment key={s.id}>{s.render(ctx)}</React.Fragment>);

  // What the strip may offer: the union of what this region's sections claim
  // to mean anything for. Derived, so a section that stops applying takes its
  // chip with it.
  const offer = new Set<ScopeAddress["kind"]>();
  for (const s of scoped) for (const k of s.scopes ?? DEFAULT_SCOPES) offer.add(k);

  return (
    <SelectionScope clips={ctx.clips}>
      {draw(lead)}
      {scoped.length > 0 && (
        <div className="relative">
          <ScopeTabs offer={offer} />
          {draw(scoped)}
        </div>
      )}
      {draw(trail)}
    </SelectionScope>
  );
}

/** Every scope a text layer can offer. The default for a section that is quiet about it. */
const DEFAULT_SCOPES: ReadonlyArray<ScopeAddress["kind"]> = ["caption", "range", "contour"];

export { isVisualClip };
