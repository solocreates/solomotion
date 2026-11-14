import { registerExprFunction } from "../expressions/functions";
import type { ExprValue } from "../expressions/types";

/**
 * `input("Mood")` — the value of one of this comp's INPUTS, as the instance
 * being drawn sets it (the master edited directly reads the default). Read on
 * the instance's outer clock: a keyed input changes when the PARENT says so,
 * however the comp inside loops. The host supplies the reader on the context
 * (`ExprContext.readInput`); without one, only ids resolve, from the scope.
 */
registerExprFunction({
  name: "input",
  category: "character",
  params: [{ name: "name", type: "string", describe: "The input’s name, as the Inputs section shows it." }],
  returns: null,
  describe: "One of this component’s inputs, as the instance on screen sets it — two instances of one character can wear two moods.",
  example: 'input("Mood") == "Happy"',
  call: (args, ctx): ExprValue => {
    const name = typeof args[0] === "string" ? args[0] : "";
    if (!name) return 0;
    const v = ctx.readInput ? ctx.readInput(name) : ctx.scope?.values[name];
    return v ?? 0;
  },
});
