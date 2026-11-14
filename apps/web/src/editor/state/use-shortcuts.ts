"use client";

import { worldViewportOpen } from "../world/state";
import { openLinkEditor } from "../links/LinkEditor";
import { locationHistory } from "../links/location-history";
import * as React from "react";
import {
  emptyOpacityDigits,
  isOpacityDigitKey,
  pushOpacityDigit,
  type DocumentStore,
  frameStepMs,
  isReferenced,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { deletePickedBlocks, posePickedBlocks, splitPickedBlocks } from "../timeline/pose-block-actions";
import { PAINT_GAP_ON } from "../drawing/PaintScopePods";
import { beginEyedrop, hasEyedropSurface } from "@/lib/eyedropper";
import { soundEngine } from "../audio/sound-engine";
import { spacePan } from "../stage/space-pan";
import { saveProject } from "./save";
import { addMarkerAtPlayhead, deleteMarkers } from "../timeline/markers";
import { setWorkRangeBound } from "../timeline/work-range";
import { activeCompId } from "../timeline/timeline-utils";
import { applyDefaultTransition } from "../timeline/transition-actions";
import {
  copyEdgeDecor,
  cutEdgeDecor,
  deleteEdgeDecor,
  pasteEdgeDecor,
  useEdgeClipboard,
} from "../timeline/edge-decor";
import {
  copySelection,
  deleteFlipbookCells,
  deleteSelection,
  duplicateSelectedClips,
  applyCompositeToSelection,
  flattenSelection,
  flipSelection,
  toggleAutoLayout,
  groupSelection,
  pasteClipboard,
  setSelectionOpacity,
  splitAtPlayhead,
  toggleHiddenSelection,
  toggleLockSelection,
  ungroupSelection,
} from "./clip-actions";
import {
  activeFlipbookCell,
  flipbookCellsInSelection,
  flipbookInContext,
  flipbookRows,
  isClipLocked,
  locateClip,
  selectedCellOf,
  targetFrameId,
} from "@solomotion/core";
import {
  copyKeyframes,
  cutKeyframes,
  deleteKeyframes,
  pasteKeyframes,
} from "./keyframe-actions";
import { selectAllVisibleKeyframes } from "./keyframe-surface";
import { lastPointer } from "../ui/EasingShortcutOverlay";
import {
  clearFlipbookClipboard,
  copyFlipbookCells,
  cutFlipbookCells,
  pasteFlipbookClipboard,
  useFlipbookClipboard,
} from "../drawing/flipbook-clipboard";
import { useDrawing } from "../drawing/drawing-store";
import { handleArrowNav } from "./keyboard-nav";
import {
  fitTimeline,
  freezeSelectionAtPlayhead,
  jumpKeyframe,
  nudgeSelection,
  rippleDeleteSelection,
  selectClipsFrom,
  zoomTimeline,
} from "./timeline-commands";
import { usePanels } from "./panels";
import { usePerform } from "../perform/state";
import { useSession } from "./session";
import { stepOutOfGroup } from "./use-group-focus";
import { redoActive, undoActive } from "./history";
import { peekEditingFps } from "./use-fps";
import { comboFor, comboFromEvent, eventKey, SHORTCUT_DEFS } from "./shortcut-registry";
import { isTypingFocused, isTypingTarget } from "../input/typing-target";

/**
 * The sheet's cells under the CURRENT selection — null when the selection names
 * no frames, so ⌘C/⌘X/Delete fall through to the generic clip clipboard.
 *
 * The rule itself is headless (`flipbookCellsInSelection`); what this adds is
 * the one thing the document cannot know: which SURFACE the key was pressed on.
 * Clicking a cell selects its paint LAYER, so the same id means "this frame" on
 * the sheet and "this rectangle" on the canvas — and resolving it to the cell
 * either way is how Delete with a rectangle selected wiped a whole frame.
 */
function flipbookCellSelection(store: DocumentStore): { flipbookId: string; cellIds: string[] } | null {
  const session = useSession.getState();
  if (session.selectedClipIds.length === 0) return null;
  const doc = store.getState();
  const fb = flipbookInContext(doc, session.activeFrameId);
  if (!fb) return null;
  const cellIds = flipbookCellsInSelection(
    doc,
    fb.id,
    session.selectedClipIds,
    targetFrameId(doc, session.nav.path),
    session.focusedPanel === "canvas" ? "canvas" : "sheet",
  );
  return cellIds.length > 0 ? { flipbookId: fb.id, cellIds } : null;
}

/**
 * Global keyboard dispatch. Commands and their combos live in the shortcut
 * registry (Settings edits them); this hook only maps command ids to actions.
 *
 * Outside the registry, deliberately: Escape (contextual cascade), arrow
 * nudging (four keys + ⇧ multiplier), and ⌘K (must fire while inputs are
 * focused — it lives in CommandPalette).
 */
export function useShortcuts(store: DocumentStore): void {
  React.useEffect(() => {
    const actions: Record<string, (e: KeyboardEvent) => void> = {
      "tool.select": () => useSession.getState().setTool("select"),
      "tool.hand": () => useSession.getState().setTool("hand"),
      "tool.text": () => useSession.getState().setTool("text"),
      "tool.frame": () => useSession.getState().setTool("frame"),
      "tool.rect": () => useSession.getState().setTool("rect"),
      "tool.ellipse": () => useSession.getState().setTool("ellipse"),
      "tool.pen": () => useSession.getState().setTool("pen"),
      "tool.bone": () => useSession.getState().setTool("bone"),
      "tool.brush": () => useSession.getState().setTool("brush"),
      "tool.brushEngine": () => {
        const drawing = useDrawing.getState();
        drawing.setBrushOptions({ engine: drawing.brush.engine === "vector" ? "raster" : "vector" });
        useSession.getState().setTool("brush");
      },
      "tool.eraser": () => {
        // E is contextual: selected keyframes get the easing popover (the
        // long-standing E behavior); otherwise E arms the eraser.
        const session = useSession.getState();
        if (session.selectedKeyframeIds.length > 0) {
          session.setEasingPopoverAt({ x: lastPointer.x, y: lastPointer.y });
          return;
        }
        session.setTool("eraser");
      },
      "tool.fill": () => useSession.getState().setTool("fill"),

      // Each of these toggles between OFF and the everyday value — the same
      // one-click meaning the pods in the options bar carry, so the key and the
      // button are the same gesture by a different route. The graduated
      // settings (which region, how far, how soft) stay behind the pod's hold,
      // because a keystroke is a poor way to pick a number.
      "paint.confine": () => {
        const d = useDrawing.getState();
        d.setScope({ confine: d.scope.confine === "off" ? "inside" : "off" });
      },
      "paint.depth": () => {
        const d = useDrawing.getState();
        d.setScope({ depth: d.scope.depth === "over" ? "under" : "over" });
      },
      "paint.closeGaps": () => {
        const d = useDrawing.getState();
        d.setScope({ closeGapPx: d.scope.closeGapPx > 0 ? 0 : PAINT_GAP_ON });
      },
      "paint.merge": () => {
        const d = useDrawing.getState();
        d.setScope({ merge: d.scope.merge === "off" ? "self" : "off" });
      },
      // The one that needs the document: reference what is selected, or — with
      // nothing selected — go back to referencing the whole picture.
      "paint.reference": () => {
        const ids = useSession.getState().selectedClipIds;
        const d = useDrawing.getState();
        if (ids.length === 0) {
          d.clearRefs();
          return;
        }
        const refs = ids.map((id) => ({ kind: "clip", id }));
        const on = refs.every((r) => isReferenced(d.scope.refs, r));
        for (const r of refs) {
          if (isReferenced(useDrawing.getState().scope.refs, r) === on) useDrawing.getState().toggleRef(r);
        }
      },
      "tool.lasso": () => useSession.getState().setTool("lasso"),
      "tool.eyedropper": () => {
        if (!hasEyedropSurface()) return;
        void beginEyedrop().then((hex) => {
          if (!hex) return;
          void navigator.clipboard?.writeText(hex).catch(() => undefined);
          toast(`${hex} copied to clipboard`);
        });
      },

      // The focused editor first (the Brush Studio and friends own account-level
      // state the document store has no patches for), else the document.
      "edit.undo": () => undoActive(),
      "edit.redo": () => redoActive(),
      "edit.copy": () => {
        // A selected clip-edge decoration (layer animation, glyph animation or
        // cut transition) copies AS ITSELF — one slot, one branch, whichever
        // kind it is.
        const edgeRef = useSession.getState().selectedEdgeDecor;
        if (edgeRef) {
          const what = copyEdgeDecor(store, edgeRef);
          if (what) {
            toast(`Copied ${what}`);
            return;
          }
        }
        // Copying anything else supersedes the edge clipboard, so ⌘V is never
        // ambiguous about which of the two it is about to paste.
        useEdgeClipboard.getState().set(null);
        if (useSession.getState().selectedKeyframeIds.length) {
          const n = copyKeyframes(store);
          if (n) toast(`Copied ${n} keyframe${n > 1 ? "s" : ""}`);
          return;
        }
        const fbSel = flipbookCellSelection(store);
        if (fbSel) {
          copyFlipbookCells(fbSel.cellIds);
          toast(`Copied ${fbSel.cellIds.length} frame${fbSel.cellIds.length > 1 ? "s" : ""}`);
          return;
        }
        void copySelection(store).then((what) => what && toast(`Copied ${what}`));
      },
      "edit.cut": () => {
        const edgeRef = useSession.getState().selectedEdgeDecor;
        if (edgeRef) {
          const what = cutEdgeDecor(store, edgeRef);
          if (what) {
            toast(`Cut ${what}`);
            return;
          }
        }
        useEdgeClipboard.getState().set(null);
        if (useSession.getState().selectedKeyframeIds.length) {
          const n = cutKeyframes(store);
          if (n) toast(`Cut ${n} keyframe${n > 1 ? "s" : ""}`);
          return;
        }
        const fbSel = flipbookCellSelection(store);
        if (fbSel) {
          cutFlipbookCells(fbSel.cellIds);
          toast(`Cut ${fbSel.cellIds.length} frame${fbSel.cellIds.length > 1 ? "s" : ""}`);
          return;
        }
        void copySelection(store, true).then((what) => what && toast(`Cut ${what}`));
      },
      "edit.paste": () => {
        // A copied edge decoration pastes onto EVERY selected clip — the "apply
        // to all" gesture. The GRAIN adapts to the target (a glyph animation
        // dropped on a shape lands as the same preset at layer grain), so this
        // is one branch for all three kinds. It only wins when it is genuinely
        // the most recent copy, because any other copy clears it above.
        const pasteSession = useSession.getState();
        if (useEdgeClipboard.getState().entry && pasteSession.selectedClipIds.length) {
          const n = pasteEdgeDecor(store, pasteSession.selectedClipIds);
          toast(n ? `Pasted onto ${n} layer${n > 1 ? "s" : ""}` : "Nowhere to paste it");
          return;
        }
        // The media library owns ⌘V while focused: it imports clipboard media
        // into the library (no clip placed) via its own paste listener.
        if (useSession.getState().focusedPanel === "media") return;
        if (useSession.getState().selectedKeyframeIds.length) {
          const n = pasteKeyframes(store);
          if (n) toast(`Pasted ${n} keyframe${n > 1 ? "s" : ""}`);
          return;
        }
        const doc = store.getState();
        const session = useSession.getState();
        const fb = flipbookInContext(doc, session.activeFrameId);
        if (fb && useFlipbookClipboard.getState().mode) {
          // A selected VOID slot wins — paste lands exactly there. Otherwise
          // after whichever cell is active (playhead/selection-priority).
          const voidTarget =
            session.selectedFlipbookVoid?.flipbookId === fb.id
              ? { trackId: session.selectedFlipbookVoid.trackId, atMs: session.selectedFlipbookVoid.ms }
              : null;
          const anchor = voidTarget ? null : activeFlipbookCell(doc, fb.id, session.playheadMs, session.selectedClipIds);
          const pasted = pasteFlipbookClipboard(store, fb.id, voidTarget ?? (anchor ? { afterCellId: anchor.id } : null));
          if (pasted) {
            session.select(pasted);
            toast(`Pasted ${pasted.length} frame${pasted.length > 1 ? "s" : ""}`);
          }
          return;
        }
        void pasteClipboard(store).then((what) => what && toast(`Pasted ${what}`));
      },
      "edit.duplicate": () => duplicateSelectedClips(store),
      "edit.delete": () => {
        const session = useSession.getState();
        // Blocks picked on a pose lane are the most specific selection there is.
        if (deletePickedBlocks(store)) return;
        // A selected edge decoration deletes THAT decoration — the cut effect or
        // the animation — never the clip it hangs off.
        if (session.selectedEdgeDecor) {
          deleteEdgeDecor(store, session.selectedEdgeDecor);
          return;
        }
        if (session.selectedKeyframeIds.length) {
          deleteKeyframes(store);
          return;
        }
        if (session.selectedMarkerIds.length) {
          deleteMarkers(store, session.selectedMarkerIds);
          return;
        }
        // A flipbook cell selected ON THE SHEET deletes the WHOLE frame, same
        // brain as ⌘C/⌘X. The same selection reached from the CANVAS is the
        // artwork inside the frame, and falls through to `deleteSelection`.
        const fbSel = flipbookCellSelection(store);
        if (fbSel) {
          deleteFlipbookCells(store, fbSel.cellIds);
          toast(`Deleted ${fbSel.cellIds.length} frame${fbSel.cellIds.length > 1 ? "s" : ""}`);
          return;
        }
        deleteSelection(store);
      },
      "edit.auto-layout": () => toggleAutoLayout(store),
      "edit.flip-h": () => flipSelection(store, "x"),
      "edit.flip-v": () => flipSelection(store, "y"),
      "edit.group": () => groupSelection(store),
      "edit.ungroup": () => ungroupSelection(store),
      "edit.flatten": () => void flattenSelection(store),
      "edit.mask": () => applyCompositeToSelection(store, "mask"),
      "edit.lock": () => toggleLockSelection(store),
      "edit.hide": () => toggleHiddenSelection(store),
      "edit.link": () => void openLinkEditor(store.getState()),
      "view.back": () => locationHistory().back(),
      "view.forward": () => locationHistory().forward(),
      // Picked pose blocks split alone; otherwise the clips under the playhead.
      "edit.split": () => void (splitPickedBlocks(store) || splitAtPlayhead(store)),
      "edit.transition": () => {
        const session = useSession.getState();
        const doc = store.getState();
        const compId = activeCompId(doc, session.activeFrameId);
        if (!compId) return;
        // Scope to the selection's lanes when there is one, so a multi-lane edit
        // can be transitioned selectively; otherwise every unlocked lane gets it.
        const lanes = session.selectedClipIds.length
          ? doc.tracks
              .filter((t) => t.clips.some((c) => session.selectedClipIds.includes(c.id)))
              .map((t) => t.id)
          : undefined;
        // Half a second of slack at the current zoom: close enough to mean "this
        // cut", far enough that the playhead need not be frame-exact.
        const n = applyDefaultTransition(store, compId, session.playheadMs, 500, lanes);
        toast(n ? `Added ${n} transition${n > 1 ? "s" : ""}` : "No cut near the playhead");
      },
      "edit.selectAll": () => {
        const session = useSession.getState();
        // Focus-aware: inside a keyframe surface (curves / dope sheet), ⌘A
        // selects VISIBLE keyframes — the primary clip first, then (2nd press)
        // every shown clip — honouring the hide/collapse filters, not "every
        // clip".
        if (session.focusedPanel === "curves") {
          if (selectAllVisibleKeyframes()) return;
        }
        const doc = store.getState();
        // Inside a flipbook sheet — standing on it OR drilled into one of its
        // cells to paint — ⌘A selects every FRAME (cell) across every row,
        // not just the layers of whichever cell happens to be open.
        const fb = flipbookInContext(doc, session.activeFrameId);
        if (fb) {
          const cellIds = flipbookRows(doc, fb.id).flatMap((r) =>
            r.cells.filter((c) => !isClipLocked(r.track, c)).map((c) => c.id),
          );
          if (cellIds.length) session.select(cellIds);
          return;
        }
        // Every clip of the OPEN comp (matches what the timeline shows).
        const compId = session.activeFrameId ?? doc.frames[0]?.id;
        const ids: string[] = [];
        for (const track of doc.tracks) {
          for (const clip of track.clips) {
            if (clip.frameId === compId && !isClipLocked(track, clip)) ids.push(clip.id);
          }
        }
        if (ids.length) session.select(ids);
      },
      "edit.easing": () => {
        // E over selected keyframes (any panel): the unified easing popover
        // at the cursor, applying to the whole keyframe selection.
        const session = useSession.getState();
        if (session.selectedKeyframeIds.length === 0) return;
        session.setEasingPopoverAt({ x: lastPointer.x, y: lastPointer.y });
      },

      "marker.add": () => addMarkerAtPlayhead(store),

      // The timeline verbs that had no key until now — see `timeline-commands`.
      "edit.selectForward": () => selectClipsFrom(store, "forward"),
      "edit.selectBackward": () => selectClipsFrom(store, "backward"),
      "edit.rippleDelete": () => rippleDeleteSelection(store),
      "edit.nudgeLeft": () => nudgeSelection(store, -1),
      "edit.nudgeRight": () => nudgeSelection(store, 1),
      "edit.freezeFrame": () => freezeSelectionAtPlayhead(store),
      "edit.speed": () => {
        // Not a dialog of its own: Speed lives in the Design tab beside the
        // rest of the clip's playback, and a second copy in a modal would be
        // the same controls twice. The key takes you to the one that exists.
        const s = useSession.getState();
        if (s.selectedClipIds.length === 0) {
          toast("Select a clip to retime");
          return;
        }
        usePanels.getState().setVisible("inspector", true);
        s.setInspectorTab("design");
      },
      "keyframe.prev": () => jumpKeyframe(store, "prev"),
      "keyframe.next": () => jumpKeyframe(store, "next"),
      "timeline.zoomIn": () => zoomTimeline(store, 1.25),
      "timeline.zoomOut": () => zoomTimeline(store, 1 / 1.25),
      "timeline.zoomFit": () => fitTimeline(store),

      "playback.toggle": () => {
        soundEngine.ensure(); // user gesture — safe moment to unlock audio
        useSession.getState().togglePlaying();
      },
      "playback.home": () => useSession.getState().setPlayhead(0),
      "playback.stepBack": () => stepFrame(store, -1),
      "playback.stepForward": () => stepFrame(store, 1),

      "range.in": () => {
        const s = useSession.getState();
        const doc = store.getState();
        setWorkRangeBound(doc, activeCompId(doc, s.activeFrameId), "start", s.playheadMs);
      },
      "range.out": () => {
        const s = useSession.getState();
        const doc = store.getState();
        setWorkRangeBound(doc, activeCompId(doc, s.activeFrameId), "end", s.playheadMs);
      },

      "view.snap": () => {
        // Focus-aware, exactly like the arrow-key gestures: the timeline magnet
        // and the canvas guides are two independent switches, and S flips the
        // one whose surface you last touched.
        const s = useSession.getState();
        if (s.focusedPanel === "canvas") {
          s.setGuides(!s.guides);
          toast(s.guides ? "Guides off" : "Guides on");
        } else {
          s.setSnapping(!s.snapping);
          toast(s.snapping ? "Snapping off" : "Snapping on");
        }
      },
      "view.recording": () => {
        const s = useSession.getState();
        const next = !s.recording;
        s.setRecording(next);
        toast(next ? "Recording mode on" : "Recording mode off");
      },
      "view.perform": () => usePerform.getState().toggle(),
      "view.focusMode": () => {
        usePanels.getState().toggleFocusMode();
        toast(usePanels.getState().focusMode ? "Focus mode on" : "Focus mode off");
      },
    };

    // The digit run in flight. A ref-like local: it must survive between
    // keystrokes but never re-render anything.
    let opacityDigits = emptyOpacityDigits;

    const onKeyDown = (e: KeyboardEvent) => {
      // The target OR the focused element: a text editor that pulled focus
      // during this very keydown (TextEditOverlay's keys-follow-the-edit) is
      // about to receive the character, and the shortcut layer must not act
      // on it as well.
      const typing = isTypingTarget(e.target) || isTypingFocused();

      // Save fires everywhere (even while typing) and always beats the browser's
      // "Save Page As…" — it's the one combo we must intercept before the guard.
      const rawCombo = comboFromEvent(e);
      if (rawCombo && comboFor("file.save") === rawCombo) {
        e.preventDefault();
        void saveProject(store);
        return;
      }

      // An open modal editor claims undo/redo even from a focused field. The
      // Brush Studio is a wall of NumberInputs, so the typing guard would hand
      // ⌘Z to the browser's text undo — which knows nothing about the value the
      // field is displaying, and so does nothing at all. A scope is only ever
      // set by an editor that has real edits to reverse.
      const scope = useSession.getState().undoScope;
      if (scope && rawCombo) {
        if (rawCombo === comboFor("edit.undo")) {
          e.preventDefault();
          scope.undo();
          return;
        }
        if (rawCombo === comboFor("edit.redo")) {
          e.preventDefault();
          scope.redo();
          return;
        }
      }

      if (typing) return;

      // NB: Space is owned separately in the CAPTURE phase below (onSpaceCapture)
      // so it can never reach a focused button/menu/select and self-activate it.

      const session = useSession.getState();

      // Contextual keys stay hardwired.
      if (e.key === "Escape") {
        // A floating layer (a dropdown, a menu, a picker) already spent this
        // Escape closing itself — Radix marks it — so the ladder must not
        // ALSO take a rung: clearing the selection here is what tore a
        // character's editor window down with its own Voice list.
        if (e.defaultPrevented) return;
        // ONE ladder out, walked one rung at a time — the same `exitContext`
        // a double-click on the dimmed canvas walks, so the mouse and the
        // keyboard can never disagree about what "back" means:
        //   interior editor (glyphs / nodes / corners / crop)
        //     → the innermost comp you entered
        //       → the group you drilled
        //         → the active tool
        //           → the selection.
        if (session.selectedPoseBlocks.length) {
          // picked pose blocks let go first: the character stays selected
          session.setSelectedPoseBlocks([]);
        } else if (session.exitContext()) {
          // nothing more: the nav popped a rung
        } else if (stepOutOfGroup(store.getState())) {
          // one group out: the group you were in is now the selection
        } else if (session.tool !== "select") session.setTool("select");
        else if (useFlipbookClipboard.getState().mode) clearFlipbookClipboard();
        else session.clearSelection();
        return;
      }
      // Smart arrow-key gestures — focus-aware (canvas vs timeline), a lattice
      // of selection × modifier too big for the flat shortcut registry. One
      // headless dispatcher owns them (keyboard-nav.ts).
      if (e.key.startsWith("Arrow")) {
        if (handleArrowNav(e, store)) e.preventDefault();
        return;
      }

      // Digits set the selection's opacity — the Photoshop/Figma gesture: 5 =
      // 50%, 5-2 in quick succession = 52%, 0 = back to 100%, 00 = invisible.
      // The state machine is headless (core/opacity-digits); this only owns
      // "when does a keystroke belong to it". Modified digits stay free for
      // ⌘0-style shortcuts, and it needs a selection to act on.
      const digit = eventKey(e);
      // With pose blocks picked a digit is a POSE (1 = the set's first), not an opacity.
      if (/^[1-9]$/.test(digit) && !e.metaKey && !e.ctrlKey && !e.altKey && posePickedBlocks(store, Number(digit))) {
        e.preventDefault();
        return;
      }
      // ⇧ excluded: ⇧0 is 100% zoom (README D5, Figma's binding), not opacity.
      if (isOpacityDigitKey(digit) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (session.selectedClipIds.length === 0) return;
        const step = pushOpacityDigit(opacityDigits, digit, e.timeStamp);
        if (!step) return;
        opacityDigits = step.next;
        e.preventDefault();
        const n = setSelectionOpacity(store, step.percent);
        if (n) toast(`Opacity ${step.percent}%`);
        return;
      }

      const combo = comboFromEvent(e);
      if (!combo) return;
      // Legacy alias: ⌘Y redoes, always.
      if (combo === "mod+y") {
        e.preventDefault();
        redoActive();
        return;
      }
      for (const def of SHORTCUT_DEFS) {
        // ⌘K is owned by CommandPalette (it must fire even while typing).
        if (def.id === "view.palette") continue;
        if (comboFor(def.id) !== combo) continue;
        if (def.id.startsWith("edit.cut") || def.id.startsWith("edit.copy")) {
          // Don't hijack copy/cut when nothing is selected (let the browser act).
          // A clip-edge decoration counts as a selection: it is the thing ⌘C/⌘X
          // act on, and leaving it out of this gate meant a selected transition
          // or animation swallowed the keystroke and did nothing at all.
          if (
            session.selectedClipIds.length === 0 &&
            session.selectedFrameIds.length === 0 &&
            session.selectedKeyframeIds.length === 0 &&
            session.selectedEdgeDecor === null
          )
            return;
        }
        e.preventDefault();
        actions[def.id]?.(e);
        return;
      }
    };

    // ── Space, owned in the CAPTURE phase ────────────────────────────────────
    // Space is globally RESERVED for playback (TAP = play/pause) and the temporary
    // hand tool (HOLD = pan; the Stage reads spacePan.held). Capturing it at the
    // window root — BEFORE it descends to a focused control — guarantees it can
    // NEVER activate a button, menu, or select trigger (the classic "I opened the
    // Add-Clip menu, now Space re-opens it instead of playing" bug). We swallow it
    // for the whole app; editable fields keep Space for typing. One seam, no
    // per-component `onKeyDown` guards anywhere.
    // `isTypingTarget` also honours `[data-capture-keys]`, the opt-in a control
    // that eats raw keystrokes (the shortcut recorder) marks itself with.
    const isEditable = isTypingTarget;
    const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " ";

    const onSpaceDownCapture = (e: KeyboardEvent) => {
      if (!isSpace(e) || isEditable(e.target)) return;
      // ⇧Space is the 3D viewport's add menu (Blender), not playback.
      if (e.shiftKey && worldViewportOpen()) return;
      // Swallow the browser's rapid keydown-repeat so a hold doesn't re-fire.
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) spacePan.press();
    };
    const onSpaceUpCapture = (e: KeyboardEvent) => {
      if (!isSpace(e)) return;
      if (e.shiftKey && worldViewportOpen()) return;
      if (isEditable(e.target)) {
        // A hold that began before focus entered a field must not stick.
        spacePan.cancel();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // A quick TAP (no pan drag) plays/pauses; a hold just ends the pan.
      if (spacePan.release()) {
        soundEngine.ensure();
        useSession.getState().togglePlaying();
      }
    };
    const onBlur = () => spacePan.cancel();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onSpaceDownCapture, true);
    window.addEventListener("keyup", onSpaceUpCapture, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onSpaceDownCapture, true);
      window.removeEventListener("keyup", onSpaceUpCapture, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [store]);
}

function stepFrame(store: DocumentStore, direction: 1 | -1): void {
  const session = useSession.getState();
  // One frame OF THE COMP BEING EDITED — see state/use-fps. Reading a
  // project-wide rate here made "step one frame" a lie in any comp that ran at
  // its own rate.
  const frameMs = frameStepMs(peekEditingFps());
  session.setPlaying(false);
  session.setPlayhead(session.playheadMs + direction * frameMs);
}
