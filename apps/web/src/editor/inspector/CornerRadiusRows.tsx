"use client";

import * as React from "react";
import type { Clip, CornerRadius } from "@solomotion/core";
import { Link2, Link2Off } from "lucide-react";
import { NumberInput } from "@/components/ui/number-input";
import { useSession } from "../state/session";
import { commitProperty, useField } from "./animatable";
import type { Field } from "./merge";
import { CornerGlyph, type Corner } from "./glyphs";
import { Half, IconToggle, Inline, PropRow } from "./controls";
import { KeyControl } from "./keyframe-controls";
import { useClipUpdater } from "./use-clip-updater";

/**
 * ONE Figma-style corner-radius control, reused by every layer that rounds:
 * rectangles (`prefix="radius"`, backed by `shape.cornerRadius`) AND box layers —
 * image/video/nested/drawing (`prefix="borderRadius"`, the universal box radius).
 * Both address `${prefix}.tl|tr|br|bl`, so the SAME rows + on-stage handles drive
 * shapes and boxes with no per-kind code.
 *
 * A single combined field edits all four corners; the link toggle reveals the
 * four independent fields (and persists while corners differ). Alt-click the
 * toggle SYNCS every corner back to the top-left value and re-links — the quick
 * "make them equal again" gesture.
 *
 * The per-corner fields carry a corner GLYPH rather than a "TL"/"BR" label: the
 * icon is the diagram, and you stop translating letters into a picture.
 */

const CORNERS: ReadonlyArray<{ corner: Corner; label: string }> = [
  { corner: "tl", label: "Top left" },
  { corner: "tr", label: "Top right" },
  { corner: "bl", label: "Bottom left" },
  { corner: "br", label: "Bottom right" },
];

export function CornerRadiusRows<C extends Clip>({
  peers,
  prefix,
  read,
  label = "Radius",
}: {
  /** The layers being shown, primary first — see `usePeers`. */
  peers: readonly C[];
  prefix: "radius" | "borderRadius";
  read: (c: C) => CornerRadius;
  label?: string;
}) {
  const clip = peers[0]!;
  const update = useClipUpdater(clip.id);
  const commit = (path: string, v: number, mergeKey: string) =>
    update("Corner radius", (c) => commitProperty(c, path, Math.max(0, v), useSession.getState().playheadMs), mergeKey);

  const f: Record<Corner, Field<number>> = {
    tl: useField(peers, `${prefix}.tl`, (c) => read(c).tl),
    tr: useField(peers, `${prefix}.tr`, (c) => read(c).tr),
    br: useField(peers, `${prefix}.br`, (c) => read(c).br),
    bl: useField(peers, `${prefix}.bl`, (c) => read(c).bl),
  };
  const tl = f.tl.value;
  // Two different questions. `uniform`: is there ONE number to show? `even`:
  // does every layer round its four corners alike? Three layers at 4, 8 and 12
  // are even but not uniform — one field reading "Mixed", not four.
  const uniform = (["tl", "tr", "br", "bl"] as const).every((k) => !f[k].mixed && f[k].value === tl);
  const even = peers.every((c) => {
    const r = read(c);
    return r.tl === r.tr && r.tr === r.br && r.br === r.bl;
  });

  const [independent, setIndependent] = React.useState(!even);
  // If the corners become even again elsewhere (e.g. undo), collapse back.
  React.useEffect(() => {
    if (even) setIndependent(false);
  }, [even]);

  const setAll = (v: number) => {
    for (const c of ["tl", "tr", "br", "bl"] as const) commit(`${prefix}.${c}`, v, `${prefix}-all`);
  };

  return (
    <>
      <PropRow
        label={label}
        keyControl={<KeyControl clip={clip} property={`${prefix}.tl`} currentValue={() => tl} />}
      >
        <Inline
          trailing={
            <IconToggle
              label="Set each corner — ⌥-click to sync them"
              pressed={independent}
              onClick={(e) => {
                if (e.altKey) {
                  setAll(tl);
                  setIndependent(false);
                } else {
                  setIndependent((v) => !v);
                }
              }}
            >
              {independent ? <Link2Off /> : <Link2 />}
            </IconToggle>
          }
        >
          {independent ? (
            <div className="grid grid-cols-2 gap-1.5">
              {CORNERS.map(({ corner: c, label: l }) => (
                <NumberInput
                  key={c}
                  label={<CornerGlyph corner={c} className="size-3" />}
                  title={l}
                  value={f[c].value}
                  mixed={f[c].mixed}
                  min={0}
                  precision={0}
                  onChange={(v) => commit(`${prefix}.${c}`, v, `${prefix}-${c}`)}
                />
              ))}
            </div>
          ) : (
            <Half>
              <NumberInput
                value={tl}
                mixed={!uniform}
                min={0}
                precision={0}
                unit="px"
                title={uniform ? undefined : "Corners differ — edit to set them all"}
                onChange={setAll}
              />
            </Half>
          )}
        </Inline>
      </PropRow>
    </>
  );
}
