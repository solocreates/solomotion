"use client";

import * as React from "react";
import {
  CAPTION_STATES,
  CAPTION_STATE_HINT,
  countSettingFor,
  countUpObjects,
  type Easing,
  CAPTION_STATE_LABEL,
  TEXT_ANIMATION_PRESETS,
  applyRangePatch,
  overlayCount,
  seedCaption,
  getPreset,
  propertyDef,
  rangeAt,
  setKeyframe,
  retargetAnimSpec,
  soundPackIdSchema,
  type AnimationSpec,
  type CaptionMotion,
  type CaptionSpec,
  type CaptionState,
  type Clip,
  type KeyframeValue,
  type PartialTextStyle,
  type SoundPackId,
  type SoundPhase,
  type TextClip,
  type RangeSoundOverrides,
  type SoundVoice,
  isLayoutMember,
} from "@solomotion/core";
import {
  AlignCenterVertical,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpToLine,
  Clock,
  Captions,
  Copy,
  MoveHorizontal,
  Play,
  Shuffle,
  RotateCcw,
  Square,
  Trash2,
  WrapText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EasingBlock, EasingPicker } from "@/components/ui/easing-editor";
import { AnimationStage } from "./preset-picker";
import { ArrowRightFromLine, ArrowRightToLine, TextCursorInput } from "lucide-react";
import { NumberInput } from "@/components/ui/number-input";
import { Range } from "@/components/ui/range";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SOUND_PACK_LABELS } from "../audio/sound-engine";
import { SoundField } from "../audio/SoundPicker";
import { listAppSounds } from "../audio/app-sounds";
import { useDoc, useDocStore } from "../state/document-context";
import { useScopeStyle, useScopeTarget } from "./scope";
import { TextEffectsSection } from "./TextEffectsSection";
import { useSession } from "../state/session";
import { revealInInspector } from "../state/inspector-nav";
import { clipLocalClamped, useEffectiveValue, useField, writeAnimatable } from "./animatable";
import { mergeReads } from "./merge";
import { ofKind, usePeers } from "./selection-scope";
import {
  Accordion,
  AccordionItem,
  AccordionMeta,
  IconTrack,
  Note,
  Pair,
  PanelSection,
  PropRow,
} from "./controls";
import { EdgeBadge, LayerAnimateItems, ParamControl } from "./LayerAnimate";
import { useTextPhaseClipboard } from "./use-animation-clipboard";
import { GroupKeyButton, KeyControl } from "./keyframe-controls";
import { EffectFields, StyleFields, typographyGroupKey } from "./StyleFields";
import { AnimationRhythm } from "./AnimationRhythm";
import { useClipUpdater } from "./use-clip-updater";

const isText = ofKind("text");

/**
 * WHICH HALF of the text panel to render.
 *
 * `design-shared` and `animate-shared` are the sections above the scope strip;
 * `design` and `animate` are the ones below it. The split is not cosmetic — it
 * is the sidebar's one layout law (see `InspectorSectionDef.scoped`), and this
 * component is asked for one half at a time because the registry, not this
 * file, decides where the line falls.
 */
export type TextPanelSlot = "design-shared" | "design" | "animate-shared" | "animate" | "sound";

/**
 * Style keys that map to registry keyframe properties — the ones record mode
 * captures as range-scoped keyframes when a text selection is active. Others
 * (shadow/stroke/highlight/align/fontFamily) stay static range styling.
 */
const RANGE_KEYFRAMEABLE = new Set(["color", "fontWeight", "fauxBold", "fontSize", "letterSpacing", "lineHeight", "italic"]);

/**
 * Inspector body for a text clip — and therefore for a caption, which IS one.
 *
 * There is exactly ONE style target in this panel, and three things it can be:
 *
 *   the clip's own style · a selected text range · a caption's FOCUS
 *
 * The last two are overrides and behave identically (`overrideScope`), which is
 * why a caption needs no controls of its own: pick "Focus" and every field
 * below — typography, effects, the highlight pill, the glyph animation — is
 * suddenly editing how the spoken words look, through the same code that edits
 * how the rest of them look.
 */
export function TextInspector({ clip, tab }: { clip: TextClip; tab: TextPanelSlot }) {
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, isText);
  const phaseMixed = (edge: "in" | "out") => {
    const specs = peers.map((c) => c.animations[edge]);
    const first = specs[0] ?? null;
    const preset = specs.some((x) => (x?.preset ?? null) !== (first?.preset ?? null));
    return {
      preset,
      durationMs: !preset && specs.some((x) => x?.durationMs !== first?.durationMs),
      staggerMs: !preset && specs.some((x) => x?.staggerMs !== first?.staggerMs),
    };
  };
  const inMixed = phaseMixed("in");
  const outMixed = phaseMixed("out");
  const sel = useSession((s) => s.textSelection);
  const scope = useScopeTarget(clip);
  const caption = clip.caption;

  // The glyph phases' headers copy, cut, paste and clear the phase as one
  // setting — the same clipboard the layer edges below them use.
  const setTextIn = React.useCallback(
    (spec: AnimationSpec | null) =>
      update("Change in animation", (c) => {
        if (c.kind === "text") c.animations.in = spec ? structuredClone(spec) : null;
      }),
    [update],
  );
  const setTextOut = React.useCallback(
    (spec: AnimationSpec | null) =>
      update("Change out animation", (c) => {
        if (c.kind === "text") c.animations.out = spec ? structuredClone(spec) : null;
      }),
    [update],
  );
  const textInClipboard = useTextPhaseClipboard(clip.animations.in, setTextIn);
  const textOutClipboard = useTextPhaseClipboard(clip.animations.out, setTextOut);

  // Narrowed once, here, so every editor below can use the span without a
  // null-check that the scope address has already made impossible.
  const rangeSpan = scope.address.kind === "range" ? scope.address : null;
  const rangeActive = !!rangeSpan;
  const captionState = scope.address.kind === "caption" ? scope.address.state : null;
  const overrideScope = !scope.isBase;

  // The style every field DISPLAYS: at base the layer's own; in a scope the
  // layer's with this scope's overrides on top — so an untouched focus field
  // reads the inherited number instead of a blank, which is the visible half of
  // "absence means inheritance".
  const styleValue: PartialTextStyle = useScopeStyle(scope);

  /**
   * The one typographic write. Where it lands is the scope's business, not
   * this function's — the only thing left here is RECORD MODE, which turns a
   * keyframeable field on a live selection into a range-scoped keyframe rather
   * than static styling. That is genuinely about time, not about scope, which
   * is why it is the one branch that survived.
   */
  const setStyle = (patch: PartialTextStyle, label: string, mergeKey?: string) => {
    if (rangeActive && sel && useSession.getState().recording) {
      const entries = Object.entries(patch);
      const kfEntries = entries.filter(([k]) => RANGE_KEYFRAMEABLE.has(k));
      const rest = entries.filter(([k]) => !RANGE_KEYFRAMEABLE.has(k));
      if (kfEntries.length > 0) {
        update(label, (c) => {
          if (c.kind !== "text") return;
          const local = clipLocalClamped(c, useSession.getState().playheadMs);
          for (const [k, v] of kfEntries) {
            setKeyframe(c.keyframes, k, local, v as KeyframeValue, undefined, { start: sel.start, end: sel.end });
          }
        }, mergeKey ? `range-kf-${mergeKey}` : undefined);
      }
      if (rest.length === 0) return;
      scope.writeStyle(Object.fromEntries(rest) as PartialTextStyle, label, mergeKey);
      return;
    }
    scope.writeStyle(patch, label, mergeKey);
  };

  const activeRange = rangeSpan ? rangeAt(clip.ranges, rangeSpan.start) : null;

  return (
    <>
      {/* SHARED — the words themselves and the box they sit in. True of the
          layer whichever state you are looking at, so it is above the strip. */}
      {/* Reading order: the BOX the words live in, then the words, then what
          being a caption adds to them. Sizing sits straight under Appearance
          because both are about the shape on the canvas; Content and Captions
          are the last things that are true of the layer, so the strip follows
          immediately after them. */}
      {tab === "design-shared" && (
        <>
          <LayoutSection clip={clip} />
          <ContentSection clip={clip} />
          {clip.caption && <CaptionSection clip={clip} caption={clip.caption} />}
        </>
      )}

      {/* SCOPED — how the words are dressed. Every field here writes wherever
          the strip is pointing, and none of them knows that. */}
      {tab === "design" && (
        <>
          {captionState && <StatePop clip={clip} state={captionState} />}
          <PanelSection
            id="typography"
            title="Typography"
            actions={!overrideScope ? typographyGroupKey(clip, styleValue) : undefined}
          >
            <StyleFields
              value={styleValue}
              set={setStyle}
              preview={scope.previewStyle}
              keyframeClip={clip}
              overrideScope={overrideScope}
            />
          </PanelSection>
          <EffectFields clip={clip} value={styleValue} set={setStyle} overrideScope={overrideScope} />
        </>
      )}

      {/* SHARED — how the layer and its glyphs enter and leave. A range or a
          caption state does not replace this, it rides ON it, so both are on
          screen at once now; the ternary that chose between them is why
          selecting three characters used to hide the layer's whole animation. */}
      {/* SHARED — what the LAYER does, whichever of its words you are looking
          at. The glyph phases used to sit up here too, and that was the tell:
          they are the one thing on this tab that a range and a caption state
          each have their own version of, so they belong below the line. */}
      {tab === "animate-shared" && (
        <Accordion defaultOpen="layer-in">
          <LayerAnimateItems clip={clip} titles={["Layer animate in", "Layer animate out"]} />
          <CaretItem clip={clip} />
        </Accordion>
      )}

      {/* SCOPED — HOW THESE GLYPHS MOVE, at whichever scope you picked.
          One idea, three stores: the layer keeps `animations.in/out`, a range
          keeps its own spec, a caption state keeps one it replays on entry.
          Routing them through one place is what makes the strip mean something
          here — and what stops the base scope showing an empty panel, which is
          what it did while these lived above the line. */}
      {tab === "animate" && (
        rangeActive ? (
          <PanelSection title="Range animation">
            <AnimationSpecEditor
              spec={activeRange?.animation ?? null}
              nullLabel="Inherit from clip"
              onChange={(spec) =>
                update("Range animation", (c) => {
                  if (c.kind !== "text") return;
                  c.ranges = applyRangePatch(c.ranges, rangeSpan!.start, rangeSpan!.end, { animation: spec });
                })
              }
            />
          </PanelSection>
        ) : captionState ? (
          <StateAnimation clip={clip} state={captionState} />
        ) : (
          <Accordion defaultOpen="text-in">
            <AccordionItem
              id="text-in"
              title="Text animate in"
              icon={<ArrowRightToLine />}
              meta={inMixed.preset ? <AccordionMeta>Mixed</AccordionMeta> : <SpecBadge spec={clip.animations.in} />}
              clipboard={textInClipboard}
            >
              <AnimationSpecEditor
                spec={clip.animations.in}
                rhythm={{ clip, phase: "in" }}
                nullLabel="None"
                mixed={inMixed}
                onChange={(spec, mergeKey) =>
                  update("Change in animation", (c) => {
                    if (c.kind === "text") c.animations.in = spec ? structuredClone(spec) : null;
                  }, mergeKey)
                }
              />
            </AccordionItem>
            <AccordionItem
              id="text-out"
              title="Text animate out"
              icon={<ArrowRightFromLine />}
              meta={outMixed.preset ? <AccordionMeta>Mixed</AccordionMeta> : <SpecBadge spec={clip.animations.out} />}
              clipboard={textOutClipboard}
            >
              <AnimationSpecEditor
                spec={clip.animations.out}
                rhythm={{ clip, phase: "out" }}
                nullLabel="None"
                mixed={outMixed}
                onChange={(spec, mergeKey) =>
                  update("Change out animation", (c) => {
                    if (c.kind === "text") c.animations.out = spec ? structuredClone(spec) : null;
                  }, mergeKey)
                }
              />
            </AccordionItem>
          </Accordion>
        )
      )}

      {/* SCOPED — the sounds THESE characters make, on top of the layer's.
          A caption STATE carries none on purpose: "tick on every word as it
          highlights" is a question about WHEN a voice fires, and the slot
          table above already owns that seam — a second sound model hiding
          inside a style scope is what core's schema refuses. */}
      {tab === "sound" && rangeActive && (
        <PanelSection title="Range sound" collapsible={false}>
          <RangeSoundEditor
            clip={clip}
            value={activeRange?.sounds ?? {}}
            onChange={(patch) =>
              update("Range sound", (c) => {
                if (c.kind !== "text") return;
                c.ranges = applyRangePatch(c.ranges, rangeSpan!.start, rangeSpan!.end, { sounds: patch });
              })
            }
          />
        </PanelSection>
      )}
    </>
  );
}

/**
 * The state POP — a glyph scale, so it never re-wraps the line it lands on.
 *
 * Only the FOCUS pop is keyframable, because only it has a registry property
 * (`focusScale`) and a pop on "every word you haven't said yet" is a constant
 * by definition — there is nothing about it that changes with time. The other
 * two write the state directly, through the same field.
 */
function StatePop({ clip, state }: { clip: TextClip; state: CaptionState }) {
  const update = useClipUpdater(clip.id);
  const stored = clip.caption?.states[state].scale ?? 1;
  const sampled = useEffectiveValue(clip, "focusScale", stored);
  const value = state === "focus" && typeof sampled === "number" ? sampled : stored;
  const label = CAPTION_STATE_LABEL[state];

  return (
    <PanelSection title={`${label} pop`} collapsible={false}>
      <PropRow
        label="Scale"
        hint={`Size of the ${label.toLowerCase()} words, relative to the rest`}
        keyControl={
          state === "focus" ? (
            <KeyControl clip={clip} property="focusScale" currentValue={() => value} />
          ) : undefined
        }
      >
        <NumberInput
          value={Math.round(value * 100)}
          min={20}
          max={300}
          precision={0}
          unit="%"
          onChange={(v) =>
            update(
              `${label} pop`,
              (c) => {
                if (c.kind !== "text" || !c.caption) return;
                if (state !== "focus") {
                  c.caption.states[state].scale = v / 100;
                  return;
                }
                writeAnimatable(c, "focusScale", v / 100, useSession.getState().playheadMs, (cc) => {
                  if (cc.kind === "text" && cc.caption) cc.caption.states.focus.scale = v / 100;
                });
              },
              `${state}-pop`,
            )
          }
        />
      </PropRow>
    </PanelSection>
  );
}

/**
 * A STATE's glyph animation — replayed each time a cue enters it.
 *
 * `unread` has no entry instant (a cue is unread from the first frame), so
 * instead of an editor that could never fire, the tab shows the thing that
 * genuinely animates the unread words: the layer's own in/out phases. Same
 * controls, one scroll away from where you asked the question.
 */
function StateAnimation({ clip, state }: { clip: TextClip; state: CaptionState }) {
  const update = useClipUpdater(clip.id);
  if (state === "unread") {
    return (
      <Accordion defaultOpen="text-in">
        <AccordionItem id="text-in" title="Text animate in" icon={<ArrowRightToLine />} meta={<SpecBadge spec={clip.animations.in} />}>
          <AnimationSpecEditor
            spec={clip.animations.in}
            rhythm={{ clip, phase: "in" }}
            nullLabel="None"
            onChange={(spec, mergeKey) =>
              update("Change in animation", (c) => {
                if (c.kind === "text") c.animations.in = spec ? structuredClone(spec) : null;
              }, mergeKey)
            }
          />
        </AccordionItem>
        <AccordionItem id="text-out" title="Text animate out" icon={<ArrowRightFromLine />} meta={<SpecBadge spec={clip.animations.out} />}>
          <AnimationSpecEditor
            spec={clip.animations.out}
            rhythm={{ clip, phase: "out" }}
            nullLabel="None"
            onChange={(spec, mergeKey) =>
              update("Change out animation", (c) => {
                if (c.kind === "text") c.animations.out = spec ? structuredClone(spec) : null;
              }, mergeKey)
            }
          />
        </AccordionItem>
      </Accordion>
    );
  }
  const label = CAPTION_STATE_LABEL[state];
  return (
    <PanelSection title={`${label} animation`}>
      <AnimationSpecEditor
        spec={clip.caption?.states[state].animation ?? null}
        nullLabel="None"
        onChange={(spec, mergeKey) =>
          update(
            `${label} animation`,
            (c) => {
              if (c.kind === "text" && c.caption) c.caption.states[state].animation = spec;
            },
            mergeKey,
          )
        }
      />
    </PanelSection>
  );
}

/**
 * Text box sizing, Figma-style, in three modes:
 *  - Auto width  (maxWidth null)            → grows on one line
 *  - Auto height (maxWidth set)             → wraps at a fixed width, grows down
 *  - Fixed size  (maxWidth + maxHeight set) → fixed box, content clipped +
 *                                             vertically aligned
 * Dragging a text layer's canvas handles adjusts these too (Stage resize):
 * a side edge sets one axis, a corner both.
 */
type SizingMode = "autoW" | "autoH" | "fixed";
export function LayoutSection({ clip }: { clip: TextClip }) {
  const update = useClipUpdater(clip.id);
  // INSIDE AN AUTO LAYOUT the layout owns the box: its W / H — Hug, Fixed,
  // Fill — ARE this text's auto width, auto height and fixed box, edited in
  // "In layout". Two controls for one fact is how a fill width got overruled
  // by a box width typed here, so this section keeps only what is the text's.
  const inLayout = isLayoutMember(useDoc(), clip.id) !== null;
  const mode: SizingMode =
    clip.maxWidth === null ? "autoW" : clip.maxHeight === null ? "autoH" : "fixed";

  // The box is animatable like any other property, so the field must show the
  // SAMPLED value at the playhead — otherwise scrubbing an animated box leaves
  // the inspector reading the base number while the canvas draws another.
  const boxW = useEffectiveValue(clip, "maxWidth", clip.maxWidth ?? 800);
  const boxH = useEffectiveValue(clip, "maxHeight", clip.maxHeight ?? 400);

  const setSizing = (next: SizingMode) =>
    update(
      next === "autoW" ? "Auto width" : next === "autoH" ? "Auto height" : "Fixed size",
      (c) => {
        if (c.kind !== "text") return;
        if (next === "autoW") {
          c.maxWidth = null;
          c.maxHeight = null;
        } else if (next === "autoH") {
          c.maxWidth = c.maxWidth ?? 800;
          c.maxHeight = null;
        } else {
          c.maxWidth = c.maxWidth ?? 800;
          c.maxHeight = c.maxHeight ?? 400;
        }
      },
    );

  return (
    <PanelSection title="Sizing" defaultOpen>
      {!inLayout && (
      <PropRow label="Resizing">
        <IconTrack
          value={mode}
          items={[
            { id: "autoW", label: "Auto width — grow on one line", icon: <MoveHorizontal /> },
            { id: "autoH", label: "Auto height — wrap at a fixed width", icon: <WrapText /> },
            { id: "fixed", label: "Fixed size — a fixed box", icon: <Square /> },
          ]}
          onPick={(v) => setSizing(v as SizingMode)}
        />
      </PropRow>
      )}
      <PropRow toggle label="Clip content">
        <Switch
          checked={clip.clipContent}
          onCheckedChange={(v) =>
            update("Clip content", (c) => void (c.kind === "text" && (c.clipContent = v)), "clip-content")
          }
          title="Mask text and its effects to the box — off keeps overflow (and blurs) visible"
        />
      </PropRow>
      {!inLayout && mode !== "autoW" && (
        <PropRow
          label={mode === "fixed" ? "Box size" : "Box width"}
          // Fixed size keys BOTH axes from one button — a box is one thing, and
          // keying half of it is the state that produces "why is it only
          // animating sideways".
          keyControl={
            mode === "fixed" ? (
              <GroupKeyButton
                clip={clip}
                properties={[
                  { property: "maxWidth", currentValue: () => boxW },
                  { property: "maxHeight", currentValue: () => boxH },
                ]}
              />
            ) : (
              <KeyControl clip={clip} property="maxWidth" currentValue={() => boxW} />
            )
          }
        >
          <Pair>
            <NumberInput
              value={boxW}
              min={50}
              max={8000}
              precision={0}
              unit="W"
              title="Wrap width. Keyframable — animating it re-wraps the lines, which a scale can't do."
              onChange={(v) =>
                update(
                  "Change box width",
                  (c) => writeAnimatable(c, "maxWidth", v, useSession.getState().playheadMs, (t) => {
                    if (t.kind === "text") t.maxWidth = v;
                  }),
                  "box-w",
                )
              }
            />
            {mode === "fixed" && (
              <NumberInput
                value={boxH}
                min={24}
                max={8000}
                precision={0}
                unit="H"
                title="Box height. Keyframable."
                onChange={(v) =>
                  update(
                    "Change box height",
                    (c) => writeAnimatable(c, "maxHeight", v, useSession.getState().playheadMs, (t) => {
                      if (t.kind === "text") t.maxHeight = v;
                    }),
                    "box-h",
                  )
                }
              />
            )}
          </Pair>
        </PropRow>
      )}
      {mode === "fixed" && (
        <PropRow label="Vertical">
          <ToggleGroup
            type="single"
            size="sm"
            className="justify-start"
            value={clip.verticalAlign}
            onValueChange={(v) =>
              v && update("Vertical align", (c) => void (c.kind === "text" && (c.verticalAlign = v as TextClip["verticalAlign"])))
            }
          >
            <ToggleGroupItem value="top" className="px-2" title="Align top">
              <ArrowUpToLine className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="middle" className="px-2" title="Align middle">
              <AlignCenterVertical className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="bottom" className="px-2" title="Align bottom">
              <ArrowDownToLine className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
        </PropRow>
      )}
    </PanelSection>
  );
}

/**
 * Editable text content with a keyframe cluster. Editing writes a keyframe at
 * the playhead when content is keyed (or record mode is armed) via
 * writeAnimatable — so the string itself animates (held between keys) — else it
 * edits the base text. The field shows the effective content at the playhead.
 */
function ContentSection({ clip }: { clip: TextClip }) {
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, isText);
  const field = useField(peers, "text", (c) => c.text);
  const text = typeof field.value === "string" ? field.value : clip.text;
  const captioned = mergeReads(peers, (c) => c.caption !== null);

  const commit = (next: string) => {
    update(
      "Edit content",
      (c) => {
        if (c.kind !== "text") return;
        writeAnimatable(c, "text", next, useSession.getState().playheadMs, (cc) => {
          if (cc.kind !== "text") return;
          cc.text = next;
          cc.name = next.slice(0, 24) || "Text";
        });
      },
      "content-edit",
    );
  };

  /**
   * Add or drop the caption module. Adding seeds one cue per word across the
   * clip and gives the focus a look you can see immediately; dropping keeps the
   * text and every style range, because those were never the caption's.
   */
  const setCaptioned = (on: boolean) =>
    update(on ? "Add captions" : "Remove captions", (c) => {
      if (c.kind !== "text") return;
      c.caption = on ? seedCaption(c.text, c.durationMs) : null;
      if (!on) c.keyframes = c.keyframes.filter((t) => t.property !== "focusScale");
    });

  return (
    // OPEN by default. The Captions switch lives in here, and a switch nobody
    // can see is a feature nobody knows exists — which is exactly what happened
    // while this section defaulted closed.
    <PanelSection title="Content" defaultOpen>
      <PropRow
        label="Text"
        keyControl={<KeyControl clip={clip} property="text" currentValue={() => clip.text} />}
      >
        <textarea
          value={field.mixed ? "" : text}
          placeholder={field.mixed ? "Mixed — type to set all" : undefined}
          rows={2}
          spellCheck={false}
          onChange={(e) => commit(e.target.value)}
          className="w-full resize-y rounded-md border bg-input/30 px-2 py-1.5 text-xs leading-snug outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </PropRow>
      {peers.length === 1 && <NumberObjects clip={clip} />}
      <PropRow toggle label="Captions" hint="Time the words, then style each state as it is spoken">
        <div className="flex flex-1 items-center gap-2">
          <Switch checked={captioned.value && !captioned.mixed} onCheckedChange={setCaptioned} />
          {/* The count is the DOOR to the cue list, not a readout. It is the
              only place in the panel that names cues, so it is where a hand
              goes looking for them — and a number you cannot click, beside a
              tab you have to find, is the panel keeping a secret. */}
          {clip.caption && peers.length === 1 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => revealInInspector({ tab: "cues", section: "cues" })}
                  className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Captions className="size-3" />
                  {clip.caption.cues.length} cues
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Open the cue list</TooltipContent>
            </Tooltip>
          )}
        </div>
      </PropRow>
    </PanelSection>
  );
}

/**
 * NUMBERS THAT COUNT — one row per number object in keyed content.
 *
 * When two content keys differ in a number, that number counts between them
 * (`text/count-up.ts`) instead of cutting. Each object is the nth number in
 * the text; the row names it by the values it passes through, switches its
 * count, and gives it its own curve — or rides the content key's, which is
 * the default and what the key's own easing shows. Only numbers that actually
 * change are listed: a number that holds still has nothing to animate.
 */
function NumberObjects({ clip }: { clip: TextClip }) {
  const update = useClipUpdater(clip.id);
  const track = clip.keyframes.find((t) => t.property === "text" && !t.range);
  const keys = React.useMemo(
    () => [...(track?.keys ?? [])].filter((k) => typeof k.value === "string").sort((a, b) => a.timeMs - b.timeMs),
    [track],
  );
  const objects = React.useMemo(
    () => countUpObjects(keys.map((k) => k.value as string)).filter((o) => o.changes),
    [keys],
  );
  if (objects.length === 0) return null;
  const keyEasing = keys[0]?.easing ?? ({ kind: "linear" } as const);

  const write = (
    slot: number,
    patch: { enabled?: boolean; easing?: Easing | null; steps?: number | null },
    label: string,
    mergeKey?: string,
  ) =>
    update(label, (c) => {
      if (c.kind !== "text") return;
      const current = countSettingFor(c.countUps, slot);
      const next = { ...current, ...patch };
      c.countUps = [...c.countUps.filter((s) => s.slot !== slot), next].sort((a, b) => a.slot - b.slot);
    }, mergeKey);

  return (
    <PropRow label="Numbers" hint="Numbers that change between content keys count to their new value instead of cutting">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {objects.map((o) => {
          const setting = countSettingFor(clip.countUps, o.slot);
          const shown = o.values.filter((v): v is string => v !== null);
          const path = shown.length > 2 ? `${shown[0]} → … → ${shown[shown.length - 1]}` : shown.join(" → ");
          return (
            <div key={o.slot} className="flex h-(--control-h) min-w-0 items-center gap-2">
              <Switch
                checked={setting.enabled}
                onCheckedChange={(on) => write(o.slot, { enabled: on }, on ? "Count number" : "Cut number")}
                aria-label={`Count ${path}`}
              />
              <span
                className={cn("min-w-0 flex-1 truncate font-mono text-xs tabular-nums", !setting.enabled && "text-muted-foreground")}
                dir="auto"
              >
                {path}
              </span>
              {setting.enabled && (
                <>
                  {/* Steps: the app's scrub field. Commits on Enter/blur, never per
                      keystroke; cleared, it reads — and is — Auto. */}
                  <NumberInput
                    value={setting.steps ?? undefined}
                    emptyLabel="Auto"
                    min={1}
                    max={1000}
                    step={1}
                    precision={0}
                    className="w-16 shrink-0"
                    title="Steps — Auto counts every value; a number jumps that many times, paced by the easing"
                    onEmpty={() => write(o.slot, { steps: null }, "Number steps")}
                    onChange={(n) => write(o.slot, { steps: Math.round(n) }, "Number steps", `steps-${o.slot}`)}
                  />
                  {setting.easing && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="Follow the content key's easing"
                          onClick={() => write(o.slot, { easing: null }, "Number easing")}
                          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground [&_svg]:size-3"
                        >
                          <RotateCcw />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Follow the key&apos;s easing</TooltipContent>
                    </Tooltip>
                  )}
                  <EasingPicker
                    value={setting.easing ?? keyEasing}
                    onChange={(e) => write(o.slot, { easing: e }, "Number easing")}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
    </PropRow>
  );
}

/**
 * THE CAPTION section — the one motion every state crosses on.
 *
 * It listed the three states as cards until the scope strip moved down here
 * beside it, and then it was the same control twice, forty pixels apart, in a
 * panel already short of room. Two ways to do one thing is not generosity, it
 * is a question the person has to answer before they can act. The strip won:
 * it is the one that also appears in Effects, in Animate, in Sound.
 *
 * What is left is what genuinely has no other home. The crossing belongs to
 * NO state — it is how a word gets from one to the next — so it cannot live
 * under a tab, and it sits with the switch that brought the states into
 * existence, which is where you are standing when you first wonder about it.
 */
function CaptionSection({ clip, caption }: { clip: TextClip; caption: CaptionSpec }) {
  const update = useClipUpdater(clip.id);
  const editMotion = (label: string, fn: (m: CaptionMotion) => void, mergeKey?: string) =>
    update(label, (c) => {
      if (c.kind === "text" && c.caption) fn(c.caption.motion);
    }, mergeKey);

  return (
    <PanelSection id="caption" title="Captions" count={caption.cues.length}>
      <PropRow label="Crossing" hint="How long a word takes to become the next state">
        <NumberInput
          value={caption.motion.durationMs}
          min={0}
          max={4000}
          step={10}
          precision={0}
          unit="ms"
          onChange={(v) => editMotion("Caption crossing", (m) => void (m.durationMs = v), "caption-cross")}
        />
      </PropRow>
      <PropRow toggle label="Travel" hint="Slide the highlight to the next word instead of cutting — it crossfades across a line break">
        <div className="flex flex-1 items-center gap-2">
          <Switch
            checked={caption.motion.travel}
            onCheckedChange={(on) => editMotion("Caption travel", (m) => void (m.travel = on))}
          />
          <MoveHorizontal className={cn("size-3", caption.motion.travel ? "text-primary" : "text-muted-foreground/50")} />
        </div>
      </PropRow>
      <EasingBlock
        value={caption.motion.easing}
        onChange={(easing) => editMotion("Caption curve", (m) => void (m.easing = easing))}
      />
    </PanelSection>
  );
}

// ── Keyframes overview: every animated property, with nav + delete ───────────

export function KeyframesOverview({ clip }: { clip: Clip }) {
  const update = useClipUpdater(clip.id);
  if (clip.keyframes.length === 0) {
    return (
      <PanelSection
        title="Keyframes"
        collapsible={false}
        hint="Hover any property and click its ◇ to key it at the playhead. Keys show on the clip in the timeline — drag them, or click one to edit its easing."
      >
        <Note>Nothing animated yet</Note>
      </PanelSection>
    );
  }
  return (
    <PanelSection title="Keyframes" collapsible={false}>
      {clip.keyframes.map((track) => (
        <div key={track.id} className="group/row grid grid-cols-[1fr_auto_auto] items-center gap-1.5">
          <span className="truncate text-[11px] text-foreground/85">
            {propertyDef(track.property)?.label ?? track.property}
            <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
              {track.keys.length}
            </span>
          </span>
          <KeyControl clip={clip} property={track.property} currentValue={() => track.keys[0]?.value ?? 0} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove all ${track.property} keyframes`}
            className="size-5 text-muted-foreground/60 hover:text-destructive"
            onClick={() =>
              update("Remove keyframe track", (c) => {
                const i = c.keyframes.findIndex((x) => x.id === track.id);
                if (i !== -1) c.keyframes.splice(i, 1);
              })
            }
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
    </PanelSection>
  );
}

/**
 * The typewriter CARET.
 *
 * It lives in the Animate tab rather than Design because it is a property of
 * the reveal, not of the type: it exists to show where the typing head is, and
 * it is meaningless without an in-animation to follow. Everything here is look
 * — position and blink are derived per frame from the same schedule the glyphs
 * animate on (`caretAt`), which is why the cursor lands correctly after a
 * content keyframe, scrubs backwards cleanly, and exports frame-identically.
 */
function CaretItem({ clip }: { clip: TextClip }) {
  const update = useClipUpdater(clip.id);
  const caret = clip.caret;
  const setCaret = (patch: Partial<TextClip["caret"]>, label: string, mergeKey?: string) =>
    update(
      label,
      (c) => {
        if (c.kind === "text") Object.assign(c.caret, patch);
      },
      mergeKey,
    );

  const SHAPES = [
    { id: "bar", label: "Bar" },
    { id: "block", label: "Block" },
    { id: "underline", label: "Underline" },
  ] as const;

  return (
    <AccordionItem
      id="caret"
      title="Typing cursor"
      icon={<TextCursorInput />}
      meta={
        caret.enabled ? (
          <AccordionMeta>{SHAPES.find((x) => x.id === caret.style)?.label}</AccordionMeta>
        ) : (
          <AccordionMeta muted>Off</AccordionMeta>
        )
      }
    >
      <PropRow toggle label="Show" hint="The cursor rides the typing head, so it needs an entrance to follow.">
        {/* Toggling only flips `enabled` — shape, blink and width stay put, so
            turning the cursor off to compare and back on is free. */}
        <Switch
          checked={caret.enabled}
          onCheckedChange={(on) => setCaret({ enabled: on }, on ? "Show cursor" : "Hide cursor")}
        />
      </PropRow>

      {caret.enabled && (
        <>
          {/* State you must SEE, in one line. This was a four-line paragraph
              explaining the mechanism; the mechanism is not the news, the
              missing entrance is. */}
          {!clip.animations.in && <Note tone="warn">No entrance to follow — it rests at the end.</Note>}

          <PropRow label="Shape">
            <ToggleGroup
              type="single"
              value={caret.style}
              onValueChange={(v) => v && setCaret({ style: v as "bar" | "block" | "underline" }, "Cursor shape")}
              className="w-full"
            >
              {SHAPES.map((sh) => (
                <ToggleGroupItem key={sh.id} value={sh.id} className="flex-1 text-[11px]">
                  {sh.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </PropRow>

          {/* Both are FEEL against the stage, and both declare a range — so both
              are bars you sweep, not boxes you type into. */}
          <PropRow wide>
            <Range
              label="Blink"
              value={caret.blinkMs}
              min={0}
              max={2000}
              step={20}
              precision={0}
              unit="ms"
              defaultValue={1060}
              format={(v) => (v === 0 ? "Solid" : `${Math.round(v)}ms`)}
              onChange={(v) => setCaret({ blinkMs: v }, "Cursor blink", "caret-blink")}
            />
          </PropRow>
          <PropRow wide>
            <Range
              label="Width"
              value={Math.round(caret.width * 100)}
              min={1}
              max={200}
              step={1}
              precision={0}
              unit="%"
              defaultValue={8}
              onChange={(v) => setCaret({ width: v / 100 }, "Cursor width", "caret-width")}
            />
          </PropRow>

          <PropRow label="At end">
            <ToggleGroup
              type="single"
              value={caret.persist ? "keep" : "vanish"}
              onValueChange={(v) =>
                v && setCaret({ persist: v === "keep" }, v === "keep" ? "Keep cursor" : "Hide cursor at end")
              }
              className="w-full"
            >
              <ToggleGroupItem value="vanish" className="flex-1 text-[11px]">
                Vanish
              </ToggleGroupItem>
              <ToggleGroupItem value="keep" className="flex-1 text-[11px]">
                Keep blinking
              </ToggleGroupItem>
            </ToggleGroup>
          </PropRow>
        </>
      )}
    </AccordionItem>
  );
}


/** The collapsed summary of a glyph-level phase — preset, then its per-unit duration. */
function SpecBadge({ spec }: { spec: AnimationSpec | null }) {
  const def = spec ? getPreset(spec.preset) : undefined;
  if (!spec || !def) return <AccordionMeta muted>None</AccordionMeta>;
  return (
    <>
      <AccordionMeta>{def.label}</AccordionMeta>
      <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/60">
        {spec.durationMs}
      </span>
    </>
  );
}

export function AnimationSpecEditor({
  spec,
  onChange,
  nullLabel,
  mixed,
  rhythm,
}: {
  spec: AnimationSpec | null;
  onChange: (spec: AnimationSpec | null, mergeKey?: string) => void;
  nullLabel: string;
  /**
   * The clip + phase this spec animates, when the editor is bound to exactly
   * one of them. Present → the rhythm strip is drawn from the real schedule;
   * absent (multi-select, captions) → the numbers stand alone, because a strip
   * that averaged several clips would be a picture of nothing.
   */
  rhythm?: { clip: TextClip; phase: "in" | "out" };
  /**
   * Per-field "Mixed" flags for multi-select: when `preset` diverges the picker
   * reads "Mixed" and the sub-fields are hidden (differing presets share no
   * params); when `durationMs`/`staggerMs` diverge those inputs read "Mixed".
   * Omitted for single-clip use, where nothing is ever mixed.
   */
  mixed?: { preset?: boolean; durationMs?: boolean; staggerMs?: boolean };
}) {
  const def = spec ? getPreset(spec.preset) : undefined;
  return (
    <>
      <AnimationStage
        presets={TEXT_ANIMATION_PRESETS}
        value={mixed?.preset ? null : spec?.preset ?? null}
        sample="text"
        phase={rhythm?.phase ?? "in"}
        text={rhythm?.clip.text}
        spec={mixed?.preset ? null : spec}
        nullLabel={mixed?.preset ? "Mixed" : nullLabel}
        emptyLabel={mixed?.preset ? "Mixed" : nullLabel}
        onSelect={(id) => onChange(id === null ? null : retargetAnimSpec(mixed?.preset ? null : spec, id))}
      />

      {spec && !mixed?.preset && (
        <>
          <PropRow label="Per">
            <Select
              value={spec.unit}
              onValueChange={(unit) => onChange({ ...spec, unit: unit as AnimationSpec["unit"] })}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="letter">Letter</SelectItem>
                <SelectItem value="word">Word</SelectItem>
                <SelectItem value="line">Line</SelectItem>
              </SelectContent>
            </Select>
          </PropRow>
          <PropRow label="Timing">
            <Pair>
              <NumberInput
                label={<ArrowDownToLine className="size-2.5" />}
                value={spec.durationMs}
                mixed={mixed?.durationMs}
                min={0}
                max={5000}
                step={10}
                precision={0}
                unit="ms"
                title="Duration per unit"
                onChange={(v) => onChange({ ...spec, durationMs: v })}
              />
              <NumberInput
                label={<ArrowUpFromLine className="size-2.5 rotate-90" />}
                value={spec.staggerMs}
                mixed={mixed?.staggerMs}
                min={0}
                max={2000}
                step={5}
                precision={0}
                unit="ms"
                title="Stagger between units"
                onChange={(v) => onChange({ ...spec, staggerMs: v })}
              />
            </Pair>
          </PropRow>
          <PropRow label="Delay">
            <NumberInput
              label={<Clock className="size-2.5" />}
              value={spec.delayMs}
              min={0}
              max={10000}
              step={10}
              precision={0}
              unit="ms"
              title="Gap against this phase's own edge — an entrance waits this long after it starts, an exit finishes this long before it ends."
              onChange={(v) => onChange({ ...spec, delayMs: v })}
            />
          </PropRow>
          {/* Humanisation. Universal, not per-preset: a rhythm is a property of
              the STAGGER, so every preset gets it from one place instead of
              fifteen presets each inventing a "randomness" param. */}
          <PropRow label="Humanize">
            <Pair>
              <NumberInput
                label={<Shuffle className="size-2.5" />}
                value={spec.jitterMs}
                min={0}
                max={600}
                step={5}
                precision={0}
                unit="ms"
                title="Timing jitter — each unit waits up to this long extra before it moves. Kills the metronome."
                onChange={(v) => onChange({ ...spec, jitterMs: v })}
              />
              <NumberInput
                label={<MoveHorizontal className="size-2.5" />}
                value={spec.scatterPx}
                min={0}
                max={400}
                step={1}
                precision={0}
                unit="px"
                title="Positional scatter while the unit is in motion — fades to zero, so the resting layout stays exact."
                onChange={(v) => onChange({ ...spec, scatterPx: v })}
              />
            </Pair>
          </PropRow>
          {spec.scatterPx > 0 && (
            <PropRow label="Tilt">
              <NumberInput
                value={spec.scatterDeg}
                min={0}
                max={90}
                step={1}
                precision={0}
                unit="°"
                title="Rotational scatter, faded out on settle like the positional one."
                onChange={(v) => onChange({ ...spec, scatterDeg: v })}
              />
            </PropRow>
          )}

          {rhythm && (
            <div className="pt-0.5">
              <AnimationRhythm clip={rhythm.clip} phase={rhythm.phase} spec={spec} />
            </div>
          )}

          {/* Preset knobs are FEEL, not figures — judged against the stage at
              the top of the section, so they get the bar you sweep. */}
          {def?.params.map((p) => (
            <ParamControl
              key={p.key}
              def={p}
              value={spec.params[p.key] ?? p.defaultValue}
              onChange={(v) => onChange({ ...spec, params: { ...spec.params, [p.key]: v } })}
            />
          ))}

          <EasingBlock value={spec.easing} onChange={(easing) => onChange({ ...spec, easing })} />
        </>
      )}
    </>
  );
}

// ── Sound editors ─────────────────────────────────────────────────────────────

/**
 * A range's sound override, keyed by the STACK ENTRY it patches.
 *
 * Keyed rather than per-phase because a phase can now hold several sounds, and
 * "this word, but popped" has to say WHICH hit it is re-voicing. Every field a
 * patch omits keeps following the clip, so a range can change only the pack and
 * still inherit later volume edits.
 */
function RangeSoundEditor({
  clip,
  value,
  onChange,
}: {
  clip: TextClip;
  value: RangeSoundOverrides;
  onChange: (patch: RangeSoundOverrides) => void;
}) {
  // Only per-unit entries can vary by range — a whole-layer or transition hit
  // fires once for the clip, so a span of text has no say over it.
  const rows = clip.sounds.filter((s) => s.trigger.kind === "text");

  if (rows.length === 0) {
    return <Note>No per-letter sound to override.</Note>;
  }

  const patch = (id: string, next: Partial<SoundVoice> | null) => {
    const merged: RangeSoundOverrides = { ...value };
    if (next === null) delete merged[id];
    else merged[id] = { ...(merged[id] ?? {}), ...next };
    onChange(merged);
  };

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const over = value[row.id] ?? null;
        return (
          <div key={row.id} className="space-y-1 rounded-md border bg-card/40 p-1.5">
            <div className="text-[10px] text-muted-foreground">
              {row.phase === "in" ? "In" : "Out"} · per letter
            </div>
            <PropRow label="Pack">
              <Select
                value={over?.pack ?? "__inherit__"}
                onValueChange={(pack) =>
                  patch(row.id, pack === "__inherit__" ? null : { pack: pack as SoundPackId })
                }
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit from clip</SelectItem>
                  {soundPackIdSchema.options.map((p) => (
                    <SelectItem key={p} value={p}>
                      {SOUND_PACK_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PropRow>
            {over && (
              <PropRow label="Volume">
                <NumberInput
                  value={Math.round((over.volume ?? row.volume) * 100)}
                  min={0}
                  max={100}
                  precision={0}
                  unit="%"
                  onChange={(v) => patch(row.id, { volume: v / 100 })}
                />
              </PropRow>
            )}
          </div>
        );
      })}
    </div>
  );
}
