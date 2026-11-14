"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatBytes } from "@/lib/format-bytes";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import {
  defaultKeepOriginal,
  estimateRenderBytes,
  planRenderInPlace,
  renderClipInPlace,
  type RenderFormat,
  type RenderScale,
} from "./render-in-place";

const FORMATS: { value: RenderFormat; label: string }[] = [
  { value: "webp", label: "WebP" },
  { value: "png", label: "PNG" },
  { value: "video", label: "Video" },
];

const SCALES: { value: RenderScale; label: string }[] = [
  { value: 1, label: "Original" },
  { value: 0.5, label: "Half" },
  { value: 0.25, label: "Quarter" },
];

/**
 * Render in place — the questions worth asking before a render, and the
 * numbers that answer them. Opened by the layer menu; the render itself runs in
 * the background and reports on the status bar.
 */
export function RenderInPlaceDialog() {
  const clipId = useSession((s) => s.renderInPlaceClipId);
  const store = useDocStore();
  const plan = React.useMemo(() => (clipId ? planRenderInPlace(store.getState(), clipId) : null), [clipId, store]);
  const [format, setFormat] = React.useState<RenderFormat>("webp");
  const [scale, setScale] = React.useState<RenderScale>(1);
  const [keep, setKeep] = React.useState(true);
  // The keep default follows the size until you touch the switch yourself.
  const [keepTouched, setKeepTouched] = React.useState(false);

  React.useEffect(() => {
    if (!plan) return;
    setFormat(plan.defaultFormat);
    setScale(1);
    setKeepTouched(false);
  }, [plan]);
  React.useEffect(() => {
    if (plan && !keepTouched) setKeep(defaultKeepOriginal(plan));
  }, [plan, keepTouched]);

  const close = () => useSession.getState().setRenderInPlaceClipId(null);
  if (!plan) return null;

  const picture = plan.kind === "picture";
  const size = estimateRenderBytes(plan, { format, scale });
  const run = () => {
    void renderClipInPlace(store, plan.clipId, { format, scale, keepOriginal: keep });
    close();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{plan.rerender ? "Render again" : "Render in place"}</DialogTitle>
          <p className="truncate text-xs text-muted-foreground">
            {plan.name}
            {picture && ` · ${Math.round(plan.width * scale)}×${Math.round(plan.height * scale)} · ${plan.frames} frames at ${plan.fps} fps`}
          </p>
        </DialogHeader>

        <div className="space-y-3 py-1 text-sm">
          {picture && (
            <>
              <Row label="Format">
                <Choice value={format} options={FORMATS} onChange={setFormat} />
              </Row>
              <Row label="Quality">
                <Choice value={scale} options={SCALES} onChange={setScale} />
              </Row>
            </>
          )}

          <Row label="Size">
            <span className="tabular-nums">
              ≈ {formatBytes(size)}
              {keep && plan.originalBytes > 0 && (
                <span className="text-muted-foreground"> + {formatBytes(plan.originalBytes)} original</span>
              )}
            </span>
          </Row>

          <Row label="Keep original">
            <Switch
              checked={keep}
              onCheckedChange={(v) => {
                setKeep(v);
                setKeepTouched(true);
              }}
            />
          </Row>
          <p className="text-xs text-muted-foreground">
            {picture && format === "video" ? "Video has no transparency — it covers what's beneath. " : ""}
            {picture && format === "png" ? "Lossless, several times larger. " : ""}
            {keep ? "Switch back anytime." : "Deleted once the render checks out. No way back."}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={run}>Render</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Choice<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={String(value)}
      onValueChange={(v) => {
        const hit = options.find((o) => String(o.value) === v);
        if (hit) onChange(hit.value);
      }}
      className="justify-end"
    >
      {options.map((o) => (
        <ToggleGroupItem key={String(o.value)} value={String(o.value)} className="px-2.5 text-xs">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
