"use client";

import * as React from "react";
import {
  Bug,
  ChevronRight,
  CircleX,
  ClipboardCopy,
  Copy,
  FileText,
  Info,
  Search,
  Terminal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { clearLog, getLogEntries, subscribeLog, type LogEntry, type LogLevel } from "@solomotion/platform";
import { errors } from "@solomotion/core";
import { FloatingWindow, type WindowBounds } from "@/components/ui/floating-window";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSession } from "../state/session";
import { useListSelection } from "../state/use-list-selection";
import {
  copyableBugReport,
  entryError,
  entryWhere,
  formatTime,
  toDetailedText,
  toPlainText,
  useCopier,
} from "./console-report";

/**
 * THE CONSOLE — a log viewer you can actually work in.
 *
 * It reads the headless bus in `@solomotion/platform`, so everything the app logs
 * appears identically in the browser and in the desktop shell. What changed is
 * that it stopped being a wall of text you look at and became something you
 * OPERATE: select a range, expand a failure, copy the evidence.
 *
 * Two decisions carry the rest:
 *
 *  • **Selection is `useListSelection`.** The app already owns click /
 *    shift-range / ⌘-toggle / marquee, tuned once for the media library. A
 *    second implementation here would have been forty lines that drift; this is
 *    the same brain the filer and the effect stacks use, so the gestures are
 *    the same gestures.
 *  • **A row knows its own error.** Entries carry the original `console.*`
 *    args, so a row whose args contain an `EngineError` can expand into the
 *    real thing — code, subject, context, cause chain, stack — instead of the
 *    one-line preview. That is the difference between "it broke" and a bug
 *    report someone can act on, and it costs one lookup.
 */

const LEVELS: {
  level: LogLevel;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
}[] = [
  { level: "debug", label: "Debug", icon: Bug, tone: "text-muted-foreground" },
  { level: "info", label: "Info", icon: Info, tone: "text-primary" },
  { level: "warn", label: "Warn", icon: TriangleAlert, tone: "text-warning" },
  { level: "error", label: "Error", icon: CircleX, tone: "text-destructive" },
];
const TONE = Object.fromEntries(LEVELS.map((l) => [l.level, l.tone])) as Record<LogLevel, string>;
const ICON = Object.fromEntries(LEVELS.map((l) => [l.level, l.icon])) as Record<
  LogLevel,
  React.ComponentType<{ className?: string }>
>;

function DetailBlock({ entry }: { entry: LogEntry }) {
  const err = entryError(entry);
  if (!err) {
    // No structured error: show the raw args, which is all there is to show.
    return (
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[10px] leading-relaxed text-muted-foreground">
        {[...entry.args, ...(entry.detail === undefined ? [] : [entry.detail])]
          .map((a) => (typeof a === "string" ? a : safe(a)))
          .join("\n")}
      </pre>
    );
  }
  const where = entryWhere(entry);
  return (
    <div className="mt-1 space-y-1 rounded bg-muted/40 p-2 text-[10px] leading-relaxed">
      <Field name="code" value={err.code} mono />
      {where && <Field name="in" value={where} />}
      {Object.entries(err.context).map(([k, v]) => (
        <Field key={k} name={k} value={safe(v)} mono />
      ))}
      {err
        .chain()
        .slice(1)
        .map((c, i) => (
          <Field key={i} name="caused by" value={`${c.name}: ${c.message}`} />
        ))}
      {err.stack && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground/80">
          {err.stack}
        </pre>
      )}
    </div>
  );
}

function Field({ name, value, mono }: { name: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground/60">{name}</span>
      <span className={cn("min-w-0 break-words text-foreground/85", mono && "font-mono")}>
        {value}
      </span>
    </div>
  );
}

function safe(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function LogRow({
  entry,
  selected,
  expanded,
  onToggleExpand,
  onPointerDown,
  itemProps,
}: {
  entry: LogEntry;
  selected: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  itemProps: { "data-select-id": string };
}) {
  const Icon = ICON[entry.level];
  const err = entryError(entry);
  const where = entryWhere(entry);
  // Only rows with something more to say get a disclosure — a chevron that
  // opens an empty drawer teaches people to stop pressing chevrons.
  const hasDetail =
    err !== null || entry.detail !== undefined || entry.args.some((a) => typeof a !== "string");

  return (
    <div
      {...itemProps}
      onPointerDown={onPointerDown}
      className={cn(
        "border-b border-border/40 px-2 py-1 font-mono text-xs leading-relaxed",
        entry.level === "error" && "bg-destructive/5",
        entry.level === "warn" && "bg-warning/5",
        selected && "bg-primary/15",
      )}
    >
      <div className="flex items-start gap-1.5">
        <button
          onClick={onToggleExpand}
          tabIndex={-1}
          aria-label={expanded ? "Collapse" : "Expand"}
          className={cn(
            "mt-0.5 shrink-0 rounded text-muted-foreground/60 transition-transform hover:text-foreground",
            expanded && "rotate-90",
            !hasDetail && "invisible",
          )}
        >
          <ChevronRight className="size-3" />
        </button>
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", TONE[entry.level])} />
        <span className="mt-px shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
          {formatTime(entry.ts)}
        </span>
        {entry.count > 1 && (
          <span className="mt-px shrink-0 rounded-(--r-xs) bg-muted px-1.5 text-[10px] text-muted-foreground">
            {entry.count}
          </span>
        )}
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90">
          {entry.text}
        </span>
        {where && (
          <span className="mt-px hidden shrink-0 truncate text-[10px] text-muted-foreground/60 @sm:block">
            {where}
          </span>
        )}
      </div>
      {expanded && <DetailBlock entry={entry} />}
    </div>
  );
}

export function ConsoleWindow() {
  const open = useSession((s) => s.consoleOpen);
  const setOpen = useSession((s) => s.setConsoleOpen);
  const [bounds, setBounds] = React.useState<WindowBounds | null>(null);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState<Set<LogLevel>>(() => new Set(LEVELS.map((l) => l.level)));
  const [autoscroll, setAutoscroll] = React.useState(true);
  const [expanded, setExpanded] = React.useState<ReadonlySet<number>>(() => new Set());
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const copy = useCopier();

  const entries = React.useSyncExternalStore(subscribeLog, getLogEntries, getLogEntries);

  React.useEffect(() => {
    if (open && !bounds) {
      const width = Math.min(760, window.innerWidth - 80);
      const height = Math.min(340, window.innerHeight - 160);
      setBounds({
        x: (window.innerWidth - width) / 2,
        y: window.innerHeight - height - 48,
        width,
        height,
        minimized: false,
      });
    }
  }, [open, bounds]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => active.has(e.level) && (!q || e.text.toLowerCase().includes(q)));
  }, [entries, active, query]);

  const order = React.useMemo(() => filtered.map((e) => String(e.id)), [filtered]);
  const selection = useListSelection(order, listRef);
  const byId = React.useMemo(() => new Map(filtered.map((e) => [String(e.id), e])), [filtered]);

  /** The rows a verb acts on, in list order — never the reverse of what you see. */
  const resolve = React.useCallback(
    (id: string): LogEntry[] => {
      const ids = new Set(selection.actionable(id));
      return filtered.filter((e) => ids.has(String(e.id)));
    },
    [selection, filtered],
  );

  const selectedEntries = React.useCallback(
    () => filtered.filter((e) => selection.isSelected(String(e.id))),
    [filtered, selection],
  );

  // Stick to the bottom as new lines arrive, unless the user opted out — and
  // never while a selection is live, which would yank the rows out from under
  // the person reading them.
  React.useEffect(() => {
    if (autoscroll && selection.selected.size === 0 && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered.length, autoscroll, selection.selected.size]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "a") {
      e.preventDefault();
      selection.selectAll();
    } else if (mod && e.key === "c") {
      e.preventDefault();
      const rows = selectedEntries();
      if (rows.length > 0) void copy(toPlainText(rows), `${rows.length} line${rows.length > 1 ? "s" : ""}`);
    } else if (e.key === "Escape" && selection.selected.size > 0) {
      e.preventDefault();
      selection.clear();
    }
  };

  if (!open || !bounds) return null;

  const toggleLevel = (level: LogLevel) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });

  const counts = entries.reduce(
    (acc, e) => ((acc[e.level] = (acc[e.level] ?? 0) + 1), acc),
    {} as Record<LogLevel, number>,
  );

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <FloatingWindow
      title="Console"
      icon={<Terminal className="size-3.5" />}
      bounds={bounds}
      windowId="console"
      minWidth={380}
      minHeight={200}
      onBoundsChange={(patch) => setBounds((b) => (b ? { ...b, ...patch } : b))}
      onToggleMinimize={() => setBounds((b) => (b ? { ...b, minimized: !b.minimized } : b))}
      onClose={() => setOpen(false)}
      body="fill"
    >
      <div className="@container flex h-full flex-col bg-background">
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
          {LEVELS.map(({ level, label, icon: Icon, tone }) => (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              title={label}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
                active.has(level) ? "bg-muted" : "opacity-40 hover:opacity-70",
              )}
            >
              <Icon className={cn("size-3", tone)} />
              <span className="tabular-nums text-muted-foreground">{counts[level] ?? 0}</span>
            </button>
          ))}
          <div className="relative ml-1 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter"
              className="h-6 w-full rounded bg-muted/60 pl-6 pr-2 text-[11px] outline-none placeholder:text-muted-foreground/60 focus:bg-muted"
            />
          </div>
          <button
            onClick={() => setAutoscroll((v) => !v)}
            title="Auto-scroll"
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px]",
              autoscroll ? "bg-muted text-foreground" : "text-muted-foreground",
            )}
          >
            Auto
          </button>
          <button
            onClick={() => void copy(copyableBugReport(), "bug report")}
            title="Copy a bug report — version, platform, errors and the log"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <FileText className="size-3.5" />
          </button>
          <button
            onClick={() => {
              clearLog();
              errors.clear();
              selection.clear();
            }}
            title="Clear console"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>

        <ScrollArea viewportRef={scrollRef} className="min-h-0 flex-1" orientation="both">
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground/60">
              {entries.length === 0 ? "Console is empty" : "No lines match the filter"}
            </div>
          ) : (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  ref={listRef}
                  tabIndex={0}
                  onKeyDown={onKeyDown}
                  {...selection.containerProps}
                  className="relative min-h-full outline-none"
                >
                  {filtered.map((e) => (
                    <LogRow
                      key={e.id}
                      entry={e}
                      selected={selection.isSelected(String(e.id))}
                      expanded={expanded.has(e.id)}
                      onToggleExpand={() => toggleExpand(e.id)}
                      onPointerDown={(ev) => selection.onItemPointerDown(String(e.id), ev)}
                      itemProps={selection.itemProps(String(e.id))}
                    />
                  ))}
                  {selection.marqueeNode}
                </div>
              </ContextMenuTrigger>
              <RowMenu
                resolve={resolve}
                selection={selection}
                byId={byId}
                copy={copy}
                onExpandAll={(rows) =>
                  setExpanded((prev) => new Set([...prev, ...rows.map((r) => r.id)]))
                }
                onOnlyLevel={(level) => setActive(new Set([level]))}
              />
            </ContextMenu>
          )}
        </ScrollArea>

        <div className="flex items-center justify-between border-t border-border px-2 py-1 text-[10px] text-muted-foreground/70">
          <span>
            {filtered.length} line{filtered.length === 1 ? "" : "s"}
            {selection.selected.size > 0 && ` · ${selection.selected.size} selected`}
          </span>
          <span className="hidden @sm:block">Shift-click for a range · ⌘C to copy</span>
        </div>
      </div>
    </FloatingWindow>
  );
}

/**
 * The row menu. It acts on the SELECTION when the clicked row is part of it and
 * on the clicked row otherwise — `actionable()`'s rule, the one every file
 * manager uses, so right-clicking one of five never silently drops four.
 */
function RowMenu({
  resolve,
  selection,
  byId,
  copy,
  onExpandAll,
  onOnlyLevel,
}: {
  resolve: (id: string) => LogEntry[];
  selection: ReturnType<typeof useListSelection>;
  byId: Map<string, LogEntry>;
  copy: (text: string, what: string) => Promise<void>;
  onExpandAll: (rows: LogEntry[]) => void;
  onOnlyLevel: (level: LogLevel) => void;
}) {
  // Which row the menu opened over — Radix gives the event to the trigger, so
  // we read it back off the DOM at open time.
  const [target, setTarget] = React.useState<LogEntry | null>(null);

  const onOpen = React.useCallback(
    (e: React.MouseEvent) => {
      const el = (e.target as HTMLElement).closest("[data-select-id]");
      const id = el?.getAttribute("data-select-id");
      setTarget(id ? (byId.get(id) ?? null) : null);
    },
    [byId],
  );

  const rows = target ? resolve(String(target.id)) : [];
  const n = rows.length;
  const plural = n === 1 ? "" : "s";

  return (
    <ContextMenuContent className="w-56" onContextMenu={onOpen} onPointerDownCapture={onOpen}>
      <ContextMenuItem disabled={n === 0} onSelect={() => void copy(toPlainText(rows), `${n} line${plural}`)}>
        <Copy /> Copy {n > 1 ? `${n} lines` : "line"}
        <ContextMenuShortcut>⌘C</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={n === 0}
        onSelect={() => void copy(toDetailedText(rows), `${n} line${plural} with details`)}
      >
        <ClipboardCopy /> Copy with details
      </ContextMenuItem>
      <ContextMenuItem disabled={n === 0} onSelect={() => onExpandAll(rows)}>
        <ChevronRight /> Expand
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void copy(copyableBugReport(), "bug report")}>
        <FileText /> Copy as bug report
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => selection.selectAll()}>
        Select all
        <ContextMenuShortcut>⌘A</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem disabled={!target} onSelect={() => target && onOnlyLevel(target.level)}>
        Show only {target?.level ?? "this level"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        className="text-destructive focus:text-destructive"
        onSelect={() => {
          clearLog();
          errors.clear();
          selection.clear();
        }}
      >
        <Trash2 /> Clear console
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
