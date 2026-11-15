"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import { openLinkEditor } from "../links/LinkEditor";
import { copyLinkTo } from "../links/navigate";
import { clipLocalClamped } from "../inspector/animatable";
import {
  FRAME_MODES,
  autoLayoutVerb,
  canMergeParts,
  canRejoinAudio,
  canSeparateAudio,
  canUngroup,
  captureLibrarySnapshot,
  clearClipKeyframes,
  clipHasSound,
  clipPlaybackOf,
  COMPOSITE_MODES,
  createNestedClip,
  decomposeNestedClip,
  deleteFrame,
  detachTextFromPath,
  duplicateFrame,
  frameContentDurationMs,
  freezeKeys,
  gapAt,
  groupOfClip,
  isCaptureClip,
  isComponentFrame,
  isInstanceClip,
  isPathText,
  isVectorGroup,
  isVisualClip,
  linkClips,
  characterOf,
  locateClip,
  mergeVectorClips,
  modeUsesStencil,
  nestClips,
  pullClipsOutOneLevel,
  rampKeys,
  rejoinClipAudio,
  rejoinLoss,
  resolveRetimeRipple,
  retimeClip,
  selectionCompositeInfo,
  separateClipAudio,
  setClipFlat,
  setClipPlayback,
  setKeyframe,
  speedAt,
  SPEED_PROPERTY,
  swapGroupRoles,
  unlinkClips,
  vectorMergeLoss,
  type MotionDocument,
  type Clip,
  type ClipPlayback,
  type DocumentStore,
  type LoopMode,
  createRig,
  makeSwitch,
  unmakeSwitch,
} from "@solomotion/core";
import {
  Activity,
  Braces,
  FileCode2,
  AlignHorizontalJustifyStart,
  Bone,
  Orbit,
  ToggleRight,
  ArrowLeftRight,
  ArrowUpFromLine,
  AudioLines,
  BetweenHorizontalEnd,
  Captions,
  Clipboard,
  Combine,
  Component,
  Copy,
  CopyPlus,
  Crop,
  Database,
  Eye,
  EyeOff,
  Box,
  Film,
  FolderInput,
  Gauge,
  Group,
  Image as ImageIcon,
  LayoutGrid,
  Library,
  Link2,
  Lock,
  LockOpen,
  Maximize2,
  Merge,
  PackageOpen,
  PencilLine,
  PenTool,
  Repeat,
  RotateCcw,
  Scissors,
  Share,
  Share2,
  SlidersHorizontal,
  Snowflake,
  Sparkles,
  Spline,
  SquareDashed,
  Trash2,
  Ungroup,
  Unlink,
  Unlink2,
  Volume2,
  VolumeX,
  Wand2,
  Smile,
  Waves,
  Zap,
  Video,
} from "lucide-react";
import { makeClips3d } from "../world/make-3d";
import { setActiveCamera } from "../world/commands";
import { useWorldUi } from "../world/state";
import { GestureHint } from "@/components/ui/kbd";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSplitItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { toast } from "@/lib/toast";
import { setBodies } from "../physics/actions";
import { ReferenceMenuItem } from "../drawing/reference-menu";
import { formatRate } from "../timeline/retime-format";
import { canMergeSelection, mergeResultKind, mergeSelectedLayers } from "../drawing/merge-layers";
import { mergeParts, partsToMerge, separateParts, separablePartCount } from "../drawing/part-actions";
import { COMPOSITE_ICONS, UnionIcon } from "../ui/composite-icons";
import { deleteFrames,
  applyCompositeToSelection,
  closeAllGapsOnTrack,
  closeSelectedGap,
  copySelection,
  createComponentFromFrame,
  createComponentFromSelection,
  deleteSelection,
  detachSelectedInstances,
  duplicateSelectedClips,
  flattenSelection,
  groupSelection,
  pasteClipboard,
  splitAtPlayhead,
  toggleAutoLayout,
  toggleHiddenSelection,
  toggleLockSelection,
  ungroupSelection,
} from "../state/clip-actions";
import { replaceClipAsset } from "../assets/import";
import { createTraceClip, isSpatialClip, placeClip } from "@solomotion/core";
import { askAgent } from "../agent/ask-bus";
import type { QuickAction } from "../agent/quick-actions";
import { usePanels } from "../state/panels";
import { cacheClipFootprint, clearClipCache } from "../stage/render/media-cache";
import { addBackgroundRemoval } from "../state/remove-background";
import { usePluginWindows } from "../plugins/plugin-windows";
import { canRenderInPlace, hasOriginal, switchToOriginal } from "../render/render-in-place";
import { exportSelectionAsFile } from "../io/slice-file";
import { inspectorTabs } from "../inspector/shared-inspector";
import { revealInInspector } from "../state/inspector-nav";
import { useParkedPlayhead, useSession } from "../state/session";
import { useDoc, useDocSelector, useDocWhen } from "../state/document-context";
import { FRAME_MODE_META, switchFrameMode } from "../frames/frame-modes";
import { syncEnteredGroup } from "../state/use-group-focus";
import { clipEditMode, EDIT_MODE_LABELS, openClipEditor, type EditMode } from "../state/focus-model";
import { ShortcutHint } from "../state/ShortcutHint";
import { characterOffer } from "../character/offer";
import { characterSection } from "../character/character-menu";
import { useCharacterPick } from "../character/pick-state";

/**
 * THE LAYER MENU — one vocabulary for the stage, the timeline and the layers
 * panel. Every entry calls the same action as its shortcut and shows the live
 * combo from the registry, so the menu and the keys can never drift.
 *
 * It is built as ORDERED SECTIONS, and a section that has nothing to say for
 * this selection is simply absent — separator included. Nothing is ever shown
 * greyed out: a disabled row is a question the menu asks and cannot answer.
 * Every layer gets the same skeleton, so your hand learns where things are:
 *
 *   1. edit        what double-click does
 *   2. clipboard   Copy ▸ · Cut · Paste ▸ · Duplicate — the ▸ holds properties
 *   3. structure   group / auto layout / combine · nest / component · convert
 *   4. clip        split, speed, loop, and the verbs of this kind of layer
 *   5. go to       Effects · Animate · Sound — links, the panel does the work
 *   6. output      render in place, cache, export, library
 *   7. state       link, reference, lock, hide
 *   8. delete
 *
 * Deliberately NOT here: flip (⇧H / ⇧V, and the transform section), folding a
 * group (the chevron on its bar), animate in/out presets (the Animate link).
 */
export function ClipMenuItems({ store }: { store: DocumentStore }) {
  // A menu is a snapshot of the selection at the moment it opens: it reads the
  // live stores directly and mounts fresh each time, so it is not memoised.
  "use no memo";
  const ids = useSession.getState().selectedClipIds;
  const doc = store.getState();
  const clips = ids.map((id) => locateClip(doc, id)?.clip).filter((c) => c !== undefined);
  if (clips.length === 0) return null;
  const single = clips.length === 1 ? clips[0] : undefined;
  return (
    <>
      {joinSections([
        editSection(store, single),
        // A character (or a part of one): its poses, behaviors, rig and parts.
        characterSection(store, doc, single),
        cameraSection(store, doc, single),
        askSection(clips),
        clipboardSection(store, single),
        linkSection(store, doc, clips),
        structureSection(store, doc, ids, clips, single),
        clipSection(store, doc, single),
        goToSection(doc, clips),
        outputSection(store, doc, ids, single),
        stateSection(store, ids, clips, single),
        [
          <ContextMenuItem key="delete" className="text-destructive focus:text-destructive" onClick={() => deleteSelection(store)}>
            <Trash2 /> Delete
            <ShortcutHint id="edit.delete" />
          </ContextMenuItem>,
        ],
      ])}
    </>
  );
}

type Section = Array<React.ReactElement | null | false | undefined>;

/** Sections with something in them, a separator between each. */
function joinSections(sections: Section[]): React.ReactNode {
  const kept = sections.map((s) => s.filter((n): n is React.ReactElement => !!n)).filter((s) => s.length > 0);
  return kept.map((items, i) => (
    <React.Fragment key={i}>
      {i > 0 && <ContextMenuSeparator />}
      {items}
    </React.Fragment>
  ));
}

/**
 * Ask the agent about what is selected. The agent already sees the selection
 * (every message carries it), so the draft only names it — the user writes
 * the rest.
 */
function askSection(clips: Clip[]): Section {
  const single = clips.length === 1 ? clips[0]! : undefined;
  const actions = single ? aiActionsFor(single) : [];
  return [
    <ContextMenuItem key="ask" onClick={askWith(single ? `“${single.name}” — ` : `These ${clips.length} layers — `)}>
      <Sparkles /> Ask AI…
    </ContextMenuItem>,
    actions.length > 0 && (
      <ContextMenuSub key="ai">
        <ContextMenuSubTrigger>
          <Wand2 /> AI actions
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>{actions}</ContextMenuSubContent>
      </ContextMenuSub>
    ),
  ];
}

/** Open the chat with a started request — for jobs that need words from the user. */
const askWith = (draft: string) => () => {
  usePanels.getState().showLeftPanel("agents");
  askAgent(draft);
};

/** Run a registry command in one click. The runner is its own chunk, fetched on first use. */
const quick = (action: QuickAction) => () => void import("../agent/quick-actions").then((m) => m.runQuickAction(action));

/**
 * What AI can do with THIS layer, in one click or one sentence. Every entry is
 * a registry command the agent also has (or a chat started for it), so the
 * menu, the chat and an external agent can never disagree about what
 * "remove pauses" means.
 */
function aiActionsFor(clip: Clip): React.ReactElement[] {
  const id = clip.id;
  const name = clip.name;
  const out: React.ReactElement[] = [];
  const item = (key: string, icon: React.ReactNode, label: string, onClick: () => void) => (
    <ContextMenuItem key={key} onClick={onClick}>
      {icon} {label}
    </ContextMenuItem>
  );
  const cutOut = item("cutout", <Wand2 />, "Cut out subject", quick({ command: "media.remove_background", input: { id }, capability: "cutout", label: "Cut out subject", done: "Subject cut out" }));
  const speech = clip.kind === "video" || (clip.kind === "audio" && clip.source.type === "asset");
  if (clip.kind === "image") {
    out.push(
      cutOut,
      item("upscale", <Maximize2 />, "Upscale 2×", quick({ command: "media.upscale", input: { id, factor: 2 }, capability: "upscale", label: "Upscale 2×", done: "Upscaled — same size, sharper" })),
      item("edit-image", <ImageIcon />, "Edit with AI…", askWith(`Edit the image “${name}”: `)),
      item("animate", <Film />, "Animate into video…", askWith(`Animate “${name}” into a 5-second video: `)),
    );
  }
  if (speech) {
    out.push(
      item("captions", <Captions />, "Captions from speech", quick({ command: "media.transcribe", input: { id, captions: { maxWords: 4 } }, capability: "transcription", label: "Caption the speech", done: "Captions added" })),
      item("pauses", <Scissors />, "Remove pauses", quick({ command: "media.remove_pauses", input: { id }, capability: "transcription", label: "Remove pauses", done: "Pauses removed" })),
      item("isolate", <AudioLines />, "Clean up voice", quick({ command: "audio.isolate", input: { id }, capability: "isolate", label: "Clean up voice", done: "Voice cleaned up" })),
    );
    if (clip.kind === "audio") out.push(item("lyrics", <Captions />, "Time lyrics…", askWith(`Time these lyrics to “${name}” and show them as captions:\n`)));
  }
  if (clip.kind === "video") {
    out.push(cutOut, item("edit-video", <Film />, "Edit video with AI…", askWith(`Edit the video “${name}”: `)));
  }
  if (clip.kind === "text" && clip.text.trim()) {
    out.push(
      item(
        "speak",
        <Volume2 />,
        "Read aloud",
        quick({ command: "generate.speech", input: { text: clip.text, place: { frameId: clip.frameId, startMs: clip.startMs } }, capability: "speech", label: "Read aloud", done: "Voiceover placed" }),
      ),
      item("rewrite", <PencilLine />, "Rewrite with AI…", askWith(`Rewrite “${name}”: `)),
    );
  }
  return out;
}

/**
 * A camera in a world: which one the world is seen through. The live camera is
 * derived (the topmost one on the timeline at that moment), so these restack
 * it — the same command as the viewport's object menu (`setActiveCamera`).
 */
function cameraSection(store: DocumentStore, doc: MotionDocument, clip: Clip | undefined): Section {
  if (clip?.kind !== "camera" || !doc.frames.find((f) => f.id === clip.frameId)?.world) return [];
  const frameId = clip.frameId;
  return [
    <ContextMenuItem key="cam-active" onClick={() => setActiveCamera(store, frameId, clip.id)}>
      <Video /> Make active camera
    </ContextMenuItem>,
    <ContextMenuItem key="cam-look" onClick={() => setActiveCamera(store, frameId, clip.id, { look: true })}>
      <Eye /> Look through it
    </ContextMenuItem>,
    <ContextMenuItem
      key="cam-lock"
      onClick={() => setActiveCamera(store, frameId, clip.id, { look: true }) && useWorldUi.getState().set({ lockCamera: true })}
    >
      <Lock /> Look through and lock to view
    </ContextMenuItem>,
  ];
}

/** Icon for each editor — the label itself comes from `EDIT_MODE_LABELS`. */
const EDIT_MODE_ICONS: Record<EditMode, React.ComponentType<{ className?: string }>> = {
  text: PencilLine,
  vectorNodes: PenTool,
  shapeCorners: SquareDashed,
  nestedComp: Film,
  waveform: AudioLines,
  svgVectors: PenTool,
  crop: Crop,
  world: Box,
};

/**
 * 1 — exactly what a double-click on this layer would do, named and run by the
 * SAME brain the gesture uses (`clipEditMode` → `openClipEditor`), so a new
 * editable kind appears here for free and can never say one thing and do
 * another.
 */
function editSection(store: DocumentStore, clip: Clip | undefined): Section {
  if (!clip) return [];
  const mode = clipEditMode(store.getState(), clip);
  // A flat nested clip is deliberately NOT enterable from here; its way in is
  // "Edit contents" below.
  if (!mode || (clip.kind === "nested" && clip.flat)) return [];
  const Icon = EDIT_MODE_ICONS[mode];
  return [
    <ContextMenuItem key="edit" onClick={() => openClipEditor(store, clip, mode)}>
      <Icon className="size-4" /> {EDIT_MODE_LABELS[mode]}
      <GestureHint>double-click</GestureHint>
    </ContextMenuItem>,
  ];
}

/**
 * 2 — Copy and Paste are SPLIT rows: click does the everyday thing, resting on
 * the row opens the property variants. That is what retired the old
 * "Properties ▸" row without hiding what it held.
 */
/**
 * The selection as the `ac.*` script that rebuilds it (core reify). "New
 * script" OWNS what it printed, so its first Run rebuilds the layers in place.
 * The bridge module is fetched on use — it measures against the agent registry.
 */
function codeItems(store: DocumentStore, name: string): React.ReactElement[] {
  const ids = () => [...useSession.getState().selectedClipIds];
  const bridge = () => import("../scripts/code-bridge");
  return [
    <ContextMenuSeparator key="code-sep" />,
    <ContextMenuItem key="code-copy" onClick={() => void bridge().then((m) => m.copyLayersAsCode(store, ids()))}>
      <Braces /> Copy as code
    </ContextMenuItem>,
    <ContextMenuItem key="code-new" onClick={() => void bridge().then((m) => m.newScriptFromLayers(store, ids(), name))}>
      <FileCode2 /> New script from {name === "selection" ? "selection" : "layer"}
    </ContextMenuItem>,
  ];
}

/** Add / edit a link (⇧⌘U), and copy a link to the layer itself. */
function linkSection(store: DocumentStore, doc: MotionDocument, clips: Clip[]): Section {
  const visual = clips.filter(isVisualClip);
  if (visual.length === 0) return [];
  const linked = visual.some((c) => c.link);
  return [
    <ContextMenuItem key="link" onClick={() => void openLinkEditor(doc)}>
      <Link2 /> {linked ? "Edit link…" : "Add link…"}
      <ShortcutHint id="edit.link" />
    </ContextMenuItem>,
    <ContextMenuItem key="link-copy" onClick={() => void copyLinkTo(store, visual.map((c) => `clip:${c.id}` as const))}>
      <Share2 /> Copy link to {visual.length === 1 ? "layer" : "layers"}
    </ContextMenuItem>,
  ];
}

function clipboardSection(store: DocumentStore, single: Clip | undefined): Section {
  const copy = () => void copySelection(store).then((w) => w && toast(`Copied ${w}`));
  const paste = () => void pasteClipboard(store).then((w) => w && toast(`Pasted ${w}`));
  const copyLabel = (
    <>
      <Copy /> Copy
      <ShortcutHint id="edit.copy" />
    </>
  );
  const pasteLabel = (
    <>
      <Clipboard /> Paste
      <ShortcutHint id="edit.paste" />
    </>
  );
  return [
    single ? (
      <ContextMenuSplitItem key="copy" onAction={copy} label={copyLabel}>
        <ContextMenuItem onClick={copy}>
          <Copy /> Copy layer
          <ShortcutHint id="edit.copy" />
        </ContextMenuItem>
        <ContextMenuItem onClick={() => useSession.getState().openPropertyTransfer("copy", single.id)}>
          <SlidersHorizontal /> Copy properties…
        </ContextMenuItem>
        {codeItems(store, single.name)}
      </ContextMenuSplitItem>
    ) : (
      <ContextMenuSplitItem key="copy" onAction={copy} label={copyLabel}>
        <ContextMenuItem onClick={copy}>
          <Copy /> Copy layers
          <ShortcutHint id="edit.copy" />
        </ContextMenuItem>
        {codeItems(store, "selection")}
      </ContextMenuSplitItem>
    ),
    <ContextMenuItem key="cut" onClick={() => void copySelection(store, true).then((w) => w && toast(`Cut ${w}`))}>
      <Scissors /> Cut
      <ShortcutHint id="edit.cut" />
    </ContextMenuItem>,
    single ? (
      <ContextMenuSplitItem key="paste" onAction={paste} label={pasteLabel}>
        <ContextMenuItem onClick={paste}>
          <Clipboard /> Paste
          <ShortcutHint id="edit.paste" />
        </ContextMenuItem>
        <ContextMenuItem onClick={() => useSession.getState().openPropertyTransfer("paste", single.id)}>
          <SlidersHorizontal /> Paste properties…
        </ContextMenuItem>
      </ContextMenuSplitItem>
    ) : (
      <ContextMenuItem key="paste" onClick={paste}>
        {pasteLabel}
      </ContextMenuItem>
    ),
    <ContextMenuItem key="dup" onClick={() => duplicateSelectedClips(store)}>
      <CopyPlus /> Duplicate
      <ShortcutHint id="edit.duplicate" />
    </ContextMenuItem>,
  ];
}

/** PHYSICS for the selection: fall, stand as a collider, push by its keys — or stop. The tab holds the rest. */
function physicsMenu(store: DocumentStore, ids: string[], clips: Clip[]): React.ReactElement | null {
  const bodies = clips.filter((c) => c.kind !== "audio" && c.kind !== "adjustment" && c.kind !== "camera" && c.kind !== "light");
  if (!bodies.length) return null;
  const any = bodies.some((c) => (c as { physics?: unknown }).physics);
  return (
    <ContextMenuSub key="physics">
      <ContextMenuSubTrigger>
        <Orbit /> Physics
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuItem onClick={() => setBodies(store, ids, "active")}>Falls — collides and tumbles</ContextMenuItem>
        <ContextMenuItem onClick={() => setBodies(store, ids, "passive")}>Fixed — others land on it</ContextMenuItem>
        <ContextMenuItem onClick={() => setBodies(store, ids, "animated")}>Pushes — moves by its keys</ContextMenuItem>
        {any && <ContextMenuItem onClick={() => setBodies(store, ids, null)}>No physics</ContextMenuItem>}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/**
 * A CHARACTER's two structures: a rig (bones that bend the art — then the Bone
 * tool, to draw them) and a switch (one member at a time — an eye's states).
 * Offered on a plain group, or on layers in one flat comp, and never on what
 * already places its members (a rig, a switch, an auto layout).
 */
function characterItems(store: DocumentStore, doc: MotionDocument, ids: string[], clips: Clip[], single: Clip | undefined): React.ReactElement[] {
  const plainGroup = single?.kind === "group" && !single.rig && !single.switch && !single.layout;
  const frameId = clips[0]?.frameId;
  const oneComp = !!frameId && clips.every((c) => c.frameId === frameId && c.kind !== "audio");
  const out: React.ReactElement[] = [];
  // Make character heads the list (ux.md §1.2): detected parts → the verb; a
  // picture, or a group with nothing found → two clicks of placement.
  // Never on what already is a character (or a part of one): its own menu leads.
  const canPick = single && !characterOf(doc, single.id) && (single.kind === "image" || single.kind === "raster" || single.kind === "path" || single.kind === "video" || single.kind === "group");
  const asCharacter = single && (single.kind === "group" || single.kind === "nested") && !(single.kind === "group" && single.poses?.length) ? single : null;
  if (asCharacter || canPick) {
    const offer = single ? characterOffer(doc, single.id) : null;
    out.push(
      <ContextMenuItem
        key="character"
        onClick={() => {
          if (offer) return void import("../character/make-character").then((m) => m.makeCharacter(store, single!.id));
          if (single?.kind === "group") toast("No mouth or eyes found — click to place them");
          useCharacterPick.getState().start(single!.id);
        }}
      >
        <Smile /> Make character
      </ContextMenuItem>,
    );
  }
  if (single?.kind === "group" && single.switch) {
    out.push(
      <ContextMenuItem key="unswitch" onClick={() => store.update("Remove switch", (d) => void unmakeSwitch(d, single.id))}>
        <ToggleRight /> Stop switching
      </ContextMenuItem>,
    );
    return out;
  }
  if (!oneComp || (single?.kind === "group" && !plainGroup)) return out;
  if (plainGroup || clips.length >= 2) {
    out.push(
      <ContextMenuItem
        key="switch"
        onClick={() => {
          let id: string | null = null;
          store.update("Make switch", (d) => void (id = makeSwitch(d, ids)));
          if (id) useSession.getState().select([id]);
        }}
      >
        <ToggleRight /> Make switch
      </ContextMenuItem>,
    );
  }
  out.push(
    <ContextMenuItem
      key="rig"
      onClick={() => {
        let id: string | null = null;
        store.update("Make rig", (d) => void (id = createRig(d, frameId!, { memberIds: ids })));
        if (!id) return;
        useSession.getState().select([id]);
        useSession.getState().setTool("bone");
        toast("Rig made — draw bones through the art, joint to joint");
      }}
    >
      <Bone /> Make rig
    </ContextMenuItem>,
  );
  return out;
}

/**
 * 3 — what the layer is made of and what it belongs to. Each verb sits beside
 * its inverse (Group/Ungroup, Make nested clip/Decompose, Create
 * component/Detach) and appears only when it can run.
 */
function structureSection(
  store: DocumentStore,
  doc: MotionDocument,
  ids: string[],
  clips: Clip[],
  single: Clip | undefined,
): Section {
  const layout = autoLayoutVerb(doc, ids);
  const nested = single?.kind === "nested" ? single : undefined;
  const instance = single ? isInstanceClip(doc, single) : false;
  const allText = clips.every((c) => c.kind === "text");
  const flattenable = clips.some((c) => c.kind === "shape" || c.kind === "path" || c.kind === "text");
  const vectorGroup = nested && isVectorGroup(doc, nested) ? nested : undefined;
  const parts = partsToMerge(doc, ids);
  return [
    <ContextMenuItem key="group" onClick={() => groupSelection(store)}>
      <Group /> Group
      <ShortcutHint id="edit.group" />
    </ContextMenuItem>,
    canUngroup(doc, ids) && (
      <ContextMenuItem key="ungroup" onClick={() => ungroupSelection(store)}>
        <Ungroup /> Ungroup
        <ShortcutHint id="edit.ungroup" />
      </ContextMenuItem>
    ),
    layout && (
      <ContextMenuItem key="layout" onClick={() => toggleAutoLayout(store)}>
        <LayoutGrid /> {layout === "remove" ? "Remove auto layout" : "Auto layout"}
        <ShortcutHint id="edit.auto-layout" />
      </ContextMenuItem>
    ),
    ...characterItems(store, doc, ids, clips, single),
    physicsMenu(store, ids, clips),
    selectionCompositeInfo(doc, ids).eligible && <CombineMenuItems key="combine" store={store} />,
    ids.some((id) => groupOfClip(doc, id) !== null) && (
      <ContextMenuItem
        key="out"
        onClick={() => {
          store.update("Move out of group", (d) => pullClipsOutOneLevel(d, ids));
          syncEnteredGroup(store.getState());
        }}
      >
        <ArrowUpFromLine /> Move out of group
      </ContextMenuItem>
    ),
    <ContextMenuItem
      key="nest"
      onClick={() => {
        let nestedId: string | null = null;
        store.update("Make nested clip", (d) => void (nestedId = nestClips(d, ids)));
        if (nestedId) useSession.getState().select([nestedId]);
      }}
    >
      <Film /> Make nested clip
    </ContextMenuItem>,
    // The flat layout, lifted into real depth: same picture, now a world you can
    // turn, light and shoot with cameras (core `moveIntoWorld`).
    !ids.some((id) => {
      const c = locateClip(doc, id)?.clip;
      return !c || doc.frames.find((f) => f.id === c.frameId)?.world;
    }) && (
      <ContextMenuItem
        key="world"
        onClick={() => makeClips3d(store, ids)}
      >
        <Box /> Make 3D
      </ContextMenuItem>
    ),
    nested && (
      <ContextMenuItem
        key="decompose"
        onClick={() => {
          store.update("Decompose nested clip", (d) => void decomposeNestedClip(d, nested.id));
          useSession.getState().clearSelection();
        }}
      >
        <Ungroup /> Decompose nested clip
      </ContextMenuItem>
    ),
    // A VIEW, lossless and reversible: stop showing me the pieces.
    nested && (
      <ContextMenuItem
        key="flat"
        onClick={() =>
          store.update(nested.flat ? "Edit contents" : "Treat as one layer", (d) => setClipFlat(d, nested.id, !nested.flat))
        }
      >
        {nested.flat ? <PenTool /> : <ImageIcon />}
        {nested.flat ? "Edit contents" : "Treat as one layer"}
      </ContextMenuItem>
    ),
    !instance && (
      <ContextMenuItem key="component" onClick={() => createComponentFromSelection(store)}>
        <Component /> Create component
      </ContextMenuItem>
    ),
    clips.some((c) => isInstanceClip(doc, c)) && (
      <ContextMenuItem key="detach" onClick={() => detachSelectedInstances(store)}>
        <Unlink /> Detach instance
      </ContextMenuItem>
    ),
    // A lone path already IS a path; it offers "Edit points" above instead.
    flattenable && !(single?.kind === "path") && (
      <ContextMenuItem key="flatten" onClick={() => void flattenSelection(store)}>
        <PenTool /> {allText ? "Convert to outlines" : "Flatten to path"}
        <ShortcutHint id="edit.flatten" />
      </ContextMenuItem>
    ),
    canMergeSelection(doc, ids) && (
      <ContextMenuItem key="merge" onClick={() => mergeSelectedLayers(store)}>
        <Merge /> Merge to {mergeResultKind(doc, ids) === "vector" ? "one vector" : "one image"}
      </ContextMenuItem>
    ),
    // An EDIT, the inverse of Separate: the pieces collapse into one editable
    // path. Offered for vector art only; per-piece animation cannot survive it,
    // and the toast says what was dropped rather than letting you find out.
    (vectorGroup || (single === undefined && clips.length > 1 && clips.every((c) => c.kind === "path"))) && (
      <ContextMenuItem
        key="merge-vector"
        onClick={() => {
          const lost = vectorGroup ? vectorMergeLoss(doc, vectorGroup) : [];
          let merged: string | null = null;
          store.update("Merge into one layer", (d) => void (merged = mergeVectorClips(d, vectorGroup ? [vectorGroup.id] : ids)));
          if (merged) {
            useSession.getState().select([merged]);
            if (lost.length) toast(`Merged — dropped ${lost.join(", ")}`);
          }
        }}
      >
        <Combine /> Merge into one layer
      </ContextMenuItem>
    ),
    // Pixel parts: the raster half of the same two verbs, in the same words.
    single && separablePartCount(doc, single.id) > 1 && (
      <ContextMenuItem key="separate-parts" onClick={() => separateParts(store, single.id)}>
        <Ungroup /> Separate parts
      </ContextMenuItem>
    ),
    canMergeParts(doc, parts) && (
      <ContextMenuItem key="merge-parts" onClick={() => mergeParts(store, parts)}>
        <Combine /> Merge parts
      </ContextMenuItem>
    ),
  ];
}

/**
 * 4 — the clip on its timeline, then the verbs only this kind of layer has:
 * its media, its sound, its path.
 */
function clipSection(store: DocumentStore, doc: MotionDocument, clip: Clip | undefined): Section {
  const items: Section = [
    <ContextMenuItem key="split" onClick={() => splitAtPlayhead(store)}>
      <Scissors /> Split at playhead
      <ShortcutHint id="edit.split" />
    </ContextMenuItem>,
  ];
  if (!clip) return items;
  if (clipPlaybackOf(clip)) items.push(<SpeedLoopItems key="speed" store={store} clip={clip} />);

  const replaceable = clip.kind === "image" || clip.kind === "video" || (clip.kind === "audio" && clip.source.type === "asset");
  if (replaceable) {
    items.push(
      <ContextMenuItem key="replace" onClick={() => void replaceClipAsset(store, clip.id)}>
        <FolderInput /> Replace {clip.kind === "image" ? "image" : clip.kind === "video" ? "video" : "audio"}…
      </ContextMenuItem>,
    );
  }
  if (clip.kind === "image" || clip.kind === "video") {
    items.push(
      <ContextMenuItem key="bg" onClick={() => addBackgroundRemoval(store, clip.id) && toast("Background removal added")}>
        <Wand2 /> Remove background
      </ContextMenuItem>,
    );
  }
  // Separate / Rejoin — two halves of ONE decision about a video's sound; only
  // ever one of them is offered.
  if (canSeparateAudio(clip)) {
    items.push(
      <ContextMenuItem
        key="separate-audio"
        onClick={() => {
          let audioId: string | null = null;
          store.update("Separate audio", (d) => void (audioId = separateClipAudio(d, clip.id)));
          if (audioId) useSession.getState().select([clip.id, audioId]);
        }}
      >
        <AudioLines /> Separate audio
      </ContextMenuItem>,
    );
  }
  if (canRejoinAudio(doc, clip.id)) {
    const lost = rejoinLoss(doc, clip.id);
    items.push(
      <ContextMenuItem
        key="rejoin-audio"
        onClick={() => {
          store.update("Rejoin audio", (d) => void rejoinClipAudio(d, clip.id));
          if (lost.length) toast(`Audio rejoined — dropped ${lost.join(" and ")}`);
        }}
      >
        <Link2 /> Rejoin audio
      </ContextMenuItem>,
    );
  }
  if (clip.kind === "video") {
    items.push(
      <ContextMenuItem
        key="mute"
        onClick={() =>
          store.update(clip.muted ? "Unmute video" : "Mute video", (d) => {
            const loc = locateClip(d, clip.id);
            if (loc?.clip.kind === "video") loc.clip.muted = !clip.muted;
          })
        }
      >
        {clip.muted ? <Volume2 /> : <VolumeX />} {clip.muted ? "Unmute" : "Mute"}
      </ContextMenuItem>,
    );
  }
  if (clip.kind === "video" || (clip.kind === "audio" && clip.source.type === "asset")) {
    items.push(
      <ContextMenuItem key="wave" onClick={() => usePluginWindows.getState().open("waveform")}>
        <AudioLines /> Add waveform visualizer…
      </ContextMenuItem>,
    );
  }
  if (clip.kind !== "audio" && clip.kind !== "trace" && clip.kind !== "group" && clip.kind !== "adjustment" && !isSpatialClip(clip)) {
    // The path this layer draws over the whole shot, just beneath it.
    items.push(
      <ContextMenuItem
        key="trace"
        onClick={() => {
          let made: string | null = null;
          store.update("Trace path", (d) => {
            const frame = d.frames.find((f) => f.id === clip.frameId);
            const end = frame?.durationMs ?? d.durationMs;
            const trace = createTraceClip({ frameId: clip.frameId, sourceClipId: clip.id, startMs: clip.startMs, durationMs: Math.max(1, end - clip.startMs), name: `${clip.name} · Trace` });
            placeClip(d, trace, { belowClipId: clip.id });
            made = trace.id;
          });
          if (made) useSession.getState().select([made]);
        }}
      >
        <Spline /> Trace path
      </ContextMenuItem>,
    );
  }
  if (isPathText(clip)) {
    items.push(
      <ContextMenuItem
        key="detach-path"
        onClick={() =>
          store.update("Detach from path", (d) => {
            const live = locateClip(d, clip.id)?.clip;
            if (live?.kind === "text") detachTextFromPath(d, live, useSession.getState().playheadMs);
          })
        }
      >
        <Spline /> Detach from path
      </ContextMenuItem>,
    );
  }
  if (clip.kind !== "audio" && isCaptureClip(clip.keyframes)) {
    items.push(
      <ContextMenuCheckboxItem
        key="xfade"
        checked={clip.captureCrossfade ?? false}
        onCheckedChange={(v) =>
          store.update("Crossfade snapshots", (d) => {
            const loc = locateClip(d, clip.id);
            if (loc && loc.clip.kind !== "audio") loc.clip.captureCrossfade = v;
          })
        }
      >
        Crossfade snapshots
      </ContextMenuCheckboxItem>,
    );
  }
  return items;
}

/**
 * 5 — LINKS, not editors. The inspector already renders effects, animation
 * and sound properly; the menu's job is to take you there (the sidebar comes
 * back if it was hidden) — never to render a second, worse copy of it.
 */
function goToSection(doc: MotionDocument, clips: Clip[]): Section {
  const tabs = inspectorTabs(clips, doc);
  const effects = clips.length === 1 && isVisualClip(clips[0]!) ? clips[0]!.effects.length : 0;
  const sounding = clips.some((c) => c.kind === "audio" || c.kind === "video" || clipHasSound(doc, c));
  return [
    tabs.includes("effects") && (
      <ContextMenuItem key="fx" onClick={() => revealInInspector({ tab: "effects" })}>
        <Sparkles /> Effects
        {effects > 0 && <MenuCount>{effects}</MenuCount>}
      </ContextMenuItem>
    ),
    tabs.includes("animate") && (
      <ContextMenuItem key="animate" onClick={() => revealInInspector({ tab: "animate" })}>
        <Activity /> Animate
      </ContextMenuItem>
    ),
    sounding && tabs.includes("sound") && (
      <ContextMenuItem key="sound" onClick={() => revealInInspector({ tab: "sound" })}>
        <Volume2 /> Sound
      </ContextMenuItem>
    ),
    tabs.includes("cues") && (
      <ContextMenuItem key="cues" onClick={() => revealInInspector({ tab: "cues" })}>
        <Captions /> Cues
      </ContextMenuItem>
    ),
  ];
}

/** A quiet right-aligned count on a menu row. */
function MenuCount({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto pl-6 text-[11px] tabular-nums text-muted-foreground/70">{children}</span>;
}

/**
 * 6 — everything that makes something OUT of the layer: a render that stands
 * in for it, cached frames, a file, a library item.
 */
function outputSection(store: DocumentStore, doc: MotionDocument, ids: string[], single: Clip | undefined): Section {
  const renderable = single ? canRenderInPlace(doc, single) : false;
  const rendered = single ? hasOriginal(doc, single) : false;
  const openRender = () => single && useSession.getState().setRenderInPlaceClipId(single.id);
  return [
    renderable && (
      <ContextMenuItem key="render" onClick={openRender}>
        <Zap /> {rendered ? "Render again…" : "Render in place…"}
      </ContextMenuItem>
    ),
    single && hasOriginal(doc, single) && (
      <ContextMenuItem key="original" onClick={() => void switchToOriginal(store, single.id)}>
        <RotateCcw /> Switch to original
      </ContextMenuItem>
    ),
    single && clipPlaybackOf(single) && <CacheSubmenu key="cache" store={store} clip={single} />,
    <ContextMenuSub key="export">
      <ContextMenuSubTrigger>
        <Share /> Export
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuItem onClick={() => useSession.getState().setExportDialogOpen(true, { scope: "selection", medium: "video" })}>
          <Film /> As video…
        </ContextMenuItem>
        <ContextMenuItem onClick={() => useSession.getState().setExportDialogOpen(true, { scope: "selection", medium: "image" })}>
          <ImageIcon /> As image…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void exportSelectionAsFile(store, { clipIds: ids })}>
          <PackageOpen /> As {identity.name} file
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>,
    <ContextMenuItem
      key="library"
      onClick={() => {
        const snapshot = captureLibrarySnapshot(store.getState(), ids);
        if (snapshot) useSession.getState().setAddToLibraryDraft(snapshot);
      }}
    >
      <Library /> Add to library…
    </ContextMenuItem>,
  ];
}

/** 7 — how the layer is held: tied to others, painted from, frozen, shown. */
function stateSection(store: DocumentStore, ids: string[], clips: Clip[], single: Clip | undefined): Section {
  const linked = clips.length >= 2 && clips.every((c) => c.linkGroupId && c.linkGroupId === clips[0]!.linkGroupId);
  const locked = clips.every((c) => c.locked);
  const hidden = clips.every((c) => c.hidden);
  return [
    // DaVinci-style: linked clips select, move, split and delete together.
    clips.length >= 2 && !linked && (
      <ContextMenuItem
        key="link"
        onClick={() => store.update("Link clips", (d) => void linkClips(d, ids))}
      >
        <Link2 /> Link clips
      </ContextMenuItem>
    ),
    clips.some((c) => c.linkGroupId) && (
      <ContextMenuItem key="unlink" onClick={() => store.update("Unlink clips", (d) => unlinkClips(d, ids))}>
        <Unlink2 /> Unlink
      </ContextMenuItem>
    ),
    single ? (
      <ReferenceMenuItem key="ref" target={{ kind: "clip", id: single.id }} />
    ) : (
      <ReferenceMenuItem key="ref" targets={ids.map((id) => ({ kind: "clip" as const, id }))} />
    ),
    <ContextMenuItem key="lock" onClick={() => toggleLockSelection(store)}>
      {locked ? <LockOpen /> : <Lock />}
      {locked ? "Unlock" : "Lock"}
      <ShortcutHint id="edit.lock" />
    </ContextMenuItem>,
    <ContextMenuItem key="hide" onClick={() => toggleHiddenSelection(store)}>
      {hidden ? <Eye /> : <EyeOff />}
      {hidden ? "Show" : "Hide"}
      <ShortcutHint id="edit.hide" />
    </ContextMenuItem>,
  ];
}

/**
 * Combine — Union / Subtract / Intersect / Exclude / Mask on the selection.
 * Shares the inspector Combine row's headless condition + action verbatim, so
 * the menu and the sidebar can never disagree about when combining applies or
 * what it does. Editing an existing group's mode never re-groups.
 */
function CombineMenuItems({ store }: { store: DocumentStore }) {
  // A menu is a snapshot of the selection at the moment it opens: it reads the
  // live stores directly and mounts fresh each time, so it is not memoised.
  "use no memo";
  const ids = useSession.getState().selectedClipIds;
  const info = selectionCompositeInfo(store.getState(), ids);
  if (!info.eligible) return null;
  const current = COMPOSITE_MODES.find((m) => m.mode === info.mode);
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <UnionIcon className="size-4" /> Combine{current ? ` · ${current.label}` : ""}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {COMPOSITE_MODES.map(({ mode, label }) => {
          const Icon = COMPOSITE_ICONS[mode];
          return (
            <ContextMenuItem key={mode} onClick={() => applyCompositeToSelection(store, mode)}>
              <Icon className="size-4" /> {info.mode === mode ? `✓ ${label}` : label}
              {mode === "mask" && <ShortcutHint id="edit.mask" />}
            </ContextMenuItem>
          );
        })}
        {info.groupId !== null && info.mode !== "pass" && (
          <>
            <ContextMenuSeparator />
            {modeUsesStencil(info.mode) && (
              <ContextMenuItem
                onClick={() =>
                  store.update("Swap roles", (d) => void swapGroupRoles(d, info.groupId!))
                }
              >
                <ArrowLeftRight className="size-4" /> Swap roles
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => applyCompositeToSelection(store, "pass")}>
              <Group /> Release to plain group
            </ContextMenuItem>
          </>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

const LOOP_LABELS: Record<LoopMode, string> = {
  none: "Play once",
  loop: "Loop",
  pingpong: "Ping-pong",
};
const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2];

/**
 * Speed + loop for ANY source-backed clip (nested comp, video, imported
 * audio) — the registry's `clipPlaybackOf` decides who gets these; the write
 * goes through `setClipPlayback`, so new source-backed kinds join for free.
 * Lives in the TIMING section; caching is a source concern and sits below.
 */
function SpeedLoopItems({ store, clip }: { store: DocumentStore; clip: Clip }) {
  // The label reads the speed at the playhead, so the playhead (and the frames
  // that time the clip) come in through React; the actions below read live.
  const playheadMs = useParkedPlayhead();
  const timingDoc = useDocWhen((d) => [d.frames]);
  const playback = clipPlaybackOf(clip);
  if (!playback) return null;
  const keyed = clip.keyframes.some((t) => t.property === SPEED_PROPERTY && t.keys.length > 0);
  const localNow = () => clipLocalClamped(clip, useSession.getState().playheadMs);
  const setPlayback = (patch: Partial<ClipPlayback>) =>
    store.update("Change playback", (d) => {
      const loc = locateClip(d, clip.id);
      if (loc) setClipPlayback(loc.clip, patch);
    });
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Gauge /> Speed · {formatRate(keyed ? speedAt(clip, clipLocalClamped(clip, playheadMs, timingDoc)) : playback.speed)}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {SPEED_PRESETS.map((s) => (
            <ContextMenuItem
              key={s}
              onClick={() => {
                // Once a clip is RAMPED, a preset is a key at the playhead:
                // re-timing the whole clip would rescale every key you placed
                // and move the ramps you built. Before that it is the classic
                // NLE retime, which changes the clip's length with it.
                if (keyed) {
                  store.update("Clip speed", (d) => {
                    const c = locateClip(d, clip.id)?.clip;
                    if (c) setKeyframe(c.keyframes, SPEED_PROPERTY, localNow(), s);
                  });
                  return;
                }
                store.update("Clip speed", (d) => {
                  retimeClip(d, clip.id, s, { ripple: resolveRetimeRipple(d, clip.id) });
                });
              }}
            >
              {!keyed && playback.speed === s ? "✓ " : ""}
              {formatRate(s)}
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          {/* The two gestures that make speed a CURVE rather than a number.
              Both write ordinary keyframes — nothing here is a new kind of
              thing, which is why they are one line each. */}
          <ContextMenuItem
            onClick={() => {
              const at = localNow();
              const rate = keyed ? speedAt(clip, at) || 1 : playback.speed;
              store.update("Freeze frame", (d) => {
                const c = locateClip(d, clip.id)?.clip;
                if (!c) return;
                for (const k of freezeKeys(at, 1000, rate)) {
                  setKeyframe(c.keyframes, SPEED_PROPERTY, k.timeMs, k.value, k.easing);
                }
              });
              toast("Frozen — drag the hatched block to change the hold");
            }}
          >
            <Snowflake /> Freeze frame here
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              const at = localNow();
              const rate = keyed ? speedAt(clip, at) || 1 : playback.speed;
              store.update("Speed ramp", (d) => {
                const c = locateClip(d, clip.id)?.clip;
                if (!c) return;
                for (const k of rampKeys(at, at + 500, rate, rate / 2)) {
                  setKeyframe(c.keyframes, SPEED_PROPERTY, k.timeMs, k.value, k.easing);
                }
              });
            }}
          >
            <Waves /> Ramp to half speed
          </ContextMenuItem>
          {keyed && (
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() =>
                store.update("Flatten speed", (d) => {
                  const c = locateClip(d, clip.id)?.clip;
                  if (c) clearClipKeyframes(c, [SPEED_PROPERTY], localNow());
                })
              }
            >
              <Trash2 /> Flatten to one speed
            </ContextMenuItem>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Repeat /> Loop · {LOOP_LABELS[playback.loop]}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {(Object.keys(LOOP_LABELS) as LoopMode[]).map((mode) => (
            <ContextMenuItem key={mode} onClick={() => setPlayback({ loop: mode })}>
              {playback.loop === mode ? "✓ " : ""}
              {LOOP_LABELS[mode]}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}

/** Per-clip cache override + "bank it now" — a SOURCE concern, not a timing one. */
function CacheSubmenu({ store, clip }: { store: DocumentStore; clip: Clip }) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Database /> Cache · {CACHE_LABELS[clip.cachePolicy ?? "auto"]}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {(Object.keys(CACHE_LABELS) as Array<keyof typeof CACHE_LABELS>).map((mode) => (
          <ContextMenuItem
            key={mode}
            onClick={() => {
              store.update("Clip cache policy", (d) => {
                const loc = locateClip(d, clip.id);
                if (loc) loc.clip.cachePolicy = mode === "auto" ? undefined : mode;
              });
              // "Never" also frees whatever is already banked, so no stale
              // (possibly downscaled) frame lingers in memory — the read-gate
              // already stops it painting, this reclaims the bytes too.
              if (mode === "never") clearClipCache(clip.id);
            }}
          >
            {(clip.cachePolicy ?? "auto") === mode ? "✓ " : ""}
            {CACHE_LABELS[mode]}
          </ContextMenuItem>
        ))}
        {(clip.kind === "video" || clip.kind === "nested") && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => {
                toast("Caching clip…");
                void cacheClipFootprint(store.getState(), clip.id).then((r) => {
                  if (r.status === "done" && r.cached > 0) {
                    toast.success(`Cached ${r.cached} frames`);
                  } else if (r.status === "done") {
                    toast.success("Already cached");
                  } else if (r.status === "playing") {
                    toast("Pause to cache — playing caches as it goes");
                  } else if (r.status === "off") {
                    toast("Caching is off for this clip");
                  } else {
                    toast(`Stopped after ${r.cached} frames — the rest caches in the background`);
                  }
                });
              }}
            >
              <Database /> Cache now
            </ContextMenuItem>
          </>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** Per-clip cache override labels — "auto" follows the timeline switch. */
const CACHE_LABELS = {
  auto: "Auto",
  always: "Always",
  never: "Never",
} as const;

export function FrameMenuItems({ store, frameId }: { store: DocumentStore; frameId: string }) {
  const frames = useDocSelector((d) => d.frames);
  const frame = frames.find((f) => f.id === frameId);
  const otherFrames = frames.filter((f) => f.id !== frameId);
  const isComponent = frame ? isComponentFrame(frame) : false;
  return (
    <>
      {frame?.mode !== "static" && (
        <ContextMenuItem onClick={() => useSession.getState().openTimeline(frameId)}>
          <Film /> {frame?.mode === "flipbook" ? "Open sheet" : "Open timeline"}
        </ContextMenuItem>
      )}
      {frame && !frame.instanceOf && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {React.createElement(FRAME_MODE_META[frame.mode].icon)} Mode
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {FRAME_MODES.map((mode) => (
              <ContextMenuCheckboxItem
                key={mode}
                checked={frame.mode === mode}
                onCheckedChange={() => switchFrameMode(store, frameId, mode)}
              >
                {React.createElement(FRAME_MODE_META[mode].icon)} {FRAME_MODE_META[mode].label}
              </ContextMenuCheckboxItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {/* A whole comp as one reference — every nested clip showing it. */}
      <ReferenceMenuItem target={{ kind: "frame", id: frameId }} />
      <ContextMenuSeparator />
      {!isComponent && (
        <ContextMenuItem onClick={() => createComponentFromFrame(store, frameId)}>
          <Component /> Create component
        </ContextMenuItem>
      )}
      {isComponent && (
        <ContextMenuItem disabled className="text-(--kind-component)">
          <Component /> Component
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void copySelection(store).then((w) => w && toast(`Copied ${w}`))}>
        <Copy /> Copy frame
        <ShortcutHint id="edit.copy" />
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void copySelection(store, true).then((w) => w && toast(`Cut ${w}`))}>
        <Scissors /> Cut frame
        <ShortcutHint id="edit.cut" />
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          let newId: string | null = null;
          store.update("Duplicate frame", (d) => void (newId = duplicateFrame(d, frameId)));
          if (newId) useSession.getState().selectFrame(newId);
        }}
      >
        <Copy /> Duplicate frame
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void copyLinkTo(store, [`frame:${frameId}`])}>
        <Share2 /> Copy link to frame
      </ContextMenuItem>
      {otherFrames.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Film /> Nest into…
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {otherFrames.map((f) => (
              <ContextMenuItem key={f.id} onClick={() => nestFrameInto(store, frameId, f.id)}>
                {f.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() => void pasteClipboard(store, { frameId }).then((w) => w && toast(`Pasted ${w}`))}
      >
        <Clipboard /> Paste
        <ShortcutHint id="edit.paste" />
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        className="text-destructive focus:text-destructive"
        onClick={() => deleteFrames(store, [frameId])}
      >
        <Trash2 /> Delete frame
        <ShortcutHint id="edit.delete" />
      </ContextMenuItem>
    </>
  );
}

/** Create a nested clip of `sourceFrameId` inside `targetFrameId` at the playhead. */
function nestFrameInto(store: DocumentStore, sourceFrameId: string, targetFrameId: string): void {
  const doc = store.getState();
  const source = doc.frames.find((f) => f.id === sourceFrameId);
  const durationMs = Math.max(500, frameContentDurationMs(doc, sourceFrameId));
  const clip = createNestedClip({
    frameId: targetFrameId,
    sourceFrameId,
    startMs: useSession.getState().playheadMs,
    durationMs,
    name: source?.name ?? "Nested",
    // Inherit the source frame's loop mode as the instance default.
    playback: source ? { loop: source.loop } : undefined,
  });
  store.update("Nest frame", (d) => placeClip(d, clip));
  useSession.getState().select([clip.id]);
  toast(`Nested “${source?.name ?? "frame"}”`);
}

/** Menu for empty canvas / lanes: paste is the star. */
export function EmptyAreaMenuItems({ store }: { store: DocumentStore }) {
  // The spot under the cursor is already the selection by the time this opens —
  // the lanes' right-click handler picks it the same way a left-click does, so
  // the menu never has to re-derive where the pointer was. "Close gap" is
  // offered only when that spot lies in a hole.
  const spot = useSession((s) => s.laneSpot);
  const doc = useDoc();
  const gap = spot ? gapAt(doc, spot.trackId, spot.frameId, spot.startMs) : null;
  return (
    <>
      <ContextMenuItem onClick={() => void pasteClipboard(store).then((w) => w && toast(`Pasted ${w}`))}>
        <SquareDashed /> Paste here
        <ShortcutHint id="edit.paste" />
      </ContextMenuItem>
      {gap && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => closeSelectedGap(store)}>
            <BetweenHorizontalEnd /> Close gap
            <ShortcutHint id="edit.delete" />
          </ContextMenuItem>
          <ContextMenuItem onClick={() => closeAllGapsOnTrack(store, gap.trackId, gap.frameId)}>
            <AlignHorizontalJustifyStart /> Close every gap on this track
          </ContextMenuItem>
        </>
      )}
    </>
  );
}
