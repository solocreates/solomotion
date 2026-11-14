"use client";

import { SimulationSection } from "../physics/lazy";
import * as React from "react";
import {
  Box,
  Camera,
  Circle,
  Cloud,
  Cylinder,
  Flashlight,
  Globe,
  Lightbulb,
  Link2,
  RectangleHorizontal,
  Shapes,
  Square,
  Sun,
  Trash2,
  Unlink2,
  X,
} from "lucide-react";
import {
  ENVIRONMENT_PRESETS,
  LIGHT_DEFAULTS,
  MATERIAL_PRESETS,
  activeCameraAt,
  getClipProperty,
  locateClip,
  meshStats,
  primitiveDef,
  propertyDef,
  solidPaint,
  type MotionDocument,
  type CameraClip,
  type Clip,
  type PickCandidate,
  type PickFilter,
  type Frame,
  type KeyframeValue,
  type LightClip,
  type MeshClip,
  type VisualClip,
  type EmptyClip,
  EMPTY_DISPLAYS,
  setChildOf,
  extrudeSchema,
  physicsSchema,
  applyMaterialPreset,
  bodyFit,
  bodyThickness,
  layerMaterial,
  VECTOR_BODY_KINDS,
  type BodyFit,
  worldSpecSchema,
  createFrame,
  type WorldSpec,
  lineArtSchema,
  latticeSpecSchema,
  latticeMesh,
  resampleLattice,
} from "@solomotion/core";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDocStore, useDocWhen } from "../state/document-context";
import { useSession, useParkedPlayhead } from "../state/session";
import { commitProperty, effectiveValue } from "./animatable";
import { IconAction, IconToggle, PanelSection, PropRow, Trio } from "./controls";
import { MultiKeyControl } from "./keyframe-controls";
import { DocColorInput } from "./DocColorInput";
import { MIXED } from "./shared-inspector";
import { ValueField } from "./value-field";
import { LayerRefField } from "../pick/ObjectField";
import { useWorldUi } from "../world/state";
import { makeEditable } from "../world/commands";

/**
 * THE 3D INSPECTOR — what a world object shows on the right when it is
 * selected, the way Blender's properties follow the active object: a camera
 * shows its lens, a light its power, a mesh its shape and surface.
 *
 * Every row is the docked inspector's own grid (`PropRow`, as the flat Design
 * tab uses) through the app's ONE field renderer (`ValueField`, inspector
 * layout): a bounded value is a meter with its readout inside, every
 * animatable one carries its keyframe diamond and binding menu, and its label,
 * range and step come from the property registry (`world/fields.ts`) — never
 * restated here. The modifier stack is the Effects tab's own section
 * (`ModifierStackSection`).
 */

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/**
 * One ANIMATABLE world value, across the selection. Label, range and step are
 * the registry's, and in the inspector's own grid a bounded value is a meter.
 * `slider={false}` is for open-ended quantities (a focal length, a distance
 * in units) where a meter would be a lie about the range.
 */
function WorldField({
  clips,
  path,
  label,
  unit,
  hint,
  bipolar,
  slider = true,
}: {
  clips: readonly Clip[];
  path: string;
  label?: string;
  unit?: string;
  hint?: string;
  bipolar?: boolean;
  slider?: boolean;
}) {
  const store = useDocStore();
  const clip = clips[0]!;
  const def = propertyDef(path);
  const base = getClipProperty(clip, path) ?? def?.identity ?? 0;
  const mixed = clips.some((c) => getClipProperty(c, path) !== base);
  const name = label ?? def?.label ?? path;
  return (
    <ValueField
      layout="inspector"
      clip={clip}
      canKey
      path={path}
      kind={def?.kind === "color" ? "color" : "number"}
      label={name}
      base={base}
      min={def?.min}
      max={slider ? def?.max : undefined}
      step={def?.step}
      unit={unit}
      hint={hint}
      bipolar={bipolar}
      mixed={mixed}
      defaultValue={def?.identity}
      onChange={(v) =>
        store.update(
          `Set ${name}`,
          (d) => {
            const at = useSession.getState().playheadMs;
            for (const c of clips) {
              const loc = locateClip(d, c.id);
              if (loc) commitProperty(loc.clip, path, v, at);
            }
          },
          { mergeKey: `w3-${path}` },
        )
      }
    />
  );
}

/** A STRUCTURAL number (never keyed) in the same row grammar as `WorldField`. */
function SpecField(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
  defaultValue?: number;
}) {
  return (
    <ValueField
      layout="inspector"
      clip={null}
      canKey={false}
      path=""
      kind="number"
      label={props.label}
      base={props.value}
      min={props.min}
      max={props.max}
      step={props.step}
      unit={props.unit}
      hint={props.hint}
      defaultValue={props.defaultValue}
      modulatable={false}
      onChange={(v: KeyframeValue) => props.onChange(Number(v))}
    />
  );
}

function ToggleField({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <PropRow label={label} hint={hint} toggle>
      <Switch checked={checked} onCheckedChange={onChange} />
    </PropRow>
  );
}

function ChoiceField<T extends string>({ label, hint, value, options, onChange }: { label: string; hint?: string; value: T; options: ReadonlyArray<SegmentedOption<T>>; onChange: (v: T) => void }) {
  return (
    <PropRow label={label} hint={hint}>
      <Segmented value={value} onChange={onChange} options={options} stretch aria-label={label} />
    </PropRow>
  );
}

function SelectField({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <PropRow label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-7 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </PropRow>
  );
}

/** A structural (non-animated) edit of one clip of a kind. */
function useEdit<K extends Clip["kind"]>(id: string, kind: K) {
  const store = useDocStore();
  return React.useCallback(
    (label: string, fn: (c: Extract<Clip, { kind: K }>) => void, mergeKey?: string) =>
      store.update(
        label,
        (d) => {
          const c = locateClip(d, id)?.clip;
          if (c && c.kind === kind) fn(c as Extract<Clip, { kind: K }>);
        },
        mergeKey ? { mergeKey } : undefined,
      ),
    [store, id, kind],
  );
}

// ── Transform ────────────────────────────────────────────────────────────────

const AXES = ["X", "Y", "Z"] as const;

/**
 * Location, rotation and scale in three axes. Uniform scale is a FACT OF THE
 * DOCUMENT (`scaleY`/`scaleZ` null mirror `scale`), so the row shows one field
 * while it is uniform and three once split — the link is read off the layer,
 * never held beside it.
 */
export function Transform3dSection({ clips }: { clips: VisualClip[] }) {
  const store = useDocStore();
  const playheadMs = useParkedPlayhead();
  // Keyed values are read at each clip's frame time, which its home frame decides.
  const timingDoc = useDocWhen((d) => [d.frames]);
  const primary = clips[0];
  if (!primary) return null;
  const value = (c: Clip, path: string) => num(effectiveValue(c, path, num(getClipProperty(c, path)), playheadMs, timingDoc));
  const merged = (path: string) => {
    let acc: number | undefined;
    for (const c of clips) {
      const v = Math.round(value(c, path) * 1000) / 1000;
      if (acc === undefined) acc = v;
      else if (acc !== v) return MIXED;
    }
    return acc ?? 0;
  };
  const write = (paths: string[], next: number, relative: boolean) =>
    store.update(
      `Set ${paths[0]}`,
      (d) => {
        const from = value(primary, paths[0]!);
        for (const c of clips) {
          const loc = locateClip(d, c.id);
          if (!loc) continue;
          for (const p of paths) commitProperty(loc.clip, p, relative ? value(loc.clip, p) + (next - from) : next, playheadMs);
        }
      },
      { mergeKey: `w3tf-${paths.join()}` },
    );
  const uniform = clips.every((c) => c.transform.scaleY == null && c.transform.scaleZ == null);
  const setUniform = (on: boolean) =>
    store.update(on ? "Link scale" : "Unlink scale", (d) => {
      for (const c of clips) {
        const loc = locateClip(d, c.id);
        if (!loc || loc.clip.kind === "audio") continue;
        const t = loc.clip.transform;
        t.scaleY = on ? null : t.scale;
        t.scaleZ = on ? null : t.scale;
      }
    });

  const trio = (label: string, paths: string[], opts: { unit?: string; relative?: boolean; pct?: boolean; precision: number }, link?: React.ReactNode) => {
    const vals = paths.map(merged);
    return (
      <PropRow label={label} keyControl={<MultiKeyControl clip={primary} properties={paths.map((p, i) => ({ property: p, currentValue: () => num(vals[i]) }))} />}>
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <Trio>
              {paths.map((p, i) => (
                <NumberInput
                  key={p}
                  label={AXES[i]}
                  value={vals[i] === MIXED ? undefined : opts.pct ? Math.round(num(vals[i]) * 1000) / 10 : (vals[i] as number)}
                  mixed={vals[i] === MIXED}
                  precision={opts.precision}
                  unit={opts.unit}
                  onChange={(v) => write([p], opts.pct ? v / 100 : v, !!opts.relative)}
                  path={p}
                  fieldLabel={`${label} ${AXES[i]}`}
                />
              ))}
            </Trio>
          </div>
          {link}
        </div>
      </PropRow>
    );
  };

  const scaleVal = merged("scale");
  return (
    <PanelSection id="transform-3d" title="Transform">
      {trio("Location", ["x", "y", "z"], { relative: true, precision: 0 })}
      {trio("Rotation", ["rotationX", "rotationY", "rotation"], { unit: "°", precision: 0 })}
      {uniform ? (
        <PropRow label="Scale" keyControl={<MultiKeyControl clip={primary} properties={[{ property: "scale", currentValue: () => num(scaleVal) }]} />}>
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <NumberInput
                value={scaleVal === MIXED ? undefined : Math.round(num(scaleVal) * 1000) / 10}
                mixed={scaleVal === MIXED}
                precision={1}
                unit="%"
                onChange={(v) => write(["scale"], v / 100, false)}
                path="scale"
                fieldLabel="Scale"
              />
            </div>
            <IconToggle label="Scale each axis separately" onClick={() => setUniform(false)}>
              <Unlink2 />
            </IconToggle>
          </div>
        </PropRow>
      ) : (
        trio(
          "Scale",
          ["scale", "scaleY", "scaleZ"],
          { pct: true, precision: 0 },
          <IconToggle label="Scale all three axes together" pressed onClick={() => setUniform(true)}>
            <Link2 />
          </IconToggle>,
        )
      )}
    </PanelSection>
  );
}

// ── Camera ───────────────────────────────────────────────────────────────────

/**
 * DEPTH OF FIELD — the camera's lens blur (Blender's camera › Depth of Field):
 * focus on a layer that stays sharp wherever it or the camera goes, or on a
 * distance; the f-stop says how quickly the rest falls out of focus. Shows in
 * Rendered view through this camera, on the board and in every export.
 */
export function DepthOfFieldSection({ clip, doc }: { clip: CameraClip; doc: MotionDocument }) {
  const edit = useEdit(clip.id, "camera");
  const dof = clip.camera.dof;
  const clips = [clip];
  const focusName = dof.focusObjectId ? locateClip(doc, dof.focusObjectId)?.clip.name : null;
  return (
    <PanelSection
      id="camera-dof"
      title="Depth of field"
      summary={dof.enabled ? (focusName ?? `f/${dof.fStop}`) : undefined}
      actions={<Switch checked={dof.enabled} onCheckedChange={(v) => edit(v ? "Depth of field on" : "Depth of field off", (c) => void (c.camera.dof.enabled = v))} aria-label="Depth of field" />}
    >
      {dof.enabled && (
        <>
          <PropRow label="Focus on" hint="A layer stays sharp wherever it moves; Nothing uses the distance below">
            <div className="min-w-0 flex-1">
              <LayerRefField
                filter={otherLayers(clip, (c) => c.clip?.kind !== "camera" && c.clip?.kind !== "light")}
                value={dof.focusObjectId ?? null}
                none="A distance"
                onChange={(id) => edit("Focus object", (c) => void (c.camera.dof.focusObjectId = id))}
              />
            </div>
          </PropRow>
          {!dof.focusObjectId && <WorldField clips={clips} path="camera.dof.focusDistance" label="Distance" unit="u" slider={false} />}
          <WorldField clips={clips} path="camera.dof.fStop" label="F-stop" hint="Lower blurs more — f/1.4 is dreamy, f/16 nearly all sharp" slider={false} />
        </>
      )}
    </PanelSection>
  );
}

export function CameraSection({ clip, doc }: { clip: CameraClip; doc: MotionDocument }) {
  const edit = useEdit(clip.id, "camera");
  const playheadMs = useParkedPlayhead();
  const frame = doc.frames.find((f) => f.id === clip.frameId);
  const live = frame ? activeCameraAt(doc, frame, playheadMs) === clip.id : false;
  const cam = clip.camera;
  const clips = [clip];
  return (
    <PanelSection
      id="camera"
      title="Camera"
      summary={live ? <span className="text-primary">Live</span> : undefined}
      hint="The topmost visible camera at the playhead is the live one. Cameras end to end on one lane cut between shots."
      actions={
        <IconAction label="Look through this camera (0)" onClick={() => useWorldUi.getState().set({ throughCamera: true })}>
          <Camera />
        </IconAction>
      }
    >
      <>
        <ChoiceField
          label="Type"
          value={cam.projection}
          onChange={(v) => edit("Camera projection", (c) => void (c.camera.projection = v))}
          options={[
            { value: "perspective", label: "Perspective" },
            { value: "orthographic", label: "Orthographic" },
          ]}
        />
        {cam.projection === "perspective" ? (
          <WorldField clips={clips} path="camera.focalLength" label="Focal" unit="mm" slider={false} hint="Lower is wider — 50 mm is how the eye sees" />
        ) : (
          <WorldField clips={clips} path="camera.orthoScale" label="Width" unit="u" slider={false} hint="How much of the world fits across the frame" />
        )}
        <WorldField clips={clips} path="camera.shiftX" bipolar hint="Slide the picture without turning the camera" />
        <WorldField clips={clips} path="camera.shiftY" bipolar />
        <WorldField clips={clips} path="camera.clipStart" unit="u" slider={false} hint="Nothing nearer than this is drawn" />
        <WorldField clips={clips} path="camera.clipEnd" unit="u" slider={false} hint="Nothing farther than this is drawn" />
        <SpecField label="Sensor" value={cam.sensorWidth} min={1} max={200} step={1} unit="mm" defaultValue={36} onChange={(v) => edit("Sensor width", (c) => void (c.camera.sensorWidth = v), "cam-sensor")} />
      </>
    </PanelSection>
  );
}

// ── Light ────────────────────────────────────────────────────────────────────

type LightType = LightClip["light"]["type"];
const LIGHT_OPTIONS: ReadonlyArray<SegmentedOption<LightType>> = [
  { value: "point", label: "Point", icon: Lightbulb, hint: "Point — a bulb, shining every way" },
  { value: "spot", label: "Spot", icon: Flashlight, hint: "Spot — a cone of light" },
  { value: "sun", label: "Sun", icon: Sun, hint: "Sun — parallel light from far away" },
  { value: "area", label: "Area", icon: RectangleHorizontal, hint: "Area — a soft panel, like a softbox" },
  { value: "hemisphere", label: "Sky", icon: Cloud, hint: "Sky — sky above, ground below" },
  { value: "environment", label: "Studio", icon: Globe, hint: "Studio — lights reflections and ambient from every side" },
];
const STRENGTH_TYPES = new Set<LightType>(["sun", "environment", "hemisphere"]);

export function LightSection({ clip }: { clip: LightClip }) {
  const edit = useEdit(clip.id, "light");
  const l = clip.light;
  const clips = [clip];
  const strength = STRENGTH_TYPES.has(l.type);
  return (
    <PanelSection id="light" title="Light">
      <>
        <ChoiceField
          label="Type"
          value={l.type}
          options={LIGHT_OPTIONS}
          onChange={(t) =>
            edit("Light type", (c) => {
              // Keep a sensible brightness across watts ↔ strength.
              if (STRENGTH_TYPES.has(t) !== STRENGTH_TYPES.has(c.light.type)) c.light.intensity = LIGHT_DEFAULTS[t].intensity;
              c.light.type = t;
            })
          }
        />
        {l.type === "environment" ? (
          <>
            <SelectField label="Studio" value={l.environment} onChange={(v) => edit("Environment", (c) => void (c.light.environment = v as never))}>
              {ENVIRONMENT_PRESETS.map((p) => (
                <SelectItem key={p} value={p} className="text-xs capitalize">
                  {p}
                </SelectItem>
              ))}
            </SelectField>
            <WorldField clips={clips} path="light.intensity" label="Strength" slider={false} />
            <WorldField clips={clips} path="rotation" label="Turn" unit="°" slider={false} hint="Spin the studio around the world — key it for a turntable" />
            <ToggleField label="Background" hint="Show the studio behind everything" checked={l.showBackground} onChange={(v) => edit("Environment background", (c) => void (c.light.showBackground = v))} />
          </>
        ) : (
          <>
            <WorldField clips={clips} path="light.color" />
            <WorldField clips={clips} path="light.intensity" label={strength ? "Strength" : "Power"} unit={strength ? undefined : "W"} slider={false} />
            {(l.type === "point" || l.type === "spot") && <WorldField clips={clips} path="light.range" unit="u" slider={false} hint="0 falls off naturally, forever" />}
            {l.type === "spot" && (
              <>
                <WorldField clips={clips} path="light.spotAngle" unit="°" />
                <WorldField clips={clips} path="light.spotBlend" label="Edge" hint="How soft the edge of the cone is" />
              </>
            )}
            {l.type === "area" && (
              <>
                <WorldField clips={clips} path="light.width" unit="u" slider={false} />
                <WorldField clips={clips} path="light.height" unit="u" slider={false} />
              </>
            )}
            {l.type === "hemisphere" && <WorldField clips={clips} path="light.groundColor" label="Ground" />}
            {(l.type === "point" || l.type === "spot" || l.type === "sun") && (
              <>
                <ToggleField label="Shadows" checked={l.castShadow} onChange={(v) => edit("Light shadows", (c) => void (c.light.castShadow = v))} />
                {l.castShadow && <WorldField clips={clips} path="light.shadowSoftness" label="Softness" />}
              </>
            )}
          </>
        )}
      </>
    </PanelSection>
  );
}

// ── Mesh: shape, surface, texture, parts ─────────────────────────────────────

export function GeometrySection({ clip }: { clip: MeshClip }) {
  const store = useDocStore();
  const edit = useEdit(clip.id, "mesh");
  const g = clip.geometry;
  const def = g.type === "primitive" ? primitiveDef(g.primitive) : undefined;
  const clips = [clip];
  const enterEdit = () => {
    useSession.getState().select([clip.id]);
    if (g.type === "primitive") makeEditable(store, clip.id);
    const u = useWorldUi.getState();
    u.set({ mode: "edit", editClipId: clip.id, elementSel: { mode: u.elementMode, verts: [], edges: [], faces: [] } });
  };
  const stats = g.type === "mesh" ? meshStats(g.mesh) : null;
  return (
    <PanelSection
      id="geometry"
      title={def ? def.label : g.type === "asset" ? "Model" : "Mesh"}
      summary={stats ? `${stats.vertices.toLocaleString()} pts · ${stats.faces.toLocaleString()} faces` : undefined}
    >
      <>
        {def?.params.map((p) => (
          <WorldField key={p.key} clips={clips} path={`geometry.${p.key}`} label={p.label} unit={p.unit} slider={p.unit !== "u"} />
        ))}
        {g.type === "asset" && (
          <ToggleField
            label="File materials"
            hint="Use the materials the model came with. Off: this layer's fill and material."
            checked={clip.material.source === "file"}
            onChange={(v) => edit("Model materials", (c) => void (c.material.source = v ? "file" : "custom"))}
          />
        )}
        <ChoiceField
          label="Shading"
          value={clip.shading}
          onChange={(v) => edit("Shading", (c) => void (c.shading = v))}
          options={[
            { value: "flat", label: "Flat" },
            { value: "auto", label: "Auto" },
            { value: "smooth", label: "Smooth" },
          ]}
        />
        {clip.shading === "auto" && <WorldField clips={clips} path="smoothAngle" unit="°" hint="Edges flatter than this shade smooth" />}
        <ToggleField label="Casts shadow" checked={clip.castShadow} onChange={(v) => edit("Cast shadow", (c) => void (c.castShadow = v))} />
        <ToggleField label="Takes shadow" checked={clip.receiveShadow} onChange={(v) => edit("Receive shadow", (c) => void (c.receiveShadow = v))} />
        {g.type !== "asset" && (
          <div className="flex gap-1.5 pt-1">
            <Button variant="secondary" size="sm" className="flex-1" onClick={enterEdit}>
              Edit points
              <kbd className="ml-1.5 font-mono text-2xs text-muted-foreground">Tab</kbd>
            </Button>
            {g.type === "primitive" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={() => makeEditable(store, clip.id)}>
                    Make editable
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Turns the {def?.label.toLowerCase() ?? "shape"} into polygons — its size stops being keyable</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </>
    </PanelSection>
  );
}

const MODEL_OPTIONS: ReadonlyArray<SegmentedOption<MeshClip["material"]["model"]>> = [
  { value: "pbr", label: "Lit", hint: "Lit like the real thing — metal, glass, plastic" },
  { value: "toon", label: "Toon", hint: "Flat bands of light, like a cartoon" },
  { value: "unlit", label: "Flat", hint: "Its colour exactly, no light at all" },
];

/**
 * The SURFACE — how light treats an object: a mesh, or any 2D layer standing
 * in a world (a photo lit like metal, glass letters, a glowing logo). A layer
 * that never chose one shows the surface it has — its exact picture when
 * flat, a lit object when thick — and the first edit makes it its own;
 * "Auto" hands it back.
 */
export function MaterialSection({ clips }: { clips: VisualClip[] }) {
  const store = useDocStore();
  const clip = clips[0]!;
  const m = layerMaterial(clip);
  const preset = MATERIAL_PRESETS.find((p) => p.id === m.preset);
  const mesh = clip.kind === "mesh" ? clip : null;
  const own = mesh || clips.some((c) => c.material);
  // A flat picture is a card both ways round already.
  const flatCard = !mesh && !bodyThickness(clip);
  const edit = (label: string, fn: (c: VisualClip) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        for (const { id } of clips) {
          const c = locateClip(d, id)?.clip as VisualClip | undefined;
          if (!c) continue;
          if (c.kind !== "mesh" && !c.material) c.material = { ...layerMaterial(c) };
          fn(c);
        }
      },
      mergeKey ? { mergeKey } : undefined,
    );
  const reset = () =>
    store.update("Surface: Auto", (d) => {
      for (const { id } of clips) {
        const c = locateClip(d, id)?.clip as VisualClip | undefined;
        if (c && c.kind !== "mesh") c.material = undefined;
      }
    });
  if (mesh && mesh.geometry.type === "asset" && m.source === "file") return null;
  return (
    <PanelSection
      id="material"
      title="Material"
      summary={preset?.label ?? (!own ? (m.model === "unlit" ? "Picture" : "Auto") : undefined)}
      actions={
        !mesh && own ? (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={reset}>
            Auto
          </Button>
        ) : undefined
      }
    >
      <>
        {/* Swatches, not labelled tiles: the sphere IS the name at a glance,
            and a grid of truncated words is what this replaced. */}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(2rem,1fr))] gap-1 pb-1">
          {MATERIAL_PRESETS.map((p) => (
            <Tooltip key={p.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={p.label}
                  aria-pressed={m.preset === p.id}
                  onClick={() => edit("Material preset", (c) => applyMaterialPreset(c, p))}
                  className={cn(
                    "flex aspect-square items-center justify-center rounded-lg transition-colors hover:bg-accent",
                    m.preset === p.id && "material-glass-raised",
                  )}
                >
                  <span className="size-6 rounded-full shadow-inner" style={{ background: swatchFor(p.color ?? "#9aa0aa", p.material) }} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{p.label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <ChoiceField label="Surface" value={m.model} options={MODEL_OPTIONS} onChange={(v) => edit("Material model", (c) => void (c.material!.model = v))} />
        {m.model === "pbr" && (
          <>
            <WorldField clips={clips} path="material.roughness" hint="0 is a mirror, 1 is chalk" />
            <WorldField clips={clips} path="material.metalness" />
            <WorldField clips={clips} path="material.transmission" label="Glass" hint="Lets light through — 1 is clear glass" />
            {m.transmission > 0 && (
              <>
                <WorldField clips={clips} path="material.ior" label="Refraction" hint="How much the glass bends light — water 1.33, glass 1.5, diamond 2.4" />
                <WorldField clips={clips} path="material.thickness" unit="u" slider={false} />
              </>
            )}
            <WorldField clips={clips} path="material.clearcoat" label="Coat" hint="A clear lacquer over the surface — car paint, ceramic" />
            {m.clearcoat > 0 && <WorldField clips={clips} path="material.clearcoatRoughness" label="Coat rough" />}
            <WorldField clips={clips} path="material.sheen" hint="The soft rim of fabric and velvet" />
            <WorldField clips={clips} path="material.iridescence" label="Rainbow" hint="Iridescence — the film on soap bubbles and pearls" />
          </>
        )}
        {m.model === "toon" && (
          <SpecField label="Bands" value={m.toonSteps} min={2} max={8} step={1} defaultValue={3} onChange={(v) => edit("Toon bands", (c) => void (c.material!.toonSteps = Math.round(v)), "toon-steps")} />
        )}
        {m.model !== "unlit" && (
          <>
            <WorldField clips={clips} path="material.emission" label="Glow colour" />
            <WorldField clips={clips} path="material.emissionStrength" label="Glow" />
          </>
        )}
        {!flatCard && (
          <ToggleField label="Both sides" hint="Draw the inside of open shapes too" checked={m.doubleSided} onChange={(v) => edit("Double-sided", (c) => void (c.material!.doubleSided = v))} />
        )}
      </>
    </PanelSection>
  );
}

/** A tiny sphere-ish swatch for a preset: its colour, lit like its material. */
function swatchFor(color: string, m: Partial<MeshClip["material"]>): string {
  const shine = m.metalness ? "rgba(255,255,255,0.95)" : m.roughness !== undefined && m.roughness < 0.3 ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.35)";
  if (m.transmission) return `radial-gradient(circle at 35% 30%, ${shine}, rgba(180,210,255,0.35) 45%, rgba(40,60,90,0.6))`;
  if (m.emission && m.emission !== "#000000") return `radial-gradient(circle at 50% 50%, #fff, ${color} 45%, ${color})`;
  return `radial-gradient(circle at 35% 30%, ${shine}, ${color} 45%, color-mix(in srgb, ${color} 35%, black))`;
}

const WRAP_OPTIONS: ReadonlyArray<SegmentedOption<MeshClip["uv"]>> = [
  { value: "box", label: "Box", icon: Box, hint: "Box — each side gets the picture" },
  { value: "planar", label: "Front", icon: Square, hint: "Front — projected straight on" },
  { value: "cylinder", label: "Tube", icon: Cylinder, hint: "Tube — wrapped around" },
  { value: "sphere", label: "Ball", icon: Circle, hint: "Ball — wrapped like a globe" },
];

/**
 * PAINT A SURFACE WITH THE TOOLS YOU HAVE — any flat comp is the mesh's
 * texture: paint it, type on it, animate it in the 2D editor, and it wraps the
 * shape live. One picker answers "what is this surface made of"; the wrap and
 * repeat follow only once there is a picture to wrap.
 */
export function TextureSection({ clip, doc }: { clip: MeshClip; doc: MotionDocument }) {
  const store = useDocStore();
  const edit = useEdit(clip.id, "mesh");
  const comps = doc.frames.filter((f) => !f.world);
  const tex = clip.texture;
  const source = tex ? comps.find((f) => f.id === tex.frameId) : undefined;
  const open = (frameId: string) => {
    useWorldUi.getState().set({ openId: null, mode: "object", editClipId: null });
    useSession.getState().selectFrame(frameId);
  };
  const create = () => {
    let id = "";
    store.update("New paint texture", (d) => {
      const host = d.frames.find((f) => f.id === clip.frameId);
      const f = createFrame({ name: `${clip.name} surface`, width: 1024, height: 1024, x: (host?.x ?? 0) + (host?.width ?? 0) + 200, y: host?.y ?? 0, pageId: host?.pageId });
      f.background = "#ffffff";
      d.frames.push(f);
      id = f.id;
      const c = locateClip(d, clip.id)?.clip;
      if (c?.kind === "mesh") c.texture = { frameId: f.id, repeat: 1 };
    });
    return id;
  };
  const NEW = "__new";
  const NONE = "__none";
  return (
    <PanelSection id="texture" title="Texture" defaultOpen={!!tex} summary={source?.name}>
      <>
        <PropRow label="Picture">
          <div className="flex min-w-0 items-center gap-1">
            <Select
              value={tex?.frameId ?? NONE}
              onValueChange={(v) => {
                if (v === NEW) create();
                else edit("Texture", (c) => void (c.texture = v === NONE ? null : { frameId: v, repeat: c.texture?.repeat ?? 1 }));
              }}
            >
              <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE} className="text-xs" description="The fill colours the surface">
                  None
                </SelectItem>
                {comps.map((f) => (
                  <SelectItem key={f.id} value={f.id} className="text-xs">
                    {f.name}
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectItem value={NEW} className="text-xs" description="A blank 1024² comp to paint on">
                  New paint comp
                </SelectItem>
              </SelectContent>
            </Select>
            {tex && (
              <IconAction label="Remove texture" onClick={() => edit("Remove texture", (c) => void (c.texture = null))}>
                <X />
              </IconAction>
            )}
          </div>
        </PropRow>
        {tex && (
          <>
            <ChoiceField label="Wrap" value={clip.uv} options={WRAP_OPTIONS} onChange={(v) => edit("Texture wrap", (c) => void (c.uv = v))} />
            <SpecField label="Repeat" value={tex.repeat} min={0.25} max={8} step={0.05} unit="×" defaultValue={1} onChange={(v) => edit("Texture repeat", (c) => void (c.texture && (c.texture.repeat = Math.max(0.05, v))), "tex-repeat")} />
            <Button variant="secondary" size="sm" className="w-full" onClick={() => open(tex.frameId)}>
              Paint {source?.name ?? "it"}
            </Button>
          </>
        )}
      </>
    </PanelSection>
  );
}

export function PartsSection({ clip }: { clip: MeshClip }) {
  const edit = useEdit(clip.id, "mesh");
  if (clip.parts.length === 0) return null;
  return (
    <PanelSection id="parts" title="Parts" count={clip.parts.length} hint="Faces with their own colour. In edit mode, select faces › right-click › New part from faces.">
      {clip.parts.map((p, i) => {
        const fill = p.fills?.find((f) => f.type === "solid");
        return (
          <PropRow key={p.id} label={p.name || `Part ${i + 1}`}>
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <DocColorInput
                  value={fill && fill.type === "solid" ? fill.color : "#ffffff"}
                  onChange={(c) =>
                    edit("Part colour", (cl) => {
                      const part = cl.parts.find((x) => x.id === p.id);
                      if (!part) return;
                      const f = part.fills?.find((x) => x.type === "solid");
                      if (f && f.type === "solid") f.color = c;
                      else part.fills = [solidPaint(c)];
                    }, `part-${p.id}`)
                  }
                />
              </div>
              <IconAction
                label="Remove part"
                onClick={() =>
                  edit("Remove part", (cl) => {
                    cl.parts = cl.parts.filter((x) => x.id !== p.id);
                    if (cl.geometry.type === "mesh" && cl.geometry.mesh.faceParts) {
                      cl.geometry.mesh.faceParts = cl.geometry.mesh.faceParts.map((x) => (x === p.id ? "" : x));
                    }
                  })
                }
              >
                <Trash2 />
              </IconAction>
            </div>
          </PropRow>
        );
      })}
    </PanelSection>
  );
}

/** Which edges a mesh's strokes draw — the outline you see, hard edges, borders, marked edges. */
export function LinesSection({ clip }: { clip: MeshClip }) {
  const edit = useEdit(clip.id, "mesh");
  const l = clip.lines;
  const toggle = (key: "silhouette" | "creases" | "boundaries" | "marked", label: string, hint: string) => (
    <ToggleField label={label} hint={hint} checked={l[key]} onChange={(v) => edit(`Lines: ${label}`, (c) => void (c.lines[key] = v))} />
  );
  return (
    <PanelSection id="lines" title="Stroke edges">
      <>
        {toggle("silhouette", "Outline", "The edge of the shape as the camera sees it")}
        {toggle("creases", "Hard edges", "Where faces meet sharper than the angle below")}
        {l.creases && <SpecField label="Angle" value={l.creaseAngle} min={0} max={180} step={1} unit="°" defaultValue={30} onChange={(v) => edit("Crease angle", (c) => void (c.lines.creaseAngle = v), "lines-angle")} />}
        {toggle("boundaries", "Open borders", "Edges with a face on one side only")}
        {toggle("marked", "Marked", "Edges you marked in edit mode (right-click › Mark edges for stroke)")}
      </>
    </PanelSection>
  );
}

/**
 * LINE ART on a layer's body — the outline the camera sees, hard edges and
 * borders, drawn as lines (core `lineArtSchema`): the illustrated look, on a
 * title, a logo, a photo card. Its own colour and width, since the layer's
 * strokes already draw its 2D outline into its picture.
 */
export function LineArtSection({ clips }: { clips: VisualClip[] }) {
  const store = useDocStore();
  const art = clips[0]!.lineArt;
  const edit = (label: string, fn: (a: NonNullable<VisualClip["lineArt"]>) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        for (const { id } of clips) {
          const c = locateClip(d, id)?.clip as VisualClip | undefined;
          if (c?.lineArt) fn(c.lineArt);
        }
      },
      mergeKey ? { mergeKey } : undefined,
    );
  const setOn = (on: boolean) =>
    store.update(on ? "Add line art" : "Remove line art", (d) => {
      for (const { id } of clips) {
        const c = locateClip(d, id)?.clip as VisualClip | undefined;
        if (!c) continue;
        if (on) c.lineArt = lineArtSchema.parse(c.lineArt ?? {});
        else delete c.lineArt;
      }
    });
  const toggle = (key: "silhouette" | "creases" | "boundaries", label: string, hint: string) =>
    art && <ToggleField label={label} hint={hint} checked={art[key]} onChange={(v) => edit(`Line art: ${label}`, (a) => void (a[key] = v))} />;
  return (
    <PanelSection id="line-art" title="Line art" summary={art ? `${art.width} px` : undefined} actions={<Switch checked={!!art} onCheckedChange={setOn} aria-label="Line art" />}>
      {art && (
        <>
          {/* Keyable, like any field: draw an outline on, fade it, change its colour. */}
          <WorldField clips={clips} path="lineArt.color" label="Colour" />
          <WorldField clips={clips} path="lineArt.width" label="Width" unit="px" slider={false} hint="On screen, whatever the distance — an outline's width" />
          <WorldField clips={clips} path="lineArt.opacity" label="Opacity" />
          {toggle("silhouette", "Outline", "The edge of the shape as the camera sees it")}
          {toggle("creases", "Hard edges", "Where faces meet sharper than the angle below — a bevel's rim, a box's corners")}
          {art.creases && <SpecField label="Angle" value={art.creaseAngle} min={0} max={180} step={1} unit="°" defaultValue={40} onChange={(v) => edit("Crease angle", (a) => void (a.creaseAngle = v), "line-art-angle")} />}
          {toggle("boundaries", "Open borders", "Edges with a face on one side only — a flat card's rim, a letter's outline")}
        </>
      )}
    </PanelSection>
  );
}

/**
 * A LATTICE CAGE (core `latticeSpecSchema`): how many points it has, and the
 * way back to rest. Its points are moved in edit mode; what it deforms is
 * whatever names it in a Lattice card.
 */
export function LatticeSection({ clip, doc }: { clip: MeshClip; doc: MotionDocument }) {
  const store = useDocStore();
  const spec = clip.lattice!;
  const users = doc.tracks
    .flatMap((t) => t.clips)
    .filter((c) => c.kind !== "audio" && ((c as VisualClip).modifiers ?? []).some((m) => m.type === "lattice" && m.cage === clip.id))
    .map((c) => c.name);
  // A new resolution keeps the cage's shape (core `resampleLattice`); Reset
  // puts every point back at rest.
  const regrid = (label: string, next: Partial<Pick<NonNullable<MeshClip["lattice"]>, "u" | "v" | "w">> | "reset") =>
    store.update(label, (d) => {
      const c = locateClip(d, clip.id)?.clip;
      if (c?.kind !== "mesh" || !c.lattice) return;
      const was = c.lattice;
      const points = c.geometry.type === "mesh" ? c.geometry.mesh.positions : [];
      c.lattice = latticeSpecSchema.parse({ ...was, ...(next === "reset" ? {} : next) });
      c.geometry = { type: "mesh", mesh: next === "reset" ? latticeMesh(c.lattice) : resampleLattice(was, points, c.lattice) };
    });
  const axis = (key: "u" | "v" | "w", label: string) => (
    <SpecField label={label} value={spec[key]} min={2} max={12} step={1} defaultValue={3} onChange={(v) => regrid("Lattice points", { [key]: Math.round(Math.min(12, Math.max(2, v))) })} />
  );
  return (
    <PanelSection id="lattice" title="Lattice" summary={`${spec.u}×${spec.v}×${spec.w}`}>
      <p className="px-1 pb-1 text-xs text-muted-foreground">
        {users.length ? `Shapes ${users.join(", ")}. ` : "Nothing reads it yet — add a Lattice modifier and pick it. "}
        Tab into it and move its points.
      </p>
      {axis("u", "Points X")}
      {axis("v", "Points Y")}
      {axis("w", "Points Z")}
      <PropRow label="">
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => regrid("Reset lattice", "reset")}>
          Reset points
        </Button>
      </PropRow>
    </PanelSection>
  );
}

const BLOOM_SOURCES: ReadonlyArray<SegmentedOption<"bright" | "emission">> = [
  { value: "bright", label: "Bright", hint: "Whatever is bright enough in the picture glows" },
  { value: "emission", label: "Emission", hint: "Only what emits light glows — neon, screens, a lit logo; a white wall never does" },
];

// ── Thickness ────────────────────────────────────────────────────────────────

const FIT_OPTIONS: ReadonlyArray<SegmentedOption<BodyFit>> = [
  { value: "outline", label: "Outline", icon: Shapes, hint: "Exact — follows the real shape: glyphs, a contour, the picture's transparency" },
  { value: "box", label: "Box", icon: Box, hint: "Fast — a slab the size of the picture. Best for video and photos" },
];

/**
 * THICKNESS — any 2D layer in a world as a real object (core `extrudeSchema`):
 * a text's glyphs, a logo, a photo, a video, a nested comp. Off is the flat
 * picture. On, the face keeps the picture and the sides take a colour — a
 * shade of a vector's face, or a picture's own edge pixels, as a printed
 * block has.
 */
export function ThicknessSection({ clips }: { clips: VisualClip[] }) {
  const store = useDocStore();
  const clip = clips[0]!;
  const ex = bodyThickness(clip);
  const edit = (label: string, fn: (spec: NonNullable<VisualClip["extrude"]>) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        for (const { id } of clips) {
          const c = locateClip(d, id)?.clip as VisualClip | undefined;
          if (c?.extrude) fn(c.extrude);
        }
      },
      mergeKey ? { mergeKey } : undefined,
    );
  const setThick = (on: boolean) =>
    store.update(on ? "Add thickness" : "Make flat", (d) => {
      for (const { id } of clips) {
        const c = locateClip(d, id)?.clip as VisualClip | undefined;
        if (!c) continue;
        // Pictures start as a thin card; letters and logos as a proper solid.
        const depth = c.extrude?.depth || (VECTOR_BODY_KINDS.has(c.kind) ? 40 : 12);
        c.extrude = on ? extrudeSchema.parse({ ...(c.extrude ?? {}), depth }) : undefined;
      }
    });
  const vector = clips.every((c) => VECTOR_BODY_KINDS.has(c.kind));
  return (
    <PanelSection id="solid-depth" title="Thickness" summary={ex ? `${Math.round(ex.depth)} u` : undefined} actions={<Switch checked={!!ex} onCheckedChange={setThick} aria-label="Thickness" />}>
      {ex && (
        <>
          <ChoiceField label="Shape" value={bodyFit(clip)} options={FIT_OPTIONS} onChange={(v) => edit("Thickness shape", (e) => void (e.fit = v))} />
          <WorldField clips={clips} path="extrude.depth" slider={false} unit="u" />
          <WorldField clips={clips} path="extrude.bevel" slider={false} unit="u" hint="Rounds the edges — a few units reads as polished" />
          {ex.bevel > 0 && (
            <SpecField label="Steps" value={ex.bevelSegments} min={1} max={8} step={1} defaultValue={3} hint="1 is a flat chamfer, 3 and up a round edge" onChange={(v) => edit("Bevel steps", (e) => void (e.bevelSegments = Math.round(Math.min(8, Math.max(1, v)))), "solid-steps")} />
          )}
          <PropRow label="Sides" hint={vector ? "Auto is a shade of the face colour" : "Auto draws the picture's edge back along the depth"}>
            {ex.sideColor ? (
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <div className="min-w-0 flex-1">
                  <DocColorInput value={ex.sideColor} onChange={(c) => edit("Side colour", (e) => void (e.sideColor = c), "solid-side")} />
                </div>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => edit("Side colour", (e) => void (e.sideColor = null))}>
                  Auto
                </Button>
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-center justify-between gap-1">
                <span className="truncate text-xs text-muted-foreground">{vector ? "Auto · a shade of the face" : "Auto · the picture's edge"}</span>
                <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={() => edit("Side colour", (e) => void (e.sideColor = "#2a2a2e"))}>
                  Colour
                </Button>
              </div>
            )}
          </PropRow>
        </>
      )}
    </PanelSection>
  );
}

// ── Constraints ──────────────────────────────────────────────────────────────

/** Any other visual layer of this comp — what a constraint may target. */
const otherLayers = (clip: Clip, predicate?: (c: PickCandidate) => boolean): PickFilter => ({
  kinds: ["layer"],
  frameId: clip.frameId,
  tags: ["visual"],
  exclude: [clip.id],
  predicate,
});

export function ConstraintsSection({ clip, doc }: { clip: VisualClip; doc: MotionDocument }) {
  const store = useDocStore();
  const list = clip.constraints ?? [];
  const edit = (label: string, fn: (c: VisualClip) => void) =>
    store.update(label, (d) => {
      const c = locateClip(d, clip.id)?.clip;
      if (c && c.kind !== "audio") fn(c);
    });
  const set = (type: "lookAt" | "follow", targetId: string | null) =>
    edit(type === "lookAt" ? "Look at" : "Follow", (c) => {
      const cs = (c.constraints ?? []).filter((x) => x.type !== type);
      if (targetId) {
        const id = `cns_${Math.random().toString(36).slice(2, 10)}`;
        cs.push(type === "lookAt" ? { id, type, targetId, enabled: true, influence: 1 } : { id, type, targetId, enabled: true, influence: 1, rotation: false });
      }
      c.constraints = cs.length ? cs : undefined;
    });
  const look = list.find((c) => c.type === "lookAt");
  const follow = list.find((c) => c.type === "follow");
  const parent = list.find((c) => c.type === "childOf");
  const ik = list.find((c) => c.type === "ik");
  const setIk = (patch: { targetId?: string | null; chainLength?: number; poleId?: string | null }) =>
    edit(patch.targetId === null ? "Remove IK" : "IK", (c) => {
      const was = (c.constraints ?? []).find((x) => x.type === "ik");
      const rest: NonNullable<VisualClip["constraints"]> = (c.constraints ?? []).filter((x) => x.type !== "ik");
      const targetId = patch.targetId === undefined ? (was?.type === "ik" ? was.targetId : null) : patch.targetId;
      if (targetId) {
        rest.push({
          id: was?.id ?? `cns_${Math.random().toString(36).slice(2, 10)}`,
          type: "ik",
          targetId,
          enabled: true,
          influence: was?.influence ?? 1,
          chainLength: patch.chainLength ?? (was?.type === "ik" ? was.chainLength : 2),
          poleId: patch.poleId === undefined ? (was?.type === "ik" ? was.poleId : null) : patch.poleId,
        });
      }
      c.constraints = rest.length ? rest : undefined;
    });
  const playheadMs = useParkedPlayhead();
  return (
    <PanelSection id="constraints" title="Track" defaultOpen={list.length > 0} count={list.length || undefined}>
      <>
        <PropRow label="Child of" hint="Moves, turns and scales with its parent from where it is now — chain them for a rig">
          <LayerRefField
            filter={otherLayers(clip)}
            noun="parent"
            value={parent?.targetId ?? null}
            onChange={(id) =>
              store.update(id ? "Parent" : "Unparent", (d) => {
                const frame = d.frames.find((f) => f.id === clip.frameId);
                if (frame) setChildOf(d, frame, clip.id, id, playheadMs);
              })
            }
          />
        </PropRow>
        <PropRow label="Look at" hint="Always turns to face it — a camera on a hero">
          <LayerRefField filter={otherLayers(clip)} value={look?.targetId ?? null} onChange={(id) => set("lookAt", id)} />
        </PropRow>
        <PropRow label="Follow" hint="Rides along with it; its own position becomes the distance it keeps">
          <LayerRefField filter={otherLayers(clip)} value={follow?.targetId ?? null} onChange={(id) => set("follow", id)} />
        </PropRow>
        {follow && (
          <ToggleField
            label="Turn with it"
            checked={follow.type === "follow" && follow.rotation}
            onChange={(v) => edit("Follow rotation", (c) => void (c.constraints ?? []).forEach((x) => x.type === "follow" && (x.rotation = v)))}
          />
        )}
        {/* IK on the TIP of a Child Of chain: its parents turn so it reaches. */}
        {parent && (
          <PropRow label="Reach (IK)" hint="Its parents turn so it reaches this — animate a hand, not three rotations">
            <LayerRefField filter={otherLayers(clip)} value={ik?.targetId ?? null} onChange={(id) => setIk({ targetId: id })} />
          </PropRow>
        )}
        {ik?.type === "ik" && (
          <>
            <SpecField label="Chain" hint="How many parents above it turn (2 = forearm and upper arm)" value={ik.chainLength} min={1} max={16} step={1} defaultValue={2} onChange={(v) => setIk({ chainLength: Math.round(Math.min(16, Math.max(1, v))) })} />
            <PropRow label="Pole" hint="Which way the bend points — an elbow toward a controller behind the arm">
              <LayerRefField filter={otherLayers(clip)} noun="pole" value={ik.poleId} onChange={(id) => setIk({ poleId: id })} />
            </PropRow>
          </>
        )}
      </>
    </PanelSection>
  );
}

// ── Controller ───────────────────────────────────────────────────────────────

/** How a controller shows in the viewport (it never renders). */
export function ControllerSection({ clip }: { clip: EmptyClip }) {
  const edit = useEdit(clip.id, "empty");
  return (
    <PanelSection id="controller" title="Controller" hint="Animate it and parent layers to it (Track › Child of). It never shows in the render.">
      <>
        <SelectField label="Shows as" value={clip.display} onChange={(v) => edit("Controller look", (c) => void (c.display = v as EmptyClip["display"]))}>
          {EMPTY_DISPLAYS.map((d) => (
            <SelectItem key={d} value={d} className="text-xs capitalize">
              {d}
            </SelectItem>
          ))}
        </SelectField>
        <SpecField label="Size" value={clip.size} min={1} step={1} unit="u" defaultValue={80} onChange={(v) => edit("Controller size", (c) => void (c.size = Math.max(1, v)), "ctrl-size")} />
      </>
    </PanelSection>
  );
}

// ── The world itself (frame inspector) ───────────────────────────────────────

export function WorldRenderSection({ frame }: { frame: Frame }) {
  const store = useDocStore();
  const w = frame.world;
  if (!w) return null;
  const edit = (label: string, fn: (w: WorldSpec) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        const f = d.frames.find((x) => x.id === frame.id);
        if (f?.world) fn(f.world);
      },
      mergeKey ? { mergeKey } : undefined,
    );
  const bloomOf = (x: WorldSpec) => (x.render.bloom ??= worldSpecSchema.parse({}).render.bloom);
  const bloom = w.render.bloom ?? worldSpecSchema.parse({}).render.bloom;
  const aoOf = (x: WorldSpec) => (x.render.ao ??= worldSpecSchema.parse({}).render.ao);
  const ao = w.render.ao ?? worldSpecSchema.parse({}).render.ao;
  const floorOf = (x: WorldSpec) => (x.render.floor ??= worldSpecSchema.parse({}).render.floor);
  const floor = w.render.floor ?? worldSpecSchema.parse({}).render.floor;
  return (
    <>
      <PanelSection id="world-render" title="3D world" hint="The world's colour is this frame's fill; its lights are layers. This is how the picture is developed.">
        <>
          <SelectField label="Tone" value={w.render.toneMapping} onChange={(v) => edit("Tone mapping", (x) => void (x.render.toneMapping = v as never))}>
            <SelectItem value="agx" className="text-xs" description="Filmic — highlights roll off softly">
              AgX
            </SelectItem>
            <SelectItem value="aces" className="text-xs" description="Punchier, the film-industry look">
              ACES
            </SelectItem>
            <SelectItem value="neutral" className="text-xs" description="Keeps product colours true">
              Neutral
            </SelectItem>
            <SelectItem value="none" className="text-xs">
              Standard
            </SelectItem>
          </SelectField>
          <SpecField label="Exposure" value={w.render.exposure} min={-5} max={5} step={0.05} unit="EV" defaultValue={0} onChange={(v) => edit("Exposure", (x) => void (x.render.exposure = v), "world-exposure")} />
          <ToggleField label="Shadows" checked={w.render.shadows} onChange={(v) => edit("Shadows", (x) => void (x.render.shadows = v))} />
          {w.render.shadows && (
            <ChoiceField
              label="Quality"
              value={w.render.shadowQuality}
              onChange={(v) => edit("Shadow quality", (x) => void (x.render.shadowQuality = v))}
              options={[
                { value: "low", label: "Low" },
                { value: "medium", label: "Med" },
                { value: "high", label: "High" },
              ]}
            />
          )}
          <ToggleField label="Mist" hint="Fades what is far away into a colour" checked={w.fog.enabled} onChange={(v) => edit("Mist", (x) => void (x.fog.enabled = v))} />
          {w.fog.enabled && (
            <>
              <PropRow label="Colour">
                <div className="min-w-0 flex-1">
                  <DocColorInput value={w.fog.color} onChange={(c) => edit("Mist colour", (x) => void (x.fog.color = c), "fog-color")} />
                </div>
              </PropRow>
              <SpecField label="Starts" value={w.fog.start} min={0} step={10} unit="u" onChange={(v) => edit("Mist start", (x) => void (x.fog.start = v), "fog-start")} />
              <SpecField label="Full at" value={w.fog.end} min={0} step={10} unit="u" onChange={(v) => edit("Mist end", (x) => void (x.fog.end = v), "fog-end")} />
            </>
          )}
          <ToggleField label="Contact" hint="Ambient occlusion — soft shadow where surfaces meet: it seats an object on the floor and gives type depth" checked={ao.enabled} onChange={(v) => edit("Ambient occlusion", (x) => void (aoOf(x).enabled = v))} />
          {ao.enabled && (
            <>
              <SpecField label="Reach" value={ao.radius} min={1} max={5000} step={1} unit="u" defaultValue={60} onChange={(v) => edit("AO reach", (x) => void (aoOf(x).radius = v), "ao-r")} />
              <SpecField label="Strength" value={ao.strength} min={0} max={2} step={0.01} defaultValue={1} onChange={(v) => edit("AO strength", (x) => void (aoOf(x).strength = v), "ao-k")} />
            </>
          )}

          {/* Four modes do not fit a segmented row at panel width. */}
          <SelectField label="Floor" value={floor.mode} onChange={(v) => edit("Floor", (x) => void (floorOf(x).mode = v as typeof floor.mode))}>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="shadow">Shadow catcher</SelectItem>
            <SelectItem value="solid">Solid</SelectItem>
            <SelectItem value="mirror">Mirror</SelectItem>
          </SelectField>
          {floor.mode !== "none" && (
            <>
              {floor.mode === "shadow" ? (
                <SpecField label="Darkness" value={floor.opacity} min={0} max={1} step={0.01} defaultValue={0.45} onChange={(v) => edit("Floor darkness", (x) => void (floorOf(x).opacity = v), "floor-o")} />
              ) : (
                <PropRow label="Colour">
                  <div className="min-w-0 flex-1">
                    <DocColorInput value={floor.color} onChange={(c) => edit("Floor colour", (x) => void (floorOf(x).color = c), "floor-c")} />
                  </div>
                </PropRow>
              )}
              {floor.mode === "mirror" && (
                <SpecField label="Reflection" hint="How much of the scene the floor reflects" value={Math.round((1 - floor.opacity) * 100) / 100} min={0} max={0.95} step={0.01} defaultValue={0.55} onChange={(v) => edit("Floor reflection", (x) => void (floorOf(x).opacity = Math.max(0.05, 1 - v)), "floor-o")} />
              )}
              <SpecField label="Height" value={floor.z} step={1} unit="u" defaultValue={0} onChange={(v) => edit("Floor height", (x) => void (floorOf(x).z = v), "floor-z")} />
            </>
          )}
          <ToggleField label="Bloom" hint="Bright things glow into their surroundings — what makes emission read as light" checked={bloom.enabled} onChange={(v) => edit("Bloom", (x) => void (bloomOf(x).enabled = v))} />
          {bloom.enabled && (
            <>
              <SpecField label="Strength" value={bloom.strength} min={0} max={3} step={0.01} defaultValue={0.8} onChange={(v) => edit("Bloom strength", (x) => void (bloomOf(x).strength = v), "bloom-k")} />
              <SpecField label="Spread" value={bloom.radius} min={0} max={1} step={0.01} defaultValue={0.5} onChange={(v) => edit("Bloom spread", (x) => void (bloomOf(x).radius = v), "bloom-r")} />
              <ChoiceField
                label="Glows"
                value={bloom.source ?? "bright"}
                options={BLOOM_SOURCES}
                onChange={(v) => edit("Bloom source", (x) => void (bloomOf(x).source = v))}
              />
              {(bloom.source ?? "bright") === "bright" && (
                <SpecField label="Threshold" hint="How bright a pixel must be to glow" value={bloom.threshold} min={0} max={1} step={0.01} defaultValue={0.75} onChange={(v) => edit("Bloom threshold", (x) => void (bloomOf(x).threshold = v), "bloom-t")} />
              )}
            </>
          )}
        </>
      </PanelSection>
      <SimulationSection frame={frame} />
    </>
  );
}

export function isWorldClip(doc: MotionDocument, clip: Clip): boolean {
  return !!doc.frames.find((f) => f.id === clip.frameId)?.world;
}
