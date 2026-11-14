"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { pickCandidates, resolvePick, searchDocNodes, type PickCandidate } from "@solomotion/core";
import { Crosshair, X } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useDoc } from "../state/document-context";
import { KeyCaps } from "@/components/ui/kbd";
import { PickGlyph } from "./PickGlyph";
import { TYPE_CHIP } from "../expressions/expression-theme";
import {
  commitRefined,
  exitPick,
  locateKey,
  PICK_TAGGED,
  boxOfRect,
  keyOfElement,
  pickAcceptsKey,
  pickAreaAllowed,
  pickPrompt,
  pickSurfaces,
  usePickMode,
  type PickBox,
  type PickSurface,
} from "./pick-mode";

/**
 * EVERYTHING THE PICK MODE DRAWS, in one layer mounted once at the shell:
 * the chip that says what is being asked, the frame that says the whole app is
 * in a mode, the veil over each canvas with the candidates cut out of it, the
 * box around the candidate under the pointer, and — for a pick-whip — the menu
 * of values at the point it landed.
 *
 * ONE box component for every surface. A clip bar, a layer row and a rotated
 * layer on the stage all get the same outline, the same glow, the same name
 * tag, so "this is the thing you will get" reads identically wherever you are
 * pointing. Everything here is `pointer-events: none` except the chip and the
 * menu (`data-pick-ui`), so the dispatcher's `elementFromPoint` sees through it.
 */
export function PickModeLayer() {
  const request = usePickMode((s) => s.request);
  const preview = usePickMode((s) => s.preview);
  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      {request && <ArmedLayer />}
      {!request && preview && <PreviewBox pickKey={preview} />}
    </>,
    document.body,
  );
}

function ArmedLayer() {
  const request = usePickMode((s) => s.request)!;
  const hover = usePickMode((s) => s.hover);
  const refine = usePickMode((s) => s.refine);
  const refusals = usePickMode((s) => s.refusals);
  const doc = useDoc();
  const hovered = hover ? resolvePick(doc, hover.key) : null;
  return (
    <>
      {/* The mode, at the edge of the window: unmistakable, never in the way. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[96] rounded-[10px] shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--primary)_55%,transparent),inset_0_0_32px_color-mix(in_srgb,var(--primary)_14%,transparent)]" />
      <SurfaceVeils />
      {hover && hovered && !refine && <HighlightBox box={hover.box} candidate={hovered} />}
      {refine && <RefineMenu />}
      <ModeChip prompt={refine ? `${refine.picked.name} · pick a value` : pickPrompt(request)} nod={refusals} />
    </>
  );
}

// ── The chip ─────────────────────────────────────────────────────────────────

function ModeChip({ prompt, nod }: { prompt: string; nod: number }) {
  // A press on something that cannot be picked NODS the chip — the reason is
  // the chip's own words, already on screen.
  const [nodding, setNodding] = React.useState(false);
  React.useEffect(() => {
    if (!nod) return;
    setNodding(true);
    const t = setTimeout(() => setNodding(false), 320);
    return () => clearTimeout(t);
  }, [nod]);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex justify-center px-4">
      <div
        data-pick-ui
        role="status"
        className={cn(
          "material-glass-raised pointer-events-auto flex h-[var(--control-h)] max-w-full items-center gap-2 rounded-full pl-2.5 pr-1 text-sm shadow-[var(--elevation-3)]",
          nodding && "animate-[tm-pick-nod_320ms_ease-in-out]",
        )}
      >
        <Crosshair className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 truncate font-medium">{prompt}</span>
        <KeyCaps combo="Esc" className="shrink-0 opacity-70" />
        <button
          type="button"
          aria-label="Stop picking"
          onClick={() => exitPick("cancel")}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <style>{"@keyframes tm-pick-nod{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}"}</style>
    </div>
  );
}

// ── The box ──────────────────────────────────────────────────────────────────

/** A box's four corners in client px, through the same rotate·skew a CSS
 *  transform applies — so the veil's hole and the outline are one shape. */
export function boxCorners(b: PickBox): Array<[number, number]> {
  const kx = Math.tan((b.skewX * Math.PI) / 180);
  const ky = Math.tan((b.skewY * Math.PI) / 180);
  const r = (b.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const x = (sx * b.w) / 2;
    const y = (sy * b.h) / 2;
    const px = x + kx * y;
    const py = ky * x + y;
    return [b.cx + px * c - py * s, b.cy + px * s + py * c];
  });
}

const boxStyle = (b: PickBox): React.CSSProperties => ({
  left: b.cx,
  top: b.cy,
  width: Math.max(4, b.w),
  height: Math.max(4, b.h),
  transform: `translate(-50%, -50%) rotate(${b.rotation}deg) skew(${b.skewX}deg, ${b.skewY}deg)`,
});

function HighlightBox({ box, candidate, quiet = false }: { box: PickBox; candidate: PickCandidate; quiet?: boolean }) {
  const corners = boxCorners(box);
  const top = Math.min(...corners.map((p) => p[1]));
  const left = Math.min(...corners.map((p) => p[0]));
  // The tag sits above the box's highest point, upright whatever the layer's
  // rotation — a name is read, not decoded — and flips inside near the top edge.
  const tagTop = top > 34 ? top - 26 : Math.max(...corners.map((p) => p[1])) + 6;
  return (
    <>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none fixed z-[97] rounded-[4px] transition-[left,top,width,height] duration-[90ms] ease-out",
          quiet
            ? "border border-dashed border-primary/80"
            : "border-[1.5px] border-primary bg-primary/10 shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_22%,transparent),0_0_22px_2px_color-mix(in_srgb,var(--primary)_32%,transparent)]",
        )}
        style={boxStyle(box)}
      >
        {!quiet &&
          (["-left-1 -top-1 border-l-2 border-t-2", "-right-1 -top-1 border-r-2 border-t-2", "-bottom-1 -right-1 border-b-2 border-r-2", "-bottom-1 -left-1 border-b-2 border-l-2"] as const).map((c) => (
            <span key={c} className={cn("absolute size-2 rounded-[1px] border-primary", c)} />
          ))}
      </div>
      <div
        aria-hidden
        className="material-glass pointer-events-none fixed z-[98] flex h-5 max-w-64 items-center gap-1.5 rounded-full px-2 text-xs"
        style={{ left: Math.max(8, Math.min(left, window.innerWidth - 120)), top: tagTop }}
      >
        <PickGlyph candidate={candidate} className="size-3 shrink-0 text-primary" />
        <span className="min-w-0 truncate font-medium">{candidate.name}</span>
        {candidate.where && <span className="min-w-0 truncate text-muted-foreground">{candidate.where}</span>}
      </div>
    </>
  );
}

/** A field's list row is hovered: show where that object is, quietly. */
function PreviewBox({ pickKey }: { pickKey: string }) {
  const doc = useDoc();
  const candidate = resolvePick(doc, pickKey);
  const box = candidate ? locateKey(pickKey) : null;
  return box && candidate ? <HighlightBox box={box} candidate={candidate} quiet /> : null;
}

// ── The veil ─────────────────────────────────────────────────────────────────

interface Veil {
  surface: PickSurface;
  rect: DOMRect;
  holes: PickBox[];
}

/**
 * Each canvas dims under a veil with its candidates CUT OUT, so what you may
 * pick is the only thing at full brightness — without re-rendering a single
 * layer. Polled once per frame against the surface's `version()` (camera,
 * redraw), which costs a comparison when nothing moved.
 */
function SurfaceVeils() {
  const [veils, setVeils] = React.useState<Veil[]>([]);
  React.useEffect(() => {
    let raf = 0;
    const seen = new Map<PickSurface, unknown>();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      let changed = seen.size !== pickSurfaces().size;
      for (const s of pickSurfaces()) {
        const v = s.version();
        if (seen.get(s) !== v) changed = true;
        seen.set(s, v);
      }
      if (!changed) return;
      setVeils([...pickSurfaces()].map((surface) => ({ surface, rect: surface.element.getBoundingClientRect(), holes: pickAreaAllowed(surface.area) ? [...surface.boxes(pickAcceptsKey).map((b) => b.box), ...overlayHoles(surface)] : [] })));
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <>
      {veils.map(({ rect, holes }, i) => (
        <svg
          key={i}
          aria-hidden
          className="pointer-events-none fixed z-[95]"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          viewBox={`${rect.left} ${rect.top} ${rect.width} ${rect.height}`}
        >
          <defs>
            <mask id={`tm-pick-veil-${i}`}>
              <rect x={rect.left} y={rect.top} width={rect.width} height={rect.height} fill="white" />
              {holes.map((h, j) => (
                <polygon key={j} points={boxCorners(h).join(" ")} fill="black" />
              ))}
            </mask>
          </defs>
          <rect x={rect.left} y={rect.top} width={rect.width} height={rect.height} fill="rgb(0 0 0 / 0.5)" mask={`url(#tm-pick-veil-${i})`} />
          {holes.map((h, j) => (
            <polygon key={j} points={boxCorners(h).join(" ")} fill="none" stroke="var(--primary)" strokeOpacity={0.45} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      ))}
    </>
  );
}

/**
 * Candidates a canvas draws in the DOM over itself (a tracker's outline) are
 * holes in its veil too — the same tags the dispatcher picks them by.
 */
function overlayHoles(surface: PickSurface): PickBox[] {
  const out: PickBox[] = [];
  for (const el of surface.element.querySelectorAll(PICK_TAGGED)) {
    const key = keyOfElement(el);
    if (!key || !pickAcceptsKey(key)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push(boxOfRect(r, 4));
  }
  return out;
}

// ── The refinement menu ──────────────────────────────────────────────────────

const MENU_W = 264;

/**
 * A pick-whip landed on a layer: which of its values? Opens AT the point it
 * landed — the eye is already there — with the field's own path first, so the
 * common case (rotation → rotation) is a single Enter.
 */
function RefineMenu() {
  const doc = useDoc();
  const refine = usePickMode((s) => s.refine)!;
  const [search, setSearch] = React.useState("");
  const root = React.useRef<HTMLDivElement>(null);
  const { picked, refinement, at } = refine;

  const all = React.useMemo(() => pickCandidates(doc, refinement.filter), [doc, refinement.filter]);
  const rows = React.useMemo(() => searchDocNodes(all, search), [all, search]);
  const preferred = !search ? all.find((c) => c.key === refinement.prefer) : undefined;
  const groups = React.useMemo(() => {
    const out = new Map<string, PickCandidate[]>();
    for (const c of rows) {
      if (c === preferred) continue;
      const g = c.group ?? "";
      out.set(g, [...(out.get(g) ?? []), c]);
    }
    return [...out];
  }, [rows, preferred]);

  // Keyboard first without raising a soft keyboard: the ROOT takes focus (cmdk
  // steers from it), the search field takes the first printable key.
  React.useEffect(() => root.current?.focus(), []);

  const left = Math.max(8, Math.min(at.x + 8, window.innerWidth - MENU_W - 8));
  const top = Math.max(8, Math.min(at.y + 8, window.innerHeight - 360));
  const whole = refinement.allowPicked;
  const row = (c: PickCandidate) => (
    <CommandItem key={c.key} value={c.key} onSelect={() => commitRefined(c)} className="gap-2">
      <PickGlyph candidate={c} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
      {c.type && <span className="shrink-0 text-3xs uppercase tracking-wide text-muted-foreground/70">{TYPE_CHIP[c.type]}</span>}
    </CommandItem>
  );

  return (
    <div data-pick-ui className="material-glass fixed z-[100] overflow-hidden p-0" style={{ left, top, width: MENU_W }}>
      <Command ref={root} tabIndex={-1} shouldFilter={false} loop className="bg-transparent outline-none">
        <CommandInput value={search} onValueChange={setSearch} placeholder={`${picked.name}…`} />
        <CommandList className="max-h-80">
          <CommandEmpty>No value fits</CommandEmpty>
          {whole && !search && (
            <CommandGroup>
              <CommandItem value="__whole" onSelect={() => commitRefined(picked)} className="gap-2">
                <PickGlyph candidate={picked} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{whole}</span>
              </CommandItem>
            </CommandGroup>
          )}
          {preferred && <CommandGroup heading="Same property">{row(preferred)}</CommandGroup>}
          {groups.map(([heading, list]) => (
            <CommandGroup key={heading} heading={heading || undefined}>
              {list.slice(0, 60).map(row)}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </div>
  );
}
