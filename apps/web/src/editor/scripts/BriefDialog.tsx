"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import {
  Boxes,
  Check,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  Library,
  Music,
  Palette,
  PenTool,
  Plus,
  Search,
  Shapes,
  Sparkles,
  Type,
  Users,
} from "lucide-react";
import {
  BRIEF_FOCUSES,
  BRIEF_GROUPS,
  briefSections,
  briefTokens,
  composeBrief,
  focusSelection,
  type BriefPack,
  type BriefSection,
  type Script,
} from "@solomotion/core";
import { SKILL_FILES } from "../agent/bridge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { getDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { agentApi, allPacks, BUILTIN_SKILL_ID } from "../agent/runner";
import { useAgent } from "../agent/store";
import { KnowledgeDialog } from "../agent/ui/KnowledgeDialog";
import { useCopied } from "../console/console-report";
import { NAMES } from "@/editor/names";

/**
 * THE BRIEF COMPOSER — choose what a chatbox learns before it writes a script.
 *
 * Sections come from `briefSections` (the skill, the catalogs, the registry,
 * the project, the person's own packs); a focus is a one-tap selection of
 * them; every checkbox after that is the person's, and the choice is
 * remembered on this device. Each row can open to show exactly what it will
 * paste, and the footer says what it costs in tokens.
 */

const FOCUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  everyday: Sparkles,
  motion: Clapperboard,
  type: Type,
  sound: Music,
  "3d": Boxes,
  drawing: PenTool,
  characters: Users,
  editing: Shapes,
  color: Palette,
  all: Library,
};

const PREFS_KEY = NAMES.storage.scriptsBrief;

interface Prefs {
  /** The focus last picked, or null once the person tuned it by hand. */
  focus: string | null;
  chosen: string[];
}

function readPrefs(): Prefs | null {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Prefs) : null;
  } catch {
    return null;
  }
}

function writePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode — the choice just isn't remembered */
  }
}

function formatTokens(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/** Where a brief stops fitting comfortably in an ordinary chat. */
const HEAVY_TOKENS = 60_000;

export function BriefDialog({ open, onOpenChange, script, lastRun }: { open: boolean; onOpenChange: (open: boolean) => void; script: Script | null; lastRun?: string }) {
  const packsVersion = useAgent((s) => s.packs);
  const disabled = useAgent((s) => s.settings.disabledPacks);
  const instructions = useAgent((s) => s.settings.instructions);
  const [knowledge, setKnowledge] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) void useAgent.getState().load();
  }, [open]);

  const packs = React.useMemo<Array<BriefPack & { enabled: boolean }>>(
    () =>
      allPacks()
        .filter((p) => p.id !== BUILTIN_SKILL_ID)
        .map((p) => ({ id: p.id, name: p.name, kind: p.kind, description: p.description, entry: p.files[p.entry] ?? "", enabled: p.enabled })),
    // allPacks reads the store; these are what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [packsVersion, disabled],
  );

  const sections = React.useMemo(() => {
    const doc = getDocStore()?.getState();
    if (!open || !doc) return [];
    return briefSections({
      appName: identity.name,
      registry: agentApi(),
      doc,
      focusFrameId: useSession.getState().activeFrameId,
      skill: SKILL_FILES,
      packs,
      instructions,
      ...(script ? { script } : {}),
      ...(lastRun ? { lastRun } : {}),
    });
  }, [open, packs, instructions, script, lastRun]);

  // The person's own enabled knowledge rides along with any focus — it is theirs.
  const alwaysOn = React.useMemo(() => [...packs.filter((p) => p.enabled).map((p) => `pack:${p.id}`), "instructions"], [packs]);
  const [prefs, setPrefs] = React.useState<Prefs>(() => readPrefs() ?? { focus: "everyday", chosen: [] });
  const ids = React.useMemo(() => sections.map((s) => s.id), [sections]);
  const chosen = React.useMemo(() => (prefs.focus ? focusSelection(prefs.focus, alwaysOn, ids) : new Set(prefs.chosen)), [prefs, alwaysOn, ids]);
  // What each focus would cost, so "Everything" can say how heavy it is before you pick it.
  const focusTokens = React.useMemo(
    () => new Map(sections.length ? BRIEF_FOCUSES.map((f) => [f.id, briefTokens(composeBrief(sections, focusSelection(f.id, alwaysOn, ids), identity.name))]) : []),
    [sections, alwaysOn, ids],
  );

  const update = (next: Prefs) => {
    setPrefs(next);
    writePrefs(next);
  };
  const toggle = (ids: string[], on: boolean) => {
    const set = new Set(chosen);
    for (const id of ids) (on ? set.add(id) : set.delete(id));
    update({ focus: null, chosen: [...set] });
  };

  const text = React.useMemo(() => composeBrief(sections, chosen, identity.name), [sections, chosen]);
  const tokens = briefTokens(text);
  const q = query.trim().toLowerCase();
  const visible = q ? sections.filter((s) => `${s.title} ${s.blurb} ${s.id}`.toLowerCase().includes(q)) : sections;

  const { copied, copy: copyText } = useCopied(2000);
  const copy = () => void copyText(text);
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: NAMES.files.brief });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex h-[min(760px,92vh)] max-w-2xl flex-col gap-0 overflow-hidden p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="shrink-0 space-y-3 px-5 pb-3 pt-4">
            <DialogTitle className="text-base">Brief for AI</DialogTitle>
            <div className="-mx-5 flex gap-1.5 overflow-x-auto px-5 pb-0.5 [scrollbar-width:none]" role="radiogroup" aria-label="Focus">
              {BRIEF_FOCUSES.map((f) => {
                const Icon = FOCUS_ICON[f.id] ?? Sparkles;
                const active = prefs.focus === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => update({ focus: f.id, chosen: [] })}
                    title={focusTokens.has(f.id) ? `≈ ${formatTokens(focusTokens.get(f.id)!)} tokens` : undefined}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1.5 rounded-(--r-sm) border px-3 text-[12.5px] transition-colors [@media(pointer:coarse)]:h-10",
                      active ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {f.name}
                  </button>
                );
              })}
            </div>
            <label className="flex h-8 items-center gap-2 rounded-md border border-input px-2.5 text-muted-foreground focus-within:border-ring [@media(pointer:coarse)]:h-10">
              <Search className="size-3.5 shrink-0" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a section" className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground" />
            </label>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 pb-3">
            {BRIEF_GROUPS.map((g) => {
              const rows = visible.filter((s) => s.group === g.id);
              if (!rows.length && g.id !== "yours") return null;
              const toggleable = rows.filter((s) => !s.locked);
              const allOn = toggleable.length > 0 && toggleable.every((s) => chosen.has(s.id));
              return (
                <section key={g.id} className="pt-3">
                  <div className="flex h-7 items-center px-3">
                    <h3 className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g.title}</h3>
                    {toggleable.length > 1 && (
                      <button type="button" className="rounded px-1.5 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => toggle(toggleable.map((s) => s.id), !allOn)}>
                        {allOn ? "None" : "All"}
                      </button>
                    )}
                  </div>
                  {rows.map((s) => (
                    <SectionRow key={s.id} section={s} on={!!s.locked || chosen.has(s.id)} open={expanded === s.id} onToggle={(on) => toggle([s.id], on)} onExpand={() => setExpanded(expanded === s.id ? null : s.id)} />
                  ))}
                  {g.id === "yours" && !q && (
                    <button type="button" onClick={() => setKnowledge(true)} className="mx-1 flex h-9 w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground [@media(pointer:coarse)]:h-11">
                      <Plus className="size-3.5" />
                      Add a skill or design system
                    </button>
                  )}
                </section>
              );
            })}
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
            <span className={cn("flex-1 text-[12.5px] tabular-nums", tokens > HEAVY_TOKENS ? "text-warning" : "text-muted-foreground")} title="Rough count — about 4 characters a token">
              ≈ {formatTokens(tokens)} tokens{tokens > HEAVY_TOKENS ? " — heavy for most chats" : ""}
            </span>
            <Button variant="secondary" size="sm" onClick={download} className="[@media(pointer:coarse)]:h-10">
              <Download className="size-3.5" />
              .md
            </Button>
            <Button variant="accent" size="sm" onClick={copy} className="w-[7.5rem] [@media(pointer:coarse)]:h-10">
              {copied ? <Check className="size-3.5 animate-in zoom-in-50 duration-150" strokeWidth={3} /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy brief"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <KnowledgeDialog open={knowledge} onOpenChange={setKnowledge} />
    </>
  );
}

function SectionRow({ section, on, open, onToggle, onExpand }: { section: BriefSection; on: boolean; open: boolean; onToggle: (on: boolean) => void; onExpand: () => void }) {
  const tokens = briefTokens(section.text);
  return (
    <div className="px-1">
      <div className={cn("group flex min-h-10 items-center gap-1 rounded-md pr-1 [@media(pointer:coarse)]:min-h-12", open && "bg-accent/40")}>
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          disabled={section.locked}
          onClick={() => onToggle(!on)}
          className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-md px-2 text-left hover:bg-accent/60 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className={cn("grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors", on ? "border-primary/60 bg-primary/15 text-primary" : "border-muted-foreground/50", section.locked && "opacity-60")}>
            {on && <Check className="size-3" strokeWidth={3} />}
          </span>
          <span className="min-w-0 flex-1 py-1.5">
            <span className="block truncate text-[13px] text-foreground">{section.title}</span>
            {section.blurb && <span className="block truncate text-[11.5px] text-muted-foreground">{section.blurb}</span>}
          </span>
          <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">{formatTokens(tokens)}</span>
        </button>
        <button type="button" aria-label={open ? "Hide" : "Preview"} aria-expanded={open} onClick={onExpand} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [@media(pointer:coarse)]:size-10">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && <pre className="mx-2 mb-2 mt-1 max-h-64 select-text overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">{section.text}</pre>}
    </div>
  );
}
