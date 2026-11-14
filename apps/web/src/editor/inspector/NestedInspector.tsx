"use client";

import * as React from "react";
import { componentFrameOfClip, nestedClipsContent, nestedSourceOf, type NestedClip } from "@solomotion/core";
import { Link2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDoc, useDocStore } from "../state/document-context";
import { makeNestedUnique } from "../state/clip-actions";
import { PanelSection, PropRow } from "./controls";
import { PlaybackSection } from "./MediaInspector";
import { mergeReads, selectValue } from "./merge";
import { ofKind, usePeers } from "./selection-scope";
import { useClipUpdater } from "./use-clip-updater";

const isNested = ofKind("nested");

type ClipMode = "auto" | "on" | "off";
const modeOf = (c: NestedClip): ClipMode => (c.clipContent == null ? "auto" : c.clipContent ? "on" : "off");

/**
 * Nested clip inspector. The Figma component actions (Create / Edit / Detach)
 * live in the universal `ComponentSection` shared by every layer kind, so this
 * panel surfaces the source — and whether it is LINKED (a comp on a page or
 * shared with other layers: edits show everywhere) or this layer's own, with
 * Make unique to turn a link into a copy — whether the comp is seen through its
 * box ("Clip content"), and playback.
 */
export function NestedInspector({ clip }: { clip: NestedClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, isNested);
  const isComponentInstance = peers.some((c) => componentFrameOfClip(doc, c) != null);
  const source = mergeReads(peers, (c) => doc.frames.find((f) => f.id === c.sourceFrameId)?.name ?? "(missing frame)");
  const linked = peers.some((c) => nestedSourceOf(doc, c) === "linked");
  const mode = mergeReads(peers, modeOf);
  // What Auto resolves to, so the choice is never a guess.
  const auto = mergeReads(peers, (c) => {
    const src = doc.frames.find((f) => f.id === c.sourceFrameId);
    return src ? nestedClipsContent({ clipContent: null }, src) : true;
  });
  const autoLabel = auto.mixed ? "Auto" : `Auto · ${auto.value ? "on" : "off"}`;

  return (
    <>
      <PanelSection title="Source" collapsible={false}>
        {!isComponentInstance && (
          <PropRow label="Frame" hint={linked ? "Linked: edits to this comp show everywhere it is used." : undefined}>
            <div className="flex min-w-0 items-center gap-1.5">
              {linked && <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-label="Linked" />}
              <span className="min-w-0 flex-1 truncate text-xs">{source.mixed ? "Mixed" : source.value}</span>
              {linked && (
                <Button variant="ghost" size="sm" className="h-6 shrink-0 px-1.5 text-xs" onClick={() => makeNestedUnique(store)} title="Give this layer its own copy">
                  <Unlink /> Make unique
                </Button>
              )}
            </div>
          </PropRow>
        )}
        <PropRow label="Clip" hint="Crop the comp to its box. Auto crops a comp with a background and lets a transparent one spill.">
          <Select
            value={selectValue(mode)}
            onValueChange={(v) =>
              update("Clip content", (c) => {
                if (c.kind === "nested") c.clipContent = v === "auto" ? null : v === "on";
              })
            }
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue placeholder="Mixed" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{autoLabel}</SelectItem>
              <SelectItem value="on">Clip to box</SelectItem>
              <SelectItem value="off">Show outside</SelectItem>
            </SelectContent>
          </Select>
        </PropRow>
      </PanelSection>
      <PlaybackSection clip={clip} />
    </>
  );
}
