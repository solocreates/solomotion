"use client";

import { formatBytes } from "@/lib/format-bytes";
import * as React from "react";
import { AlertTriangle, FileText, Film, HardDriveDownload, Image as ImageIcon, Loader2, Music, Package, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useDocStore } from "../state/document-context";
import { useAppShell } from "../state/app-shell";
import { performSave, useSaveUi } from "../state/save";
import { estimateBundleSize, type BundleSizeEstimate } from "../io/motion-file";
import { canUseFilePicker, getSaveTarget } from "../io/file-handle-store";
import { orphanClipRefs, type ClipRef } from "../assets/media-usage";
import { useMediaReviewUi } from "../panels/MediaReviewDialog";

/** Amber above this, red above the next — a nudge, never a block. */
const WARN_BYTES = 100 * 1024 * 1024;
const HEAVY_BYTES = 500 * 1024 * 1024;


/**
 * The Save dialog — pick whether media travels inside the .motion file and see
 * the resulting size before you commit. Opens on first save and on "Save As…";
 * afterwards ⌘S re-saves silently with the remembered choice.
 */
export function SaveProjectDialog() {
  const store = useDocStore();
  const open = useSaveUi((s) => s.dialogOpen);
  const mode = useSaveUi((s) => s.dialogMode);
  const saving = useSaveUi((s) => s.saving);

  const [includeMedia, setIncludeMedia] = React.useState(true);
  const [estimate, setEstimate] = React.useState<BundleSizeEstimate | null>(null);
  const [estimating, setEstimating] = React.useState(false);
  const [orphans, setOrphans] = React.useState<ClipRef[]>([]);

  // Surface clips that reference media not in the library (won't be saved) —
  // kept live so fixing them in the review dialog updates the alert here.
  React.useEffect(() => {
    if (!open) return;
    const refresh = () => setOrphans(orphanClipRefs(store.getState()));
    refresh();
    return store.subscribe(refresh);
  }, [open, store]);

  // On open, adopt the remembered "include media" choice for this project.
  React.useEffect(() => {
    if (!open) return;
    const projectId = useAppShell.getState().currentProjectId;
    if (!projectId) return;
    void getSaveTarget(projectId).then((t) => {
      if (t) setIncludeMedia(t.includeMedia);
    });
  }, [open]);

  // Recompute the size whenever the toggle or dialog visibility changes.
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    setEstimating(true);
    void estimateBundleSize(store.getState(), { includeMedia }).then((e) => {
      if (alive) {
        setEstimate(e);
        setEstimating(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [open, includeMedia, store]);

  const onSave = async () => {
    const projectId = useAppShell.getState().currentProjectId;
    if (!projectId) return;
    const ok = await performSave(store, projectId, includeMedia, { forceNewLocation: mode === "save-as" });
    if (ok) useSaveUi.getState().closeSaveDialog();
  };

  const total = estimate?.total ?? 0;
  const heavy = total >= HEAVY_BYTES;
  const warn = total >= WARN_BYTES;
  const hasMedia = !!estimate && estimate.mediaBytes + estimate.fontBytes > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && useSaveUi.getState().closeSaveDialog()}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="size-4" /> {mode === "save-as" ? "Save project as…" : "Save project"}
          </DialogTitle>
          <DialogDescription>
            Saves a <span className="font-medium text-foreground">.motion</span> file — your whole project in one place.
          </DialogDescription>
        </DialogHeader>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
          <Switch checked={includeMedia} onCheckedChange={setIncludeMedia} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Include media in file</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {includeMedia
                ? "Bundles every image, video, sound and custom font — a self-contained file you can open on any device."
                : "References only — a tiny, portable file. Media stays on this device, so opening it elsewhere shows placeholders to relink."}
            </p>
          </div>
        </label>

        <div className="rounded-lg border">
          <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">Estimated size</div>
          <div className="divide-y">
            <SizeRow icon={<FileText className="size-3.5" />} label="Document" bytes={estimate?.docBytes} loading={estimating} />
            {includeMedia && (
              <>
                <SizeRow icon={<ImageIcon className="size-3.5" />} label="Images" bytes={estimate?.imageBytes} loading={estimating} muteZero />
                <SizeRow icon={<Film className="size-3.5" />} label="Video" bytes={estimate?.videoBytes} loading={estimating} muteZero />
                <SizeRow icon={<Music className="size-3.5" />} label="Audio & sounds" bytes={estimate?.audioBytes} loading={estimating} muteZero />
                <SizeRow icon={<Type className="size-3.5" />} label="Fonts" bytes={estimate?.fontBytes} loading={estimating} muteZero />
              </>
            )}
          </div>
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-sm font-semibold">Total</span>
            <span className={cn("text-sm font-semibold tabular-nums", heavy ? "text-destructive" : warn ? "text-amber-500" : "text-foreground")}>
              {estimating || !estimate ? "…" : formatBytes(total)}
            </span>
          </div>
        </div>

        {warn && (
          <div className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-xs", heavy ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-600 dark:text-amber-400")}>
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              This is a {heavy ? "very large" : "large"} file ({formatBytes(total)}). {hasMedia && "Turn off “Include media” for a lightweight copy, "}
              or save it somewhere with room to spare.
            </span>
          </div>
        )}

        {orphans.length > 0 && (
          <button
            type="button"
            onClick={() => useMediaReviewUi.getState().openReview()}
            className="flex w-full items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-left text-xs text-amber-600 transition-colors hover:bg-amber-500/10 dark:text-amber-400"
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {orphans.length} clip{orphans.length > 1 ? "s aren’t" : " isn’t"} in the library and won’t be
              saved — review
            </span>
          </button>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => useSaveUi.getState().closeSaveDialog()} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <HardDriveDownload className="size-4" />}
            {saving ? "Saving…" : canUseFilePicker() ? "Choose location & save" : "Save & download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SizeRow({
  icon,
  label,
  bytes,
  loading,
  muteZero,
}: {
  icon: React.ReactNode;
  label: string;
  bytes: number | undefined;
  loading: boolean;
  muteZero?: boolean;
}) {
  const zero = !loading && (bytes ?? 0) === 0;
  return (
    <div className={cn("flex items-center justify-between px-3 py-1.5 text-xs", muteZero && zero && "text-muted-foreground/50")}>
      <span className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        {label}
      </span>
      <span className="tabular-nums text-muted-foreground">
        {loading || bytes === undefined ? "…" : formatBytes(bytes)}
      </span>
    </div>
  );
}
