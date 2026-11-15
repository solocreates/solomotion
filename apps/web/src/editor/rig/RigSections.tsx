"use client";

import * as React from "react";
import {
  addExpression,
  bindSchema,
  decide2d,
  evaluateRig,
  bakeRig,
  addConstraint,
  boneColor,
  mirrorPose,
  removeConstraints,
  sideOf,
  SIDE_COLORS,
  symmetrize,
  updateConstraint,
  expressionById,
  fxToken,
  getBoneProperty,
  limitChannel,
  locateClip,
  memberOf,
  parseFxToken,
  resetPose,
  rigIsPlanar,
  setBind,
  setBoneProps,
  setExpressionSource,
  setSwitch,
  composesOverKeys,
  switchOptions,
  unmakeSwitch,
  clearWeightPaint,
  type MotionDocument,
  type Bone,
  type BoneLimits,
  type BoneConstraint,
  type BoneShape,
  type Clip,
  type GroupClip,
  type KeyframeValue,
  type Rig,
} from "@solomotion/core";
import { Bone as BoneIcon, Circle, Diamond, FlipHorizontal2, Move, Pencil, Plus, RotateCcw, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Range } from "@/components/ui/range";
import { RenameInput } from "@/components/ui/rename-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useParkedPlayhead } from "../state/session";
import { clipLocalClamped, commitProperty, useEffectiveValue } from "../inspector/animatable";
import { Note, Pair, PanelSection, PropRow, IconTrack } from "../inspector/controls";
import { KeyControl } from "../inspector/keyframe-controls";
import { ValueField } from "../inspector/value-field";
import { useRigUi } from "./state";

/**
 * THE RIG IN THE SIDEBAR — the rig, the bone you picked, a switch, and how a
 * piece of art follows its bones.
 *
 * Bones are not layers, so they never enter the clip selection: you select
 * the RIG (the group), and the bone you picked on the canvas or in the list
 * below opens its own panel under it. Every pose value is an ordinary
 * channel row — keyed, driven and modulated by the same `ValueField` every
 * effect field uses — and a limited channel's row becomes a meter across
 * exactly its range.
 */

// ── Rig ──────────────────────────────────────────────────────────────────────

export function RigSections({ clip }: { clip: GroupClip }) {
  if (!clip.rig) return null;
  return (
    <>
      <RigSection clip={clip} rig={clip.rig} />
      <BoneSection clip={clip} rig={clip.rig} />
    </>
  );
}

/** Pose / Setup — what dragging the art does (`useRigUi.mode`; the Bone tool is setup too). */
const RIG_MODES = [
  { id: "pose", label: "Pose — move it by its bones", icon: <span className="text-[10px] font-medium">Pose</span> },
  { id: "setup", label: "Setup — adjust bones and art at rest", icon: <span className="text-[10px] font-medium">Setup</span> },
] as const;

/** Rotate / Reach — how a drag poses (`useRigUi.grammar`). */
const POSE_GRAMMARS = [
  { id: "reach", label: "Reach — pull a bone and its limb bends to follow (IK)", icon: <span className="text-[10px] font-medium">Reach</span> },
  { id: "rotate", label: "Rotate — a bone turns about its head (FK)", icon: <span className="text-[10px] font-medium">Rotate</span> },
] as const;

function RigSection({ clip, rig }: { clip: GroupClip; rig: Rig }) {
  const store = useDocStore();
  const picked = useRigUi((s) => (s.rigId === clip.id ? s.bones : NONE));
  const mode = useRigUi((s) => s.mode);
  const grammar = useRigUi((s) => s.grammar);
  const chain = useRigUi((s) => s.chain);
  const drawing = useSession((s) => s.tool === "bone");
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const rows = React.useMemo(() => boneTree(rig), [rig]);
  const sided = React.useMemo(() => rig.bones.some((b) => sideOf(b.name)), [rig]);
  const update = (label: string, fn: (g: GroupClip, d: MotionDocument) => void, mergeKey?: string) =>
    store.update(label, (d) => {
      const g = locateClip(d, clip.id)?.clip;
      if (g?.kind === "group" && g.rig) fn(g, d);
    }, mergeKey ? { mergeKey } : undefined);

  return (
    <PanelSection
      id="rig"
      title="Rig"
      hint="Bones that move this character"
      count={rig.bones.length || undefined}
      actions={
        <>
          <Button variant="ghost" size="icon-sm" title="Draw bones (J)" onClick={() => useSession.getState().setTool("bone")}>
            <Pencil />
          </Button>
          {sided && <MirrorMenu clip={clip} picked={picked} />}
          <Button
            variant="ghost"
            size="icon-sm"
            title={picked.length ? "Reset the picked bones to rest" : "Reset every bone to rest (keys stay)"}
            onClick={() => update("Reset pose", (_, d) => void resetPose(d, clip.id, picked.length ? picked : undefined))}
          >
            <RotateCcw />
          </Button>
        </>
      }
    >
      <PropRow label="Mode">
        <IconTrack
          value={drawing ? "setup" : mode}
          items={RIG_MODES}
          onPick={(v) => {
            useRigUi.getState().setMode(v);
            if (v === "pose" && drawing) useSession.getState().setTool("select");
          }}
        />
      </PropRow>
      {mode === "pose" && !drawing && (
        <PropRow label="Drag" hint="How dragging a bone poses it. Pins (right-click a bone) hold while you reach.">
          <div className="flex w-full items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <IconTrack value={grammar} items={POSE_GRAMMARS} onPick={(v) => useRigUi.getState().setGrammar(v)} />
            </div>
            {grammar === "reach" && (
              <div className="w-20 shrink-0" title="How many bones a reach bends ([ and ] on the canvas)">
                <NumberInput value={chain} min={1} max={16} step={1} unit="bones" onChange={(v) => useRigUi.getState().setChain(v)} />
              </div>
            )}
          </div>
        </PropRow>
      )}
      {rows.length ? (
        <div className="track flex max-h-56 flex-col gap-px overflow-y-auto bg-input/35 p-0.5" role="listbox" aria-label="Bones">
          {rows.map(({ bone, depth }) => {
            const on = picked.includes(bone.id);
            return (
              <div
                key={bone.id}
                role="option"
                aria-selected={on}
                className={cn(
                  "flex h-6 cursor-default items-center gap-1.5 rounded px-1.5 text-[12px]",
                  on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                style={{ paddingLeft: 6 + depth * 12 }}
                onClick={(e) => useRigUi.getState().selectBones(clip.id, [bone.id], e.shiftKey)}
                onDoubleClick={() => setRenaming(bone.id)}
              >
                <ShapeGlyph bone={bone} />
                {renaming === bone.id ? (
                  <RenameInput
                    initial={bone.name}
                    className="h-5 min-w-0 flex-1 rounded bg-background px-1 text-[12px]"
                    onCommit={(name) => {
                      setRenaming(null);
                      if (name.trim() && name !== bone.name) update("Rename bone", (_, d) => void setBoneProps(d, clip.id, bone.id, { name }));
                    }}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{bone.name}</span>
                )}
                {bone.ik && <span className="text-[10px] text-muted-foreground/80" title="Reaches by IK">IK</span>}
                {!bone.deform && bone.shape === "bone" && <span className="text-[10px] text-muted-foreground/80" title="A control: posed and keyed, bends nothing">ctrl</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <Note>No bones yet — press J and draw through the art, joint to joint.</Note>
      )}
      <PropRow label="Blend" hint="How far the bending art softens around a joint: 0 creases like a hinge, 1 bends like rubber hose.">
        <Range
          className="w-full"
          value={rig.blend}
          min={0}
          max={1}
          step={0.01}
          precision={2}
          defaultValue={0.35}
          aria-label="Joint blend"
          onChange={(v) => update("Joint blend", (g) => void (g.rig!.blend = Math.max(0, Math.min(1, v))), "rig-blend")}
        />
      </PropRow>
      <PropRow toggle label="Show bones" hint="Draw the bones while this rig is selected. Guides only — never in a render.">
        <Switch checked={rig.showBones} onCheckedChange={(v) => update(v ? "Show bones" : "Hide bones", (g) => void (g.rig!.showBones = v))} />
      </PropRow>
    </PanelSection>
  );
}

const NONE: string[] = [];

/**
 * Left ↔ right: build one side of the skeleton from the other (setup), or
 * copy / flip the pose at the playhead (keyed with Record on). Shown once a
 * bone's name says which side it is on.
 */
function MirrorMenu({ clip, picked }: { clip: GroupClip; picked: string[] }) {
  const store = useDocStore();
  const at = () => clipLocalClamped(clip, useSession.getState().playheadMs);
  const pose = (label: string, opts: Parameters<typeof mirrorPose>[3]) =>
    store.update(label, (d) => void mirrorPose(d, clip.id, at(), { ...opts, key: useSession.getState().recording }));
  const item = "text-[12px]";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Mirror left ↔ right">
          <FlipHorizontal2 />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">Skeleton</DropdownMenuLabel>
        <DropdownMenuItem className={item} onSelect={() => store.update("Symmetrize", (d) => void symmetrize(d, clip.id, { from: "L" }))}>Symmetrize left → right</DropdownMenuItem>
        <DropdownMenuItem className={item} onSelect={() => store.update("Symmetrize", (d) => void symmetrize(d, clip.id, { from: "R" }))}>Symmetrize right → left</DropdownMenuItem>
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">Pose here</DropdownMenuLabel>
        {picked.length > 0 && (
          <DropdownMenuItem className={item} onSelect={() => pose("Mirror pose", { mode: "copy", bones: picked })}>Copy picked to the other side</DropdownMenuItem>
        )}
        <DropdownMenuItem className={item} onSelect={() => pose("Mirror pose", { mode: "copy", from: "L" })}>Copy left → right</DropdownMenuItem>
        <DropdownMenuItem className={item} onSelect={() => pose("Mirror pose", { mode: "copy", from: "R" })}>Copy right → left</DropdownMenuItem>
        <DropdownMenuItem className={item} onSelect={() => pose("Flip pose", { mode: "flip" })}>Flip pose</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Bones in tree order (parents before children), each with its depth. */
function boneTree(rig: Rig): Array<{ bone: Bone; depth: number }> {
  const kids = new Map<string | null, Bone[]>();
  const ids = new Set(rig.bones.map((b) => b.id));
  for (const b of rig.bones) {
    const p = b.parent && ids.has(b.parent) ? b.parent : null;
    kids.set(p, [...(kids.get(p) ?? []), b]);
  }
  const out: Array<{ bone: Bone; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (p: string | null, depth: number) => {
    for (const b of kids.get(p) ?? []) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push({ bone: b, depth });
      walk(b.id, depth + 1);
    }
  };
  walk(null, 0);
  // A loop the evaluator cut still lists, at the root.
  for (const b of rig.bones) if (!seen.has(b.id)) out.push({ bone: b, depth: 0 });
  return out;
}

function ShapeGlyph({ bone }: { bone: Bone }) {
  const cls = "size-3 shrink-0";
  const tint = boneColor(bone);
  const style = tint ? { color: tint } : undefined;
  switch (bone.shape) {
    case "circle":
      return <Circle className={cls} style={style} />;
    case "square":
      return <Square className={cls} style={style} />;
    case "diamond":
      return <Diamond className={cls} style={style} />;
    case "cross":
      return <Move className={cls} style={style} />;
    default:
      return <BoneIcon className={cn(cls, !bone.deform && "opacity-50")} style={style} />;
  }
}

// ── The picked bone ─────────────────────────────────────────────────────────

const SHAPES: ReadonlyArray<{ id: BoneShape; label: string; icon: React.ReactNode }> = [
  { id: "bone", label: "Bone", icon: <BoneIcon /> },
  { id: "circle", label: "Circle — a root, a hip, a dial", icon: <Circle /> },
  { id: "square", label: "Square", icon: <Square /> },
  { id: "diamond", label: "Diamond — an IK target", icon: <Diamond /> },
  { id: "cross", label: "Cross — a mover", icon: <Move /> },
];

/** Side colours (Blender's bone colours): left, right, centre, and two spares. */
const COLOURS = [SIDE_COLORS.L, SIDE_COLORS.R, "#ffd23f", "#5ee07a", "#c77dff"];

/** Ready-made controls: what a person usually means by "make this a control". */
const PRESETS: ReadonlyArray<{ label: string; hint: string; props: Parameters<typeof setBoneProps>[3] }> = [
  { label: "Slider", hint: "Left–right, 0 to 100 — drive a smile, a blink, a switch", props: { deform: false, shape: "circle", limits: { x: [0, 100], y: [0, 0], rotation: [0, 0] } } },
  { label: "Pad", hint: "Up, down, left, right — an eye target, a mouth shape", props: { deform: false, shape: "square", limits: { x: [-50, 50], y: [-50, 50], rotation: [0, 0] } } },
  { label: "Dial", hint: "Turns only, a half turn either way", props: { deform: false, shape: "circle", limits: { x: [0, 0], y: [0, 0], rotation: [-180, 180] } } },
  { label: "IK target", hint: "Moves freely; a chain reaches for it", props: { deform: false, shape: "diamond", limits: null } },
  { label: "Mover", hint: "A root that carries everything under it", props: { deform: false, shape: "cross", limits: null } },
];

function BoneSection({ clip, rig }: { clip: GroupClip; rig: Rig }) {
  const store = useDocStore();
  const doc = useDoc();
  const active = useRigUi((s) => (s.rigId === clip.id ? (s.bones[s.bones.length - 1] ?? null) : null));
  const bone = rig.bones.find((b) => b.id === active);
  if (!bone) return null;
  const planar = rigIsPlanar(doc, clip);
  const set = (label: string, props: Parameters<typeof setBoneProps>[3]) => store.update(label, (d) => void setBoneProps(d, clip.id, bone.id, props));
  const others = rig.bones.filter((b) => b.id !== bone.id);
  // A world bone turns three ways and moves in depth; a flat one turns once, in its plane.
  const channels: Array<{ ch: "rotation" | "rotationY" | "rotationX" | "x" | "y" | "z" | "scale" | "scaleY"; label: string; unit?: string; step: number }> = [
    { ch: "rotation", label: planar ? "Rotation" : "Heading", unit: "°", step: 0.1 },
    ...(planar ? [] : [{ ch: "rotationY" as const, label: "Pitch", unit: "°", step: 0.1 }, { ch: "rotationX" as const, label: "Roll", unit: "°", step: 0.1 }]),
    { ch: "x", label: "Move X", step: planar ? 1 : 0.1 },
    { ch: "y", label: "Move Y", step: planar ? 1 : 0.1 },
    ...(planar ? [] : [{ ch: "z" as const, label: "Move Z", step: 0.1 }]),
    { ch: "scale", label: "Stretch", step: 0.01 },
    { ch: "scaleY", label: "Thickness", step: 0.01 },
  ];

  return (
    <PanelSection
      id="bone"
      title={bone.name}
      hint="The picked bone. Its pose is a change from where it was drawn; every value keys, drives and modulates like any other."
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" title="Make this bone a ready-made control">
              Control…
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">Make it a control</DropdownMenuLabel>
            {PRESETS.map((p) => (
              <DropdownMenuItem key={p.label} onSelect={() => set(`Make ${p.label.toLowerCase()}`, p.props)} className="flex-col items-start gap-0">
                <span className="text-[12px]">{p.label}</span>
                <span className="text-[11px] text-muted-foreground">{p.hint}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => set("Make deforming bone", { deform: true, shape: "bone", limits: null })} className="text-[12px]">
              Back to a plain bone
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {channels.map(({ ch, label, unit, step }) => {
        const path = `bone.${bone.id}.${ch}`;
        const range = bone.limits?.[ch];
        const locked = !!range && range[0] === range[1];
        if (locked) return null;
        return (
          <ValueField
            key={ch}
            clip={clip}
            canKey
            layout="inspector"
            path={path}
            kind="number"
            label={label}
            base={(getBoneProperty(clip, path) as number) ?? (ch === "scale" || ch === "scaleY" ? 1 : 0)}
            min={range?.[0]}
            max={range?.[1]}
            step={step}
            unit={unit}
            defaultValue={ch === "scale" || ch === "scaleY" ? 1 : 0}
            onChange={(v) => writeChannelValue(store, clip.id, bone, path, ch, v)}
          />
        );
      })}
      {bone.ik && (
        <ValueField
          clip={clip}
          canKey
          layout="inspector"
          path={`bone.${bone.id}.ik`}
          kind="number"
          label="IK"
          hint="How much the reach wins over the keyed angles."
          base={bone.ik.mix}
          min={0}
          max={1}
          step={0.01}
          defaultValue={1}
          onChange={(v) => writeChannelValue(store, clip.id, bone, `bone.${bone.id}.ik`, "ik", v)}
        />
      )}

      <PropRow label="Parent">
        <Select value={bone.parent ?? "∅"} onValueChange={(v) => set("Re-parent bone", { parent: v === "∅" ? null : v })}>
          <SelectTrigger className="h-7 w-full text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="∅" className="text-[12px]">None — a root</SelectItem>
            {others.map((b) => (
              <SelectItem key={b.id} value={b.id} className="text-[12px]">
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PropRow>
      <PropRow toggle label="Bends art" hint="Off for a control — posed and keyed like any bone, but it pulls on no art.">
        <Switch checked={bone.deform} onCheckedChange={(v) => set(v ? "Bone bends art" : "Bone is a control", { deform: v })} />
      </PropRow>
      <PropRow label="Shape" hint="How it is drawn while posing. A shape makes it a handle to grab.">
        <IconTrack value={bone.shape} items={SHAPES} onPick={(v) => set("Bone shape", { shape: v })} />
      </PropRow>
      {bone.shape !== "bone" && (
        <PropRow label="Size">
          <Pair>
            <NumberInput value={bone.size ?? Math.max(10, bone.rest.length * 0.35)} min={1} precision={0} unit={planar ? "px" : "u"} onChange={(v) => set("Control size", { size: v })} />
          </Pair>
        </PropRow>
      )}
      <PropRow label="Colour" hint="Tell a character's sides apart on the canvas.">
        <div className="flex h-7 items-center gap-1">
          <button
            type="button"
            aria-label="No colour"
            className={cn("size-5 rounded-full border border-border", !bone.color && "ring-2 ring-foreground/70")}
            onClick={() => set("Bone colour", { color: null })}
          />
          {COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              className={cn("size-5 rounded-full", bone.color === c && "ring-2 ring-foreground/70")}
              style={{ background: c }}
              onClick={() => set("Bone colour", { color: c })}
            />
          ))}
        </div>
      </PropRow>

      <LimitRows bone={bone} planar={planar} onSet={(limits) => set("Bone limits", { limits })} />
      <IkRows bone={bone} others={others} onSet={(ik) => set(ik === null ? "Remove IK" : "Bone IK", { ik })} />
      <ConstraintRows clip={clip} bone={bone} others={others} />
    </PanelSection>
  );
}

const CONSTRAINT_KINDS: ReadonlyArray<{ type: BoneConstraint["type"]; label: string; hint: string }> = [
  { type: "look", label: "Look", hint: "Slides toward a target inside its pad — a pupil" },
  { type: "track", label: "Track", hint: "Turns to point at a target — a head" },
];

/** LOOK / TRACK: what the bone watches, how much (keyable), and for a look how far it may slide. */
function ConstraintRows({ clip, bone, others }: { clip: GroupClip; bone: Bone; others: Bone[] }) {
  const store = useDocStore();
  const list = bone.constraints ?? [];
  const edit = (label: string, fn: (d: MotionDocument) => void) => store.update(label, fn);
  const add = (type: BoneConstraint["type"]) => {
    const target = others.find((b) => /look|target|aim|gaze/i.test(b.name)) ?? others.find((b) => !b.deform) ?? others[0];
    if (target) edit(`Add ${type}`, (d) => void addConstraint(d, clip.id, bone.id, { type, target: { kind: "bone", bone: target.id } }));
  };
  return (
    <>
      {list.map((c) => {
        const kind = CONSTRAINT_KINDS.find((k) => k.type === c.type)!;
        const target = c.target.kind === "bone" ? c.target.bone : "∅point";
        return (
          <React.Fragment key={c.id}>
            <PropRow
              label={kind.label}
              hint={kind.hint}
              keyControl={
                <button type="button" className="text-muted-foreground hover:text-foreground [&_svg]:size-3" title={`Remove ${kind.label.toLowerCase()}`} onClick={() => edit("Remove constraint", (d) => void removeConstraints(d, clip.id, bone.id, [c.id]))}>
                  <X />
                </button>
              }
            >
              <Select value={target} onValueChange={(v) => edit("Constraint target", (d) => void updateConstraint(d, clip.id, bone.id, c.id, { target: { kind: "bone", bone: v } }))}>
                <SelectTrigger className="h-7 w-full text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {c.target.kind === "point" && (
                    <SelectItem value="∅point" className="text-[12px]">
                      A point ({Math.round(c.target.x)}, {Math.round(c.target.y)})
                    </SelectItem>
                  )}
                  {others.map((b) => (
                    <SelectItem key={b.id} value={b.id} className="text-[12px]">
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PropRow>
            <ValueField
              clip={clip}
              canKey
              layout="inspector"
              path={`bone.${bone.id}.con.${c.id}`}
              kind="number"
              label="Influence"
              base={c.influence}
              min={0}
              max={1}
              step={0.01}
              defaultValue={1}
              onChange={(v) => {
                if (typeof v !== "number") return;
                store.update("Constraint influence", (d) => {
                  const g = locateClip(d, clip.id)?.clip;
                  if (g) commitProperty(g, `bone.${bone.id}.con.${c.id}`, Math.max(0, Math.min(1, v)), useSession.getState().playheadMs);
                }, { mergeKey: `con-${c.id}` });
              }}
            />
            {c.type === "look" && (
              <PropRow label="Reach" hint="How far it slides from its keyed place. Empty: its pad limits alone.">
                <Pair>
                  <NumberInput value={c.radius ?? 0} min={0} precision={0} unit={c.radius === null ? "pad" : "px"} onChange={(v) => edit("Look reach", (d) => void updateConstraint(d, clip.id, bone.id, c.id, { radius: v > 0 ? v : null }))} />
                </Pair>
              </PropRow>
            )}
          </React.Fragment>
        );
      })}
      {others.length > 0 && (
        <PropRow label="Watch">
          <div className="flex gap-1">
            {CONSTRAINT_KINDS.map((k) => (
              <Button key={k.type} variant="ghost" size="sm" className="h-7 px-2 text-[12px]" title={k.hint} onClick={() => add(k.type)}>
                <Plus className="size-3" /> {k.label}
              </Button>
            ))}
          </div>
        </PropRow>
      )}
    </>
  );
}

/** A channel written as an inspector edit: inside the bone's limits, keyed where it is keyed or recording. */
function writeChannelValue(store: ReturnType<typeof useDocStore>, rigId: string, bone: Bone, path: string, ch: Parameters<typeof limitChannel>[1], v: KeyframeValue): void {
  if (typeof v !== "number") return;
  store.update(
    "Pose bone",
    (d) => {
      const g = locateClip(d, rigId)?.clip;
      if (g) commitProperty(g, path, ch === "ik" ? Math.max(0, Math.min(1, v)) : limitChannel(bone, ch, v), useSession.getState().playheadMs);
    },
    { mergeKey: `pose-${path}` },
  );
}

const LIMIT_CHANNELS: ReadonlyArray<{ ch: keyof BoneLimits; label: string; free: [number, number]; unit?: string }> = [
  { ch: "rotation", label: "Turn", free: [-90, 90], unit: "°" },
  { ch: "x", label: "Move X", free: [-50, 50] },
  { ch: "y", label: "Move Y", free: [-50, 50] },
  { ch: "scale", label: "Stretch", free: [0.5, 1.5] },
];

/** LIMITS: per channel, a range or free. Equal ends lock it (and the row above disappears). */
function LimitRows({ bone, planar, onSet }: { bone: Bone; planar: boolean; onSet: (l: { [K in keyof BoneLimits]?: [number, number] | null }) => void }) {
  void planar;
  return (
    <>
      {LIMIT_CHANNELS.map(({ ch, label, free, unit }) => {
        const r = bone.limits?.[ch];
        return (
          <PropRow
            key={ch}
            label={`${label}`}
            hint={`Hold ${label.toLowerCase()} between two values${ch === "rotation" ? " — a knee that never bends backwards" : ""}. Equal ends lock it.`}
            keyControl={
              r ? (
                <button type="button" className="text-muted-foreground hover:text-foreground [&_svg]:size-3" title="Free it" onClick={() => onSet({ [ch]: null })}>
                  <X />
                </button>
              ) : undefined
            }
          >
            {r ? (
              <Pair>
                <NumberInput value={r[0]} precision={ch === "scale" ? 2 : 0} unit={unit ?? "min"} onChange={(v) => onSet({ [ch]: [v, r[1]] })} />
                <NumberInput value={r[1]} precision={ch === "scale" ? 2 : 0} unit={unit ?? "max"} onChange={(v) => onSet({ [ch]: [r[0], v] })} />
              </Pair>
            ) : (
              <button
                type="button"
                className="flex h-7 w-full items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground [&_svg]:size-3"
                onClick={() => onSet({ [ch]: free })}
              >
                <Plus /> Free — limit it
              </button>
            )}
          </PropRow>
        );
      })}
    </>
  );
}

/** IK: which control this bone's tip reaches for, how many bones turn, which way it bends. */
function IkRows({ bone, others, onSet }: { bone: Bone; others: Bone[]; onSet: (ik: Parameters<typeof setBoneProps>[3]["ik"]) => void }) {
  const ik = bone.ik;
  return (
    <>
      <PropRow label="Reach" hint="Inverse kinematics: this bone's tip reaches for another bone's head (usually a control), turning the chain above it.">
        <Select value={ik?.target ?? "∅"} onValueChange={(v) => onSet(v === "∅" ? null : { target: v })}>
          <SelectTrigger className="h-7 w-full text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="∅" className="text-[12px]">Nothing — posed by its angles</SelectItem>
            {others.map((b) => (
              <SelectItem key={b.id} value={b.id} className="text-[12px]">
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PropRow>
      {ik && (
        <>
          <PropRow label="Chain" hint="How many bones turn to reach: 2 for an arm or a leg.">
            <Pair>
              <NumberInput value={ik.chain} min={1} max={16} precision={0} onChange={(v) => onSet({ chain: Math.max(1, Math.min(16, Math.round(v))) })} />
            </Pair>
          </PropRow>
          <PropRow label="Pole" hint="A bone the bend points toward — a knee at its control.">
            <Select value={ik.pole ?? "∅"} onValueChange={(v) => onSet({ pole: v === "∅" ? null : v })}>
              <SelectTrigger className="h-7 w-full text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="∅" className="text-[12px]">None — bends as drawn</SelectItem>
                {others.filter((b) => b.id !== ik.target).map((b) => (
                  <SelectItem key={b.id} value={b.id} className="text-[12px]">
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropRow>
          <PropRow toggle label="Bend the other way">
            <Switch checked={ik.flip} onCheckedChange={(v) => onSet({ flip: v })} />
          </PropRow>
        </>
      )}
    </>
  );
}

// ── A switch ────────────────────────────────────────────────────────────────

/**
 * `if(blink(4) > 0, "Shut", #value)` → its parts, so the panel can show and
 * edit it. A blink RIDES on the switch's own choice (`#value`), so Show keeps
 * working under it; the older form with a fixed open member still reads.
 */
const BLINK = /^if\(blink\(([\d.]+)\) > 0, "((?:[^"\\]|\\.)*)", (?:#value|"((?:[^"\\]|\\.)*)")\)$/;
const blinkSource = (every: number, shut: string) => `if(blink(${every}) > 0, ${JSON.stringify(shut)}, #value)`;

export function SwitchSection({ clip }: { clip: GroupClip }) {
  const store = useDocStore();
  const doc = useDoc();
  const options = switchOptions(doc, clip.id);
  const value = useEffectiveValue(clip, "switch", clip.switch?.show ?? "");
  const shown = options.find((c) => (typeof value === "number" ? options.indexOf(c) === Math.round(value) : c.name.trim().toLowerCase() === String(value).trim().toLowerCase())) ?? options[0];
  const token = clip.drivers?.switch;
  const expr = token ? expressionById(doc, parseFxToken(token) ?? "") : undefined;
  const blink = expr ? BLINK.exec(expr.source.trim()) : null;
  // Driven means "the picks do nothing" — not a blink that rides on them.
  const driven = !!token && !(expr && composesOverKeys(expr.source));

  const show = (id: string) =>
    store.update("Show", (d) => void setSwitch(d, clip.id, id, clipLocalClamped(clip, useSession.getState().playheadMs), { key: useSession.getState().recording }), { mergeKey: `switch-${clip.id}` });

  const setBlink = (on: boolean, every = 4, shut?: string) =>
    store.update(on ? "Blink" : "Stop blinking", (d) => {
      const g = locateClip(d, clip.id)?.clip;
      if (!g || g.kind !== "group") return;
      const drivers = { ...(g.drivers ?? {}) };
      if (!on) {
        delete drivers.switch;
      } else {
        // Shut: what was chosen, else a member named like it, else the last. Between blinks the
        // switch shows its own choice, so that must not BE the shut one.
        const closed = shut ?? blink?.[2] ?? options.find((c) => /clos|shut|blink/i.test(c.name))?.name ?? options[options.length - 1]?.name ?? "";
        const source = blinkSource(every, closed);
        if (shown?.name === closed) {
          const open = blink?.[3] ?? options.find((c) => c.name !== closed && /open/i.test(c.name))?.name ?? options.find((c) => c.name !== closed)?.name;
          if (open) setSwitch(d, clip.id, open, clipLocalClamped(clip, useSession.getState().playheadMs));
        }
        const current = parseFxToken(drivers.switch);
        if (current && expressionById(d, current)) setExpressionSource(d, current, source);
        else drivers.switch = fxToken(addExpression(d, source, `${g.name} · blink`).id);
      }
      g.drivers = Object.keys(drivers).length ? drivers : undefined;
    });

  return (
    <PanelSection
      id="switch"
      title="Switch"
      hint="One member shows at a time — an eye's states, a mouth's shapes. Pick one here or in the layers panel; with Record on it keys."
      actions={
        <Button variant="ghost" size="icon-sm" title="Stop switching — every member shows again" onClick={() => store.update("Remove switch", (d) => void unmakeSwitch(d, clip.id))}>
          <X />
        </Button>
      }
    >
      <PropRow label="Show" stack keyControl={<KeyControl clip={clip} property="switch" currentValue={() => shown?.name ?? ""} />}>
        <div className={cn("flex flex-wrap gap-1", driven && "pointer-events-none opacity-50")}>
          {options.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={c.id === shown?.id}
              className={cn(
                "h-7 max-w-full truncate rounded px-2 text-[12px] transition-colors",
                c.id === shown?.id ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "bg-input/35 text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              onClick={() => show(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      </PropRow>
      <PropRow toggle label="Blink" hint="Shut on its own at a living, uneven rhythm (the blink() expression). Off: keys and picks decide.">
        <Switch checked={!!blink} disabled={driven && !blink} onCheckedChange={(v) => setBlink(v)} />
      </PropRow>
      {blink && (
        <>
          <PropRow label="Every" hint="Seconds between blinks, on average.">
            <Range className="w-full" value={Number(blink[1])} min={1} max={10} step={0.5} precision={1} unit="s" defaultValue={4} aria-label="Blink every" onChange={(v) => setBlink(true, v)} />
          </PropRow>
          <PropRow label="Shut">
            <Select value={blink[2]} onValueChange={(v) => setBlink(true, Number(blink[1]), v)}>
              <SelectTrigger className="h-7 w-full text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((c) => (
                  <SelectItem key={c.id} value={c.name} className="text-[12px]">
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropRow>
        </>
      )}
      {driven && !blink && <Note>Driven by an expression — right-click Show to edit or detach it.</Note>}
    </PanelSection>
  );
}

// ── How a member follows ────────────────────────────────────────────────────

const MODES = [
  { id: "auto", label: "Auto — decided by the art", icon: <span className="text-[10px] font-medium">Auto</span> },
  { id: "smooth", label: "Bend — weights over several bones", icon: <span className="text-[10px] font-medium">Bend</span> },
  { id: "rigid", label: "Ride — one bone, whole and crisp", icon: <span className="text-[10px] font-medium">Ride</span> },
  { id: "none", label: "Ignore the bones", icon: <span className="text-[10px] font-medium">Off</span> },
] as const;

export function followsBones(doc: MotionDocument, clip: Clip): boolean {
  const m = memberOf(doc, clip.id);
  return !!m && m.unit.id === clip.id;
}

export function FollowsSection({ clip }: { clip: Clip }) {
  const store = useDocStore();
  const doc = useDoc();
  const painting = useRigUi((s) => s.paint?.clipId === clip.id);
  const playheadMs = useParkedPlayhead();
  const m = memberOf(doc, clip.id);
  if (!m || m.unit.id !== clip.id || clip.kind === "audio") return null;
  const rig = m.rig.rig!;
  const bind = clip.bind ?? bindSchema.parse({});
  const planar = rigIsPlanar(doc, m.rig);
  const now = (() => {
    if (!planar) return null;
    const pose = evaluateRig(bakeRig(m.rig, clipLocalClamped(m.rig, playheadMs)) ?? rig, { planar: true });
    const d = decide2d(doc, m, pose);
    if (d.kind === "none") return "Ignores the bones";
    if (d.kind === "rigid") return `Rides ${rig.bones.find((b) => b.id === d.bone)?.name ?? "a bone"}`;
    return "Bends with the bones";
  })();
  const set = (label: string, patch: { mode?: "auto" | "smooth" | "rigid" | "none"; bone?: string | null }) => store.update(label, (d) => void setBind(d, clip.id, patch));
  const painted = bind.paint.length;

  return (
    <PanelSection id="follows" title="Follows bones" hint={`In the rig "${m.rig.name}". Every piece follows its bones with no binding step; change how here.`} summary={now ?? undefined}>
      <PropRow label="How">
        <IconTrack value={bind.mode} items={MODES} onPick={(v) => set("Follow bones", { mode: v })} />
      </PropRow>
      {bind.mode === "rigid" && (
        <PropRow label="Bone">
          <Select value={bind.bone ?? "∅"} onValueChange={(v) => set("Ride bone", { bone: v === "∅" ? null : v })}>
            <SelectTrigger className="h-7 w-full text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="∅" className="text-[12px]">The one running most through it</SelectItem>
              {rig.bones.filter((b) => b.deform).map((b) => (
                <SelectItem key={b.id} value={b.id} className="text-[12px]">
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PropRow>
      )}
      {now && <Note>{now}{painted ? ` · ${painted} painted stroke${painted === 1 ? "" : "s"}` : ""}</Note>}
      {planar && clip.kind !== "group" && (
        <PropRow label="Weights">
          <Button
            variant={painting ? "default" : "secondary"}
            size="sm"
            className="h-7 w-full text-[12px]"
            title={painting ? "Stop painting (Esc)" : "Paint how much each bone pulls here — Esc or Done to finish"}
            onClick={() => {
              const ui = useRigUi.getState();
              if (painting) return ui.stopPaint();
              const picked = ui.rigId === m.rig.id ? ui.bones[ui.bones.length - 1] : undefined;
              const first = rig.bones.find((b) => b.deform)?.id;
              const bone = picked && rig.bones.some((b) => b.id === picked && b.deform) ? picked : first;
              if (bone) ui.startPaint(clip.id, bone);
            }}
          >
            {painting ? "Painting — stop" : "Paint weights"}
          </Button>
        </PropRow>
      )}
      {painted > 0 && (
        <PropRow label="Paint">
          <Button variant="ghost" size="sm" className="h-7 w-full justify-start px-2 text-[12px]" onClick={() => store.update("Clear weight paint", (d) => void clearWeightPaint(d, clip.id))}>
            Clear painted weights
          </Button>
        </PropRow>
      )}
    </PanelSection>
  );
}
