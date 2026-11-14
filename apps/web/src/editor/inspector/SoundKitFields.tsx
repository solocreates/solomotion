"use client";

import * as React from "react";
import { X } from "lucide-react";
import type { SoundKit, SoundLayer, SoundTake } from "@solomotion/core";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDoc } from "../state/document-context";
import { PropRow } from "./controls";

/** A take's note as a pitch class, kept within a tritone of C so a retune never moves a recording far. */
const ROOTS: Array<[number, string]> = [
  [-6, "F♯"], [-5, "G"], [-4, "G♯"], [-3, "A"], [-2, "B♭"], [-1, "B"],
  [0, "C"], [1, "C♯"], [2, "D"], [3, "E♭"], [4, "E"], [5, "F"],
];
const LAYER_LABEL: Record<SoundTake["layer"], string> = { any: "Any hit", soft: "Soft hits", hard: "Hard hits" };

/**
 * A voice as a KIT of recorded takes (v105): the saved hit sounds it plays in
 * turn, each with the note it sounds (so a voice with notes retunes it into the
 * scale) and the hits it answers. Takes come from the project's saved hit
 * sounds, so each already carries its measured hit point.
 */
export function SoundKitFields({ row, onPatch }: { row: SoundLayer; onPatch: (next: Partial<SoundLayer>, label: string) => void }) {
  const doc = useDoc();
  const saved = doc.customSounds;
  const nameOf = (assetId: string) =>
    saved.find((s) => s.assetId === assetId)?.name ?? doc.assets.find((a) => a.id === assetId)?.name ?? "Take";
  const takes = row.kit?.takes ?? [];
  const count = `${takes.length} take${takes.length === 1 ? "" : "s"}`;
  const setTakes = (next: SoundTake[], label: string) => onPatch({ kit: next.length ? ({ takes: next } satisfies SoundKit) : null }, label);
  const patchTake = (k: number, patch: Partial<SoundTake>, label: string) => setTakes(takes.map((t, j) => (j === k ? { ...t, ...patch } : t)), label);
  // Starting a kit on a voice that already plays a saved sound keeps that sound as the first take.
  const seed = !takes.length && row.custom ? [{ assetId: row.custom.assetId, hitMs: row.custom.hitMs, root: 0, layer: "any" as const }] : [];
  const addable = saved.filter((s) => !takes.some((t) => t.assetId === s.assetId) && !seed.some((t) => t.assetId === s.assetId));

  return (
    <>
      <PropRow label="Kit" hint="Recorded takes played in turn, never the same one twice in a row. Set each take's note and it plays the scale.">
        <Select
          value=""
          onValueChange={(id) => {
            const s = saved.find((c) => c.id === id);
            if (s) setTakes([...seed, ...takes, { assetId: s.assetId, hitMs: s.hitMs, root: 0, layer: "any" }], "Add a take");
          }}
          disabled={!addable.length}
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue placeholder={addable.length ? (takes.length ? `${count} · add` : "Add a take") : saved.length ? count : "Save hit sounds first"} />
          </SelectTrigger>
          <SelectContent>
            {addable.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PropRow>
      {takes.map((t, k) => (
        <div key={`${t.assetId}-${k}`} className="flex min-w-0 items-center gap-1 pl-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={nameOf(t.assetId)}>
            {nameOf(t.assetId)}
          </span>
          <Select value={String(t.root)} onValueChange={(v) => patchTake(k, { root: Number(v) }, "Set the take's note")}>
            <SelectTrigger className="h-6 w-14 text-xs" aria-label="The note this take sounds">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROOTS.map(([v, n]) => (
                <SelectItem key={v} value={String(v)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={t.layer} onValueChange={(v) => patchTake(k, { layer: v as SoundTake["layer"] }, "Set which hits the take plays")}>
            <SelectTrigger className="h-6 w-24 text-xs" aria-label="Which hits this take plays">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(LAYER_LABEL) as SoundTake["layer"][]).map((l) => (
                <SelectItem key={l} value={l}>
                  {LAYER_LABEL[l]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            aria-label="Remove this take"
            onClick={() => setTakes(takes.filter((_, j) => j !== k), "Remove a take")}
          >
            <X className="size-3" />
          </Button>
        </div>
      ))}
    </>
  );
}
