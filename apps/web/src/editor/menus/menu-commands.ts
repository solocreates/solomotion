import { product } from "@/editor/product";
import type { DocumentStore } from "@solomotion/core";
import { toast } from "@/lib/toast";
import { soundEngine } from "../audio/sound-engine";
import { exportJson } from "../export/export-media";
import { deletePickedBlocks, splitPickedBlocks } from "../timeline/pose-block-actions";
import { saveProject } from "../state/save";
import { pickAndImportProject } from "../state/open-project";
import { currentExportScope, exportSelectionAsFile, pickAndImportFiles } from "../io/slice-file";
import {
  copySelection,
  deleteSelection,
  duplicateSelectedClips,
  flattenSelection,
  groupSelection,
  pasteClipboard,
  splitAtPlayhead,
  toggleHiddenSelection,
  toggleLockSelection,
  ungroupSelection,
} from "../state/clip-actions";
import { useAppShell } from "../state/app-shell";
import { usePanels } from "../state/panels";
import { useSession } from "../state/session";
import { redoActive, undoActive } from "../state/history";

/**
 * Every command a menu can invoke. The ids double as the stable contract with
 * the native menu spec (menu-spec.ts) — an item's `command` is one of these, and
 * the desktop shell routes clicks back here. Edit ids mirror the shortcut
 * registry so they read the same everywhere.
 */
export type MenuCommandId =
  | "file.new"
  | "file.open"
  | "file.save"
  | "file.saveAs"
  | "file.import"
  | "file.exportDialog"
  | "file.exportSlice"
  | "file.exportJson"
  | "file.settings"
  | "edit.undo"
  | "edit.redo"
  | "edit.copy"
  | "edit.cut"
  | "edit.paste"
  | "edit.duplicate"
  | "edit.group"
  | "edit.ungroup"
  | "edit.flatten"
  | "edit.split"
  | "edit.lock"
  | "edit.hide"
  | "edit.delete"
  | "view.pixelGrid"
  | "view.rulers"
  | "view.motionPaths"
  | "view.mute"
  | "view.focusMode"
  | "view.palette"
  | "window.variables"
  | "window.console"
  | "help.website"
  | "help.reportBug"
  | "help.feedback";


function withToast(p: Promise<string | null>, verb: string): void {
  void p.then((what) => what && toast(`${verb} ${what}`));
}

/**
 * THE single place a menu action runs — driven identically by the in-window
 * menubar and the native OS menu (the desktop shell routes item clicks to this).
 * Each case calls the exact same unified action the rest of the app uses, so
 * there's no second implementation to keep in sync.
 */
export function runMenuCommand(store: DocumentStore, command: MenuCommandId): void {
  const session = useSession.getState();
  switch (command) {
    // ── File ────────────────────────────────────────────────────────────────
    case "file.new":
      useAppShell.getState().openNewProject();
      return;
    case "file.open":
      void pickAndImportProject(store);
      return;
    case "file.save":
      void saveProject(store);
      return;
    case "file.saveAs":
      void saveProject(store, { forceDialog: true, mode: "save-as" });
      return;
    case "file.import": {
      const doc = store.getState();
      // No frame yet is fine — the import makes one where the media lands.
      const frame = doc.frames.find((f) => f.id === session.activeFrameId) ?? doc.frames[0];
      pickAndImportFiles(store, { frameId: frame?.id ?? "", startMs: session.playheadMs });
      return;
    }
    case "file.exportDialog":
      session.setExportDialogOpen(true);
      return;
    case "file.exportSlice": {
      const scope = currentExportScope(store.getState());
      void exportSelectionAsFile(store, scope.selection);
      return;
    }
    case "file.exportJson":
      exportJson(store.getState());
      return;
    case "file.settings":
      session.setSettingsDialogOpen(true);
      return;

    // ── Edit ────────────────────────────────────────────────────────────────
    case "edit.undo":
      undoActive();
      return;
    case "edit.redo":
      redoActive();
      return;
    case "edit.copy":
      withToast(copySelection(store), "Copied");
      return;
    case "edit.cut":
      withToast(copySelection(store, true), "Cut");
      return;
    case "edit.paste":
      withToast(pasteClipboard(store), "Pasted");
      return;
    case "edit.duplicate":
      duplicateSelectedClips(store);
      return;
    case "edit.group":
      groupSelection(store);
      return;
    case "edit.ungroup":
      ungroupSelection(store);
      return;
    case "edit.flatten":
      void flattenSelection(store);
      return;
    case "edit.split":
      if (!splitPickedBlocks(store)) splitAtPlayhead(store);
      return;
    case "edit.lock":
      toggleLockSelection(store);
      return;
    case "edit.hide":
      toggleHiddenSelection(store);
      return;
    case "edit.delete":
      if (!deletePickedBlocks(store)) deleteSelection(store);
      return;

    // ── View ────────────────────────────────────────────────────────────────
    case "view.pixelGrid":
      session.setPixelGrid(!session.pixelGrid);
      return;
    case "view.rulers":
      session.setRulers(!session.rulers);
      return;
    case "view.motionPaths":
      session.setMotionPaths(!session.motionPaths);
      return;
    case "view.mute": {
      const next = !session.muted;
      session.setMuted(next);
      soundEngine.setMuted(next);
      return;
    }
    case "view.focusMode":
      usePanels.getState().toggleFocusMode();
      return;
    case "view.palette":
      session.setCommandPaletteOpen(true);
      return;

    // ── Window ──────────────────────────────────────────────────────────────
    case "window.variables":
      session.setVariablesOpen(true);
      return;
    case "window.console":
      session.setConsoleOpen(true);
      return;

    // ── Help ────────────────────────────────────────────────────────────────
    case "help.website":
      window.open(product.siteUrl, "_blank", "noopener,noreferrer");
      return;
    case "help.reportBug":
      product.feedback.open("bug");
      return;
    case "help.feedback":
      product.feedback.open("feedback");
      return;
  }
}
