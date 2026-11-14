"use client";

import * as React from "react";
import { type Asset } from "@solomotion/core";
import {
  AlertTriangle,
  ClipboardPaste,
  Copy,
  CopyPlus,
  FileVideo,
  Folder,
  FolderInput,
  FolderPlus,
  ImageIcon,
  Link2,
  Music,
  Pencil,
  RefreshCw,
  Scissors,
  SlidersHorizontal,
  Trash2,
  Unlink,
  Upload,
} from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ShortcutHint } from "../state/ShortcutHint";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Breadcrumb } from "../filer/Breadcrumb";
import { NewFolderDialog } from "../filer/NewFolderDialog";
import { childCount, computeView, isDescendant, type FilerNode, type SortKey } from "../filer/model/tree";
import { useFilerKeys } from "../filer/use-filer-keys";
import { usePanelFocus } from "../state/panel-focus";
import { usePanelZoom } from "../state/use-panel-zoom";
import { useSession } from "../state/session";
import { useFiler, useFilerManager } from "../filer/use-file-manager";
import { useMarquee } from "../filer/use-marquee";
import { assetObjectURL, hasAssetBlob } from "../assets/asset-store";
import { importFilesAsAssets, importFolderTree, relinkAssetBytes } from "../assets/import";
import { appFilesToFiles } from "../assets/app-file";
import { pickFolder, readDataTransferFiles } from "../assets/folder-import";
import {
  canLinkFolders,
  linkFolder,
  rescanLinkedFoldersOnFocus,
  resumeLinkedWatches,
  syncLinkedFolder,
  unlinkFolder,
  useLinkedSync,
} from "../assets/linked-folder";
import { platform } from "@/editor/platform";
import { assetIdsUnder, clipsUsingAssets, orphanClipRefs, type ClipRef } from "../assets/media-usage";
import { useDocSelector, useDocStore } from "../state/document-context";
import { AffectedClipsList } from "./AffectedClips";
import { createMediaAdapter } from "./media-adapter";
import { useMediaReviewUi } from "./MediaReviewDialog";
import { useMediaDrag } from "./use-media-drag";
import { DRAG_OUT_SURFACE } from "./drag-out";
import { BrowserFilters, BrowserSearch } from "./BrowserControls";
import { DRAG_OUT_PROPS } from "./drag-out";
import { isTypingFocused } from "../input/typing-target";

/**
 * The media library — a full file manager over the project's imported media,
 * built on the same headless `filer/` engine as the project home. Folders
 * (saved in the document), multi-select, drag into folders or OUT onto the
 * canvas/timeline (with the live clip preview), search + sort, grid/list layout
 * at three sizes, and a rich right-click. Import once, place many; the tree is
 * kept in lockstep with the document so undo, import and bundle round-trips all
 * reflect here immediately.
 */

type ViewMode = "grid" | "list";
const VIEW_KEY = "tm-media-view";

/** The natural width of a card, in CSS px. Panel zoom scales from here. */
const TILE_PX = 120;

const SORTS: { value: SortKey; label: string }[] = [
  { value: "updated", label: "Date added" },
  { value: "name", label: "Name" },
];

export function MediaLibrary() {
  const store = useDocStore();
  const adapter = React.useMemo(() => createMediaAdapter(store), [store]);
  const fm = useFilerManager(adapter);

  // Clips whose backing media isn't in the library (played from cached bytes) —
  // they won't survive a save until re-imported. Recomputed on any doc change.
  const [orphans, setOrphans] = React.useState<ClipRef[]>([]);

  // Keep the filer tree in lockstep with the document (import, undo, external
  // edits). immer gives new array refs only when assets/folders actually change.
  React.useEffect(() => {
    let prevA = store.getState().assets;
    let prevF = store.getState().mediaFolders;
    let orphanSig = "";
    const recompute = () => {
      const d = store.getState();
      if (d.assets !== prevA || d.mediaFolders !== prevF) {
        prevA = d.assets;
        prevF = d.mediaFolders;
        void fm.getState().refresh();
      }
      const refs = orphanClipRefs(d);
      const sig = refs.map((r) => r.clipId).join(",");
      if (sig !== orphanSig) {
        orphanSig = sig;
        setOrphans(refs);
      }
    };
    recompute();
    return store.subscribe(recompute);
  }, [store, fm]);

  const [view, setView] = usePersisted<ViewMode>(VIEW_KEY, "grid");
  const [folderDialog, setFolderDialog] = React.useState<{ open: boolean; moveIds: string[] | null }>({
    open: false,
    moveIds: null,
  });
  const [deleteIds, setDeleteIds] = React.useState<string[] | null>(null);
  const [dropActive, setDropActive] = React.useState(false);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const { beginDrag, ghostNode } = useMediaDrag(fm);
  const { onPointerDown: onMarqueeDown, marqueeNode } = useMarquee(fm, scrollRef);
  // Reusable, workspace-persisted panel zoom (⌘-scroll / pinch + ⌘±/⌘0), applied
  // as CSS `zoom` on the grid/list content — the same primitive as the app's
  // Interface scale. Gated to when the media panel is focused for the keys.
  const zoom = usePanelZoom("media", {
    scrollRef: viewportRef,
    isActive: () => useSession.getState().focusedPanel === "media",
  });
  // Delete (and every other filer shortcut) only fires while this panel
  // actually holds keyboard focus — same focusedPanel brain the stage/
  // timeline/curves panels already claim on pointer-down, so a flipbook cell
  // or a clip stays the Delete target even while a stale media selection
  // lingers here.
  const { bind: panelFocusBind, focused: mediaFocused } = usePanelFocus("media");
  useFilerKeys(fm, { gridRef, onRequestDelete: setDeleteIds, enabled: mediaFocused });

  const tree = useFiler(fm, (s) => s.tree);
  const currentFolderId = useFiler(fm, (s) => s.currentFolderId);
  const sort = useFiler(fm, (s) => s.sort);
  const search = useFiler(fm, (s) => s.search);
  const selected = useFiler(fm, (s) => s.selection.selected);
  const clipboard = useFiler(fm, (s) => s.clipboard);
  const renamingId = useFiler(fm, (s) => s.renamingId);
  const view$ = React.useMemo(
    () => computeView(tree, currentFolderId, sort, search),
    [tree, currentFolderId, sort, search],
  );

  // Which assets have no local bytes (opened a references-only bundle elsewhere).
  const [missing, setMissing] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const gone = new Set<string>();
      for (const it of view$.items) if (!(await hasAssetBlob(it.id))) gone.add(it.id);
      if (alive) setMissing(gone);
    })();
    return () => {
      alive = false;
    };
  }, [view$.items]);

  const importInto = async (files: File[]) => {
    const ids = (await importFilesAsAssets(store, files)).map((a) => a.id);
    if (ids.length && currentFolderId) await fm.getState().move(ids, currentFolderId);
    if (ids.length) toast(`Added ${ids.length} file${ids.length > 1 ? "s" : ""} to media`);
    else if (files.length) toast.error("Nothing importable in that selection");
  };

  // Linked (synced) folders — mirror a real on-disk folder; the record lives in
  // the doc, the live handle/watch behind the platform folder port. Cards read
  // their own linked/sync state; here we only need the "can we link" gate.
  const canLink = React.useMemo(() => canLinkFolders(), []);
  const linkFolderHere = () => void linkFolder(store, currentFolderId);

  // Web has no filesystem watch — re-scan linked folders when the window regains
  // focus. Native watches (resumed once here) push their own changes.
  React.useEffect(() => {
    resumeLinkedWatches(store);
    const onFocus = () => rescanLinkedFoldersOnFocus(store);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [store]);

  const pickFiles = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*,video/*,audio/*";
    input.onchange = () => void importInto([...(input.files ?? [])]);
    input.click();
  };

  // Pick a folder and import it as a named bin (recursive, nested structure
  // preserved). The menu counterpart to dropping a folder onto the panel;
  // non-media (.DS_Store…) is silently skipped.
  const pickFolderInto = () => {
    void pickFolder().then((files) => {
      if (files.length) void importFolderTree(store, files, currentFolderId);
    });
  };

  // ⌘V while the media panel is focused imports clipboard media straight into
  // the library (no clip placed) — the global paste shortcut steps aside for us.
  // Image blobs come off the paste event; on the desktop shell, OS file copies
  // (Finder / Explorer) come through the platform clipboard bridge.
  const importIntoRef = React.useRef(importInto);
  importIntoRef.current = importInto;
  React.useEffect(() => {
    if (!mediaFocused) return;
    const onPaste = (e: ClipboardEvent) => {
      // Never hijack a paste into an actual text field (search, rename…).
      if (isTypingFocused()) return;
      e.preventDefault();
      const fromEvent = e.clipboardData ? Array.from(e.clipboardData.files) : [];
      void (async () => {
        let files = fromEvent;
        if (files.length === 0) {
          files = await appFilesToFiles(await platform.clipboard.readFiles().catch(() => []));
        }
        if (files.length) await importIntoRef.current(files);
      })();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [mediaFocused]);

  const submitNewFolder = async (name: string) => {
    const id = await fm.getState().newFolder(name);
    if (folderDialog.moveIds?.length) await fm.getState().move(folderDialog.moveIds, id);
  };

  const cutIds = clipboard?.mode === "cut" ? new Set(clipboard.ids) : null;
  const nodes = [...view$.folders, ...view$.items];
  // Columns FOLLOW the width, they are not declared. `grid-cols-2` meant the
  // grid stayed two-wide at every zoom and every panel width — zoom just made
  // two tiles bigger — which is the opposite of what a zoom is for. With
  // auto-fill, zooming in shrinks the container's CSS width and the row count
  // falls out; widening the panel adds columns for free.
  // ONE dial. There used to be a second — a small/medium/large slider beside
  // this — and two controls for one fact disagree the moment you touch either:
  // "large" at 60% zoom was smaller than "small" at 140%. Zoom already scales
  // the content continuously and is shared with the library, the stage and the
  // timeline, so it wins and the slider is gone. This is only where it starts.
  const gridStyle = {
    ...zoom.style,
    gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_PX}px, 1fr))`,
  } as React.CSSProperties;

  return (
    <div
      className={cn("relative flex h-full min-h-0 flex-col overflow-hidden", dropActive && "ring-2 ring-inset ring-primary/60")}
      onPointerDownCapture={panelFocusBind.onPointerDownCapture}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={(e) => {
        const dt = e.dataTransfer;
        setDropActive(false);
        if (!dt || (dt.items.length === 0 && dt.files.length === 0)) return;
        e.preventDefault();
        // Recurses any dropped folders (Chromium entries API) into real media
        // bins, falling back to a flat import for loose files. Entries are
        // captured synchronously here; the reads resolve after.
        void readDataTransferFiles(dt).then((files) => {
          if (files.length) void importFolderTree(store, files, currentFolderId);
        });
      }}
    >
      {dropActive && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/5 text-xs font-medium text-primary">
          Drop to import
        </div>
      )}

      {/* Controls — the SAME search field and filter popover the library uses.
          Two panels doing one job had grown two of each: two search fields at
          different heights with different clear buttons, two popovers at
          different widths, a sort dropdown here and a sort toggle group there.
          Nothing about narrowing a list differs between files and presets. */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b p-2">
        <Breadcrumb fm={fm} compact maxDepth={2} />
        <div className="flex items-center gap-1">
          <BrowserSearch value={search.query} onChange={(v) => fm.getState().setSearch(v)} />
          <BrowserFilters
            view={view}
            onView={setView}
            zoom={zoom}
            sort={sort.key}
            sorts={SORTS}
            onSort={(key) =>
              fm.getState().setSort({
                key: key as SortKey,
                dir: sort.key === key && sort.dir === "desc" ? "asc" : "desc",
              })
            }
          />
        </div>
      </div>

      {orphans.length > 0 && (
        <button
          type="button"
          onClick={() => useMediaReviewUi.getState().openReview()}
          className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-2 py-1.5 text-left text-[11px] text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
        >
          <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 truncate">
            {orphans.length} clip{orphans.length > 1 ? "s" : ""} not in library — review
          </span>
        </button>
      )}

      {/* Content */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* `touch-action` on the VIEWPORT, so every tile inherits it and the
              next one cannot forget — see DRAG_OUT_SURFACE. */}
          <ScrollArea
            fill
            viewportRef={viewportRef}
            className="min-h-0 flex-1"
            viewportClassName={DRAG_OUT_SURFACE}
          >
            <div ref={scrollRef} onPointerDown={onMarqueeDown} className="relative flex flex-col p-2">
              {nodes.length === 0 ? (
                <div className="px-4 py-10 text-center text-[11px] leading-relaxed text-muted-foreground">
                  <ImageIcon className="mx-auto mb-2 size-6 opacity-40" />
                  {view$.searching ? "No matches." : "No media here. Import files, or drop them onto the canvas."}
                </div>
              ) : view === "list" ? (
                <div ref={gridRef} style={zoom.style} className="flex flex-col gap-0.5">
                  {nodes.map((node) => (
                    <MediaRow
                      key={node.id}
                      fm={fm}
                      node={node}
                      selected={selected.has(node.id)}
                      cut={cutIds?.has(node.id) ?? false}
                      renaming={renamingId === node.id}
                      missing={missing.has(node.id)}
                      beginDrag={beginDrag}
                      onMoveToNewFolder={(ids) => setFolderDialog({ open: true, moveIds: ids })}
                      onRequestDelete={setDeleteIds}
                    />
                  ))}
                </div>
              ) : (
                <div ref={gridRef} style={gridStyle} className="grid gap-2">
                  {nodes.map((node) => (
                    <MediaCard
                      key={node.id}
                      fm={fm}
                      node={node}
                      selected={selected.has(node.id)}
                      cut={cutIds?.has(node.id) ?? false}
                      renaming={renamingId === node.id}
                      missing={missing.has(node.id)}
                      beginDrag={beginDrag}
                      onMoveToNewFolder={(ids) => setFolderDialog({ open: true, moveIds: ids })}
                      onRequestDelete={setDeleteIds}
                    />
                  ))}
                </div>
              )}
              {marqueeNode}
            </div>
          </ScrollArea>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem onClick={pickFiles}>
            <Upload /> Import files
          </ContextMenuItem>
          <ContextMenuItem onClick={pickFolderInto}>
            <FolderInput /> Import folder…
          </ContextMenuItem>
          {canLink && (
            <ContextMenuItem onClick={linkFolderHere}>
              <Link2 /> Link folder…
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => setFolderDialog({ open: true, moveIds: null })}>
            <FolderPlus /> New folder
          </ContextMenuItem>
          <ContextMenuItem disabled={!clipboard} onClick={() => void fm.getState().paste()}>
            <ClipboardPaste /> Paste
            <ShortcutHint id="edit.paste" />
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Sticky action bar */}
      <div className="flex shrink-0 items-center gap-1 border-t p-2">
        {selected.size > 0 ? (
          <>
            <span className="px-1 text-xs text-muted-foreground">{selected.size} selected</span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setFolderDialog({ open: true, moveIds: [...selected] })}
            >
              <FolderInput className="size-3.5" /> Move
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-destructive hover:text-destructive"
              onClick={() => setDeleteIds([...selected])}
            >
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" size="sm" className="h-8 flex-1 gap-1.5" onClick={pickFiles}>
              <Upload className="size-3.5" /> Import media
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="size-8 shrink-0" title="Folders">
                  <FolderPlus className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setFolderDialog({ open: true, moveIds: null })}>
                  <FolderPlus /> New folder
                </DropdownMenuItem>
                <DropdownMenuItem onClick={pickFolderInto}>
                  <FolderInput /> Import folder…
                </DropdownMenuItem>
                {canLink && (
                  <DropdownMenuItem onClick={linkFolderHere}>
                    <Link2 /> Link folder…
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      <NewFolderDialog
        open={folderDialog.open}
        onOpenChange={(open) => setFolderDialog((s) => ({ ...s, open }))}
        onSubmit={submitNewFolder}
        title={folderDialog.moveIds ? "Move to new folder" : "New folder"}
      />
      <DeleteMediaConfirm
        ids={deleteIds}
        store={store}
        onCancel={() => setDeleteIds(null)}
        onConfirm={() => {
          if (deleteIds) void fm.getState().trashNodes(deleteIds);
          setDeleteIds(null);
        }}
      />
      {ghostNode}
    </div>
  );
}

// ── Shared card behaviour (menu, selection, rename) ────────────────────────

interface NodeProps {
  fm: ReturnType<typeof useFilerManager<Asset>>;
  node: FilerNode<Asset>;
  selected: boolean;
  cut: boolean;
  renaming: boolean;
  missing: boolean;
  beginDrag: (e: React.PointerEvent, node: FilerNode<Asset>) => void;
  onMoveToNewFolder: (ids: string[]) => void;
  onRequestDelete: (ids: string[]) => void;
}

/** What a menu on `nodeId` acts on: the selection when it includes the node, else the node alone. */
const menuIds = (selected: ReadonlySet<string>, nodeId: string) => (selected.has(nodeId) ? [...selected] : [nodeId]);

function useNodeMenu(fm: NodeProps["fm"], node: FilerNode<Asset>) {
  const ids = () => menuIds(fm.getState().selection.selected, node.id);
  const normalize = () => {
    if (!fm.getState().selection.selected.has(node.id)) fm.getState().setSelection([node.id]);
  };
  return { ids, normalize, isFolder: node.kind === "folder" };
}

/** A media folder's link to a folder on disk, or null — subscribed, so the badge follows a relink. */
function useLinkedFolder(id: string, isFolder: boolean) {
  return useDocSelector((d) => (isFolder ? (d.mediaFolders.find((f) => f.id === id)?.linked ?? null) : null));
}

function MediaMenuItems({
  fm,
  node,
  docStore,
  isFolder,
  missing,
  onMoveToNewFolder,
  onRequestDelete,
}: {
  fm: NodeProps["fm"];
  node: FilerNode<Asset>;
  docStore: ReturnType<typeof useDocStore>;
  isFolder: boolean;
  missing: boolean;
  onMoveToNewFolder: (ids: string[]) => void;
  onRequestDelete: (ids: string[]) => void;
}) {
  const tree = useFiler(fm, (st) => st.tree);
  const selected = useFiler(fm, (st) => st.selection.selected);
  const ids = menuIds(selected, node.id);
  const linked = useLinkedFolder(node.id, isFolder);
  const draggedFolderIds = ids.filter((id) => tree.folders.some((f) => f.id === id));
  const currentParents = new Set(
    ids.map((id) => [...tree.folders, ...tree.items].find((n) => n.id === id)?.parentId ?? null),
  );
  const targets = tree.folders.filter(
    (f) =>
      !ids.includes(f.id) &&
      !draggedFolderIds.some((d) => isDescendant(tree, f.id, d)) &&
      !(currentParents.size === 1 && currentParents.has(f.id)),
  );

  return (
    <>
      {!isFolder && (
        <ContextMenuItem disabled={missing} onClick={() => fm.getState().activate(node.id)}>
          <ImageIcon /> Place on frame
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => fm.getState().beginRename(node.id)}>
        <Pencil /> Rename
        <Kbd>F2</Kbd>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => fm.getState().cut()}>
        <Scissors /> Cut
        <ShortcutHint id="edit.cut" />
      </ContextMenuItem>
      <ContextMenuItem onClick={() => fm.getState().copy()}>
        <Copy /> Copy
        <ShortcutHint id="edit.copy" />
      </ContextMenuItem>
      {!isFolder && (
        <ContextMenuItem onClick={() => void fm.getState().duplicateSelection()}>
          <CopyPlus /> Duplicate
          <ShortcutHint id="edit.duplicate" />
        </ContextMenuItem>
      )}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <FolderInput /> Move to
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
<ScrollArea className="max-h-72">
          <ContextMenuItem onClick={() => onMoveToNewFolder(ids)}>
            <FolderPlus /> New folder…
          </ContextMenuItem>
          {!currentParents.has(null) && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => void fm.getState().move(ids, null)}>Media root</ContextMenuItem>
            </>
          )}
          {targets.map((f) => (
            <ContextMenuItem key={f.id} onClick={() => void fm.getState().move(ids, f.id)}>
              {f.name}
            </ContextMenuItem>
          ))}
        </ScrollArea>
        </ContextMenuSubContent>
      </ContextMenuSub>
      {!isFolder && (
        <ContextMenuItem onClick={() => void relinkAssetBytes(docStore, node.id)}>
          <Link2 /> {missing ? "Relink file…" : "Replace file…"}
        </ContextMenuItem>
      )}
      {isFolder && linked && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => void syncLinkedFolder(docStore, node.id)}>
            <RefreshCw /> Sync now
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void unlinkFolder(docStore, node.id)}>
            <Unlink /> Unlink folder
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        className="text-destructive focus:text-destructive"
        onClick={() => onRequestDelete(ids)}
      >
        <Trash2 /> Delete
        <ShortcutHint id="edit.delete" />
      </ContextMenuItem>
    </>
  );
}

function MediaCard(props: NodeProps) {
  const { fm, node, selected, cut, renaming, missing, beginDrag } = props;
  const docStore = useDocStore();
  const menu = useNodeMenu(fm, node);
  const isFolder = node.kind === "folder";
  const linked = useLinkedFolder(node.id, isFolder);
  const syncing = useLinkedSync((st) => st.syncing.has(node.id));
  const count = useFiler(fm, (st) => (isFolder ? childCount(st.tree, node.id) : 0));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-node-id={node.id}
          {...(isFolder ? { "data-drop-folder-id": node.id } : {})}
          onPointerDown={(e) => beginDrag(e, node)}
          {...DRAG_OUT_PROPS}
          onContextMenu={menu.normalize}
          className={cn(
            "group relative flex select-none flex-col overflow-hidden rounded-lg border bg-card text-left transition",
            "data-[drop-over=true]:border-primary data-[drop-over=true]:ring-2 data-[drop-over=true]:ring-primary/60",
            selected ? "border-primary/70 ring-2 ring-primary/50" : "border-border hover:border-primary/50",
            cut && "opacity-45",
            missing && !selected && "border-amber-500/50",
          )}
        >
          <div className="relative flex aspect-4/3 items-center justify-center overflow-hidden border-b bg-stage">
            {isFolder ? <Folder className="size-6 text-muted-foreground/70" /> : <AssetThumb asset={node.data as Asset} missing={missing} />}
            {missing && !isFolder && (
              <span className="absolute left-1 top-1 rounded bg-amber-500/90 px-1 py-0.5 text-[9px] font-semibold text-white">
                Missing
              </span>
            )}
            {linked && (
              <span
                className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-primary/90 px-1 py-0.5 text-[9px] font-semibold text-primary-foreground"
                title={linked.syncedAt ? `Synced ${new Date(linked.syncedAt).toLocaleString()}` : "Linked folder"}
              >
                {syncing ? <RefreshCw className="size-2.5 animate-spin" /> : <Link2 className="size-2.5" />}
                Linked
              </span>
            )}
          </div>
          {renaming ? (
            <RenameInput fm={fm} id={node.id} initial={node.name} />
          ) : (
            <div className="flex items-baseline gap-1 px-1.5 py-1">
              <span className="min-w-0 flex-1 truncate text-[10px] font-medium">{node.name}</span>
              {isFolder && (
                <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">{count}</span>
              )}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <MediaMenuItems fm={fm} node={node} docStore={docStore} isFolder={menu.isFolder} missing={missing} onMoveToNewFolder={props.onMoveToNewFolder} onRequestDelete={props.onRequestDelete} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MediaRow(props: NodeProps) {
  const { fm, node, selected, cut, renaming, missing, beginDrag } = props;
  const docStore = useDocStore();
  const menu = useNodeMenu(fm, node);
  const isFolder = node.kind === "folder";
  const linked = useLinkedFolder(node.id, isFolder);
  const syncing = useLinkedSync((st) => st.syncing.has(node.id));
  const count = useFiler(fm, (st) => (isFolder ? childCount(st.tree, node.id) : 0));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-node-id={node.id}
          {...(isFolder ? { "data-drop-folder-id": node.id } : {})}
          onPointerDown={(e) => beginDrag(e, node)}
          {...DRAG_OUT_PROPS}
          onContextMenu={menu.normalize}
          className={cn(
            "group flex select-none items-center gap-2 rounded-md border px-1.5 py-1 transition",
            "data-[drop-over=true]:border-primary data-[drop-over=true]:ring-1 data-[drop-over=true]:ring-primary/60",
            selected ? "border-primary/60 bg-primary/5" : "border-transparent hover:bg-muted/50",
            cut && "opacity-45",
          )}
        >
          <div className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded border bg-stage">
            {isFolder ? <Folder className="size-4 text-muted-foreground/70" /> : <AssetThumb asset={node.data as Asset} missing={missing} small />}
            {linked &&
              (syncing ? (
                <RefreshCw className="absolute bottom-0.5 right-0.5 size-2.5 animate-spin text-primary" />
              ) : (
                <Link2 className="absolute bottom-0.5 right-0.5 size-2.5 text-primary" />
              ))}
          </div>
          {renaming ? (
            <RenameInput fm={fm} id={node.id} initial={node.name} />
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs">{node.name}</span>
          )}
          {isFolder && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{count} item{count === 1 ? "" : "s"}</span>}
          {missing && !isFolder && <span className="text-[9px] font-semibold text-amber-500">Missing</span>}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <MediaMenuItems fm={fm} node={node} docStore={docStore} isFolder={menu.isFolder} missing={missing} onMoveToNewFolder={props.onMoveToNewFolder} onRequestDelete={props.onRequestDelete} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RenameInput({ fm, id, initial }: { fm: NodeProps["fm"]; id: string; initial: string }) {
  const [value, setValue] = React.useState(initial);
  const commit = () => void fm.getState().commitRename(id, value);
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") fm.getState().cancelRename();
        e.stopPropagation();
      }}
      className="mx-1 my-0.5 min-w-0 flex-1 rounded bg-input/60 px-1 text-xs outline-none ring-1 ring-primary/50"
      spellCheck={false}
    />
  );
}

function DeleteMediaConfirm({
  ids,
  store,
  onCancel,
  onConfirm,
}: {
  ids: string[] | null;
  store: ReturnType<typeof useDocStore>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const n = ids?.length ?? 0;
  const affected = React.useMemo(() => {
    if (!ids || !store) return [];
    const doc = store.getState();
    return clipsUsingAssets(doc, assetIdsUnder(doc, ids));
  }, [ids, store]);

  return (
    <Dialog open={ids !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {n === 1 ? "this item" : `${n} items`}?</DialogTitle>
          <DialogDescription>
            {affected.length > 0
              ? `This unlinks ${affected.length} clip${affected.length > 1 ? "s" : ""} on the timeline — they'll show as missing media until you replace them. Deleting a folder removes everything inside it.`
              : "This removes the media from the project for good. Deleting a folder removes everything inside it."}
          </DialogDescription>
        </DialogHeader>
        {affected.length > 0 && <AffectedClipsList refs={affected} onFocus={onCancel} />}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssetThumb({ asset, missing, small }: { asset: Asset; missing?: boolean; small?: boolean }) {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    if (asset.kind === "audio" || missing) return;
    void assetObjectURL(asset.id, asset.mime).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [asset.id, asset.mime, asset.kind, missing]);

  if (asset.kind === "image" && url && !missing)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={asset.name} draggable={false} className="max-h-full max-w-full object-contain" />;
  if (asset.kind === "video" && url && !missing)
    return <video src={url} muted playsInline preload="metadata" draggable={false} className="max-h-full max-w-full object-contain" />;
  const Icon = asset.kind === "video" ? FileVideo : asset.kind === "audio" ? Music : ImageIcon;
  return <Icon className={cn("text-muted-foreground/60", small ? "size-4" : "size-6")} />;
}

function usePersisted<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = React.useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    return (window.localStorage.getItem(key) as T) || fallback;
  });
  const set = React.useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [value, set];
}
