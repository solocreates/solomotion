"use client";

import { identity } from "@/editor/identity";
import { product } from "@/editor/product";
import * as React from "react";
import { Check, Download, ExternalLink, Hand, Monitor, Moon, PenLine, RotateCcw, Sun, Upload } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { ColorInput } from "@/components/ui/color-picker";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Range } from "@/components/ui/range";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { KeyCaps } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  LIMIT_DEFAULT,
  LIMIT_UNLIMITED,
  UNKNOWN_KIND,
  effectiveLimit,
  fixedLimit,
  taskKinds,
  type TaskLimit,
} from "@solomotion/core";
import { useSession } from "../state/session";
import { useSafety } from "../runtime/safety-store";
import { APP_VERSION } from "../version";
import { modifierLabel } from "../state/drag-modifiers";
import { puckStore, usePuckState } from "../input/puck-store";
import { usePointerEnv } from "../input/pointer-env";
import {
  ACT_LABELS,
  AUTHORITY_DEFAULTS,
  usePointerAuthority,
  type FingerCanvasMode,
  type PointerAct,
  type TouchRule,
} from "../input/pointer-authority";
import { useTheme } from "../theme/use-theme";
import { DENSITY_OPTIONS, RADIUS_MAX, RADIUS_MIN, SCALE_MAX, SCALE_MIN } from "../theme/theme-tokens";
import { resolveCssColor } from "../theme/resolve-color";
import {
  compile,
  fontDef,
  FONTS,
  fontStack,
  listPresets,
  PART_DIALECTS,
  PART_NAMES,
  previewStyle,
  type LabelStyle,
  type PartName,
  type Theme,
} from "@solomotion/theme";
import { Segmented } from "@/components/ui/segmented";
import {
  commandForCombo,
  comboFromEvent,
  formatCombo,
  isOverridden,
  resetAllShortcuts,
  setCombo,
  useShortcutValue,
  useCombo,
  SHORTCUT_DEFS,
  activeKeymapId,
  isFromKeymap,
  setKeymap,
  activeWorldKeymapId,
  setWorldKeymap,
  worldComboFromEvent,
  WORLD_SHORTCUT_DEFS,
  WORLD_KEYMAPS,
} from "../state/shortcut-registry";
import { KEYMAPS } from "../state/keymaps";
import { KEYMAP_LOGOS } from "../menus/keymap-logos";
import { useUpdate } from "../update";
import { McpDialog } from "../agent/ui/McpDialog";
import { Disclosure, Row, Section, SettingsNavContext, SettingsPage } from "./kit";


// ── Appearance ───────────────────────────────────────────────────────────────

const MODE_OPTIONS = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
] as const;

const LABEL_OPTIONS: ReadonlyArray<{ value: LabelStyle; label: string }> = [
  { value: "upper", label: "CAPS" },
  { value: "title", label: "As written" },
  { value: "lower", label: "lower" },
  { value: "var", label: "--var" },
];

const PART_LABELS: Record<PartName, string> = {
  range: "Amounts",
  measure: "Measures",
  switch: "Switches",
  tabs: "Tabs",
  button: "Buttons",
  field: "Fields",
  menu: "Menus",
  tools: "Tool rail",
  backdrop: "Stage",
  heads: "Section heads",
};

const FONT_SLOTS: ReadonlyArray<{ slot: "ui" | "display" | "num" | "mono"; label: string; kinds: ReadonlyArray<string> }> = [
  { slot: "ui", label: "Interface", kinds: ["sans", "display"] },
  { slot: "display", label: "Display", kinds: ["sans", "display", "mono"] },
  { slot: "num", label: "Numbers", kinds: ["sans", "mono", "display"] },
  { slot: "mono", label: "Code", kinds: ["mono"] },
];

const NEUTRAL_FIELDS: ReadonlyArray<{ key: "bg" | "panel" | "raised" | "fg" | "muted"; label: string }> = [
  { key: "bg", label: "Ground" },
  { key: "panel", label: "Panel" },
  { key: "raised", label: "Raised" },
  { key: "fg", label: "Ink" },
  { key: "muted", label: "Quiet ink" },
];

/**
 * Tier 1 of the whole dialog: "switch the look", "make it bigger". The look is
 * a gallery of real previews, mode sits beside it, and everything a theme
 * file holds is one disclosure down, ending in import and export.
 */
export function AppearancePage() {
  const presetId = useTheme((s) => s.presetId);
  const theme = useTheme((s) => s.theme);
  const activeMode = useTheme((s) => s.activeMode);
  const mode = useTheme((s) => s.mode);
  const colors = useTheme((s) => s.colors);
  const scale = useTheme((s) => s.scale);
  const glass = useTheme((s) => s.glass);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const presets = listPresets();
  const t = useTheme.getState;

  const onExport = () => {
    const json = t().exportTheme();
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${theme.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "theme"}.theme.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Theme exported");
  };
  const onImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = t().importTheme(String(reader.result ?? ""));
      if (r.ok) toast.success("Theme imported");
      else toast.error(r.error);
    };
    reader.readAsText(file);
  };

  return (
    <SettingsPage id="appearance" title="Appearance">
      <Section>
        <Row label="Look" keywords="theme dark light colours preset" wide>
          <div className="grid w-full grid-cols-2 gap-2 @[30rem]:grid-cols-3">
            {presets.map((p) => (
              <ThemeCard key={p.theme.id} theme={p.theme} mode={activeMode} active={presetId === p.theme.id} onPick={() => t().applyPreset(p.theme.id)} />
            ))}
            {presetId === "custom" && <ThemeCard theme={theme} mode={activeMode} active onPick={() => {}} />}
          </div>
        </Row>
        <Row label="Mode" keywords="dark light system appearance">
          <Segmented value={mode} onChange={(v) => t().setMode(v)} options={MODE_OPTIONS} aria-label="Mode" />
        </Row>
        <Row label="Accent" keywords="colour color highlight">
          <ColorInput className="w-full" value={colors.primary} onChange={(v) => t().setAccent(v)} />
        </Row>
      </Section>

      <Section title="Interface">
        <Row label="Interface size" keywords="ui scale zoom bigger smaller" hint="Sizes all chrome. The canvas and timeline keep their true pixels.">
          <Range
            className="w-full"
            kind="measure"
            value={scale}
            min={SCALE_MIN}
            max={SCALE_MAX}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            defaultValue={1}
            onChange={(v) => t().setScale(Number(v.toFixed(2)))}
          />
        </Row>
        <Row label="Density" hint="Height of every field, button and slider.">
          <Segmented
            value={String(DENSITY_OPTIONS.find((d) => d.id === theme.density)?.id ?? 28)}
            onChange={(v) => t().setDensity(Number(v))}
            options={DENSITY_OPTIONS.map((d) => ({ value: String(d.id), label: d.label }))}
            aria-label="Density"
          />
        </Row>
        <Row label="Roundness" keywords="radius corners" hint="The largest corner. Menus, controls and chips are graded from it.">
          <Range className="w-full" kind="measure" value={theme.radius} min={RADIUS_MIN} max={RADIUS_MAX} step={1} unit="px" onChange={(v) => t().setRadius(v)} />
        </Row>
        <Row label="Transparency" keywords="glass blur frosted" hint="Frosted glass on canvas chrome. Costs GPU time; dropped automatically during playback.">
          <Switch checked={glass} onCheckedChange={(v) => t().setGlass(v)} />
        </Row>
      </Section>

      <Disclosure label="Customise the theme">
        <Section title="Type">
          {FONT_SLOTS.map((f) => (
            <Row key={f.slot} label={f.label} keywords="font typeface">
              <Select value={fontDef(theme.font[f.slot]) ? theme.font[f.slot] : "custom"} onValueChange={(v) => v !== "custom" && t().setFont(f.slot, v)}>
                <SelectTrigger className="w-44 max-w-full" style={{ fontFamily: fontStack(theme.font[f.slot]) }}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONTS.filter((x) => f.kinds.includes(x.kind)).map((x) => (
                    <SelectItem key={x.id} value={x.id} style={{ fontFamily: fontStack(x.id) }}>
                      {x.label}
                    </SelectItem>
                  ))}
                  {!fontDef(theme.font[f.slot]) && <SelectItem value="custom">Custom</SelectItem>}
                </SelectContent>
              </Select>
            </Row>
          ))}
          <Row label="Labels" keywords="caps uppercase case">
            <Segmented value={theme.labels} onChange={(v) => t().setLabels(v)} options={LABEL_OPTIONS} aria-label="Labels" />
          </Row>
        </Section>
        <Section title="Parts">
          {PART_NAMES.map((part) => (
            <Row key={part} label={PART_LABELS[part]} keywords="dialect style part">
              <Select value={theme.parts[part]} onValueChange={(v) => t().setPart(part, v as never)}>
                <SelectTrigger className="w-44 max-w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PART_DIALECTS[part].map((d) => (
                    <SelectItem key={d} value={d}>
                      {d[0]!.toUpperCase() + d.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          ))}
        </Section>
        <Section title={activeMode === "dark" ? "Dark colours" : "Light colours"}>
          {NEUTRAL_FIELDS.map((f) => (
            <Row key={f.key} label={f.label} keywords="colour color neutral">
              <ColorInput className="w-full" value={resolveCssColor(theme.neutral[activeMode][f.key])} onChange={(v) => t().setNeutral(f.key, v)} />
            </Row>
          ))}
        </Section>
        <Row label="Theme file" keywords="import export reset json">
          <div className="flex gap-1">
            <Button variant="ghost" size="xs" onClick={() => fileRef.current?.click()}>
              <Upload /> Import
            </Button>
            <Button variant="ghost" size="xs" onClick={onExport}>
              <Download /> Export
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                t().reset();
                toast("Theme reset");
              }}
            >
              <RotateCcw /> Reset
            </Button>
          </div>
        </Row>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImport(file);
            e.target.value = "";
          }}
        />
      </Disclosure>
    </SettingsPage>
  );
}

/**
 * A look, previewed in itself: its own ground, panel, ink, accent and type,
 * scoped to the card by the compiled variables (dialects stay the page's —
 * they are keyed on the root by design).
 */
function ThemeCard({ theme, mode, active, onPick }: { theme: Theme; mode: "dark" | "light"; active: boolean; onPick: () => void }) {
  const style = React.useMemo(() => previewStyle(compile(theme, mode)), [theme, mode]);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={cn("group flex flex-col gap-1.5 rounded-lg p-1.5 text-left transition-colors", active ? "bg-selection" : "hover:bg-hover")}
    >
      <div style={style} className="flex h-14 w-full overflow-hidden rounded-md border border-line bg-background text-foreground">
        <div className="flex w-1/3 flex-col justify-end gap-1 bg-panel p-1.5">
          <span className="h-1 w-3/4 rounded-full bg-fg-faint" />
          <span className="h-1 w-1/2 rounded-full bg-primary" />
        </div>
        <div className="flex flex-1 flex-col justify-between p-1.5" style={{ fontFamily: "var(--font-display)" }}>
          <span className="truncate text-body">Aa</span>
          <span className="flex items-center justify-between gap-1">
            <span className="text-meta text-fg-muted" style={{ fontFamily: "var(--font-num)" }}>
              01:24
            </span>
            <span className="h-2 w-5 rounded-[2px] bg-primary" />
          </span>
        </div>
      </div>
      <span className={cn("flex items-center justify-between px-0.5 text-body", active ? "text-selection-fg" : "text-fg")}>
        <span className="truncate">{theme.name}</span>
        {active && <Check className="size-3.5 shrink-0" />}
      </span>
    </button>
  );
}

// ── Canvas ───────────────────────────────────────────────────────────────────

export function CanvasPage() {
  const focusStage = useSession((s) => s.focusStage);
  const nativeLock = useSession((s) => s.nativeResizeLockAspect);
  const scaleLock = useSession((s) => s.scaleLockAspect);
  return (
    <SettingsPage id="canvas" title="Canvas">
      <Section title="Selection">
        <Row label="Bring selection into view" keywords="focus frame pan" hint="Selecting a layer pans and zooms the canvas to it — only when it is off screen.">
          <Switch checked={focusStage} onCheckedChange={(v) => useSession.getState().setFocusStage(v)} />
        </Row>
      </Section>
      <Section title="Resizing">
        <Row label="Keep proportions: shapes & text" keywords="aspect ratio lock" hint="Off: drag a handle to stretch, ⇧ keeps proportions. On: the reverse.">
          <Switch checked={nativeLock} onCheckedChange={(v) => useSession.getState().setNativeResizeLockAspect(v)} />
        </Row>
        <Row label="Keep proportions: media & groups" keywords="aspect ratio lock image video" hint="On: pixels never distort, ⇧ stretches. Off: scale freely.">
          <Switch checked={scaleLock} onCheckedChange={(v) => useSession.getState().setScaleLockAspect(v)} />
        </Row>
      </Section>
    </SettingsPage>
  );
}

// ── Timeline & playback ──────────────────────────────────────────────────────

export function TimelinePage() {
  const focusTime = useSession((s) => s.focusTime);
  const autoDeleteEmptyTracks = useSession((s) => s.autoDeleteEmptyTracks);
  const clipPreviews = useSession((s) => s.clipPreviews);
  const tabsFollowActivePage = useSession((s) => s.tabsFollowActivePage);
  const mergeMarkers = useSession((s) => s.mergeMarkers);
  const dragOutModifier = useSession((s) => s.dragOutModifier);
  const snapping = useSession((s) => s.snapping);
  const snap = useSession((s) => s.snapSettings);
  const setSnap = useSession((s) => s.setSnapSettings);
  return (
    <SettingsPage id="timeline" title="Timeline & playback">
      <Section title="Timeline">
        <Row label="Clip previews" keywords="filmstrip thumbnails" hint="Pictures on each clip's bar. Off frees the cached pictures at once.">
          <Switch checked={clipPreviews} onCheckedChange={(v) => useSession.getState().setClipPreviews(v)} />
        </Row>
        <Row label="Scroll to the selection" keywords="focus" hint="Selecting a clip scrolls it into view — only when it is off screen.">
          <Switch checked={focusTime} onCheckedChange={(v) => useSession.getState().setFocusTime(v)} />
        </Row>
        <Row label="Remove empty tracks" hint="When the last clip leaves a track, remove it. Tracks you add with + Track stay.">
          <Switch checked={autoDeleteEmptyTracks} onCheckedChange={(v) => useSession.getState().setAutoDeleteEmptyTracks(v)} />
        </Row>
        <Row label="Markers from nested comps" keywords="global markers" hint="Show every parent and nested comp's markers on each timeline. Editing still moves the original.">
          <Switch checked={mergeMarkers} onCheckedChange={(v) => useSession.getState().setMergeMarkers(v)} />
        </Row>
        <Row label="Timeline tabs follow the page" hint="On: only timelines from the page you're on (pinned tabs stay). Off: tabs are global.">
          <Switch checked={tabsFollowActivePage} onCheckedChange={(v) => useSession.getState().setTabsFollowActivePage(v)} />
        </Row>
        <Row label="Drag out of a group with" keywords="modifier key" hint="Hold this key to let a dragged clip leave its group's band.">
          <ToggleGroup type="single" value={dragOutModifier} onValueChange={(v) => v && useSession.getState().setDragOutModifier(v as "meta" | "alt" | "shift")}>
            {(["meta", "alt", "shift"] as const).map((m) => (
              <ToggleGroupItem key={m} value={m} className="px-2.5">
                {modifierLabel(m)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Row>
      </Section>
      <Section title="Snapping">
        <Row label="Snap" keywords="magnet" hint="Clips, playhead and keyframes snap while you drag.">
          <Switch checked={snapping} onCheckedChange={(v) => useSession.getState().setSnapping(v)} />
        </Row>
        <Row label="Snap distance" hint="How close before it grabs.">
          <NumberInput value={snap.thresholdPx} min={2} max={40} precision={0} unit="px" className="w-24" onChange={(v) => setSnap({ thresholdPx: Math.round(v) })} />
        </Row>
        <Disclosure label="Snap targets">
          <Row label="Clip edges" keywords="snap">
            <Switch checked={snap.toClips} onCheckedChange={(v) => setSnap({ toClips: v })} />
          </Row>
          <Row label="Keyframes" keywords="snap">
            <Switch checked={snap.toKeyframes} onCheckedChange={(v) => setSnap({ toKeyframes: v })} />
          </Row>
          <Row label="Playhead" keywords="snap">
            <Switch checked={snap.toPlayhead} onCheckedChange={(v) => setSnap({ toPlayhead: v })} />
          </Row>
        </Disclosure>
      </Section>
    </SettingsPage>
  );
}

// ── Input: touch & pen, then shortcuts ───────────────────────────────────────

type TouchChoice = "recommended" | "finger" | "custom";

/**
 * TOUCH & PEN — one choice, not a table (D14). The two presets set the same
 * stores the table does (`pointer-authority`); anything else IS custom, and
 * the per-act table lives behind "Custom ▸". On a device with no touch screen
 * the whole thing is one line you can still open.
 */
function TouchAndPen() {
  const env = usePointerEnv();
  const penMode = usePointerAuthority((t) => t.mode);
  const fingerCanvas = usePointerAuthority((t) => t.fingerCanvas);
  const touch = usePointerAuthority((t) => t.touch);
  const customised = (Object.keys(AUTHORITY_DEFAULTS) as PointerAct[]).some((a) => touch[a] !== AUTHORITY_DEFAULTS[a]);
  const choice: TouchChoice =
    fingerCanvas === "tool" && !customised && penMode === "auto"
      ? "recommended"
      : fingerCanvas === "tool" && penMode === "off"
        ? "finger"
        : "custom";
  const [customOpen, setCustomOpen] = React.useState(choice === "custom");
  const hasTouch = env.primaryCoarse || env.touchPoints > 0;
  const [showAnyway, setShowAnyway] = React.useState(false);

  const pick = (c: TouchChoice) => {
    const a = usePointerAuthority.getState();
    if (c === "recommended") {
      a.setMode("auto");
      a.setFingerCanvas("tool");
      a.resetTouchRules();
      setCustomOpen(false);
    } else if (c === "finger") {
      a.setMode("off");
      a.setFingerCanvas("tool");
      setCustomOpen(false);
    } else setCustomOpen(true);
  };

  if (!hasTouch && !showAnyway) {
    return (
      <Section title="Touch & pen">
        <Row label="No touch screen on this device" keywords="touch pen stylus pencil">
          <Button variant="ghost" size="xs" onClick={() => setShowAnyway(true)}>
            Show settings
          </Button>
        </Row>
      </Section>
    );
  }

  const cards: Array<{ id: TouchChoice; icon: React.ReactNode; title: string; meta: string }> = [
    { id: "recommended", icon: <PenLine />, title: "Pen draws, finger moves the canvas", meta: "Recommended" },
    { id: "finger", icon: <Hand />, title: "Finger draws too", meta: "No stylus" },
  ];

  return (
    <Section title="Touch & pen">
      <Row label="How your hands work" keywords="touch pen stylus pencil finger palm" wide>
        <div role="radiogroup" aria-label="Touch and pen" className="grid w-full grid-cols-1 gap-2 @[30rem]:grid-cols-2">
          {cards.map((c) => {
            const on = choice === c.id;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => pick(c.id)}
                className={cn(
                  "flex items-center gap-3 rounded-lg p-3 text-left transition-colors @[30rem]:flex-col @[30rem]:items-start",
                  on ? "bg-selection" : "bg-raised hover:bg-hover",
                )}
              >
                <span className={cn("flex size-8 items-center justify-center rounded-md [&_svg]:size-5", on ? "text-selection-fg" : "text-fg-muted")}>{c.icon}</span>
                <span className="flex min-w-0 flex-col">
                  <span className={cn("text-label", on ? "text-selection-fg" : "text-fg")}>{c.title}</span>
                  <span className="text-meta text-fg-faint">{c.meta}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Row>
      <Disclosure label={choice === "custom" ? "Customised" : "Customise"} open={customOpen} onOpenChange={setCustomOpen}>
        <TouchTable />
      </Disclosure>
    </Section>
  );
}

/** Today's per-act table, unchanged in what it sets. */
function TouchTable() {
  const { mode } = usePuckState();
  const env = usePointerEnv();
  const penMode = usePointerAuthority((t) => t.mode);
  const penSeen = usePointerAuthority((t) => t.penSeen);
  const restricted = usePointerAuthority((t) => t.restricted());
  const fingerCanvas = usePointerAuthority((t) => t.fingerCanvas);
  const fingerWorld = usePointerAuthority((t) => t.fingerWorld);
  const tapUndo = usePointerAuthority((t) => t.tapUndo);
  const longPressMenu = usePointerAuthority((t) => t.longPressMenu);
  const touch = usePointerAuthority((t) => t.touch);
  const fingerModes = (
    <>
      <ToggleGroupItem value="tool">Tool</ToggleGroupItem>
      <ToggleGroupItem value="hold">Hold</ToggleGroupItem>
      <ToggleGroupItem value="navigate">Navigate</ToggleGroupItem>
    </>
  );
  return (
    <>
      <Row
        label="Draw with pen only"
        keywords="stylus"
        hint={`Auto turns it on where touch is the main pointer and a stylus has been used. In force here: ${restricted ? "on" : "off"}${penSeen ? ", stylus seen" : ", no stylus yet"}.`}
      >
        <ToggleGroup type="single" value={penMode} onValueChange={(v) => v && usePointerAuthority.getState().setMode(v as "auto" | "on" | "off")}>
          <ToggleGroupItem value="auto">Auto</ToggleGroupItem>
          <ToggleGroupItem value="on">On</ToggleGroupItem>
          <ToggleGroupItem value="off">Off</ToggleGroupItem>
        </ToggleGroup>
      </Row>
      {(Object.keys(AUTHORITY_DEFAULTS) as PointerAct[]).map((act) => (
        <Row key={act} label={`Finger: ${ACT_LABELS[act].title.toLowerCase()}`} hint={ACT_LABELS[act].hint}>
          <ToggleGroup type="single" value={touch[act]} onValueChange={(v) => v && usePointerAuthority.getState().setTouchRule(act, v as TouchRule)}>
            <ToggleGroupItem value="always">Always</ToggleGroupItem>
            <ToggleGroupItem value="no-pen">No pen</ToggleGroupItem>
            <ToggleGroupItem value="never">Never</ToggleGroupItem>
          </ToggleGroup>
        </Row>
      ))}
      <Row label="One finger on the canvas" hint="Tool: the armed tool. Hold: pause before dragging. Navigate: one finger pans.">
        <ToggleGroup type="single" value={fingerCanvas} onValueChange={(v) => v && usePointerAuthority.getState().setFingerCanvas(v as FingerCanvasMode)}>
          {fingerModes}
        </ToggleGroup>
      </Row>
      <Row label="One finger in 3D" hint="Navigate: drag turns the view. Hold: pause, then box-select. Tool: the armed tool.">
        <ToggleGroup type="single" value={fingerWorld} onValueChange={(v) => v && usePointerAuthority.getState().setFingerWorld(v as FingerCanvasMode)}>
          {fingerModes}
        </ToggleGroup>
      </Row>
      <Row label="Two-finger tap undoes" hint="Two fingers undo, three redo.">
        <Switch checked={tapUndo} onCheckedChange={(v) => usePointerAuthority.getState().setTapUndo(v)} />
      </Row>
      <Row label="Press and hold opens the menu" keywords="long press right-click">
        <Switch checked={longPressMenu} onCheckedChange={(v) => usePointerAuthority.getState().setLongPressMenu(v)} />
      </Row>
      <Row
        label="Modifier puck"
        keywords="shift alt cmd keys"
        hint={`A floating ⇧ ⌥ ⌘ pad for devices with no keyboard. This device: ${[
          env.primaryCoarse ? "touch-first" : "pointer-first",
          env.fine && "fine pointer",
          env.hover && "hover",
          env.touchPoints > 1 && `${env.touchPoints} touch points`,
        ]
          .filter(Boolean)
          .join(", ")}.`}
      >
        <ToggleGroup type="single" value={mode} onValueChange={(v) => v && puckStore.setMode(v as "auto" | "on" | "off")}>
          <ToggleGroupItem value="auto">Auto</ToggleGroupItem>
          <ToggleGroupItem value="on">On</ToggleGroupItem>
          <ToggleGroupItem value="off">Off</ToggleGroupItem>
        </ToggleGroup>
      </Row>
      <Row label="Restore touch defaults">
        <Button variant="ghost" size="xs" onClick={() => usePointerAuthority.getState().resetTouchRules()}>
          Reset
        </Button>
      </Row>
    </>
  );
}

/**
 * Keymap presets as cards: the one choice here that changes forty things at
 * once. No vendor logos beyond the keymap's own mark.
 */
function KeymapPicker() {
  const active = useShortcutValue(activeKeymapId);
  return (
    <div role="radiogroup" aria-label="Shortcut set" className="grid w-full grid-cols-2 gap-2 @[30rem]:grid-cols-4">
      {KEYMAPS.map((km) => {
        const on = km.id === active;
        const logo = KEYMAP_LOGOS[km.id];
        return (
          <button
            key={km.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => {
              setKeymap(km.id);
              toast(`${km.label} shortcuts — your own edits are kept`);
            }}
            className={cn("flex flex-col items-center gap-2 rounded-lg px-2 py-3 transition-colors", on ? "bg-selection" : "bg-raised hover:bg-hover")}
          >
            {logo ? (
              <svg viewBox="0 0 24 24" aria-hidden className="size-6" style={{ fill: km.tint }}>
                <path d={logo} />
              </svg>
            ) : (
              <product.Mark className="size-6" />
            )}
            <span className={cn("max-w-full truncate text-label", on ? "text-selection-fg" : "text-fg")}>{km.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function WorldKeymapPicker() {
  const active = useShortcutValue(activeWorldKeymapId);
  return (
    <ToggleGroup
      type="single"
      value={active}
      onValueChange={(v) => {
        if (!v) return;
        setWorldKeymap(v as (typeof WORLD_KEYMAPS)[number]["id"]);
      }}
    >
      {WORLD_KEYMAPS.map((km) => (
        <ToggleGroupItem key={km.id} value={km.id} className="px-2.5">
          {km.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Shortcuts() {
  const nav = React.useContext(SettingsNavContext);
  const groups = [...new Set(SHORTCUT_DEFS.map((d) => d.group))];
  const worldGroups = [...new Set(WORLD_SHORTCUT_DEFS.map((d) => d.group))];
  // Typing a command's name in the settings search finds its shortcut; the
  // full list otherwise sits one click down, so the page opens on the presets.
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Section
        title="Keyboard shortcuts"
        aside={
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              resetAllShortcuts();
              toast("Your edits cleared — back to the keymap's own bindings");
            }}
          >
            <RotateCcw /> Clear my edits
          </Button>
        }
      >
        <Row label="Shortcut set" keywords="keymap premiere after effects resolve figma" wide>
          <KeymapPicker />
        </Row>
        <Row label="3D viewport keys" keywords="blender keymap" hint="Keys go to the 3D viewport while the pointer is over it.">
          <WorldKeymapPicker />
        </Row>
        <Disclosure label="All shortcuts" open={open || nav.query.trim() !== ""} onOpenChange={setOpen}>
          {groups.map((group) => (
            <Section key={group} title={group}>
              {SHORTCUT_DEFS.filter((d) => d.group === group).map((def) => (
                <Row key={def.id} label={def.label} keywords="shortcut key">
                  <ShortcutKey id={def.id} label={def.label} />
                </Row>
              ))}
            </Section>
          ))}
          {worldGroups.map((group) => (
            <Section key={group} title={group}>
              {WORLD_SHORTCUT_DEFS.filter((d) => d.group === group).map((def) => {
                const label = def.mode === "edit" ? `${def.label} · edit mode` : def.label;
                return (
                  <Row key={def.id} label={label} keywords="shortcut key 3d">
                    <ShortcutKey id={def.id} label={label} />
                  </Row>
                );
              })}
            </Section>
          ))}
        </Disclosure>
      </Section>
    </>
  );
}

function ShortcutKey({ id, label }: { id: string; label: string }) {
  const combo = useCombo(id);
  const [recording, setRecording] = React.useState(false);
  const overridden = useShortcutValue(() => isOverridden(id));
  const fromKeymap = useShortcutValue(() => isFromKeymap(id));
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setRecording(false);
    const next = id.startsWith("world.") ? worldComboFromEvent(e.nativeEvent) : comboFromEvent(e);
    if (!next) return;
    const conflict = commandForCombo(next, id);
    if (conflict) {
      toast.error(`${formatCombo(next)} is taken by “${conflict.label}”`);
      return setRecording(false);
    }
    setCombo(id, next);
    setRecording(false);
  };
  return (
    <div className="group/sc flex items-center gap-1">
      {overridden && !recording && (
        <button
          type="button"
          aria-label={`Reset ${label} shortcut`}
          title="Reset to the keymap's binding"
          className="flex size-6 items-center justify-center rounded-sm text-fg-faint opacity-0 hover:bg-hover hover:text-fg group-hover/sc:opacity-100 [&_svg]:size-3.5"
          onClick={() => setCombo(id, null)}
        >
          <RotateCcw />
        </button>
      )}
      <button
        type="button"
        {...(recording ? { "data-capture-keys": "" } : {})}
        title={fromKeymap ? "Set by the shortcut set" : overridden ? "Your binding" : undefined}
        onClick={() => setRecording(true)}
        onKeyDown={onKeyDown}
        onBlur={() => setRecording(false)}
        className={cn(
          "flex h-(--control-h) min-w-16 items-center justify-center gap-1 rounded-md px-1.5 transition-colors",
          recording ? "text-body text-primary ring-1 ring-primary" : "hover:bg-hover",
          overridden && !recording && "text-selection-fg",
        )}
      >
        {recording ? "Press keys…" : <KeyCaps combo={formatCombo(combo)} />}
      </button>
    </div>
  );
}

export function InputPage() {
  return (
    <SettingsPage id="input" title="Input">
      <TouchAndPen />
      <Shortcuts />
    </SettingsPage>
  );
}

// ── Agents & AI ──────────────────────────────────────────────────────────────

export function AgentsPage() {
  const [mcpOpen, setMcpOpen] = React.useState(false);
  return (
    <SettingsPage id="agents" title="Agents & AI">
      <Section>
        <Row label="Use your agent app" keywords="mcp claude codex cursor link" hint="Connect Claude, Codex or another MCP app so it can work in this project.">
          <Button variant="secondary" size="xs" onClick={() => setMcpOpen(true)}>
            Set up…
          </Button>
        </Row>
      </Section>
      <McpDialog open={mcpOpen} onOpenChange={setMcpOpen} />
    </SettingsPage>
  );
}

// ── Performance ──────────────────────────────────────────────────────────────

/** Runaway protection is the 1%: one switch up front, the budgets one level down. */
export function PerformancePage() {
  const config = useSafety((s) => s.config);
  const set = useSafety((s) => s.set);
  const setKindLimit = useSafety((s) => s.setKindLimit);
  const reset = useSafety((s) => s.reset);
  const kinds = taskKinds().filter((k) => k.id !== UNKNOWN_KIND.id);
  return (
    <SettingsPage id="performance" title="Performance">
      <Section title="Stuck operations">
        <Row label="Stop stuck operations" keywords="safety runaway freeze timeout" hint="Long work runs in slices on a clock, so the app keeps responding and you can stop it.">
          <Switch checked={config.enabled} onCheckedChange={(v) => set({ enabled: v })} />
        </Row>
        <Row label="Time limit" hint="How long an operation may run before it's stopped, unless its own limit says otherwise.">
          <NumberInput value={Math.round(config.defaultLimitMs / 1000)} onChange={(v) => set({ defaultLimitMs: Math.max(1, v) * 1000 })} min={1} max={3600} step={1} unit="s" disabled={!config.enabled} className="w-24" />
        </Row>
        <Row label="Record freezes" hint="Note when the app stops responding and what it was doing. Shown in Activity and sent with bug reports.">
          <Switch checked={config.watchdog} onCheckedChange={(v) => set({ watchdog: v })} />
        </Row>
        <Row label="Activity" keywords="running tasks">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              useSession.getState().setActivityOpen(true);
              useSession.getState().setSettingsDialogOpen(false);
            }}
          >
            Open
          </Button>
        </Row>
      </Section>
      <Disclosure label="Advanced limits">
        <Row label="Count as frozen after" hint="Shorter catches more; too short reports ordinary heavy frames.">
          <NumberInput value={config.freezeMs / 1000} onChange={(v) => set({ freezeMs: Math.max(0.5, v) * 1000 })} min={0.5} max={30} step={0.5} precision={1} unit="s" disabled={!config.watchdog} className="w-24" />
        </Row>
        {kinds.map((kind) => (
          <Row key={kind.id} label={kind.label} hint={kind.hint} keywords="limit">
            <LimitField limit={effectiveLimit(config, kind)} isOverride={config.limits[kind.id] !== undefined} disabled={!config.enabled} onChange={(limit) => setKindLimit(kind.id, limit)} />
          </Row>
        ))}
        <Row label="Restore limits">
          <Button variant="ghost" size="xs" onClick={reset}>
            <RotateCcw /> Reset
          </Button>
        </Row>
      </Disclosure>
    </SettingsPage>
  );
}

/** Default · Custom · No limit — three states, so zero never means "forever". */
function LimitField({ limit, isOverride, disabled, onChange }: { limit: TaskLimit; isOverride: boolean; disabled?: boolean; onChange: (limit: TaskLimit | null) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={limit.mode}
        onValueChange={(v) => {
          if (v === "default") onChange(isOverride ? null : LIMIT_DEFAULT);
          else if (v === "unlimited") onChange(LIMIT_UNLIMITED);
          else onChange(fixedLimit(limit.mode === "fixed" ? limit.ms : 30_000));
        }}
        disabled={disabled}
      >
        <SelectTrigger className="h-(--control-h) w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Default</SelectItem>
          <SelectItem value="fixed">Custom</SelectItem>
          <SelectItem value="unlimited">No limit</SelectItem>
        </SelectContent>
      </Select>
      {limit.mode === "fixed" && (
        <NumberInput value={Math.round(limit.ms / 1000)} onChange={(v) => onChange(fixedLimit(Math.max(1, v) * 1000))} min={1} max={3600} step={1} unit="s" disabled={disabled} className="w-20" />
      )}
    </div>
  );
}

// ── About ────────────────────────────────────────────────────────────────────

/** The ONLY place the version number appears. */
export function AboutPage() {
  const phase = useUpdate((s) => s.phase);
  const latest = useUpdate((s) => s.latest);
  const hasUpdate = useUpdate((s) => s.hasUpdate());
  const open = (path: string) => window.open(`${product.siteUrl}${path}`, "_blank", "noopener,noreferrer");
  return (
    <SettingsPage id="about" title="About">
      <Section>
        <Row label="Version" keywords="about build">
          <span className="text-body tabular-nums text-fg-muted">{identity.name} {APP_VERSION}</span>
        </Row>
        <Row label="Updates" keywords="update upgrade version">
          {hasUpdate ? (
            <Button size="xs" onClick={() => useUpdate.getState().setDialogOpen(true)}>
              Update to {latest}
            </Button>
          ) : (
            <Button variant="ghost" size="xs" disabled={phase === "checking"} onClick={() => void useUpdate.getState().check()}>
              {phase === "checking" ? "Checking…" : phase === "current" ? "Up to date · check again" : "Check for updates"}
            </Button>
          )}
        </Row>
        <Row label="What's new" keywords="changelog release notes">
          <Button variant="ghost" size="xs" onClick={() => open("/changelog")}>
            Changelog <ExternalLink />
          </Button>
        </Row>
        <Row label="Help" keywords="docs documentation learn">
          <Button variant="ghost" size="xs" onClick={() => open("/docs")}>
            Docs <ExternalLink />
          </Button>
        </Row>
        <Row label="Report a bug" keywords="feedback issue">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              useSession.getState().setSettingsDialogOpen(false);
              product.feedback.open("bug");
            }}
          >
            Report…
          </Button>
        </Row>
        <Row label="Terms and privacy" keywords="legal licence">
          <div className="flex gap-1">
            <Button variant="ghost" size="xs" onClick={() => open("/terms")}>
              Terms
            </Button>
            <Button variant="ghost" size="xs" onClick={() => open("/privacy")}>
              Privacy
            </Button>
          </div>
        </Row>
      </Section>
    </SettingsPage>
  );
}
