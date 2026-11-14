"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FilePlus2,
  FileCode2,
  Folder,
  FolderPlus,
  Frame,
  MoreHorizontal,
  PanelLeft,
  Play,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import {
  createId,
  deleteScriptFolder,
  saveScript,
  scriptHere,
  scriptPath,
  uniqueScriptName,
  type MotionDocument,
  type Script,
  type ScriptFolder,
  type ScriptRunMode,
} from "@solomotion/core";
import { Button } from "@/components/ui/button";
import { RenameInput } from "@/components/ui/rename-input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getDocStore, useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { agentApi } from "../agent/runner";
import CodeEditor from "./CodeEditor";
import type { CompletionDeps } from "./completions";
import { exposeToDevtools, panelRunContext, runReport, scriptHost } from "./host";
import { RunEntry } from "./RunOutput";
import { copyWithStatus } from "../console/console-report";
import { BriefDialog } from "./BriefDialog";
import { useScripts, type RunRecord } from "./store";
import { newScriptFromLayers } from "./code-bridge";

/**
 * THE SCRIPTS PANEL — Blender's text editor and Python console, for the web.
 *
 * Files on the left (the project's own, saved with it), the open file in the
 * middle, and one output stream below that both the file runs and the console
 * prompt write into, the way DevTools interleaves them. Every control is
 * reachable by keyboard (⌘↵ run, ⇧⌘↵ run and keep, ↑↓ console history) and
 * big enough for a finger.
 *
 * The panel is a lazy chunk (CodeMirror rides in it), and closing it frees the
 * script worker — memory a script took comes back when you close the window.
 */

const STARTER = `// ⌘↵ runs this file. Running again replaces what the last run made.
const words = ["Make", "it", "move"];

for (const [i, word] of words.entries()) {
  const { id } = await ac.layer.create({ kind: "text", text: word, y: (i - 1) * 140 });
  await ac.animation.set({ id, slot: "in", preset: "fade-up", delayMs: i * 120 });
}
`;

const deps: CompletionDeps = { registry: agentApi, doc: () => getDocStore()?.getState() ?? null, focus: () => useSession.getState().activeFrameId };

function copy(text: string, what: string) {
  void copyWithStatus(text, what.toLowerCase());
}

/** What a run did, as a model reads it. */
function resultForAi(run: RunRecord): string {
  return ["```json", JSON.stringify(runReport(run), null, 2), "```"].join("\n");
}

/** The error as a person pastes it: what, where, and the API's fix. */
function errorText(run: RunRecord): string {
  const e = run.error!;
  return `${e.name}: ${e.message}${e.line ? ` (${run.path}:${e.line})` : ""}${e.hint ? `\n→ ${e.hint}` : ""}`;
}

/** A run as a chatbox reads it: the code, then what happened. */
function runForAi(run: RunRecord, source: string): string {
  return [`Ran \`${run.path}\` in ${identity.name}:`, "```js", source, "```", "Result:", resultForAi(run)].join("\n");
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export default function ScriptsPanel() {
  const store = useDocStore();
  const doc = useDoc();
  const openId = useScripts((s) => s.openId);
  const setOpen = useScripts((s) => s.setOpen);
  const running = useScripts((s) => s.running);
  const root = React.useRef<HTMLDivElement>(null);
  const wide = useWidth(root) >= 560;
  const [explorer, setExplorer] = React.useState<boolean | null>(null);
  const showExplorer = explorer ?? wide;
  const [jump, setJump] = React.useState<{ line: number; n: number } | null>(null);

  const script = doc.scripts.find((s) => s.id === openId) ?? doc.scripts[0] ?? null;
  const path = script ? scriptPath(doc, script) : "";
  const lastRun = useScripts((s) => (script ? s.entries.findLast((e) => e.scriptId === script.id) : undefined));
  const [errorSeen, setErrorSeen] = React.useState<string | null>(null);
  const error = lastRun?.error?.line && lastRun.id !== errorSeen ? { line: lastRun.error.line, message: lastRun.error.message } : null;

  React.useEffect(() => {
    exposeToDevtools(agentApi, getDocStore);
    return () => scriptHost(agentApi).release();
  }, []);

  const setSource = (text: string) => {
    if (!script || text === script.source) return;
    setErrorSeen(lastRun?.id ?? null);
    store.update(`Edit ${script.name}`, (d) => {
      const s = d.scripts.find((x) => x.id === script.id);
      if (s) s.source = text;
    }, { mergeKey: `script-text:${script.id}`, mergeWindowMs: 4000 });
  };

  const run = (mode?: ScriptRunMode) => {
    if (!script || running) return;
    void scriptHost(agentApi).run({ code: script.source, path, repl: false, scriptId: script.id, mode, ctx: panelRunContext(store, path) });
  };

  const newFile = (folderId: string | null = script?.folderId ?? null) => {
    let id = "";
    store.update("New script", (d) => {
      const name = uniqueScriptName(d, folderId, "untitled.js");
      const folder = folderId ? d.scriptFolders.find((f) => f.id === folderId) : null;
      const s = saveScript(d, folder ? `${folderPathOf(d, folder)}/${name}` : name, d.scripts.length ? "" : STARTER);
      id = s.id;
    });
    setOpen(id);
    setRenaming(id);
  };

  const newFolder = () => {
    const id = createId("sfold");
    store.update("New folder", (d) => {
      const taken = new Set(d.scriptFolders.filter((f) => !f.parentId).map((f) => f.name));
      let name = "folder";
      for (let n = 2; taken.has(name); n++) name = `folder ${n}`;
      d.scriptFolders.push({ id, name, parentId: null });
    });
    setRenaming(id);
  };

  const [renaming, setRenaming] = React.useState<string | null>(null);

  const [briefOpen, setBriefOpen] = React.useState(false);
  const brief = () => setBriefOpen(true);
  const setMode = (mode: ScriptRunMode) =>
    script &&
    script.onRun !== mode &&
    store.update(mode === "replace" ? "Re-run replaces" : "Re-run appends", (d) => {
      const s = d.scripts.find((x) => x.id === script.id);
      if (s) s.onRun = mode;
    });

  // An empty tree beside an empty state says "nothing" twice.
  const explorerEl = showExplorer && doc.scripts.length > 0 && (
    <Explorer
      doc={doc}
      openId={script?.id ?? null}
      renaming={renaming}
      onRenamed={() => setRenaming(null)}
      onRename={setRenaming}
      onOpen={(id) => {
        setOpen(id);
        if (!wide) setExplorer(false);
      }}
      onNewFile={newFile}
      onNewFolder={newFolder}
      overlay={!wide}
    />
  );

  return (
    <div ref={root} className="relative flex h-full min-h-0 flex-col bg-background text-sm">
      {/* Toolbar */}
      {/* Toolbar — with no file there is nothing to browse or run, so it holds
          only the menu; the empty state below is the one place to start. */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-1.5">
        {script ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Files"
              title="Files"
              aria-pressed={showExplorer}
              className={cn("[@media(pointer:coarse)]:size-9", showExplorer && "text-foreground")}
              onClick={() => setExplorer(!showExplorer)}
            >
              <PanelLeft className="size-4" />
            </Button>
            <span className="min-w-0 truncate px-1 font-mono text-xs text-muted-foreground" title={path}>
              {path}
            </span>
          </>
        ) : (
          <span className="px-1.5 text-xs font-medium text-muted-foreground">Scripts</span>
        )}
        <span className="flex-1" />
        {script && (
          <Button variant="ghost" size="icon-sm" aria-label="Brief for AI" title="Brief for AI — what a chatbot needs to write a script" className="[@media(pointer:coarse)]:size-9" onClick={brief}>
            <Sparkles className="size-4" />
          </Button>
        )}
        <MoreMenu
          script={script}
          onNewFile={() => newFile()}
          onNewFolder={newFolder}
          onRename={() => script && setRenaming(script.id)}
          onDelete={() => {
            if (!script) return;
            store.update(`Delete ${script.name}`, (d) => {
              d.scripts = d.scripts.filter((s) => s.id !== script.id);
            });
          }}
        />
        {script && <HereChip />}
        {script && <RunButton script={script} running={!!running} onRun={() => run()} onStop={() => scriptHost(agentApi).stop()} onKeep={() => run("append")} onMode={setMode} />}
      </div>
      <BriefDialog open={briefOpen} onOpenChange={setBriefOpen} script={script} lastRun={lastRun && lastRun.status !== "running" && lastRun.status !== "queued" ? resultForAi(lastRun) : undefined} />

      <ResizablePanelGroup direction="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={62} minSize={20}>
          <div className="relative flex h-full min-h-0">
            {explorerEl}
            {!wide && showExplorer && <button type="button" aria-label="Close files" className="absolute inset-0 z-10 bg-black/30" onClick={() => setExplorer(false)} />}
            <div className="relative min-w-0 flex-1">
              {script ? (
                <CodeEditor
                  key={script.id}
                  mode="file"
                  value={script.source}
                  onChange={setSource}
                  onRun={() => run()}
                  onRunAlt={() => run("append")}
                  error={error}
                  jumpTo={jump}
                  deps={deps}
                  className="absolute inset-0 overflow-hidden"
                />
              ) : (
                <EmptyState onNew={() => newFile(null)} onBrief={brief} />
              )}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={38} minSize={12}>
          <Output onJump={(line) => setJump({ line, n: Date.now() })} sourceOf={(r) => (r.scriptId ? (doc.scripts.find((s) => s.id === r.scriptId)?.source ?? r.code) : r.code)} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function folderPathOf(doc: Pick<MotionDocument, "scriptFolders">, folder: ScriptFolder): string {
  return scriptPath(doc, { name: folder.name, folderId: folder.parentId });
}

function EmptyState({ onNew, onBrief }: { onNew: () => void; onBrief: () => void }) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-4">
      <div className="flex w-full max-w-60 flex-col items-center text-center">
        <div className="material-chip mb-3 grid size-9 place-items-center rounded-lg">
          <FileCode2 className="size-4 text-muted-foreground" />
        </div>
        <p className="text-[13px] font-medium text-foreground">Script your scene</p>
        <p className="mt-1 text-xs text-muted-foreground">Layers and motion, written as code.</p>
        <div className="mt-4 flex w-full flex-col gap-1.5">
          <Button size="sm" className="w-full" onClick={onNew}>
            <FilePlus2 className="size-3.5" />
            New script
          </Button>
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={onBrief}>
            <Sparkles className="size-3.5" />
            Brief for AI
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Explorer ─────────────────────────────────────────────────────────────────

interface ExplorerProps {
  doc: MotionDocument;
  openId: string | null;
  renaming: string | null;
  onRename: (id: string) => void;
  onRenamed: () => void;
  onOpen: (id: string) => void;
  onNewFile: (folderId: string | null) => void;
  onNewFolder: () => void;
  overlay: boolean;
}

function Explorer(props: ExplorerProps) {
  const { doc } = props;
  const [closed, setClosed] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setClosed((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  const rows: React.ReactNode[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const f of doc.scriptFolders.filter((x) => x.parentId === parentId).sort(byName)) {
      rows.push(<FolderRow key={f.id} folder={f} depth={depth} open={!closed.has(f.id)} onToggle={() => toggle(f.id)} {...props} />);
      if (!closed.has(f.id)) walk(f.id, depth + 1);
    }
    for (const s of doc.scripts.filter((x) => x.folderId === parentId).sort(byName)) {
      rows.push(<FileRow key={s.id} script={s} depth={depth} {...props} />);
    }
  };
  walk(null, 0);

  return (
    <div className={cn("flex w-52 shrink-0 flex-col border-r border-border bg-background", props.overlay && "absolute inset-y-0 left-0 z-20 w-60 shadow-xl")}>
      <div className="flex h-9 shrink-0 items-center gap-0.5 px-2">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Files</span>
        <Button variant="ghost" size="icon-sm" aria-label="New script" title="New script" className="[@media(pointer:coarse)]:size-9" onClick={() => props.onNewFile(null)}>
          <FilePlus2 className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="New folder" title="New folder" className="[@media(pointer:coarse)]:size-9" onClick={props.onNewFolder}>
          <FolderPlus className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2" role="tree" aria-label="Scripts">
        {rows}
      </div>
    </div>
  );
}

function byName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

const ROW = "flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] [@media(pointer:coarse)]:h-9";

function FolderRow({ folder, depth, open, onToggle, renaming, onRenamed, onRename, onNewFile }: ExplorerProps & { folder: ScriptFolder; depth: number; open: boolean; onToggle: () => void }) {
  const store = useDocStore();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="px-1.5">
          {renaming === folder.id ? (
            <RenameInput
              initial={folder.name}
              className="h-7 w-full rounded-md border border-ring bg-background px-2 text-[12.5px]"
              onCommit={(name) => {
                onRenamed();
                const clean = name.trim().replace(/\//g, "-");
                if (clean && clean !== folder.name)
                  store.update("Rename folder", (d) => {
                    const f = d.scriptFolders.find((x) => x.id === folder.id);
                    if (f) f.name = clean;
                  });
              }}
            />
          ) : (
            <button type="button" role="treeitem" aria-expanded={open} className={cn(ROW, "text-muted-foreground hover:bg-accent hover:text-foreground")} style={{ paddingLeft: 6 + depth * 12 }} onClick={onToggle} onDoubleClick={() => onRename(folder.id)}>
              <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate">{folder.name}</span>
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onNewFile(folder.id)}>New script here</ContextMenuItem>
        <ContextMenuItem onSelect={() => onRename(folder.id)}>Rename</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => store.update(`Delete ${folder.name}`, (d) => deleteScriptFolder(d, folder.id))}>
          Delete folder
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FileRow({ script, depth, openId, onOpen, renaming, onRenamed, onRename }: ExplorerProps & { script: Script; depth: number }) {
  const store = useDocStore();
  const active = script.id === openId;
  const remove = () =>
    store.update(`Delete ${script.name}`, (d) => {
      d.scripts = d.scripts.filter((s) => s.id !== script.id);
    });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="px-1.5">
          {renaming === script.id ? (
            <RenameInput
              initial={script.name}
              className="h-7 w-full rounded-md border border-ring bg-background px-2 font-mono text-[12px]"
              onCommit={(name) => {
                onRenamed();
                if (!name.trim()) return;
                store.update("Rename script", (d) => {
                  const s = d.scripts.find((x) => x.id === script.id);
                  if (s) s.name = uniqueScriptName(d, s.folderId, name, s.id);
                });
              }}
            />
          ) : (
            <button
              type="button"
              role="treeitem"
              aria-selected={active}
              className={cn(ROW, "font-mono text-[12px]", active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
              style={{ paddingLeft: 21 + depth * 12 }}
              onClick={() => onOpen(script.id)}
              onDoubleClick={() => onRename(script.id)}
              onKeyDown={(e) => {
                if (e.key === "F2" || (e.key === "Enter" && e.altKey)) onRename(script.id);
                if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) remove();
              }}
            >
              <span className="truncate">{script.name}</span>
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onRename(script.id)}>Rename</ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            let id = "";
            store.update(`Duplicate ${script.name}`, (d) => {
              const copy: Script = { ...script, id: createId("script"), name: uniqueScriptName(d, script.folderId, script.name), output: { clipIds: [], frameIds: [] } };
              d.scripts.push(copy);
              id = copy.id;
            });
            onOpen(id);
          }}
        >
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(script.source, "Script")}>Copy source</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={remove}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ── Toolbar menu ─────────────────────────────────────────────────────────────

/**
 * Where Run will land — the comp you're on, named before you press it, so a
 * script built for the intro never surprises you by appearing in the outro.
 * Clicking it shows that comp on the canvas.
 */
function HereChip() {
  const doc = useDoc();
  const focused = useSession((s) => s.activeFrameId);
  const here = scriptHere(doc, focused);
  if (!here) return null;
  return (
    <button
      type="button"
      onClick={() => useSession.getState().revealFrame(here.frameId)}
      title={`Runs in “${here.name}” — the comp you're on. A frameId in the script targets another.`}
      className="flex h-7 min-w-0 max-w-36 shrink items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground [@media(pointer:coarse)]:h-9"
    >
      <Frame className="size-3.5 shrink-0" />
      <span className="truncate">{here.name}</span>
    </button>
  );
}

/**
 * Run, with the re-run policy one click away in its own menu — the split
 * button every IDE uses. Fixed widths, so Run ↔ Stop and a mode change never
 * move anything in the toolbar.
 */
function RunButton({ script, running, onRun, onStop, onKeep, onMode }: { script: Script; running: boolean; onRun: () => void; onStop: () => void; onKeep: () => void; onMode: (mode: ScriptRunMode) => void }) {
  const seg = "flex items-center justify-center text-xs font-medium transition-[filter,background-color] disabled:opacity-50";
  const tone = running ? "bg-secondary text-secondary-foreground hover:bg-accent" : "bg-primary text-primary-foreground hover:brightness-110";
  return (
    <div className="ml-0.5 flex h-7 shrink-0 overflow-hidden rounded-md shadow-[0_1px_2px_rgb(0_0_0/0.3)] [@media(pointer:coarse)]:h-9">
      <button
        type="button"
        onClick={running ? onStop : onRun}
        title={running ? "Stop" : script.onRun === "append" ? "Run — adds to what it made (⌘↵)" : "Run — replaces what it made (⌘↵)"}
        className={cn(seg, tone, "w-[4.25rem] gap-1.5")}
      >
        {running ? <Square className="size-3 fill-current" /> : <Play className="size-3 fill-current" />}
        {running ? "Stop" : "Run"}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={running} aria-label="Run options" className={cn(seg, tone, "w-6 border-l border-black/25 [@media(pointer:coarse)]:w-8")}>
            <ChevronDown className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">When run again</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={script.onRun} onValueChange={(v) => onMode(v as ScriptRunMode)}>
            <DropdownMenuRadioItem value="replace">Replace what it made</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="append">Add to it</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onKeep}>
            Run once, keep the last output
            <DropdownMenuShortcut>⇧⌘↵</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The selection as a script that OWNS it (core reify): its first Run replaces
 * the selected layers with the code's rebuild, so the file edits them in place.
 */
function NewFromSelectionItem() {
  const store = useDocStore();
  const ids = useSession((s) => s.selectedClipIds);
  const doc = useDoc();
  const single = ids.length === 1 ? doc.tracks.flatMap((t) => t.clips).find((c) => c.id === ids[0]) : undefined;
  return (
    <DropdownMenuItem disabled={!ids.length} onSelect={() => void newScriptFromLayers(store, ids, single?.name ?? "selection")}>
      <FileCode2 /> New script from selection
    </DropdownMenuItem>
  );
}

function MoreMenu(props: {
  script: Script | null;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { script } = props;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="More" className="[@media(pointer:coarse)]:size-9">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={props.onNewFile}>
          <FilePlus2 /> New script
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={props.onNewFolder}>
          <FolderPlus /> New folder
        </DropdownMenuItem>
        <NewFromSelectionItem />
        {script && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => copy(script.source, "Script")}>
              <Copy /> Copy source
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={props.onRename}>Rename</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={props.onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Output + console ─────────────────────────────────────────────────────────

function Output({ onJump, sourceOf }: { onJump: (line: number) => void; sourceOf: (r: RunRecord) => string }) {
  const store = useDocStore();
  const entries = useScripts((s) => s.entries);
  const running = useScripts((s) => s.running);
  const history = useScripts((s) => s.history);
  const [line, setLine] = React.useState("");
  const scroller = React.useRef<HTMLDivElement>(null);
  const stick = React.useRef(true);

  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const submit = () => {
    const code = line.trim();
    if (!code || running) return;
    useScripts.getState().remember(code);
    setLine("");
    stick.current = true;
    void scriptHost(agentApi).run({ code, path: "console", repl: true, ctx: panelRunContext(store, "console") });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-3">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Output</span>
        <Button variant="ghost" size="icon-sm" aria-label="Clear output" title="Clear output" className="[@media(pointer:coarse)]:size-9" onClick={() => useScripts.getState().clear()}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 cursor-text select-text overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {entries.map((r) => (
          <RunEntry key={r.id} run={r} onJump={onJump} onStop={(id) => scriptHost(agentApi).stopRun(id, "person")} copyAs={{ run: (run) => runForAi(run, sourceOf(run)), error: errorText }} />
        ))}
      </div>
      <div className="flex shrink-0 items-start gap-2 border-t border-border/60 px-3 py-1">
        <span className="select-none pt-[9px] font-mono text-[12px] leading-none text-primary">›</span>
        <CodeEditor
          mode="prompt"
          value={line}
          onChange={setLine}
          onRun={submit}
          history={history}
          deps={deps}
          placeholder="ac.doc.overview()"
          className="max-h-32 min-w-0 flex-1 overflow-auto"
        />
      </div>
    </div>
  );
}
