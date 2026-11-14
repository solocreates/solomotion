"use client";

import * as React from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  Loader2,
  Paperclip,
  RotateCw,
  ThumbsDown,
  ThumbsUp,
  Redo2,
  Undo2,
} from "lucide-react";
import type { ImagePart, Message, Part, ToolCallPart, ToolOutput, ToolResultPart } from "@solomotion/agent";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Markdown } from "./Markdown";
import { toolLabel } from "./tool-labels";
import { useDocStore } from "../../state/document-context";
import type { LiveRun, LiveToolCall } from "../store";
import { useNow } from "../../runtime/use-now";

/**
 * THE TRANSCRIPT — what the agent said, thought and did, in the order it
 * happened, and the live edge of it while it is still happening.
 *
 * Tool calls are rows, not cards: a run can make forty calls, and forty cards
 * push the actual answer off screen. A row is one line — icon, what it did,
 * how long — and opens to show the raw input, the result, and any picture the
 * agent looked at. A run of more than a few rows folds into "N steps" once it
 * finishes, so a finished answer reads as an answer.
 */

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const fmtSecs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

// ── Thinking ─────────────────────────────────────────────────────────────────

export function ThinkingBlock({ text, live, ms }: { text: string; live?: boolean; ms?: number }) {
  const [open, setOpen] = React.useState(false);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  // While streaming, keep the newest thought in view inside its own box.
  React.useEffect(() => {
    if (live && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [text, live]);
  const label = live ? "Thinking" : ms ? `Thought for ${fmtSecs(ms)}` : "Thought";
  return (
    <div className="agent-rise">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex items-center gap-1.5 rounded-md py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open || live}
      >
        <Brain className="size-3.5" />
        <span className={cn(live && "agent-shimmer font-medium")}>{label}</span>
        <ChevronRight className={cn("size-3 transition-transform", (open || live) && "rotate-90")} />
      </button>
      {(open || live) && text && (
        <div
          ref={bodyRef}
          className={cn(
            "mt-1 whitespace-pre-wrap border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground/90",
            live ? "max-h-28 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_24px)]" : "max-h-72 overflow-y-auto",
          )}
        >
          {text}
        </div>
      )}
    </div>
  );
}

// ── Tool rows ────────────────────────────────────────────────────────────────

function OutputView({ output }: { output: ToolOutput }) {
  const text = output.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  const images = output.content.filter((c): c is ImagePart => c.type === "image");
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* not JSON — show as is */
  }
  return (
    <div className="space-y-1.5">
      {images.map((img, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={i} src={`data:${img.mediaType};base64,${img.data}`} alt="What the agent saw" className="max-h-64 w-auto rounded-md border" />
      ))}
      {pretty && (
        <pre className={cn("max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 font-mono text-2xs leading-snug", output.isError ? "text-destructive" : "text-muted-foreground")}>
          {pretty.length > 6000 ? `${pretty.slice(0, 6000)}…` : pretty}
        </pre>
      )}
    </div>
  );
}

export function ToolRow({
  name,
  input,
  status,
  output,
  ms,
  partialJson,
  sub,
  progress,
}: {
  name: string;
  input: unknown;
  status: LiveToolCall["status"];
  output?: ToolOutput;
  ms?: number;
  partialJson?: string;
  sub?: LiveToolCall["sub"];
  progress?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const label = toolLabel(name, input ?? tryParse(partialJson));
  const Icon = label.icon;
  const busy = status === "streaming" || status === "running";
  const thumb = output?.content.find((c): c is ImagePart => c.type === "image");
  return (
    <div className="agent-rise">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent/60"
        aria-expanded={open}
      >
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-md border bg-background/60 [&_svg]:size-3",
            status === "error" ? "border-destructive/40 text-destructive" : busy ? "text-primary" : "text-muted-foreground",
          )}
        >
          {busy ? <Loader2 className="animate-spin" /> : status === "error" ? <CircleAlert /> : <Icon />}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", busy ? "agent-shimmer" : status === "error" ? "text-destructive" : "text-foreground/85")}>
          {busy ? label.running : label.done}
          {progress && busy ? ` · ${progress}` : ""}
        </span>
        {thumb && !open && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`data:${thumb.mediaType};base64,${thumb.data}`} alt="" className="h-5 w-auto shrink-0 rounded-sm border" />
        )}
        {ms !== undefined && !busy && <span className="shrink-0 tabular-nums text-2xs text-muted-foreground">{fmtSecs(ms)}</span>}
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100", open && "rotate-90 opacity-100")} />
      </button>
      {sub && (
        <div className="ml-3.5 space-y-0.5 border-l border-border py-0.5 pl-3">
          {sub.tools.slice(-6).map((t) => {
            const l = toolLabel(t.name, undefined);
            return (
              <div key={t.id} className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                {t.status === "running" ? <Loader2 className="size-3 animate-spin" /> : t.status === "error" ? <CircleAlert className="size-3 text-destructive" /> : <Check className="size-3" />}
                <span className="truncate">{t.status === "running" ? l.running : l.done}</span>
              </div>
            );
          })}
          {sub.text && <p className="line-clamp-3 text-2xs text-muted-foreground/80">{sub.text}</p>}
        </div>
      )}
      {open && (
        <div className="ml-7 mt-1 space-y-1.5 pb-1">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 font-mono text-2xs leading-snug text-muted-foreground">
            {name}({input !== undefined ? JSON.stringify(input, null, 2) : partialJson || ""})
          </pre>
          {output && <OutputView output={output} />}
        </div>
      )}
    </div>
  );
}

function tryParse(json?: string): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    // A streaming prefix — pull a few readable fields out for the label.
    const pick = (k: string) => new RegExp(`"${k}"\\s*:\\s*"([^"]*)`).exec(json)?.[1];
    return { kind: pick("kind"), text: pick("text"), type: pick("type"), prompt: pick("prompt"), preset: pick("preset"), label: pick("label"), path: pick("path") };
  }
}

/** A finished run of steps: a few show; more fold into "N steps". */
function StepGroup({ calls, results }: { calls: ToolCallPart[]; results: Map<string, ToolResultPart> }) {
  const [open, setOpen] = React.useState(false);
  const failed = calls.filter((c) => results.get(c.id)?.isError).length;
  const rows = calls.map((c) => {
    const r = results.get(c.id);
    return (
      <ToolRow
        key={c.id}
        name={c.name}
        input={c.input}
        status={r ? (r.isError ? "error" : "done") : "done"}
        output={r ? { content: r.content, isError: r.isError } : undefined}
      />
    );
  });
  if (calls.length <= 3) return <div className="space-y-0.5">{rows}</div>;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {calls.length} steps
        {failed > 0 && <span className="text-destructive">· {failed} failed</span>}
      </button>
      {open && <div className="space-y-0.5">{rows}</div>}
    </div>
  );
}

// ── Messages ─────────────────────────────────────────────────────────────────

function Attachments({ parts }: { parts: Part[] }) {
  const items = parts.filter((p) => p.type === "image" || p.type === "file" || p.type === "attachment");
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {items.map((p, i) =>
        p.type === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} src={`data:${p.mediaType};base64,${p.data}`} alt={p.name ?? "Attached image"} className="h-16 w-auto rounded-md border object-cover" />
        ) : (
          <span key={i} className="flex max-w-[12rem] items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1 text-2xs text-muted-foreground">
            {p.type === "file" ? <FileText className="size-3 shrink-0" /> : <Paperclip className="size-3 shrink-0" />}
            <span className="truncate">{p.type === "file" || p.type === "attachment" ? p.name : ""}</span>
          </span>
        ),
      )}
    </div>
  );
}

export function UserMessage({ message }: { message: Message }) {
  const text = message.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => (p as { text: string }).text).join("\n");
  return (
    <div className="agent-rise flex flex-col items-end gap-1.5 pl-6">
      <Attachments parts={message.parts} />
      {text && <div className="max-w-full whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary px-3 py-2 text-sm text-foreground [overflow-wrap:anywhere]">{text}</div>}
    </div>
  );
}

export function AssistantMessage({
  message,
  results,
  onRate,
  rating,
  checkpoint,
}: {
  message: Message;
  results: Map<string, ToolResultPart>;
  onRate?: (up: boolean) => void;
  rating?: boolean | null;
  /** The request this reply ended, when it changed the document. */
  checkpoint?: { key: string; label: string };
}) {
  // Consecutive tool calls render as one group; text and thinking between them break it.
  const blocks: Array<{ kind: "part"; part: Part } | { kind: "calls"; calls: ToolCallPart[] }> = [];
  for (const p of message.parts) {
    if (p.type === "tool_call") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "calls") last.calls.push(p);
      else blocks.push({ kind: "calls", calls: [p] });
    } else blocks.push({ kind: "part", part: p });
  }
  const hasText = message.parts.some((p) => p.type === "text" && p.text.trim());
  return (
    <div className="group/msg agent-rise space-y-1.5">
      {blocks.map((b, i) =>
        b.kind === "calls" ? (
          <StepGroup key={i} calls={b.calls} results={results} />
        ) : b.part.type === "thinking" ? (
          <ThinkingBlock key={i} text={b.part.text} ms={b.part.durationMs} />
        ) : b.part.type === "text" && b.part.text.trim() ? (
          <Markdown key={i} text={b.part.text} />
        ) : null,
      )}
      {(hasText || checkpoint) && (onRate || checkpoint) && (
        <div className="flex items-center gap-0.5 text-muted-foreground">
          {checkpoint && <TurnRewind checkpoint={checkpoint} />}
          {hasText && onRate && (
            <div className={cn("flex items-center gap-0.5 transition-opacity", rating == null && "opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100")}>
              <RateButton up active={rating === true} onClick={() => onRate(true)} />
              <RateButton up={false} active={rating === false} onClick={() => onRate(false)} />
              {message.model && <span className="ml-1 text-2xs">{message.model.model}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Rewind one request: undo everything it changed (and whatever landed after
 * it — all of it redoable), or bring it back. Reads the live history, so it
 * always offers what is actually possible right now.
 */
export function TurnRewind({ checkpoint, actor = "AI", iconOnly }: { checkpoint: { key: string; label: string }; actor?: string; iconOnly?: boolean }) {
  const store = useDocStore();
  const read = React.useCallback(() => {
    const u = store.undoDepthOf(checkpoint.key);
    if (u !== null) return `undo:${u}:${store.peekUndoLabel() === `${actor} · ${checkpoint.label}` ? 1 : 0}`;
    const r = store.redoDepthOf(checkpoint.key);
    return r !== null ? `redo:${r}` : "none";
  }, [store, checkpoint, actor]);
  const state = React.useSyncExternalStore(store.subscribe, read, () => "none");
  if (state === "none") return null;
  const [mode, n, ownTop] = state.split(":");
  const depth = Number(n);
  const undo = mode === "undo";
  const later = undo && ownTop !== "1" ? depth - 1 : 0;
  const tip = undo
    ? later > 0
      ? `Undo this request — and the ${later} step${later === 1 ? "" : "s"} after it. ⌘⇧Z brings everything back.`
      : "Undo everything this request changed (one step)."
    : "Bring this request's changes back.";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            for (let i = 0; i < depth; i++) (undo ? store.undo() : store.redo());
          }}
          aria-label={undo ? "Undo this request" : "Redo this request"}
          className={cn(
            "flex h-6 items-center gap-1 rounded-md text-2xs transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5",
            iconOnly ? "w-6 justify-center" : "px-1.5",
          )}
        >
          {undo ? <Undo2 /> : <Redo2 />}
          {!iconOnly && (undo ? (later > 0 ? `Undo changes (+${later})` : "Undo changes") : "Redo changes")}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}

function RateButton({ up, active, onClick }: { up: boolean; active: boolean; onClick: () => void }) {
  const Icon = up ? ThumbsUp : ThumbsDown;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={up ? "Good response" : "Bad response"}
          aria-pressed={active}
          className={cn("flex size-6 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5", active && "text-primary")}
        >
          <Icon />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{up ? "Good" : "Not good — tell us why"}</TooltipContent>
    </Tooltip>
  );
}

// ── The live edge ────────────────────────────────────────────────────────────

export function LiveBlock({ live }: { live: LiveRun }) {
  const thinkingLive = !!live.thinkingStartedAt && !live.text;
  return (
    <div className="space-y-1.5">
      {live.thinking && <ThinkingBlock text={live.thinking} live={thinkingLive} ms={live.thinkingMs} />}
      {live.text && (
        <div className="relative">
          <Markdown text={live.text} />
          <span className="agent-caret ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-primary align-middle" />
        </div>
      )}
      {live.callOrder.length > 0 && (
        <div className="space-y-0.5">
          {live.callOrder.map((id) => {
            const c = live.calls[id];
            return c ? <ToolRow key={id} name={c.name} input={c.input} status={c.status} output={c.output} ms={c.ms} partialJson={c.partialJson} sub={c.sub} progress={c.progress} /> : null;
          })}
        </div>
      )}
    </div>
  );
}

/** The one line that says the agent is alive: what it is doing, for how long, at what cost. */
export function StatusLine({ live }: { live: LiveRun }) {
  const now = useNow(true, Date.now);
  const elapsed = now - live.startedAt;
  // Exact counts arrive per step; in between, estimate what is streaming (≈4 chars a token).
  const out = live.outputTokens + Math.round(live.streamedChars / 4);
  const doing = live.status === "stopping"
    ? "Stopping"
    : live.retry
      ? `Retrying in ${Math.max(0, Math.ceil((live.retry.until - now) / 1000))}s (${live.retry.attempt}/${live.retry.maxAttempts})`
      : live.thinkingStartedAt && !live.text
        ? "Thinking"
        : Object.values(live.calls).some((c) => c.status === "running" || c.status === "streaming")
          ? "Working"
          : live.text
            ? "Writing"
            : "Starting";
  return (
    <div className="flex items-center gap-2 text-2xs text-muted-foreground" aria-live="polite">
      {live.retry ? <RotateCw className="size-3 animate-spin text-amber-500" /> : <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" /><span className="relative inline-flex size-2 rounded-full bg-primary" /></span>}
      <span className={cn("font-medium", !live.retry && "agent-shimmer")}>{doing}</span>
      <span className="tabular-nums">· {fmtSecs(elapsed)}</span>
      <span className="tabular-nums">· ↑ {fmtTokens(live.inputTokens)} ↓ {fmtTokens(out)}</span>
      {live.queued.length > 0 && <span className="rounded bg-primary/15 px-1 text-primary">{live.queued.length} queued</span>}
    </div>
  );
}

export function Notice({ level, text }: { level: "info" | "warning" | "error"; text: string }) {
  return (
    <div
      className={cn(
        "agent-rise flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs",
        level === "error" ? "border-destructive/40 bg-destructive/10 text-destructive" : level === "warning" ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "bg-muted/40 text-muted-foreground",
      )}
      role={level === "error" ? "alert" : undefined}
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span className="[overflow-wrap:anywhere]">{text}</span>
    </div>
  );
}
