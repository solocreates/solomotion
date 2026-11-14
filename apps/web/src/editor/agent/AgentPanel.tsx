"use client";

import { product } from "@/editor/product";
import * as React from "react";
import { BookOpen, Cable, History, MessageSquarePlus, MoreHorizontal, PlugZap, Search, Trash2 } from "lucide-react";
import { PROVIDERS } from "@solomotion/agent";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppShell } from "../state/app-shell";
import { useAgent } from "./store";
import { ChatView } from "./ui/ChatView";
import { SetupDialog } from "./ui/SetupDialog";
import { KnowledgeDialog } from "./ui/KnowledgeDialog";
import { ProviderMark } from "./ui/ProviderMark";
import { McpDialog } from "./ui/McpDialog";
import { LinkedStrip, LinkedView } from "./ui/LinkedAgent";
import { useMcp } from "./mcp-link";
import { NAMES } from "@/editor/names";

/**
 * THE AGENTS PANEL — a docked surface on the left rail like Library and
 * Layers, and so floatable into a window like them. This file is the root of
 * a LAZY chunk: the runtime, the provider SDKs and the skill load when someone
 * first opens the panel, never before, so an editor that never uses AI never
 * pays for it.
 *
 * Three states: no connection yet (one clear way in), a chat, or the list of
 * chats. Chats belong to the project they were started in; the list shows
 * this project's first and the rest after.
 */
export default function AgentPanel() {
  const loaded = useAgent((s) => s.loaded);
  const connections = useAgent((s) => s.connections);
  const view = useAgent((s) => s.view);
  // The link is ON (linked, or knocking for its agent app) — it gets the panel, or a strip beside the chat.
  const linkOn = useMcp((s) => s.status === "connected" || s.status === "waiting" || s.status === "connecting");

  React.useEffect(() => {
    void useAgent.getState().load();
    // A hook for rehearsals in development — never in a production build.
    if (process.env.NODE_ENV !== "production") {
      void import("./runner").then(({ rehearse, armRehearsal, agentApi }) => {
        (window as unknown as Record<string, unknown>)[NAMES.wire.debug("Agent")] = {
          rehearse,
          arm: armRehearsal,
          mcp: (token: string) => void import("./mcp-link").then((m) => m.connectMcp(token)),
          api: agentApi,
          running: () => !!useAgent.getState().live,
          /** The agent's store (connections, settings) and what this person may do — for end-to-end tests. */
          agent: useAgent,
          entitlements: product.entitlements,
          /** Run one registry command the way every AI caller does. */
          call: async (commandId: string, input: unknown) => {
            const [{ callCommand }, { getDocStore }, { editorApiSession }] = await Promise.all([import("./call"), import("../state/document-context"), import("../state/session")]);
            return callCommand(commandId, input, {
              store: getDocStore()!,
              actor: "Test",
              session: editorApiSession(),
            });
          },
          /** One frame of a comp at a scale, as JPEG base64 — for recording a clean render. */
          frame: async (atMs: number, scale = 1) => {
            const [{ renderStill }, { getDocStore }, { useSession }] = await Promise.all([import("../export/export-media"), import("../state/document-context"), import("../state/session")]);
            const doc = getDocStore()!.getState();
            const frame = doc.frames.find((f) => f.id === useSession.getState().activeFrameId) ?? doc.frames[0];
            if (!frame) throw new Error("This project has no frames.");
            const canvas = await renderStill(doc, frame, atMs, { scale });
            return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
          },
          /** The comp's full sound mix as WAV base64. */
          audio: async (durationMs: number) => {
            const [{ renderCompAudioToBuffer, audioBufferToWav }, { getDocStore }, { useSession }] = await Promise.all([import("../export/export-audio"), import("../state/document-context"), import("../state/session")]);
            const doc = getDocStore()!.getState();
            const frameId = useSession.getState().activeFrameId ?? doc.frames[0]?.id;
            if (!frameId) throw new Error("This project has no frames.");
            const wav = audioBufferToWav(await renderCompAudioToBuffer(doc, frameId, durationMs));
            const bytes = new Uint8Array(await wav.arrayBuffer());
            let bin = "";
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(bin);
          },
          /** Every picture the agent looked at in the open chat, newest last. */
          images: () =>
            (useAgent.getState().chat?.messages ?? []).flatMap((m) =>
              m.parts.flatMap((p) => (p.type === "tool_result" ? p.content.filter((c) => c.type === "image") : [])),
            ),
        };
      });
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header />
      {!loaded ? null : connections.length === 0 ? (
        linkOn ? <LinkedView /> : <Welcome />
      ) : view === "history" ? (
        <ChatHistory />
      ) : (
        <>
          {linkOn && <LinkedStrip />}
          <ChatView />
        </>
      )}
      <SetupDialog />
      <KnowledgeDialog />
    </div>
  );
}

function Header() {
  const [mcpOpen, setMcpOpen] = React.useState(false);
  const chat = useAgent((s) => s.chat);
  const view = useAgent((s) => s.view);
  const live = useAgent((s) => s.live);
  // Chats in this project — a quiet count on the history button, not a label.
  const projectId = useAppShell((s) => s.currentProjectId);
  const chatCount = useAgent((s) => s.chats.filter((c) => c.projectId === projectId).length);
  const newChat = () => {
    if (live) return;
    useAgent.getState().newChat(useAppShell.getState().currentProjectId);
  };
  return (
    <div className="flex h-(--control-h-lg) shrink-0 items-center gap-1 border-b border-line pl-1.5 pr-1">
      <HeaderButton label={view === "history" ? "Back to chat" : "Chats"} active={view === "history"} onClick={() => useAgent.getState().setView(view === "history" ? "chat" : "history")}>
        <History />
        {chatCount > 0 && <span className="text-meta tabular-nums text-fg-faint">{chatCount}</span>}
      </HeaderButton>
      <span className="min-w-0 flex-1 truncate px-1 text-label text-fg">{view === "history" ? "Chats" : (chat?.title ?? "New chat")}</span>
      <HeaderButton label="New chat" onClick={newChat} disabled={!!live}>
        <MessageSquarePlus />
      </HeaderButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Agent options"
            className="flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg [&_svg]:size-3.5"
          >
            <MoreHorizontal />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={() => useAgent.getState().setSetupOpen(true)}>
            <PlugZap /> Connections
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => useAgent.getState().setKnowledgeOpen(true)}>
            <BookOpen /> Skills & design systems
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setMcpOpen(true)}>
            <Cable /> Use your agent app…
          </DropdownMenuItem>
          {chat && chat.messages.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!!live} onClick={() => void useAgent.getState().deleteChat(chat.id)} className="text-destructive focus:text-destructive">
                <Trash2 /> Delete this chat
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <McpDialog open={mcpOpen} onOpenChange={setMcpOpen} />
    </div>
  );
}

function HeaderButton({ label, onClick, children, active, disabled }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 [&_svg]:size-3.5",
            active && "material-glass-raised text-primary",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * First run: the mark, one line, the two ways in. A `fill` scroller whose
 * column centres its content — centred when it fits, scrolling from the top
 * when the panel is short, never clipped.
 */
function Welcome() {
  const [mcpOpen, setMcpOpen] = React.useState(false);
  const marks = PROVIDERS.filter((p) => !p.hidden && p.id !== "custom").slice(0, 8);
  return (
    <ScrollArea fill className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-[17rem] flex-col items-center justify-center gap-4 px-5 py-8 text-center">
        <ProviderMark providerId="builtin" className="size-12 rounded-xl text-primary" />
        <p className="text-body text-fg-muted">Ask AI to design, animate and edit this project</p>
        <div className="flex w-full flex-col gap-1.5">
          <Button className="h-(--control-h-lg) w-full min-w-0 px-2" onClick={() => useAgent.getState().setSetupOpen(true)}>
            <PlugZap /> <span className="truncate">Connect a model</span>
          </Button>
          <Button variant="secondary" className="h-(--control-h-lg) w-full min-w-0 px-2" onClick={() => setMcpOpen(true)}>
            <Cable /> <span className="truncate">Use your agent app</span>
          </Button>
        </div>
        <div className="flex flex-wrap justify-center gap-1 opacity-70">
          {marks.map((p) => (
            <ProviderMark key={p.id} providerId={p.id} className="size-5 rounded-md" />
          ))}
        </div>
      </div>
      <McpDialog open={mcpOpen} onOpenChange={setMcpOpen} />
    </ScrollArea>
  );
}

function ChatHistory() {
  const chats = useAgent((s) => s.chats);
  const projectId = useAppShell((s) => s.currentProjectId);
  const [query, setQuery] = React.useState("");
  const q = query.toLowerCase();
  const filtered = chats.filter((c) => !q || c.title.toLowerCase().includes(q));
  const here = filtered.filter((c) => c.projectId === projectId);
  const elsewhere = filtered.filter((c) => c.projectId !== projectId);
  const row = (c: (typeof chats)[number]) => (
    <button
      key={c.id}
      type="button"
      onClick={() => void useAgent.getState().openChat(c.id)}
      className="group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-foreground">{c.title}</span>
        <span className="block truncate text-2xs text-muted-foreground">
          {new Date(c.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {c.model ?? "—"}
        </span>
      </span>
      <span
        role="button"
        tabIndex={0}
        aria-label={`Delete ${c.title}`}
        onClick={(e) => {
          e.stopPropagation();
          void useAgent.getState().deleteChat(c.id);
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-background hover:text-destructive group-hover:opacity-100 [&_svg]:size-3.5"
      >
        <Trash2 />
      </span>
    </button>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative shrink-0 p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" className="h-8 pl-8 text-xs" />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-2 pb-3">
          {filtered.length === 0 && <p className="py-10 text-center text-xs text-muted-foreground">No chats yet.</p>}
          {here.length > 0 && (
            <section>
              <h3 className="px-2 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">This project</h3>
              {here.map(row)}
            </section>
          )}
          {elsewhere.length > 0 && (
            <section>
              <h3 className="px-2 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Other projects</h3>
              {elsewhere.map(row)}
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
