import { z } from "zod";
import { keyframeValueSchema, type KeyframeValue } from "../../schema";
import { compFps, frameStepMs } from "../../timeline/fps";
import { recordTake, recordTriggerTake, TakeRefused, type TakeResult } from "../../perform/take";
import { ApiError, defineCommand } from "../command";
import { requireClip } from "../lookup";
import { assertPath } from "./edit";

/**
 * PERFORM — an agent ACTS a take the way a person does in Perform mode: hand
 * it the samples (or trigger presses) and it is written through the same
 * reducer and punch-in, one undo step.
 */

const sampleSchema = z.object({
  at: z.number(),
  value: z.union([keyframeValueSchema, z.array(keyframeValueSchema)]),
});

export const performTake = defineCommand({
  id: "perform.take",
  summary: "Record a performed take onto a layer's channels: timed samples (a drag) or trigger presses, reduced to clean keys over the take's range only.",
  details:
    "SAMPLES: `path` (one channel) or `paths` (sampled together — pass [\"x\",\"y\"] for a motion drag; each sample's `value` is then an array in that order). `at` is ms from the layer's start (clock: layer) or comp time (clock: comp), in the order performed; a time that jumps BACK is a loop wrap and starts a new pass. Keys land on the comp's frames; `tolerance` (channel units) is the most the played curve may stray from a sample; `smoothMs` steadies a shaky hand. Numbers get eased keys (the Smooth brain), discrete values (switch, pose.<set>, text) key where they change. Only the take's range is replaced; keys outside it are untouched. TRIGGERS: `mode` latch|touch + `events` [{at, kind: down|up, value}] on ONE discrete `path` — latch keys each press; touch returns to what showed before on release. A path a pose set owns is refused: perform `pose.<set>` on the character group.",
  effect: "write",
  input: z.object({
    id: z.string(),
    path: z.string().optional(),
    paths: z.array(z.string()).min(1).optional(),
    samples: z.array(sampleSchema).optional(),
    events: z.array(z.object({ at: z.number(), kind: z.enum(["down", "up"]), value: keyframeValueSchema })).optional(),
    mode: z.enum(["latch", "touch"]).default("latch"),
    clock: z.enum(["layer", "comp"]).default("layer"),
    tolerance: z.union([z.number().positive(), z.array(z.number().positive())]).optional(),
    smoothMs: z.number().min(0).max(500).default(0),
  }),
  run(input, rt) {
    const paths = input.paths ?? (input.path ? [input.path] : []);
    if (!paths.length) throw new ApiError("Name the channel: `path`, or `paths` for channels sampled together.");
    if (!input.samples?.length && !input.events?.length) throw new ApiError("Nothing performed: pass `samples` or trigger `events`.");
    let result: TakeResult | null = null;
    rt.write("Perform take", (d) => {
      const clip = requireClip(d, input.id).clip;
      for (const p of paths) assertPath(clip, p);
      const local = (at: number) => (input.clock === "comp" ? at - clip.startMs : at);
      const stepMs = frameStepMs(compFps(d, clip.frameId));
      try {
        if (input.events?.length) {
          if (paths.length !== 1) throw new ApiError("Triggers key one discrete channel — pass a single `path`.");
          result = recordTriggerTake(d, clip.id, paths[0]!, input.events.map((e) => ({ t: local(e.at), kind: e.kind, value: e.value })), input.mode, { stepMs });
        } else {
          const samples = input.samples!.map((s) => {
            const v: KeyframeValue[] = Array.isArray(s.value) && paths.length > 1 ? (s.value as KeyframeValue[]) : [s.value as KeyframeValue];
            if (v.length !== paths.length) throw new ApiError(`Each sample needs ${paths.length} values (one per path).`);
            return { t: local(s.at), v };
          });
          result = recordTake(d, clip.id, paths, samples, { tolerance: input.tolerance, smoothMs: input.smoothMs, stepMs });
        }
      } catch (err) {
        if (err instanceof TakeRefused) throw new ApiError(err.message);
        throw err;
      }
    });
    const r = result as TakeResult | null;
    return { keys: r?.keys ?? {}, passes: r?.runs ?? 0, span: r?.span ?? null };
  },
});

export const PERFORM_COMMANDS = [performTake];
