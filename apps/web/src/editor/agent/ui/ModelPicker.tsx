"use client";

import * as React from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { chatModels, providerDef, type Effort } from "@solomotion/agent";
import { Popover, PopoverBody, PopoverContent, PopoverFooter, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ProviderMark } from "./ProviderMark";
import { fmtTokens } from "./Transcript";
import { connectionOf, useAgent } from "../store";

/**
 * Which model the chat runs on — switchable mid-conversation, because the
 * transcript is provider-neutral. The choice is the CHAT's (a Claude chat stays
 * Claude when you open it tomorrow) and also becomes the default for new ones.
 */

const EFFORTS: Array<{ id: Effort; label: string }> = [
  { id: "low", label: "Fast" },
  { id: "medium", label: "Balanced" },
  { id: "high", label: "Deep" },
  { id: "max", label: "Max" },
];

export function ModelPicker() {
  const connections = useAgent((s) => s.connections);
  const settings = useAgent((s) => s.settings);
  const chat = useAgent((s) => s.chat);
  const [open, setOpen] = React.useState(false);
  const connection = connectionOf({ connections, settings }, chat);
  const modelId = chat?.model ?? settings.model;
  const model = connection ? chatModels(connection).find((m) => m.id === modelId) : undefined;

  const choose = async (connectionId: string, id: string) => {
    const state = useAgent.getState();
    if (state.chat) await state.saveChat({ ...state.chat, connectionId, model: id });
    await state.setSettings({ connectionId, model: id });
    setOpen(false);
  };

  const chatCapable = connections.filter((c) => providerDef(c.providerId)?.capabilities.includes("chat"));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          {connection && <ProviderMark providerId={connection.providerId} className="size-4 rounded border-0 bg-transparent" />}
          <span className="truncate">{model?.label ?? modelId ?? "Choose a model"}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-0">
        <PopoverBody className="max-h-80">
          <div className="p-1">
            {chatCapable.map((c) => (
              <div key={c.id} className="py-1">
                <div className="flex items-center gap-1.5 px-2 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  <ProviderMark providerId={c.providerId} className="size-3.5 rounded-sm border-0 bg-transparent" />
                  {c.label}
                </div>
                {chatModels(c).map((m) => {
                  const active = c.id === connection?.id && m.id === modelId;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => void choose(c.id, m.id)}
                      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent", active && "bg-accent/60")}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-foreground">{m.label}</span>
                        {m.note && <span className="block truncate text-2xs text-muted-foreground">{m.note}</span>}
                      </span>
                      <span className="shrink-0 tabular-nums text-2xs text-muted-foreground">{fmtTokens(m.contextWindow)}</span>
                      <Check className={cn("size-3.5 shrink-0 text-primary", !active && "invisible")} />
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </PopoverBody>
        <PopoverFooter className="space-y-2 p-2">
          <div className="flex items-center gap-2">
            <span className="text-2xs text-muted-foreground">Effort</span>
            <div role="radiogroup" aria-label="Effort" className="flex flex-1 rounded-md bg-muted/50 p-0.5">
              {EFFORTS.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="radio"
                  aria-checked={settings.effort === e.id}
                  onClick={() => void useAgent.getState().setSettings({ effort: e.id })}
                  className={cn(
                    "flex-1 rounded px-1 py-0.5 text-2xs transition-colors",
                    settings.effort === e.id ? "material-glass-raised text-primary" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              useAgent.getState().setSetupOpen(true);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3.5" /> Connect another model
          </button>
        </PopoverFooter>
      </PopoverContent>
    </Popover>
  );
}

/** How full the model's context window is — a ring, with the numbers on hover. */
export function ContextMeter({ used, window }: { used: number; window: number }) {
  if (!window || !used) return null;
  const f = Math.min(1, used / window);
  const r = 7;
  const c = 2 * Math.PI * r;
  const tone = f > 0.85 ? "text-destructive" : f > 0.6 ? "text-warning" : "text-primary";
  return (
    <span className="group relative flex items-center" title={`Context ${fmtTokens(used)} of ${fmtTokens(window)} tokens (${Math.round(f * 100)}%)`}>
      <svg viewBox="0 0 18 18" className="size-4 -rotate-90" aria-label={`Context ${Math.round(f * 100)}% full`}>
        <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2" className="stroke-border" />
        <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2" strokeLinecap="round" className={cn("stroke-current transition-[stroke-dashoffset] duration-500", tone)} strokeDasharray={c} strokeDashoffset={c * (1 - f)} />
      </svg>
    </span>
  );
}
