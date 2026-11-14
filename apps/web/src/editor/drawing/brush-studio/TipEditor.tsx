"use client";

import * as React from "react";
import {
  createId,
  locateClip,
  GRAIN_LABEL,
  GRAIN_TEXTURES,
  TIP_KINDS,
  TIP_LABEL,
  type BrushPreset,
  type GrainTexture,
} from "@solomotion/core";
import { Dices, ImagePlus, Layers, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { putAssetBlob } from "../../assets/asset-store";
import { MediaPickerDialog } from "../../inspector/MediaPickerDialog";
import { useDoc } from "../../state/document-context";
import { useSession } from "../../state/session";
import { captureClipAsTip } from "../tip-capture";
import { Dial, Group, Row, Seg, SegGrid, TipGlyph, Toggle, type StudioProps } from "./controls";

/**
 * THE TIP TAB — what one stamp of this brush looks like.
 *
 * Two worlds behind one gallery. Thirteen of the entries are PROCEDURAL: pure
 * math (`core/drawing/tips`) baked to a sprite, crisp at any size, tintable,
 * free to ship. The fourteenth is IMAGE, and it opens onto a set of stamps —
 * files, project media, or layers lifted straight off the canvas.
 *
 * Making that fourteenth entry a LIST rather than a slot is what turns an image
 * brush into a particle brush. One source behaves exactly like every other app's
 * image tip; six sources deal a different stamp per dab, which is the whole
 * difference between scattering leaves and rubber-stamping one leaf forty times.
 * Weights let one of them be the big leaf.
 */

/** Which parameters each family actually listens to — so no dead sliders. */
const USES: Record<string, { density?: boolean; spread?: boolean; irregular?: boolean; sides?: boolean; hardness?: boolean }> = {
  round: { hardness: true },
  chisel: { spread: true, hardness: true },
  square: { hardness: true },
  polygon: { sides: true, irregular: true, hardness: true },
  bristle: { density: true, spread: true, irregular: true, hardness: true },
  spray: { density: true, spread: true, irregular: true },
  spatter: { density: true, spread: true, irregular: true, hardness: true },
  grit: { density: true, spread: true, irregular: true, hardness: true },
  sponge: { density: true, spread: true, hardness: true },
  hatch: { density: true, irregular: true, hardness: true },
  ring: { spread: true, hardness: true },
  leaf: { spread: true, irregular: true, hardness: true },
  sparkle: { sides: true, spread: true, density: true },
  image: {},
};

const SPREAD_LABEL: Record<string, string> = {
  chisel: "Nib width",
  bristle: "Rake width",
  spray: "Dot size",
  spatter: "Droplet size",
  grit: "Grain size",
  sponge: "Cell size",
  ring: "Thickness",
  leaf: "Leaf width",
  sparkle: "Point width",
};

export function TipEditor({ brush, patch }: StudioProps) {
  const kind = brush.shape.type;
  const uses = USES[kind] ?? {};

  return (
    <>
      <Group title="Shape">
        <SegGrid
          columns={7}
          // A tip is chosen by RECOGNISING its mark, so the cell is square and
          // gives the glyph the room a text chip would not need.
          itemClassName="aspect-square h-auto p-1"
          value={kind}
          options={[...TIP_KINDS, "image" as const].map((k) => ({
            v: k,
            label: <TipChoiceGlyph brush={brush} kind={k} />,
            hint: k === "image" ? "An image, an SVG, or a layer from the canvas — one, or a set to scatter." : TIP_LABEL[k as keyof typeof TIP_LABEL],
          }))}
          onChange={(k) => patch((b) => void (b.shape.type = k))}
        />
      </Group>

      {kind === "image" ? (
        <TipSources brush={brush} patch={patch} />
      ) : (
        <Group title={TIP_LABEL[kind as keyof typeof TIP_LABEL]}>
          {uses.hardness && (
            <Dial
              label="Hardness"
              hint="How sharply the mark stops at its edge. Zero is an airbrush; one is a stencil."
              percent
              value={brush.shape.hardness}
              defaultValue={0.9}
              onChange={(v) => patch((b) => void (b.shape.hardness = v))}
            />
          )}
          {uses.density && (
            <Dial
              label="Density"
              hint="How many marks the tip is made of — hairs, dots, hatches."
              percent
              value={brush.shape.density}
              defaultValue={0.5}
              onChange={(v) => patch((b) => void (b.shape.density = v))}
            />
          )}
          {uses.spread && (
            <Dial
              label={SPREAD_LABEL[kind] ?? "Spread"}
              percent
              value={brush.shape.spread}
              defaultValue={0.5}
              onChange={(v) => patch((b) => void (b.shape.spread = v))}
            />
          )}
          {uses.irregular && (
            <Dial
              label="Break-up"
              hint="How uneven the mark is. The difference between ink and chalk."
              percent
              value={brush.shape.irregular}
              defaultValue={0.4}
              onChange={(v) => patch((b) => void (b.shape.irregular = v))}
            />
          )}
          {uses.sides && (
            <Dial
              label="Points"
              value={brush.shape.sides}
              min={3}
              max={12}
              step={1}
              precision={0}
              onChange={(v) => patch((b) => void (b.shape.sides = Math.round(v)))}
            />
          )}
        </Group>
      )}

      <Group title="Orientation">
        <Dial
          label="Roundness"
          hint="Squashes the tip on its minor axis. Low values carve a calligraphic edge."
          percent
          min={0.05}
          value={brush.shape.roundness}
          defaultValue={1}
          onChange={(v) => patch((b) => void (b.shape.roundness = v))}
        />
        <Dial
          label="Angle"
          value={brush.shape.angle}
          min={-180}
          max={180}
          step={1}
          precision={0}
          unit="°"
          origin={0}
          ticks={[-90, 0, 90]}
          defaultValue={0}
          onChange={(v) => patch((b) => void (b.shape.angle = v))}
        />
        <Toggle
          label="Follow stroke"
          hint="Turns the tip along the line — rakes and bristles need it. A broad calligraphy nib must NOT have it: a nib that rotates has no fixed angle, and its width stops varying with direction."
          checked={brush.shape.followStroke}
          onChange={(v) => patch((b) => void (b.shape.followStroke = v))}
        />
        {kind !== "image" && (
          <Row label="Variation" hint="Deals a new arrangement of the tip's marks. Same number, same tip, forever.">
            <Button
              size="xs"
              variant="ghost"
              className="gap-1 text-[11px]"
              onClick={() => patch((b) => void (b.shape.seed = Math.floor(Math.random() * 10000)))}
            >
              <Dices className="size-3" /> Reshuffle
            </Button>
          </Row>
        )}
      </Group>
    </>
  );
}

/**
 * One entry in the shape gallery: the tip's REAL baked sprite, not an icon of
 * one — so choosing a tip is choosing the mark you can actually see, and a
 * stencil whose parameters make it invisible looks invisible right here.
 */
function TipChoiceGlyph({ brush, kind }: { brush: BrushPreset; kind: BrushPreset["shape"]["type"] }) {
  // Previewed as THIS brush would carry it, so the gallery shows what switching
  // would give you rather than a generic sample.
  const preview = React.useMemo<BrushPreset>(
    () => ({ ...brush, shape: { ...brush.shape, type: kind, roundness: 1, angle: 0 } }),
    [brush, kind],
  );
  if (kind === "image" && brush.shape.sources.length === 0) {
    return <ImagePlus className="size-4 text-muted-foreground" />;
  }
  return <TipGlyph brush={preview} size={30} />;
}

/**
 * The tip's SOURCE SET — a repeater of stamps with weights.
 *
 * Three ways in, and they all end at the same opaque blob id: upload a file,
 * pick project media, or capture the selected layer. That last one is the one
 * worth having — it means "make a brush out of the shape I just drew" is two
 * clicks and never leaves the app.
 */
function TipSources({ brush, patch }: StudioProps) {
  const doc = useDoc();
  const selectedIds = useSession((s) => s.selectedClipIds);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [mediaOpen, setMediaOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const add = (assetId: string) =>
    patch((b) => void b.shape.sources.push({ id: createId("tipsrc"), assetId, weight: 1 }));

  /**
   * The selected layer, lifted into a stamp. `locateClip` is the app's ONE
   * clip lookup, and the clip's own frame is what `drawClipPoster` renders
   * against — so this borrows the exact path layer thumbnails already take.
   */
  const captureLayer = async () => {
    const clipId = selectedIds.at(-1);
    const located = clipId ? locateClip(doc, clipId) : null;
    const frame = located ? doc.frames.find((f) => f.id === located.clip.frameId) : null;
    if (!located || !frame || located.clip.kind === "audio") return;
    setBusy(true);
    try {
      const id = await captureClipAsTip(doc, frame, located.clip, 0);
      if (id) add(id);
    } finally {
      setBusy(false);
    }
  };

  const sources = brush.shape.sources;

  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center gap-1.5">
        <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Stamps
        </h3>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          multiple
          className="hidden"
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            for (const file of files) {
              const id = createId("brushtip");
              await putAssetBlob(id, file);
              add(id);
            }
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="xs" variant="ghost" className="gap-1 text-[11px]" disabled={busy}>
              <Upload className="size-3" /> Add
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={() => inputRef.current?.click()}>
              <Upload /> Upload image or SVG…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setMediaOpen(true)}>
              <ImagePlus /> From project media…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={captureLayer} disabled={selectedIds.length === 0}>
              <Layers /> Capture selected layer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {sources.length === 0 ? (
        <p className="rounded-[--radius] border border-dashed border-border/70 px-3 py-6 text-center text-[11px] text-muted-foreground">
          Add a shape to stamp. More than one, and each dab picks a different stamp.
        </p>
      ) : (
        <div className="space-y-1.5">
          {sources.map((source, i) => (
            <div
              key={source.id}
              className="flex items-center gap-2 rounded-[--radius] border border-border/60 bg-[--panel] p-1.5"
            >
              <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[--radius] bg-[#101014]">
                <TipGlyph
                  brush={{ ...brush, shape: { ...brush.shape, type: "image" } }}
                  size={34}
                  // Each row shows ITS stamp, which is the variant at its index.
                  key={`${source.assetId}:${i}`}
                />
              </div>
              <div className="min-w-0 flex-1">
                <Dial
                  label="Weight"
                  hint="How often this stamp is dealt, relative to the others."
                  value={source.weight}
                  min={0}
                  max={8}
                  step={0.1}
                  precision={1}
                  defaultValue={1}
                  onChange={(v) =>
                    patch((b) => {
                      const s = b.shape.sources.find((x) => x.id === source.id);
                      if (s) s.weight = v;
                    })
                  }
                />
              </div>
              <button
                type="button"
                aria-label="Remove stamp"
                onClick={() =>
                  patch((b) => void (b.shape.sources = b.shape.sources.filter((s) => s.id !== source.id)))
                }
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <MediaPickerDialog open={mediaOpen} onOpenChange={setMediaOpen} onPick={add} accept={["image"]} />
    </section>
  );
}

/** THE GRAIN TAB — which surface the paint is fighting. */
export function GrainEditor({ brush, patch }: StudioProps) {
  return (
    <>
      <Group title="Surface" hint="Grain gates the finished stroke, so two strokes crossing reveal the same tooth — that is what makes it paper rather than a texture on each stamp.">
        <SegGrid
          value={brush.grain.texture}
          options={GRAIN_TEXTURES.map((t) => ({ v: t as GrainTexture, label: GRAIN_LABEL[t] }))}
          onChange={(t) => patch((b) => void (b.grain.texture = t))}
        />
        <Dial
          label="Depth"
          hint="How much of the paint the surface is allowed to eat. Zero is a wet medium; high is chalk on rough paper."
          percent
          value={brush.grain.intensity}
          defaultValue={0}
          onChange={(v) => patch((b) => void (b.grain.intensity = v))}
        />
        <Dial
          label="Scale"
          value={brush.grain.scale}
          min={0.1}
          max={8}
          step={0.05}
          precision={2}
          unit="×"
          ticks={[1]}
          defaultValue={1}
          onChange={(v) => patch((b) => void (b.grain.scale = v))}
        />
        <Toggle
          label="Moves with stroke"
          hint="On, the texture travels with the brush — smooth, and never reveals the page. Off, it is anchored to the canvas, which is what real paper does."
          checked={brush.grain.moving}
          onChange={(v) => patch((b) => void (b.grain.moving = v))}
        />
      </Group>
    </>
  );
}

/** THE RENDERING TAB — how the stroke meets the layer. */
export function RenderingEditor({ brush, patch }: StudioProps) {
  return (
    <>
      <Group title="Build-up">
        <Row
          label="Stamping"
          hint="The single choice that decides what kind of instrument this is."
        >
          <Seg
            className="w-44"
            value={brush.rendering.stamp}
            options={[
              { v: "uniform", label: "Even", hint: "The stroke composites once at its opacity. Crossing yourself inside one stroke changes nothing — a 30% wash stays an even 30%. Airbrushes, washes, highlighters." },
              { v: "glaze", label: "Build up", hint: "Every stamp composites separately, so overlaps darken and going over a line twice makes it stronger. Markers, ink, dry media." },
            ]}
            onChange={(v) => patch((b) => void (b.rendering.stamp = v))}
          />
        </Row>
      </Group>

      <Group title="Compositing">
        <Row label="Blend">
          <Seg
            className="w-44"
            value={brush.rendering.blend === "normal" ? "normal" : brush.rendering.blend === "multiply" ? "multiply" : "screen"}
            options={[
              { v: "normal", label: "Normal" },
              { v: "multiply", label: "Multiply", hint: "Darkens what is under it — inks, shadows, highlighter." },
              { v: "screen", label: "Screen", hint: "Only lightens — neon, glow, sparks." },
            ]}
            onChange={(v) => patch((b) => void (b.rendering.blend = v))}
          />
        </Row>
        <Toggle
          label="Erases"
          hint="An eraser is a brush whose stroke removes alpha. Every tip, grain and dynamic still applies — which is how you get a textured eraser."
          checked={brush.rendering.erase}
          onChange={(v) => patch((b) => void (b.rendering.erase = v))}
        />
      </Group>
    </>
  );
}

/**
 * THE WET TAB — paint that is still moving.
 *
 * A wet brush is a different instrument, not a stronger setting, so this tab is
 * gated on one switch and everything under it is the simulation's own
 * vocabulary (`drawing/watercolor`). The numbers here ARE the numbers the
 * physics runs on; there is no translation layer to disagree with.
 *
 * The hints say what each dial does to the MARK, because "deposition rate" is
 * not a thing anyone wants and "how fast colour drops out of the water" is.
 */
export function WetEditor({ brush, patch }: StudioProps) {
  const wet = brush.rendering.wet;
  const on = wet.enabled;

  return (
    <>
      <Group title="Wet media" hint="Paint that keeps flowing after the stroke ends: it bleeds into other wet paint, pools at its own edges, and dries — on its own, on command, or under the drying fan.">
        <Toggle
          label="Paints wet"
          hint="Turns this brush into live water carrying pigment, instead of pixels."
          checked={on}
          onChange={(v) => patch((b) => void (b.rendering.wet.enabled = v))}
        />
        <Dial
          label="Water"
          hint="How loaded the brush is. A wet brush runs and bleeds; a thirsty one stains where it touches and stops."
          percent
          disabled={!on}
          value={wet.wetness}
          defaultValue={0.8}
          onChange={(v) => patch((b) => void (b.rendering.wet.wetness = v))}
        />
      </Group>

      <Group title="Behaviour">
        <Dial
          label="Spread"
          hint="How freely the water runs. Low keeps a wash where you put it; high lets it flood."
          percent
          disabled={!on}
          value={wet.flow}
          defaultValue={0.75}
          onChange={(v) => patch((b) => void (b.rendering.wet.flow = v))}
        />
        <Dial
          label="Drying"
          hint="How fast the water leaves. Faster dries sooner and bleeds less — the difference between a wash and a wet ink."
          disabled={!on}
          value={wet.evaporation}
          min={0.0005}
          max={0.08}
          step={0.0005}
          precision={4}
          defaultValue={0.004}
          onChange={(v) => patch((b) => void (b.rendering.wet.evaporation = v))}
        />
        <Dial
          label="Settling"
          hint="How readily colour drops out of the water. Low is a staining pigment that travels; high drops where it lands."
          percent
          disabled={!on}
          value={wet.deposition}
          min={0.005}
          max={0.5}
          defaultValue={0.06}
          onChange={(v) => patch((b) => void (b.rendering.wet.deposition = v))}
        />
      </Group>

      <Group title="Character">
        <Dial
          label="Edge"
          hint="How hard colour piles up at the drying rim. This is the dark outline a real wash leaves — it is not drawn, it happens."
          percent
          disabled={!on}
          value={wet.edge}
          defaultValue={0.7}
          onChange={(v) => patch((b) => void (b.rendering.wet.edge = v))}
        />
        <Dial
          label="Granulation"
          hint="How much pigment sinks into the paper's low points. High is the mottled sediment of a rough sheet."
          percent
          disabled={!on}
          value={wet.granulation}
          defaultValue={0.45}
          onChange={(v) => patch((b) => void (b.rendering.wet.granulation = v))}
        />
        <div className={on ? undefined : "pointer-events-none opacity-40"}>
          <SegGrid
            value={wet.texture}
            options={GRAIN_TEXTURES.map((t) => ({ v: t as GrainTexture, label: GRAIN_LABEL[t] }))}
            onChange={(t) => patch((b) => void (b.rendering.wet.texture = t))}
          />
        </div>
      </Group>
    </>
  );
}
