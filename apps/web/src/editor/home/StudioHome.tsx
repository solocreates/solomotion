"use client";

import { identity } from "@/editor/identity";
import { product } from "@/editor/product";
import * as React from "react";
import {
  ArrowUpRight,
  ChevronDown,
  FileUp,
  FolderPlus,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Breadcrumb } from "../filer/Breadcrumb";
import { FilerToolbar } from "../filer/FilerToolbar";
import { useFiler } from "../filer/use-file-manager";
import { AppMenu } from "../menus/AppMenu";
import { BrandTrigger } from "../menus/BrandTrigger";
import { useIsCompact } from "../state/use-shell-density";
import { CommunityView } from "./CommunityView";
import {
  HomeNotice,
  NEW_PRESETS,
  type HomeKit,
  type HomePlace,
} from "./home-kit";
import { ProjectGrid } from "./ProjectGrid";

/**
 * HOME as a studio — the `studio` layout. The product's site, carried into the
 * app: one column under one band, no sidebar.
 *
 *  · The band: the mark and name (the app menu), the places as tabs, and the
 *    two ways in (Import, New project).
 *  · "Pick a frame": the New row as a shelf of frames drawn at their TRUE
 *    shape and equal area, on the theme's backdrop (a dot field where the
 *    theme says so), so a size is chosen by its silhouette before its name.
 *  · The projects: a section heading with its count, the list's own tools
 *    (search, sort, layout, a folder, Trash) beside it, then the shared grid.
 *
 * Every section is the site's grammar: a small mono eyebrow in the accent over
 * a tight display heading. Width is one formula: the tabs drop to their own
 * row below `md`, the shelf scrolls, the list tools wrap under the heading.
 */
export function StudioHome({ kit }: { kit: HomeKit }) {
  const { fm, place, go, title, showNewRow } = kit;
  const count = useFiler(fm, (s) => s.tree.items.length);
  const firstRun = place === "recents" && kit.isEmpty && !kit.loading;
  // Nothing to list and no examples to offer: the shelf IS the page.
  const shelfAlone = firstRun && !kit.examples;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-2 sm:px-4">
        <BrandMenu />
        <span
          aria-hidden
          className="mx-2 hidden h-4 w-px shrink-0 bg-line md:block"
        />
        <Places
          place={place}
          go={go}
          learnUrl={kit.learnUrl}
          examples={kit.examples}
          className="hidden self-stretch md:flex"
        />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="max-sm:px-2"
            onClick={kit.importProject}
            aria-label="Import"
          >
            <FileUp /> <span className="max-sm:hidden">Import</span>
          </Button>
          <Button
            size="sm"
            className="max-sm:px-2.5"
            onClick={kit.openNewProject}
            aria-label="New project"
          >
            <Plus /> <span className="max-sm:hidden">New project</span>
          </Button>
        </div>
      </header>
      <Places
        place={place}
        go={go}
        learnUrl={kit.learnUrl}
        examples={kit.examples}
        className="h-11 shrink-0 overflow-x-auto border-b border-line px-2 [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
      />
      <HomeNotice />
      {product.HomeBanner && <product.HomeBanner />}

      {/* One child: `fill` grows every direct child, and the shelf must keep its height. */}
      <ScrollArea fill className="min-h-0 flex-1">
        <div className="flex flex-col">
          {showNewRow && <FrameShelf kit={kit} alone={shelfAlone} />}
          {!shelfAlone && (

          <section className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pb-16 pt-8 sm:px-8 sm:pt-10">
            {place === "explore" ? (
              <>
                <SectionHead eyebrow="Examples" title="Explore" />
                <CommunityView />
              </>
            ) : firstRun ? (
              <>
                <SectionHead eyebrow="Examples" title="Start from an example" />
                <CommunityView limit={4} />
              </>
            ) : (
              <>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <SectionHead
                    eyebrow={
                      place === "recents"
                        ? `${count} ${count === 1 ? "project" : "projects"}`
                        : "Projects"
                    }
                    title={title ?? <Breadcrumb fm={fm} />}
                  />
                  <div className="flex min-w-0 items-center gap-1 sm:w-[26rem]">
                    <FilerToolbar
                      fm={fm}
                      layout={kit.layout}
                      onLayout={kit.setLayout}
                      placeholder="Search projects"
                    />
                    <span
                      aria-hidden
                      className="mx-1 h-4 w-px shrink-0 bg-line"
                    />
                    <IconAction label="New folder" onClick={kit.newFolder}>
                      <FolderPlus />
                    </IconAction>
                    <IconAction
                      label="Recently deleted"
                      onClick={() => void fm.getState().openTrash()}
                    >
                      <Trash2 />
                    </IconAction>
                  </div>
                </div>
                <ProjectGrid kit={kit} />
              </>
            )}
          </section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** The mark and the name: the app menu, as the editor's top bar has it. */
function BrandMenu() {
  const compact = useIsCompact();
  return (
    <AppMenu
      side="bottom"
      trigger={<BrandTrigger compact={compact} />}
    />
  );
}

const PLACES: ReadonlyArray<{ id: HomePlace; label: string }> = [
  { id: "recents", label: "Recents" },
  { id: "projects", label: "Projects" },
  { id: "explore", label: "Explore" },
];

/**
 * The places, as tabs: plain text, the current one inked with the accent's
 * underline where the band meets the page. Learn leaves the app, so it says so.
 */
function Places({
  place,
  go,
  learnUrl,
  examples,
  className,
}: {
  place: HomePlace;
  go: (to: HomePlace) => void;
  learnUrl: string;
  examples: boolean;
  className?: string;
}) {
  const tab =
    "relative flex h-full shrink-0 items-center gap-1 px-3 text-body transition-colors [&_svg]:size-3.5";
  return (
    <nav aria-label="Home" className={cn("flex items-stretch", className)}>
      {PLACES.filter((p) => examples || p.id !== "explore").map((p) => {
        const on = place === p.id;
        return (
          <button
            key={p.id}
            type="button"
            aria-current={on ? "page" : undefined}
            onClick={() => go(p.id)}
            className={cn(
              tab,
              on
                ? "text-fg after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {p.label}
          </button>
        );
      })}
      <a
        href={learnUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(tab, "text-fg-faint hover:text-fg")}
      >
        Learn <ArrowUpRight />
      </a>
    </nav>
  );
}

/** The site's section grammar: a mono eyebrow in the accent over a tight display heading. */
function SectionHead({
  eyebrow,
  title,
}: {
  eyebrow: string;
  title: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="font-mono text-meta text-primary">{eyebrow}</p>
      {typeof title === "string" ? (
        <h2 className="font-heading text-[length:calc(var(--text-display)*1.3)] font-semibold leading-tight tracking-[-0.03em] text-fg">
          {title}
        </h2>
      ) : (
        <div className="flex h-(--control-h-lg) items-center">{title}</div>
      )}
    </div>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="flex size-(--control-h-lg) shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg [&_svg]:size-4"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Every frame on the shelf has this area (px²), so a size reads by its shape, not its bulk. */
const FRAME_AREA = 92 * 92;
function frameBox(width: number, height: number) {
  const r = width / height;
  return {
    width: Math.round(Math.sqrt(FRAME_AREA * r)),
    height: Math.round(Math.sqrt(FRAME_AREA / r)),
  };
}

/**
 * "Pick a frame": blank, the common sizes, and a file, as frames standing on
 * one baseline over the theme's backdrop. The dot field fades out toward the
 * edges, as it does under the site's hero.
 */
function FrameShelf({ kit, alone }: { kit: HomeKit; alone: boolean }) {
  return (
    // Alone (a first run with nothing else to show), the shelf takes the page
    // and sits a little above its middle, the way the site's hero sits.
    <section className={cn("relative", alone ? "flex flex-1 flex-col justify-center pb-[8vh]" : "border-b border-line")}>
      <div
        aria-hidden
        className="stage-backdrop pointer-events-none absolute inset-0"
        style={{
          maskImage: alone
            ? "radial-gradient(ellipse 75% 70% at 40% 45%, #000 30%, transparent 80%)"
            : "radial-gradient(ellipse 70% 90% at 30% 60%, #000 25%, transparent 75%)",
        }}
      />
      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pb-8 pt-8 sm:px-8 sm:pb-10 sm:pt-12">
        <SectionHead eyebrow="New project" title="Pick a frame" />
        <div
          data-no-marquee
          className="-mx-4 -my-2 flex items-end gap-3 overflow-x-auto px-4 py-2 [scrollbar-width:none] sm:-mx-8 sm:gap-4 sm:px-8 [&::-webkit-scrollbar]:hidden"
        >
          <FrameTile
            // Without a dialog, New is a canvas you draw the frame on.
            label={identity.newProject === "canvas" ? "Blank canvas" : "Any size"}
            sub={identity.newProject === "canvas" ? "Draw a frame" : "Custom"}
            dashed
            box={frameBox(4, 3)}
            onClick={kit.openNewProject}
          >
            <Plus className="size-5" />
          </FrameTile>
          {NEW_PRESETS.map((p) => (
            <FrameTile
              key={p.name}
              label={p.name}
              sub={`${p.width}×${p.height}`}
              box={frameBox(p.width, p.height)}
              onClick={() => kit.createSized(p)}
            >
              <span className="font-mono text-meta">{p.meta}</span>
            </FrameTile>
          ))}
          <FrameTile
            label="Open a file"
            sub={identity.sliceExt}
            dashed
            box={frameBox(4, 3)}
            onClick={kit.importProject}
          >
            <FileUp className="size-5" />
          </FrameTile>
        </div>
      </div>
    </section>
  );
}

function FrameTile({
  label,
  sub,
  box,
  dashed,
  onClick,
  children,
}: {
  label: string;
  sub: string;
  box: { width: number; height: number };
  dashed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex shrink-0 flex-col items-start gap-2.5 text-left outline-none"
    >
      <span
        aria-hidden
        style={box}
        className={cn(
          "flex items-center justify-center rounded-md border text-fg-faint transition-[transform,border-color,color,background-color] duration-200 ease-out",
          "group-hover:-translate-y-0.5 group-hover:border-primary group-hover:text-primary group-active:translate-y-0",
          "group-focus-visible:ring-2 group-focus-visible:ring-primary/60",
          dashed
            ? "border-dashed border-fg-faint/40 bg-background/60"
            : "border-line bg-panel shadow-sm",
        )}
      >
        {children}
      </span>
      <span className="flex flex-col">
        <span className="text-label text-fg">{label}</span>
        <span className="font-mono text-meta text-fg-faint">{sub}</span>
      </span>
    </button>
  );
}
