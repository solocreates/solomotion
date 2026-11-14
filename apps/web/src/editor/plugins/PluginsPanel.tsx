"use client";

import * as React from "react";
import { ChevronLeft, ExternalLink, MoreHorizontal, PanelLeft, RefreshCw, Search, Trash2, X } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { forgetDevHandle, hasDevHandle, reloadFromFolder } from "./dev-folder";
import { PluginBody } from "./PluginBody";
import { PluginMark } from "./PluginIcon";
import { PluginInstallMenu } from "./PluginInstallMenu";
import { usePluginWindows } from "./plugin-windows";
import { usePlugins } from "./plugins-store";
import type { RuntimePlugin } from "./plugin-model";

/**
 * PLUGINS — a docked panel beside Library, Media and Layers, and the app's ONE
 * plugin surface. It has two states, which is the whole idea:
 *
 *   browse   the plugins you have, searchable, grouped by what they do
 *   running  the plugin you picked, filling this panel
 *
 * A plugin is therefore a TOOL you choose in a sidebar, not a window you
 * summon — and because the panel body comes from the shared registry, that same
 * plugin follows the panel anywhere the panel can go (docked left, or floated
 * into a sticky window through the rail's right-click). `PluginBody` is what
 * makes that true: it renders a plugin without knowing its host.
 *
 * There used to be a manager DIALOG as well — a second list of the same plugins
 * with its own rows, badges and buttons — plus the install doors living only
 * inside it. Two surfaces answering "what plugins do I have" always drift, so
 * the dialog is deleted and everything it could do happens here: install from
 * the header's +, manage from a row's right-click.
 *
 * Everything shown reads from `RuntimePlugin`, already the app's one plugin
 * identity, so nothing here branches on built-in vs installed.
 */
export function PluginsPanel() {
  const plugins = usePlugins((s) => s.plugins);
  const docked = usePluginWindows((s) => s.docked);
  const running = docked ? plugins.find((p) => p.id === docked && p.enabled) : undefined;
  return running ? <RunningPlugin plugin={running} /> : <PluginBrowser plugins={plugins} />;
}

// ── Running ─────────────────────────────────────────────────────────────────

/**
 * A plugin filling the panel, under a header that is the way back. The plugin
 * gets everything below it — a panel is narrow enough already without a second
 * frame drawn inside the first.
 *
 * You get here by ASKING for it (right-click a plugin ▸ Run in this panel).
 * Clicking a plugin opens a window, which is where a plugin lives.
 */
function RunningPlugin({ plugin }: { plugin: RuntimePlugin }) {
  const undock = usePluginWindows((s) => s.undock);
  const open = usePluginWindows((s) => s.open);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b pl-1 pr-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Back to plugins"
              onClick={() => undock()}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4"
            >
              <ChevronLeft />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">All plugins</TooltipContent>
        </Tooltip>
        <PluginMark icon={plugin.icon} size="sm" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{plugin.name}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`${plugin.name} options`}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
            >
              <MoreHorizontal />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {/* Moving it to a window, not copying it — one plugin, one instance. */}
            <DropdownMenuItem onClick={() => open(plugin.id)}>
              <ExternalLink /> Open in a window
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => undock()}>
              <X /> Close
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="min-h-0 flex-1">
        <PluginBody plugin={plugin} onClose={() => undock()} />
      </div>
    </div>
  );
}

// ── Browsing ────────────────────────────────────────────────────────────────

function PluginBrowser({ plugins }: { plugins: RuntimePlugin[] }) {
  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();
  const matches = q
    ? plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q),
      )
    : plugins;

  // Grouped by the plugin's OWN category rather than by built-in vs installed:
  // which bundle something shipped in is our concern, not the user's — they are
  // looking for "the audio one".
  const groups = new Map<string, RuntimePlugin[]>();
  for (const p of matches) {
    const list = groups.get(p.category) ?? [];
    list.push(p);
    groups.set(p.category, list);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b p-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins…"
            className="h-(--control-h) pl-7"
            spellCheck={false}
          />
        </div>
        <PluginInstallMenu />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-1.5">
          {matches.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">Nothing matches.</p>
          ) : (
            [...groups].map(([category, list]) => (
              <section key={category}>
                {/* One group needs no label. A lone "AUDIO" over the only two
                    rows in the list is furniture — it names a distinction that
                    isn't being drawn yet. */}
                {groups.size > 1 && <h3 className="label-section px-2 pb-1 pt-0.5">{category}</h3>}
                {list.map((p) => (
                  <PluginCard key={p.id} plugin={p} />
                ))}
              </section>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * One plugin as a row: mark, name, one line of what it does.
 *
 * Both text lines truncate to exactly one line, which is the point — the rows
 * used to be a mark beside a two-line clamped paragraph and an author line, so
 * every row was a different height, no two names started at the same y, and the
 * description arrived cut mid-word ("…templates, live styling, always in").
 * A list you cannot scan down is a list you read one item at a time. The full
 * text, the author and the version live in the tooltip, where length is free.
 *
 * The whole row runs the plugin — a row where only a small "Open" hits is a
 * target hunt — and the enable switch deliberately does not, since turning a
 * plugin off should never also launch it. Everything else it can do (window it,
 * reload it, remove it) is on the right-click, where a secondary action belongs
 * and where it costs the row no width.
 */
function PluginCard({ plugin }: { plugin: RuntimePlugin }) {
  const disabled = !plugin.enabled;
  const isFolder = plugin.source?.kind === "folder";
  const watching = isFolder && hasDevHandle(plugin.id);
  // Clicking a plugin OPENS it — in a window, which is where a plugin lives.
  // Running it inside this panel is the secondary choice on the right-click:
  // real, but not what you meant by clicking the row.
  const open = () => !disabled && usePluginWindows.getState().open(plugin.id);

  const onReload = async () => {
    const res = await reloadFromFolder(plugin.id);
    if (res) toast.success(`Reloaded \u201C${res.name}\u201D`);
  };

  const onRemove = async () => {
    usePluginWindows.getState().close(plugin.id);
    forgetDevHandle(plugin.id);
    await usePlugins.getState().remove(plugin.id);
    toast.success(`Removed \u201C${plugin.name}\u201D`);
  };

  const onToggle = async (enabled: boolean) => {
    if (!enabled) usePluginWindows.getState().close(plugin.id);
    await usePlugins.getState().setEnabled(plugin.id, enabled);
  };

  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <div
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-disabled={disabled}
              onClick={open}
              onKeyDown={(e) => {
                if (disabled) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  open();
                }
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                disabled ? "opacity-45" : "cursor-pointer hover:bg-accent",
              )}
            >
              <PluginMark icon={plugin.icon} />

              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium leading-tight text-foreground">{plugin.name}</div>
                <div className="truncate text-2xs leading-tight text-muted-foreground">{plugin.description}</div>
              </div>

              {watching && <Badge tone="live">Live</Badge>}
              {isFolder && !watching && <Badge tone="warn">Reconnect</Badge>}

              {/* Built-ins have nothing to disable — they are part of the app. */}
              {!plugin.builtin && (
                <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                  <Switch
                    checked={plugin.enabled}
                    onCheckedChange={(v) => void onToggle(v)}
                    aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                  />
                </div>
              )}
            </div>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="right" className="max-w-56">
          <p className="font-medium">{plugin.name}</p>
          <p className="text-muted-foreground">{plugin.description}</p>
          {(plugin.author || plugin.version) && (
            <p className="text-muted-foreground/70">
              {[plugin.author, plugin.version && `v${plugin.version}`].filter(Boolean).join(" \u00B7 ")}
            </p>
          )}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent className="w-48">
        <ContextMenuItem disabled={disabled} onClick={open}>
          <ExternalLink /> Open in a window
        </ContextMenuItem>
        <ContextMenuItem disabled={disabled} onClick={() => usePluginWindows.getState().dock(plugin.id)}>
          <PanelLeft /> Run in this panel
        </ContextMenuItem>
        {watching && (
          <ContextMenuItem onClick={() => void onReload()}>
            <RefreshCw /> Reload from folder
          </ContextMenuItem>
        )}
        {!plugin.builtin && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem className="text-destructive focus:text-destructive" onClick={() => void onRemove()}>
              <Trash2 /> Remove
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A dev-folder's live state. The only badge that survived: "Built-in" and a
 *  version string label every row with something the reader already assumes. */
function Badge({ children, tone }: { children: React.ReactNode; tone: "live" | "warn" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-3xs font-medium uppercase",
        tone === "live" ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500",
      )}
    >
      {children}
    </span>
  );
}
