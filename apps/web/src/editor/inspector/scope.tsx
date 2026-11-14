"use client";

import * as React from "react";
import {
  BASE_SCOPE,
  applyBaseStyle,
  applyRangePatch,
  baseScope,
  clearOverlayDomain,
  clearOverlayProp,
  domainOfPath,
  CAPTION_STATE_LABEL,
  isCaptionClip,
  overlayAt,
  overlayCount,
  overriddenDomains,
  resolveOverlay,
  clipLocalTime,
  scopeKey,
  selectionScope,
  setClipProperty,
  writeOverlayPath,
  writeStyleToOverlay,
  type Clip,
  type KeyframeValue,
  type OverrideDomain,
  type PartialTextStyle,
  type ResolvedScope,
  type ScopeAddress,
  type ScopeOverlay,
  type TextClip,
} from "@solomotion/core";
import { RotateCcw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSession, useParkedPlayhead } from "../state/session";
import { useClipUpdater } from "./use-clip-updater";
import { MERGED_STYLE_KEYS } from "./merge";
import { ofKind, usePeers } from "./selection-scope";

/**
 * The SCOPE seam — what the sidebar is pointed at, and how a write lands.
 *
 * Every field in the inspector edits a property PATH. What it edits that path
 * ON is the scope: the layer, a caption's focus, or a text selection. The
 * fields never learn the difference. They ask this context for the value and
 * hand it a write, and the context decides whether that write mutates the clip
 * or lands in an overlay — which is the entire reason a caption's focus can
 * carry its own stroke without a single stroke control knowing captions exist.
 *
 * Three operations, and they are the whole parent/child contract:
 *
 *   write(path, v)   override this field here (or edit the base, at base)
 *   revert(path)     follow the parent again — a delete, so nothing lingers
 *   overridden(path) is this field mine or inherited?
 *
 * `overridden` is READ FROM THE OVERLAY, never tracked alongside it, so the dot
 * on a row, the count on a tab and the pixels on the canvas are three readings
 * of one fact and cannot disagree.
 */

export interface ScopeTarget {
  clip: TextClip;
  address: ScopeAddress;
  /** The look this scope resolves to — base with every override applied. */
  resolved: ResolvedScope;
  /** The overlay behind it; undefined at base, where there is nothing to override. */
  overlay: ScopeOverlay | undefined;
  /** True at `base` — where a write edits the layer itself. */
  isBase: boolean;
  write: (path: string, value: KeyframeValue, label: string, mergeKey?: string) => void;
  /** Fold a whole typographic patch in one undo step. */
  writeStyle: (patch: PartialTextStyle, label: string, mergeKey?: string) => void;
  /**
   * The same patch as a LIVE PREVIEW — no history, cleared with `null` — landing
   * exactly where `writeStyle` would. A font hovered while three letters are
   * selected previews on those three letters, not on the whole layer.
   */
  previewStyle: (patch: PartialTextStyle | null) => void;
  revert: (path: string, label?: string) => void;
  revertDomain: (domain: OverrideDomain) => void;
  overridden: (path: string) => boolean;
  /**
   * Raw overlay access for surfaces that write structure (paint/effect hosts).
   * The callback runs once per overlay the address covers — a focus is one, a
   * span may be several — with that overlay's resolved look and the parent it
   * resolves against.
   */
  editOverlay: (
    label: string,
    fn: (ov: ScopeOverlay, resolved: ResolvedScope, parent: ResolvedScope) => void,
    mergeKey?: string,
  ) => void;
  /** Domains carrying at least one override — drives the dot on a section header. */
  domains: Set<OverrideDomain>;
  count: number;
  setAddress: (a: ScopeAddress) => void;
}

const ScopeCtx = React.createContext<ScopeTarget | null>(null);

export function useScope(): ScopeTarget | null {
  return React.useContext(ScopeCtx);
}

/** The scope, but only when it is an OVERRIDE scope — the common guard. */
export function useOverrideScope(): ScopeTarget | null {
  const s = React.useContext(ScopeCtx);
  return s && !s.isBase ? s : null;
}

export function ScopeProvider({ value, children }: { value: ScopeTarget; children: React.ReactNode }) {
  return <ScopeCtx.Provider value={value}>{children}</ScopeCtx.Provider>;
}

/**
 * The one place a scope address is DERIVED, so the caret, the scope tabs and
 * every field agree about what is being edited without passing it around.
 *
 * With no chip chosen the sidebar follows the selection through core's
 * `selectionScope` — the layer, the word being spoken, or a range. A chosen
 * chip is checked against what exists right now: a range needs a live
 * sub-span and always reads the LIVE span, a focus needs a caption; otherwise
 * the layer. The choice itself is forgotten the moment the selection changes
 * (see `setTextSelection`), so it can never outlive the span it was about.
 */
export function useScopeAddress(clip: Clip): ScopeAddress {
  const editingClipId = useSession((s) => s.editingClipId);
  const sel = useSession((s) => s.textSelection);
  const choice = useSession((s) => s.scopeAddress);
  const playheadMs = useParkedPlayhead();
  if (clip.kind !== "text") return BASE_SCOPE;
  const live = editingClipId === clip.id ? sel : null;
  if (choice === null) return selectionScope(clip, live, clipLocalTime(clip, playheadMs) ?? 0);
  if (choice.kind === "range") {
    const auto = selectionScope(clip, live, clipLocalTime(clip, playheadMs) ?? 0);
    return auto.kind === "base" ? BASE_SCOPE : { kind: "range", start: live!.start, end: live!.end };
  }
  if (choice.kind === "caption") return isCaptionClip(clip) ? choice : BASE_SCOPE;
  return BASE_SCOPE;
}

/** Build the live target for a clip at the current address. */
export function useScopeTarget(clip: TextClip): ScopeTarget {
  const address = useScopeAddress(clip);
  const update = useClipUpdater(clip.id);
  const setAddress = useSession((s) => s.setScopeAddress);

  const overlay = overlayAt(clip, address);
  const resolved = resolveOverlay(baseScope(clip), overlay);
  const isBase = address.kind === "base";

  /**
   * Mutate the overlay this address points at, creating it if it isn't there.
   * The callback also receives the RESOLVED look, because a structural edit
   * (fork this list) has to start from what the scope currently shows, not from
   * the sparse delta that produced it.
   */
  const editOverlay: ScopeTarget["editOverlay"] = (label, fn, mergeKey) =>
    update(
      label,
      (c) => {
        if (c.kind !== "text") return;
        const parent = baseScope(c);
        if (address.kind === "caption") {
          if (!c.caption) return;
          const ov = c.caption.states[address.state].overlay;
          fn(ov, resolveOverlay(parent, ov), parent);
          return;
        }
        if (address.kind === "range") {
          // The span may cover several ranges, half of one, or none. The patch
          // visits each on its own detached overlay (and a fresh one for every
          // gap), so a write, a delete and a fork all land where they should
          // and a second edit accumulates onto the first. `applyRangePatch`
          // owns that algebra.
          c.ranges = applyRangePatch(c.ranges, address.start, address.end, {
            overlay: (ov) => fn(ov, resolveOverlay(parent, ov), parent),
          });
        }
      },
      mergeKey,
    );

  const write: ScopeTarget["write"] = (path, value, label, mergeKey) => {
    if (isBase) {
      update(label, (c) => setClipProperty(c, path, value), mergeKey);
      return;
    }
    editOverlay(label, (ov) => writeOverlayPath(ov, path, value), mergeKey && `${scopeKey(address)}-${mergeKey}`);
  };

  const writeStyle: ScopeTarget["writeStyle"] = (patch, label, mergeKey) => {
    // `textEffects` is a LIST, not a key: it cannot live in the overlay's flat
    // prop map, so an off-base write routes to the overlay's `added` list
    // instead. `styleAt` resolves the two the same way, so this is the only
    // place the difference is visible.
    if (!isBase && patch.textEffects) {
      const { textEffects, ...rest } = patch;
      editOverlay(
        label,
        (ov, resolved) => {
          const inherited = new Set(resolved.style.textEffects.map((e) => e.id));
          const next = textEffects;
          // Anything inherited that this scope no longer lists is REMOVED here;
          // anything new is ADDED. Untouched entries stay inherited, so the
          // layer's own shadow keeps following the layer.
          ov.added.textEffects = next.filter((e) => !inherited.has(e.id));
          const kept = new Set(next.map((e) => e.id));
          ov.removed = [
            ...ov.removed.filter((id) => !inherited.has(id)),
            ...[...inherited].filter((id) => !kept.has(id)),
          ];
          // A field changed on an entry this scope INHERITED becomes a prop
          // override, so everything else about it still follows the layer.
          for (const e of next) {
            if (!inherited.has(e.id)) continue;
            const base = resolved.style.textEffects.find((x) => x.id === e.id);
            if (!base) continue;
            for (const [k, v] of Object.entries(e)) {
              if (k === "id" || k === "type") continue;
              if (!Object.is((base as unknown as Record<string, unknown>)[k], v)) {
                ov.props[`tfx.${e.id}.${k}`] = v as KeyframeValue;
              }
            }
          }
          if (Object.keys(rest).length > 0) writeStyleToOverlay(ov, rest);
        },
        mergeKey && `${scopeKey(address)}-${mergeKey}`,
      );
      return;
    }
    if (isBase) {
      update(
        label,
        (c) => {
          if (c.kind === "text") applyBaseStyle(c, patch);
        },
        mergeKey,
      );
      return;
    }
    editOverlay(label, (ov) => writeStyleToOverlay(ov, patch), mergeKey && `${scopeKey(address)}-${mergeKey}`);
  };

  const previewStyle: ScopeTarget["previewStyle"] = (patch) => {
    if (!patch) {
      update.preview(null);
      return;
    }
    update.preview((c) => {
      if (c.kind !== "text") return;
      if (address.kind === "base") applyBaseStyle(c, patch);
      else if (address.kind === "range") {
        c.ranges = applyRangePatch(c.ranges, address.start, address.end, {
          overlay: (ov) => writeStyleToOverlay(ov, patch),
        });
      } else if (address.kind === "caption" && c.caption) {
        writeStyleToOverlay(c.caption.states[address.state].overlay, patch);
      }
    });
  };

  const revert: ScopeTarget["revert"] = (path, label) => {
    if (isBase) return;
    editOverlay(label ?? "Inherit from text", (ov) => clearOverlayProp(ov, path));
  };

  const revertDomain: ScopeTarget["revertDomain"] = (domain) => {
    if (isBase) return;
    editOverlay("Inherit section", (ov, _resolved, parent) => clearOverlayDomain(ov, domain, parent));
  };

  return {
    clip,
    address,
    resolved,
    overlay,
    isBase,
    write,
    writeStyle,
    previewStyle,
    editOverlay,
    revert,
    revertDomain,
    overridden: (path) => !isBase && !!overlay && path in overlay.props,
    domains: overriddenDomains(overlay),
    count: overlayCount(overlay),
    setAddress,
  };
}

/**
 * The style VALUE a field should display: the scope's RESOLVED style — at base
 * the layer's own, in a scope the layer's with every override on top, added
 * glows included. So an untouched focus field reads the inherited number
 * instead of a blank, which is the visible half of "absence means
 * inheritance", and the section showing a range's text effects shows the same
 * list the renderer paints.
 */
export function useScopeStyle(target: ScopeTarget): PartialTextStyle {
  const peers = usePeers(target.clip, isText);
  const { address, resolved } = target;
  return React.useMemo(() => {
    if (peers.length < 2) return resolved.style;
    // Across a selection, a typographic key the texts DISAGREE on is left out
    // — StyleFields renders an absent key as "Mixed", so this is the whole
    // Mixed state for typography. Each peer is read at the same scope address
    // (a caption state is per layer; the base is the base).
    const others = peers.slice(1).map((c) => resolveOverlay(baseScope(c), overlayAt(c, address)).style);
    const out: PartialTextStyle = { ...resolved.style };
    for (const key of MERGED_STYLE_KEYS) {
      if (others.some((o) => !Object.is(o[key], resolved.style[key]))) delete out[key];
    }
    return out;
  }, [peers, address, resolved]);
}

const isText = ofKind("text");

// ── The row affordance ───────────────────────────────────────────────────────

/**
 * The override MARKER — a dot on the label of any field this scope has taken
 * over, and the door back to inheriting it.
 *
 * It sits on the LABEL rather than in a new column on purpose: the row grid is
 * 56px · fluid · 20px everywhere in the app, and a fourth column to say
 * "sometimes" would move every field in the panel by a few pixels the moment
 * you switched scopes. Figma marks an instance's overridden property the same
 * way, and for the same reason.
 */
export function OverrideDot({ path, label }: { path: string; label?: string }) {
  const scope = useOverrideScope();
  if (!scope || !scope.overridden(path)) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label ?? path} is overridden — click to inherit`}
          onClick={(e) => {
            e.stopPropagation();
            scope.revert(path);
          }}
          className="group/dot -ml-0.5 flex size-3 shrink-0 items-center justify-center rounded-full text-primary"
        >
          <span className="size-1.5 rounded-full bg-primary transition-opacity group-hover/dot:opacity-0" />
          <RotateCcw className="absolute size-2.5 opacity-0 transition-opacity group-hover/dot:opacity-100" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">Overridden here — click to inherit</TooltipContent>
    </Tooltip>
  );
}

/** The same marker at SECTION grain: a dot in the header, click reverts the lot. */
export function DomainRevert({ domain, title }: { domain: OverrideDomain; title: string }) {
  const scope = useOverrideScope();
  if (!scope || !scope.domains.has(domain)) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Reset ${title} to inherited`}
          onClick={(e) => {
            e.stopPropagation();
            scope.revertDomain(domain);
          }}
          className="flex size-4 items-center justify-center rounded text-primary hover:bg-primary/10"
        >
          <RotateCcw className="size-2.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">Reset to inherited</TooltipContent>
    </Tooltip>
  );
}

/** `domainOfPath`, re-exported so panels don't import from two places. */
export { domainOfPath };

/** A section header dot: this section holds overrides in the current scope. */
export function useDomainOverridden(domain: OverrideDomain): boolean {
  const scope = useOverrideScope();
  return !!scope?.domains.has(domain);
}

export function scopeLabel(a: ScopeAddress): string {
  if (a.kind === "base") return "Text";
  if (a.kind === "caption") return CAPTION_STATE_LABEL[a.state];
  return a.kind === "range" ? "Range" : "Contour";
}

export function cnScopeTint(active: boolean): string {
  return cn(active && "text-primary");
}
