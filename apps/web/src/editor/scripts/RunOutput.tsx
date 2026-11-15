"use client";

import * as React from "react";
import { HighlightedCode } from "./HighlightedCode";
import { Check, ChevronRight, CircleCheck, CircleSlash, CircleX, Clock, Copy, LoaderCircle, Square, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopied } from "../console/console-report";
import type { RunLog, RunRecord } from "./store";

/**
 * A run, read like DevTools: what it logged (with the line that logged it),
 * what it returned, what it changed, and — when it failed — the message, the
 * fix the API suggested, and a jump to the line. No prose: the numbers and the
 * code are the explanation.
 */

const LEVEL_TONE: Record<RunLog["level"], string> = {
  log: "",
  info: "",
  debug: "text-muted-foreground",
  warn: "text-warning bg-warning/5",
  error: "text-destructive bg-destructive/5",
};

/** What each copy button puts on the clipboard — the panel knows the source; the row only shows it. */
export interface RunCopy {
  run: (run: RunRecord) => string;
  error: (run: RunRecord) => string;
}

export function RunEntry({ run, onJump, onStop, copyAs }: { run: RunRecord; onJump?: (line: number) => void; onStop?: (id: string) => void; copyAs: RunCopy }) {
  return (
    <div className="group/run border-b border-border/50 py-1.5 font-mono text-[12px] leading-5">
      {run.repl ? (
        <div className="flex gap-2 px-3 text-muted-foreground">
          <span className="select-none text-primary">›</span>
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words text-(--code-foreground)"><HighlightedCode code={run.code} /></pre>
          <CopyButton label="Copy for AI" text={() => copyAs.run(run)} />
        </div>
      ) : (
        <RunHeader run={run} copyAs={copyAs} onStop={onStop} />
      )}
      {run.logs.map((log, i) => (
        <div key={i} className={cn("flex gap-2 px-3 pl-7", LEVEL_TONE[log.level])}>
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {log.args.map((a, j) => (
              <React.Fragment key={j}>
                {j > 0 && " "}
                {typeof a === "string" ? a : <Value value={a} />}
              </React.Fragment>
            ))}
          </div>
          {log.line && !run.repl && (
            <button type="button" onClick={() => onJump?.(log.line!)} className="shrink-0 text-muted-foreground/60 hover:text-foreground">
              :{log.line}
            </button>
          )}
        </div>
      ))}
      {run.dropped > 0 && <div className="px-3 pl-7 text-muted-foreground">…{run.dropped} more lines</div>}
      {run.error && <ErrorBlock run={run} onJump={onJump} copy={() => copyAs.error(run)} />}
      {run.status === "ok" && run.value !== undefined && (
        <div className="flex gap-2 px-3">
          <span className="select-none text-muted-foreground/60">←</span>
          <div className="min-w-0 flex-1">
            <Value value={run.value} />
          </div>
        </div>
      )}
      {run.unawaited > 0 && (
        <div className="flex items-center gap-1.5 px-3 pl-7 text-warning">
          <TriangleAlert className="size-3.5 shrink-0" />
          {run.unawaited} call{run.unawaited === 1 ? "" : "s"} not awaited
        </div>
      )}
    </div>
  );
}

const STATUS_ICON = { queued: Clock, running: LoaderCircle, ok: CircleCheck, stopped: CircleSlash, error: CircleX } as const;

function RunHeader({ run, copyAs, onStop }: { run: RunRecord; copyAs: RunCopy; onStop?: (id: string) => void }) {
  const Icon = STATUS_ICON[run.status];
  const live = run.status === "running" || run.status === "queued";
  const tone = run.status === "ok" ? "text-success" : run.status === "error" ? "text-destructive" : "text-muted-foreground";
  return (
    <div className="flex items-center gap-2 px-3">
      <Icon className={cn("size-3.5 shrink-0", tone, run.status === "running" && "animate-spin")} />
      <span className="min-w-0 truncate text-foreground">
        {run.path}
        {run.here && <span className="text-muted-foreground"> · {run.here}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        {!live && <span>{formatMs(run.ms)}</span>}
        {run.status === "queued" && <Chip>queued</Chip>}
        {run.status === "stopped" && <Chip>{run.stoppedBy === "timeout" ? "timed out" : "stopped"}</Chip>}
        {run.created > 0 && <Chip>+{run.created}</Chip>}
        {run.replaced > 0 && <Chip>−{run.replaced}</Chip>}
      </span>
      <span className="flex-1" />
      {/* Any live run — an agent's background build included — stops from here. */}
      {live && onStop && (
        <button
          type="button"
          onClick={() => onStop(run.id)}
          aria-label="Stop run"
          title="Stop run"
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [@media(pointer:coarse)]:size-8"
        >
          <Square className="size-3 fill-current" />
        </button>
      )}
      <CopyButton label="Copy for AI" text={() => copyAs.run(run)} />
    </div>
  );
}

function ErrorBlock({ run, onJump, copy }: { run: RunRecord; onJump?: (line: number) => void; copy: () => string }) {
  const e = run.error!;
  return (
    <div className="mx-2 mt-1 rounded-md bg-destructive/8 px-2.5 py-1.5 text-destructive">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          <span className="text-destructive">{e.name}</span> {e.message}
        </span>
        {e.line && !run.repl && (
          <button type="button" onClick={() => onJump?.(e.line!)} className="shrink-0 rounded px-1 text-destructive/70 hover:bg-destructive/15 hover:text-destructive">
            line {e.line}
          </button>
        )}
        <CopyButton label="Copy error" text={copy} className="text-destructive/70 hover:bg-destructive/15 hover:text-destructive" />
      </div>
      {e.hint && <div className="mt-0.5 text-destructive/70">→ {e.hint}</div>}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-(--r-xs) bg-raised px-1.5 text-[11px] leading-4 text-muted-foreground">{children}</span>;
}

/** Copies, then shows a check where the person is looking — no toast needed. */
function CopyButton({ label, text, className }: { label: string; text: () => string; className?: string }) {
  const { copied, copy } = useCopied();
  return (
    <button
      type="button"
      onClick={() => void copy(text())}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded transition-colors [@media(pointer:coarse)]:size-8",
        className ?? "text-muted-foreground/60 hover:bg-accent hover:text-foreground group-hover/run:text-muted-foreground",
      )}
    >
      {copied ? <Check className="size-3.5 text-success animate-in zoom-in-50 duration-150" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

// ── Values ───────────────────────────────────────────────────────────────────

const PREVIEW_KEYS = 4;

/** A returned or logged value: primitives coloured, objects folded, images shown. */
export function Value({ value, name }: { value: unknown; name?: string }) {
  const [open, setOpen] = React.useState(false);
  const label = name !== undefined ? <span className="text-(--code-token-parameter)">{name}: </span> : null;
  if (value === null || value === undefined || typeof value !== "object") {
    return (
      <span>
        {label}
        <Primitive value={value} />
      </span>
    );
  }
  const rec = value as Record<string, unknown>;
  if (isImage(rec)) {
    return (
      <span className="inline-block align-top">
        {label}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:${rec.$image.mediaType};base64,${rec.$image.data}`} alt="" className="mt-1 max-h-48 max-w-full rounded border border-border" />
      </span>
    );
  }
  if ("$fn" in rec) return <span className="text-(--code-token-function)">{label}ƒ {String(rec.$fn)}</span>;
  if ("$error" in rec) {
    const e = rec.$error as { name: string; message: string };
    return <span className="text-destructive">{label}{e.name}: {e.message}</span>;
  }
  const isArr = Array.isArray(value);
  const entries: Array<[string, unknown]> = isArr ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(rec);
  return (
    <span className="inline">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-baseline text-left hover:text-foreground">
        <ChevronRight className={cn("mr-0.5 size-3 shrink-0 self-center text-muted-foreground transition-transform", open && "rotate-90")} />
        {label}
        <span className="text-muted-foreground">{isArr ? `Array(${entries.length})` : preview(entries)}</span>
      </button>
      {open && (
        <span className="block border-l border-border/60 pl-3 ml-1.5">
          {entries.map(([k, v]) => (
            <span key={k} className="block">
              <Value value={v} name={k} />
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function preview(entries: Array<[string, unknown]>): string {
  const shown = entries.slice(0, PREVIEW_KEYS).map(([k, v]) => `${k}: ${short(v)}`);
  return `{${shown.join(", ")}${entries.length > PREVIEW_KEYS ? ", …" : ""}}`;
}

function short(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v.length > 24 ? `${v.slice(0, 23)}…` : v);
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (v && typeof v === "object") return "{…}";
  return String(v);
}

function Primitive({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="text-(--code-token-string)">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="text-(--code-token-constant)">{value}</span>;
  if (typeof value === "boolean") return <span className="text-(--code-token-keyword)">{String(value)}</span>;
  return <span className="text-muted-foreground">{String(value)}</span>;
}

function isImage(v: Record<string, unknown>): v is { $image: { mediaType: string; data: string } } {
  return !!v.$image && typeof v.$image === "object";
}
