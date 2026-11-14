"use client";

import * as React from "react";
import { getClipProperty, parseDriverToken, propertyDef, type Clip, type KeyframeValue } from "@solomotion/core";
import { NumberInput } from "@/components/ui/number-input";
import { ColorInput } from "@/components/ui/color-picker";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FontPicker } from "../inspector/FontPicker";
import { useSession } from "../state/session";
import { useClipUpdater } from "../inspector/use-clip-updater";
import { commitProperty, useEffectiveValue } from "../inspector/animatable";
import { KeyControl } from "../inspector/keyframe-controls";
import { PropertyBindingMenu } from "../inspector/property-binding";
import { useBoardStore } from "./board-store";

/**
 * A projection-node row's editor — the SIDEBAR field for a layer property, in
 * the node tree. It reads the layer's REAL live value (`useEffectiveValue`) and
 * writes it back through the SAME animatable policy every inspector field uses
 * (`commitProperty`: base value, or a keyframe at the playhead when keyed / in
 * record mode), so editing a node value edits the layer — and keyframes it — for
 * real. The right control is chosen headlessly from the property's own def
 * (`propertyDef`): a scrubbable number, the app's colour picker, a text field, a
 * switch. Rendered ONLY when the socket is unconnected; a driven row shows just
 * its incoming value and hides the editor (you can't type over a wire).
 */
export function NodePropertyField({ clip, path }: { clip: Clip; path: string }) {
  const def = propertyDef(path);
  const activeGraphId = useBoardStore((s) => s.activeGraphId);
  const update = useClipUpdater(clip.id);
  // THE base is the layer's REAL current value for this path (getClipProperty),
  // NOT the identity — that's the one source of truth. `useEffectiveValue` then
  // returns the sampled value when keyed, else this base, so the node row always
  // shows (and edits from) what the layer actually is. Getting this wrong made X
  // read 0 and text reset to a single letter every keystroke.
  const raw = getClipProperty(clip, path);
  const base = ((raw ?? def?.identity ?? 0) as KeyframeValue) as never;
  const value = useEffectiveValue(clip, path, base);
  const mergeKey = `node-field-${clip.id}-${path}`;

  const commit = React.useCallback(
    (v: number | string | boolean) =>
      update(`Set ${def?.label ?? path}`, (c) => commitProperty(c, path, v, useSession.getState().playheadMs), mergeKey),
    [update, def?.label, path, mergeKey],
  );

  if (!def) return null;

  // Driven from somewhere that is NOT a wire on this board — another graph, an
  // expression, a variable. The row still shows a field: `PropertyBindingMenu`
  // tints it by its source and opens that source on click, which is the same
  // affordance the sidebar gives, so the board and the inspector behave
  // identically. A same-graph drive keeps showing as a wire instead (its graphId
  // is the active board's, so there is already a line to follow).
  const token = clip.drivers?.[path];
  const wiredHere = token ? parseDriverToken(token)?.graphId === activeGraphId : false;
  const drivenElsewhere = Boolean(token) && !wiredHere;

  const isFontFamily = path === "fontFamily" || path.endsWith(".fontFamily");
  const isFontWeight = path === "fontWeight" || path.endsWith(".fontWeight");

  const control = () => {
    // The reusable font family selector — the SAME picker the sidebar/variables
    // use, now in the node tree (drivable + keyframable like any other field).
    if (isFontFamily) {
      return (
        <div className="w-28">
          <FontPicker value={typeof value === "string" ? value : undefined} onChange={(f) => commit(f)} />
        </div>
      );
    }
    if (isFontWeight) {
      return (
        <Select value={String(typeof value === "number" ? value : 400)} onValueChange={(w) => commit(parseInt(w, 10))}>
          <SelectTrigger className="h-6 w-24 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
              <SelectItem key={w} value={String(w)} className="text-xs">
                {w}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    if (def.kind === "color") {
      return <ColorInput value={typeof value === "string" ? value : "#ffffff"} onChange={(v) => commit(v)} />;
    }
    if (def.kind === "discrete" && typeof base === "boolean") {
      return <Switch checked={Boolean(value)} onCheckedChange={(v) => commit(v)} />;
    }
    if (def.kind === "discrete" && typeof base === "string") {
      return (
        <Input
          value={typeof value === "string" ? value : ""}
          onChange={(e) => commit(e.target.value)}
          className="h-6 w-24 text-[11px]"
        />
      );
    }
    return (
      <NumberInput
        value={typeof value === "number" ? value : 0}
        onChange={(v) => commit(v)}
        min={def.min}
        max={def.max}
        step={def.step}
        className="h-6 w-16 text-[11px]"
      />
    );
  };

  return (
    <div className="ml-auto flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
      {drivenElsewhere ? (
        <PropertyBindingMenu
          clip={clip}
          path={path}
          kind={def.kind === "color" ? "color" : typeof base === "number" ? "number" : "string"}
          label={def.label ?? path}
          literal={base as string | number}
        >
          <div className="min-w-0">{control()}</div>
        </PropertyBindingMenu>
      ) : (
        control()
      )}
      {/* A property driven by a wire on THIS board is shown as the wire — keep the
          keyframe cluster here so node rows still key like the sidebar does. */}
      <KeyControl clip={clip} property={path} currentValue={() => (value ?? base) as never} driverBadge={drivenElsewhere} />
    </div>
  );
}
