"use client";

import * as React from "react";
import { pickCandidates, type PickCandidate, type PickFilter } from "@solomotion/core";
import { ObjectField, type PickScope } from "../pick/ObjectField";
import { useDoc } from "../state/document-context";
import { useParkedPlayhead } from "../state/session";

/**
 * A voice field — the one every surface that asks "which recording does this
 * mouth follow" mounts (the Lip sync card, the Character tab's Voice). A voice
 * is named, not pointed at (`lipsync("Hello")` survives a re-record that keeps
 * the name), so the value is a layer NAME and "" means every voice in reach.
 */

const span = (c: PickCandidate) => {
  const clip = c.clip;
  if (!clip) return null;
  const s = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  return `${s(clip.startMs)}–${s(clip.startMs + clip.durationMs)}`;
};

const NONE = "__none";

export function VoicePicker({
  frameId,
  value,
  onChange,
  every = { label: "Every voice", hint: "Whichever is playing" },
  onNone,
}: {
  frameId: string;
  /** A layer name, "" for every voice, or null for none (only with `onNone`). */
  value: string | null;
  onChange: (name: string) => void;
  /** What "" means here — every voice in reach, or none at all. */
  every?: { label: string; hint?: string };
  /** Offer "None" too: the mouth hears nothing. */
  onNone?: () => void;
}) {
  const doc = useDoc();
  const want = (value ?? "").trim().toLowerCase();
  // The PARKED playhead: it holds still while the transport runs, so the picker
  // doesn't re-render with every playing frame.
  const playhead = useParkedPlayhead();
  const scopes: PickScope[] = React.useMemo(() => {
    const comp: PickFilter = { kinds: ["layer"], frameId, tags: ["voice"] };
    return [
      { id: "comp", label: "In this comp", filter: comp },
      { id: "now", label: "At playhead", filter: { ...comp, atMs: playhead } },
    ];
  }, [frameId, playhead]);
  const found = React.useMemo(
    () => (want ? pickCandidates(doc, scopes[0]!.filter).find((c) => c.id === value || c.name.trim().toLowerCase() === want) : undefined),
    [doc, scopes, want, value],
  );
  return (
    <ObjectField
      filter={scopes}
      noun="voice"
      value={found?.key ?? null}
      broken={!!want && !found}
      onChange={(c) => onChange(c.name)}
      extras={onNone ? [{ value: "", ...every }, { value: NONE, label: "None" }] : [{ value: "", ...every }]}
      extraValue={value === null ? NONE : want ? null : ""}
      onExtra={(v) => (v === NONE ? onNone?.() : onChange(v))}
      missing={want ? `${value} — missing` : undefined}
      note={span}
    />
  );
}
