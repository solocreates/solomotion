"use client";

import { identity } from "@/editor/identity";
import { useCopied } from "../../console/console-report";
import * as React from "react";
import { Cable, Check, ChevronDown, CircleAlert, Clock3, Copy, ListChecks, Loader2, Settings2, Unplug } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppShell } from "../../state/app-shell";
import { agentAppMark, agentAppName, disconnectMcp, loadFeed, useMcp, type McpTurn } from "../mcp-link";
import { McpDialog } from "./McpDialog";
import { ProviderMark } from "./ProviderMark";
import { ToolRow, TurnRewind } from "./Transcript";

/**
 * THE LINKED AGENT — what the Agents panel shows while an agent app (Claude
 * Code, Codex, Cursor…) drives this tab.
 *
 * MCP carries TOOL CALLS, not the conversation: the prompt, the model's
 * thinking and its replies stay in the agent app. So this surface does not
 * pretend to be a chat — it says where to type, and shows what CAN be seen:
 * every call as it happens, grouped into requests, each with its own Undo,
 * through the same `ToolRow` the built-in chat uses.
 *
 * Two shapes: `LinkedView` when the link is the only way in (no model
 * connected), `LinkedStrip` above the chat when both exist.
 */

function useLink() {
  const status = useMcp((s) => s.status);
  const client = useMcp((s) => s.client);
  const calls = useMcp((s) => s.calls);
  const all = useMcp((s) => s.turns);
  const sessions = useMcp((s) => s.sessions.length);
  const projectId = useAppShell((s) => s.currentProjectId);
  React.useEffect(() => {
    loadFeed();
  }, []);
  // This project's requests. A turn saved before projects were tagged has no id — show it anywhere rather than lose it.
  const turns = React.useMemo(() => all.filter((t) => !t.projectId || t.projectId === projectId), [all, projectId]);
  const linked = status === "connected";
  return { status, linked, calls, turns, sessions, name: agentAppName(client), mark: agentAppMark(client) };
}

function AppMark({ mark, className }: { mark: string | null; className?: string }) {
  if (mark) return <ProviderMark providerId={mark} className={className} />;
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg border bg-background/70 text-primary", className)}>
      <Cable className="size-[58%]" />
    </span>
  );
}

function StatusDot({ linked }: { linked: boolean }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", linked ? "bg-emerald-400" : "animate-pulse bg-primary")} />;
}

/** A square icon button with a real tooltip — the panel's one recipe for them. */
function IconAction({
  label,
  onClick,
  danger,
  small,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent [&_svg]:size-3.5",
            small ? "size-6" : "size-7",
            danger ? "hover:text-destructive" : "hover:text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Every request the agent app made, oldest first; the newest follows the edge. */
function ActivityFeed({ turns, name, className }: { turns: McpTurn[]; name: string; className?: string }) {
  const end = React.useRef<HTMLDivElement>(null);
  // Name each request's session only when more than one session worked here.
  const several = React.useMemo(() => new Set(turns.map((t) => t.session ?? "")).size > 1, [turns]);
  const last = turns[turns.length - 1];
  const lastCount = last?.calls.length ?? 0;
  // A BLOCK body, never `() => el.scrollIntoView()`: Chrome's scroll methods now
  // return a Promise, React takes an effect's return value as its cleanup, and
  // calling a Promise threw "u is not a function" on every new step and on
  // leaving the panel — which took the whole left column down with it.
  React.useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns.length, lastCount]);
  if (!turns.length) {
    return <p className={cn("px-3 py-6 text-center text-xs text-muted-foreground", className)}>Nothing yet — {name}&apos;s steps will appear here.</p>;
  }
  return (
    <div className={cn("space-y-2 px-2 pb-2", className)}>
      {turns.map((t) => {
        const running = t.calls.some((c) => c.status === "running");
        const failed = t.calls.filter((c) => c.status === "error").length;
        return (
          <section key={t.key}>
            <div className="sticky top-0 z-10 flex h-7 items-center gap-2.5 bg-panel px-1.5 text-2xs tabular-nums text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock3 className="size-3" />
                {clock(t.calls[0]?.at ?? Date.now())}
              </span>
              <span className="flex items-center gap-1" aria-label={`${t.calls.length + (t.earlier ?? 0)} steps`}>
                {running ? <Loader2 className="size-3 animate-spin text-primary" /> : <ListChecks className="size-3" />}
                {t.calls.length + (t.earlier ?? 0)}
              </span>
              {failed > 0 && (
                <span className="flex items-center gap-1 text-destructive" aria-label={`${failed} failed`}>
                  <CircleAlert className="size-3" />
                  {failed}
                </span>
              )}
              {several && t.where && <span className="min-w-0 truncate text-foreground/70">{t.where}</span>}
              <span className="h-px flex-1 bg-border" />
              {!running && <TurnRewind checkpoint={{ key: t.key, label: "request" }} actor={t.label} iconOnly />}
            </div>
            {t.calls.map((c) => (
              <ToolRow key={c.id} name={c.name} input={c.input} status={c.status} output={c.output} ms={c.ms} />
            ))}
          </section>
        );
      })}
      <div ref={end} />
    </div>
  );
}

const EXAMPLE = `In ${identity.name}, make a 10-second title card`;

/** A prompt to try — one tap copies it, ready to paste into the agent app. */
function ExamplePrompt() {
  const { copied, copy } = useCopied();
  return (
    <button
      type="button"
      onClick={() => void copy(EXAMPLE)}
      className="group flex h-7 w-full items-center gap-2 rounded-md border bg-background/60 px-2 text-left text-2xs transition-colors hover:bg-accent"
    >
      <span className="min-w-0 flex-1 truncate text-foreground/85">“{EXAMPLE}”</span>
      {copied ? <Check className="size-3 shrink-0 text-emerald-500" /> : <Copy className="size-3 shrink-0 text-muted-foreground group-hover:text-foreground" />}
    </button>
  );
}

/** The link is the only way in: who is connected, where to type, and what it did. */
export function LinkedView() {
  const { linked, calls, turns, sessions, name, mark } = useLink();
  const [setupOpen, setSetupOpen] = React.useState(false);
  const app = name;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2.5 border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <AppMark mark={mark} className="size-7 rounded-lg" />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-xs font-semibold">{app}</p>
            <p className="flex items-center gap-1.5 truncate text-2xs text-muted-foreground">
              <StatusDot linked={linked} />
              {linked
                ? [sessions > 1 ? `${sessions} sessions` : "Connected", calls ? `${calls} action${calls === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")
                : "Waiting — start a new session there"}
            </p>
          </div>
          <IconAction label="Setup" onClick={() => setSetupOpen(true)}>
            <Settings2 />
          </IconAction>
          <IconAction label={`Unlink ${app}`} danger onClick={disconnectMcp}>
            <Unplug />
          </IconAction>
        </div>
        <div className="space-y-1.5">
          <p className="text-2xs text-muted-foreground">Ask in {app} — its steps appear below.</p>
          <ExamplePrompt />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ActivityFeed turns={turns} name={app} />
      </ScrollArea>
      <McpDialog open={setupOpen} onOpenChange={setSetupOpen} />
    </div>
  );
}

/** The link beside a chat: one line, the activity a click away. */
export function LinkedStrip() {
  const { linked, turns, sessions, name, mark } = useLink();
  const [open, setOpen] = React.useState(false);
  const busy = turns[turns.length - 1]?.calls.some((c) => c.status === "running") ?? false;
  return (
    <div className="shrink-0 border-b">
      <div className="flex h-8 items-center gap-1.5 pl-2.5 pr-1 text-xs">
        <AppMark mark={mark} className="size-4 rounded border-0 bg-transparent" />
        <StatusDot linked={linked} />
        <span className={cn("min-w-0 flex-1 truncate", busy ? "agent-shimmer" : "text-muted-foreground")}>
          {linked ? (busy ? `${name} is working…` : sessions > 1 ? `${sessions} ${name} sessions` : `Connected to ${name}`) : `Waiting for ${name}`}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Activity <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
        </button>
        <IconAction label={`Unlink ${name}`} danger small onClick={disconnectMcp}>
          <Unplug />
        </IconAction>
      </div>
      {open && (
        <ScrollArea className="max-h-64 border-t bg-background/30">
          <ActivityFeed turns={turns} name={name} />
        </ScrollArea>
      )}
    </div>
  );
}
