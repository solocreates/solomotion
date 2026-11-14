"use client";

import * as React from "react";
import {
  applyBaseStyle,
  offeredWeights,
  resolveColor,
  weightName,
  type Clip,
  type PartialTextStyle,
  type TextClip,
} from "@solomotion/core";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  CaseLower,
  CaseSensitive,
  CaseUpper,
  Italic,
  RemoveFormatting,
  Strikethrough,
  Underline,
} from "lucide-react";
import { DocColorInput } from "./DocColorInput";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAppShell } from "../state/app-shell";
import { noteFontChosen } from "../state/font-prefs";
import { fontPickPatch, useFamilyMeta } from "../fonts/library";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { useEffectiveValue, writeAnimatable } from "./animatable";
import { Half, IconTrack, Pair, PanelSection, PropRow, Seg } from "./controls";
import { HighlightSection } from "./HighlightSection";
import { FontPicker } from "./FontPicker";
import { BindableField } from "./variables/bindable";
import { GroupKeyButton, KeyControl } from "./keyframe-controls";
import { useClipUpdater } from "./use-clip-updater";

/**
 * Typography controls, usable against two targets:
 *  - the clip's own TextStyle (all values defined, keyframable, bindable)
 *  - an OVERRIDE scope: a selected text range, or a caption's focus. Values may
 *    be undefined ("mixed" / inherited) and there are no keyframes or variable
 *    bindings, because those live on the clip and an override is styling.
 *
 * Both arrive here as `value` + `set`, which is what lets the entire text
 * sidebar serve a caption's focused words with no caption-specific controls.
 */
export interface StyleFieldsProps {
  value: PartialTextStyle;
  set: (patch: PartialTextStyle, label: string, mergeKey?: string) => void;
  /**
   * The same patch as a history-free PREVIEW (`null` reverts), landing where
   * `set` would — so a font hovered while a word is selected previews on that
   * word. Omitted, font hover previews nothing.
   */
  preview?: (patch: PartialTextStyle | null) => void;
  /** The clip owning these styles — enables keyframe controls when set. */
  keyframeClip?: Clip;
  /**
   * This scope is an OVERRIDE (a text range, a caption's focus) rather than the
   * clip's own style: writes go through `set`, and the clip-level affordances
   * that make no sense on a slice — keyframes, variable binding, paragraph
   * settings like alignment and line height — are withheld.
   */
  overrideScope?: boolean;
}

/**
 * Faux bold's "on" amount: 3% of the font size per edge. Heavy enough to read
 * as bold at a glance on a Regular, light enough that a Black stays legible.
 */
const FAUX_BOLD_ON = 0.03;

export function StyleFields({ value, set, preview, keyframeClip, overrideScope }: StyleFieldsProps) {
  const doc = useDoc();
  const updateClip = useClipUpdater(keyframeClip?.id ?? "__none__");
  const animatable = keyframeClip && !overrideScope ? keyframeClip : undefined;

  // Effective (sampled-when-keyed) typography values.
  // Bindable typography defaults coerce to a literal (a bound field shows the
  // variable chip instead, so the numeric control never sees a token).
  const fontSize = useEffectiveValue(animatable, "fontSize", typeof value.fontSize === "number" ? value.fontSize : 96);
  const letterSpacing = useEffectiveValue(animatable, "letterSpacing", value.letterSpacing ?? 0);
  const lineHeight = useEffectiveValue(animatable, "lineHeight", value.lineHeight ?? 1.15);
  const color = useEffectiveValue(animatable, "color", value.color ?? "#ffffff");
  const fontWeight = useEffectiveValue(animatable, "fontWeight", typeof value.fontWeight === "number" ? value.fontWeight : 400);
  const fauxBold = useEffectiveValue(animatable, "fauxBold", value.fauxBold ?? 0);
  const italic = useEffectiveValue(animatable, "italic", value.italic ?? false);

  const familyMeta = useFamilyMeta(typeof value.fontFamily === "string" ? value.fontFamily : undefined);
  const familyWeights = familyMeta ? offeredWeights(familyMeta) : [400, 700];
  const projectId = useAppShell((s) => s.currentProjectId);
  // Binding writes a `var:<id>` token to the whole-clip base style — offered
  // everywhere except a range slice (per-run styling binds later).
  const canBind = !overrideScope;

  const key = (property: string, currentValue: () => number | string | boolean) =>
    keyframeClip && !overrideScope ? (
      <KeyControl clip={keyframeClip} property={property} currentValue={currentValue} />
    ) : undefined;

  /** Keyed properties write a keyframe at the playhead; others patch the style. */
  const setValue = (
    property: string,
    v: number | string | boolean,
    patch: PartialTextStyle,
    label: string,
    mergeKey?: string,
  ) => {
    if (animatable) {
      updateClip(
        label,
        (c) => {
          if (c.kind === "audio" || c.kind === "nested") return;
          writeAnimatable(c, property, v, useSession.getState().playheadMs, (cc) => {
            if (cc.kind === "text") applyBaseStyle(cc, patch);
          });
        },
        mergeKey,
      );
    } else {
      set(patch, label, mergeKey);
    }
  };

  return (
    <>
      <PropRow label="Font">
        <div className="flex min-w-0 flex-1 gap-1">
          <BindableField
            type="fontFamily"
            value={value.fontFamily}
            literal={typeof value.fontFamily === "string" ? value.fontFamily : "Space Grotesk"}
            onChange={(next) => set({ fontFamily: next as string }, "Change font")}
            disabled={!canBind}
          >
            <FontPicker
              value={typeof value.fontFamily === "string" ? value.fontFamily : undefined}
              weight={typeof fontWeight === "number" ? fontWeight : undefined}
              italic={italic === true}
              onChange={(family, face) => {
                // An uploaded file names its own face — Inter-Bold-Italic must
                // land as bold italic, not as the family's upright Regular.
                set(fontPickPatch(family, { weight: fontWeight as number, italic: italic === true }, face), "Change font");
                noteFontChosen(projectId, family);
              }}
              onPreview={preview ? (family) => preview(family ? { fontFamily: family } : null) : undefined}
            />
          </BindableField>
        </div>
      </PropRow>

      {/* WEIGHT picks a face the foundry drew; faux bold (B+, and the B
          under Style) adds ink on top of it. Two concepts, two fields — the
          Bold button used to write 700, which did nothing on a family whose
          heaviest face is 700. Same shape as Size · LS below. */}
      <PropRow label="Weight" keyControl={key("fontWeight", () => fontWeight)}>
        <Pair>
          <BindableField
            type="fontWeight"
            value={value.fontWeight}
            literal={fontWeight as number}
            onChange={(next) => set({ fontWeight: next as number }, "Change weight")}
            disabled={!canBind}
          >
            <Select
              value={value.fontWeight !== undefined || animatable ? String(fontWeight) : ""}
              onValueChange={(w) =>
                setValue("fontWeight", parseInt(w, 10), { fontWeight: parseInt(w, 10) }, "Change weight")
              }
            >
              <SelectTrigger className="h-7 min-w-0 flex-1 text-xs" title={weightName(fontWeight as number)}>
                {/* The number, closed: exact, and it fits half a row. The menu names them. */}
                <SelectValue placeholder="Mixed">
                  {value.fontWeight !== undefined || animatable ? (
                    <span className="font-mono tabular-nums">{String(fontWeight)}</span>
                  ) : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {familyWeights.map((w) => (
                  <SelectItem key={w} value={String(w)}>
                    <span style={{ fontWeight: w }}>{weightName(w)}</span>
                    <span className="ml-1.5 font-mono text-2xs text-muted-foreground tabular-nums">{w}</span>
                  </SelectItem>
                ))}
                {!familyWeights.includes(fontWeight as number) && (
                  <SelectItem value={String(fontWeight)}>
                    <span className="font-mono tabular-nums">{String(fontWeight)}</span>
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </BindableField>
          <NumberInput
            label="B+"
            value={animatable ? Math.round((fauxBold as number) * 1000) / 10 : value.fauxBold !== undefined ? Math.round(value.fauxBold * 1000) / 10 : undefined}
            mixed={!animatable && value.fauxBold === undefined}
            min={0}
            max={25}
            step={0.5}
            precision={1}
            unit="%"
            onChange={(v) => setValue("fauxBold", v / 100, { fauxBold: v / 100 }, "Faux bold", "style-fauxbold")}
            title="Faux bold — thickness added on top of the weight, as a share of the size"
          />
        </Pair>
      </PropRow>

      {/* Style and case are two vocabularies, not eight buttons in a row — at
          130px of control column the old single strip gave each toggle 15px.
          Within Style the four are INDEPENDENT: bold and italic are separate
          booleans and underline/strikethrough are two values of one enum, so
          the track shows a SET. Read through one ternary it could only ever
          light the first one that was true — bold-and-italic reported italic
          off while the stage plainly showed it on. The state comes from the
          scope's own merged style (`useScopeStyle`), so a selected range, a
          caption's focused word and the whole layer each report their own. */}
      <PropRow label="Style">
        <IconTrack
          value={[
            ...((fauxBold as number) > 0 ? ["bold" as const] : []),
            ...(italic === true ? ["italic" as const] : []),
            ...(value.decoration === "underline" ? ["underline" as const] : []),
            ...(value.decoration === "strikethrough" ? ["strike" as const] : []),
          ]}
          items={[
            { id: "bold", label: "Faux bold — thicker, on any weight", icon: <Bold /> },
            { id: "italic", label: "Italic", icon: <Italic /> },
            { id: "underline", label: "Underline", icon: <Underline /> },
            { id: "strike", label: "Strikethrough", icon: <Strikethrough /> },
          ]}
          onPick={(id) => {
            if (id === "bold") {
              const next = (fauxBold as number) > 0 ? 0 : FAUX_BOLD_ON;
              setValue("fauxBold", next, { fauxBold: next }, next > 0 ? "Faux bold" : "Remove faux bold");
            } else if (id === "italic") {
              setValue("italic", italic !== true, { italic: italic !== true }, "Toggle italic");
            } else if (id === "underline") {
              const on = value.decoration === "underline";
              set({ decoration: on ? "none" : "underline" }, "Underline");
            } else {
              const on = value.decoration === "strikethrough";
              set({ decoration: on ? "none" : "strikethrough" }, "Strikethrough");
            }
          }}
        />
      </PropRow>

      <PropRow label="Case">
        <IconTrack
          value={value.textCase ?? "none"}
          items={[
            { id: "none", label: "Normal case", icon: <RemoveFormatting /> },
            { id: "upper", label: "UPPERCASE", icon: <CaseUpper /> },
            { id: "lower", label: "lowercase", icon: <CaseLower /> },
            { id: "title", label: "Title Case", icon: <CaseSensitive /> },
          ]}
          onPick={(v) => set({ textCase: v as PartialTextStyle["textCase"] }, "Change case")}
        />
      </PropRow>

      <PropRow label="Size" keyControl={key("fontSize", () => fontSize)}>
        <Pair>
          <BindableField
            type="number"
            value={value.fontSize}
            literal={fontSize}
            onChange={(next) => set({ fontSize: next as number }, "Change size")}
            disabled={!canBind}
          >
            <NumberInput
              value={animatable ? fontSize : typeof value.fontSize === "number" ? value.fontSize : undefined}
              mixed={!animatable && value.fontSize === undefined}
              min={1}
              max={2000}
              precision={0}
              onChange={(v) => setValue("fontSize", v, { fontSize: v }, "Change size", "style-size")}
              title="Font size"
            />
          </BindableField>
          <NumberInput
            label="LS"
            value={animatable ? letterSpacing : value.letterSpacing}
            mixed={!animatable && value.letterSpacing === undefined}
            min={-40}
            max={200}
            step={0.5}
            precision={1}
            onChange={(v) =>
              setValue("letterSpacing", v, { letterSpacing: v }, "Change spacing", "style-spacing")
            }
            title="Letter spacing"
          />
        </Pair>
      </PropRow>

      {!overrideScope && (
        <PropRow label="Line" keyControl={key("lineHeight", () => lineHeight)}>
          <Half>
            <NumberInput
              value={lineHeight}
              min={0.5}
              max={3}
              step={0.01}
              precision={2}
              onChange={(v) =>
                setValue("lineHeight", v, { lineHeight: v }, "Change line height", "style-lineheight")
              }
              title="Line height"
            />
          </Half>
        </PropRow>
      )}

      {!overrideScope && (
        <PropRow label="Align">
          <IconTrack
            value={value.align}
            items={[
              { id: "left", label: "Align left", icon: <AlignLeft /> },
              { id: "center", label: "Align center", icon: <AlignCenter /> },
              { id: "right", label: "Align right", icon: <AlignRight /> },
              { id: "justify", label: "Justify — fills a fixed-width box", icon: <AlignJustify /> },
            ]}
            onPick={(v) => set({ align: v as PartialTextStyle["align"] }, "Change alignment")}
          />
        </PropRow>
      )}

      {!overrideScope && (
        <PropRow label="Writing" hint="Horizontal lines, or upright letters stacked in columns that advance right to left. Mirroring is the layer's flip (⇧H / ⇧V).">
          <IconTrack
            value={value.orientation ?? "horizontal"}
            items={[
              { id: "horizontal", label: "Horizontal lines", icon: <Seg>Aa</Seg> },
              { id: "vertical", label: "Vertical columns", icon: <Seg>A↓</Seg> },
            ]}
            onPick={(v) => set({ orientation: v as PartialTextStyle["orientation"] }, "Change writing orientation")}
          />
        </PropRow>
      )}

      {!overrideScope && (
        <PropRow label="Direction">
          <IconTrack
            value={value.direction}
            items={[
              { id: "auto", label: "Auto-detect from content", icon: <Seg>Auto</Seg> },
              { id: "ltr", label: "Left-to-right", icon: <Seg>LTR</Seg> },
              { id: "rtl", label: "Right-to-left", icon: <Seg>RTL</Seg> },
            ]}
            onPick={(v) => set({ direction: v as PartialTextStyle["direction"] }, "Change direction")}
          />
        </PropRow>
      )}

      {/* Keyframes always hold literal colors — tokens resolve before keying. */}
      <PropRow
        label="Color"
        keyControl={key("color", () =>
          resolveColor(doc, typeof color === "string" ? color : "#ffffff"),
        )}
      >
        <DocColorInput
          value={animatable ? color : value.color}
          mixed={!animatable && value.color === undefined}
          onChange={(c) => setValue("color", c, { color: c }, "Change color", "style-color")}
        />
      </PropRow>

      <PropRow label="Opacity">
        <NumberInput
          value={value.opacity !== undefined ? Math.round(value.opacity * 100) : undefined}
          mixed={value.opacity === undefined}
          min={0}
          max={100}
          precision={0}
          unit="%"
          onChange={(v) => set({ opacity: v / 100 }, "Change opacity", "style-opacity")}
        />
      </PropRow>
    </>
  );
}

/** The group-keyframe cluster for typography (used by section headers). */
export function typographyGroupKey(clip: Clip, value: PartialTextStyle) {
  return (
    <GroupKeyButton
      clip={clip}
      properties={[
        { property: "fontSize", currentValue: () => value.fontSize ?? 96 },
        { property: "fontWeight", currentValue: () => (typeof value.fontWeight === "number" ? value.fontWeight : 400) },
        { property: "fauxBold", currentValue: () => value.fauxBold ?? 0 },
        { property: "letterSpacing", currentValue: () => value.letterSpacing ?? 0 },
        { property: "lineHeight", currentValue: () => value.lineHeight ?? 1.15 },
        { property: "color", currentValue: () => value.color ?? "#ffffff" },
      ]}
    />
  );
}

/**
 * The text sidebar's remaining style block: the highlight pill. The effect
 * stack that used to sit above it moved to the Effects tab in v54 — one place
 * for every layer's effects, text included.
 */
export function EffectFields({
  clip,
  value,
  set,
  overrideScope,
}: {
  clip: TextClip;
  value: PartialTextStyle;
  set: (patch: PartialTextStyle, label: string, mergeKey?: string) => void;
  overrideScope?: boolean;
}) {
  return (
    <HighlightSection clip={clip} value={value} set={set} overrideScope={overrideScope} />
  );
}
