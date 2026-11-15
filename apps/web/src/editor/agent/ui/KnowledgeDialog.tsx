"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import { BookOpen, ClipboardPaste, FileUp, Github, Loader2, Palette, Trash2 } from "lucide-react";
import { clusterFeedback, fetchGithubPack, packFromFiles, type KnowledgePack, type PackKind } from "@solomotion/agent";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useAgent } from "../store";
import { allPacks } from "../runner";

/**
 * WHAT THE AGENT KNOWS — skills (how to work), design systems (what good looks
 * like here), the user's standing instructions, and the feedback it has filed.
 *
 * Packs come from anywhere a Markdown folder can: the app's own, a GitHub repo
 * (the same layout any Agent Skill uses), files dropped in, or text pasted.
 * Built-ins cannot be removed, only switched off — a user's own design system
 * should be able to replace ours without deleting it.
 */
export function KnowledgeDialog(props: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  // Controlled by a host that is not the Agents panel (the Scripts brief) —
  // otherwise by the agent store, so the two mounts never open together.
  const storeOpen = useAgent((s) => s.knowledgeOpen);
  const open = props.open ?? storeOpen;
  const onOpenChange = props.onOpenChange ?? ((v: boolean) => useAgent.getState().setKnowledgeOpen(v));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(680px,88vh)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <div className="shrink-0 px-5 pb-3 pt-4">
          <DialogTitle className="text-base">Knowledge</DialogTitle>
          <DialogDescription className="mt-1 text-xs">What the agent reads before it works.</DialogDescription>
        </div>
        <Tabs defaultValue="skill" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-5 w-auto self-start">
            <TabsTrigger value="skill">Skills</TabsTrigger>
            <TabsTrigger value="design-system">Design systems</TabsTrigger>
            <TabsTrigger value="instructions">Instructions</TabsTrigger>
            <TabsTrigger value="feedback">Reports</TabsTrigger>
          </TabsList>
          <TabsContent value="skill" className="min-h-0 flex-1">
            <PackTab kind="skill" />
          </TabsContent>
          <TabsContent value="design-system" className="min-h-0 flex-1">
            <PackTab kind="design-system" />
          </TabsContent>
          <TabsContent value="instructions" className="min-h-0 flex-1">
            <InstructionsTab />
          </TabsContent>
          <TabsContent value="feedback" className="min-h-0 flex-1">
            <FeedbackTab />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function PackTab({ kind }: { kind: PackKind }) {
  const stored = useAgent((s) => s.packs);
  const disabled = useAgent((s) => s.settings.disabledPacks);
  const packs = allPacks(stored, disabled).filter((p) => p.kind === kind);
  const [adding, setAdding] = React.useState<"github" | "paste" | null>(null);
  const Icon = kind === "skill" ? BookOpen : Palette;

  const toggle = (p: KnowledgePack, on: boolean) => {
    if (p.source.type === "builtin") {
      const next = on ? disabled.filter((id) => id !== p.id) : [...disabled, p.id];
      void useAgent.getState().setSettings({ disabledPacks: next });
    } else void useAgent.getState().savePack({ ...p, enabled: on });
  };

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 px-5 py-3">
          {packs.map((p) => (
            <div key={p.id} className="flex items-start gap-3 rounded-lg border bg-card/50 p-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  {p.version && <span className="text-2xs text-muted-foreground">v{p.version}</span>}
                  <span className="rounded bg-muted px-1.5 text-2xs text-muted-foreground">
                    {p.source.type === "builtin" ? "Built in" : p.source.type === "github" ? p.source.repo : p.source.type === "plugin" ? "Plugin" : "Yours"}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
                <p className="mt-1 text-2xs text-muted-foreground">{Object.keys(p.files).length} files</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {p.source.type !== "builtin" && (
                  <button
                    type="button"
                    aria-label={`Remove ${p.name}`}
                    onClick={() => void useAgent.getState().removePack(p.id)}
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
                <Switch checked={p.enabled} onCheckedChange={(on) => toggle(p, on)} aria-label={`Use ${p.name}`} />
              </div>
            </div>
          ))}
          {adding === "github" && <GithubForm kind={kind} onDone={() => setAdding(null)} />}
          {adding === "paste" && <PasteForm kind={kind} onDone={() => setAdding(null)} />}
        </div>
      </ScrollArea>
      <div className="flex shrink-0 flex-wrap gap-2 border-t px-5 py-3">
        <Button size="xs" variant="secondary" onClick={() => setAdding("github")}>
          <Github /> From GitHub
        </Button>
        <UploadButton kind={kind} />
        <Button size="xs" variant="secondary" onClick={() => setAdding("paste")}>
          <ClipboardPaste /> Paste
        </Button>
      </div>
    </div>
  );
}

function GithubForm({ kind, onDone }: { kind: PackKind; onDone: () => void }) {
  const [url, setUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const pack = await fetchGithubPack(kind, url.trim());
      await useAgent.getState().savePack(pack);
      toast.success(`Added ${pack.name}`);
      onDone();
    } catch (err) {
      toast.error("Could not add it", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="agent-rise flex gap-2 rounded-lg border border-dashed p-3">
      <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} placeholder="owner/repo or a folder URL" className="h-8 text-xs" />
      <Button size="sm" variant="primary" onClick={() => void submit()} disabled={!url.trim() || busy}>
        {busy ? <Loader2 className="animate-spin" /> : "Add"}
      </Button>
    </div>
  );
}

function PasteForm({ kind, onDone }: { kind: PackKind; onDone: () => void }) {
  const [name, setName] = React.useState("");
  const [text, setText] = React.useState("");
  const submit = async () => {
    const entry = kind === "skill" ? "SKILL.md" : "DESIGN.md";
    const body = text.startsWith("---") ? text : `---\nname: ${name || "My pack"}\n---\n${text}`;
    const pack = packFromFiles(kind, { [entry]: body }, { type: "local" }, name || "My pack");
    await useAgent.getState().savePack(pack);
    onDone();
  };
  return (
    <div className="agent-rise space-y-2 rounded-lg border border-dashed p-3">
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="h-8 text-xs" />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={kind === "skill" ? "How the agent should work — Markdown" : "Colours, type, spacing, motion rules — Markdown"}
        className="h-40 w-full resize-y rounded-md border bg-background/60 p-2 font-mono text-xs outline-none focus:border-primary/60"
      />
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="xs" variant="primary" onClick={() => void submit()} disabled={!text.trim()}>
          Add
        </Button>
      </div>
    </div>
  );
}

function UploadButton({ kind }: { kind: PackKind }) {
  const ref = React.useRef<HTMLInputElement>(null);
  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const files: Record<string, string> = {};
    for (const f of [...list]) {
      if (!/\.(md|mdx|txt|json|ya?ml|css)$/i.test(f.name)) continue;
      const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/").slice(1).join("/") || f.name;
      files[path] = await f.text();
    }
    if (!Object.keys(files).length) {
      toast.error("No Markdown in those files");
      return;
    }
    const pack = packFromFiles(kind, files, { type: "local" }, list[0]!.name.replace(/\.\w+$/, ""));
    await useAgent.getState().savePack(pack);
    toast.success(`Added ${pack.name}`);
  };
  return (
    <>
      <input ref={ref} type="file" multiple accept=".md,.mdx,.txt,.json,.yaml,.yml,.css" className="hidden" onChange={(e) => void onFiles(e.target.files)} />
      <Button size="xs" variant="secondary" onClick={() => ref.current?.click()}>
        <FileUp /> Upload
      </Button>
    </>
  );
}

function InstructionsTab() {
  const instructions = useAgent((s) => s.settings.instructions);
  const [text, setText] = React.useState(instructions);
  React.useEffect(() => setText(instructions), [instructions]);
  return (
    <div className="flex h-full flex-col gap-2 px-5 py-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void useAgent.getState().setSettings({ instructions: text })}
        placeholder={"Standing instructions for every chat. E.g.\n· Our brand font is Inter; headlines in 800.\n· Always export-safe: keep text inside 90% of the frame.\n· Reply in Persian."}
        className="min-h-0 flex-1 resize-none rounded-lg border bg-background/60 p-3 text-sm leading-relaxed outline-none focus:border-primary/60"
      />
      <p className="text-2xs text-muted-foreground">Saved when you click away. Applies to new messages.</p>
    </div>
  );
}

function FeedbackTab() {
  const events = useAgent((s) => s.feedback);
  const share = useAgent((s) => s.settings.shareFeedback);
  const clusters = React.useMemo(() => clusterFeedback(events), [events]);
  return (
    <div className="flex h-full flex-col">
      <label className="mx-5 my-3 flex items-center justify-between gap-3 rounded-lg border bg-card/50 px-3 py-2">
        <span>
          <span className="block text-xs font-medium">Share reports to improve {identity.name}</span>
          <span className="block text-2xs text-muted-foreground">What failed and why — never your project, files or keys.</span>
        </span>
        <Switch checked={share} onCheckedChange={(v) => void useAgent.getState().setSettings({ shareFeedback: v })} />
      </label>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1.5 px-5 pb-4">
          {clusters.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">Nothing reported yet.</p>}
          {clusters.map((c) => {
            const sample = c.samples[0]!;
            return (
              <details key={c.fingerprint} className="group rounded-lg border bg-card/40">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
                  <span
                    className={cn(
                      "flex h-5 min-w-5 items-center justify-center rounded px-1 text-2xs font-semibold tabular-nums",
                      c.maxSeverity >= 4 ? "bg-destructive/15 text-destructive" : c.maxSeverity >= 3 ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
                    )}
                    title="Severity"
                  >
                    {Math.round(c.maxSeverity)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">{c.title}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">×{c.count}</span>
                </summary>
                <div className="space-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
                  {sample.kind === "report" && (
                    <>
                      <p>
                        <span className="text-foreground">Tried:</span> {sample.tried}
                      </p>
                      <p>
                        <span className="text-foreground">Happened:</span> {sample.happened}
                      </p>
                      <p>
                        <span className="text-foreground">Expected:</span> {sample.expected}
                      </p>
                      {sample.suggestion && (
                        <p>
                          <span className="text-foreground">Fix:</span> {sample.suggestion}
                        </p>
                      )}
                      <p className="text-2xs">
                        {sample.category} · fault: {sample.fault}
                        {sample.command ? ` · ${sample.command}` : ""}
                      </p>
                    </>
                  )}
                  <p className="text-2xs">{Object.keys(c.models).join(", ")}</p>
                </div>
              </details>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
