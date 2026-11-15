"use client";

import * as React from "react";
import { ArrowDown, Film, Palette, Type } from "lucide-react";
import { providerDef } from "@solomotion/agent";
import type { Message, ToolResultPart } from "@solomotion/agent";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useAgent } from "../store";
import { recordFeedback } from "../feedback";
import { sendMessage } from "../runner";
import { Composer } from "./Composer";
import { ProviderMark } from "./ProviderMark";
import { askAgent } from "../ask-bus";
import { AssistantMessage, LiveBlock, Notice, StatusLine, UserMessage } from "./Transcript";

/**
 * The conversation. It STICKS TO THE BOTTOM while the agent writes — unless
 * the user scrolls up to read, in which case it stays exactly where they put
 * it and offers a way back down. Yanking someone to the bottom mid-sentence is
 * the most common way a chat UI loses trust.
 */
export function ChatView() {
  const chat = useAgent((s) => s.chat);
  const live = useAgent((s) => s.live);
  const lastError = useAgent((s) => s.lastError);
  const viewport = React.useRef<HTMLDivElement>(null);
  const root = React.useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = React.useState(true);
  const [height, setHeight] = React.useState(600);
  const [ratings, setRatings] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setHeight(e!.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const messages = chat?.messages ?? [];
  const liveHere = live && live.chatId === chat?.id ? live : null;

  // Tool results live in the user message after their call; index them once.
  const results = React.useMemo(() => {
    const map = new Map<string, ToolResultPart>();
    for (const m of messages) for (const p of m.parts) if (p.type === "tool_result") map.set(p.callId, p);
    return map;
  }, [messages]);

  const scrollToEnd = React.useCallback((smooth = false) => {
    const el = viewport.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  React.useLayoutEffect(() => {
    if (stuck) scrollToEnd();
  });

  React.useEffect(() => {
    setStuck(true);
  }, [chat?.id]);

  const onScroll = () => {
    const el = viewport.current;
    if (!el) return;
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  const rate = (m: Message, up: boolean) => {
    setRatings((r) => ({ ...r, [m.id]: up }));
    recordFeedback({ kind: "rating", up, reasons: up ? ["great"] : [] }, { provider: m.model?.provider ?? "unknown", model: m.model?.model ?? "unknown" });
  };

  const visible = messages.filter((m) => m.role === "assistant" || m.parts.some((p) => p.type !== "tool_result"));

  return (
    <div ref={root} className="relative flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1" viewportRef={viewport} viewportProps={{ onScroll }}>
        <div className="space-y-4 px-3 py-3">
          {visible.length === 0 && !liveHere && <Starters />}
          {visible.map((m) =>
            m.role === "user" ? (
              <UserMessage key={m.id} message={m} />
            ) : (
              <AssistantMessage key={m.id} message={m} results={results} rating={ratings[m.id] ?? null} onRate={(up) => rate(m, up)} checkpoint={chat?.checkpoints?.[m.id]} />
            ),
          )}
          {liveHere?.queued.map((m) => (
            <div key={m.id} className="opacity-60">
              <UserMessage message={m} />
            </div>
          ))}
          {liveHere && <LiveBlock live={liveHere} />}
          {liveHere?.notice && <Notice level={liveHere.notice.level} text={liveHere.notice.text} />}
          {!liveHere && lastError && lastError.chatId === chat?.id && <Notice level="error" text={lastError.text} />}
          {liveHere && <StatusLine live={liveHere} />}
        </div>
      </ScrollArea>
      {!stuck && (
        <button
          type="button"
          onClick={() => {
            setStuck(true);
            scrollToEnd(true);
          }}
          aria-label="Jump to latest"
          className="absolute left-1/2 z-10 flex size-7 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-raised text-fg-muted shadow-(--elevation-2) transition-colors hover:text-fg"
          style={{ bottom: 96 }}
        >
          <ArrowDown className="size-3.5" />
        </button>
      )}
      <Composer panelHeight={height} />
    </div>
  );
}

/**
 * An empty chat: the model you are talking to, large; one line; three
 * prompts that land in the composer (to edit, not to send) — the agent's
 * best starting points, never a paragraph.
 */
function Starters() {
  const connectionId = useAgent((s) => s.settings.connectionId);
  const connection = useAgent((s) => s.connections.find((c) => c.id === connectionId) ?? s.connections[0]);
  const name = connection ? (providerDef(connection.providerId)?.name ?? "the agent") : "the agent";
  const starters = [
    { icon: Type, text: "Design a bold title card and animate it in" },
    { icon: Film, text: "Cut the selected video into a 30s vertical reel with captions" },
    { icon: Palette, text: "Grade this shot warm and filmic" },
  ];
  return (
    <div className="flex flex-col items-center gap-4 px-2 pb-2 pt-10 text-center">
      <ProviderMark providerId={connection?.providerId ?? "builtin"} className="size-12 rounded-xl" />
      <p className="text-body text-fg-muted">What should {name} make?</p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {starters.map((s) => (
          <button
            key={s.text}
            type="button"
            onClick={() => askAgent(s.text)}
            className="flex h-(--control-h) max-w-full items-center gap-1.5 rounded-(--r-control) border border-line px-2.5 text-body text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <s.icon className="size-3.5 shrink-0" />
            <span className="truncate">{s.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
