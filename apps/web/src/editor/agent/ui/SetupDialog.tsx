"use client";

import * as React from "react";
import { Cable, Check, ChevronLeft, CircleAlert, ExternalLink, Eye, EyeOff, Loader2, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import {
  PROVIDERS,
  chatModels,
  connectionModels,
  modelsFor,
  providerDef,
  testConnection,
  type MediaCapability,
  type Connection,
  type ConnectionTest,
  type ModelDef,
  type ProviderDef,
} from "@solomotion/agent";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ProviderMark } from "./ProviderMark";
import { AgentClientMarks, ExternalAgentSetup } from "./McpDialog";
import { defaultModelFor, useAgent } from "../store";

/**
 * CONNECTIONS — every AI the app can use, set up in one place.
 *
 * Left: your connections, then every provider you could add. Right: the one
 * you picked — its fields, a model, a live TEST (one tiny real request, so a
 * green check means a chat will work), and what else it should do for you:
 * a key that can draw, speak or transcribe can be the one those jobs use.
 *
 * Keys stay on this device, in the browser's storage, and go only to the
 * provider they belong to.
 */

type Selection = { mode: "edit"; id: string } | { mode: "new"; providerId: string } | { mode: "agent-app" } | null;

const CAP_LABEL: Record<MediaCapability, string> = {
  image: "Images — draw and edit",
  video: "Video — shoot, animate, edit",
  speech: "Voiceover",
  transcription: "Transcripts and captions",
  sound: "Sound effects",
  music: "Music",
  cutout: "Background removal",
  isolate: "Voice clean-up",
  upscale: "Upscaling",
  alignment: "Lyric and script timing",
};

export function SetupDialog() {
  const open = useAgent((s) => s.setupOpen);
  const connections = useAgent((s) => s.connections);
  const [selection, setSelection] = React.useState<Selection>(null);

  React.useEffect(() => {
    if (open) setSelection(connections[0] ? { mode: "edit", id: connections[0].id } : null);
    // Selection resets only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const editing = selection?.mode === "edit" ? connections.find((c) => c.id === selection.id) : undefined;
  const provider = selection?.mode === "new" ? providerDef(selection.providerId) : editing ? providerDef(editing.providerId) : undefined;
  const visibleProviders = PROVIDERS.filter((p) => !p.hidden);

  return (
    <Dialog open={open} onOpenChange={(v) => useAgent.getState().setSetupOpen(v)}>
      <DialogContent className="flex h-[min(680px,88vh)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <div className="shrink-0 border-b px-5 py-4">
          <DialogTitle className="text-base">Connections</DialogTitle>
          <DialogDescription className="mt-1 text-xs">Any model, any provider. Keys stay on this device.</DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1">
          {/* The list — hidden on a narrow screen once something is picked. */}
          <ScrollArea className={cn("w-full shrink-0 border-r sm:w-64", selection && "hidden sm:flex")}>
            <div className="space-y-4 p-3">
              {connections.length > 0 && (
                <section>
                  <h3 className="px-1 pb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Yours</h3>
                  <div className="space-y-0.5">
                    {connections.map((c) => (
                      <ListButton key={c.id} active={selection?.mode === "edit" && selection.id === c.id} onClick={() => setSelection({ mode: "edit", id: c.id })}>
                        <ProviderMark providerId={c.providerId} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-foreground">{c.label}</span>
                          <span className="block truncate text-2xs text-muted-foreground">{c.defaultModel ?? providerDef(c.providerId)?.name}</span>
                        </span>
                        {c.verifiedAt && <Check className="size-3.5 shrink-0 text-emerald-500" aria-label="Tested" />}
                      </ListButton>
                    ))}
                  </div>
                </section>
              )}
              <section>
                <h3 className="px-1 pb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Use your agent app</h3>
                <ListButton active={selection?.mode === "agent-app"} onClick={() => setSelection({ mode: "agent-app" })}>
                  <AgentClientMarks className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">Claude Code, Codex…</span>
                    <span className="block truncate text-2xs text-muted-foreground">Any MCP app, any model</span>
                  </span>
                </ListButton>
              </section>
              <section>
                <h3 className="px-1 pb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Add a model</h3>
                <div className="space-y-0.5">
                  {visibleProviders.map((p) => (
                    <ListButton key={p.id} active={selection?.mode === "new" && selection.providerId === p.id} onClick={() => setSelection({ mode: "new", providerId: p.id })}>
                      <ProviderMark providerId={p.id} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-foreground">{p.name}</span>
                        <span className="block truncate text-2xs text-muted-foreground">{p.blurb}</span>
                      </span>
                      <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                    </ListButton>
                  ))}
                </div>
              </section>
            </div>
          </ScrollArea>
          <div className={cn("min-w-0 flex-1", !selection && "hidden sm:block")}>
            {selection?.mode === "agent-app" ? (
              <ScrollArea className="h-full">
                <div className="space-y-4 p-5">
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => setSelection(null)} className="-ml-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent sm:hidden" aria-label="Back">
                      <ChevronLeft className="size-4" />
                    </button>
                    <span className="flex size-10 items-center justify-center rounded-xl border bg-background/70 text-primary">
                      <Cable className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">Your agent app</p>
                      <p className="truncate text-xs text-muted-foreground">Claude Code, Codex, Gemini CLI, Cursor, VS Code — over MCP</p>
                    </div>
                  </div>
                  <ExternalAgentSetup />
                </div>
              </ScrollArea>
            ) : provider ? (
              <ConnectionForm
                key={editing?.id ?? provider.id}
                provider={provider}
                existing={editing}
                onBack={() => setSelection(null)}
                onSaved={(id) => setSelection({ mode: "edit", id })}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
                <Zap className="size-6 text-primary" />
                <p className="text-sm font-medium">Pick a provider to connect</p>
                <p className="max-w-xs text-xs text-muted-foreground">Local models through Ollama or LM Studio need no key. Already use Claude Code or Codex? Link it instead — no key here at all.</p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ListButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
        active ? "material-glass-raised" : "hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

function ConnectionForm({
  provider,
  existing,
  onBack,
  onSaved,
}: {
  provider: ProviderDef;
  existing?: Connection;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const settings = useAgent((s) => s.settings);
  const [label, setLabel] = React.useState(existing?.label ?? provider.name);
  const [values, setValues] = React.useState<Connection["values"]>(existing?.values ?? {});
  const [extra, setExtra] = React.useState<ModelDef[]>(existing?.extraModels ?? []);
  const [model, setModel] = React.useState<string>(existing?.defaultModel ?? provider.defaultModel ?? "");
  const [reveal, setReveal] = React.useState(false);
  const [test, setTest] = React.useState<ConnectionTest | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [custom, setCustom] = React.useState("");

  // A new connection's identity is minted once, when the form opens — not on
  // every keystroke's render.
  const [born] = React.useState(() => ({ id: `conn_${Date.now().toString(36)}`, at: Date.now() }));
  const draft: Connection = {
    id: existing?.id ?? born.id,
    providerId: provider.id,
    label: label.trim() || provider.name,
    values,
    extraModels: extra,
    defaultModel: model || undefined,
    createdAt: existing?.createdAt ?? born.at,
    verifiedAt: existing?.verifiedAt,
  };
  const models = chatModels(draft);
  const canChat = provider.capabilities.includes("chat");
  const missing = provider.fields.filter((f) => f.required && !values[f.key]?.trim());

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    const res = await testConnection(draft, model || models[0]?.id || "");
    setTesting(false);
    setTest(res);
    if (res.models?.length) {
      const known = new Set(connectionModels({ ...draft, extraModels: [] }).map((m) => m.id));
      setExtra(res.models.filter((m) => !known.has(m.id)));
    }
    if (res.ok && existing) await useAgent.getState().saveConnection({ ...draft, verifiedAt: Date.now() });
  };

  const save = async () => {
    const c: Connection = { ...draft, verifiedAt: test?.ok ? Date.now() : draft.verifiedAt, defaultModel: model || defaultModelFor(draft) || undefined };
    await useAgent.getState().saveConnection(c);
    onSaved(c.id);
  };

  const connections = useAgent((s) => s.connections);
  /** Who serves a job NOW: the route the user set, else the first connection that can. */
  const servedBy = (cap: MediaCapability) =>
    connections.find((c) => c.id === settings.routes[cap] && providerDef(c.providerId)?.capabilities.includes(cap))?.id ??
    connections.find((c) => providerDef(c.providerId)?.capabilities.includes(cap))?.id;
  const setRoute = (cap: MediaCapability, on: boolean) => {
    const other = connections.find((c) => c.id !== draft.id && providerDef(c.providerId)?.capabilities.includes(cap));
    void useAgent.getState().setSettings({ routes: { ...settings.routes, [cap]: on ? draft.id : other?.id } });
  };
  const setRouteModel = (cap: MediaCapability, model: string) =>
    void useAgent.getState().setSettings({ routeModels: { ...settings.routeModels, [cap]: model || undefined } });

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-5">
          <div className="flex items-center gap-3">
            <button type="button" onClick={onBack} className="-ml-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent sm:hidden" aria-label="Back">
              <ChevronLeft className="size-4" />
            </button>
            <ProviderMark providerId={provider.id} className="size-10 rounded-xl" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{provider.name}</p>
              <p className="truncate text-xs text-muted-foreground">{provider.blurb}</p>
            </div>
            {provider.keysUrl && (
              <a href={provider.keysUrl} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline">
                Get a key <ExternalLink className="size-3" />
              </a>
            )}
          </div>

          <Field label="Name">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 text-sm" />
          </Field>

          {provider.fields.map((f) => (
            <Field key={f.key} label={f.label} hint={f.help} required={f.required}>
              <div className="relative">
                <Input
                  type={f.secret && !reveal ? "password" : "text"}
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [f.key]: e.target.value }));
                    setTest(null);
                  }}
                  className={cn("h-8 font-mono text-xs", f.secret && "pr-8")}
                />
                {f.secret && (
                  <button
                    type="button"
                    onClick={() => setReveal((v) => !v)}
                    aria-label={reveal ? "Hide key" : "Show key"}
                    className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  >
                    {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                )}
              </div>
            </Field>
          ))}

          {canChat && (
            <Field label="Model">
              <div className="grid gap-1">
                {models.slice(0, 40).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModel(m.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                      model === m.id ? "border-primary/60 bg-primary/10" : "hover:bg-accent",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">{m.label}</span>
                      <span className="block truncate text-2xs text-muted-foreground">{m.note ?? m.id}</span>
                    </span>
                    {m.reasoning && <span className="rounded bg-muted px-1 text-2xs text-muted-foreground">thinks</span>}
                    {m.vision && <span className="rounded bg-muted px-1 text-2xs text-muted-foreground">sees</span>}
                  </button>
                ))}
                <div className="flex gap-1.5">
                  <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Another model id…" className="h-7 text-xs" />
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 shrink-0 text-xs"
                    disabled={!custom.trim()}
                    onClick={() => {
                      const id = custom.trim();
                      setExtra((e) => [...e.filter((m) => m.id !== id), { id, label: id, contextWindow: 128_000 }]);
                      setModel(id);
                      setCustom("");
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </Field>
          )}

          {provider.capabilities.some((c) => c !== "chat") && (
            <Field label="Also use it for">
              <div className="space-y-1.5">
                {provider.capabilities
                  .filter((c): c is MediaCapability => c !== "chat")
                  .map((cap) => {
                    const on = !!existing && servedBy(cap) === draft.id;
                    const options = modelsFor(draft, cap);
                    return (
                      <div key={cap} className="rounded-md border px-2.5 py-1.5 text-xs">
                        <label className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate">{CAP_LABEL[cap]}</span>
                          <Switch checked={on} disabled={!existing} onCheckedChange={(v) => setRoute(cap, v)} aria-label={CAP_LABEL[cap]} />
                        </label>
                        {on && options.length > 1 && (
                          <select
                            className="mt-1.5 h-7 w-full rounded-md border bg-background px-1.5 text-2xs text-muted-foreground"
                            value={settings.routeModels?.[cap] ?? ""}
                            onChange={(e) => setRouteModel(cap, e.target.value)}
                            aria-label={`${CAP_LABEL[cap]} model`}
                          >
                            <option value="">Best fit for each job</option>
                            {options.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.label}
                                {m.note ? ` — ${m.note}` : ""}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                {!existing && <p className="text-2xs text-muted-foreground">Save the connection first.</p>}
              </div>
            </Field>
          )}

          {test && (
            <div
              className={cn(
                "agent-rise flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                test.ok ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-destructive/40 bg-destructive/10 text-destructive",
              )}
              role="status"
            >
              {test.ok ? <Check className="mt-px size-3.5 shrink-0" /> : <CircleAlert className="mt-px size-3.5 shrink-0" />}
              <span className="[overflow-wrap:anywhere]">
                {test.ok ? `Connected in ${test.ms}ms${test.reply ? ` — “${test.reply}”` : ""}${test.models?.length ? ` · ${test.models.length} models available` : ""}` : test.error}
              </span>
            </div>
          )}
        </div>
      </ScrollArea>
      <div className="flex shrink-0 items-center gap-2 border-t px-5 py-3">
        {existing && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => {
              void useAgent.getState().removeConnection(existing.id);
              onBack();
            }}
          >
            <Trash2 /> Remove
          </Button>
        )}
        <div className="flex-1" />
        {canChat && (
          <Button variant="secondary" size="sm" onClick={() => void runTest()} disabled={testing || missing.length > 0 || !(model || models[0])}>
            {testing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Test
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={missing.length > 0}>
          {existing ? "Save" : "Connect"}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-foreground">
        {label}
        {required && <span className="text-muted-foreground"> *</span>}
      </p>
      {children}
      {hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
