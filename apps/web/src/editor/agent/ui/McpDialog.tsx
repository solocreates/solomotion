"use client";

import { BRIDGE } from "../bridge";
import { useCopied } from "../../console/console-report";
import * as React from "react";
import { Check, ChevronRight, Code2, Copy, ExternalLink, SquareTerminal } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { connectMcp, disconnectMcp, savedToken, useMcp } from "../mcp-link";
import { useAgent } from "../store";
import { ProviderMark } from "./ProviderMark";

/**
 * YOUR AGENT APP — drive the editor from the agent you already use.
 *
 * The product's bridge (`BRIDGE.package`) is an MCP server, so what it needs is an MCP CLIENT, not a
 * particular model: Claude Code, Codex, Gemini CLI, Cursor, VS Code, Claude
 * Desktop — whatever model that app runs. Each client is one row of data (how
 * to add a stdio server there); the pairing below is the same for all of them.
 *
 * One component, shown from the Connections dialog, the Agents welcome, the
 * ⋯ menu and Settings › Agents & AI — never four copies. Three steps, each a
 * row with its control; the explanations live in `?` tooltips.
 */

const SERVER = { command: "npx", args: ["-y", `${BRIDGE.package}@latest`] };
const NAME = BRIDGE.serverName;
const CONFIG_JSON = JSON.stringify({ mcpServers: { [NAME]: SERVER } }, null, 2);

interface AgentClient {
  id: string;
  name: string;
  /** A provider mark, or a generic icon for clients without one. */
  mark: string | typeof SquareTerminal;
  /** One line to paste into a terminal. */
  command?: string;
  /** Where the JSON goes, for clients configured by file. */
  configPath?: string;
  /** A one-click install link the client registers. */
  install?: { label: string; href: string };
}

export const AGENT_CLIENTS: AgentClient[] = [
  { id: "claude-code", name: "Claude Code", mark: "anthropic", command: `claude mcp add -s user ${NAME} -- npx -y ${BRIDGE.package}@latest` },
  { id: "codex", name: "Codex", mark: "openai", command: `codex mcp add ${NAME} -- npx -y ${BRIDGE.package}@latest` },
  { id: "gemini", name: "Gemini CLI", mark: "google", command: `gemini mcp add -s user ${NAME} npx -y ${BRIDGE.package}@latest` },
  {
    id: "cursor",
    name: "Cursor",
    mark: Code2,
    configPath: "~/.cursor/mcp.json",
    install: {
      label: "Add to Cursor",
      href: `cursor://anysphere.cursor-deeplink/mcp/install?name=${NAME}&config=${typeof btoa === "function" ? btoa(JSON.stringify(SERVER)) : ""}`,
    },
  },
  {
    id: "vscode",
    name: "VS Code",
    mark: Code2,
    command: `code --add-mcp '${JSON.stringify({ name: NAME, ...SERVER })}'`,
    install: { label: "Add to VS Code", href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: NAME, ...SERVER }))}` },
  },
  { id: "claude-desktop", name: "Claude Desktop", mark: "anthropic", configPath: "Settings ▸ Developer ▸ Edit Config" },
  { id: "other", name: "Any other", mark: SquareTerminal, configPath: "your client's MCP settings (stdio server)" },
];

function Mark({ mark, className }: { mark: AgentClient["mark"]; className?: string }) {
  if (typeof mark === "string") return <ProviderMark providerId={mark} className={className} />;
  const Icon = mark;
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-raised text-fg-muted", className)}>
      <Icon className="size-[58%]" />
    </span>
  );
}

/** A little stack of the clients' marks — for list rows that stand for all of them. */
export function AgentClientMarks({ className }: { className?: string }) {
  return (
    <span className={cn("flex -space-x-1.5", className)}>
      {["anthropic", "openai", "google"].map((m) => (
        <ProviderMark key={m} providerId={m} className="size-6 rounded-md ring-2 ring-popover" />
      ))}
    </span>
  );
}

function CopyBlock({ text, multiline }: { text: string; multiline?: boolean }) {
  const { copied, copy } = useCopied();
  return (
    <button
      type="button"
      onClick={() => void copy(text)}
      title="Copy"
      className="group flex w-full items-start gap-2 rounded-md bg-raised px-2.5 py-2 text-left font-mono text-meta text-fg-muted transition-colors hover:bg-hover hover:text-fg"
    >
      <span className={cn("min-w-0 flex-1", multiline ? "whitespace-pre" : "[overflow-wrap:anywhere]")}>{text}</span>
      {copied ? <Check className="size-3.5 shrink-0 text-success" /> : <Copy className="size-3.5 shrink-0" />}
    </button>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label="More about this step"
          className="flex size-4 shrink-0 items-center justify-center rounded-full text-meta text-fg-faint hover:bg-hover hover:text-fg"
        >
          ?
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{children}</TooltipContent>
    </Tooltip>
  );
}

/** One step: number, title, `?`, and its control on the right. */
function Step({ n, title, hint, control, children }: { n: number; title: string; hint?: React.ReactNode; control: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-raised text-meta font-medium tabular-nums text-fg-muted">{n}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="truncate text-label text-fg">{title}</span>
          {hint && <Hint>{hint}</Hint>}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">{control}</div>
      </div>
      {children && <div className="pl-8">{children}</div>}
    </section>
  );
}

/** Live link state: a dot and a few words, inline. */
function LinkStatus({ pickedName }: { pickedName: string }) {
  const { status, client, error, calls } = useMcp();
  const on = status !== "off" && status !== "error";
  const text =
    status === "connected"
      ? `${client ?? "Linked"} · ${calls} call${calls === 1 ? "" : "s"}`
      : on
        ? `Waiting for ${pickedName}`
        : (error ?? "Not linked");
  return (
    <span role="status" className={cn("flex min-w-0 items-center gap-1.5 text-body", status === "error" ? "text-destructive" : status === "connected" ? "text-fg" : "text-fg-muted")}>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status === "connected" ? "bg-success" : status === "error" ? "bg-destructive" : on ? "animate-pulse bg-primary" : "bg-fg-faint",
        )}
      />
      <span className="max-w-44 truncate">{text}</span>
    </span>
  );
}

/** The whole setup: add the server to your app, link this tab, choose what it may open. */
export function ExternalAgentSetup() {
  const status = useMcp((s) => s.status);
  const [clientId, setClientId] = React.useState(AGENT_CLIENTS[0]!.id);
  const [token, setToken] = React.useState(savedToken);
  const [advanced, setAdvanced] = React.useState(() => !!savedToken());
  const picked = AGENT_CLIENTS.find((c) => c.id === clientId) ?? AGENT_CLIENTS[0]!;
  const on = status !== "off" && status !== "error";
  const allowed = useAgent((s) => s.settings.projectAccess ?? false);

  return (
    <div className="flex flex-col gap-5">
      <Step
        n={1}
        title={`Add ${BRIDGE.name} to your app`}
        hint={`${BRIDGE.name} is an MCP server, so any MCP app works, whatever model it runs: every editor command as a tool, real renders to check its work, one undo step per request.`}
        control={
          <Select value={clientId} onValueChange={setClientId}>
            <SelectTrigger className="h-(--control-h) w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGENT_CLIENTS.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="flex items-center gap-2">
                    <Mark mark={c.mark} className="size-4 rounded-sm border-0 bg-transparent" />
                    {c.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <div className="flex flex-col gap-2">
          {picked.install && (
            <Button asChild size="xs" variant="secondary" className="w-fit">
              <a href={picked.install.href}>
                {picked.install.label} <ExternalLink />
              </a>
            </Button>
          )}
          {picked.command && <CopyBlock text={picked.command} />}
          {picked.configPath && !picked.command && (
            <>
              <span className="text-meta text-fg-faint">In {picked.configPath}</span>
              <CopyBlock text={CONFIG_JSON} multiline />
            </>
          )}
        </div>
      </Step>

      <Step
        n={2}
        title="Link this tab"
        hint={`Your app starts ${BRIDGE.name}'s bridge when a session begins, so open a NEW session after adding it. This tab then links on its own, every time, until you unlink. Then ask: “in ${BRIDGE.name}, make a 10-second title card”.`}
        control={
          <>
            <LinkStatus pickedName={picked.id === "other" ? "your app" : picked.name} />
            {on ? (
              <Button size="xs" variant="ghost" onClick={disconnectMcp}>
                Unlink
              </Button>
            ) : (
              <Button size="xs" onClick={() => connectMcp(advanced ? token : "")}>
                Link
              </Button>
            )}
          </>
        }
      />

      <Step
        n={3}
        title="Open your other projects"
        hint="Agents can list your other projects and copy comps and media from them into this one — a brand kit from one film into the next. Other projects are read, never changed. The built-in chat follows the same switch."
        control={<Switch checked={allowed} onCheckedChange={(v) => void useAgent.getState().setSettings({ projectAccess: v })} />}
      />

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex w-fit items-center gap-1 text-meta text-fg-muted hover:text-fg">
          <ChevronRight className={cn("size-3 transition-transform", advanced && "rotate-90")} /> Pair with a token
        </button>
        {advanced && (
          <div className="flex items-center gap-2">
            <Input value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="Pairing token" className="h-(--control-h) font-mono text-body" />
            <Hint>
              Only for {BRIDGE.name} served from somewhere of your own. The bridge prints it on start and keeps it in <code>~/{BRIDGE.home}</code>.
            </Hint>
          </div>
        )}
      </div>
    </div>
  );
}

/** The same setup as a dialog, for the Agents panel's ⋯ menu and welcome. */
export function McpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-5">
        <div className="flex items-center gap-3">
          <AgentClientMarks />
          <div className="min-w-0">
            <DialogTitle className="text-heading text-fg">Use your agent app</DialogTitle>
            <DialogDescription className="text-body text-fg-muted">Claude Code, Codex, Cursor or any MCP app.</DialogDescription>
          </div>
        </div>
        <ExternalAgentSetup />
      </DialogContent>
    </Dialog>
  );
}
