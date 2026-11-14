import { registerExprFunction } from "../expressions/functions";

/**
 * `state("Mood")` and `stateTime("Mood")` — a STATE MACHINE as a value source.
 * The machine writes nothing; a pose set's channel (or any field) is driven by
 * the state it is in at the instant, read in the instance's scope on its
 * outer clock. The host supplies the reader (`ExprContext.readMachine`).
 */

const machineParam = { name: "machine", type: "string" as const, describe: "The machine’s name, as the board shows it." };
const layerParam = { name: "layer", type: "string" as const, describe: "Which of its layers (default: the first).", optional: true };

const layerArg = (v: unknown) => (typeof v === "string" && v ? v : undefined);

registerExprFunction({
  name: "state",
  category: "character",
  params: [machineParam, layerParam],
  returns: "string",
  describe: "The state a machine is in now — drive a pose set with it, or test it in if().",
  example: 'state("Mood")',
  call: (args, ctx) => {
    const name = typeof args[0] === "string" ? args[0] : "";
    return (name && ctx.readMachine?.(name, layerArg(args[1]))?.stateName) || "";
  },
});

/**
 * The state's pose OUTPUT — what a state says its part shows. Without it a
 * state's `output` was board decoration: `state()` returns the state's NAME,
 * so a hand set driven by it only worked when every state was named after a
 * pose. A pose set's channel driven by `statePose("Body")` shows the output
 * of whatever state the machine is in; a state with no pose output reads ""
 * (the set's first pose).
 */
registerExprFunction({
  name: "statePose",
  category: "character",
  params: [machineParam, layerParam],
  returns: "string",
  describe: "The pose the machine's current state outputs — drive a pose set with it so each state shows its pose.",
  example: 'statePose("Body")',
  call: (args, ctx) => {
    const name = typeof args[0] === "string" ? args[0] : "";
    const out = name ? ctx.readMachine?.(name, layerArg(args[1]))?.output : undefined;
    return out?.kind === "pose" ? out.pose : "";
  },
});

registerExprFunction({
  name: "stateTime",
  category: "character",
  params: [machineParam, layerParam],
  returns: "float",
  describe: "Seconds the machine has been in its current state.",
  example: 'min(stateTime("Mood") / 0.3, 1)',
  call: (args, ctx) => {
    const name = typeof args[0] === "string" ? args[0] : "";
    const r = name ? ctx.readMachine?.(name, layerArg(args[1])) : null;
    return r ? r.timeInStateMs / 1000 : 0;
  },
});
