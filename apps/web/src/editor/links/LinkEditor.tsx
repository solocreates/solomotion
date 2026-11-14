"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import { create } from "zustand";
import { ArrowUpRight, Copy, Globe, Link2, Link2Off, Mail, Phone, Plus, Puzzle, Trash2, type LucideIcon } from "lucide-react";
import { describeLink, isBrokenLink, resolveLink, type MotionDocument, type Link, type LinkOpen } from "@solomotion/core";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useStageView } from "../state/session";
import { stageHitRects, hitAABB, unionAABB } from "../stage/stage-geometry";
import { PickGlyph, docNodeGlyph } from "../pick/PickGlyph";
import { PanelSection } from "../inspector/controls";
import { LinkPicker } from "./LinkPicker";
import { currentLinkScope, linkOfScope, setScopeLink, type LinkScope } from "./link-scope";
import { appUrlFor, followLink, linkUrlFor } from "./navigate";

/**
 * EDITING A LINK — one panel, two homes: the Design tab's Link section, and a
 * floating editor at the selection (⇧⌘U, ⌘K while typing, the context menu).
 * Both edit `currentLinkScope` — a text run while typing, else the selected
 * layers — so the two can never disagree about what "this" is.
 */

/** The scope, live: it follows the selection and the text caret. */
export function useLinkScope(): LinkScope | null {
  const doc = useDoc();
  const editingClipId = useSession((s) => s.editingClipId);
  const textSelection = useSession((s) => s.textSelection);
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  return currentLinkScope(doc, { editingClipId, textSelection, selectedClipIds });
}

const OPEN_OPTIONS = [
  { value: "auto", label: "Auto", hint: "Web links open a new tab; places in this project open here" },
  { value: "here", label: "Here" },
  { value: "new", label: "New tab" },
] as const satisfies ReadonlyArray<{ value: LinkOpen; label: string; hint?: string }>;

function TargetGlyph({ doc, link, className }: { doc: MotionDocument; link: Link; className?: string }) {
  const r = resolveLink(doc, link);
  if (r.kind === "node") return <PickGlyph candidate={docNodeGlyph(r.node)} className={className} />;
  let Icon: LucideIcon = Link2Off;
  if (r.kind === "external") Icon = r.href.startsWith("mailto:") ? Mail : r.href.startsWith("tel:") ? Phone : Globe;
  else if (r.kind === "route") Icon = r.route.to === "plugin" ? Puzzle : Link2;
  return <Icon className={className} />;
}

/** Where a link goes, as one line — the section's row and the editor's header. */
function LinkTarget({ doc, link }: { doc: MotionDocument; link: Link }) {
  const broken = isBrokenLink(doc, link);
  const { label, where } = describeLink(doc, link, identity.name);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <TargetGlyph doc={doc} link={link} className={cn("size-3.5 shrink-0", broken ? "text-amber-500" : "text-muted-foreground")} />
      <span className={cn("min-w-0 truncate text-[12px]", broken && "text-amber-500")}>{label}</span>
      {where && <span className="min-w-0 shrink truncate text-2xs text-muted-foreground">{where}</span>}
    </span>
  );
}

function IconButton({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5",
            danger && "hover:text-destructive",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Copy where a link goes: its URL, or this app's deep link to the place. */
function copyTarget(doc: MotionDocument, link: Link): void {
  const r = resolveLink(doc, link);
  const text = r.kind === "external" ? r.href : r.kind === "route" ? appUrlFor(r.route) : r.kind === "node" ? linkUrlFor(doc, [r.node.key], r.t) : null;
  if (!text) return;
  navigator.clipboard.writeText(text).then(
    () => toast.success("Link copied"),
    () => toast.error("Couldn't reach the clipboard."),
  );
}

/**
 * The editor body: the current link (follow · copy · remove · how it opens)
 * over the picker that changes it.
 */
export function LinkEditPanel({ scope, onDone }: { scope: LinkScope; onDone?: () => void }) {
  const doc = useDoc();
  const store = useDocStore();
  const { link, mixed } = linkOfScope(doc, scope);
  const pick = (target: Link["target"]) => {
    setScopeLink(store, scope, { target, open: link?.open ?? "auto" });
    onDone?.();
  };
  return (
    <div className="flex flex-col">
      {link && (
        <div className="flex flex-col gap-1.5 border-b border-border/60 p-2">
          <div className="flex items-center gap-1">
            <LinkTarget doc={doc} link={link} />
            <IconButton label="Go there" onClick={() => followLink(store, link)}>
              <ArrowUpRight />
            </IconButton>
            <IconButton label="Copy link" onClick={() => copyTarget(doc, link)}>
              <Copy />
            </IconButton>
            <IconButton
              label="Remove link"
              danger
              onClick={() => {
                setScopeLink(store, scope, null);
                onDone?.();
              }}
            >
              <Trash2 />
            </IconButton>
          </div>
          <Segmented<LinkOpen>
            stretch
            aria-label="Opens"
            value={link.open}
            onChange={(open) => setScopeLink(store, scope, { ...link, open })}
            options={OPEN_OPTIONS}
          />
        </div>
      )}
      {mixed && <div className="border-b border-border/60 px-2.5 py-2 text-[12px] text-muted-foreground">Mixed links</div>}
      <LinkPicker onPick={pick} />
    </div>
  );
}

/** The Design tab's Link section. */
export function LinkSection() {
  const doc = useDoc();
  const store = useDocStore();
  const scope = useLinkScope();
  const [open, setOpen] = React.useState(false);
  if (!scope) return null;
  const { link, mixed } = linkOfScope(doc, scope);
  const title = scope.kind === "range" ? "Link · selection" : "Link";
  const editor = (trigger: React.ReactNode) => (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <LinkEditPanel scope={scope} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
  return (
    <PanelSection
      id="link"
      title={title}
      hint="⌘-click a link on the canvas to follow it. With the Hand tool, a click follows."
      actions={
        link || mixed ? (
          <button
            type="button"
            aria-label="Remove link"
            onClick={() => setScopeLink(store, scope, null)}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-destructive [&_svg]:size-3.5"
          >
            <Trash2 />
          </button>
        ) : (
          editor(
            <button
              type="button"
              aria-label="Add link"
              className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
            >
              <Plus />
            </button>,
          )
        )
      }
    >
      {(link || mixed) && (
        <div className="space-y-1.5">
          {editor(
            <button
              type="button"
              className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-input bg-transparent px-2 text-left transition-colors hover:bg-accent/50 data-[state=open]:bg-accent/50"
            >
              {link ? <LinkTarget doc={doc} link={link} /> : <span className="text-[12px] text-muted-foreground">Mixed</span>}
            </button>,
          )}
          {link && (
            <Segmented<LinkOpen> stretch aria-label="Opens" value={link.open} onChange={(o) => setScopeLink(store, scope, { ...link, open: o })} options={OPEN_OPTIONS} />
          )}
        </div>
      )}
    </PanelSection>
  );
}

// ── The floating editor ─────────────────────────────────────────────────────

interface FloatingLinkEditor {
  /** Screen rect to open beside, or null when closed. */
  at: { x: number; y: number; width: number; height: number } | null;
  scope: LinkScope | null;
  close: () => void;
}

export const useFloatingLinkEditor = create<FloatingLinkEditor>((set) => ({
  at: null,
  scope: null,
  close: () => set({ at: null, scope: null }),
}));

/** Where the scope is on screen: the selected letters, else the layers' box. */
function scopeScreenRect(scope: LinkScope): FloatingLinkEditor["at"] {
  if (scope.kind === "range") {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height) return { x: r.left, y: r.top, width: r.width, height: r.height };
    }
  }
  const ids = new Set(scope.kind === "range" ? [scope.clipId] : scope.clipIds);
  const box = unionAABB(stageHitRects.current.filter((h) => ids.has(h.clipId)).map(hitAABB));
  const stage = document.querySelector("[data-stage-drop]")?.getBoundingClientRect();
  if (box && stage) {
    const v = useStageView.getState();
    return { x: stage.left + v.tx + box.minX * v.scale, y: stage.top + v.ty + box.minY * v.scale, width: (box.maxX - box.minX) * v.scale, height: (box.maxY - box.minY) * v.scale };
  }
  return stage ? { x: stage.left + stage.width / 2, y: stage.top + stage.height / 3, width: 0, height: 0 } : { x: 200, y: 200, width: 0, height: 0 };
}

/** ⇧⌘U, ⌘K while typing, "Add link…" — open the editor at what is selected. */
export function openLinkEditor(doc: MotionDocument): boolean {
  const scope = currentLinkScope(doc);
  if (!scope) {
    toast.error("Select a layer or some text to link.");
    return false;
  }
  useFloatingLinkEditor.setState({ scope, at: scopeScreenRect(scope) });
  return true;
}

/** Mounted once by the editor. */
export function FloatingLinkEditorHost() {
  const at = useFloatingLinkEditor((s) => s.at);
  const scope = useFloatingLinkEditor((s) => s.scope);
  const close = useFloatingLinkEditor((s) => s.close);
  if (!at || !scope) return null;
  return (
    <Popover open onOpenChange={(v) => !v && close()}>
      <PopoverAnchor asChild>
        <div aria-hidden className="pointer-events-none fixed" style={{ left: at.x, top: at.y, width: at.width, height: at.height }} />
      </PopoverAnchor>
      <PopoverContent className="w-80 p-0" side="bottom" align="start" sideOffset={8}>
        <LinkEditPanel scope={scope} onDone={close} />
      </PopoverContent>
    </Popover>
  );
}
