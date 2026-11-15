"use client";

import { identity } from "@/editor/identity";
import { product } from "@/editor/product";
import * as React from "react";
import {
  Activity,
  AppWindow,
  BookOpen,
  Eye,
  FileText,
  Gift,
  LayoutGrid,
  Menu as MenuIcon,
  Pencil,
  Braces,
  ChevronsDownUp,
  Clipboard,
  Copy,
  Crosshair,
  Diamond,
  Download,
  EyeOff,
  Boxes,
  FileJson,
  FilePlus2,
  FileUp,
  Grid2x2,
  Home,
  Group,
  ImagePlus,
  LayoutPanelTop,
  Maximize,
  Lock,
  PanelBottom,
  PanelLeft,
  PanelRight,
  AudioLines,
  PackageOpen,
  PackagePlus,
  Puzzle,
  Redo2,
  Ruler,
  Save,
  Scissors,
  Search,
  Settings,
  Bug,
  Share2,
  Spline,
  Terminal,
  SquareSlash,
  Trash2,
  Undo2,
  Ungroup,
  VolumeX,
  XSquare,
} from "lucide-react";
import { GestureHint } from "@/components/ui/kbd";
import { toast } from "@/lib/toast";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { soundEngine } from "../audio/sound-engine";
import { exportJson } from "../export/export-media";
import { saveProject } from "../state/save";
import { pickAndImportProject } from "../state/open-project";
import { exportPresets } from "../presets/PresetTransferDialog";
import {
  currentExportScope,
  exportSelectionAsFile,
  pickAndImportFiles,
} from "../io/slice-file";
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
import { usePlugins } from "../plugins/plugins-store";
import { PluginMark } from "../plugins/PluginIcon";
import { usePluginWindows } from "../plugins/plugin-windows";
import { useFloatingPanels } from "../panels/floating-panels";
import { useAppShell } from "../state/app-shell";
import { useDocStore } from "../state/document-context";
import { resolvePanel, usePanels } from "../state/panels";
import { useGraphEditor } from "../timeline/graph-editor";
import { useSession } from "../state/session";
import { useBoardStore } from "../nodes/board-store";
import { ShortcutHint } from "../state/ShortcutHint";
import { useFullscreen } from "../stage/use-fullscreen";
import { duplicateProject } from "../state/project-store";
import { flushAutosave } from "../state/autosave";
import {
  ProjectHero,
  ProjectSwitcherKeys,
  ProjectsTab,
  RecentStrip,
  useLogoMenuRequest,
  useProjectRecords,
  type LogoMenuTab,
} from "../topbar/ProjectSwitcher";
import { Segmented } from "@/components/ui/segmented";
import { useLayout } from "../workspace/store";
import { editorIcon } from "../panels/panel-registry";
import { redoActive, undoActive } from "../state/history";

/**
 * THE LOGO MENU — the way into everything that isn't on the canvas.
 *
 * Two faces on one Radix dropdown (keyboard nav, focus, submenus come from the
 * primitive):
 *
 *   MENU      the project you are in — name, "Saved", Export — then New · Open ·
 *             Home as tiles, ONE row of recent thumbnails, the File · Edit ·
 *             View · Window · Plugins submenus, the agent, the palette,
 *             Settings, and a quiet footer (what's new, docs, a bug, Pro).
 *   PROJECTS  every project as a searchable grid of cards.
 *
 * The face is a fixed size whatever you have made: recents are a row, not a
 * list, so a busy account no longer pushes the commands off the screen.
 * Typing ANYWHERE in the menu switches to Projects with the keystroke in the
 * search — the mark is the fastest way to any project. ⌘⇧O opens on Projects.
 * Every entry calls the same unified actions as its shortcut.
 */
export function AppMenu({ trigger, side }: { trigger?: React.ReactElement; side?: "right" | "bottom" }) {
  const store = useDocStore();
  const view = useAppShell((s) => s.view);
  const inEditor = view === "editor";
  const tabs = useAppShell((s) => s.tabs);
  const currentId = useAppShell((s) => (s.view === "editor" ? (s.pendingProjectId ?? s.currentProjectId) : null));

  const [open, setOpen] = React.useState(false);
  const [face, setFace] = React.useState<LogoMenuTab>("menu");
  const [query, setQuery] = React.useState("");
  const [focusFirst, setFocusFirst] = React.useState(false);
  const [searchSeq, setSearchSeq] = React.useState(0);
  const records = useProjectRecords(open);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setFace("menu");
      setQuery("");
      setFocusFirst(false);
      setSearchSeq(0);
    }
  };
  // ⌘⇧O: the instance whose mark is on screen answers (a hidden dock's never does).
  const requestSeq = useLogoMenuRequest((s) => s.seq);
  React.useEffect(() => {
    if (!requestSeq) return;
    const el = triggerRef.current;
    if (!el || el.getClientRects().length === 0) return;
    setFace("projects");
    setFocusFirst(true);
    setOpen(true);
  }, [requestSeq]);

  // Type-to-search from anywhere in the menu. Runs before Radix's typeahead,
  // which it replaces: jumping to the item that starts with "f" is worth far
  // less than finding the project called "fox".
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.key === " ") return;
    if (e.target instanceof HTMLInputElement) return;
    // Not a tool key either: "t" typed into the menu must not arm the Text tool.
    e.preventDefault();
    e.stopPropagation();
    setFace("projects");
    setFocusFirst(false);
    setQuery((q) => q + e.key);
    setSearchSeq((n) => n + 1);
  };

  const record = currentId ? records?.find((r) => r.id === currentId) : undefined;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <ProjectSwitcherKeys />
      <DropdownMenuTrigger asChild ref={triggerRef}>
        {trigger ?? (
          <button
            type="button"
            aria-label="Main menu"
            // THE MARK IS THE MENU. There is no top bar in the editor to hold a
            // separate "more" button, and the top of the left rail is where a
            // brand anchor belongs — Figma's shape. Home passes its own,
            // larger trigger; the MENU is the same object in both.
            className="group flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-accent"
          >
            <product.Mark className="size-7 transition-transform group-hover:scale-105" />
          </button>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        // The editor's menu hangs off the left rail, so it opens sideways;
        // Home's hangs under a top nav, so it opens down. One menu, two anchors.
        side={side ?? (inEditor ? "right" : "bottom")}
        sideOffset={6}
        className="w-[21rem]"
        onKeyDown={inEditor ? onKeyDown : undefined}
      >
        {inEditor && currentId && <ProjectHero id={currentId} record={record} />}

        {/* Home IS the project browser, so there the menu is commands only. */}
        {inEditor && (
          <div className="px-1 pb-1.5 pt-0.5" onKeyDown={(e) => e.key.startsWith("Arrow") && e.key !== "ArrowDown" && e.stopPropagation()}>
            <Segmented
              stretch
              aria-label="Menu or projects"
              value={face}
              onChange={(next) => {
                setFace(next);
                setFocusFirst(false);
              }}
              options={[
                { value: "menu", label: "Menu", icon: MenuIcon },
                { value: "projects", label: records ? `Projects · ${records.length}` : "Projects", icon: LayoutGrid },
              ]}
            />
          </div>
        )}

        {face === "projects" && inEditor ? (
          <ProjectsTab query={query} setQuery={setQuery} records={records} focusFirst={focusFirst} searchSeq={searchSeq} />
        ) : (
          <>
            <QuickTiles store={store} inEditor={inEditor} />
            {inEditor && (
              <RecentStrip
                records={records}
                exclude={currentId ? [currentId] : tabs}
                onAll={() => {
                  setFace("projects");
                  setFocusFirst(true);
                }}
              />
            )}

            {inEditor && (
              <>
                <DropdownMenuSeparator />
                <AppSubmenus store={store} />
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => useLayout.getState().reveal("agents")}>
                  <AgentIcon /> Ask the agent
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => useSession.getState().setCommandPaletteOpen(true)}>
                  <Search /> Command palette <ShortcutHint id="view.palette" />
                </DropdownMenuItem>
              </>
            )}
            {!inEditor && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => useSession.getState().setSettingsDialogOpen(true)}>
              <Settings /> Settings
            </DropdownMenuItem>
            <MenuFooter />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const AgentIcon = editorIcon("agents");
const openSite = (path: string) => window.open(`${product.siteUrl}${path}`, "_blank", "noopener,noreferrer");

/** New · Open · Home — the three "which project" verbs, as tiles: the tier-1 row. */
function QuickTiles({ store, inEditor }: { store: ReturnType<typeof useDocStore>; inEditor: boolean }) {
  const tile = "flex-1 flex-col justify-center gap-1 py-2 text-meta text-fg-muted focus:text-fg [&_svg]:size-4.5 [&_svg]:text-fg";
  return (
    <div className="flex gap-0.5 pb-1">
      <DropdownMenuItem className={tile} onClick={() => useAppShell.getState().openNewProject()}>
        <FilePlus2 /> New
      </DropdownMenuItem>
      <DropdownMenuItem className={tile} onClick={() => void pickAndImportProject(store)}>
        <FileUp /> Open file
      </DropdownMenuItem>
      {inEditor && (
        <DropdownMenuItem className={tile} onClick={() => useAppShell.getState().goHome()}>
          <Home /> Home
        </DropdownMenuItem>
      )}
    </div>
  );
}

/**
 * The menu's foot: where the app is going, how to learn it, how to tell us it
 * broke, and the product's own row (the way to Pro; Support). Reassurance, not
 * tasks — so it is a quieter band of its own at the bottom edge, full bleed,
 * two columns of left-aligned rows. Four centred items in one row were
 * squeezed to their icons' width and read as a broken toolbar.
 */
function MenuFooter() {
  const item = "gap-2 px-2 text-meta text-fg-muted focus:text-fg [&_svg]:size-3.5";
  return (
    <div className="-mx-1 -mb-1 mt-1 grid grid-cols-2 gap-0.5 border-t border-line bg-[color-mix(in_srgb,var(--foreground)_2.5%,transparent)] p-1">
      <DropdownMenuItem className={item} onClick={() => openSite("/changelog")}>
        <Gift /> What's new
      </DropdownMenuItem>
      <DropdownMenuItem className={item} onClick={() => openSite("/docs")}>
        <BookOpen /> Learn
      </DropdownMenuItem>
      <DropdownMenuItem className={item} onClick={() => product.feedback.open("bug")}>
        <Bug /> Report bug
      </DropdownMenuItem>
      {product.MenuEntry && <product.MenuEntry className={item} />}
    </div>
  );
}

/** File · Edit · View · Window · Plugins — every document command, one hop down. */
function AppSubmenus({ store }: { store: ReturnType<typeof useDocStore> }) {
  const pixelGrid = useSession((s) => s.pixelGrid);
  const rulers = useSession((s) => s.rulers);
  const motionPaths = useSession((s) => s.motionPaths);
  const muted = useSession((s) => s.muted);
  const focusStage = useSession((s) => s.focusStage);
  const focusTime = useSession((s) => s.focusTime);
  return (
    <>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><FileText /> File</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
          <DropdownMenuItem onClick={() => void saveProject(store)}>
            <Save /> Save project <ShortcutHint id="file.save" />
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              void saveProject(store, { forceDialog: true, mode: "save-as" })
            }
          >
            <PackagePlus /> Save project as…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              const doc = store.getState();
              const session = useSession.getState();
              const frame = doc.frames.find((f) => f.id === session.activeFrameId) ?? doc.frames[0];
              // Unified import: media lands as clips, slice files (slices /
              // .motion / .json) merge into the project — one picker for both.
              // No frame yet is fine: the import makes one where media lands.
              pickAndImportFiles(store, {
                frameId: frame?.id ?? "",
                startMs: session.playheadMs,
              });
            }}
          >
            <ImagePlus /> Import media…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              const scope = currentExportScope(store.getState());
              void exportSelectionAsFile(store, scope.selection);
            }}
          >
            <PackageOpen /> Export selection ({identity.sliceExt})
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => exportJson(store.getState())}>
            <FileJson /> Export document (.json)
          </DropdownMenuItem>
          {/* Presets are a LIBRARY, not a document — so they get their own pair
              rather than riding the project's export. A look you built is worth
              keeping when the cut it came from is long finished. */}
          <DropdownMenuItem onClick={() => exportPresets()}>
            <Boxes /> Export presets…
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => useSession.getState().setExportDialogOpen(true)}
          >
            <Download /> Export video / sequence…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DuplicateProjectItem />
            </DropdownMenuSubContent>
          </DropdownMenuSub>

        {/* Everything below needs a document. Rendering it on Home would offer
            Undo, Group and "Mute preview" for a project that isn't open. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger><Pencil /> Edit</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => undoActive()}>
              <Undo2 /> Undo <ShortcutHint id="edit.undo" />
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => redoActive()}>
              <Redo2 /> Redo <ShortcutHint id="edit.redo" />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => withToast(copySelection(store), "Copied")}
            >
              <Copy /> Copy <ShortcutHint id="edit.copy" />
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => withToast(copySelection(store, true), "Cut")}
            >
              <Scissors /> Cut <ShortcutHint id="edit.cut" />
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => withToast(pasteClipboard(store), "Pasted")}
            >
              <Clipboard /> Paste <ShortcutHint id="edit.paste" />
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => duplicateSelectedClips(store)}>
              <Copy /> Duplicate <ShortcutHint id="edit.duplicate" />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => groupSelection(store)}>
              <Group /> Group <ShortcutHint id="edit.group" />
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => ungroupSelection(store)}>
              <Ungroup /> Ungroup <ShortcutHint id="edit.ungroup" />
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void flattenSelection(store)}>
              <Spline /> Flatten to path <ShortcutHint id="edit.flatten" />
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => splitAtPlayhead(store)}>
              <SquareSlash /> Split at playhead <ShortcutHint id="edit.split" />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => toggleLockSelection(store)}>
              <Lock /> Lock / unlock selection <ShortcutHint id="edit.lock" />
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => toggleHiddenSelection(store)}>
              <EyeOff /> Show / hide selection <ShortcutHint id="edit.hide" />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => deleteSelection(store)}
            >
              <Trash2 /> Delete <ShortcutHint id="edit.delete" />
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger><Eye /> View</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuCheckboxItem
              checked={pixelGrid}
              icon={<Grid2x2 />}
              onCheckedChange={(on) => useSession.getState().setPixelGrid(on)}
            >
              Pixel grid
              <GestureHint>4×+ zoom</GestureHint>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={rulers}
              icon={<Ruler />}
              onCheckedChange={(on) => useSession.getState().setRulers(on)}
            >
              Rulers
              <GestureHint>right-click for settings</GestureHint>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={motionPaths}
              icon={<Spline />}
              onCheckedChange={(on) => useSession.getState().setMotionPaths(on)}
            >
              Motion paths
              <GestureHint>on selection</GestureHint>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={muted}
              icon={<VolumeX />}
              onCheckedChange={(on) => {
                useSession.getState().setMuted(on);
                soundEngine.setMuted(on);
              }}
            >
              Mute preview
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={focusStage}
              icon={<Crosshair />}
              onCheckedChange={(on) => useSession.getState().setFocusStage(on)}
            >
              Focus on selection: Stage
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={focusTime}
              icon={<Crosshair />}
              onCheckedChange={(on) => useSession.getState().setFocusTime(on)}
            >
              Focus on selection: Timeline
            </DropdownMenuCheckboxItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger><AppWindow /> Window</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <WindowMenuItems />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger><Puzzle /> Plugins</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">
            <PluginsMenuBody />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
    </>
  );
}

/** Duplicate the open project and switch to the copy (was the header's verb). */
function DuplicateProjectItem() {
  const projectId = useAppShell((s) => s.currentProjectId);
  if (!projectId) return null;
  return (
    <DropdownMenuItem
      onClick={async () => {
        // The copy is made from what is on disk, so write what is on screen first.
        await flushAutosave();
        const copy = await duplicateProject(projectId);
        if (copy) useAppShell.getState().openProject(copy.id);
      }}
    >
      <Copy /> Duplicate project
    </DropdownMenuItem>
  );
}

/**
 * Everything that opens, closes or rearranges a surface: panels, floating
 * windows, the node board, focus mode. Extracted so the app menu's "Window"
 * submenu and the app bar's layout button are two doors into ONE list — the
 * node board in particular used to have a second control (a Stage/Nodes
 * switcher) for the same piece of state.
 */
/**
 * FULLSCREEN — here, with the rest of "how much screen does the app get".
 *
 * It spent a release as a button in the stage's view cluster, permanently over
 * the artwork beside focus mode, which is the same question asked twice: both
 * say "give the canvas the room", one by hiding the app's chrome and one by
 * hiding the browser's. It is a once-a-session decision the OS already has a
 * key for, and the cluster is for things you touch while you work.
 *
 * The state is DERIVED from the browser, never a flag set when the item was
 * clicked — Escape and F11 leave fullscreen without telling the app, and a
 * remembered boolean is wrong the first time anyone uses them.
 */
function FullscreenItem() {
  const fs = useFullscreen();
  if (!fs.supported) return null;
  return (
    <DropdownMenuCheckboxItem checked={fs.active} icon={<Maximize />} onCheckedChange={fs.toggle}>
      Fullscreen
    </DropdownMenuCheckboxItem>
  );
}

export function WindowMenuItems() {
  const left = usePanels((s) => resolvePanel(s, "left"));
  const inspector = usePanels((s) => resolvePanel(s, "inspector"));
  const timeline = usePanels((s) => resolvePanel(s, "timeline"));
  const mixer = usePanels((s) => resolvePanel(s, "mixer"));
  const focusMode = usePanels((s) => s.focusMode);
  const graphOpen = useGraphEditor((s) => s.open);
  const graphTab = useGraphEditor((s) => s.tab);
  const keysActive = graphOpen && graphTab === "keys";
  const curvesActive = graphOpen && graphTab === "curves";
  const pluginCount = usePluginWindows((s) => s.windows.length);
  const floatCount = useFloatingPanels((s) => s.windows.length);
  const variablesOpen = useSession((s) => s.variablesOpen);
  const consoleOpen = useSession((s) => s.consoleOpen);
  const activityOpen = useSession((s) => s.activityOpen);
  const nodesOpen = useBoardStore((s) => s.isOpen);
  const windowCount =
    pluginCount + floatCount + (variablesOpen ? 1 : 0) + (consoleOpen ? 1 : 0) + (activityOpen ? 1 : 0);

  return (
    <>
          <DropdownMenuCheckboxItem
            checked={left}
            icon={<PanelLeft />}
            onCheckedChange={() => usePanels.getState().toggle("left")}
          >
            Assets panel
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={inspector}
            icon={<PanelRight />}
            onCheckedChange={() => usePanels.getState().toggle("inspector")}
          >
            Inspector
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={timeline}
            icon={<PanelBottom />}
            onCheckedChange={() => usePanels.getState().toggle("timeline")}
          >
            Timeline
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={mixer}
            icon={<AudioLines />}
            onCheckedChange={() => usePanels.getState().toggle("mixer")}
          >
            Audio mixer
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={focusMode}
            icon={<LayoutPanelTop />}
            onCheckedChange={() => usePanels.getState().toggleFocusMode()}
          >
            Focus mode <ShortcutHint id="view.focusMode" />
          </DropdownMenuCheckboxItem>
          <FullscreenItem />

          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={nodesOpen}
            icon={<Share2 />}
            onCheckedChange={(v) =>
              v
                ? useBoardStore.getState().open()
                : useBoardStore.getState().close()
            }
          >
            Node board
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={keysActive}
            icon={<Diamond />}
            onCheckedChange={() => useGraphEditor.getState().toggle("keys")}
          >
            Keyframes
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={curvesActive}
            icon={<Spline />}
            onCheckedChange={() => useGraphEditor.getState().toggle("curves")}
          >
            Curves
          </DropdownMenuCheckboxItem>

          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={variablesOpen}
            icon={<Braces />}
            onCheckedChange={(v) => useSession.getState().setVariablesOpen(v)}
          >
            Variables
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={consoleOpen}
            icon={<Terminal />}
            onCheckedChange={(v) => useSession.getState().setConsoleOpen(v)}
          >
            Console
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={activityOpen}
            icon={<Activity />}
            onCheckedChange={(v) => useSession.getState().setActivityOpen(v)}
          >
            Activity
          </DropdownMenuCheckboxItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={windowCount === 0}
            onClick={() => {
              usePluginWindows.getState().minimizeAll();
              useFloatingPanels.getState().minimizeAll();
            }}
          >
            <ChevronsDownUp /> Minimize all windows
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={windowCount === 0}
            onClick={() => {
              usePluginWindows.getState().closeAll();
              useFloatingPanels.getState().closeAll();
              useSession.getState().setVariablesOpen(false);
              useSession.getState().setConsoleOpen(false);
            }}
          >
            <XSquare /> Close all windows
          </DropdownMenuItem>
        </>
  );
}

/**
 * The plugin browser: search + the unified registry (built-in + installed),
 * Figma-style. Opening a plugin mounts its floating window; a built-in's code
 * chunk loads right then, a sandboxed one boots its iframe. Rows wear the same
 * MARK the Plugins panel uses, at menu size — a plugin should look like itself
 * wherever it is listed, and it can ship any art at all. Local state lives here
 * so the search resets each open.
 */
function PluginsMenuBody() {
  const plugins = usePlugins((s) => s.plugins);
  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();
  const matches = plugins.filter(
    (p) =>
      p.enabled &&
      (!q ||
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)),
  );
  return (
    <>
      <div className="p-1.5">
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins…"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            // Keep typing inside the field — Radix menus treat keys as typeahead.
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
      </div>
      <DropdownMenuSeparator />
      {matches.length === 0 && (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {q ? `No plugins match “${query}”` : "No plugins yet."}
        </div>
      )}
      {matches.map((p) => (
        <DropdownMenuItem
          key={p.id}
          onClick={() => usePluginWindows.getState().open(p.id)}
        >
          <PluginMark icon={p.icon} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs">{p.name}</div>
            <div className="truncate text-2xs text-muted-foreground">{p.description}</div>
          </div>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => usePanels.getState().showLeftPanel("plugins")}>
        <Puzzle />
        All plugins
      </DropdownMenuItem>
    </>
  );
}

function withToast(p: Promise<string | null>, verb: string): void {
  void p.then((what) => what && toast(`${verb} ${what}`));
}
