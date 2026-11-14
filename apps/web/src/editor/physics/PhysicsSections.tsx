"use client";

import * as React from "react";
import {
  createId,
  rigPieceOf,
  jointSchema,
  locateClip,
  physicsSchema,
  simulationSchema,
  type MotionDocument,
  type Clip,
  type Frame,
  type JointSpec,
  type PhysicsSpec,
  type SimulationSpec,
  type VisualClip,
  type PickFilter,
} from "@solomotion/core";
import { LayerRefField } from "../pick/ObjectField";
import { Link2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Range } from "@/components/ui/range";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { IconTrack, Note, Pair, PanelSection, PropRow, Trio } from "../inspector/controls";

/**
 * THE PHYSICS TAB — a body, its joints, its forces, and the comp's simulation,
 * for a flat comp and a world alike (docs/adr/ADR-physics.md). Rows adapt to
 * the dimension: a flat comp's push is X/Y and its spin one number; a world's
 * are three. Body settings are what the simulation STARTS from (it is exact
 * per frame and re-runs when they change). Forces are their own stack
 * (`ForceStack.tsx`, the effect stack with a force host).
 */

const isWorldClip = (doc: MotionDocument, c: Clip) => !!doc.frames.find((f) => f.id === c.frameId)?.world;

const TYPES = [
  { id: "off", label: "Off — not simulated", icon: <span className="text-[10px] font-medium">Off</span> },
  { id: "active", label: "Falls — collides and tumbles", icon: <span className="text-[10px] font-medium">Falls</span> },
  { id: "passive", label: "Fixed — a collider others land on", icon: <span className="text-[10px] font-medium">Fixed</span> },
  { id: "animated", label: "Keys — moves by its own keys and pushes", icon: <span className="text-[10px] font-medium">Keys</span> },
] as const;

const SHAPES = [
  { id: "auto", label: "Auto — read from the layer: a box, a circle, its outline, or a drawn line's edge", icon: <span className="text-[10px] font-medium">Auto</span> },
  { id: "box", label: "Box", icon: <span className="text-[10px] font-medium">Box</span> },
  { id: "sphere", label: "Circle / ball", icon: <span className="text-[10px] font-medium">Ball</span> },
  { id: "hull", label: "Hull — the outline without its dents (fastest)", icon: <span className="text-[10px] font-medium">Hull</span> },
  { id: "outline", label: "Outline — exact, cut into convex pieces", icon: <span className="text-[10px] font-medium">Exact</span> },
  { id: "edge", label: "Edge — the line is a wall; things bounce inside it", icon: <span className="text-[10px] font-medium">Edge</span> },
] as const;

// ── Body ─────────────────────────────────────────────────────────────────────

export function BodySection({ clips }: { clips: VisualClip[] }) {
  const store = useDocStore();
  const doc = useDoc();
  const first = clips[0]!;
  const p = first.physics;
  const world = isWorldClip(doc, first);
  const mixed = clips.some((c) => (c.physics?.type ?? "off") !== (p?.type ?? "off"));
  const edit = (label: string, fn: (c: VisualClip) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        for (const c of clips) {
          const x = locateClip(d, c.id)?.clip;
          if (x && x.kind !== "audio") fn(x as VisualClip);
        }
      },
      mergeKey ? { mergeKey } : undefined,
    );
  const set = (label: string, patch: Partial<PhysicsSpec>, mergeKey?: string) =>
    edit(label, (c) => void (c.physics = physicsSchema.parse({ ...(c.physics ?? {}), ...patch })), mergeKey);
  // In a rig a body acts through the bones: say which, so the panel matches what the canvas does.
  const piece = clips.length === 1 ? rigPieceOf(doc, first.id) : null;
  const summary = p
    ? p.type === "active"
      ? piece
        ? piece.bone
          ? `Swings on ${piece.bone.name}`
          : `${piece.rig.name} falls`
        : "Falls"
      : p.type === "passive"
        ? piece?.bone
          ? `Rides ${piece.bone.name}`
          : "Fixed"
        : "Keys"
    : undefined;

  return (
    <PanelSection
      id="physics-body"
      title="Body"
      summary={summary}
      hint="A rigid body: it starts where it is when physics starts (or when its clip does), moving the way its keys were moving, and collides on its real outline. In a rig it acts through its bone: it swings from the joint."
    >
      <PropRow label="Body">
        <IconTrack
          value={mixed ? undefined : (p?.type ?? "off")}
          items={TYPES}
          onPick={(v) => (v === "off" ? edit("No physics", (c) => void (c.physics = undefined)) : set(v === "active" ? "Make it fall" : v === "passive" ? "Make it a collider" : "Make it push", { type: v }))}
        />
      </PropRow>
      {p && (
        <>
          <PropRow label="Shape" hint="What it collides as. Auto reads the layer: a rectangle or a picture is a box, a circle a circle, a star, a path or a word its real outline.">
            <IconTrack value={p.shape} items={SHAPES} onPick={(v) => set("Collision shape", { shape: v })} />
          </PropRow>
          {p.type === "active" && (
            <PropRow label="Mass" hint="Heavier bodies push lighter ones aside.">
              <Range className="w-full" value={p.mass} min={0.05} max={50} scale="log" step={0.05} precision={2} unit="kg" defaultValue={1} aria-label="Mass" onChange={(v) => set("Mass", { mass: Math.max(0.01, v) }, "phys-mass")} />
            </PropRow>
          )}
          <PropRow label="Bounce">
            <Range className="w-full" value={p.bounce} min={0} max={1} step={0.01} precision={2} defaultValue={0.3} aria-label="Bounce" onChange={(v) => set("Bounce", { bounce: v }, "phys-bounce")} />
          </PropRow>
          <PropRow label="Friction">
            <Range className="w-full" value={p.friction} min={0} max={1} step={0.01} precision={2} defaultValue={0.5} aria-label="Friction" onChange={(v) => set("Friction", { friction: v }, "phys-friction")} />
          </PropRow>
          {p.type === "active" && (
            <>
              <PropRow label="Follow" hint={piece?.bone ? "How hard it pulls back to its bone's animated angle. 0 hangs limp; a little is jiggle; 1 is stiff." : "How hard it pulls back to where its keys put it. 0 is free; a little is jiggle; 1 is stiff."}>
                <Range className="w-full" value={p.follow} min={0} max={1} step={0.01} precision={2} defaultValue={0} aria-label="Follow" onChange={(v) => set("Follow", { follow: v }, "phys-follow")} />
              </PropRow>
              <PropRow label="Air" hint="Air resistance: how much of its motion it loses each second.">
                <Range className="w-full" value={p.damping} min={0} max={1} step={0.01} precision={2} defaultValue={0.01} aria-label="Air resistance" onChange={(v) => set("Air resistance", { damping: v }, "phys-air")} />
              </PropRow>
              <PropRow label="Push" hint={world ? "Start velocity, units per second" : "Start velocity, px per second (+Y is down)"}>
                {world ? (
                  <Trio>
                    {[0, 1, 2].map((i) => (
                      <NumberInput key={i} label={"XYZ"[i]} value={p.velocity[i]!} precision={0} onChange={(v) => set("Push", { velocity: with3(p.velocity, i, v) }, "phys-vel")} />
                    ))}
                  </Trio>
                ) : (
                  <Pair>
                    {[0, 1].map((i) => (
                      <NumberInput key={i} label={"XY"[i]} value={p.velocity[i]!} precision={0} onChange={(v) => set("Push", { velocity: with3(p.velocity, i, v) }, "phys-vel")} />
                    ))}
                  </Pair>
                )}
              </PropRow>
              <PropRow label="Spin" hint={world ? "Start spin about X, Y and Z, degrees per second" : "Start spin, degrees per second (+ turns clockwise)"}>
                {world ? (
                  <Trio>
                    {[0, 1, 2].map((i) => (
                      <NumberInput key={i} label={"XYZ"[i]} value={p.spin[i]!} precision={0} unit="°/s" onChange={(v) => set("Spin", { spin: with3(p.spin, i, v) }, "phys-spin")} />
                    ))}
                  </Trio>
                ) : (
                  <Pair>
                    <NumberInput value={p.spin[2]!} precision={0} unit="°/s" onChange={(v) => set("Spin", { spin: with3(p.spin, 2, v) }, "phys-spin")} />
                  </Pair>
                )}
              </PropRow>
            </>
          )}
        </>
      )}
    </PanelSection>
  );
}

const with3 = (v: readonly [number, number, number], i: number, x: number): [number, number, number] => {
  const out = [...v] as [number, number, number];
  out[i] = x;
  return out;
};

// ── Joints ───────────────────────────────────────────────────────────────────

const JOINT_LABEL: Record<JointSpec["type"], string> = { pin: "Pin", weld: "Weld", rope: "Rope", spring: "Spring" };

export function JointsSection({ clip }: { clip: VisualClip }) {
  const store = useDocStore();
  const doc = useDoc();
  if (!clip.physics) return null;
  const joints = clip.joints ?? [];
  const bodies = doc.tracks.flatMap((t) => t.clips).filter((c): c is VisualClip => c.id !== clip.id && c.frameId === clip.frameId && c.kind !== "audio" && !!(c as VisualClip).physics);
  const otherBodies: PickFilter = { kinds: ["layer"], frameId: clip.frameId, tags: ["body"], exclude: [clip.id] };
  const write = (label: string, fn: (js: JointSpec[]) => JointSpec[], mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        const c = locateClip(d, clip.id)?.clip as VisualClip | undefined;
        if (!c) return;
        const next = fn([...(c.joints ?? [])]);
        c.joints = next.length ? next : undefined;
      },
      mergeKey ? { mergeKey } : undefined,
    );
  const add = (type: JointSpec["type"], target: string | null) =>
    write(`Add ${JOINT_LABEL[type].toLowerCase()}`, (js) => [...js, jointSchema.parse({ id: createId("jnt"), type, target, anchor: [0, 0, 0] })]);
  const patch = (id: string, p: Partial<JointSpec>, mergeKey?: string) => write("Joint", (js) => js.map((j) => (j.id === id ? jointSchema.parse({ ...j, ...p }) : j)), mergeKey);

  return (
    <PanelSection
      id="physics-joints"
      title="Joints"
      count={joints.length || undefined}
      hint="Hold this body to another, or to a point in the comp: a pin turns freely (a pendulum, a hinge), a weld makes one piece, a rope stays within its length, a spring pulls back and bounces."
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="Add a joint">
              <Plus />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">To the comp</DropdownMenuLabel>
            <DropdownMenuItem className="text-[12px]" onSelect={() => add("pin", null)}>
              Pin in place — swings from here
            </DropdownMenuItem>
            <DropdownMenuItem className="text-[12px]" onSelect={() => add("spring", null)}>
              Spring to here — bobs back
            </DropdownMenuItem>
            {bodies.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[11px] text-muted-foreground">To another body</DropdownMenuLabel>
                {bodies.slice(0, 12).map((b) =>
                  (["pin", "spring", "rope", "weld"] as const).map((t) => (
                    <DropdownMenuItem key={`${b.id}${t}`} className="text-[12px]" onSelect={() => add(t, b.id)}>
                      {JOINT_LABEL[t]} to {b.name}
                    </DropdownMenuItem>
                  )),
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {joints.length === 0 && <Note>None — + to pin it, hang it on a spring, or join it to another body.</Note>}
      {joints.map((j) => (
        <div key={j.id} className="flex flex-col gap-1 rounded-md border border-border/60 p-1.5">
          <div className="flex h-6 items-center gap-1.5 text-[12px]">
            <Link2 className="size-3 text-muted-foreground" />
            <span className="font-medium">{JOINT_LABEL[j.type]}</span>
            <span className="text-muted-foreground">to</span>
            <LayerRefField
              size="sm"
              className="min-w-0 flex-1"
              filter={otherBodies}
              noun="body"
              none="The comp"
              value={j.target}
              onChange={(target) => patch(j.id, { target })}
            />
            <Switch checked={j.enabled} onCheckedChange={(v) => patch(j.id, { enabled: v })} aria-label="Joint on" />
            <button type="button" className="text-muted-foreground hover:text-foreground [&_svg]:size-3" title="Remove" onClick={() => write("Remove joint", (js) => js.filter((x) => x.id !== j.id))}>
              <X />
            </button>
          </div>
          <PropRow label="Anchor" hint="Where on this body, in its own space (px from its origin).">
            <Pair>
              <NumberInput label="X" value={j.anchor[0]} precision={0} onChange={(v) => patch(j.id, { anchor: with3(j.anchor, 0, v) }, `jx-${j.id}`)} />
              <NumberInput label="Y" value={j.anchor[1]} precision={0} onChange={(v) => patch(j.id, { anchor: with3(j.anchor, 1, v) }, `jy-${j.id}`)} />
            </Pair>
          </PropRow>
          {(j.type === "rope" || j.type === "spring") && (
            <PropRow label="Length" hint="Blank = their distance at the start.">
              <Pair>
                <NumberInput value={j.length ?? 0} min={0} precision={0} unit="px" onChange={(v) => patch(j.id, { length: v > 0 ? v : null }, `jl-${j.id}`)} />
              </Pair>
            </PropRow>
          )}
          {j.type === "spring" && (
            <>
              <PropRow label="Stiff">
                <Range className="w-full" value={j.stiffness} min={1} max={400} scale="log" step={1} precision={0} defaultValue={40} aria-label="Stiffness" onChange={(v) => patch(j.id, { stiffness: v }, `js-${j.id}`)} />
              </PropRow>
              <PropRow label="Settle" hint="How quickly it stops bouncing.">
                <Range className="w-full" value={j.damping} min={0} max={20} step={0.1} precision={1} defaultValue={2} aria-label="Damping" onChange={(v) => patch(j.id, { damping: v }, `jd-${j.id}`)} />
              </PropRow>
            </>
          )}
        </div>
      ))}
    </PanelSection>
  );
}

// ── The comp's simulation ───────────────────────────────────────────────────

export function SimulationSection({ frame }: { frame: Frame }) {
  const store = useDocStore();
  const doc = useDoc();
  const s = simulationSchema.parse(frame.physics ?? {});
  const world = !!frame.world;
  const set = (label: string, patch: Partial<SimulationSpec>, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        const f = d.frames.find((x) => x.id === frame.id);
        if (f) f.physics = simulationSchema.parse({ ...(f.physics ?? {}), ...patch });
      },
      mergeKey ? { mergeKey } : undefined,
    );
  const clips = doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === frame.id && c.kind !== "audio") as VisualClip[];
  const bodies = clips.filter((c) => c.physics).length, forces = clips.reduce((n, c) => n + (c.forces?.length ?? 0), 0);
  const emitters = clips.reduce((n, c) => n + (c.emitters?.length ?? 0), 0);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  // What simulates here, zeros left out: "2 bodies · 1 emitter".
  const counts = [bodies && plural(bodies, "body", "bodies"), forces && plural(forces, "force", "forces"), emitters && plural(emitters, "emitter", "emitters")].filter(Boolean).join(" · ");
  return (
    <PanelSection
      id="physics-sim"
      title="Simulation"
      summary={counts || undefined}
      hint="This comp's physics: where down is and how hard, when it starts, what is solid. Exact per frame — it re-runs only when what it starts from changes."
    >
      <PropRow label="Gravity" hint={`Downward pull, ${world ? "cm" : "px"}/s² (981 is Earth). 0 floats.`}>
        <Range className="w-full" value={s.gravity} min={0} max={4000} step={1} precision={0} unit={world ? "cm/s²" : "px/s²"} defaultValue={981} aria-label="Gravity" onChange={(v) => set("Gravity", { gravity: v }, "sim-g")} />
      </PropRow>
      <PropRow label="Starts" hint="Before this, bodies are where their keys put them; from here, physics takes over.">
        <Pair>
          <NumberInput value={s.startMs / 1000} min={0} step={0.1} precision={2} unit="s" onChange={(v) => set("Physics start", { startMs: Math.max(0, v * 1000) }, "sim-start")} />
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" title="Start at the playhead" onClick={() => set("Physics start", { startMs: Math.max(0, useSession.getState().playheadMs) })}>
            At playhead
          </Button>
        </Pair>
      </PropRow>
      <PropRow toggle label={world ? "Ground" : "Floor"} hint={world ? "A ground plane bodies land on." : "The comp's bottom edge is solid."}>
        <Switch checked={s.floor} onCheckedChange={(v) => set(v ? "Floor" : "No floor", { floor: v })} />
      </PropRow>
      {!world && (
        <PropRow toggle label="Walls" hint="The comp's left, right and top edges are solid too — nothing leaves the frame.">
          <Switch checked={s.walls} onCheckedChange={(v) => set(v ? "Walls" : "No walls", { walls: v })} />
        </PropRow>
      )}
      <PropRow label="Speed" hint="Slow motion below 1.">
        <Range className="w-full" value={s.timeScale} min={0.05} max={4} scale="log" step={0.01} precision={2} unit="×" defaultValue={1} aria-label="Simulation speed" onChange={(v) => set("Simulation speed", { timeScale: v }, "sim-speed")} />
      </PropRow>
      <PropRow toggle label="Guard" hint="Fast small bodies never slip through a wall: the simulation takes finer steps when something moves that fast. On for new comps; comps made before it keep their exact motion until you turn it on.">
        <Switch checked={s.guard} onCheckedChange={(v) => set(v ? "Guard" : "No guard", { guard: v })} />
      </PropRow>
      {counts && <Note>{counts}</Note>}
    </PanelSection>
  );
}
