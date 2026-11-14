import type { ClipProperty } from "../animation/clip-properties";
import type { Clip, Expression, NodeGraph, NodeValue, Variable } from "../schema";
import { parseFxToken } from "../schema/expressions";
import { parseDriverToken } from "../schema/nodes";
import { parseVarToken } from "../schema/variables";
import { parseInputToken } from "../schema/inputs";
import { resolveFxToken, type VariableSampler } from "../expressions/scope";
import { evaluateDriver } from "./eval";
import type { EvalContext, NodeRegistry } from "./registry";

/**
 * DRIVER RESOLUTION — the bridge from a stored token on a property to a concrete
 * value at a time. One funnel for every authoring path there is: a written
 * expression (`fx:`), a document variable (`var:`), an Output-node expression
 * and an Object-node sink socket (`expr:`), built on the token grammars in
 * `schema/*` and the sink-aware `evaluateDriver`.
 *
 * Its only caller is `resolveClipDrivers`, which BAKES the answer into the
 * clip's own slot. Nothing overlays a driver onto a sampled map any more: that
 * design made a driven value visible only to code that happened to read that
 * particular map, which is how a shape came to move while its own handles,
 * hit rectangle and inspector field stayed behind.
 *
 * Reading another layer: the bake injects a `readProperty` that answers a
 * driven field with its DRIVEN value, evaluated on demand and once per bake
 * (`evaluate/resolved-doc.ts`), so `layer("Count").x` is where Count is. A
 * cycle (A reads B reads A) is cut where it closes: that read gets the field's
 * keys or base. Hosts without a bake (a board preview) read keys and base.
 */

export interface DriverEnv {
  /** All graphs in the document — `expr:<id>` tokens resolve against these. */
  graphs: NodeGraph[];
  registry: NodeRegistry;
  fps: number;
  /** Sample any clip's property at a time (driven in a bake — see note above). */
  readProperty: (clipId: string, propertyKey: string, timeMs: number) => number | string | boolean | undefined;
  /**
   * The bake's memoised driver results: one driven field of one clip, at the
   * env's instant, resolved at most once however many readers ask. Omitted =
   * each field resolves where it is baked.
   */
  driven?: (clip: Clip, path: string) => NodeValue | undefined;
  /** Live property projection for Object-node sink sockets. */
  describeClip: (targetId: string) => ClipProperty[];
  /** Read a document variable (keyframe-aware) for the Variables node; optional. */
  readVariable?: (id: string) => number | string | boolean | { x: number; y: number } | undefined;
  /**
   * The expression table + the variables it may name, so an `fx:<id>` driver
   * resolves here alongside `expr:<id>` graph drivers. Carried the same way
   * `graphs` is, and for the same reason: a driver token has to become a value
   * without this module ever holding the document. Omitted = expression drivers
   * fall through to the keyframed value.
   */
  expressions?: { table: Expression[]; variables: Variable[]; sample: VariableSampler };
  /**
   * Run one clip's driver resolution inside whatever AMBIENT scope the host
   * needs — in practice `#layer.*`, which only means something while a
   * particular layer is the subject.
   *
   * Injected rather than threaded because the scope belongs to the host: core
   * cannot know that a layer's facts are set by `withExpressionLayer`, and the
   * renderer cannot pass a parameter through a pipeline that never had one.
   * Omitted = resolve against whatever context is already ambient, which is what
   * every non-visual caller wants.
   */
  scopeClip?: <T>(clip: Clip, fn: () => T) => T;
  /**
   * Read an input of the comp being baked, in the instance scope the bake is
   * for (`components/inputs.ts` `readInput`). Omitted = `input:` drivers fall
   * through to the stored value.
   */
  readInput?: (id: string) => NodeValue | undefined;
  /** Where a media layer is in its recording at this env's clock — the Sound node's ears (`EvalContext.mediaAt`). */
  mediaAt?: EvalContext["mediaAt"];
  /** A tracker's reading at this env's clock — the Track node's eyes (`EvalContext.trackAt`). */
  trackAt?: EvalContext["trackAt"];
}

/** Resolve one driver token to a value at `timeMs`, or undefined to fall back. */
export function resolveDriver(token: string, timeMs: number, env: DriverEnv): NodeValue | undefined {
  // Two driver flavours, one funnel. An `fx:` token is a written expression, an
  // `expr:` token is a graph — the property sampler above neither knows nor
  // cares which, which is exactly what makes them interchangeable on any field.
  //
  // Note the deliberate asymmetry: an expression reads the AMBIENT context the
  // renderer set for this draw, not the `timeMs` passed here. That argument is
  // clip-LOCAL, and `#time` means composition time by definition — clip-local
  // time is `#layer.time`, derived from the layer's own start. One clock, two
  // named views of it, rather than a third that silently disagrees.
  if (parseFxToken(token)) {
    const fx = env.expressions;
    if (!fx) return undefined;
    return resolveFxToken(token, fx.table, fx.variables, fx.sample, null);
  }
  // A plain `var:` reference is the third flavour. A property path can name a
  // document variable directly — no graph, no expression, just "this field IS
  // that value" — which is what makes "read from a variable" available on every
  // animatable property and not only on the handful of slots whose own schema
  // was widened to hold a token.
  const variableId = parseVarToken(token);
  if (variableId) {
    // Through the PARSER, never a raw slice: a colour slot's token may carry a
    // trailing `/<alpha>`, and slicing the prefix off by hand looked the id up
    // under a name no variable has.
    return env.readVariable?.(variableId);
  }

  // `input:<id>` — the fourth flavour: "this field IS that input", valued by
  // whichever instance the comp is being drawn through.
  const inputId = parseInputToken(token);
  if (inputId) return env.readInput?.(inputId);

  const parsed = parseDriverToken(token);
  if (!parsed) return undefined;
  const graph = env.graphs.find((g) => g.id === parsed.graphId);
  if (!graph) return undefined;
  return evaluateDriver(
    graph,
    env.registry,
    {
      timeMs,
      fps: env.fps,
      readProperty: env.readProperty,
      describeClip: env.describeClip,
      readVariable: env.readVariable,
      mediaAt: env.mediaAt,
      trackAt: env.trackAt,
      // So an Expression node on the board runs the same language a field does.
      expressions: env.expressions
        ? { variables: env.expressions.variables, sample: env.expressions.sample }
        : undefined,
    },
    parsed.sink,
  );
}
