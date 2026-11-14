"use client";

import { useWorldUi } from "./world/state";
import { RenderInPlaceDialog } from "./render/RenderInPlaceDialog";
import { renderProfiler } from "./stage/render/profiler-instance";
import * as React from "react";
import { compFps, createEmptyDocument, flipbookInContext, setFrameMode, frameStepMs, quantizeMsToFrame } from "@solomotion/core";
import { Loader2 } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommunityOpenDialog } from "./home/CommunityView";
import { HomeScreen } from "./home/HomeScreen";
import { AddToLibraryDialog } from "./menus/AddToLibraryDialog";
import { PropertyTransferDialog } from "./menus/PropertyTransferDialog";
import { PluginDock } from "./plugins/PluginDock";
import { usePlugins } from "./plugins/plugins-store";
import { startDevWatch } from "./plugins/dev-folder";
import { VariablesWindow } from "./inspector/variables/VariablesWindow";
import { MachineWindowHost } from "./machines/MachineWindowHost";
import { SaveToLibraryDialog } from "./presets/SaveToLibraryDialog";
import { ConsoleWindow } from "./console/ConsoleWindow";
import { ActivityWindow } from "./runtime/ActivityWindow";
import { PerfHud } from "./stage/PerfHud";
import { CommandPalette } from "./menus/CommandPalette";
import { Navigator } from "./menus/Navigator";
import { FloatingLinkEditorHost } from "./links/LinkEditor";
import { NewProjectDialog, type NewProjectSpec } from "./menus/NewProjectDialog";
import { SaveProjectDialog } from "./menus/SaveProjectDialog";
import { MediaReviewDialog } from "./panels/MediaReviewDialog";
import { PublishDialog } from "./library/PublishDialog";
import { SettingsDialog } from "./menus/SettingsDialog";
import { ExportDialog } from "./export/ExportDialog";
import { GenerateHost } from "./agent/GenerateHost";
import { CenterStage } from "./nodes/CenterStage";
import { restoreCustomFonts } from "./stage/render/fonts";
import { useAudioDurationHeal } from "./audio/heal-durations";
import { useAppShell } from "./state/app-shell";
import { DocumentProvider, useDocStore } from "./state/document-context";
import { createProject, createProjectId } from "./state/project-store";
import { flushAutosave, startAutosave } from "./state/autosave";
import { clearResident, makeResident } from "./state/project-index";
import { useDensitySync } from "./state/use-shell-density";
import { usePanels } from "./state/panels";
import { LeftRail, RightRail } from "./panels/SideRail";
import { BottomRail } from "./panels/BottomRail";
import { FloatingPanelDock } from "./panels/FloatingPanelDock";
import { WorkspaceShell } from "./workspace/WorkspaceShell";
import { TopBar } from "./topbar/TopBar";
import { SupportDialog } from "./support/SupportDialog";
import { installZoomShortcuts } from "./workspace/zoom-shortcuts";
import { DropOverlay } from "./workspace/DropOverlay";
import { usePlayback } from "./state/use-playback";
import { useCacheCeilingNotice } from "./cache/use-cache-ceiling-notice";
import { bindLoadedDocument, releaseClosedDocument } from "./cache/document-release";
import { cacheProducers, cacheSettings, compSubject, hasFrame, setCacheSettings } from "./cache/cache-status";
import { layerCacheBreakdown, layerCoverageSpans } from "./stage/render/layer-cache";
import { lastPresented } from "./stage/render/stage-dirty";
import { boardPictureStats } from "./stage/render/board-pictures";
import { goToPage } from "./state/frame-nav";
import { playbackLog } from "./cache/playback-log";
import * as Core from "@solomotion/core";
import { prerenderRange } from "./preview/prerender";
import { currentFrameVariant, isResolvedAt } from "./stage/render/frame-store";
import { useRigUi } from "./rig/state";
import { useSession, useStageView } from "./state/session";
import { useShortcuts } from "./state/use-shortcuts";
import { installTextPaste } from "./state/text-paste";
import { useTheme, watchSystemMode } from "./theme/use-theme";
import { useStageLive } from "./theme/use-stage-live";
import { useGroupFocus } from "./state/use-group-focus";
import { useSelectionRevealConductor } from "./state/selection-reveal";
import { useUrlSync } from "./state/use-url-sync";
import { usePlayheadMemory, useStillMoments } from "./state/playhead-memory";
import { PresetTransferDialog } from "./presets/PresetTransferDialog";
import { BrushStudio } from "./drawing/BrushStudio";
import { BrushLibraryWindow } from "./pickers/BrushLibraryWindow";
import { EasingShortcutOverlay } from "./ui/EasingShortcutOverlay";
import { PickModeLayer } from "./pick/PickModeLayer";
import { ModifierPuck } from "./input/ModifierPuck";
import { startModifierProjection, startModifierTracking } from "./input/modifiers";
import {
  startPointerTracking,
  startLongPressContextMenu,
  startMultiFingerTaps,
} from "./input/pointer-gestures";
import { startDirectActivation } from "./input/direct-activation";
import { startPageZoomGuard } from "./input/page-zoom-guard";
import { useCoarsePointerSync } from "./input/pointer-env";
import { redoActive, undoActive } from "./state/history";
import { AppBoundary } from "./runtime/ErrorBoundary";
import { NAMES } from "@/editor/names";

export default function Editor() {
  return (
    // The last resort under everything: a render error nothing narrower caught
    // becomes the crash screen with the bug report, not the framework's blank
    // page. The document store outlives the provider (see `theStore`), so a
    // retry here, like the panels' own boundaries below, keeps the document.
    <AppBoundary>
      <DocumentProvider>
        <TooltipProvider delayDuration={400}>
          <AppRoot />
        </TooltipProvider>
      </DocumentProvider>
    </AppBoundary>
  );
}

/** Top-level router: Home vs Editor, sharing one document store + New dialog. */
function AppRoot() {
  const store = useDocStore();
  const setNewProjectOpen = useAppShell((s) => s.setNewProjectOpen);
  useUrlSync(store);
  usePlayheadMemory(store);
  useStillMoments(store);

  // Project the persisted theme onto the DOM for the WHOLE app, not just the
  // editor. It used to run in EditorShell, so Home rendered with none of it —
  // no accent, no radius, and `data-glass` unset, which meant every glass
  // surface silently fell back to its opaque state until you opened a project.
  React.useEffect(() => {
    useTheme.getState().apply();
    return watchSystemMode();
  }, []);

  // ⇧/⌥/⌘ tracked app-wide, from the keyboard AND the on-screen puck. It has to
  // live above the Home/Editor switch: the store is a singleton, and mounting
  // the tracker inside the editor would leave the modifiers frozen at whatever
  // was held when you last left it.
  React.useEffect(() => startModifierTracking(), []);

  /*
   * A latched ⇧/⌥/⌘ from the on-screen puck now reports through `e.shiftKey`
   * itself, so every shift-range and ⌘-toggle in the app works with it —
   * including the ones that read the event directly, which is most of the
   * selection code and all of the component libraries. See
   * `startModifierProjection`.
   */
  React.useEffect(() => startModifierProjection(), []);

  // Publishes `data-pointer` on <html> so hit targets can grow on a tablet
  // through the cascade instead of through a subscription in every control.
  useCoarsePointerSync();

  // The gesture arbiter, and the ONE long-press recognizer built on it. Both
  // are app-wide singletons for the same reason the modifier tracker is: they
  // answer a question ("who owns this pointer") that must have a single answer
  // for the whole window, and a per-surface copy would disagree at the seams.
  //
  // The long press dispatches a real `contextmenu`, so every Radix context menu
  // already in the app — clips, layers, tracks, frames, library cards, media,
  // flipbook cells, the stage — becomes reachable on touch and Pencil from
  // here, with nothing added at any of those sites.
  React.useEffect(() => {
    const stopPointers = startPointerTracking();
    const stopLongPress = startLongPressContextMenu();
    /*
     * A stylus and a finger can press anything. Delegated from the window, so
     * it covers every control in the app — including ones that do not exist
     * yet — rather than the four floating surfaces that had remembered to
     * mount a hook. See `direct-activation` for why the compatibility click
     * cannot be relied on.
     */
    const stopActivation = startDirectActivation();
    /*
     * Two fingers undo, three redo — ONE recognizer, so it works in the
     * timeline, the panels and the node board as well as the stage, and so a
     * tap over nested surfaces cannot undo twice.
     */
    const stopTaps = startMultiFingerTaps({
      onUndo: undoActive,
      onRedo: redoActive,
    });
    /*
     * The page never zooms — a pinch or ⌘+ zooms the stage (see
     * `page-zoom-guard`). Installed here, after the panels' own zoom keys.
     */
    const stopZoomGuard = startPageZoomGuard();
    // ⌘= ⌘− ⌘0 ⇧0: one listener, routed to the view you are in (D5).
    installZoomShortcuts();
    return () => {
      stopZoomGuard();
      stopTaps();
      stopActivation();
      stopLongPress();
      stopPointers();
    };
  }, []);

  // THE LOADED PROJECT IS WHAT IS HELD (`document-release`). Switching projects
  // releases everything the old one built; closing the last one also empties
  // the store, which otherwise kept that whole document and its undo history
  // alive behind Home for the rest of the session.
  React.useEffect(() => {
    bindLoadedDocument(() => (useAppShell.getState().currentProjectId ? store.getState() : null));
    return useAppShell.subscribe((s, prev) => {
      if (s.currentProjectId === prev.currentProjectId) return;
      if (!s.currentProjectId) {
        // The last tab closed: its edits are still in the store, owned by the id the shell just dropped.
        void flushAutosave(store, prev.currentProjectId);
        clearResident();
        store.replace(createEmptyDocument());
      }
      releaseClosedDocument();
    });
  }, [store]);

  const view = useAppShell((s) => s.view);
  const newProjectOpen = useAppShell((s) => s.newProjectOpen);

  const handleCreate = (spec: NewProjectSpec) => {
    const doc = createEmptyDocument(spec.name);
    const frame = doc.frames[0]!;
    frame.width = spec.width;
    frame.height = spec.height;
    if (spec.mode !== "timeline") setFrameMode(doc, frame.id, spec.mode, { atMs: 0 });
    const id = createProjectId();
    void createProject(id, doc);
    makeResident(store, id, doc);
  };

  return (
    <>
      {/*
        `isolate` — THE APP IS ONE STACKING CONTEXT, and every floating window
        lives above it.

        Without it, a `z-index` written anywhere inside the shell competes at
        the ROOT level with the body-portalled windows, and several do. The
        worst is invisible in any component: `.shell-card::after` draws each
        panel's hairline border at `z-50` (it has to paint above the card's own
        contents, or the stage canvas covers its own edge). A panel is `position:
        relative; z-index: auto`, so it establishes no context to trap that 50 —
        and the border of the inspector painted a grey line straight down
        through any window parked over it. It looked exactly like seeing the app
        THROUGH a translucent pane, which is why chasing it through the glass
        tokens never fixed it: the window was already opaque and the line was in
        FRONT of it.
        
        One word here means no z-index inside the app can ever reach a floating
        surface again, whoever writes it and whenever. The stage already does
        this for its own toolbar (see Stage.tsx) — this is the same fix at the
        level the whole shell needed it.
      */}
      <div className="isolate flex h-dvh flex-col overflow-hidden">
        {/* No app-wide bar. It existed to carry the tab strip across the
            Home/Editor switch, but a full-width band also owned the top of the
            window and kept the side rails from reaching it — the dark corners.
            Each screen carries the strip itself now: the editor in its stage
            row, Home in its own header. The tabs themselves live in the store,
            so neither screen owns them. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {view === "home" ? <HomeScreen /> : <EditorShell />}
          <SwitchVeil />
        </div>
      </div>
      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
        onCreate={handleCreate}
      />
      {/* App-scoped, so it lives ABOVE the screen switch. Inside EditorShell it
          could only ever open in the editor, which left Home's menu offering a
          Settings item that opened nothing. Nothing in it reads the document. */}
      <SettingsDialog />
      <CommunityOpenDialog />
      {/* LAST, and outside the `isolate` shell on purpose: the puck modifies
          whatever gesture is on top, so it must paint above the floating
          windows too. It renders nothing at all on a device with a real
          keyboard (see `usePuckVisible`). */}
      <ModifierPuck />
    </>
  );
}

/**
 * Covers the workspace while a tab switch fetches its document.
 *
 * Without it you watch the OUTGOING project sit there — stage, timeline,
 * inspector, all still showing the thing you just left — and then snap to the
 * new one. Even at IndexedDB speed that reads as a glitch rather than as
 * loading, because nothing on screen ever said "this is stale".
 *
 * Deliberately not the boot splash: this is usually under 150ms, and a brand
 * animation for a fetch that fast is theatre. A dim and a spinner, faded in
 * with a delay so a fast switch shows nothing at all.
 */
function SwitchVeil() {
  const switching = useAppShell((s) => s.switching);
  if (!switching) return null;
  return (
    <div
      aria-hidden
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 opacity-0 animate-[switch-veil_240ms_ease-out_120ms_forwards]"
    >
      <Loader2 className="size-5 animate-spin text-primary" />
    </div>
  );
}

function EditorShell() {
  const store = useDocStore();
  usePlayback(store);
  useCacheCeilingNotice();
  useShortcuts(store);
  // Every text field pastes words, never a copied layer's JSON (see the module).
  React.useEffect(() => installTextPaste(), []);
  // Drops the glass blur while the canvas repaints every frame (see the hook).
  useStageLive();
  // Every surface shows what is selected — see the module.
  useSelectionRevealConductor(store);
  // The entered group follows the selection — see the hook.
  useGroupFocus();
  // Dev only: the live document and session, reachable from a console or a
  // driving script — how a change is verified end to end without pixel-reading.
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as Record<string, unknown>)[NAMES.wire.debug("")] = {
      store,
      session: useSession,
      stageView: useStageView,
      rigUi: useRigUi,
      world: useWorldUi,
      presented: lastPresented,
      playbackLog,
      // The stage's rolling per-layer cost — what the perf HUD reads.
      profiler: renderProfiler,
      // What the board's retained pictures hold — rungs and bytes against their share.
      boardPictures: boardPictureStats,
      // Switch pages the one way every surface does.
      goToPage: (pageId: string) => goToPage(store.getState(), pageId),
      cache: { settings: cacheSettings, set: setCacheSettings },
      core: Core,
      // One registry command, the way every AI caller runs it — lazy, so the
      // agent code stays out of the editor chunk.
      call: async (commandId: string, input: unknown) => {
        const [{ callCommand }, { editorApiSession }] = await Promise.all([import("./agent/call"), import("./state/session")]);
        return callCommand(commandId, input, { store, actor: "Test", session: editorApiSession() });
      },
      // A PDF of these frames, returned instead of downloaded — links,
      // bookmarks and pages checked from a script.
      exportPdf: async (frameIds: string[], render: "vector" | "image" = "vector") => {
        const [{ exportPdf }, { collectSaves }] = await Promise.all([import("./export/export-pdf"), import("./export/save")]);
        const doc = store.getState();
        const pages = Core.planExportPages(doc, frameIds, { sampling: "current", currentTimeOf: () => 0 }).pages;
        let result: unknown;
        const files = await collectSaves(async (save) => {
          result = await exportPdf(doc, pages, { render, scale: 1, imageFormat: "jpeg", fileName: "check", save }, { projectId: useAppShell.getState().currentProjectId });
        });
        return { result, pdf: files[0] ? new TextDecoder("latin1").decode(await files[0].blob.arrayBuffer()) : null };
      },
      buildRange: prerenderRange,
      // Cells of a comp's picture coverage (the ruler bar), 0..toMs.
      compCells: (frameId: string, toMs = 10_000) => {
        let n = 0;
        for (let t = 0; t < toMs; t += 1000 / 30) if (hasFrame(compSubject(frameId), t + 1)) n++;
        return n;
      },
      // What every cache holds right now, and which instants of the active
      // comp play from memory — read beside `playbackLog` when a playback
      // report comes in.
      cacheReport: (fromMs = 0, toMs = 10_000) => {
        const doc = store.getState();
        const fid = useSession.getState().activeFrameId;
        const step = fid ? frameStepMs(compFps(doc, fid)) : 1000 / 30;
        const unresolved: number[] = [];
        for (let t = quantizeMsToFrame(fromMs, 1000 / step); t <= toMs; t += step) {
          if (fid && !isResolvedAt(fid, t)) unresolved.push(Math.round(t));
        }
        return {
          producers: cacheProducers().map((p) => ({ id: p.id, label: p.label, ...p.stats() })),
          layerBreakdown: layerCacheBreakdown(),
          variant: currentFrameVariant(),
          unresolved,
          layerSpans: Object.fromEntries(
            doc.tracks.flatMap((t) => t.clips).map((c) => [c.id, layerCoverageSpans(c.id)]),
          ),
        };
      },
    };
  }, [store]);
  useAudioDurationHeal(store);

  // Re-register user-uploaded fonts from IndexedDB.
  React.useEffect(() => {
    void restoreCustomFonts();
  }, []);

  // Keep the session valid against the document — selection, open tabs, and
  // the nav projection (which surface's zoom is being remembered).
  //
  // Once on MOUNT as well as on every change: a project you just opened and
  // have not edited produces no store tick, and the projection it arrived with
  // is the store's pre-document one. Skipping the first sync is what left the
  // timeline naming no surface at all until the first edit.
  React.useEffect(() => {
    const sync = () => {
      const doc = store.getState();
      const clipIds = new Set<string>();
      for (const track of doc.tracks) for (const clip of track.clips) clipIds.add(clip.id);
      const frameIds = new Set<string>(doc.frames.map((f) => f.id));
      useSession.getState().pruneSelection(clipIds, frameIds);
    };
    sync();
    return store.subscribe(sync);
  }, [store]);

  // Autosave the open project (quiet, bounded and flushable — see autosave.ts).
  React.useEffect(() => startAutosave(store), [store]);

  // Load installed plugins once, and keep dev-folder plugins live-reloading.
  React.useEffect(() => {
    void usePlugins.getState().hydrate();
    return startDevWatch();
  }, []);

  return (
    <>
      <WorkspaceLayout />
      <SupportDialog />
      <EasingShortcutOverlay />
      <PickModeLayer />
      <CommandPalette />
      <Navigator />
      <FloatingLinkEditorHost />
      <BrushStudio />
      <BrushLibraryWindow />
      <ExportDialogHost />
      <SaveProjectDialog />
      <MediaReviewDialog />
      <AddToLibraryDialog />
      <RenderInPlaceDialog />
      <PublishDialog />
      <PropertyTransferDialog />
      <GenerateHost />
      <PluginDock />
      <FloatingPanelDock />
      <VariablesWindow />
      <MachineWindowHost />
      <SaveToLibraryDialog />
      <PresetTransferDialog />
      <PerfHud />
      <ConsoleWindow />
      <ActivityWindow />
    </>
  );
}

/**
 * The export dialog's mount point. It used to live inside the top bar, so
 * deleting that bar unmounted the dialog while leaving every caller happily
 * setting `exportDialogOpen` — the button worked, the state changed, and
 * nothing appeared. A dialog belongs with the other dialogs, not inside a
 * piece of chrome that might be redesigned away.
 */
function ExportDialogHost() {
  const open = useSession((s) => s.exportDialogOpen);
  return <ExportDialog open={open} onOpenChange={(v) => useSession.getState().setExportDialogOpen(v)} />;
}

/**
 * The auto-armed WORKSPACE: navigation context decides the panel set. Open a
 * flipbook → the sheet workspace; open a drawing → canvas-first; anything
 * else → the user's own layout. Same restore guarantee as focus mode — the
 * workspace only OVERRIDES flags, never writes them.
 */
function useWorkspaceAutoSwitch() {
  const store = useDocStore();
  const activeFrameId = useSession((s) => s.activeFrameId);
  React.useEffect(() => {
    const apply = () => {
      const doc = store.getState();
      const frame = doc.frames.find((f) => f.id === useSession.getState().activeFrameId);
      // A still inside a sheet is a DRAWING (the sheet keeps its clock); a
      // still on its own is a design — canvas, layers, inspector, no timeline.
      const w = !frame
        ? "default"
        : frame.mode === "flipbook"
          ? "flipbook"
          : flipbookInContext(doc, frame.id)
            ? "drawing"
            : frame.mode === "static"
              ? "static"
              : "default";
      usePanels.getState().setWorkspace(w);
    };
    apply();
    return store.subscribe(apply);
  }, [store, activeFrameId]);
}

/**
 * THE WORKSPACE — one layout, every width.
 *
 * There were two: this one, and a `MobileLayout` that rendered a stage, a
 * timeline and a bar with two sheet buttons. It was written before the rails
 * existed and never learned about them, so on a narrow window the app had no
 * app menu, no undo, no export, no settings, no Library/Media/Layers/Plugins
 * switch, no inspector tabs, no Keyframes/Curves/Nodes — the entire control
 * surface of the editor, gone, because a second implementation of the layout
 * is a second implementation of the GRAMMAR and only one of them was being
 * maintained. That is the bug this deletes.
 *
 * The rails are the spine at every width. What width changes is only how a
 * panel is PRESENTED, and that lives in one place (`resolvePanel` + `density`),
 * not here:
 *
 *   wide     left panel │ stage │ inspector      docked, resizable columns
 *            ───────────────────────────
 *                    bottom region
 *
 *   compact            stage                     side panels FLOAT over the
 *            ───────────────────────────         stage, one at a time
 *                    bottom region
 *                    rail dock                   all three rails, in one bar
 *
 * The bottom region stays docked at both widths deliberately. It is not an
 * inspection surface you visit — it is the thing you are editing, and it has to
 * be on screen at the same time as the canvas.
 *
 * What compact changes about the RAILS is where they are, not what they are:
 * two vertical rails cost 88px of a 375px window permanently, so they move into
 * the bottom bar as groups of the same rail, fed the same item lists (see
 * `RailDock`). Still one grammar — the fork this file exists to prevent is a
 * second component tree, not a second position.
 */
function WorkspaceLayout() {
  // The one place window width becomes a fact. Returns the query's answer
  // directly so the first paint is already correct (see the hook).
  const compact = useDensitySync() === "compact";
  useWorkspaceAutoSwitch();

  // THE CHROME, and the reversal that earned it. The rails used to survive
  // focus mode because they held the way OUT of it — the same rule that keeps a
  // collapse toggle outside the panel it collapses. That way out now lives on
  // the stage itself (`FocusToggle`, beside the zoom), which is the one surface
  // focus mode can never hide, so the rails are free to go with everything
  // else. Focus mode finally means what it says: the canvas, and nothing.
  const focusMode = usePanels((s) => s.focusMode);
  const rails = !focusMode;

  return (
    // THE TOP BAR owns one row (identity, the open projects, Export); the
    // rails start under it, full height to the bottom. It takes room from
    // nothing below it, so opening a project never moves a panel.
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    {rails && <TopBar />}
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Wide only: when the window is narrow these are in the dock at the
          bottom instead (see `BottomRail`) — a position, not a fork. */}
      {rails && !compact && <LeftRail />}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* THE SHELL, rendered from the layout tree (workspace/). Panels are
            cards on a dark ground; the gap between two cards is the separator.
            Compact presents the same tree as stage-over-timeline with every
            other region one overlay away — siblings of the resizable group,
            never members, so opening Properties never resizes the canvas. */}
        <div className="shell-ground relative flex min-h-0 flex-1">
          <WorkspaceShell compact={compact} />
        </div>
        {/* OUTSIDE the shell ground on purpose: the bar can collapse the
            timeline, so it must not live inside the thing it collapses. */}
        {rails && <BottomRail />}
      </div>
      {rails && !compact && <RightRail />}
      <DropOverlay />
    </div>
    </div>
  );
}
