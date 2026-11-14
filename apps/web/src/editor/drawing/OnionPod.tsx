"use client";

import * as React from "react";
import { NumberInput } from "@/components/ui/number-input";
import { ColorInput } from "@/components/ui/color-picker";
import { Switch } from "@/components/ui/switch";
import { MoreRow, PodMenu } from "../stage/tool-bar-kit";
import { OnionSkinIcon } from "../stage/tool-icons";
import { RotateCcw } from "lucide-react";
import { sceneInk } from "../stage/scene-chrome";
import { useTheme } from "../theme/use-theme";
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
  // The theme's tints are derived, so a theme change must re-read them.
  useTheme((s) => s.theme);
  useTheme((s) => s.activeMode);
  const ink = sceneInk();

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
      <MoreRow label="Behind">
        <TintField value={onion.prevColor} theme={ink.onionBehind} onChange={(prevColor) => setOnion({ prevColor })} />
      </MoreRow>
      <MoreRow label="Ahead">
        <TintField value={onion.nextColor} theme={ink.onionAhead} onChange={(nextColor) => setOnion({ nextColor })} />
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

/**
 * A ghost tint: the theme's (shown, not stored) until a person picks one, and
 * a way back to it once they have.
 */
function TintField({ value, theme, onChange }: { value: string | null; theme: string; onChange: (c: string | null) => void }) {
  return (
    <span className="flex items-center gap-1">
      {value !== null && (
        <button
          type="button"
          aria-label="Use the theme's tint"
          title="Use the theme's tint"
          onClick={() => onChange(null)}
          className="grid size-(--control-h-sm) place-items-center rounded-(--r-xs) text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3"
        >
          <RotateCcw />
        </button>
      )}
      <ColorInput value={value ?? theme} onChange={onChange} variant="badge" />
    </span>
  );
}
