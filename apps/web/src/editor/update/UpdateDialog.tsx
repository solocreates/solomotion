"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdate } from "./update-store";

/**
 * The update dialog — deliberately spare: what's new, from → to, and the two
 * choices that matter (update now / later). Release notes are optional and open
 * externally, so the dialog stays a decision surface, not a changelog reader.
 */
export function UpdateDialog() {
  const { dialogOpen, setDialogOpen, current, latest, manifest, applyKind, phase, apply } =
    useUpdate();
  const applying = phase === "applying";
  const primaryLabel = applyKind === "install" ? "Install & restart" : "Reload to update";

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="size-4" />
            </span>
            <DialogTitle className="text-base">A new version is available</DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <VersionChip label="Current" version={current || "—"} muted />
            <span className="text-muted-foreground">→</span>
            <VersionChip label="Latest" version={latest ?? "—"} />
          </div>

          {manifest?.name && (
            <p className="text-sm font-medium leading-snug">{manifest.name}</p>
          )}

          <p className="text-sm leading-relaxed text-muted-foreground">
            {applyKind === "install"
              ? `The update will download and install the next time you relaunch ${identity.name}.`
              : "Reload now to switch to the latest build. Your work autosaves — nothing is lost."}
          </p>

          {manifest?.notesUrl && (
            <a
              href={manifest.notesUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              What&apos;s new in {latest}
              <ArrowUpRight className="size-3" />
            </a>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={applying}>
            Later
          </Button>
          <Button onClick={() => void apply()} disabled={applying}>
            {applying ? "Updating…" : primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionChip({
  label,
  version,
  muted,
}: {
  label: string;
  version: string;
  muted?: boolean;
}) {
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs " +
        (muted ? "text-muted-foreground" : "border-primary/40 text-foreground")
      }
    >
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </span>
      {version}
    </span>
  );
}
