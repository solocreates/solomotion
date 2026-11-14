"use client";

import * as React from "react";
import { locateClip, type WaveformClip } from "@solomotion/core";
import { AudioLines, Link2, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePluginWindows } from "../plugins/plugin-windows";
import { useDoc } from "../state/document-context";
import { PanelSection, PropRow } from "./controls";
import { mergeReads } from "./merge";
import { ofKind, usePeers } from "./selection-scope";

const isWaveform = ofKind("waveform");

/**
 * Inspector section for waveform-visualizer clips: shows what it listens to
 * and hands off to the Waveform Visualizer plugin — the plugin edits the
 * selected clip live, so this stays a summary + one honest button instead of
 * a second, drifting copy of the style controls.
 */
export function WaveformInspector({ clip }: { clip: WaveformClip }) {
  const doc = useDoc();
  const peers = usePeers(clip, isWaveform);
  const target = locateClip(doc, clip.targetClipId)?.clip ?? null;
  const listens = mergeReads(peers, (c) => c.targetClipId);
  const style = mergeReads(peers, (c) => `${c.style.template} · ${c.style.mode === "spectrum" ? "spectrum EQ" : "scrolling wave"}`);
  return (
    <PanelSection title="Waveform visualizer">
      <PropRow label="Audio">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
          {listens.mixed ? (
            <span className="truncate text-muted-foreground">Mixed</span>
          ) : target ? (
            <>
              <AudioLines className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{target.name}</span>
              {clip.linkGroupId && <Link2 className="size-3 shrink-0 text-muted-foreground" />}
            </>
          ) : (
            <>
              <TriangleAlert className="size-3 shrink-0 text-destructive" />
              <span className="truncate text-destructive">missing — open the plugin to retarget</span>
            </>
          )}
        </div>
      </PropRow>
      <PropRow label="Style">
        <span className="text-[11px] text-muted-foreground">
          {style.mixed ? "Mixed" : style.value}
        </span>
      </PropRow>
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={() => usePluginWindows.getState().open("waveform")}
      >
        <SlidersHorizontal /> Edit visualizer…
      </Button>
    </PanelSection>
  );
}
