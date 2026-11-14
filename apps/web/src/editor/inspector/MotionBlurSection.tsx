"use client";

import * as React from "react";
import {
  DEFAULT_CLIP_MOTION_BLUR,
  isVisualClip,
  motionBlurSettingsSchema,
  type MotionDocument,
  type MotionBlurCombine,
  type MotionBlurSampling,
  type MotionBlurSettings,
  type ShutterWeighting,
  type VisualClip,
} from "@solomotion/core";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { useField } from "./animatable";
import { mergeReads, type Field } from "./merge";
import { usePeers } from "./selection-scope";
import { Disclosure, Half, PanelSection, Pair, PropRow } from "./controls";
import { KeyControl } from "./keyframe-controls";
import { PresetPicker } from "./effect-editor/PresetPicker";
import { ShutterDial } from "./ShutterDial";
import { useClipUpdater } from "./use-clip-updater";

/**
 * MOTION BLUR — the layer's shutter.
 *
 * It sits in Design, beside Transform and Appearance, and NOT under Effects.
 * That is not filing: an effect is `pixels(t) → pixels`, while this re-invokes
 * the whole layer render — the effect stack included — once per sample. It is a
 * property of the layer in exactly the way `opacity`, `feather` and `blendMode`
 * are, and putting it in the effect stack would leave its position in that
 * stack meaningless.
 *
 * The section is deliberately shallow by default: a switch, a dial, and one
 * quality picker. Everything past that is real control people came looking for,
 * so it is present but folded away.
 */

const WEIGHTINGS: ReadonlyArray<{ id: ShutterWeighting; label: string; hint: string }> = [
  { id: "box", label: "Even", hint: "A real film gate — every instant weighs the same." },
  { id: "ease", label: "Soft", hint: "Fades at both ends. Hides a low sample count." },
  { id: "trail", label: "Trail", hint: "Heaviest in the past — a comet tail behind the layer." },
  { id: "lead", label: "Lead", hint: "Heaviest ahead — anticipation in front of the layer." },
  { id: "curve", label: "Curve", hint: "Your own weighting curve." },
];

const SAMPLINGS: ReadonlyArray<{ id: MotionBlurSampling; label: string; hint: string }> = [
  { id: "velocity", label: "Fast", hint: "A straight smear along the measured motion. One extra pass." },
  { id: "transform", label: "Exact", hint: "Renders once, re-composites per sample. Arcs and spins are exact." },
  { id: "content", label: "Full", hint: "Re-renders per sample — blurs animating content too. Costly." },
];

const COMBINES: ReadonlyArray<{ id: MotionBlurCombine; label: string; hint: string }> = [
  { id: "average", label: "Average", hint: "Physically correct." },
  { id: "add", label: "Add", hint: "Long-exposure light trails — bright things paint light." },
  { id: "screen", label: "Screen", hint: "Like Add, but rolls off instead of clipping." },
  { id: "max", label: "Lighten", hint: "Keeps the brightest sample. A harder streak." },
];

/** A compact segmented picker. Wider than `IconTrack` because these need words. */
function Segmented<T extends string>({
  items,
  value,
  onPick,
}: {
  items: ReadonlyArray<{ id: T; label: string; hint: string }>;
  /** Null while the selection disagrees — nothing reads as pressed. */
  value: T | null;
  onPick: (id: T) => void;
}) {
  return (
    <div className="track flex h-7 w-full items-center gap-px bg-input/35">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          title={it.hint}
          aria-pressed={value === it.id}
          onClick={() => onPick(it.id)}
          className={cn(
            "min-w-0 flex-1 truncate rounded-[5px] px-1 py-1 text-[10px] transition-colors",
            value === it.id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/**
 * What a layer's shutter actually renders with: its own override, or its
 * comp's. The comp object carries the master switch alongside the settings, so
 * that is stripped rather than letting `enabled` masquerade as a setting.
 */
function shutterOf(doc: MotionDocument, clip: VisualClip): MotionBlurSettings {
  const mb = clip.motionBlur ?? DEFAULT_CLIP_MOTION_BLUR;
  if (mb.override) return mb.override;
  const frame = doc.frames.find((f) => f.id === clip.frameId);
  if (!frame) return motionBlurSettingsSchema.parse({});
  const { enabled: _master, ...rest } = frame.motionBlur;
  return rest;
}

/** Blurring right now: the layer's gate AND its comp's master. */
function blurringOf(doc: MotionDocument, clip: VisualClip): boolean {
  const frame = doc.frames.find((f) => f.id === clip.frameId);
  return (clip.motionBlur ?? DEFAULT_CLIP_MOTION_BLUR).enabled && (frame?.motionBlur.enabled ?? false);
}

export function MotionBlurSection({ clip }: { clip: VisualClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const update = useClipUpdater(clip.id);
  const peers = usePeers(clip, isVisualClip);
  const [advanced, setAdvanced] = React.useState(false);

  const settings = shutterOf(doc, clip);
  const shutter = <T,>(read: (s: MotionBlurSettings) => T) => mergeReads(peers, (c) => read(shutterOf(doc, c)));
  const custom = peers.some((c) => c.motionBlur.override !== null);

  // The dial values are keyframable, so they read through the animatable seam
  // like every other property — the dial follows the playhead.
  const angle = useField(peers, "mblur.shutterAngle", (c) => shutterOf(doc, c).shutterAngle);
  const phase = useField(peers, "mblur.shutterPhase", (c) => shutterOf(doc, c).shutterPhase);
  const strength = useField(peers, "mblur.strength", (c) => shutterOf(doc, c).strength);
  const amount = useField(peers, "mblur.amount", (c) => shutterOf(doc, c).amount);
  const sampling = shutter((s) => s.sampling);
  const weighting = shutter((s) => s.weighting);
  const combine = shutter((s) => s.combine);
  const maxSamples = shutter((s) => s.maxSamples);
  const pick = <T,>(f: Field<T>) => (f.mixed ? null : f.value);

  /**
   * Writing ANY field customises the layer. Making people press "Customise"
   * first would be a mode to discover before the control does anything — so
   * the first edit forks a faithful copy of what they were already seeing, and
   * "Use comp settings" puts it back. Same shape as overriding an inherited
   * style anywhere else.
   */
  const patch = (label: string, p: Partial<MotionBlurSettings>, mergeKey?: string) =>
    update(
      label,
      (c, d) => {
        // Each layer forks what IT was showing, so a shared edit to one field
        // leaves every other field of every layer where it was.
        if (!isVisualClip(c)) return;
        c.motionBlur = { ...c.motionBlur, override: { ...shutterOf(d, c), ...p } };
      },
      mergeKey,
    );

  /**
   * ONE SWITCH, ONE TRUTH.
   *
   * Motion blur has two gates — this layer's, and the comp master that v55
   * wrote off on every existing project so old renders kept their look. The
   * header switch used to show only the LAYER's, which schema-defaults to on.
   * So the switch read ON, the layer rendered no blur at all, and an amber
   * banner underneath had to explain that the control above it was lying. Two
   * facts behind one control, one of them invisible, and a paragraph of prose
   * paying for the difference.
   *
   * It now shows the EFFECTIVE state: on means blurring, off means not, and
   * nothing has to be read to know which. Switching it on opens whichever gate
   * is shut — in one undo step, because "turn this on" is one intention — and
   * the status bar names the comp-wide half so it is never a silent side
   * effect on the other layers. Switching it off touches only this layer: the
   * comp master is shared, and one layer must not close a door for the rest.
   */
  const on = mergeReads(peers, (c) => blurringOf(doc, c));
  const effectiveOn = on.value && !on.mixed;

  const setEnabled = (next: boolean) => {
    if (!next) {
      update("Motion blur off", (c) => {
        if (isVisualClip(c)) c.motionBlur = { ...c.motionBlur, enabled: false };
      });
      return;
    }
    const ids = new Set(peers.map((c) => c.id));
    const shut = new Set(
      peers.filter((c) => !doc.frames.find((f) => f.id === c.frameId)?.motionBlur.enabled).map((c) => c.frameId),
    );
    store.update("Motion blur on", (d) => {
      for (const t of d.tracks) {
        for (const c of t.clips) if (ids.has(c.id) && isVisualClip(c)) c.motionBlur = { ...c.motionBlur, enabled: true };
      }
      for (const f of d.frames) if (shut.has(f.id)) f.motionBlur.enabled = true;
    });
    if (shut.size > 0) toast(shut.size > 1 ? "Motion blur enabled for these comps" : "Motion blur enabled for this comp");
  };

  return (
    <PanelSection
      id="motion-blur"
      title="Motion Blur"
      hint="The layer's shutter. Blurs whatever it does across the exposure — position, rotation, scale, and its in/out animation."
      /*
       * Open when it is ON, collapsed when it is OFF — a shutter that is doing
       * something to the picture is the thing you came to tune, and it should
       * not be a click away. Off, it is a decision not yet made: the switch in
       * the header is the whole control, and eight rows of shutter maths below
       * it would be a wall between you and the next section.
       *
       * Seeded per SELECTION (the key below), so it re-evaluates when you pick
       * another layer but never fights you inside one: collapse it and it stays
       * collapsed.
       */
      key={`${peers.map((c) => c.id).join(",")}:${effectiveOn}`}
      defaultOpen={effectiveOn}
      transfer={peers.length === 1 ? { domains: ["motion"], clipId: clip.id } : undefined}
      // Collapsed, the header still answers "is it on, and at what angle?"
      summary={
        effectiveOn ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            {angle.mixed ? "Mixed" : `${Math.round(angle.value)}°`}
          </span>
        ) : null
      }
      actions={
        <div className="flex items-center gap-1.5">
          {/* The SAME three-scope picker every effect card uses — motion blur is
              not an effect, but "save this look and use it again" is one
              concept, so it gets the one implementation. */}
          <PresetPicker
            kind="motion-blur"
            label="Shutter"
            defaultName="Shutter"
            capture={() => settings}
            onApply={(data) => patch("Shutter preset", data as Partial<MotionBlurSettings>)}
          />
          <Switch checked={effectiveOn} onCheckedChange={setEnabled} aria-label="Motion blur" />
        </div>
      }
    >
      <div className={cn("space-y-2", !effectiveOn && "pointer-events-none opacity-40")}>
        {/* The dial is the explanation; the fields beside it are the authority. */}
        <div className="flex items-start gap-3">
          <ShutterDial
            angle={angle.value}
            phase={phase.value}
            onChange={(n) =>
              patch(
                n.angle !== undefined ? "Shutter angle" : "Shutter phase",
                n.angle !== undefined ? { shutterAngle: n.angle } : { shutterPhase: n.phase },
                "mblur-dial",
              )
            }
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <PropRow
              label="Shutter"
              hint="Exposure as a fraction of one frame. 180° is the film standard."
              keyControl={<KeyControl clip={clip} property="mblur.shutterAngle" currentValue={() => angle.value} />}
            >
              <Half>
                <NumberInput
                  value={Math.round(angle.value)}
                  mixed={angle.mixed}
                  min={0}
                  max={3600}
                  precision={0}
                  unit="°"
                  onChange={(v) => patch("Shutter angle", { shutterAngle: v })}
                />
              </Half>
            </PropRow>
            <PropRow
              label="Phase"
              hint="Where the exposure sits around the frame. −½ the angle centres it."
              keyControl={<KeyControl clip={clip} property="mblur.shutterPhase" currentValue={() => phase.value} />}
            >
              <Half>
                <NumberInput
                  value={Math.round(phase.value)}
                  mixed={phase.mixed}
                  min={-3600}
                  max={360}
                  precision={0}
                  unit="°"
                  onChange={(v) => patch("Shutter phase", { shutterPhase: v })}
                />
              </Half>
            </PropRow>
          </div>
        </div>

        <PropRow label="Quality" hint="What gets re-sampled. Exact is right for almost everything.">
          <Segmented items={SAMPLINGS} value={pick(sampling)} onPick={(v) => patch("Blur quality", { sampling: v })} />
        </PropRow>

        <Disclosure open={advanced} onToggle={() => setAdvanced((v) => !v)} count={4} />

        {advanced && (
          <div className="space-y-1.5 border-t pt-2">
            <PropRow label="Falloff" hint="How the exposure is weighted across the shutter. Trail is a comet tail.">
              <Segmented items={WEIGHTINGS} value={pick(weighting)} onPick={(v) => patch("Shutter falloff", { weighting: v })} />
            </PropRow>
            <PropRow label="Blend" hint="How the samples pile up. Add gives long-exposure light trails.">
              <Segmented items={COMBINES} value={pick(combine)} onPick={(v) => patch("Sample blend", { combine: v })} />
            </PropRow>
            <PropRow
              label="Strength"
              hint="Mix against the crisp layer. Below 1 stays readable while it smears."
              keyControl={<KeyControl clip={clip} property="mblur.strength" currentValue={() => strength.value} />}
            >
              <Pair>
                <NumberInput
                  value={Math.round(strength.value * 100)}
                  mixed={strength.mixed}
                  min={0}
                  max={100}
                  precision={0}
                  unit="%"
                  onChange={(v) => patch("Blur strength", { strength: v / 100 })}
                />
                <NumberInput
                  value={amount.value}
                  mixed={amount.mixed}
                  min={0}
                  max={4}
                  step={0.05}
                  precision={2}
                  unit="×"
                  onChange={(v) => patch("Blur amount", { amount: v })}
                />
              </Pair>
            </PropRow>
            <PropRow label="Max samples" hint="A ceiling. The real count is measured from how far the layer travels.">
              <Half>
                <NumberInput
                  value={maxSamples.value}
                  mixed={maxSamples.mixed}
                  min={2}
                  max={64}
                  precision={0}
                  onChange={(v) => patch("Max samples", { maxSamples: Math.round(v) })}
                />
              </Half>
            </PropRow>
            {custom && (
              <button
                type="button"
                onClick={() =>
                  update("Use comp shutter", (c) => {
                    if (isVisualClip(c)) c.motionBlur = { ...c.motionBlur, override: null };
                  })
                }
                className="w-full rounded px-1 py-0.5 text-left text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Use comp settings
              </button>
            )}
          </div>
        )}
      </div>
    </PanelSection>
  );
}
