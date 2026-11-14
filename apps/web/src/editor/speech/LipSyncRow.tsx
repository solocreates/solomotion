"use client";

import * as React from "react";
import { mouthHears, mouthsIn, setMouthVoice, type AudioClip } from "@solomotion/core";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PanelSection, PropRow } from "../inspector/controls";
import { useDoc, useDocStore } from "../state/document-context";
import { useSpeechStatus } from "./speech-host";

/**
 * "Lip sync" on a voice clip: which mouth in its comp moves with it. Picking
 * one points that mouth's Lip sync behavior at this voice (core
 * `setMouthVoice` — the same field the Character tab edits); None silences
 * the mouths that hear it. A comp with no mouth offers one, and so does the
 * picker for a second character. Status rides here too, since this is where
 * the clip being heard is selected.
 */

const NONE = "__none";
const NEW = "__new";

export function LipSyncRow({ clip }: { clip: AudioClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const assetId = clip.source.type === "asset" ? clip.source.assetId : null;
  const status = useSpeechStatus(assetId);
  const [adding, setAdding] = React.useState(false);
  if (!assetId) return null;
  const mouths = mouthsIn(doc, clip.frameId);
  const following = mouths.filter((m) => mouthHears(m, clip));

  const addMouth = async () => {
    setAdding(true);
    try {
      const { addMouthForVoice } = await import("../character/make-character");
      await addMouthForVoice(store, clip.id);
    } finally {
      setAdding(false);
    }
  };

  const pick = (value: string) => {
    if (value === NEW) return void addMouth();
    store.update(value === NONE ? "Stop lip sync" : "Lip sync", (d) => {
      if (value === NONE) for (const m of following) setMouthVoice(d, m, null);
      else {
        const m = mouths.find((x) => x.key === value);
        if (m) setMouthVoice(d, m, clip.name);
      }
    });
  };

  return (
    <PanelSection id="lip-sync" title="Lip sync">
      {mouths.length ? (
        <PropRow label="Mouth" hint="The mouth this voice moves">
          <Select value={following[0]?.key ?? NONE} onValueChange={pick} disabled={adding}>
            <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {mouths.map((m) => (
                <SelectItem key={m.key} value={m.key}>
                  {m.label}
                </SelectItem>
              ))}
              <SelectItem value={NONE}>None</SelectItem>
              <SelectSeparator />
              <SelectItem value={NEW}>New mouth</SelectItem>
            </SelectContent>
          </Select>
        </PropRow>
      ) : (
        <PropRow wide>
          <Button variant="outline" size="sm" className="h-7 w-full text-xs" disabled={adding} onClick={() => void addMouth()}>
            <Plus /> Add mouth
          </Button>
        </PropRow>
      )}
      {status?.state === "listening" && (
        <PropRow label=" ">
          <span className="text-[11px] text-muted-foreground">Listening… {Math.round(status.progress * 100)}%</span>
        </PropRow>
      )}
      {status?.state === "failed" && (
        <PropRow label=" ">
          <span className="text-[11px] text-amber-500">Couldn&apos;t hear a voice in this clip</span>
        </PropRow>
      )}
    </PanelSection>
  );
}
