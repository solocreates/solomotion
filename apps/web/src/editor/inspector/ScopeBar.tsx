"use client";

import * as React from "react";
import {
  BASE_SCOPE,
  CAPTION_STATES,
  CAPTION_STATE_HINT,
  CAPTION_STATE_LABEL,
  clearRange,
  clipLocalTime,
  cueStateAt,
  activeCueAt,
  emptyCaptionState,
  isCaptionClip,
  overlayCount,
  overrideEntries,
  propertyDef,
  selectionScope,
  sharedOverlayIn,
  type CaptionState,
  type OverrideDomain,
  type OverrideEntry,
  type ScopeAddress,
  type TextClip,
} from "@solomotion/core";
import { RotateCcw, Type, Sparkle, TextSelect, Eye, EyeOff } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSession, type InspectorTabId, useParkedPlayhead } from "../state/session";
import { revealInInspector } from "../state/inspector-nav";
import { PanelSection, PropRow } from "./controls";
import { useClipUpdater } from "./use-clip-updater";
import { useScope, type ScopeTarget } from "./scope";

/**
 * The SCOPE BAR — the one control that says what the panel below is editing.
 *
 * It replaces two things that used to disagree: a Text/Focus toggle that only
 * captions had, and a separate pink banner that appeared for a text selection.
 * They were the same idea twice, so a caption with a live selection showed
 * neither honestly. One strip, one vocabulary, and the tab a scope is on is
 * irrelevant — the bar is above the tabs' content, so switching from Design to
 * Effects keeps the target you picked.
 *
 * It STICKS to the top of the sidebar, because everything above it is the same
 * in every scope (the layer's name, its buttons) and everything below it is
 * not. Scroll to the effect stack and the strip is still there saying which
 * words that stack belongs to — which is the difference between a switch you
 * trust and one you re-check by scrolling back up.
 *
 * The COUNT on each chip is `overlayCount` — derived from the payload, so a
 * scope that overrides nothing cannot advertise a badge, and clearing the last
 * override cannot leave one behind.
 */

/**
 * THE sticky shell every scope strip wears — text scopes here, vector contours
 * in `VectorInspector`. One place owns the offset, the glass and the z-order,
 * so two strips cannot stick at two different heights.
 *
 * `pr-4` clears the overlay scrollbar. The strip is full-bleed so its rule
 * spans the panel, and without that padding the last chip sat under the
 * scroll handle — a target you could see and not hit.
 */
export function StickyScopeStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-30 flex items-center gap-1 border-y bg-background/90 py-1.5 pl-2 pr-4 backdrop-blur-xl">
      {children}
    </div>
  );
}

const STATE_ICON: Record<CaptionState, typeof Type> = {
  unread: EyeOff,
  focus: Sparkle,
  read: Eye,
};

/** One scope the strip can point at. */
interface ScopeChip {
  id: string;
  address: ScopeAddress;
  label: string;
  hint: string;
  count: number;
  Icon: typeof Type;
  /** The state the playhead is standing in — a dot, not a selection. */
  live?: boolean;
}

/**
 * THE SCOPE TABS — what the sections BELOW this line are editing.
 *
 * Mounted by `LayerSections` at the shared/scoped boundary, never by a panel,
 * so every tab introduces its scoped half the same way. Above the line is the
 * layer; below it is whichever of its parts you have picked.
 *
 * ONLY THE SELECTED CHIP CARRIES ITS NAME. Five modes and a caption's three
 * states do not fit a 240px sidebar as five labels — they truncate to "Un…",
 * "Fo…", "Re…", which is a row of chips that all look alike and say nothing.
 * A segmented control does not need to shout every option: the icons are the
 * options, the label says where you are, and the tooltip says where you would
 * be going. That also makes the active chip visibly wider, so "which one am I
 * on" is answerable from shape alone, across the room, without reading.
 */
export function ScopeTabs({ offer }: { offer: ReadonlySet<ScopeAddress["kind"]> }) {
  const scope = useScope();
  const sel = useSession((s) => s.textSelection);
  const editing = useSession((s) => s.editingClipId);
  const playheadMs = useParkedPlayhead();
  if (!scope) return null;

  const clip = scope.clip;
  const localMs = clipLocalTime(clip, playheadMs) ?? 0;
  // The same rule the address derives from. A range chip needs a proper
  // sub-span behind it — nothing, or the whole text, is the layer and offers
  // none. The spoken word resolves to Focus on its own, but the chip is
  // offered either way so a person can always insist on "these characters".
  const auto = editing === clip.id ? selectionScope(clip, sel, localMs) : BASE_SCOPE;
  const liveRange: ScopeAddress | null =
    auto.kind === "base" || !sel ? null : { kind: "range", start: sel.start, end: sel.end };
  const captioned = isCaptionClip(clip);


  // WHICH STATE THE PLAYHEAD IS STANDING IN, so the live one is marked. The
  // chips are a switch, not a readout — but a caption paused mid-word should
  // say which of the three you are looking at on the canvas, or the Unread tab
  // reads as broken when nothing on stage is unread.
  const liveState: CaptionState | null =
    captioned && clip.caption.cues.length > 0
      ? (activeCueAt(clip.caption, localMs)
          ? "focus"
          : cueStateAt(clip.caption.cues[clip.caption.cues.length - 1]!, localMs))
      : null;

  const chips: ScopeChip[] = [
    { id: "base", address: BASE_SCOPE, label: "Text", hint: "The whole layer", count: 0, Icon: Type },
  ];
  if (captioned && offer.has("caption")) {
    // Reading order, not schema order: what is coming, what is here, what is
    // done. The strip is one word's life, left to right.
    for (const state of CAPTION_STATES) {
      chips.push({
        id: `caption:${state}`,
        address: { kind: "caption", state },
        label: CAPTION_STATE_LABEL[state],
        hint: CAPTION_STATE_HINT[state],
        count: overlayCount(clip.caption.states[state].overlay),
        Icon: STATE_ICON[state],
        live: liveState === state,
      });
    }
  }
  if (liveRange && offer.has("range")) {
    chips.push({
      id: "range",
      address: liveRange,
      label: `${sel!.end - sel!.start} chars`,
      hint: "The characters you selected",
      count: overlayCount(sharedOverlayIn(clip.ranges, sel!.start, sel!.end)),
      Icon: TextSelect,
    });
  }

  // ONE chip is not a choice. A strip that offers only "Text" is furniture at
  // best and a prank at worst — it looks like a switch, and pressing the only
  // thing on it does nothing. The Sound tab is exactly this case for a caption
  // with no selection, which is why the check is on what was actually offered
  // rather than on what the layer is.
  if (chips.length < 2) return null;

  const activeId = scope.address.kind === "caption" ? `caption:${scope.address.state}` : scope.address.kind;

  return (
    <StickyScopeStrip>
      <div className="track flex min-w-0 flex-1 gap-0.5 bg-input/25">
        {chips.map((c) => {
          const active = activeId === c.id;
          return (
            <Tooltip key={c.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-pressed={active}
                  aria-label={c.label}
                  onClick={() => scope.setAddress(c.address)}
                  className={cn(
                    "relative flex h-6 min-w-0 items-center justify-center gap-1 rounded text-[11px] transition-colors",
                    // The selected chip takes the room ITS NAME needs and no
                    // more; the others divide what is left, evenly. Letting the
                    // active chip stretch to fill looked like a progress bar
                    // that had swallowed the panel, and it moved every other
                    // chip by a different amount each time you switched — so
                    // the target you wanted was never twice in the same place.
                    // This way the strip's rhythm is stable and only the label
                    // breathes.
                    active
                      ? "material-glass-raised shrink-0 px-2 text-foreground"
                      : "min-w-7 flex-1 text-muted-foreground hover:bg-background/40 hover:text-foreground",
                  )}
                >
                  <c.Icon className={cn("size-3 shrink-0", active && "text-primary")} />
                  {active && <span className="truncate">{c.label}</span>}
                  {c.count > 0 && (
                    <span
                      className={cn(
                        "shrink-0 font-mono text-primary",
                        active
                          ? "rounded-(--r-xs) bg-primary/20 px-1 text-[9px] leading-[14px]"
                          // Collapsed, the count is a bare numeral: a pill on a
                          // 28px chip is more chrome than fact.
                          : "text-[9px] leading-none",
                      )}
                    >
                      {c.count}
                    </span>
                  )}
                  {c.live && <span className="absolute right-0.5 top-0.5 size-1 rounded-full bg-primary" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {c.label}
                <span className="ml-1.5 text-muted-foreground">{c.hint}</span>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </StickyScopeStrip>
  );
}

// ── What this scope actually changes ─────────────────────────────────────────

const DOMAIN_LABEL: Record<OverrideDomain, string> = {
  typography: "Typography",
  highlight: "Highlight",
  fill: "Fill",
  stroke: "Stroke",
  effects: "Effects",
  textEffects: "Text effects",
  layer: "Layer",
};

/**
 * The OVERRIDES list — every field this scope has taken over, grouped by the
 * section that owns it, each one revertible on the spot.
 *
 * This is the answer to "what is different about these words?", which used to
 * be answerable only by walking every panel looking for a dot. It renders from
 * `overrideEntries`, which is a pure read of the overlay — so it can never list
 * an override that isn't there, or miss one that is, no matter which panel
 * created it.
 *
 * RESET LIVES HERE, in this header, and not on the tab strip. "Clear all of
 * this" is an action on a thing, and the thing is the list directly under it —
 * beside the tabs it read as "reset the tabs", sat a full panel away from the
 * overrides it would destroy, and took space five chips needed. Section-grain
 * revert ("Inherit all") and field-grain revert (the dot) already live in this
 * list; scope-grain revert is the same idea one level up, so it belongs in the
 * same place, not on the furniture.
 */
export function ScopeOverridesSection() {
  const scope = useScope();
  const update = useClipUpdater(scope?.clip.id ?? "");
  if (!scope || scope.isBase || scope.count === 0) return null;
  const entries = overrideEntries(scope.overlay);
  const byDomain = new Map<OverrideDomain, OverrideEntry[]>();
  for (const e of entries) {
    const arr = byDomain.get(e.domain);
    if (arr) arr.push(e);
    else byDomain.set(e.domain, [e]);
  }

  return (
    <PanelSection
      title="Overrides"
      count={entries.length}
      defaultOpen
      hint="What this scope changes about the layer. Click any row to inherit it again."
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Inherit everything in this scope"
              className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => {
                if (scope.address.kind === "caption") {
                  const state = scope.address.state;
                  update(`Reset ${CAPTION_STATE_LABEL[state].toLowerCase()}`, (c) => {
                    if (c.kind === "text" && c.caption) c.caption.states[state] = emptyCaptionState();
                  });
                } else if (scope.address.kind === "range") {
                  const { start, end } = scope.address;
                  update("Clear range styling", (c) => {
                    if (c.kind === "text") c.ranges = clearRange(c.ranges, start, end);
                  });
                }
              }}
            >
              <RotateCcw className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Inherit everything in this scope</TooltipContent>
        </Tooltip>
      }
    >
      <div className="flex flex-col gap-1.5">
        {[...byDomain].map(([domain, list]) => (
          <div key={domain} className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                {DOMAIN_LABEL[domain]}
              </span>
              <button
                type="button"
                className="rounded px-1 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() => scope.revertDomain(domain)}
              >
                Inherit all
              </button>
            </div>
            {list.map((e) => (
              <OverrideRow key={`${e.kind}:${e.id}`} entry={e} scope={scope} />
            ))}
          </div>
        ))}
      </div>
    </PanelSection>
  );
}

/** What one added/removed entry is called — an id is not a name. */
const ENTRY_NOUN: Record<OverrideDomain, string> = {
  typography: "style",
  highlight: "highlight",
  fill: "fill",
  stroke: "stroke",
  effects: "effect",
  textEffects: "text effect",
  layer: "entry",
};

function OverrideRow({ entry, scope }: { entry: OverrideEntry; scope: ScopeTarget }) {
  const label = entry.kind === "prop" ? pathLabel(entry.id) : ENTRY_NOUN[entry.domain];
  return (
    <div className="group/ov flex h-6 items-center gap-1.5 rounded pr-1 hover:bg-accent/40">
      {/* The row IS the door to the field. Listing what changed without a way
          to reach it makes you go hunting for the control you are already
          looking at the name of. */}
      <button
        type="button"
        title={`Go to ${label}`}
        onClick={() => revealInInspector(revealTargetFor(entry))}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-left"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px] group-hover/ov:underline group-hover/ov:decoration-dotted group-hover/ov:underline-offset-2">
          {entry.kind === "added" ? `Added ${label}` : entry.kind === "removed" ? `Removed ${label}` : label}
        </span>
      </button>
      {entry.value !== undefined && (
        <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">
          {formatValue(entry.value)}
        </span>
      )}
      {entry.kind === "prop" && (
        <button
          type="button"
          aria-label={`Inherit ${label}`}
          className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/ov:opacity-100"
          onClick={() => scope.revert(entry.id)}
        >
          <RotateCcw className="size-2.5" />
        </button>
      )}
    </div>
  );
}

/**
 * WHERE a path is edited — the reveal target for an override row.
 *
 * Clicking "Font size" in the Overrides list has to land you on the font size
 * field, not merely on the tab it lives in. The mapping is derived from the
 * path's own shape, which is the same thing `domainOfPath` already reads, so a
 * new scopable field is navigable the moment it is addressable. The entry id
 * (a fill, a stroke, an effect card) rides along so the ROW flashes too.
 */
function revealTargetFor(entry: OverrideEntry): { tab: InspectorTabId; section: string; entry?: string } {
  const id = entry.id;
  const listEntry = /^(?:fill|stroke|lfx)\.([^.]+)\./.exec(id)?.[1];
  switch (entry.domain) {
    case "highlight":
      return { tab: "design", section: "highlight" };
    case "fill":
      return { tab: "design", section: "fill", entry: listEntry ?? id };
    case "stroke":
      return { tab: "design", section: "stroke", entry: listEntry ?? id };
    case "effects":
      return { tab: "effects", section: "effects", entry: listEntry ?? id };
    case "textEffects":
      return { tab: "design", section: "text-effects", entry: listEntry ?? id };
    default:
      return { tab: "design", section: "typography" };
  }
}

/** A property path as a person would say it. The registry answers first. */
function pathLabel(path: string): string {
  const def = propertyDef(path);
  if (def) return def.label;
  const [head, , tail] = path.split(".");
  if (head === "highlight") return `Highlight ${path.slice(10)}`;
  if (head === "fill" || head === "stroke" || head === "lfx") {
    return `${head === "lfx" ? "Effect" : head[0]!.toUpperCase() + head.slice(1)} ${tail ?? ""}`.trim();
  }
  return path;
}

function formatValue(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "string") return v.length > 12 ? `${v.slice(0, 12)}…` : v;
  return "…";
}

export { PropRow };
