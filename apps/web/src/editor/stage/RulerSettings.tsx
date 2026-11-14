"use client";

import * as React from "react";
import {
  RULER_UNITS,
  RULER_UNIT_LABEL,
  type GuideStyle,
  type RulerUnit, findGuide, removeGuide } from "@solomotion/core";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";

/**
 * The ruler / guide settings panel — ONE component reused everywhere guides are
 * configured. `target` picks the surface:
 *   - "default" (ruler tool / ruler strips): unit + the DEFAULT guide colour &
 *     style (which every non-overridden guide follows) + snap toggle.
 *   - a specific guide (right-clicking a guide line): that guide's colour/style
 *     override (or "Default" to inherit) + Remove.
 * Both share the same colour swatches + style toggle, so the two feel identical.
 */
export type GuideSettingsTarget = { kind: "default" } | { kind: "guide"; frameId: string; guideId: string };

const GUIDE_COLORS = ["#22C7B6", "#F5406B", "#4C8DFF", "#F5B843", "#B18CFF", "#FFFFFF"];
const STYLES: GuideStyle[] = ["solid", "dashed", "dotted"];

function StyleToggle({ value, onChange }: { value: GuideStyle | null; onChange: (s: GuideStyle) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-input/40 p-0.5">
      {STYLES.map((s) => (
        <button
          key={s}
          type="button"
          aria-label={s}
          aria-pressed={value === s}
          onClick={() => onChange(s)}
          className={cn(
            "flex h-6 flex-1 items-center justify-center rounded transition-colors",
            value === s ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <svg width="24" height="8" viewBox="0 0 24 8" aria-hidden>
            <line
              x1="2"
              y1="4"
              x2="22"
              y2="4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray={s === "dashed" ? "5 3" : s === "dotted" ? "1 3" : undefined}
              strokeLinecap="round"
            />
          </svg>
        </button>
      ))}
    </div>
  );
}

function Swatches({
  value,
  onPick,
  allowInherit,
  inherited,
  onInherit,
}: {
  value: string;
  onPick: (c: string) => void;
  allowInherit?: boolean;
  inherited?: boolean;
  onInherit?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {allowInherit && (
        <button
          type="button"
          aria-label="Default colour"
          aria-pressed={inherited}
          onClick={onInherit}
          className={cn(
            "h-5 rounded px-1.5 text-[10px] font-medium transition-colors",
            inherited ? "bg-primary/15 text-primary" : "bg-input/40 text-muted-foreground hover:text-foreground",
          )}
        >
          Auto
        </button>
      )}
      {GUIDE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={c}
          aria-pressed={!inherited && value.toLowerCase() === c.toLowerCase()}
          onClick={() => onPick(c)}
          className={cn(
            "size-5 rounded-full border transition-transform hover:scale-110",
            !inherited && value.toLowerCase() === c.toLowerCase() ? "border-foreground" : "border-border/60",
          )}
          style={{ backgroundColor: c }}
        />
      ))}
      <label className="relative size-5 cursor-pointer overflow-hidden rounded-full border border-border/60" aria-label="Custom colour">
        <span className="pointer-events-none absolute inset-0" style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }} />
        <input
          type="color"
          value={value}
          onChange={(e) => onPick(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

function DefaultSettings({ heading }: { heading?: boolean }) {
  const unit = useSession((s) => s.rulerUnit);
  const guideSnap = useSession((s) => s.guideSettings.toGuides);
  const color = useSession((s) => s.guideDefaultColor);
  const style = useSession((s) => s.guideDefaultStyle);

  return (
    <div className="space-y-3">
      {/* The title is the HOST's when there is one. A right-click popover needs
          to say what it is about; a tab already labelled "Guides" does not, and
          a heading repeating its own tab is the padding this app keeps out. */}
      {heading && <div className="text-xs font-semibold">Rulers &amp; guides</div>}
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Unit</span>
        <Select value={unit} onValueChange={(u) => useSession.getState().setRulerUnit(u as RulerUnit)}>
          <SelectTrigger className="h-7 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RULER_UNITS.map((u) => (
              <SelectItem key={u} value={u} className="text-xs">
                {RULER_UNIT_LABEL[u]} ({u})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5 text-xs">
        <span className="text-muted-foreground">Default colour</span>
        <Swatches value={color} onPick={(c) => useSession.getState().setGuideDefaultColor(c)} />
      </div>
      <div className="space-y-1.5 text-xs">
        <span className="text-muted-foreground">Default style</span>
        <StyleToggle value={style} onChange={(s) => useSession.getState().setGuideDefaultStyle(s)} />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Snap to guides</span>
        <Switch checked={guideSnap} onCheckedChange={(v) => useSession.getState().setGuideSettings({ toGuides: v })} />
      </div>
    </div>
  );
}

function GuideSettings({ frameId, guideId, onRemove }: { frameId: string; guideId: string; onRemove?: () => void }) {
  const doc = useDoc();
  const store = useDocStore();
  const defColor = useSession((s) => s.guideDefaultColor);
  // `frameId` is the guide's OWNER: a frame, or a page for a page guide (D17).
  const guide = findGuide(doc, frameId, guideId);
  if (!guide) return null;

  const patch = (p: { color?: string | null; style?: GuideStyle | null }) =>
    store.update("Style guide", (d) => {
      const g = findGuide(d, frameId, guideId);
      if (g) Object.assign(g, p);
    });
  const remove = () => {
    store.update("Delete guide", (d) => {
      removeGuide(d, frameId, guideId);
    });
    onRemove?.(); // close the popover — no zombie panel over a guide that's gone
  };

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold">Guide</div>
      <div className="space-y-1.5 text-xs">
        <span className="text-muted-foreground">Colour</span>
        <Swatches
          value={guide.color ?? defColor}
          onPick={(c) => patch({ color: c })}
          allowInherit
          inherited={guide.color === null}
          onInherit={() => patch({ color: null })}
        />
      </div>
      <div className="space-y-1.5 text-xs">
        <span className="text-muted-foreground">Style</span>
        <StyleToggle value={guide.style} onChange={(s) => patch({ style: s })} />
      </div>
      <button
        type="button"
        onClick={remove}
        className="w-full rounded-md bg-destructive/10 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
      >
        Remove guide
      </button>
    </div>
  );
}

export function RulerSettings({
  target = { kind: "default" },
  onRemove,
  heading,
}: {
  target?: GuideSettingsTarget;
  /** Called after a guide is removed (guide target only) — lets the host close. */
  onRemove?: () => void;
  /** Print "Rulers & guides" above the fields. For a host with no title of its
   *  own — a right-click popover. A titled panel or tab passes nothing. */
  heading?: boolean;
}) {
  return target.kind === "guide" ? (
    <GuideSettings frameId={target.frameId} guideId={target.guideId} onRemove={onRemove} />
  ) : (
    <DefaultSettings heading={heading} />
  );
}
