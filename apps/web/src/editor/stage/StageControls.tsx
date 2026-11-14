"use client";

import * as React from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Grid2x2,
  Magnet,
  Paintbrush2,
  PenTool,
  Ruler,
  Settings2,
  Spline,
  Trash2,
} from "lucide-react";
import type { PreviewQuality } from "@solomotion/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Range } from "@/components/ui/range";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ZoomControl, ZoomPresetList, ZoomReadout } from "@/components/ui/zoom-control";
import { CAMERA_ZOOM } from "../workspace/view-zoom";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePointerEnv } from "../input/pointer-env";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useStageView } from "../state/session";
import { usePanels } from "../state/panels";
import { formatCombo, useCombo } from "../state/shortcut-registry";
import { RulerSettings } from "./RulerSettings";
import { PreviewQualityControl } from "./PreviewQualityControl";
import { CHROME_CAPSULE } from "./StageChrome";
import { FocusModeIcon, ShutterIcon } from "./tool-icons";

/**
 * The stage's view cluster — ONE capsule: how big the canvas is, and how it is
 * being drawn.
 *
 * It has just lost two buttons and is better for it.
 *
 * FULLSCREEN is gone, to the Window menu where the rest of "how much screen
 * does the app get" lives. It is a once-a-session decision with a keyboard
 * shortcut of the browser's own, and it was sitting permanently over the
 * artwork next to focus mode saying almost the same thing twice.
 *
 * MOTION BLUR is gone INTO the settings, because the chip lied about its
 * scope. A shutter control on the canvas reads as the document's motion blur —
 * the thing that will be rendered — and it is nothing of the kind: it is the
 * quality the STAGE previews at, and the exporter never reads it. A control
 * that looks like a render setting and is a preview setting is worse than a
 * buried one; it is now a row in the Preview tab, beside the frame time that
 * explains why you would touch it.
 */

/**
 * ONE recipe for every square button in this capsule — two buttons writing
 * their own class lists is how one capsule ends up with two sizes.
 */
const CHROME_BUTTON =
  "flex aspect-square shrink-0 items-center justify-center rounded-lg transition-colors [&_svg]:size-4";

/** Shared row shape for the settings popover. */
function ToggleRow({
  icon: Icon,
  label,
  checked,
  onChange,
  combo,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  combo?: string | null;
}) {
  return (
    <label className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-1 transition-colors hover:bg-accent/50">
      {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" /> : <span className="size-3.5 shrink-0" />}
      <span className="flex-1 text-xs">{label}</span>
      {combo && <kbd className="rounded bg-secondary px-1 font-mono text-2xs text-muted-foreground">{combo}</kbd>}
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

/**
 * The options a switch owns, shown only while it is on.
 *
 * Not a disabled block at 40% — that was the old shape, and a dimmed control
 * still occupies its full height, still invites a click, and still has to be
 * read past. A setting that does not apply is not a faded setting; it is one
 * that is not there.
 */
function Reveal({ when, children }: { when: boolean; children: React.ReactNode }) {
  if (!when) return null;
  return <div className="space-y-1 border-l border-border/60 pb-1 pl-2 pr-1">{children}</div>;
}


/**
 * The stage's zoom: a number you can DRAG, which opens the dial when you click.
 *
 * It reads as a CHIP now, and that is the whole of the redesign. The readout
 * was an unsized span inside a taller flex row, so it drew a short pill floating
 * in the middle of a control-height capsule — the one element in the top band
 * that did not line up with anything beside it. It is `--control-h` tall like
 * every other inline control in the app, it holds a minimum width so the capsule
 * does not twitch as the percentage goes from 8% to 100%, and it carries the
 * caret that says the click opens something.
 */
function ZoomMenu({ onZoom, onFit }: { onZoom: (s: number) => void; onFit: () => void }) {
  const scale = useStageView((v) => v.scale);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Zoom"
          className="group/zoom flex shrink-0 items-center rounded-lg pr-1 transition-colors hover:bg-accent/60"
          style={{ height: "var(--control-h)" }}
        >
          <ZoomReadout
            value={scale}
            spec={CAMERA_ZOOM}
            scale="log"
            format={CAMERA_ZOOM.format}
            onChange={onZoom}
            onReset={() => onZoom(1)}
            aria-label="Zoom"
            className="flex h-full min-w-9 items-center justify-center bg-transparent px-1 text-xs tabular-nums group-hover/zoom:bg-transparent"
          />
          <ChevronDown className="size-2.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-56 space-y-1 p-2">
        <div className="flex justify-center pb-1">
          <ZoomControl
            value={scale}
            spec={CAMERA_ZOOM}
            scale="log"
            size="sm"
            length={120}
            onChange={onZoom}
            onReset={() => onZoom(1)}
            title="Stage zoom — drag, scroll or ± ; double-click to reset"
            aria-label="Stage zoom"
          />
        </div>
        <div className="pt-1">
          <ZoomPresetList spec={CAMERA_ZOOM} value={scale} onPick={onZoom} onFit={onFit} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Stage settings ──────────────────────────────────────────────────────────

/**
 * THE STAGE SETTINGS POPOVER — three tabs, and it scrolls.
 *
 * It was one flat column of switches with hairlines between them, grown a row
 * at a time until it ran off the bottom of a short window with no scroller —
 * the last rows were genuinely unreachable, not merely awkward. A list that
 * only grows needs a ceiling and a scroller together; either alone is half a
 * fix.
 *
 * The tabs are not decoration on top of that. The rows answer three different
 * questions and had been interleaved by the order they were written in:
 *
 *   VIEW      what is DRAWN over the artwork — rulers, grid, motion paths
 *   GUIDES    the magnet and the lines, which are two features sharing a word
 *   PREVIEW   how hard the stage is working, and what it may spend
 *
 * "Guides" earns its own tab because of the collision the old panel could not
 * express: SMART guides are the snapping magnet, RULER guides are lines you
 * drag out and keep. Turning the rulers off left every line on screen with no
 * control anywhere that could hide them or clear them, because the panel had
 * only one row called "guides" and it belonged to the other feature.
 */
function ViewSettings() {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Stage settings"
              className={cn(CHROME_BUTTON, "text-muted-foreground hover:bg-accent hover:text-foreground")}
              style={{ height: "var(--control-h)" }}
            >
              <Settings2 />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Stage settings</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-64 p-0">
        <Tabs defaultValue="view">
          <div className="border-b p-2">
            <TabsList className="w-full">
              <TabsTrigger value="view" className="flex-1">
                View
              </TabsTrigger>
              <TabsTrigger value="guides" className="flex-1">
                Guides
              </TabsTrigger>
              <TabsTrigger value="preview" className="flex-1">
                Preview
              </TabsTrigger>
            </TabsList>
          </div>
          <ScrollArea className="max-h-[min(24rem,60vh)]">
            <div className="p-2">
              <TabsContent value="view" className="space-y-0.5">
                <ViewTab />
              </TabsContent>
              <TabsContent value="guides" className="space-y-0.5">
                <GuidesTab />
              </TabsContent>
              <TabsContent value="preview" className="space-y-0.5">
                <PreviewTab />
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

/** What the stage draws OVER the artwork, and the hand rest beside it. */
function ViewTab() {
  const rulers = useSession((s) => s.rulers);
  const pixelGrid = useSession((s) => s.pixelGrid);
  const motionPaths = useSession((s) => s.motionPaths);
  const brushHandle = useSession((s) => s.brushHandle);
  const focusMode = usePanels((s) => s.focusMode);
  const focusCombo = useCombo("view.focusMode");
  return (
    <>
      <ToggleRow
        icon={FocusModeIcon}
        label="Focus mode"
        checked={focusMode}
        onChange={(v) => {
          if (v !== usePanels.getState().focusMode) usePanels.getState().toggleFocusMode();
        }}
        combo={focusCombo ? formatCombo(focusCombo) : undefined}
      />
      <ToggleRow icon={Ruler} label="Rulers" checked={rulers} onChange={(v) => useSession.getState().setRulers(v)} />
      <ToggleRow
        icon={Grid2x2}
        label="Pixel grid"
        checked={pixelGrid}
        onChange={(v) => useSession.getState().setPixelGrid(v)}
      />
      <ToggleRow
        icon={Spline}
        label="Motion paths"
        checked={motionPaths}
        onChange={(v) => useSession.getState().setMotionPaths(v)}
      />
      <ToggleRow
        icon={Paintbrush2}
        label="Brush handle"
        checked={brushHandle}
        onChange={(v) => useSession.getState().setBrushHandle(v)}
      />
      <TouchSettingsLink />
    </>
  );
}

/**
 * TWO FEATURES THAT SHARE A WORD, finally in one room and told apart.
 *
 * Smart guides are the MAGNET: nothing is drawn until something snaps. Ruler
 * guides are LINES you place and keep. The old panel had a single row labelled
 * "Smart guides" and nothing at all for the lines, so with the rulers hidden
 * there was no way to hide or clear the guides you had already pulled — the
 * bug this tab exists to close.
 */
function GuidesTab() {
  const guides = useSession((s) => s.guides);
  const settings = useSession((s) => s.guideSettings);
  const rulerGuides = useSession((s) => s.rulerGuides);
  const snapCombo = useCombo("view.snap");

  return (
    <>
      <div className="label-section px-1 pb-1 pt-0.5">Snapping</div>
      <ToggleRow
        icon={Magnet}
        label="Smart guides"
        checked={guides}
        onChange={(v) => useSession.getState().setGuides(v)}
        combo={snapCombo ? formatCombo(snapCombo) : undefined}
      />
      <Reveal when={guides}>
        <Range
          value={settings.thresholdPx}
          min={2}
          max={40}
          step={1}
          label="Strength"
          unit="px"
          precision={0}
          defaultValue={8}
          onChange={(v) => useSession.getState().setGuideSettings({ thresholdPx: v })}
        />
        <ToggleRow
          label="Layers"
          checked={settings.toLayers}
          onChange={(v) => useSession.getState().setGuideSettings({ toLayers: v })}
        />
        <ToggleRow
          label="Page edges"
          checked={settings.toPageEdges}
          onChange={(v) => useSession.getState().setGuideSettings({ toPageEdges: v })}
        />
        <ToggleRow
          label="Page centre"
          checked={settings.toPageCenter}
          onChange={(v) => useSession.getState().setGuideSettings({ toPageCenter: v })}
        />
      </Reveal>

      <div className="label-section px-1 pb-1 pt-3">Guide lines</div>
      <ToggleRow
        icon={Ruler}
        label="Show guides"
        checked={rulerGuides}
        onChange={(v) => useSession.getState().setRulerGuides(v)}
      />
      <Reveal when={rulerGuides}>
        {/* The unit, the default colour and style, and snap-to-guides — the
            exact panel a ruler's right-click opens. One editor, two doors. */}
        <div className="pt-1">
          <RulerSettings />
        </div>
      </Reveal>
      <ClearGuides />
    </>
  );
}

/**
 * Clear the guides on the artboard you are looking at.
 *
 * SCOPED to one artboard, and shown only when that artboard has guides. They
 * are frame-local by design (they ride the board when it moves), so an
 * app-wide "clear all" would silently wipe boards you cannot see — the kind of
 * destructive reach that has to be asked for, not offered on a popover. The
 * count is in the label so pressing it is never a guess.
 */
function ClearGuides() {
  const doc = useDoc();
  const store = useDocStore();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const frame = doc.frames.find((f) => f.id === activeFrameId) ?? doc.frames[0];
  const count = frame?.guides.length ?? 0;
  if (!frame || count === 0) return null;
  return (
    <button
      type="button"
      onClick={() =>
        store.update("Clear guides", (d) => {
          const f = d.frames.find((fr) => fr.id === frame.id);
          if (f) f.guides = [];
        })
      }
      className="mt-1 flex h-7 w-full items-center gap-2 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
    >
      <Trash2 className="size-3.5 shrink-0" />
      <span className="flex-1 text-left">Clear {count === 1 ? "1 guide" : `${count} guides`}</span>
    </button>
  );
}

const SHUTTER_OPTIONS: Array<{ value: PreviewQuality | "auto"; label: string; hint: string }> = [
  { value: "auto", label: "Auto", hint: "Lower it when the frame gets expensive" },
  { value: "full", label: "Full", hint: "Every sample, whatever it costs" },
  { value: "fast", label: "Fast", hint: "Fewer samples" },
  { value: "off", label: "Off", hint: "No blur on the stage" },
];

/**
 * WHAT THE STAGE COSTS, and the one thing you can spend less on.
 *
 * Motion blur lives here now, and the heading says the thing the chip on the
 * canvas could not: this is the PREVIEW. The export renders its own blur from
 * the document and never reads this value, so a control that looked like a
 * render setting was teaching something false about what the file contains.
 *
 * The governor's own decision is reported in the same place rather than only as
 * a colour on a chip — "the app lowered this for you" is a fact about the
 * picture on screen and belongs beside the frame time that explains it.
 */
function PreviewTab() {
  const quality = useSession((s) => s.motionBlurQuality);
  const actual = useSession((s) => s.motionBlurActual);
  const perfHud = useSession((s) => s.perfHud);
  const degraded = quality === "auto" && actual.degraded;
  const effective: PreviewQuality = quality === "auto" ? actual.quality : quality;

  return (
    <>
      <div className="label-section px-1 pb-1 pt-0.5">Motion blur on the stage</div>
      <div className="space-y-0.5">
        {SHUTTER_OPTIONS.map((o) => {
          const on = quality === o.value;
          return (
            <Tooltip key={o.value}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => useSession.getState().setMotionBlurQuality(o.value)}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 rounded-md px-1 text-left text-xs transition-colors",
                    on ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <ShutterIcon
                    trail={o.value === "off" ? 0 : o.value === "fast" ? 1 : 2}
                    className="size-3.5 shrink-0"
                  />
                  <span className="flex-1">{o.label}</span>
                  {on && degraded && <span className="text-2xs text-warning">now {effective}</span>}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{o.hint}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="label-section px-1 pb-1 pt-3">Cost</div>
      <div className="flex h-7 items-center gap-2 px-1">
        <Activity className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-xs">Frame</span>
        <span className="font-mono text-xs tabular-nums text-foreground/90">
          {actual.frameMs > 0 ? `${actual.frameMs.toFixed(1)} ms` : "—"}
        </span>
      </div>
      <ToggleRow label="Per-layer cost" checked={perfHud} onChange={(v) => useSession.getState().setPerfHud(v)} />
    </>
  );
}

/**
 * THE WAY INTO TOUCH & PEN, on the device that needs it.
 *
 * The switches that decide what a finger does are five taps deep, behind a tab
 * strip that scrolls on a phone. That is fine for a preference you set once on
 * a desktop and wrong for the one you want the moment the app does something
 * you did not expect — which, on touch, is exactly when you want it. It goes
 * straight to the tab: a door that promises gesture options and delivers a
 * dialog to search through has not answered.
 *
 * Shown only where touch is the primary pointer. On a desktop it is a row for a
 * page nobody there opens.
 */
function TouchSettingsLink() {
  const env = usePointerEnv();
  if (!env.primaryCoarse) return null;
  return (
    <button
      type="button"
      onClick={() => useSession.getState().openSettingsAt("touch")}
      className="flex h-7 w-full items-center gap-2 rounded-md px-1 text-xs transition-colors hover:bg-accent/50"
    >
      <PenTool className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 text-left">Touch &amp; pen</span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

export function StageControls({
  onZoom,
  onFit,
}: {
  /** Set the stage scale, anchored at the viewport center. */
  onZoom: (scale: number) => void;
  /** Reset — fit all content. */
  onFit: () => void;
}) {
  return (
    <div className={CHROME_CAPSULE}>
      {/* How big the canvas is, then how TRUE it is — the two questions about
          what you are looking at, beside each other. No hairlines between
          them: four controls in one capsule already read as one group.
          Focus mode lives in Stage settings ▸ View (and on ⌘\\) — a switch you
          flip once a session did not earn a permanent button here. */}
      <ZoomMenu onZoom={onZoom} onFit={onFit} />
      <PreviewQualityControl />
      <ViewSettings />
    </div>
  );
}
