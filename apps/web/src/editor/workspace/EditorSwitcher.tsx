"use client";

import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTypeToFocus } from "../input/use-type-to-focus";
import { editorIcon } from "../panels/panel-registry";
import { EDITOR_GROUPS, editorsByGroup, filterEditors, type EditorId, type EditorMeta } from "./editor-registry";
import styles from "./workspace.module.css";

/**
 * THE EDITOR SWITCHER — Blender's editor-type menu, designed like a pro tool's
 * menu rather than a dropdown: the editors in COLUMNS by group (Design ·
 * Motion · Color & FX · Sound · Assets · Extend), icon + name + shortcut, the
 * current one marked with the selection tint.
 *
 * Type to filter. `useTypeToFocus` puts the first keystroke into the filter
 * without ever focusing it on open, so a tablet never throws up a soft
 * keyboard over the menu you opened with a finger. Arrows walk the visible
 * list, Enter picks.
 */
export function EditorSwitcher({
  current,
  onPick,
  children,
  align = "start",
}: {
  current: EditorId;
  onPick: (editor: EditorId) => void;
  children: React.ReactNode;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-auto p-2" onOpenAutoFocus={(e) => e.preventDefault()}>
        {open && (
          <SwitcherBody
            current={current}
            onPick={(id) => {
              setOpen(false);
              onPick(id);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function SwitcherBody({ current, onPick }: { current: EditorId; onPick: (id: EditorId) => void }) {
  const [query, setQuery] = React.useState("");
  const [hi, setHi] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  useTypeToFocus(inputRef);

  const filtered = React.useMemo(() => filterEditors(query).filter((e) => e.id !== "stage" || current === "stage"), [query, current]);
  const groups = React.useMemo(() => {
    if (query) return [{ group: "results", name: "", editors: filtered }];
    return editorsByGroup().map((g) => ({ ...g, editors: g.editors.filter((e) => filtered.includes(e)) })).filter((g) => g.editors.length);
  }, [query, filtered]);
  const flat = groups.flatMap((g) => g.editors);

  React.useEffect(() => setHi(0), [query]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      setHi((h) => Math.min(flat.length - 1, h + 1));
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      const pick = flat[hi];
      if (pick) {
        e.preventDefault();
        onPick(pick.id as EditorId);
      }
    }
  };

  return (
    <div onKeyDown={onKey} className="flex flex-col gap-1">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Editor"
        aria-label="Filter editors"
        // Present but quiet: it fills from type-to-focus, and a tap focuses it
        // deliberately (that is the one time a tablet keyboard is wanted).
        className="h-7 w-full rounded-md bg-transparent px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:bg-accent"
      />
      {flat.length === 0 ? (
        <div className="px-2 py-3 text-xs text-muted-foreground">No editor matches</div>
      ) : (
        <div className={styles.switcher} style={{ ["--cols" as string]: query ? 1 : Math.min(3, groups.length) }} role="menu">
          {(query ? [groups as Group[]] : columnise(groups as Group[])).map((col, ci) => (
            <div key={ci} className="flex flex-col">
              {col.map((g) => (
                <div key={g.group} className="flex flex-col">
                  {g.name && <div className={styles.switcherHeading}>{g.name}</div>}
                  {g.editors.map((e) => (
                    <Item key={e.id} meta={e} current={e.id === current} highlight={flat[hi]?.id === e.id} onPick={onPick} />
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Group = { group: string; name: string; editors: EditorMeta[] };

/** Six groups into three columns, pairing neighbours (Design+Motion, …). */
function columnise(groups: Group[]): Group[][] {
  if (groups.length <= 3) return groups.map((g) => [g]);
  const cols: Group[][] = [[], [], []];
  groups.forEach((g, i) => cols[Math.min(2, Math.floor((i * 3) / groups.length))]!.push(g));
  return cols.filter((c) => c.length);
}

function Item({ meta, current, highlight, onPick }: { meta: EditorMeta; current: boolean; highlight: boolean; onPick: (id: EditorId) => void }) {
  const Icon = editorIcon(meta.id as EditorId);
  return (
    <button
      type="button"
      role="menuitem"
      className={styles.switcherItem}
      data-current={current || undefined}
      data-highlight={highlight || undefined}
      title={meta.hint}
      onClick={() => onPick(meta.id as EditorId)}
    >
      <Icon />
      <span className="truncate">{meta.name}</span>
      {meta.shortcut && <span className={styles.switcherShortcut}>{meta.shortcut}</span>}
    </button>
  );
}

export { EDITOR_GROUPS };
