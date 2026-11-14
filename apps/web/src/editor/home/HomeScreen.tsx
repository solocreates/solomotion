"use client";

import { identity } from "@/editor/identity";
import { product } from "@/editor/product";
import * as React from "react";
import { createEmptyDocument } from "@solomotion/core";
import {
  ChevronDown,
  CircleAlert,
  Clock,
  Compass,
  FileUp,
  Film,
  Folder,
  FolderOpen,
  GraduationCap,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Breadcrumb } from "../filer/Breadcrumb";
import { FileGrid } from "../filer/FileGrid";
import { FilerToolbar, type FilerLayout } from "../filer/FilerToolbar";
import { NewFolderDialog } from "../filer/NewFolderDialog";
import { TrashView } from "../filer/TrashView";
import type { FilerItem } from "../filer/model/tree";
import { useFiler, useFilerManager, type FilerStore } from "../filer/use-file-manager";
import { useAppShell } from "../state/app-shell";
import { useDocStore } from "../state/document-context";
import { pickAndImportProject } from "../state/open-project";
import { createProject, createProjectId, getProjectDocument, type ProjectRecord } from "../state/project-store";
import { makeResident } from "../state/project-index";
import { holdPreview } from "../cache/document-release";
import { drawFrameContent } from "../stage/render/draw-frame";
import { ensureDocumentFaces } from "../stage/render/system-fonts";
import { editedAgo } from "../topbar/ProjectSwitcher";
import { createProjectsAdapter } from "./projects-adapter";
import { CommunityView } from "./CommunityView";
import { AppMenu } from "../menus/AppMenu";
import { NAMES } from "@/editor/names";

/**
 * HOME — a file browser first (v5 redesign, D15).
 *
 * Jobs, by frequency: open what I was working on · start something new ·
 * keep projects tidy · find an example. So:
 *  · Tier 1 — Recents, the default view: every project, newest first, one
 *    double-click from open. The New row sits above it (blank + the sizes
 *    people actually make + Import).
 *  · Tier 2 — Projects and its folders, search, sort, grid/list.
 *  · Tier 3 — Trash, Learn, and Explore (the community) at the sidebar's foot.
 * The sidebar is the only navigation; on a phone it becomes a chip row.
 * Every interaction (selection, marquee, drag-to-folder, keys, menus) rides
 * the headless `filer/` engine — this screen supplies the projects adapter
 * and the card's picture.
 */
type HomePlace = "recents" | "projects" | "explore";

const LAYOUT_KEY = NAMES.storage.homeLayout;
function readLayout(): FilerLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

const LEARN_URL = `${identity.siteUrl}/docs`;

/** The sizes people make most, in the order they make them. */
const NEW_PRESETS = [
  { name: "Reel", meta: "9:16", width: 1080, height: 1920 },
  { name: "Square", meta: "1:1", width: 1080, height: 1080 },
  { name: "YouTube", meta: "16:9", width: 1920, height: 1080 },
  { name: "Title card", meta: "4:5", width: 1080, height: 1350 },
] as const;

export function HomeScreen() {
  const store = useDocStore();
  const openNewProject = useAppShell((s) => s.openNewProject);
  const adapter = React.useMemo(() => createProjectsAdapter(), []);
  const fm = useFilerManager(adapter);
  // Search always means "everywhere" here, and Home opens on Recents — set
  // before the first paint, so Projects never flashes first.
  const primed = React.useRef<typeof fm | null>(null);
  if (primed.current !== fm) {
    primed.current = fm;
    fm.setState((st) => ({ search: { ...st.search, recursive: true, flat: true } }));
  }
  const loading = useFiler(fm, (s) => s.loading);
  const flat = useFiler(fm, (s) => Boolean(s.search.flat));
  const folderId = useFiler(fm, (s) => s.currentFolderId);
  const query = useFiler(fm, (s) => s.search.query);
  const isEmpty = useFiler(fm, (s) => s.tree.items.length === 0 && s.tree.folders.length === 0);
  const section = useAppShell((s) => s.homeSection);
  const place: HomePlace = section === "community" ? "explore" : flat ? "recents" : "projects";
  const [layout, setLayoutState] = React.useState<FilerLayout>("grid");
  React.useEffect(() => setLayoutState(readLayout()), []);
  const setLayout = (next: FilerLayout) => {
    setLayoutState(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* a private window keeps it for this visit */
    }
  };


  const go = (to: HomePlace) => {
    const shell = useAppShell.getState();
    if (to === "explore") return shell.setHomeSection("community");
    shell.setHomeSection("projects");
    if (to === "recents") fm.getState().setFlat(true);
    else fm.getState().navigate(null);
  };

  // New-folder dialog, shared by the sidebar/background menu and "Move to → New
  // folder…". A pending id set means: create the folder, then move it into it.
  const [folderDialog, setFolderDialog] = React.useState<{ open: boolean; moveIds: string[] | null }>({
    open: false,
    moveIds: null,
  });
  const submitNewFolder = async (name: string) => {
    if (fm.getState().search.flat) fm.getState().navigate(null);
    const id = await fm.getState().newFolder(name);
    if (folderDialog.moveIds?.length) await fm.getState().move(folderDialog.moveIds, id);
  };
  const newFolder = () => setFolderDialog({ open: true, moveIds: null });

  // Delete confirm, shared by the keyboard, context menu and three-dot menu.
  const [deleteIds, setDeleteIds] = React.useState<string[] | null>(null);

  const createSized = (preset: (typeof NEW_PRESETS)[number]) => {
    const doc = createEmptyDocument(preset.name);
    const frame = doc.frames[0]!;
    frame.width = preset.width;
    frame.height = preset.height;
    const id = createProjectId();
    void createProject(id, doc);
    makeResident(store, id, doc);
  };

  // The still stays under the preview: a hover reads the document first, and a
  // card that blanked while it did would flash on every pass of the pointer.
  const renderThumb = React.useCallback(
    (item: FilerItem<ProjectRecord>, hovered: boolean) => (
      <div className="relative size-full">
        {item.data.thumbnail ? (
          <img src={item.data.thumbnail} alt="" className="size-full object-contain" draggable={false} />
        ) : (
          <div className="flex size-full items-center justify-center text-fg-faint">
            <Film className="size-6" />
          </div>
        )}
        {hovered && <HoverPlayer projectId={item.id} />}
      </div>
    ),
    [],
  );

  const showNewRow = place !== "explore" && !query && (place === "recents" || folderId === null);
  const title = place === "recents" ? "Recents" : place === "explore" ? "Explore" : null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
      <HomeSidebar fm={fm} place={place} go={go} onNewFolder={newFolder} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-6">
          <div className="md:hidden">
            <LogoMenuTrigger />
          </div>
          {place === "explore" ? (
            <div className="flex-1" />
          ) : (
            <FilerToolbar fm={fm} layout={layout} onLayout={setLayout} placeholder="Search projects" />
          )}
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" size="sm" className="max-sm:px-2" onClick={() => void pickAndImportProject(store)}>
              <FileUp /> <span className="max-sm:hidden">Import</span>
            </Button>
            <Button size="sm" className="max-sm:px-2.5" onClick={openNewProject}>
              <Plus /> <span className="max-sm:hidden">New project</span>
            </Button>
          </div>
        </header>
        <HomeNotice />
        {product.HomeBanner && <product.HomeBanner />}
        <MobilePlaces place={place} go={go} />

        <ScrollArea fill className="min-h-0 flex-1" viewportClassName="px-3 py-5 sm:px-6">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
            <div className="flex h-(--control-h-lg) items-center">
              {title ? <h1 className="text-display text-fg">{title}</h1> : <Breadcrumb fm={fm} />}
            </div>

            {showNewRow && (
              <NewRow
                onBlank={openNewProject}
                onPreset={createSized}
                onImport={() => void pickAndImportProject(store)}
              />
            )}

            {place === "explore" ? (
              <CommunityView />
            ) : loading ? (
              <p className="py-16 text-center text-body text-fg-faint">Loading…</p>
            ) : (
              <FileGrid<ProjectRecord>
                fm={fm}
                layout={layout}
                renderThumb={renderThumb}
                itemThumbUrl={(item) => item.data.thumbnail}
                itemMeta={(item) => `Edited ${timeAgo(item.data.updatedAt)}`}
                onNewFolder={newFolder}
                onMoveToNewFolder={(ids) => setFolderDialog({ open: true, moveIds: ids })}
                onRequestDelete={setDeleteIds}
                empty={isEmpty ? <FirstRun /> : undefined}
              />
            )}
          </div>
        </ScrollArea>
      </div>

      <NewFolderDialog
        open={folderDialog.open}
        onOpenChange={(open) => setFolderDialog((s) => ({ ...s, open }))}
        onSubmit={submitNewFolder}
        title={folderDialog.moveIds ? "Move to new folder" : "New folder"}
      />
      <TrashView fm={fm} itemThumbUrl={(item) => item.data.thumbnail} />
      <DeleteConfirm
        ids={deleteIds}
        onCancel={() => setDeleteIds(null)}
        onConfirm={() => {
          if (deleteIds) void fm.getState().trashNodes(deleteIds);
          setDeleteIds(null);
        }}
      />
    </div>
  );
}

/** The product's mark — the logo menu (project switcher + app menu). */
function LogoMenuTrigger() {
  return (
    <AppMenu
      trigger={
        <button
          type="button"
          aria-label="Main menu"
          className="group flex h-(--control-h-lg) shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-hover data-[state=open]:bg-hover"
        >
          <product.Mark className="size-6" />
          <ChevronDown className="size-3.5 text-fg-faint" />
        </button>
      }
    />
  );
}

function SideItem({
  icon: Icon,
  label,
  active,
  onClick,
  trailing,
  indent,
  dropFolderId,
  quiet,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
  indent?: boolean;
  dropFolderId?: string;
  quiet?: boolean;
}) {
  return (
    <div
      {...(dropFolderId ? { "data-drop-folder-id": dropFolderId } : {})}
      className={cn(
        "group/side flex h-(--control-h) items-center rounded-md text-body transition-colors",
        "data-[drop-over=true]:bg-selection",
        active ? "bg-selection text-selection-fg" : quiet ? "text-fg-muted hover:bg-hover hover:text-fg" : "text-fg hover:bg-hover",
      )}
    >
      <button type="button" onClick={onClick} className={cn("flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left", indent && "pl-7")}>
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      {trailing}
    </div>
  );
}

function HomeSidebar({
  fm,
  place,
  go,
  onNewFolder,
}: {
  fm: FilerStore<ProjectRecord>;
  place: HomePlace;
  go: (to: HomePlace) => void;
  onNewFolder: () => void;
}) {
  const folders = useFiler(fm, (s) => s.tree.folders);
  const currentFolderId = useFiler(fm, (s) => s.currentFolderId);
  const roots = React.useMemo(
    () => folders.filter((f) => f.parentId === null).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    [folders],
  );
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-panel md:flex">
      <div className="flex h-14 shrink-0 items-center px-3">
        <LogoMenuTrigger />
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        <SideItem icon={Clock} label="Recents" active={place === "recents"} onClick={() => go("recents")} />
        <SideItem
          icon={FolderOpen}
          label="Projects"
          active={place === "projects" && currentFolderId === null}
          onClick={() => go("projects")}
          trailing={
            <button
              type="button"
              aria-label="New folder"
              title="New folder"
              onClick={onNewFolder}
              className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-muted opacity-0 hover:bg-pressed hover:text-fg group-hover/side:opacity-100 [@media(pointer:coarse)]:opacity-100 [&_svg]:size-3.5"
            >
              <Plus />
            </button>
          }
        />
        {roots.map((f) => (
          <SideItem
            key={f.id}
            icon={Folder}
            label={f.name}
            indent
            dropFolderId={f.id}
            active={place === "projects" && currentFolderId === f.id}
            onClick={() => {
              useAppShell.getState().setHomeSection("projects");
              fm.getState().navigate(f.id);
            }}
          />
        ))}
        <SideItem icon={Trash2} label="Trash" quiet onClick={() => void fm.getState().openTrash()} />

        <div className="mt-auto flex flex-col gap-0.5 pt-4">
          <SideItem icon={GraduationCap} label="Learn" quiet onClick={() => window.open(LEARN_URL, "_blank", "noopener,noreferrer")} />
          <SideItem icon={Compass} label="Explore" quiet active={place === "explore"} onClick={() => go("explore")} />
        </div>
      </nav>
    </aside>
  );
}

/** The sidebar, on a phone: one row of chips under the header. */
function MobilePlaces({ place, go }: { place: HomePlace; go: (to: HomePlace) => void }) {
  const chips: Array<{ id: HomePlace; label: string }> = [
    { id: "recents", label: "Recents" },
    { id: "projects", label: "Projects" },
    { id: "explore", label: "Explore" },
  ];
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3 md:hidden">
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => go(c.id)}
          className={cn(
            "h-(--control-h) shrink-0 rounded-md px-3 text-body",
            place === c.id ? "bg-selection text-selection-fg" : "text-fg-muted hover:bg-hover",
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** A frame's shape at icon size — the preset reads before its name does. */
function ShapeGlyph({ width, height }: { width: number; height: number }) {
  const s = 22 / Math.max(width, height);
  return (
    <span
      aria-hidden
      className="rounded-xs border-[1.5px] border-current"
      style={{ width: Math.round(width * s), height: Math.round(height * s) }}
    />
  );
}

function NewTile({ onClick, glyph, label, meta }: { onClick: () => void; glyph: React.ReactNode; label: string; meta?: string }) {
  return (
    <button
      type="button"
      data-no-marquee
      onClick={onClick}
      className="group flex h-14 min-w-36 shrink-0 items-center gap-3 rounded-lg bg-raised px-3 text-left transition-colors hover:bg-hover"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted group-hover:text-fg">{glyph}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-label text-fg">{label}</span>
        {meta && <span className="text-meta text-fg-faint">{meta}</span>}
      </span>
    </button>
  );
}

function NewRow({
  onBlank,
  onPreset,
  onImport,
}: {
  onBlank: () => void;
  onPreset: (p: (typeof NEW_PRESETS)[number]) => void;
  onImport: () => void;
}) {
  return (
    <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 [&::-webkit-scrollbar]:hidden">
      <NewTile onClick={onBlank} glyph={<Plus className="size-5" />} label="New project" meta="Any size" />
      {NEW_PRESETS.map((p) => (
        <NewTile key={p.name} onClick={() => onPreset(p)} glyph={<ShapeGlyph width={p.width} height={p.height} />} label={p.name} meta={p.meta} />
      ))}
      <NewTile onClick={onImport} glyph={<FileUp className="size-5" />} label="Import" meta={`${identity.sliceExt} file`} />
    </div>
  );
}

/** An empty Home is a starting point, never a void: examples to open. */
function FirstRun() {
  return (
    <div className="flex flex-col gap-3 pt-2">
      <h2 className="text-title text-fg">Start from an example</h2>
      <CommunityView limit={4} />
    </div>
  );
}

function DeleteConfirm({
  ids,
  onCancel,
  onConfirm,
}: {
  ids: string[] | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const n = ids?.length ?? 0;
  return (
    <Dialog open={ids !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Move {n === 1 ? "item" : `${n} items`} to Recently Deleted?</DialogTitle>
          <DialogDescription>
            You can restore {n === 1 ? "it" : "them"} later from Recently Deleted. Deleting a folder removes
            everything inside it.
          </DialogDescription>
        </DialogHeader>
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

/** How long the pointer rests on a card before its document is read. */
const HOVER_INTENT_MS = 220;

/**
 * Plays the project's first frame across its duration on hover, muted (visual
 * only). The document is read only once the pointer RESTS on the card — a
 * sweep across the grid reads nothing — and it is held only while it plays:
 * leaving the card lets go of it and of every picture it decoded.
 */
function HoverPlayer({ projectId }: { projectId: string }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = React.useState(false);

  React.useEffect(() => {
    let raf = 0;
    let alive = true;
    let release: (() => void) | null = null;
    const intent = window.setTimeout(() => {
      void getProjectDocument(projectId)
        .catch(() => null)
        .then((doc) => {
          const canvas = canvasRef.current;
          const frame = doc?.frames[0];
          if (!alive || !doc || !frame || !canvas) return;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ensureDocumentFaces(doc);
          release = holdPreview(doc);
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const box = canvas.getBoundingClientRect();
          canvas.width = Math.max(1, Math.round(box.width * dpr));
          canvas.height = Math.max(1, Math.round(box.height * dpr));
          const s = Math.min(canvas.width / frame.width, canvas.height / frame.height);
          const ox = (canvas.width - frame.width * s) / 2;
          const oy = (canvas.height - frame.height * s) / 2;
          const dur = doc.durationMs || 4000;
          const start = performance.now();
          let drawn = false;
          const loop = () => {
            const t = (performance.now() - start) % dur;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.setTransform(s, 0, 0, s, ox, oy);
            drawFrameContent(ctx, doc, frame, t);
            if (!drawn) {
              drawn = true;
              setShown(true);
            }
            raf = requestAnimationFrame(loop);
          };
          raf = requestAnimationFrame(loop);
        });
    }, HOVER_INTENT_MS);
    return () => {
      alive = false;
      window.clearTimeout(intent);
      cancelAnimationFrame(raf);
      const canvas = canvasRef.current;
      if (canvas) canvas.width = canvas.height = 0;
      release?.();
    };
  }, [projectId]);

  return <canvas ref={canvasRef} className={cn("absolute inset-0 size-full bg-background", !shown && "invisible")} />;
}

function timeAgo(ms: number): string {
  return editedAgo(ms);
}

/** One line saying why you are Home instead of in the project you asked for. */
function HomeNotice() {
  const notice = useAppShell((s) => s.homeNotice);
  if (!notice) return null;
  return (
    <div role="status" className="flex h-10 shrink-0 items-center gap-2 border-b bg-destructive/10 px-6 text-xs text-destructive">
      <CircleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{notice}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => useAppShell.getState().setHomeNotice(null)}
        className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-destructive/15"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
