"use client";

import * as React from "react";
import { CircleAlert, Film, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FilerLayout } from "../filer/FilerToolbar";
import type { FilerItem } from "../filer/model/tree";
import type { FilerStore } from "../filer/use-file-manager";
import { useAppShell } from "../state/app-shell";
import { getProjectDocument, type ProjectRecord } from "../state/project-store";
import { holdPreview } from "../cache/document-release";
import { drawFrameContent } from "../stage/render/draw-frame";
import { ensureDocumentFaces } from "../stage/render/system-fonts";
import { editedAgo } from "../topbar/ProjectSwitcher";
import { CommunityView } from "./CommunityView";

/**
 * What every Home layout is handed: the state and the actions, never the look.
 * `HomeScreen` owns them once; a layout (`layouts.tsx`) only composes.
 */
export type HomePlace = "recents" | "projects" | "explore";

/** The sizes people make most, in the order they make them. */
export const NEW_PRESETS = [
  { name: "Reel", meta: "9:16", width: 1080, height: 1920 },
  { name: "Square", meta: "1:1", width: 1080, height: 1080 },
  { name: "YouTube", meta: "16:9", width: 1920, height: 1080 },
  { name: "Title card", meta: "4:5", width: 1080, height: 1350 },
] as const;
export type NewPreset = (typeof NEW_PRESETS)[number];

export interface HomeKit {
  fm: FilerStore<ProjectRecord>;
  place: HomePlace;
  go: (to: HomePlace) => void;
  layout: FilerLayout;
  setLayout: (next: FilerLayout) => void;
  loading: boolean;
  /** No project and no folder at all: the first run. */
  isEmpty: boolean;
  /** The New row belongs here (Recents, or the Projects root, not searching). */
  showNewRow: boolean;
  /** Recents / Explore have a title; a folder shows its breadcrumb instead. */
  title: string | null;
  learnUrl: string;
  /** The product offers community examples (Explore, the first run's shelf); `identity.examples`. */
  examples: boolean;
  openNewProject: () => void;
  createSized: (preset: NewPreset) => void;
  importProject: () => void;
  newFolder: () => void;
  moveToNewFolder: (ids: string[]) => void;
  requestDelete: (ids: string[]) => void;
  renderThumb: (item: FilerItem<ProjectRecord>, hovered: boolean) => React.ReactNode;
}

/** The project card's picture: the still, with the live player over it on hover. */
export function renderProjectThumb(item: FilerItem<ProjectRecord>, hovered: boolean) {
  // The still stays under the preview: a hover reads the document first, and a
  // card that blanked while it did would flash on every pass of the pointer.
  return (
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
  );
}

/** A frame's shape at icon size — the preset reads before its name does. */
export function ShapeGlyph({ width, height }: { width: number; height: number }) {
  const s = 22 / Math.max(width, height);
  return (
    <span
      aria-hidden
      className="rounded-xs border-[1.5px] border-current"
      style={{ width: Math.round(width * s), height: Math.round(height * s) }}
    />
  );
}

/** An empty Home is a starting point, never a void: examples to open. */
export function FirstRun() {
  return (
    <div className="flex flex-col gap-3 pt-2">
      <h2 className="text-title text-fg">Start from an example</h2>
      <CommunityView limit={4} />
    </div>
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

export function timeAgo(ms: number): string {
  return editedAgo(ms);
}

/** One line saying why you are Home instead of in the project you asked for. */
export function HomeNotice() {
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
