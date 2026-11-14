"use client";

import * as React from "react";
import { RotateCw, Square } from "lucide-react";
import { FAILURE_META, retryFailedLazyModules, supervisor, type TaskRecord } from "@solomotion/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useSession } from "../state/session";
import { useTasks } from "./use-tasks";

/**
 * THE ACTIVITY RING — one small mark that says the app is fetching or working
 * on something, and what.
 *
 * Heavy parts of the app arrive lazily (the 3D engine, effect families, models)
 * and long jobs run in the background (tracking, export). Without this, the
 * first press of a 3D button looked like nothing happening for two seconds.
 *
 * Pure view over the supervisor, like the Activity window it opens:
 *
 *   nothing running   nothing drawn — the bar stays quiet
 *   something running a ring: an arc that fills when the work can say how far
 *                     it is, a turning arc when it cannot. It appears only once
 *                     work has run for SHOW_AFTER_MS, so a chunk that lands in
 *                     80 ms never blinks the bar.
 *   something failed  a dot, until looked at. Hover names it and why — offline,
 *                     server, a newer version — with Retry where retrying helps.
 */
const SHOW_AFTER_MS = 350;

export function ActivityRing({ className }: { className?: string }) {
  const tasks = useTasks();
  const [open, setOpen] = React.useState(false);
  const [seenAt, setSeenAt] = React.useState(() => performance.now());
  // The time is state, set when the show timer fires, so it reaches the render
  // through React. A stale `now` only ever errs towards "not yet": the timer
  // below then fires at once and corrects it.
  const [now, setNow] = React.useState(() => performance.now());
  const closeTimer = React.useRef<number | null>(null);

  const running = tasks.filter((t) => t.state === "running");
  const visible = running.filter((t) => now - t.startedAt >= SHOW_AFTER_MS);
  const failures = tasks.filter((t) => (t.state === "failed" || t.state === "expired") && (t.endedAt ?? 0) > seenAt);

  // A task that started a moment ago becomes visible without anything else
  // changing — wake once at that instant rather than polling.
  const pendingShow = running.find((t) => now - t.startedAt < SHOW_AFTER_MS);
  React.useEffect(() => {
    if (!pendingShow) return;
    const id = window.setTimeout(() => setNow(performance.now()), SHOW_AFTER_MS - (performance.now() - pendingShow.startedAt) + 5);
    return () => window.clearTimeout(id);
  }, [pendingShow]);

  React.useEffect(() => {
    if (!visible.length && !failures.length) setOpen(false);
  }, [visible.length, failures.length]);

  if (!visible.length && !failures.length) return null;

  const measured = visible.filter((t) => t.progress !== null);
  const progress = measured.length === visible.length && visible.length ? measured.reduce((n, t) => n + t.progress!, 0) / measured.length : null;
  const failed = failures.length > 0 && !visible.length;

  const hoverOpen = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hoverClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 220);
  };
  const markSeen = () => setSeenAt(performance.now());

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o && failed) markSeen();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={failed ? "Something failed — details" : "Working — details"}
          onPointerEnter={(e) => e.pointerType === "mouse" && hoverOpen()}
          onPointerLeave={(e) => e.pointerType === "mouse" && hoverClose()}
          className={cn(
            "relative grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
            className,
          )}
        >
          {visible.length > 0 && <Ring progress={progress} />}
          {failures.length > 0 && (
            <span
              className={cn(
                "absolute rounded-full bg-destructive ring-2 ring-background",
                visible.length ? "right-1 top-1 size-1.5" : "size-2",
              )}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-72 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={hoverOpen}
        onPointerLeave={hoverClose}
      >
        {visible.map((t) => (
          <RunningRow key={t.id} task={t} />
        ))}
        {failures.slice(0, 4).map((t) => (
          <FailedRow key={t.id} task={t} />
        ))}
        <button
          type="button"
          onClick={() => {
            markSeen();
            setOpen(false);
            useSession.getState().setActivityOpen(true);
          }}
          className="mt-0.5 w-full rounded px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          Open Activity
        </button>
      </PopoverContent>
    </Popover>
  );
}

/** 14 px: a faint track, and an arc that fills or turns. */
function Ring({ progress }: { progress: number | null }) {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const arc = progress === null ? c * 0.28 : c * Math.max(0.04, progress);
  return (
    <svg viewBox="0 0 14 14" className={cn("size-3.5 -rotate-90", progress === null && "animate-spin")} aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth="1.75" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={`${arc} ${c}`}
        className="transition-[stroke-dasharray] duration-200"
      />
    </svg>
  );
}

function RunningRow({ task }: { task: TaskRecord }) {
  const pct = task.progress === null ? null : Math.round(task.progress * 100);
  return (
    <div className="group flex items-center gap-2 rounded px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{task.label}</div>
        {(task.note ?? task.detail) && <div className="truncate text-2xs text-muted-foreground">{task.note ?? task.detail}</div>}
      </div>
      {pct !== null && <span className="shrink-0 tabular-nums text-2xs text-muted-foreground">{pct}%</span>}
      {task.cancellable && (
        <button
          type="button"
          aria-label={`Stop ${task.label}`}
          onClick={() => supervisor.cancel(task.id)}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-60 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100"
        >
          <Square className="size-2.5 fill-current" />
        </button>
      )}
    </div>
  );
}

function FailedRow({ task }: { task: TaskRecord }) {
  const meta = task.failure ? FAILURE_META[task.failure] : null;
  // Only a LOAD can be retried from here — any other job is re-run where it
  // was started (the panel that owns it knows its inputs; this does not).
  const retry = task.kind === "load" && (meta?.retry ?? true);
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1.5">
      <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs">{task.label.replace(/^Loading /, "Couldn't load ")}</div>
        <div className="truncate text-2xs text-muted-foreground">{meta?.label ?? task.error ?? "Failed"}</div>
      </div>
      {retry && (
        <button
          type="button"
          onClick={() => retryFailedLazyModules()}
          className="flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-2xs text-primary transition-colors hover:bg-primary/10"
        >
          <RotateCw className="size-2.5" /> Retry
        </button>
      )}
    </div>
  );
}
