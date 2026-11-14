"use client";

import * as React from "react";
import { ArrowUp, FileText, Loader2, Mic, Paperclip, Square, X } from "lucide-react";
import { transcribe, modelsFor, providerDef, type Part } from "@solomotion/agent";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { formatBytes } from "@/lib/format-bytes";
import { classify, imageToBase64, putAttachment } from "../attachments";
import { sendMessage, stopRun } from "../runner";
import { onAsk } from "../ask-bus";
import { useAgent } from "../store";
import { ContextMeter, ModelPicker } from "./ModelPicker";

/**
 * THE COMPOSER — where the user talks to the agent, and it stays usable while
 * the agent works: whatever is sent mid-run is queued and folded into the run
 * at its next step (Claude Code's steering), so a correction never has to wait
 * for a stop.
 *
 * Any file goes in: pasted, dropped or picked. Images are seen, text files are
 * read, everything else (audio, video, fonts) is stored once and handed over
 * by id for a tool to use. The box grows with what is typed up to 40% of the
 * panel, then scrolls — a composer that eats the transcript is worse than one
 * that scrolls.
 */

interface Draft {
  key: string;
  file: File;
  preview?: string;
}

const MAX_INLINE_TEXT = 200_000;

async function partsFor(drafts: Draft[]): Promise<Part[]> {
  const out: Part[] = [];
  for (const d of drafts) {
    const kind = classify(d.file.name, d.file.type);
    if (kind === "text" && d.file.size <= MAX_INLINE_TEXT) {
      out.push({ type: "file", name: d.file.name, mediaType: d.file.type || "text/plain", text: await d.file.text() });
      continue;
    }
    const stored = await putAttachment(d.file);
    if (kind === "image") {
      const img = await imageToBase64(d.file);
      out.push({ type: "image", mediaType: img.mediaType, data: img.data, name: d.file.name, attachmentId: stored.id, size: d.file.size });
      continue;
    }
    const meta: Record<string, string | number> = {};
    if (kind === "audio" || kind === "video") {
      const ms = await mediaDuration(d.file);
      if (ms) meta.durationMs = ms;
    }
    out.push({ type: "attachment", id: stored.id, name: d.file.name, mediaType: stored.type, size: d.file.size, ...(Object.keys(meta).length ? { meta } : {}) });
  }
  return out;
}

function mediaDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    const url = URL.createObjectURL(file);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : null);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    el.src = url;
  });
}

export function Composer({ panelHeight }: { panelHeight: number }) {
  const [text, setText] = React.useState("");
  const [drafts, setDrafts] = React.useState<Draft[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const live = useAgent((s) => s.live);
  const chat = useAgent((s) => s.chat);
  const running = !!live;
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const maxHeight = Math.max(96, Math.round(panelHeight * 0.4));

  // Grow with the text, up to the cap.
  React.useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }, [text, maxHeight]);

  // "Ask AI" from a layer's context menu lands here as a draft.
  React.useEffect(
    () =>
      onAsk((draft) => {
        setText(draft);
        requestAnimationFrame(() => {
          const ta = taRef.current;
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(draft.length, draft.length);
        });
      }),
    [],
  );

  // Focus follows a freshly opened chat.
  React.useEffect(() => {
    taRef.current?.focus();
  }, [chat?.id]);

  const addFiles = React.useCallback((files: Iterable<File>) => {
    const next: Draft[] = [];
    for (const file of files) {
      next.push({ key: `${file.name}-${file.size}-${Math.random()}`, file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined });
    }
    if (next.length) setDrafts((d) => [...d, ...next]);
  }, []);

  const removeDraft = (key: string) =>
    setDrafts((d) => {
      const gone = d.find((x) => x.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return d.filter((x) => x.key !== key);
    });

  const submit = async () => {
    const trimmed = text.trim();
    if ((!trimmed && !drafts.length) || busy) return;
    setBusy(true);
    try {
      const parts: Part[] = [...(await partsFor(drafts))];
      if (trimmed) parts.push({ type: "text", text: trimmed });
      for (const d of drafts) if (d.preview) URL.revokeObjectURL(d.preview);
      setText("");
      setDrafts([]);
      await sendMessage(parts);
    } catch (err) {
      toast.error("Could not send", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      taRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      stopRun();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const canSend = (text.trim().length > 0 || drafts.length > 0) && !busy;
  const contextUsed = live?.contextTokens ?? chat?.contextTokens ?? 0;
  const contextWindow = live?.contextWindow ?? 0;

  return (
    <div
      className="shrink-0 px-2 pb-2"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <div
        className={cn(
          "rounded-xl border bg-card/80 shadow-sm transition-[border-color,box-shadow] focus-within:border-primary/50 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_15%,transparent)]",
          dragging && "border-dashed border-primary",
        )}
      >
        {drafts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-2">
            {drafts.map((d) => (
              <span key={d.key} className="group relative flex items-center gap-1.5 rounded-lg border bg-background/70 py-1 pl-1 pr-6 text-2xs">
                {d.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={d.preview} alt="" className="size-7 rounded object-cover" />
                ) : (
                  <span className="flex size-7 items-center justify-center rounded bg-muted text-muted-foreground">
                    <FileText className="size-3.5" />
                  </span>
                )}
                <span className="max-w-[8rem]">
                  <span className="block truncate text-foreground">{d.file.name}</span>
                  <span className="block text-muted-foreground">{formatBytes(d.file.size)}</span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${d.file.name}`}
                  onClick={() => removeDraft(d.key)}
                  className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder={running ? "Add to what it's doing…" : "Ask for anything — design, animate, edit, generate"}
          aria-label="Message the agent"
          className="block w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          style={{ maxHeight }}
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <IconButton label="Attach files" onClick={() => fileRef.current?.click()}>
            <Paperclip />
          </IconButton>
          <Dictation onText={(t) => setText((v) => (v ? `${v} ${t}` : t))} />
          <div className="flex min-w-0 flex-1 items-center">
            <ModelPicker />
          </div>
          <span className="flex shrink-0 items-center px-1">
            <ContextMeter used={contextUsed} window={contextWindow} />
          </span>
          {/* ONE action slot, so nothing ever overlaps the model name: Stop
              while it works and the box is empty, Send (which queues mid-run)
              the moment there is something to send. */}
          {running && !canSend ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={stopRun}
                  aria-label="Stop"
                  className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/90 text-background transition-[filter,transform] hover:brightness-90 active:translate-y-px"
                >
                  <Square className="size-2.5 fill-current" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Stop  Esc</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!canSend}
                  aria-label={running ? "Queue message" : "Send"}
                  className={cn(
                    "ml-1 flex size-7 shrink-0 items-center justify-center rounded-lg transition-[background,opacity,transform] active:translate-y-px [&_svg]:size-4",
                    canSend ? "material-action text-primary hover:brightness-110" : "bg-muted text-muted-foreground opacity-60",
                  )}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{running ? "Queue — it joins at the next step" : "Send  ↵"}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

function IconButton({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5",
            active && "bg-destructive/15 text-destructive hover:bg-destructive/25 hover:text-destructive",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

// ── Dictation ────────────────────────────────────────────────────────────────

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>; resultIndex: number }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};

/**
 * Speak instead of type. With a transcription connection (Whisper, Scribe,
 * Groq) the recording is transcribed by it — accurate, any language; without
 * one, the browser's own recognizer does it, so dictation works with nothing
 * set up at all.
 */
function Dictation({ onText }: { onText: (text: string) => void }) {
  const [state, setState] = React.useState<"idle" | "listening" | "transcribing">("idle");
  const stopRef = React.useRef<(() => void) | null>(null);

  const start = async () => {
    const { connections, settings } = useAgent.getState();
    const routed = connections.find((c) => c.id === settings.routes.transcription);
    const conn = routed ?? connections.find((c) => providerDef(c.providerId)?.capabilities.includes("transcription"));
    const model = conn ? modelsFor(conn, "transcription")[0]?.id : undefined;

    if (conn && model && typeof MediaRecorder !== "undefined") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          setState("transcribing");
          try {
            const t = await transcribe({ connection: conn, model, audio: new Blob(chunks, { type: rec.mimeType }) });
            if (t.text.trim()) onText(t.text.trim());
          } catch (err) {
            toast.error("Could not transcribe", { description: err instanceof Error ? err.message : String(err) });
          } finally {
            setState("idle");
          }
        };
        rec.start();
        stopRef.current = () => rec.stop();
        setState("listening");
        return;
      } catch {
        toast.error("Microphone access was blocked");
        return;
      }
    }

    const Ctor = (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike })
      .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (!Ctor) {
      toast("Dictation needs a transcription connection in this browser", { description: "Add OpenAI, Groq or ElevenLabs in Agents → Connections." });
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = navigator.language;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i]!.isFinal) onText(e.results[i]![0].transcript.trim());
    };
    rec.onend = () => setState("idle");
    rec.onerror = () => setState("idle");
    rec.start();
    stopRef.current = () => rec.stop();
    setState("listening");
  };

  const stop = () => {
    stopRef.current?.();
    stopRef.current = null;
  };

  return state === "transcribing" ? (
    <span className="flex size-7 items-center justify-center text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
    </span>
  ) : (
    <IconButton label={state === "listening" ? "Stop dictation" : "Dictate"} onClick={state === "listening" ? stop : () => void start()} active={state === "listening"}>
      <Mic className={cn(state === "listening" && "animate-pulse")} />
    </IconButton>
  );
}
