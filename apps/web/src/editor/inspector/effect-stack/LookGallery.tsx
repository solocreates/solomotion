"use client";

import * as React from "react";
import { LFX, TEXTURE_LOOK_GROUP, effectGroups, lookShortId, type LayerEffect, type Preset } from "@solomotion/core";
import { ChevronDown, Plus, Search, Star, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useTypeToFocus } from "../../input/use-type-to-focus";
import { usePresets } from "../effect-editor/use-presets";
import { useLookThumb, type LookSubject } from "./look-thumbs";
import { NAMES } from "@/editor/names";

/**
 * THE LOOK ROW AND ITS GALLERY (D13) — the one door to looks for every
 * selection: a layer, a text layer, a frame.
 *
 * Who opens it, and why: "make this look like something" (try a few, keep
 * one), then "back it off" (mix — on the group card), then rarely "keep this
 * one for later" (save). So the row is tier 1 — the current look's name and a
 * few live tiles you can click without opening anything; the gallery is tier 2;
 * saving is a footer line.
 *
 * Applying is a SWAP when the stack already wears a look: clicking ten tiles
 * is ten tries on one group, never ten stacked looks. Clicking the lit tile
 * takes the look off.
 */

const FAV_KEY = NAMES.storage.lookFavourites;
function readFavs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function useFavourites() {
  const [favs, setFavs] = React.useState<Set<string>>(() => (typeof window === "undefined" ? new Set() : readFavs()));
  const toggle = (id: string) =>
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  return { favs, toggle };
}

export interface LookTarget {
  /** The stack the look lands on (the layer's, or the frame's effects). */
  effects: readonly LayerEffect[];
  /** For the live tiles. `into` is filled in here. */
  subject: Omit<LookSubject, "into"> | null;
  apply: (preset: Preset, into: string | null) => void;
  remove: (groupId: string) => void;
  /** Save the current look (its group's cards) to the library. */
  save?: () => void;
}

/** The looks a layer stack can wear, built-in first, in library order. */
function useLooks() {
  const { presets } = usePresets(LFX.stackPresetKind);
  return presets;
}

function LookTile({
  preset,
  subject,
  on,
  fav,
  onPick,
  onFav,
  size = "md",
}: {
  preset: Preset;
  subject: LookSubject | null;
  on: boolean;
  fav?: boolean;
  onPick: () => void;
  onFav?: () => void;
  size?: "sm" | "md";
}) {
  const w = size === "sm" ? 40 : 96;
  const h = size === "sm" ? 28 : 60;
  const ref = useLookThumb(subject, preset, w, h);
  const [ground, ink] = preset.chip ?? ["#e8e4dc", "#6b6b6b"];
  const pic = (
    <span className="relative block overflow-hidden rounded-[4px]" style={{ width: "100%", aspectRatio: `${w} / ${h}`, background: ground }}>
      {/* The chip colours stand in until the live render lands. */}
      <span className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: ink }} />
      <canvas ref={ref} className="absolute inset-0 size-full bg-[var(--raised)] object-contain" style={{ width: "100%", height: "100%" }} />
    </span>
  );
  if (size === "sm") {
    return (
      <button
        type="button"
        title={on ? `${preset.name} — click to remove` : preset.name}
        aria-pressed={on}
        onClick={onPick}
        className={cn("min-w-0 rounded-[6px] p-0.5 transition-colors hover:bg-white/5", on && "bg-primary/15")}
      >
        {pic}
      </button>
    );
  }
  return (
    <div className="group/tile relative min-w-0">
      <button
        type="button"
        data-look={preset.id}
        aria-pressed={on}
        onClick={onPick}
        title={on ? "Click to remove" : preset.fps ? `Holds the layer at ${preset.fps} fps` : undefined}
        className={cn(
          "flex w-full min-w-0 flex-col gap-1 rounded-md p-1 text-left outline-none transition-colors",
          "hover:bg-white/5 active:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-primary/60",
          on && "bg-primary/15",
        )}
      >
        {pic}
        <span className={cn("truncate px-0.5 text-[11px] leading-[14px]", on ? "text-primary" : "text-muted-foreground group-hover/tile:text-foreground")}>
          {preset.name}
        </span>
      </button>
      {onFav && (
        <button
          type="button"
          aria-label={fav ? "Remove from favourites" : "Add to favourites"}
          onClick={onFav}
          className={cn(
            "absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-[4px] bg-black/45 text-white transition-opacity [&_svg]:size-3",
            fav ? "opacity-100" : "opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Star className={fav ? "fill-current" : undefined} />
        </button>
      )}
    </div>
  );
}

const ALL = "All";
const FAVS = "Favourites";
const SAVED = "Saved";

function LookGallery({ target, into, onDone }: { target: LookTarget; into: string | null; onDone: () => void }) {
  const looks = useLooks();
  const { favs, toggle } = useFavourites();
  const [query, setQuery] = React.useState("");
  const [cat, setCat] = React.useState(ALL);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  useTypeToFocus(searchRef);
  const worn = wornGroup(target.effects, into);
  const subject = target.subject ? { ...target.subject, into: worn?.id ?? null } : null;

  const cats = React.useMemo(() => {
    const groups = [...new Set(looks.filter((p) => p.scope === "builtin").map((p) => p.group).filter(Boolean))] as string[];
    return [ALL, ...(favs.size ? [FAVS] : []), ...groups, ...(looks.some((p) => p.scope !== "builtin") ? [SAVED] : [])];
  }, [looks, favs.size]);

  const q = query.trim().toLowerCase();
  const shown = looks.filter((p) => {
    if (q) return p.name.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)) || (p.group ?? "").toLowerCase().includes(q);
    if (cat === ALL) return true;
    if (cat === FAVS) return favs.has(p.id);
    if (cat === SAVED) return p.scope !== "builtin";
    return p.scope === "builtin" && p.group === cat;
  });

  const pick = (p: Preset) => {
    if (worn && worn.look === lookShortId(p)) target.remove(worn.id);
    else target.apply(p, worn?.id ?? null);
  };

  return (
    <div className="flex max-h-[min(70vh,560px)] flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
        <span className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search looks"
            className="h-7 w-full rounded-[6px] bg-[var(--raised)] pl-7 pr-2 text-[12px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/60"
          />
        </span>
      </div>
      {!q && (
        <div className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-1 pt-2 [scrollbar-width:none]">
          {cats.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={cn(
                "h-6 shrink-0 rounded-[6px] px-2 text-[11px] transition-colors",
                cat === c ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              )}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {shown.length ? (
          <div className="grid grid-cols-3 gap-0.5">
            {shown.map((p) => (
              <LookTile
                key={p.id}
                preset={p}
                subject={subject}
                on={worn?.look === lookShortId(p)}
                fav={favs.has(p.id)}
                onFav={() => toggle(p.id)}
                onPick={() => pick(p)}
              />
            ))}
          </div>
        ) : (
          <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">No looks match “{query || cat}”.</p>
        )}
      </div>
      {(target.save || worn) && (
        <div className="flex shrink-0 items-center gap-1 border-t border-border/60 px-2 py-1.5">
          {target.save && worn && (
            <button
              type="button"
              onClick={() => {
                onDone();
                target.save!();
              }}
              className="flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-muted-foreground hover:bg-white/5 hover:text-foreground [&_svg]:size-3.5"
            >
              <Plus /> Save current as look
            </button>
          )}
          {worn && (
            <button
              type="button"
              onClick={() => {
                target.remove(worn.id);
                onDone();
              }}
              className="ml-auto flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-muted-foreground hover:bg-white/5 hover:text-foreground [&_svg]:size-3.5"
            >
              <X /> Remove look
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The group a gallery acts on: the one it was opened for, else the stack's first. */
function wornGroup(effects: readonly LayerEffect[], into: string | null) {
  const groups = effectGroups(effects) as unknown as Array<{ id: string; name: string; look?: string }>;
  return (into ? groups.find((g) => g.id === into) : undefined) ?? groups[0] ?? null;
}

/** The gallery as a popover around any trigger — the group card's swap button uses it too. */
export function LookGalleryPopover({
  target,
  into = null,
  children,
  open: openProp,
  onOpenChange,
}: {
  target: LookTarget;
  into?: string | null;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = React.useState(false);
  const open = openProp ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-[332px] max-w-[calc(100vw-32px)] p-0">
        {open && <LookGallery target={target} into={into} onDone={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The Look row — first thing in Effects. `inline` (frames) shows the
 * gallery's first six as tiles right in the panel: a frame is where "this
 * looks flat" gets asked most, so its answer must not hide behind a click.
 */
export function LookRow({ target, inline = false }: { target: LookTarget; inline?: boolean }) {
  const looks = useLooks();
  const worn = wornGroup(target.effects, null);
  const subject = target.subject ? { ...target.subject, into: worn?.id ?? null } : null;
  // A frame's six lead with the Texture looks — the frame's "this looks flat".
  const quick = (inline ? [...looks.filter((p) => p.group === TEXTURE_LOOK_GROUP), ...looks.filter((p) => p.group !== TEXTURE_LOOK_GROUP)] : looks).slice(0, inline ? 6 : 4);
  const pick = (p: Preset) => {
    if (worn && worn.look === lookShortId(p)) target.remove(worn.id);
    else target.apply(p, worn?.id ?? null);
  };

  const trigger = (
    <button
      type="button"
      className="flex h-7 min-w-[4.5rem] max-w-[60%] shrink-0 items-center gap-1 rounded-[6px] px-2 text-[12px] font-[550] hover:bg-white/5 [&_svg]:size-3.5"
      title="All looks"
    >
      <span className={cn("truncate", !worn && "text-muted-foreground")}>{worn?.name ?? "None"}</span>
      <ChevronDown className="shrink-0 text-muted-foreground" />
    </button>
  );

  if (inline) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-[550]">Look</span>
          <LookGalleryPopover target={target}>{trigger}</LookGalleryPopover>
        </div>
        <div className="grid grid-cols-3 gap-0.5">
          {quick.map((p) => (
            <LookTile key={p.id} preset={p} subject={subject} on={worn?.look === lookShortId(p)} onPick={() => pick(p)} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex h-7 items-center gap-1">
        <span className="w-14 shrink-0 text-[12px] font-[550]">Look</span>
        <LookGalleryPopover target={target}>{trigger}</LookGalleryPopover>
      </div>
      <div className="grid grid-cols-4 gap-0.5">
        {quick.map((p) => (
          <LookTile key={p.id} size="sm" preset={p} subject={subject} on={worn?.look === lookShortId(p)} onPick={() => pick(p)} />
        ))}
      </div>
    </div>
  );
}
