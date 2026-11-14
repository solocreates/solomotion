"use client";

import * as React from "react";
import { create } from "zustand";
import { analyzeAudio, captureLibrarySnapshot, landingFrameId, type LibraryKind } from "@solomotion/core";
import { Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { PeaksWave } from "./PeaksWave";
import { setPublisher, usePublisher } from "./publisher-identity";
import { bundleProject, extOf, sendToLibrary, slug, type Poster } from "./publish";

/**
 * PUBLISH — the form, and the analysis that makes the form short.
 *
 * The editor does the measuring. It decodes the file it is about to publish and
 * runs the SAME `analyzeAudio` the build script runs, so duration, the hit
 * point and the waveform are already known before anything leaves this dialog —
 * which is why the form asks for a name, some tags and a line, and nothing
 * else. Every field a human could get wrong is a field the app can compute.
 *
 * That is also the answer to "how do previews get made": by the app, from the
 * real thing, at publish time. Not by a headless browser in CI reimplementing
 * what the renderer already does.
 */

interface PublisherUi {
  open: boolean;
  openDialog: () => void;
  close: () => void;
}

export const usePublisherUi = create<PublisherUi>((set) => ({
  open: false,
  openDialog: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export const openPublisher = () => usePublisherUi.getState().openDialog();

interface Analysis {
  durationMs: number;
  hitMs: number;
  peaks: number[];
}

const KINDS: Array<{ value: LibraryKind; label: string }> = [
  { value: "sound", label: "Sound" },
  { value: "component", label: "Component" },
  { value: "template", label: "Project" },
];

export function PublishDialog() {
  const open = usePublisherUi((s) => s.open);
  const close = usePublisherUi((s) => s.close);
  const publisher = usePublisher();
  const store = useDocStore();

  const [id, setId] = React.useState(publisher?.id ?? "");
  const [secret, setSecret] = React.useState(publisher?.secret ?? "");
  const [kind, setKind] = React.useState<LibraryKind>("sound");
  const [packId, setPackId] = React.useState("");
  const [packTitle, setPackTitle] = React.useState("");
  const [name, setName] = React.useState("");
  const [tags, setTags] = React.useState<string[]>([]);
  const [tagDraft, setTagDraft] = React.useState("");
  const [blurb, setBlurb] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [analysis, setAnalysis] = React.useState<Analysis | null>(null);
  const [poster, setPoster] = React.useState<Poster | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [packs, setPacks] = React.useState<Array<{ id: string; title: string; kind: string }>>([]);
  const [available, setAvailable] = React.useState(true);

  React.useEffect(() => {
    setId(publisher?.id ?? "");
    setSecret(publisher?.secret ?? "");
  }, [publisher]);

  // Which packs this keypair owns — the server is the only authority on that,
  // so the dialog asks rather than guessing from anything cached locally.
  React.useEffect(() => {
    if (!open || !id || !secret) return;
    let alive = true;
    void fetch(`/api/library/publish?id=${encodeURIComponent(id)}&secret=${encodeURIComponent(secret)}`)
      .then((r) => r.json())
      .then((data: { packs?: typeof packs; available?: boolean }) => {
        if (!alive) return;
        setPacks(data.packs ?? []);
        setAvailable(data.available !== false);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, id, secret]);

  const chooseFile = async (f: File) => {
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "));
    if (kind !== "sound") return;
    try {
      const ctx = new AudioContext();
      const buffer = await ctx.decodeAudioData(await f.arrayBuffer());
      const a = analyzeAudio(buffer.getChannelData(0), buffer.sampleRate);
      setAnalysis({ durationMs: a.audibleMs || a.durationMs, hitMs: a.hitMs, peaks: a.peaks });
      void ctx.close();
    } catch {
      setAnalysis(null);
      toast("Couldn’t decode that file");
    }
  };

  /** Publish the current selection as a component, without touching disk. */
  const captureSelection = () => {
    const snapshot = captureLibrarySnapshot(store.getState(), useSession.getState().selectedClipIds);
    if (!snapshot) {
      toast("Select something on the canvas first");
      return;
    }
    const json = new File([JSON.stringify(snapshot)], `${slug(name || "component")}.json`, {
      type: "application/json",
    });
    setFile(json);
    setAnalysis(null);
  };

  /**
   * Publish THIS project. The bundle is the File menu's own format, minus what
   * only means something on this machine; the poster is the frame under the
   * playhead — park it on the moment that sells the piece, then publish.
   */
  const captureProject = async () => {
    const doc = store.getState();
    const s = useSession.getState();
    const frame = doc.frames.find((f) => f.id === s.activeFrameId) ?? doc.frames.find((f) => f.id === landingFrameId(doc));
    if (!frame) {
      toast("This project has nothing to show yet");
      return;
    }
    setBusy(true);
    try {
      const { blob, poster } = await bundleProject(doc, frame, s.playheadMs);
      const title = name || doc.name;
      setFile(new File([blob], `${slug(title)}.motion`, { type: "application/zip" }));
      if (!name) setName(doc.name);
      setPoster(poster);
      setAnalysis(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn’t bundle this project");
    } finally {
      setBusy(false);
    }
  };

  const addTag = () => {
    const t = tagDraft.trim().toLowerCase().replace(/^#/, "");
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft("");
  };

  const canPublish = Boolean(id && secret && file && name.trim() && (packId || packTitle.trim()));

  const publish = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const chosen = packs.find((p) => p.id === packId);
      const data = await sendToLibrary(
        { id, secret },
        { id: packId || slug(packTitle), title: chosen?.title ?? packTitle, kind },
        {
          fileName: `${slug(name)}${extOf(file.name)}`,
          name: name.trim(),
          tags,
          blurb: blurb.trim() || null,
          description: description.trim() || null,
          ...(analysis ? { hitMs: analysis.hitMs } : {}),
        },
        file,
        poster,
      );
      setPublisher({ id, secret });
      toast(`${data.replaced ? "Replaced" : "Wrote"} ${data.path} — run pnpm library:publish to ship it`);
      close();
      setFile(null);
      setName("");
      setTags([]);
      setBlurb("");
      setDescription("");
      setAnalysis(null);
      setPoster(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish to the library</DialogTitle>
          <DialogDescription>
            Writes into your content repo. Review the diff, then run{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">pnpm library:publish</code>.
          </DialogDescription>
        </DialogHeader>

        {!available ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            No content repo on this machine. Set <code>LIBRARY_CONTENT_DIR</code> and restart the dev server.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Publisher id">
                <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="your-name" className="h-8 text-xs" />
              </Field>
              <Field label="Secret">
                <Input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="••••••••"
                  className="h-8 text-xs"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Field label="Kind">
                <Select value={kind} onValueChange={(v) => setKind(v as LibraryKind)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KINDS.map((k) => (
                      <SelectItem key={k.value} value={k.value}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Pack">
                {packs.length ? (
                  <Select value={packId} onValueChange={setPackId}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="New pack…" />
                    </SelectTrigger>
                    <SelectContent>
                      {packs.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={packTitle}
                    onChange={(e) => setPackTitle(e.target.value)}
                    placeholder="New pack name"
                    className="h-8 text-xs"
                  />
                )}
              </Field>
            </div>

            {/* What is being published, and what the app already measured. */}
            <div className="rounded-lg border bg-card/50 p-2.5">
              {file ? (
                <div className="flex items-center gap-2.5">
                  {poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={poster.dataUrl} alt="" className="h-9 w-32 shrink-0 rounded object-cover" />
                  ) : analysis ? (
                    <PeaksWave
                      peaks={analysis.peaks}
                      durationMs={analysis.durationMs}
                      hitMs={analysis.hitMs}
                      className="h-9 w-32 shrink-0 text-primary/80"
                    />
                  ) : (
                    <div className="flex h-9 w-32 shrink-0 items-center justify-center rounded bg-stage/60 text-[10px] text-muted-foreground">
                      {extOf(file.name).slice(1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1 text-[11px]">
                    <div className="truncate font-medium">{file.name}</div>
                    <div className="text-muted-foreground">
                      {analysis
                        ? `${Math.round(analysis.durationMs)} ms · hits at ${analysis.hitMs.toFixed(0)} ms`
                        : `${(file.size / 1024).toFixed(0)} KB`}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="Choose a different file"
                    onClick={() => {
                      setFile(null);
                      setAnalysis(null);
                      setPoster(null);
                    }}
                    className="text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
                  >
                    <X />
                  </button>
                </div>
              ) : (
                kind === "template" ? (
                  <Button type="button" variant="outline" size="sm" className="h-8 w-full text-[11px]" disabled={busy} onClick={() => void captureProject()}>
                    Use this project
                  </Button>
                ) : (
                <div className="flex items-center gap-2">
                  <label className="flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed text-[11px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground">
                    <Upload className="size-3.5" />
                    Choose a file
                    <input
                      type="file"
                      accept={kind === "sound" ? "audio/*" : undefined}
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void chooseFile(f);
                      }}
                    />
                  </label>
                  {kind === "component" && (
                    <Button type="button" variant="outline" size="sm" className="h-8 text-[11px]" onClick={captureSelection}>
                      Use selection
                    </Button>
                  )}
                </div>
                )
              )}
            </div>

            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" />
            </Field>

            <Field label="Tags">
              <div className="flex flex-wrap items-center gap-1 rounded-md border bg-input/30 p-1">
                {tags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTags(tags.filter((x) => x !== t))}
                    className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/25"
                  >
                    #{t} <X className="size-2.5" />
                  </button>
                ))}
                <input
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTag();
                    } else if (e.key === "Backspace" && !tagDraft) setTags(tags.slice(0, -1));
                  }}
                  onBlur={addTag}
                  placeholder={tags.length ? "" : "ui, soft, click"}
                  className="min-w-24 flex-1 bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground"
                />
              </div>
            </Field>

            <Field label="One line">
              <Input
                value={blurb}
                onChange={(e) => setBlurb(e.target.value)}
                placeholder="What it’s for, in a breath"
                className="h-8 text-xs"
              />
            </Field>

            <Field label="Notes (Markdown, optional)">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full resize-y rounded-md border bg-input/30 px-2 py-1.5 text-xs outline-none focus-visible:border-primary/60"
              />
            </Field>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!canPublish || busy || !available} onClick={() => void publish()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1")}>
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
