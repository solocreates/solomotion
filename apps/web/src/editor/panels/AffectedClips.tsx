"use client";

import * as React from "react";
import { Check, FileVideo, ImageIcon, Link2, MoreVertical, Music, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { focusClip, type ClipRef } from "../assets/media-usage";

/**
 * The one list of media-affected clips, reused by the media-review dialog and
 * the delete confirm. Clicking a row jumps to the clip in the timeline (focus is
 * a click, never a button). A file dropped on a row relinks that clip's media
 * (reactive drop styling → a success check). Right-click or the ⋯ menu offer
 * Replace (file picker) and Forget (remove clip + media). All actions are
 * optional, so the delete confirm can use it read-only.
 */
export function AffectedClipsList({
  refs,
  onFocus,
  onReplace,
  onForget,
  onDropFile,
  resolved,
  className,
}: {
  refs: ClipRef[];
  onFocus?: (ref: ClipRef) => void;
  onReplace?: (ref: ClipRef) => void;
  onForget?: (ref: ClipRef) => void;
  onDropFile?: (ref: ClipRef, file: File) => void;
  /** Asset ids that have been relinked this session — shown as done, kept in place. */
  resolved?: ReadonlySet<string>;
  className?: string;
}) {
  if (refs.length === 0) return null;
  return (
    <ScrollArea className={cn("max-h-72", className)}>
      <ul className="flex flex-col gap-1 pr-3">
        {refs.map((ref) => (
          <ClipRow
            key={ref.clipId}
            refItem={ref}
            done={resolved?.has(ref.assetId) ?? false}
            onFocus={onFocus}
            onReplace={onReplace}
            onForget={onForget}
            onDropFile={onDropFile}
          />
        ))}
      </ul>
    </ScrollArea>
  );
}

function ClipRow({
  refItem: ref,
  done,
  onFocus,
  onReplace,
  onForget,
  onDropFile,
}: {
  refItem: ClipRef;
  done: boolean;
  onFocus?: (ref: ClipRef) => void;
  onReplace?: (ref: ClipRef) => void;
  onForget?: (ref: ClipRef) => void;
  onDropFile?: (ref: ClipRef, file: File) => void;
}) {
  const [dropping, setDropping] = React.useState(false);
  const focus = () => {
    focusClip(ref);
    onFocus?.(ref);
  };
  const hasMenu = Boolean(onReplace || onForget);

  const row = (
    <div
      role="button"
      tabIndex={0}
      onClick={focus}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && focus()}
      onDragOver={
        onDropFile
          ? (e) => {
              if (e.dataTransfer?.types.includes("Files")) {
                e.preventDefault();
                setDropping(true);
              }
            }
          : undefined
      }
      onDragLeave={() => setDropping(false)}
      onDrop={
        onDropFile
          ? (e) => {
              setDropping(false);
              const file = e.dataTransfer?.files?.[0];
              if (!file) return;
              e.preventDefault();
              onDropFile(ref, file);
            }
          : undefined
      }
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-left transition",
        dropping
          ? "border-primary bg-primary/10 ring-2 ring-primary/50"
          : done
            ? "border-emerald-500/40 bg-emerald-500/5"
            : "border-border bg-card hover:border-primary/40 hover:bg-muted/40",
      )}
    >
      <KindIcon kind={ref.kind} done={done} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{ref.name}</div>
        <div className="text-[10px] text-muted-foreground">
          {done ? "Linked" : onDropFile ? "Drop a file to relink" : timecode(ref.startMs)}
        </div>
      </div>
      {hasMenu && !done && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Actions"
              onClick={(e) => e.stopPropagation()}
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [&_svg]:size-4"
            >
              <MoreVertical />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            {onReplace && (
              <DropdownMenuItem onClick={() => onReplace(ref)}>
                <Link2 /> Replace file…
              </DropdownMenuItem>
            )}
            {onForget && (
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onForget(ref)}>
                <Trash2 /> Forget clip
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {done && <Check className="size-4 shrink-0 text-emerald-500" />}
    </div>
  );

  if (!hasMenu) return <li>{row}</li>;
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem onClick={focus}>Show in timeline</ContextMenuItem>
          {onReplace && (
            <ContextMenuItem onClick={() => onReplace(ref)}>
              <Link2 /> Replace file…
            </ContextMenuItem>
          )}
          {onForget && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem className="text-destructive focus:text-destructive" onClick={() => onForget(ref)}>
                <Trash2 /> Forget clip
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

function KindIcon({ kind, done }: { kind: ClipRef["kind"]; done: boolean }) {
  const Icon = kind === "video" ? FileVideo : kind === "audio" ? Music : ImageIcon;
  return (
    <div className={cn("flex size-7 shrink-0 items-center justify-center rounded border bg-stage", done && "border-emerald-500/40")}>
      <Icon className="size-3.5 text-muted-foreground" />
    </div>
  );
}

function timecode(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
