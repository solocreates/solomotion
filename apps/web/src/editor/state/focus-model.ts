/**
 * The unified focus brain — ONE headless resolver for "what does a double-click
 * do right now?", shared by the stage and the timeline so drilling behaves
 * identically on both. No React, no DOM.
 *
 * The model: every layer is first just a selectable thing. A double-click walks
 * a single progressive path:
 *
 *   outermost group → … → innermost group → the leaf clip → the clip's OWN editor
 *
 * Each double-click advances exactly one step (Figma "deep select"). The group
 * steps are kind-agnostic (`nextEnterGroup` in core). Only the terminal step —
 * entering the clip's own editor — is kind-specific, and THAT is the one
 * extension point: `clipEditMode` maps a clip kind to its deeper mode (text
 * edit, vector nodes, shape corners, …). Adding a new editable kind is one line
 * there, exactly like the base-layer/OOP-extension split Shayan asked for.
 *
 * Surfaces call `resolveEnter` to get a `FocusAction`, run `applyEnter` to
 * perform the surface-agnostic part (drill / select), and — only if an editor
 * step is returned — open that editor in whatever way makes sense for the
 * surface (an inline overlay on the stage, drilling a comp in the timeline, …).
 */

import {
  type MotionDocument,
  type Clip,
  type DocumentStore,
  clipAncestorGroups,
  expandSelectionToGroups,
  nextEnterGroup,
  speaksForMembers,
} from "@solomotion/core";
import { isSvgImageClip, openSvgClipAsVectors } from "../assets/import";
import { usePluginWindows } from "../plugins/plugin-windows";
import { useSession } from "./session";
import { useWorldUi } from "../world/state";
import { openWorldFrame } from "../world/make-3d";
import { editElementsOf } from "../world/edit-targets";

/**
 * The intrinsic "deeper" mode a clip enters on a terminal double-click — the
 * OOP-extended behavior layered on top of the base "just a selectable layer".
 * `null` = no deeper mode (a plain shape/image/video): landing on it is the end
 * of the road. This map is the single source of truth for editability.
 */
export type EditMode =
  | "text" // inline glyph editor
  | "vectorNodes" // Bézier node edit
  | "shapeCorners" // draggable shape corners (stays a shape)
  | "nestedComp" // drill into the composition
  | "waveform" // the visualizer plugin
  | "svgVectors" // vectorize an SVG image, then drill in
  | "crop" // the on-stage crop window (box media's own editor)
  | "world"; // a layer in a 3D world: the viewport's own editor for its kind

export function clipEditMode(doc: MotionDocument, clip: Clip): EditMode | null {
  // In a WORLD every layer edits in the viewport: a mesh its polygons, a path
  // or a stroke its points, a shape its points (made a path), a picture its
  // crop, a text its words. A nested comp still opens its timeline.
  if (clip.kind !== "nested" && doc.frames.find((f) => f.id === clip.frameId)?.world) {
    return clip.kind === "text" || editElementsOf(clip.kind).length > 0 ? "world" : null;
  }
  switch (clip.kind) {
    case "text":
      // Including a caption: double-clicking one opens the SAME inline glyph
      // editor, because a caption is a text clip. Its cue list is a tab.
      return "text";
    case "path":
      return "vectorNodes";
    case "nested":
      return "nestedComp";
    case "waveform":
      return "waveform";
    case "image":
      return isSvgImageClip(doc, clip) ? "svgVectors" : "crop";
    case "video":
      // Box media has no interior to drill, but it DOES have an editor: the
      // crop window. Routing it through here (instead of the stage's old
      // image/video special-case, which fired before the group walk) means a
      // double-click on a grouped photo drills the group first, like every
      // other kind.
      return "crop";
    case "shape":
      // Rect/polygon/star edit their corners; ellipses have no corner editor.
      return clip.shape !== "ellipse" ? "shapeCorners" : null;
    default:
      return null;
  }
}

/** What a double-click resolves to, given where the drill currently stands. */
export type FocusAction =
  /** Step one level deeper into the group tree; select the unit at that level. */
  | { type: "enterGroup"; groupId: string; select: string[] }
  /** Land on the leaf clip (nothing deeper to enter yet). */
  | { type: "selectClip"; clipId: string }
  /** The clip is already the sole selection — open its own editor. */
  | { type: "editClip"; clipId: string; mode: EditMode };

export interface FocusContext {
  /** How deep we've drilled (session.enteredGroupId). */
  enteredGroupId: string | null;
  /** The current selection — used to tell "just landed" from "already here". */
  selectedClipIds: readonly string[];
}

/**
 * THE double-click resolver. Advances the drill by one step and reports the
 * intent. Identical on stage and timeline — the surface only differs in how it
 * executes the terminal `editClip`.
 */
export function resolveEnter(doc: MotionDocument, clip: Clip, ctx: FocusContext): FocusAction {
  // Double-clicking the GROUP ITSELF enters it — the one case the member-based
  // drill below cannot express, because a group clip's own `groupId` names its
  // PARENT, so asking "what do I enter next on the way to this clip" would step
  // out of the thing you just double-clicked.
  if (clip.kind === "group" && ctx.enteredGroupId !== clip.id) {
    return { type: "enterGroup", groupId: clip.id, select: [clip.id] };
  }
  const next = nextEnterGroup(doc, clip.id, ctx.enteredGroupId);
  const part = next ? characterPart(doc, clip, ctx) : null;
  if (part) return { type: "enterGroup", groupId: part.parentId, select: [part.id] };
  if (next) {
    // Drill one level in and select the unit that level represents (its child
    // group toward the clip, or the clip itself when directly inside).
    return { type: "enterGroup", groupId: next, select: expandSelectionToGroups(doc, [clip.id], next) };
  }
  // No group left to enter: we're at the clip. If it's already sitting alone in
  // the selection, the gesture graduates to opening the clip's own editor;
  // otherwise this double-click simply lands on it (the next one edits).
  const sole = ctx.selectedClipIds.length === 1 && ctx.selectedClipIds[0] === clip.id;
  const mode = clipEditMode(doc, clip);
  if (sole && mode) return { type: "editClip", clipId: clip.id, mode };
  return { type: "selectClip", clipId: clip.id };
}

/**
 * INSIDE A CHARACTER, a double-click lands on the PART under the cursor — the
 * outermost unit below the rig that moves as one (an eye's switch, a rigid
 * group), else the drawn layer itself — not one nesting level at a time
 * (Pip › Head › Eye.L › Open › path was four double-clicks to reach an eye).
 * Spine and Character Animator select the attachment you clicked; this is
 * that. Null when the clip is not in a rig, or the part is already where the
 * drill stands (then the ordinary drill continues inside it).
 */
function characterPart(doc: MotionDocument, clip: Clip, ctx: FocusContext): { id: string; parentId: string } | null {
  const ancestors = clipAncestorGroups(doc, clip.id); // inner → outer
  const rigAt = ancestors.findIndex((g) => !!g.rig?.bones.length);
  if (rigAt < 0) return null;
  // Between the clip and the rig: the outermost group that speaks for its members.
  let part: Clip = clip;
  for (let i = rigAt - 1; i >= 0; i--) if (speaksForMembers(ancestors[i]!)) { part = ancestors[i]!; break; }
  const partAt = part === clip ? -1 : ancestors.indexOf(part as (typeof ancestors)[number]);
  const parent = ancestors[partAt + 1];
  if (!parent) return null;
  // Already at (or inside) the part: let the ordinary drill go deeper.
  const inside = ctx.enteredGroupId !== null && (ctx.enteredGroupId === part.id || ancestors.slice(0, Math.max(partAt, 0)).some((g) => g.id === ctx.enteredGroupId));
  const landed = ctx.enteredGroupId === parent.id && ctx.selectedClipIds.length === 1 && ctx.selectedClipIds[0] === part.id;
  if (inside || landed) return null;
  return { id: part.id, parentId: parent.id };
}

/** Minimal session surface the drill/select steps need. */
interface FocusSession {
  setEnteredGroup: (groupId: string | null) => void;
  select: (ids: string[], additive?: boolean) => void;
  /** Open a group BECAUSE the drill entered it — closed again on the way out. */
  openGroupForDrill: (groupId: string) => void;
}

/**
 * Perform the surface-agnostic part of a `FocusAction` (drill or select). If the
 * action is a terminal `editClip`, nothing is done here — it's returned so the
 * caller can open the right editor for its surface. Keeps the drill byte-for-
 * byte identical everywhere while letting editors stay surface-appropriate.
 */
export function applyEnter(action: FocusAction, session: FocusSession): { clipId: string; mode: EditMode } | null {
  switch (action.type) {
    case "enterGroup":
      session.setEnteredGroup(action.groupId);
      // Entering a group SHOWS you inside it. A drill that left the rows folded
      // would have put you in a context with nothing visible in it.
      session.openGroupForDrill(action.groupId);
      session.select(action.select);
      return null;
    case "selectClip":
      session.select([action.clipId]);
      return null;
    case "editClip":
      return { clipId: action.clipId, mode: action.mode };
  }
}

/**
 * What each editor is CALLED — the menu has to name the double-click, and the
 * name must come from the same table the gesture does or the two drift.
 */
export const EDIT_MODE_LABELS: Record<EditMode, string> = {
  text: "Edit text",
  vectorNodes: "Edit points",
  shapeCorners: "Edit corners",
  nestedComp: "Open timeline",
  waveform: "Edit visualizer…",
  svgVectors: "Edit vectors",
  crop: "Crop",
  world: "Edit",
};

/**
 * OPEN a clip's own editor — the terminal step of the drill, in one place.
 * Double-click (stage and timeline) and the right-click menu's top item all
 * call THIS, so "what does entering this layer do?" has a single answer per
 * kind. Adding an editable kind stays two lines: `clipEditMode` + a case here.
 */
export function openClipEditor(store: DocumentStore, clip: Clip, mode: EditMode): void {
  const session = useSession.getState();
  // A layer standing in a 3D WORLD has the world's editors, not the canvas's:
  // the canvas's node leaf is never drawn there (it showed as "› nodes" in the
  // breadcrumb with no points anywhere). The viewport opens the right one.
  const home = store.getState().frames.find((f) => f.id === clip.frameId);
  if (home?.world && clip.kind !== "nested") {
    openWorldFrame(store, home.id, [clip.id]);
    useWorldUi.getState().set({ editRequest: clip.id });
    return;
  }
  switch (mode) {
    case "text": {
      if (clip.kind !== "text") break;
      // Land the playhead inside the clip so keyframed glyphs render while editing.
      const { startMs, durationMs } = clip;
      if (session.playheadMs < startMs || session.playheadMs > startMs + durationMs) {
        session.setPlayhead(startMs + Math.min(durationMs - 1, durationMs * 0.5));
      }
      session.enterLeaf(clip.id, "text");
      break;
    }
    case "vectorNodes":
      // Paths edit their Bézier nodes (pen-tool anatomy) — a LEAF of the same
      // navigation the comp drill uses, which is why Escape, the breadcrumb
      // and the isolation scrim all understand it without extra wiring.
      session.enterLeaf(clip.id, "vectorNodes");
      break;
    case "shapeCorners":
      // Rect/polygon/star edit their CORNERS — draggable points that stay a
      // shape (never a path). Ellipses have no corner editor (mode === null).
      session.enterLeaf(clip.id, "shapeCorners");
      break;
    case "crop":
      // Box media has no inside to drill; its editor is the crop window.
      session.enterLeaf(clip.id, "crop");
      break;
    case "nestedComp":
      // Step in. Nothing about the stage changes: same camera, same page, same
      // pixels — only the TIMELINE re-scopes and everything outside dims. The
      // scope registry decides whether this particular inside is edited in
      // place or on its own canvas, so this call is identical for a component
      // instance, a private nested comp, a flipbook and a drawing.
      session.enterClip(clip.id);
      break;
    case "waveform":
      // A waveform visualizer IS its own editor — open the plugin.
      usePluginWindows.getState().open("waveform");
      break;
    case "svgVectors":
      // An SVG opens as an editable nested frame: converts to vectors, nests
      // them, and drills in — Figma's "enter". Each path is then selectable.
      void openSvgClipAsVectors(store, clip.id);
      break;
  }
}
