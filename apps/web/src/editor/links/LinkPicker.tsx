"use client";

import * as React from "react";
import { Globe, Mail, Phone, Route as RouteIcon } from "lucide-react";
import { docIndex, parseLinkTarget, searchDocNodes, type DocNode, type DocNodeKind, type LinkTarget, type PickFilter } from "@solomotion/core";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { useAppShell } from "../state/app-shell";
import { linkParseContext } from "./navigate";
import { PickGlyph, docNodeGlyph } from "../pick/PickGlyph";
import { AimButton } from "../pick/ObjectField";
import { beginPickDrag, enterPick, exitPick, usePickMode, type PickRequest } from "../pick/pick-mode";
import { usePlugins } from "../plugins/plugins-store";
import { PluginMark } from "../plugins/PluginIcon";

/**
 * THE LINK TARGET PICKER — paste anything, or search the project.
 *
 * Paste a URL, an email or a phone number and it is the first row; paste this
 * app's own deep link and it becomes the place it points at. Type a few
 * letters and it searches core's document index — the one ⌘P and every node
 * field run — plus the plugins. Keyboard first: ↑↓, ↵.
 */

const GROUPS: Array<{ heading: string; kinds: DocNodeKind[]; cap: number; onlyWhenTyping?: boolean }> = [
  { heading: "Frames", kinds: ["frame", "world", "component"], cap: 8 },
  { heading: "Pages", kinds: ["page"], cap: 6 },
  { heading: "Nested comps", kinds: ["comp"], cap: 5, onlyWhenTyping: true },
  { heading: "Layers", kinds: ["layer"], cap: 10, onlyWhenTyping: true },
];

const LINK_PICK: PickFilter = { kinds: ["layer", "frame"] };

function hrefIcon(href: string) {
  if (href.startsWith("mailto:")) return Mail;
  if (href.startsWith("tel:")) return Phone;
  return Globe;
}

export function LinkPicker({ onPick, autoFocus = true }: { onPick: (target: LinkTarget) => void; autoFocus?: boolean }) {
  const doc = useDoc();
  const [search, setSearch] = React.useState("");
  const projectId = useAppShell((s) => (s.view === "editor" ? s.currentProjectId : null));
  const activePage = useSession((s) => s.activePageId) ?? doc.pages[0]?.id;
  const plugins = usePlugins((s) => s.plugins);
  const q = search.trim();

  // What was pasted, read by the one target parser (this app's own deep link
  // becomes the place it names; a node key typed by hand works too).
  const pasted = React.useMemo(
    () => (q ? parseLinkTarget(q, linkParseContext(projectId)) : null),
    [q, projectId],
  );
  const typed = pasted && pasted.kind !== "node" ? pasted : null;
  const typedNode = pasted?.kind === "node" ? pasted : null;

  const index = React.useMemo(() => docIndex(doc).filter((n) => !n.tags.includes("internal") || n.kind === "comp"), [doc]);
  const groups = React.useMemo(
    () =>
      GROUPS.map((g) => {
        let rows: DocNode[] = index.filter((n) => g.kinds.includes(n.kind));
        if (q) rows = searchDocNodes(rows, q);
        else if (g.onlyWhenTyping) rows = [];
        else if (g.kinds.includes("frame")) rows = rows.filter((n) => n.pageId === activePage);
        return { ...g, rows: rows.slice(0, g.cap) };
      }).filter((g) => g.rows.length > 0),
    [index, q, activePage],
  );
  const pluginRows = React.useMemo(() => {
    if (!q) return [];
    const lq = q.toLowerCase();
    return plugins.filter((p) => p.enabled && (p.name.toLowerCase().includes(lq) || p.id.toLowerCase().includes(lq))).slice(0, 5);
  }, [plugins, q]);

  // Or point at the place itself: any layer or frame, on any surface.
  const owner = React.useId();
  const armed = usePickMode((s) => s.request?.owner === owner);
  const aim = (): PickRequest => ({ owner, filter: LINK_PICK, onPick: (c) => onPick({ kind: "node", node: c.key, t: null }) });

  const TypedIcon = typed?.kind === "url" ? hrefIcon(typed.href) : RouteIcon;
  return (
    <Command shouldFilter={false} loop>
      <div className="relative">
        <CommandInput autoFocus={autoFocus} value={search} onValueChange={setSearch} placeholder="Paste a link or search the project…" className="pr-8" />
        <AimButton
          armed={armed}
          label="Pick a layer or frame"
          className="absolute right-1.5 top-1/2 -translate-y-1/2"
          onPress={(e) => (armed ? exitPick("cancel") : beginPickDrag(e, aim()))}
          onKeyboard={() => (armed ? exitPick("cancel") : enterPick(aim()))}
        />
      </div>
      <CommandList className="max-h-80">
        <CommandEmpty>{q ? "No match — paste a web address to link out." : "Nothing to link to yet."}</CommandEmpty>
        {(typed || typedNode) && (
          <CommandGroup>
            <CommandItem value="typed" onSelect={() => onPick((typed ?? typedNode)!)} className="gap-2">
              <TypedIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[12px]">
                {typed?.kind === "url" ? typed.href.replace(/^(https?:\/\/|mailto:|tel:)/, "") : typed?.kind === "route" ? typed.path : q}
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground">↵ Link</span>
            </CommandItem>
          </CommandGroup>
        )}
        {groups.map((g) => (
          <CommandGroup key={g.heading} heading={g.heading}>
            {g.rows.map((n) => (
              <CommandItem key={n.key} value={n.key} onSelect={() => onPick({ kind: "node", node: n.key, t: null })} className="gap-2">
                <PickGlyph candidate={docNodeGlyph(n)} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[12px]">{n.name}</span>
                <span className="max-w-[40%] shrink-0 truncate text-2xs text-muted-foreground">{n.kind === "page" ? "" : n.where}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        {pluginRows.length > 0 && (
          <CommandGroup heading="Plugins">
            {pluginRows.map((p) => (
              <CommandItem key={p.id} value={`plugin:${p.id}`} onSelect={() => onPick({ kind: "route", path: `/plugin/${encodeURIComponent(p.id)}` })} className="gap-2">
                <PluginMark icon={p.icon} size="sm" />
                <span className="min-w-0 flex-1 truncate text-[12px]">{p.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
}
