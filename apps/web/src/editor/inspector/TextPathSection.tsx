"use client";

import * as React from "react";
import {
  detachTextFromPath,
  hostLocalTime,
  hostPolylinesAt,
  isPathText,
  locateClip,
  pathHostOf,
  type PathTextClip,
  type TextClip,
  type TextPathFollow,
} from "@solomotion/core";
import { FlipHorizontal2, Link2Off, Repeat, Spline } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useParkedPlayhead } from "../state/session";
import { useEffectiveValue, writeAnimatable } from "./animatable";
import { IconTrack, PanelSection, PropRow } from "./controls";
import { KeyControl } from "./keyframe-controls";
import { useClipUpdater } from "./use-clip-updater";

/**
 * ON PATH — the section a text grows the moment it rides an outline.
 *
 * It stands where Transform would: the layer's position, rotation and scale
 * are the host's while bound (`relations/resolve.ts`), so the fields that
 * would edit them are not shown — a number you can type into that then does
 * nothing is worse than no number. What IS the text's own is here: how far
 * round it sits (in laps, so a spin is one key), how far off the line, which
 * side, whether the letters turn with the curve, and what happens past the
 * end. Detach puts the text down exactly where it is, as plain text.
 */
export function TextPathSection({ clip }: { clip: TextClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const update = useClipUpdater(clip.id);
  const playheadMs = useParkedPlayhead();
  if (!isPathText(clip)) return null;
  const bound: PathTextClip = clip;
  const host = pathHostOf(doc, bound);
  const contours = host ? hostPolylinesAt(host, hostLocalTime(host, playheadMs)).length : 0;

  return <Body clip={bound} hostName={host?.name ?? null} contours={contours} onDetach={() => {
    store.update("Detach from path", (d) => {
      const live = locateClip(d, clip.id)?.clip;
      if (live && live.kind === "text") detachTextFromPath(d, live, useSession.getState().playheadMs);
    });
  }} update={update} />;
}

function Body({
  clip,
  hostName,
  contours,
  onDetach,
  update,
}: {
  clip: PathTextClip;
  hostName: string | null;
  contours: number;
  onDetach: () => void;
  update: ReturnType<typeof useClipUpdater>;
}) {
  const offset = useEffectiveValue(clip, "path.offset", clip.path.offset);
  const rise = useEffectiveValue(clip, "path.rise", clip.path.rise);
  const setSpec = (label: string, mutate: (p: PathTextClip["path"]) => void, mergeKey?: string) =>
    update(label, (c) => void (c.kind === "text" && c.path && mutate(c.path)), mergeKey);

  return (
    <PanelSection
      id="text-path"
      title="On path"
      hint="This text rides another layer's outline. Its position is the host's; slide it with the grip on the canvas or the offset here."
      actions={
        <Button variant="ghost" size="icon-sm" title="Detach — keep the text where it is, as plain text" onClick={onDetach}>
          <Link2Off />
        </Button>
      }
    >
      <PropRow label="Host">
        <div className="flex h-[var(--control-h)] items-center gap-1.5 truncate text-[12px]">
          <Spline className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{hostName ?? "Missing"}</span>
        </div>
      </PropRow>
      {contours > 1 && (
        <PropRow label="Contour" hint="A host with several contours — a ring, a compound path — carries the text on one of them.">
          <Select
            value={String(Math.min(contours - 1, clip.path.contour))}
            onValueChange={(v) => setSpec("Change contour", (p) => void (p.contour = Number(v)))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: contours }, (_, i) => (
                <SelectItem key={i} value={String(i)}>
                  {i === 0 ? "Outer" : contours === 2 ? "Inner" : `Contour ${i + 1}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PropRow>
      )}
      <PropRow
        label="Offset"
        hint="Where along the outline the text sits, in laps — 1 is once around, so keying 0 → 3 spins it three times."
        keyControl={<KeyControl clip={clip} property="path.offset" currentValue={() => offset} />}
      >
        <NumberInput
          value={offset}
          step={0.01}
          precision={3}
          unit="×"
          onChange={(v) =>
            update(
              "Change path offset",
              (c) => writeAnimatable(c, "path.offset", v, useSession.getState().playheadMs, (t) => {
                if (t.kind === "text" && t.path) t.path.offset = v;
              }),
              "path-offset",
            )
          }
        />
      </PropRow>
      <PropRow
        label="Rise"
        hint="Lift off the line, in px. Negative sinks the letters to the other side."
        keyControl={<KeyControl clip={clip} property="path.rise" currentValue={() => rise} />}
      >
        <NumberInput
          value={rise}
          step={1}
          precision={0}
          unit="px"
          onChange={(v) =>
            update(
              "Change path rise",
              (c) => writeAnimatable(c, "path.rise", v, useSession.getState().playheadMs, (t) => {
                if (t.kind === "text" && t.path) t.path.rise = v;
              }),
              "path-rise",
            )
          }
        />
      </PropRow>
      <PropRow label="Letters">
        <IconTrack
          value={[
            ...(clip.path.follow === "tangent" ? (["tangent"] as const) : []),
            ...(clip.path.flip ? (["flip"] as const) : []),
            ...(clip.path.loop ? (["loop"] as const) : []),
          ]}
          items={[
            { id: "tangent", label: "Turn with the curve", icon: <Spline /> },
            { id: "flip", label: "Flip to the other side", icon: <FlipHorizontal2 /> },
            { id: "loop", label: "Wrap past the end", icon: <Repeat /> },
          ]}
          onPick={(id) => {
            if (id === "tangent")
              setSpec("Turn letters", (p) => void (p.follow = (p.follow === "tangent" ? "upright" : "tangent") as TextPathFollow));
            else if (id === "flip") setSpec("Flip path text", (p) => void (p.flip = !p.flip));
            else setSpec("Wrap path text", (p) => void (p.loop = !p.loop));
          }}
        />
      </PropRow>
    </PanelSection>
  );
}
