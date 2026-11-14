import { MACHINE_ANY, MACHINE_EXIT, type MotionDocument, type Frame, type Machine, type MachineCondition, type MachineOutput, type PoseSet } from "../schema";
import { findInputDef } from "../components/inputs";

/**
 * A MACHINE AS CODE — the printer the reify bridge registers for machines, and
 * what the board's Code tab shows. The code is ONE `machine.create` call with
 * the whole machine by name; running it replaces the machine of that name and
 * keeps the ids and places of states that keep their names — so running it IS
 * editing it (the round-trip law: run(print(m)) ≅ m).
 *
 * MERGE POINT (reify): `registerReifier({ kind: "machine", print })` lands in
 * `scripts/reify.ts`; until then the board calls `machineCode` directly.
 */

/** The pose sets on the groups of a comp — what a machine state can show. */
export function framePoseSets(doc: MotionDocument, frameId: string): PoseSet[] {
  return doc.tracks.flatMap((t) => t.clips.flatMap((c) => (c.kind === "group" && c.frameId === frameId ? (c.poses ?? []) : [])));
}

/** A state's pose set by id, else by name (any case) — how code and agents name it. */
export function poseSetRef(doc: MotionDocument, frameId: string, ref: string): PoseSet | null {
  const sets = framePoseSets(doc, frameId);
  const want = ref.trim().toLowerCase();
  return sets.find((s) => s.id === ref) ?? sets.find((s) => s.name.trim().toLowerCase() === want) ?? null;
}

/** The `machine.create` input that rebuilds `machine` — names, not ids. With
 *  `doc`, a pose output names its set when that name is unique in the comp. */
export function machineSpec(frame: Frame, machine: Machine, doc?: MotionDocument) {
  const sets = doc ? framePoseSets(doc, frame.id) : [];
  const outputOf = (o: MachineOutput): MachineOutput => {
    if (o.kind !== "pose") return o;
    const set = sets.find((s) => s.id === o.set);
    const unique = set && sets.filter((s) => s.name.trim().toLowerCase() === set.name.trim().toLowerCase()).length === 1;
    return unique ? { ...o, set: set.name } : o;
  };
  const inputName = (ref: string) => findInputDef(frame.inputs ?? [], ref)?.name ?? ref;
  const named = (c: MachineCondition): MachineCondition => (c.kind === "input" || c.kind === "trigger" ? { ...c, input: inputName(c.input) } : c);
  return {
    frameId: frame.id,
    name: machine.name,
    layers: machine.layers.map((l) => {
      const nameOf = (id: string) => (id === MACHINE_ANY ? "any" : id === MACHINE_EXIT ? "exit" : (l.states.find((s) => s.id === id)?.name ?? id));
      return {
        name: l.name,
        ...(l.entry && l.entry !== l.states[0]?.id ? { entry: nameOf(l.entry) } : {}),
        states: l.states.map((s) => ({ name: s.name, x: Math.round(s.x), y: Math.round(s.y), ...(s.output.kind !== "none" ? { output: outputOf(s.output) } : {}) })),
        transitions: l.transitions.map((t) => ({
          from: nameOf(t.from),
          to: nameOf(t.to),
          when: t.conditions.map(named),
          ...(t.durationMs ? { durationMs: t.durationMs } : {}),
          ...(t.exitTime !== undefined ? { exitTime: t.exitTime } : {}),
        })),
      };
    }),
  };
}

/** The script that rebuilds `machine` in `frame`. */
export function machineCode(frame: Frame, machine: Machine, doc?: MotionDocument): string {
  return `// ${machine.name} — state machine of "${frame.name}". Run to rebuild it; the same name replaces it.\nawait ac.machine.create(${JSON.stringify(machineSpec(frame, machine, doc), null, 2)});\n`;
}
