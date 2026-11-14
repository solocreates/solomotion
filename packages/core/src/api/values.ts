import { z } from "zod";
import { easingSchema, type Easing } from "../schema";
import { EASING_PRESET_POINTS } from "../easing";
import { ApiError } from "./command";

/**
 * Value shorthands an API caller may use wherever the document wants the long
 * form — so an agent writes `"ease-out-expo"` instead of an object, and the
 * document still only ever stores one shape.
 */

/** `"linear"`, `"hold"`, a preset name, `"cubic-bezier(a,b,c,d)"`, or the stored object. */
export const easingInputSchema = z
  .union([z.string(), easingSchema])
  .describe(`"linear" | "hold" | ${Object.keys(EASING_PRESET_POINTS).map((n) => JSON.stringify(n)).join(" | ")} | "cubic-bezier(x1,y1,x2,y2)"`);

export function parseEasing(input: z.infer<typeof easingInputSchema> | undefined): Easing | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") return input;
  const s = input.trim();
  if (s === "linear") return { kind: "linear" };
  if (s === "hold") return { kind: "hold" };
  if (s in EASING_PRESET_POINTS) return { kind: "preset", name: s as keyof typeof EASING_PRESET_POINTS };
  const m = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(s);
  if (m) return { kind: "bezier", values: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] };
  throw new ApiError(
    `Unknown easing "${input}".`,
    `Use "linear", "hold", one of ${Object.keys(EASING_PRESET_POINTS).join(", ")}, or "cubic-bezier(x1,y1,x2,y2)".`,
  );
}
