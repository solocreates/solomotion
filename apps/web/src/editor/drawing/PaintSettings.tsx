"use client";

import * as React from "react";
import { pressureResponse, type PathFidelity, type PressureResponse } from "@solomotion/core";
import { Gauge, Paintbrush2, Waves } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Range } from "@/components/ui/range";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FidelityFields } from "./FidelityFields";
import { SizePreview, SmoothingPreview } from "./paint-preview";
import { useDrawing } from "./drawing-store";
import { usePaintDials, type PaintDials } from "./paint-dials";

/**
 * PAINT SETTINGS — every knob the armed paint tool has, in one tabbed sheet,
 * behind one visible button.
 *
 * Before this there were three hidden popovers. The fidelity pod, the pressure
 * pod and the handle's caps each opened their own, each only on a HOLD or a
 * right-click, and each was scrolled off the right-hand end of a tool bar that
 * had been squeezed to 400px. So the app's whole expressive range — the
 * stabiliser, the pressure curves, the tip's own size and falloff — was
 * reachable only by a gesture nobody had been told about, on a control nobody
 * could see. "Why would users know that clicking that gets them extra
 * settings?" is the correct question, and the honest answer was that they
 * wouldn't.
 *
 * One sheet fixes both halves. It has a plain labelled button in the bar, which
 * is the discoverable door. And it is TABBED rather than one long column,
 * because these are three different subjects — the mark, the hand, the pen —
 * and stacking them made a scroller in which the third was invisible too.
 *
 * The tabs are a LIST, and each body is a component that already existed:
 * `FidelityFields` is literally the same element the bar's smoothing pod shows,
 * so the two can never drift. Adding a fourth subject is one entry in
 * `PAINT_TABS`, not a fourth popover.
 *
 * Everything that opens it — the bar's button, either pod's hold, either cap on
 * the stage handle — opens THIS, on the tab it is about. Three doors, one room.
 */

export type PaintTab = "brush" | "smoothing" | "pressure";

/**
 * The open/tab pair, so every surface that hosts the sheet spells it the same
 * way — and so a pod can say `openAt("pressure")` without knowing whether the
 * popover it lands in belongs to the bar or to the stage handle.
 */
export function usePaintSettings(initial: PaintTab = "brush") {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<PaintTab>(initial);
  const openAt = React.useCallback((t: PaintTab) => {
    setTab(t);
    setOpen(true);
  }, []);
  return { open, tab, openAt, props: { open, onOpenChange: setOpen, tab, onTab: setTab } };
}

/**
 * Who to ask to open the sheet. The tool bar hosts ONE sheet, on its Advanced
 * button, and every pod inside it opens that one on its own tab — a popover
 * that flew out of whichever pod you happened to hold would be three popovers
 * again, in a different disguise.
 */
const OpenerContext = React.createContext<((tab: PaintTab) => void) | null>(null);
export const PaintSettingsOpener = OpenerContext.Provider;
export const useOpenPaintSettings = () => React.useContext(OpenerContext);

const PAINT_TABS: ReadonlyArray<{
  id: PaintTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  Body: React.ComponentType<{ dials: PaintDials }>;
}> = [
  { id: "brush", label: "Mark", icon: Paintbrush2, Body: BrushFields },
  { id: "smoothing", label: "Hand", icon: Waves, Body: SmoothingFields },
  { id: "pressure", label: "Pen", icon: Gauge, Body: PressureFields },
];

/**
 * The sheet. Controlled from outside so a pod can open it on its own tab and
 * still let you walk to the others — a popover that only ever shows what you
 * pressed is three popovers wearing a costume.
 */
export function PaintSettings({
  open,
  onOpenChange,
  tab,
  onTab,
  side = "bottom",
  align = "center",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: PaintTab;
  onTab: (tab: PaintTab) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /**
   * What the sheet hangs off, rendered INSIDE the popover root and otherwise
   * untouched — the caller wraps its own element in `PopoverTrigger` (click to
   * open) or `PopoverAnchor` (opened by a hold gesture elsewhere).
   *
   * It is not wrapped for you, and that is deliberate: an `asChild` trigger
   * added here would land on whatever the caller passed, and every one of these
   * buttons is already inside a `Tooltip`. A Radix root is not a DOM element,
   * so the ref went nowhere, the popover had no anchor, and the stage handle's
   * caps silently opened nothing at all.
   */
  children?: React.ReactNode;
}) {
  const dials = usePaintDials();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {children}
      <PopoverContent side={side} align={align} sideOffset={8} className="w-72 p-2">
        {dials ? (
          <Tabs value={tab} onValueChange={(v) => onTab(v as PaintTab)}>
            <TabsList className="w-full">
              {PAINT_TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="flex-1 gap-1.5">
                  <t.icon className="size-3.5" />
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {PAINT_TABS.map((t) => (
              <TabsContent key={t.id} value={t.id} className="pt-2">
                <t.Body dials={dials} />
              </TabsContent>
            ))}
          </Tabs>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// ── The bodies ──────────────────────────────────────────────────────────────

/** THE MARK — how big, how opaque, and what that actually looks like. */
function BrushFields({ dials }: { dials: PaintDials }) {
  const size = dials.dials.size;
  const opacity = dials.dials.opacity;
  return (
    <div className="space-y-2">
      <div className="flex h-[76px] items-center justify-center">
        <SizePreview size={size.value} brush={dials.brush} />
      </div>
      <Range
        label={size.label}
        value={size.value}
        min={size.min}
        max={size.max}
        scale={size.scale}
        ticks={[...(size.ticks ?? [])]}
        defaultValue={size.defaultValue}
        precision={0}
        unit="px"
        onChange={size.set}
      />
      <Range
        label={opacity.label}
        value={Math.round(opacity.value * 100)}
        min={1}
        max={100}
        step={1}
        unit="%"
        precision={0}
        defaultValue={opacity.defaultValue === undefined ? undefined : Math.round(opacity.defaultValue * 100)}
        ticks={[100]}
        onChange={(v) => opacity.set(v / 100)}
      />
    </div>
  );
}

/** THE HAND — the stabiliser, from the same fields the bar's pod shows. The
 *  caller owns WHERE the value lives; the fields are written once. */
function SmoothingFields({ dials }: { dials: PaintDials }) {
  const brush = useDrawing((s) => s.brush);
  const eraser = useDrawing((s) => s.eraser);
  const isEraser = dials.tool === "eraser";
  const value: PathFidelity = isEraser ? eraser.fidelity : brush.fidelity;
  const write = (patch: Partial<PathFidelity>) => {
    const d = useDrawing.getState();
    if (isEraser) d.setEraserOptions({ fidelity: { ...d.eraser.fidelity, ...patch } });
    else d.setBrushOptions({ fidelity: { ...d.brush.fidelity, ...patch } });
  };
  // The pixel brush stabilises but makes no anchors, so simplify and corners
  // are not its questions — the same rule the options bar applies.
  return (
    <div className="space-y-2">
      {/* Every tab opens with a picture of what it does. This one runs the real
          stabiliser over a demo stroke, so the leash you see is the leash you
          will feel — and the tab stops being one slider in an empty room. */}
      <div className="flex h-[76px] items-center justify-center">
        <SmoothingPreview value={value.smoothing} />
      </div>
      <div className="flex items-baseline justify-between px-0.5">
        <span className="text-2xs text-muted-foreground">Stabiliser</span>
        <span className="text-2xs text-muted-foreground">⇧ reverses it</span>
      </div>
      <FidelityFields
        value={value}
        onChange={write}
        geometry={!isEraser && brush.engine === "vector"}
        heading={false}
      />
    </div>
  );
}

/** THE PEN — how pressure becomes a mark. */
export function PressureFields() {
  const pressure = useDrawing((s) => s.pressure);
  const setPressure = useDrawing((s) => s.setPressure);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">Pen pressure</span>
        <Switch checked={pressure.enabled} onCheckedChange={(v) => setPressure({ enabled: v })} />
      </div>
      <div className={pressure.enabled ? undefined : "pointer-events-none space-y-3 opacity-40"}>
        <ResponseEditor
          label="Size"
          value={pressure.size}
          onChange={(patch) => setPressure({ size: { ...pressure.size, ...patch } })}
        />
        <ResponseEditor
          label="Opacity"
          value={pressure.opacity}
          onChange={(patch) => setPressure({ opacity: { ...pressure.opacity, ...patch } })}
        />
      </div>
      {/* No paragraph explaining that pressure applies to pens. The one thing
          worth saying here is what happens on hardware that has none. */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Fake it from speed</span>
        <Switch
          checked={pressure.velocityFallback}
          onCheckedChange={(v) => setPressure({ velocityFallback: v })}
        />
      </div>
    </div>
  );
}

/**
 * A pressure response, as the CURVE it is.
 *
 * It was three bare number fields in a row — `100`, `1.00`, `5` — and nothing
 * about them said what they did to a stroke. Amount, gamma and floor are not
 * three settings, they are three handles on one shape, and the shape is what an
 * artist is actually choosing: how hard you press before the mark grows, and
 * how much is left when you barely touch.
 */
function ResponseCurve({ value }: { value: PressureResponse }) {
  const W = 100;
  const H = 40;
  const d = React.useMemo(() => {
    const pts = Array.from({ length: 33 }, (_, i) => {
      const p = i / 32;
      return `${(p * W).toFixed(1)},${(H - pressureResponse(p, value) * H).toFixed(1)}`;
    });
    return `M${pts.join(" L")}`;
  }, [value]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-10 w-full" preserveAspectRatio="none" aria-hidden>
      {/* The straight response, for reference — how far the curve is from it IS
          the setting, and without it a gentle curve looks like a straight line. */}
      <path d={`M0,${H} L${W},0`} stroke="var(--foreground)" strokeOpacity={0.12} strokeWidth={1} fill="none" />
      <path d={`${d} L${W},${H} L0,${H} Z`} fill="var(--primary)" fillOpacity={0.12} stroke="none" />
      <path d={d} fill="none" stroke="var(--primary)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ResponseEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: PressureResponse;
  onChange: (patch: Partial<PressureResponse>) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-2xs text-muted-foreground">light → hard</span>
      </div>
      <ResponseCurve value={value} />
      <Range
        label="Amount"
        value={Math.round(value.amount * 100)}
        min={0}
        max={100}
        step={1}
        unit="%"
        precision={0}
        defaultValue={100}
        ticks={[0, 100]}
        onChange={(v) => onChange({ amount: v / 100 })}
      />
      <Range
        label="Curve"
        value={value.gamma}
        min={0.25}
        max={4}
        scale="log"
        precision={2}
        defaultValue={1}
        ticks={[1]}
        onChange={(gamma) => onChange({ gamma })}
      />
      <Range
        label="Minimum"
        value={Math.round(value.floor * 100)}
        min={0}
        max={90}
        step={1}
        unit="%"
        precision={0}
        defaultValue={5}
        ticks={[0]}
        onChange={(v) => onChange({ floor: v / 100 })}
      />
    </div>
  );
}
