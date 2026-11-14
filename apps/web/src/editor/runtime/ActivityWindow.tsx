"use client";

import * as React from "react";
import { Activity, Ban, Check, CircleX, Snowflake, Square, TriangleAlert } from "lucide-react";
import {
  FAILURE_META,
  supervisor,
  taskKind,
  watchdog,
  type FreezeRecord,
  type TaskRecord,
} from "@solomotion/core";
import { FloatingWindow, type WindowBounds } from "@/components/ui/floating-window";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSession } from "../state/session";
import { useTasks } from "./use-tasks";
import { useNow } from "./use-now";

/**
 * ACTIVITY — what the app is doing, how long it has been doing it, and how to
 * make it stop.
 *
 * The honest counterpart to a spinner. Every other surface in the app can only
 * say "working"; this one names the operation, shows its progress against its
 * own budget, and gives you the button. It also keeps the freezes — because the
 * question after the app goes quiet for nine seconds is never "did it freeze",
 * it is "what was it doing", and until now nothing in the app could answer.
 *
 * Pure view over the supervisor's store. It holds no task state of its own, so
 * it cannot disagree with the engine about what is running.
 */

function useFreezes(): readonly FreezeRecord[] {
  return React.useSyncExternalStore(
    (fn) => watchdog.subscribe(fn),
    () => watchdog.freezes(),
    () => watchdog.freezes(),
  );
}

function secs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const OUTCOME = {
  done: { icon: Check, tone: "text-emerald-400", word: "Finished" },
  failed: { icon: CircleX, tone: "text-red-400", word: "Failed" },
  cancelled: { icon: Ban, tone: "text-muted-foreground", word: "Stopped" },
  expired: { icon: TriangleAlert, tone: "text-amber-400", word: "Timed out" },
} as const;

function RunningRow({ task, now }: { task: TaskRecord; now: number }) {
  const elapsed = now - task.startedAt;
  // Against its own deadline where it has one — the bar then means "how close
  // to being stopped", which is the only thing a budget can honestly show.
  const share =
    task.progress !== null
      ? task.progress
      : task.deadlineAt !== null
        ? Math.min(1, elapsed / Math.max(1, task.deadlineAt - task.startedAt))
        : null;

  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-xs font-medium">{task.label}</span>
          {task.overdue && (
            <span className="shrink-0 text-[10px] font-medium text-amber-400">over time</span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-200",
                task.overdue ? "bg-amber-400" : "bg-primary",
                // Nothing to measure: a moving stripe rather than a fake number.
                share === null && "w-1/3 animate-pulse",
              )}
              style={share === null ? undefined : { width: `${Math.round(share * 100) || 2}%` }}
            />
          </div>
          <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
            {secs(elapsed)}
          </span>
        </div>
        {(task.note ?? task.detail) && (
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground/80">
            {task.note ?? task.detail}
          </div>
        )}
      </div>
      {task.cancellable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => supervisor.cancel(task.id)}
              aria-label={`Stop ${task.label}`}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Stop</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="p-1 text-muted-foreground/40">
              <Square className="size-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Can’t be interrupted safely</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function FinishedRow({ task }: { task: TaskRecord }) {
  const o = OUTCOME[task.state as keyof typeof OUTCOME] ?? OUTCOME.done;
  const Icon = o.icon;
  const took = task.endedAt === undefined ? null : task.endedAt - task.startedAt;
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5">
      <Icon className={cn("size-3.5 shrink-0", o.tone)} />
      <span className="min-w-0 flex-1 truncate text-xs text-foreground/80">{task.label}</span>
      {(task.failure || task.error) && (
        <span className="max-w-[40%] truncate text-[10px] text-red-400/80" title={task.error}>
          {task.failure ? FAILURE_META[task.failure].label : task.error}
        </span>
      )}
      <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
        {took === null ? o.word : secs(took)}
      </span>
    </div>
  );
}

function Heading({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </span>
      {right}
    </div>
  );
}

export function ActivityWindow() {
  const open = useSession((s) => s.activityOpen);
  const setOpen = useSession((s) => s.setActivityOpen);
  const [bounds, setBounds] = React.useState<WindowBounds | null>(null);
  const tasks = useTasks();
  const freezes = useFreezes();

  const running = tasks.filter((t) => t.state === "running");
  const finished = tasks.filter((t) => t.state !== "running");
  // Elapsed ticks only while something is running, and only while this is open.
  const now = useNow(open && running.length > 0);

  React.useEffect(() => {
    if (open && !bounds) {
      const width = Math.min(420, window.innerWidth - 80);
      const height = Math.min(460, window.innerHeight - 160);
      setBounds({
        x: window.innerWidth - width - 32,
        y: 88,
        width,
        height,
        minimized: false,
      });
    }
  }, [open, bounds]);

  if (!open || !bounds) return null;

  const stoppable = running.some((t) => t.cancellable);

  return (
    <FloatingWindow
      title="Activity"
      icon={<Activity className="size-3.5" />}
      bounds={bounds}
      windowId="activity"
      minWidth={320}
      minHeight={220}
      onBoundsChange={(patch) => setBounds((b) => (b ? { ...b, ...patch } : b))}
      onToggleMinimize={() => setBounds((b) => (b ? { ...b, minimized: !b.minimized } : b))}
      onClose={() => setOpen(false)}
      body="fill"
    >
      <div className="flex h-full flex-col bg-background">
        <ScrollArea className="min-h-0 flex-1">
          <Heading
            right={
              stoppable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={() => supervisor.cancelAll()}
                >
                  Stop all
                </Button>
              ) : undefined
            }
          >
            Running{running.length > 0 ? ` · ${running.length}` : ""}
          </Heading>
          {running.length === 0 ? (
            <div className="px-3 py-4 text-center text-[11px] text-muted-foreground/60">
              Nothing running
            </div>
          ) : (
            <div className="divide-y divide-border/40">
              {running.map((t) => (
                <RunningRow key={t.id} task={t} now={now} />
              ))}
            </div>
          )}

          {freezes.length > 0 && (
            <>
              <Heading
                right={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={() => watchdog.clear()}
                  >
                    Clear
                  </Button>
                }
              >
                Freezes
              </Heading>
              <div className="divide-y divide-border/40">
                {freezes.map((f, i) => (
                  <div key={`${f.at}-${i}`} className="flex items-center gap-2.5 px-3 py-1.5">
                    <Snowflake className="size-3.5 shrink-0 text-sky-400" />
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground/80">
                      {f.tasks[0]?.label ?? "Nothing was running"}
                    </span>
                    <span className="shrink-0 tabular-nums text-[10px] text-amber-400">
                      {secs(f.durationMs)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {finished.length > 0 && (
            <>
              <Heading
                right={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={() => supervisor.clearHistory()}
                  >
                    Clear
                  </Button>
                }
              >
                Recent
              </Heading>
              <div className="divide-y divide-border/40">
                {finished.map((t) => (
                  <FinishedRow key={t.id} task={t} />
                ))}
              </div>
            </>
          )}
        </ScrollArea>
        <div className="border-t border-border px-3 py-1 text-[10px] text-muted-foreground/70">
          {running.length === 0
            ? "Idle"
            : `${running.length} running · ${taskKind(running[0]!.kind)?.label ?? "Task"}`}
        </div>
      </div>
    </FloatingWindow>
  );
}
