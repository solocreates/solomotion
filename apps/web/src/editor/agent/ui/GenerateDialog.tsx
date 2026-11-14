"use client";

import * as React from "react";
import { AudioLines, Film, ImagePlus, Music, PlugZap, Sparkles, Waves } from "lucide-react";
import { listVoices, pickModel, providerDef, type MediaCapability, type Voice } from "@solomotion/agent";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useSession } from "../../state/session";
import { usePanels } from "../../state/panels";
import { askAgent } from "../ask-bus";
import { useGenerate, type GenerateKind } from "../generate-bus";
import { runQuickAction } from "../quick-actions";
import { connectionFor } from "../runner";
import { useAgent } from "../store";

/**
 * GENERATE WITH AI — make a new picture, shot, voiceover, sound or score
 * straight onto the timeline at the playhead, without a conversation. The
 * dialog only gathers the brief; the job runs through the same registry verb
 * the agent uses (`generate.*`), so routing, provenance, the ghost on the
 * canvas and the one-step undo are the agent's too. "Ask the agent" hands the
 * same brief to the chat when it needs judgement, not just a render.
 */

const KINDS: Array<{ kind: GenerateKind; label: string; icon: React.ComponentType<{ className?: string }>; capability: MediaCapability; placeholder: string }> = [
  { kind: "image", label: "Image", icon: ImagePlus, capability: "image", placeholder: "A ceramic coffee cup on warm linen, soft window light from the left, 50mm, shallow depth, space above for a title" },
  { kind: "video", label: "Video", icon: Film, capability: "video", placeholder: "Slow push-in on a neon diner sign at night, rain on the lens, reflections on wet asphalt, moody and quiet" },
  { kind: "speech", label: "Voice", icon: AudioLines, capability: "speech", placeholder: "Write the script the way it should be spoken. Punctuation is pacing." },
  { kind: "sound", label: "Sound", icon: Waves, capability: "sound", placeholder: "A soft, airy whoosh left to right, short tail" },
  { kind: "music", label: "Music", icon: Music, capability: "music", placeholder: "Warm lo-fi, 84 bpm, felt piano and brushed drums, builds gently, ends clean" },
];

const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border bg-muted/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("h-6 rounded-md px-2 text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground", value === o.value && "bg-background text-foreground shadow-sm")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function GenerateDialog() {
  const kind = useGenerate((s) => s.kind);
  const initial = useGenerate((s) => s.prompt);
  const connections = useAgent((s) => s.connections);
  const settings = useAgent((s) => s.settings);
  const [prompt, setPrompt] = React.useState("");
  const [aspect, setAspect] = React.useState<(typeof ASPECTS)[number]>("16:9");
  const [count, setCount] = React.useState(1);
  const [transparent, setTransparent] = React.useState(false);
  const [durationS, setDurationS] = React.useState(6);
  const [withSound, setWithSound] = React.useState(true);
  const [loop, setLoop] = React.useState(false);
  const [instrumental, setInstrumental] = React.useState(true);
  const [voice, setVoice] = React.useState("");
  const [style, setStyle] = React.useState("");
  const [voices, setVoices] = React.useState<Voice[]>([]);

  React.useEffect(() => {
    void useAgent.getState().load();
  }, []);
  React.useEffect(() => {
    if (kind) setPrompt(initial);
  }, [kind, initial]);

  const def = KINDS.find((k) => k.kind === kind) ?? KINDS[0]!;
  // Re-read on every render that could change it: connections, routes.
  const connection = React.useMemo(() => (kind ? connectionFor(def.capability) : null), [kind, def.capability, connections, settings]);
  const model = connection ? pickModel(connection, def.capability, "text", settings.routeModels?.[def.capability]) : null;

  React.useEffect(() => {
    if (kind !== "speech" || !connection) return;
    const ctl = new AbortController();
    listVoices(connection, ctl.signal)
      .then(setVoices)
      .catch(() => setVoices([]));
    return () => ctl.abort();
  }, [kind, connection]);

  const close = () => useGenerate.setState({ kind: null });

  const go = () => {
    const text = prompt.trim();
    if (!text || !kind) return;
    const s = useSession.getState();
    const place = { frameId: s.activeFrameId ?? undefined, startMs: s.playheadMs };
    const common = { capability: def.capability, done: "Placed at the playhead" };
    const action =
      kind === "image"
        ? { ...common, command: "generate.image", label: "Draw image", input: { prompt: text, aspect, count, transparent, place } }
        : kind === "video"
          ? { ...common, command: "generate.video", label: "Shoot video", input: { prompt: text, aspect: aspect === "4:3" || aspect === "3:4" ? "16:9" : aspect, durationS, audio: withSound, place } }
          : kind === "speech"
            ? { ...common, command: "generate.speech", label: "Record voiceover", input: { text, ...(voice ? { voice } : {}), ...(style.trim() ? { style: style.trim() } : {}), place } }
            : kind === "sound"
              ? { ...common, command: "generate.sound", label: "Design sound", input: { prompt: text, durationS, loop, place } }
              : { ...common, command: "generate.music", label: "Compose music", input: { prompt: text, durationS: Math.max(10, durationS), instrumental, place } };
    close();
    void runQuickAction(action);
  };

  const askInstead = () => {
    close();
    usePanels.getState().showLeftPanel("agents");
    askAgent(`${def.label === "Voice" ? "Record a voiceover" : `Make ${def.label === "Image" ? "an image" : def.label === "Video" ? "a video" : def.label === "Sound" ? "a sound effect" : "music"}`} for this project: ${prompt.trim()}`);
  };

  const durations = kind === "music" ? [15, 30, 60, 120] : kind === "sound" ? [1, 2, 4, 8] : [4, 6, 8, 12];

  return (
    <Dialog open={!!kind} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <div className="px-5 pb-3 pt-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-primary" /> Generate with AI
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs">Lands in Media (“AI generated”) and on the timeline at the playhead. ⌘Z removes it.</DialogDescription>
        </div>

        <div className="flex gap-1 px-5 pb-3" role="tablist" aria-label="What to make">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="tab"
              aria-selected={k.kind === kind}
              onClick={() => useGenerate.setState({ kind: k.kind })}
              className={cn(
                "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3.5",
                k.kind === kind && "border-primary/50 bg-primary/10 text-foreground",
              )}
            >
              <k.icon /> {k.label}
            </button>
          ))}
        </div>

        <div className="space-y-3 px-5 pb-4">
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
            }}
            placeholder={def.placeholder}
            rows={kind === "speech" ? 6 : 4}
            className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
          />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            {(kind === "image" || kind === "video") && (
              <Segmented
                label="Aspect"
                value={aspect}
                onChange={setAspect}
                options={(kind === "video" ? ASPECTS.slice(0, 3) : ASPECTS).map((a) => ({ value: a, label: a }))}
              />
            )}
            {kind === "image" && (
              <>
                <Segmented label="How many" value={String(count) as "1"} onChange={(v) => setCount(Number(v))} options={["1", "2", "4"].map((n) => ({ value: n as "1", label: `×${n}` }))} />
                <label className="flex items-center gap-2 text-muted-foreground">
                  <Switch checked={transparent} onCheckedChange={setTransparent} aria-label="Transparent background" /> Transparent
                </label>
              </>
            )}
            {(kind === "video" || kind === "sound" || kind === "music") && (
              <Segmented label="Length" value={String(durationS) as "4"} onChange={(v) => setDurationS(Number(v))} options={durations.map((d) => ({ value: String(d) as "4", label: `${d}s` }))} />
            )}
            {kind === "video" && (
              <label className="flex items-center gap-2 text-muted-foreground">
                <Switch checked={withSound} onCheckedChange={setWithSound} aria-label="Generate sound" /> With sound
              </label>
            )}
            {kind === "sound" && (
              <label className="flex items-center gap-2 text-muted-foreground">
                <Switch checked={loop} onCheckedChange={setLoop} aria-label="Seamless loop" /> Loop
              </label>
            )}
            {kind === "music" && (
              <label className="flex items-center gap-2 text-muted-foreground">
                <Switch checked={instrumental} onCheckedChange={setInstrumental} aria-label="Instrumental" /> Instrumental
              </label>
            )}
            {kind === "speech" && (
              <div className="flex w-full gap-2">
                <select
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  aria-label="Voice"
                  className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
                >
                  <option value="">Default voice</option>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {v.description ? ` — ${v.description}` : ""}
                    </option>
                  ))}
                </select>
                <input
                  value={style}
                  onChange={(e) => setStyle(e.target.value)}
                  placeholder="Direction: warm, unhurried"
                  aria-label="Performance direction"
                  className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/70"
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t px-5 py-3">
          {connection ? (
            <p className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
              {providerDef(connection.providerId)?.name ?? connection.label} · {model?.label ?? "no model"}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => {
                close();
                usePanels.getState().showLeftPanel("agents");
                useAgent.getState().setSetupOpen(true);
              }}
              className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-2xs text-muted-foreground hover:text-foreground"
            >
              <PlugZap className="size-3.5 shrink-0" /> Nothing connected can do this yet — connect a provider
            </button>
          )}
          <button type="button" onClick={askInstead} disabled={!prompt.trim()} className="h-8 rounded-lg px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40">
            Ask the agent
          </button>
          <button
            type="button"
            onClick={go}
            disabled={!prompt.trim() || !connection}
            className="flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium material-action text-primary transition-[filter,transform] hover:brightness-110 active:translate-y-px disabled:pointer-events-none disabled:opacity-40"
          >
            <Sparkles className="size-3.5" /> Generate
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
