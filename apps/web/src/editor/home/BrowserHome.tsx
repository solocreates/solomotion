"use client";

import { identity } from "@/editor/identity";
import { product } from "@/editor/product";
import * as React from "react";
import { ChevronDown, Clock, Compass, FileUp, Folder, FolderOpen, GraduationCap, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Breadcrumb } from "../filer/Breadcrumb";
import { FilerToolbar } from "../filer/FilerToolbar";
import { useFiler, type FilerStore } from "../filer/use-file-manager";
import { useAppShell } from "../state/app-shell";
import type { ProjectRecord } from "../state/project-store";
import { AppMenu } from "../menus/AppMenu";
import { CommunityView } from "./CommunityView";
import { HomeNotice, NEW_PRESETS, ShapeGlyph, type HomeKit, type HomePlace, type NewPreset } from "./home-kit";
import { ProjectGrid } from "./ProjectGrid";

/**
 * HOME as a file browser (v5 redesign, D15) — the `browser` layout.
 *
 * Jobs, by frequency: open what I was working on · start something new ·
 * keep projects tidy · find an example. So:
 *  · Tier 1 — Recents, the default view: every project, newest first, one
 *    double-click from open. The New row sits above it (blank + the sizes
 *    people actually make + Import).
 *  · Tier 2 — Projects and its folders, search, sort, grid/list.
 *  · Tier 3 — Trash, Learn, and Explore (the community) at the sidebar's foot.
 * The sidebar is the only navigation; on a phone it becomes a chip row.
 */
export function BrowserHome({ kit }: { kit: HomeKit }) {
  const { fm, place, go, layout, setLayout, title, showNewRow } = kit;
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
      <HomeSidebar fm={fm} place={place} go={go} onNewFolder={kit.newFolder} learnUrl={kit.learnUrl} examples={kit.examples} />

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
            <Button variant="secondary" size="sm" className="max-sm:px-2" onClick={kit.importProject}>
              <FileUp /> <span className="max-sm:hidden">Import</span>
            </Button>
            <Button size="sm" className="max-sm:px-2.5" onClick={kit.openNewProject}>
              <Plus /> <span className="max-sm:hidden">New project</span>
            </Button>
          </div>
        </header>
        <HomeNotice />
        {product.HomeBanner && <product.HomeBanner />}
        <MobilePlaces place={place} go={go} examples={kit.examples} />

        <ScrollArea fill className="min-h-0 flex-1" viewportClassName="px-3 py-5 sm:px-6">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
            <div className="flex h-(--control-h-lg) items-center">
              {title ? <h1 className="text-display text-fg">{title}</h1> : <Breadcrumb fm={fm} />}
            </div>

            {showNewRow && <NewRow onBlank={kit.openNewProject} onPreset={kit.createSized} onImport={kit.importProject} />}

            {place === "explore" ? <CommunityView /> : <ProjectGrid kit={kit} />}
          </div>
        </ScrollArea>
      </div>
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
  learnUrl,
  examples,
}: {
  fm: FilerStore<ProjectRecord>;
  place: HomePlace;
  go: (to: HomePlace) => void;
  onNewFolder: () => void;
  learnUrl: string;
  examples: boolean;
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
          <SideItem icon={GraduationCap} label="Learn" quiet onClick={() => window.open(learnUrl, "_blank", "noopener,noreferrer")} />
          {examples && <SideItem icon={Compass} label="Explore" quiet active={place === "explore"} onClick={() => go("explore")} />}
        </div>
      </nav>
    </aside>
  );
}

/** The sidebar, on a phone: one row of chips under the header. */
function MobilePlaces({ place, go, examples }: { place: HomePlace; go: (to: HomePlace) => void; examples: boolean }) {
  const chips: Array<{ id: HomePlace; label: string }> = [
    { id: "recents", label: "Recents" },
    { id: "projects", label: "Projects" },
    ...(examples ? [{ id: "explore" as const, label: "Explore" }] : []),
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
  onPreset: (p: NewPreset) => void;
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
