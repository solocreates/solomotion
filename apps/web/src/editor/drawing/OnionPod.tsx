"use client";

import * as React from "react";
import { NumberInput } from "@/components/ui/number-input";
import { ColorInput } from "@/components/ui/color-picker";
import { Switch } from "@/components/ui/switch";
import { MoreRow, PodMenu } from "../stage/tool-bar-kit";
import { OnionSkinIcon } from "../stage/tool-icons";
import { useDrawing } from "./drawing-store";

/**
 * Onion skinning — one pod, shown wherever frames are drawn: the stage's tool
 * bar and the flipbook sheet's own toolbar. Click toggles, the caret opens the
 * settings.
 *
 * It used to hide the whole settings panel behind a HOLD, which is an invisible
 * gesture: the counts, the tints and the loop-wrap switch were unreachable
 * unless you already knew they were there. `PodMenu` gives it the app's shared
 * two-target chip instead — the same object every disclosure pod in a tool bar
 * now wears — and with it the one armed state (`material-glass-raised`) rather
 * than the accent-filled slab this had of its own.
 *
 * Settings are app-level view preferences; the stage renders ghosts through the
 * headless core plan (`onionGhosts`), so this pod never touches rendering.
 */
export function OnionPod() {
  const onion = useDrawing((s) => s.onion);
  const setOnion = useDrawing((s) => s.setOnion);

  return (
    <PodMenu
      icon={<OnionSkinIcon />}
      label="Onion skin"
      detail={onion.enabled ? `${onion.prevCount} back · ${onion.nextCount} forward` : "off"}
      armed={onion.enabled}
      onToggle={() => setOnion({ enabled: !onion.enabled })}
    >
      <MoreRow label="Frames back">
        <NumberInput
          value={onion.prevCount}
          min={0}
          max={8}
          precision={0}
          className="w-16"
          onChange={(v) => setOnion({ prevCount: Math.round(v) })}
        />
      </MoreRow>
      <MoreRow label="Frames forward">
        <NumberInput
          value={onion.nextCount}
          min={0}
          max={8}
          precision={0}
          className="w-16"
          onChange={(v) => setOnion({ nextCount: Math.round(v) })}
        />
      </MoreRow>
      <MoreRow label="Past tint">
        <ColorInput value={onion.prevColor} onChange={(prevColor) => setOnion({ prevColor })} variant="badge" />
      </MoreRow>
      <MoreRow label="Future tint">
        <ColorInput value={onion.nextColor} onChange={(nextColor) => setOnion({ nextColor })} variant="badge" />
      </MoreRow>
      <MoreRow label="Tint strength">
        <NumberInput
          value={Math.round(onion.tintStrength * 100)}
          min={0}
          max={100}
          precision={0}
          unit="%"
          className="w-16"
          onChange={(v) => setOnion({ tintStrength: v / 100 })}
        />
      </MoreRow>
      <MoreRow label="Opacity">
        <NumberInput
          value={Math.round(onion.opacity * 100)}
          min={5}
          max={90}
          precision={0}
          unit="%"
          className="w-16"
          onChange={(v) => setOnion({ opacity: v / 100 })}
        />
      </MoreRow>
      <MoreRow label="Wrap looping rows">
        <Switch checked={onion.loopWrap} onCheckedChange={(loopWrap) => setOnion({ loopWrap })} />
      </MoreRow>
    </PodMenu>
  );
}
