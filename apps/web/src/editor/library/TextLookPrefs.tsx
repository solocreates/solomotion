"use client";

import * as React from "react";
import {
  INHERIT_PREFS,
  defaultLookVoice,
  type SoundVoice,
  type TextLookPrefs,
} from "@solomotion/core";
import { Droplet, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DocColorInput } from "../inspector/DocColorInput";
import { PropRow } from "../inspector/controls";
import { SoundVoiceFields, SoundVoicePicker } from "../inspector/SoundVoiceFields";
import { useWorkspace } from "../state/workspace";

/**
 * THE LOOK DIALS — one colour and one voice, sitting above a hundred presets.
 *
 * The problem they solve is arithmetic. A hundred looks each carry their own
 * palette and their own typing sound, which is right: that is what makes them
 * looks rather than fonts. But a project has ONE brand colour, and a creator
 * has one idea of how their text should sound, and without these two dials
 * every single apply is followed by the same two manual corrections. Multiply
 * by a hundred presets and the library stops being a library.
 *
 * INHERIT IS THE DEFAULT AND IT IS A REAL POSITION, not an empty field. The
 * switch off means "the preset decides", which is a statement, and it is the
 * one you come back to. Turning it on does not open a form to fill in — it
 * seeds a working value immediately, because a dial that arms into an invalid
 * state is a dial that has to be finished before it does anything.
 *
 * And the dials are BROWSE-time. They change what the next apply writes and
 * what the cards show it would write, then they are out of the loop: a layer
 * that has been styled owns its own colours, and moving this dial later must
 * never reach back and repaint work you have already done.
 */

export function TextLookPrefsBar() {
  const prefs = useWorkspace((s) => s.textLookPrefs);
  const set = useWorkspace((s) => s.setTextLookPrefs);
  const inherited = prefs.color.mode === "inherit" && prefs.sound.mode === "inherit";

  return (
    <div className="flex items-center gap-1 px-1.5 pb-1.5">
      <ColorDial prefs={prefs} set={set} />
      <SoundDial prefs={prefs} set={set} />
      {!inherited && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Use each preset's own colour and sound"
              onClick={() => set(INHERIT_PREFS)}
              className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3"
            >
              <RotateCcw />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back to each preset's own</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

type Setter = (patch: Partial<TextLookPrefs>) => void;

function ColorDial({ prefs, set }: { prefs: TextLookPrefs; set: Setter }) {
  const custom = prefs.color.mode === "custom" ? prefs.color : null;

  return (
    <Dial
      label={custom ? "Colour" : "Preset colour"}
      active={!!custom}
      swatch={custom?.ink}
      icon={<Droplet />}
    >
      <DialHeader
        title="Primary colour"
        hint="Recolours each look's identity — its type, its halo, its outline, its pill — together."
        on={!!custom}
        onToggle={(on) =>
          set({ color: on ? { mode: "custom", ink: "#F5B843", accent: null } : { mode: "inherit" } })
        }
      />
      {custom && (
        <div className="space-y-1 px-2 pb-2">
          <PropRow label="Primary">
            <DocColorInput
              value={custom.ink}
              onChange={(ink) => set({ color: { ...custom, ink } })}
            />
          </PropRow>
          {/* Second colour is opt-in, and absent means "leave the preset's
              own alone" — which is what dropping a brand colour into a
              browser almost always means. A null-able row beats a second
              switch for one field. */}
          <PropRow label="Second" hint="The look's offset shadow, fringe or second word. Off = keep the preset's.">
            {custom.accent === null ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-full justify-start px-2 text-[11px] text-muted-foreground"
                onClick={() => set({ color: { ...custom, accent: "#4CC3E0" } })}
              >
                Preset's own
              </Button>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <DocColorInput
                  value={custom.accent}
                  onChange={(accent) => set({ color: { ...custom, accent } })}
                />
                <button
                  type="button"
                  aria-label="Use the preset's second colour"
                  onClick={() => set({ color: { ...custom, accent: null } })}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3"
                >
                  <RotateCcw />
                </button>
              </div>
            )}
          </PropRow>
        </div>
      )}
    </Dial>
  );
}

function SoundDial({ prefs, set }: { prefs: TextLookPrefs; set: Setter }) {
  const pref = prefs.sound;
  const custom = pref.mode === "custom" ? pref : null;

  const patchVoice = (patch: Partial<SoundVoice>) =>
    custom && set({ sound: { ...custom, voice: { ...custom.voice, ...patch } } });

  return (
    <Dial
      label={pref.mode === "off" ? "Silent" : custom ? "Custom sound" : "Preset sound"}
      active={pref.mode !== "inherit"}
      icon={pref.mode === "off" ? <VolumeX /> : <Volume2 />}
    >
      <DialHeader
        title="Typing sound"
        hint="A per-unit voice, applied to every look — including the ones authored silent."
        on={pref.mode !== "inherit"}
        onToggle={(on) => set({ sound: on ? defaultLookVoice() : { mode: "inherit" } })}
      />
      {pref.mode !== "inherit" && (
        <>
          {/* Silence is its own arm, never a fader at the floor: it has to
              survive switching between looks that do and do not ship a sound,
              and it must not be reachable by dragging a slider too far. */}
          <div className="grid grid-cols-2 gap-1 px-2 pb-1.5">
            <ModeButton
              label="Choose one"
              active={pref.mode === "custom"}
              onClick={() => set({ sound: defaultLookVoice() })}
            />
            <ModeButton
              label="Silent"
              active={pref.mode === "off"}
              onClick={() => set({ sound: { mode: "off" } })}
            />
          </div>
          {custom && (
            <div className="space-y-1 px-2 pb-2">
              <div className="flex items-center gap-1">
                <SoundVoicePicker value={custom.voice} onChange={(p) => patchVoice(p)} />
              </div>
              <SoundVoiceFields
                value={custom.voice}
                scope="look"
                onChange={(p) => patchVoice(p)}
                placement={{
                  anchor: custom.anchor,
                  offsetMs: custom.offsetMs,
                  onChange: (p) => set({ sound: { ...custom, ...p } }),
                }}
              />
            </div>
          )}
        </>
      )}
    </Dial>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * One dial: a chip that READS its own state, and a popover holding the controls.
 *
 * A popover rather than an inline section because these are set rarely and read
 * constantly — the chip is the readout, and spending four rows of a 280px panel
 * on controls nobody is touching would push the grid, which is the thing you
 * came for, off the screen. The body scrolls and is capped against the
 * viewport, so the sound dial's six rows work on a phone as well as a desktop.
 */
function Dial({
  label,
  active,
  swatch,
  icon,
  children,
}: {
  label: string;
  active: boolean;
  swatch?: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-pressed={active}
          className={cn(
            "flex h-6 min-w-0 shrink items-center gap-1.5 rounded-full px-2 text-[10px] font-medium transition-colors outline-none",
            "focus-visible:ring-1 focus-visible:ring-primary/60 [&_svg]:size-3 [&_svg]:shrink-0",
            active
              ? "material-glass-raised text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {swatch ? (
            <span
              className="size-3 shrink-0 rounded-full border border-white/25"
              style={{ background: swatch }}
            />
          ) : (
            icon
          )}
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-64 p-0">
        <ScrollArea className="max-h-[min(60vh,22rem)]">{children}</ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function DialHeader({
  title,
  hint,
  on,
  onToggle,
}: {
  title: string;
  hint: string;
  on: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b px-2 py-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help text-[11px] font-medium decoration-dotted underline-offset-2 hover:underline">
            {title}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{hint}</TooltipContent>
      </Tooltip>
      <span className="ml-auto text-[10px] text-muted-foreground">
        {on ? "Override" : "Inherit"}
      </span>
      <Switch checked={on} aria-label={title} onCheckedChange={onToggle} className="scale-75" />
    </div>
  );
}

function ModeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-6 items-center justify-center rounded-[5px] text-[11px] font-medium transition-colors",
        active ? "material-glass-raised text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
