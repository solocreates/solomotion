import type { MotionDocument, Clip, InputDef, KeyframeValue, NestedClip } from "../schema";
import type { AnimatablePropertyDef, PropertyKind } from "../animation/properties";

/**
 * INPUT CHANNELS AS PROPERTY PATHS — `input.<id>` on a nested clip, the family
 * the property registry, `paths.ts` and the instance enumerator each delegate
 * ONE call to (the `bone.<id>.<channel>` pattern in `rig/fields.ts`). So an
 * instance's inputs key, drive, modulate, wire into the node board and answer
 * `layer_set` with no code of their own anywhere else.
 *
 * The channel's BASE value is the instance's override (`clip.inputValues[id]`);
 * absent, the definition's default applies — which only a reader holding the
 * document can know, so the doc-free accessors here return `undefined` for an
 * input the instance never overrode, and `components/inputs.ts` fills in.
 */

export const INPUT_PATH = /^input\.([^.]+)$/;

export function inputPath(id: string): string {
  return `input.${id}`;
}

/** The input id a path names, or null. */
export function inputIdOfPath(path: string): string | null {
  const m = INPUT_PATH.exec(path);
  return m ? m[1]! : null;
}

/** Is this an input channel on an instance (a nested clip)? */
export function isInputPath(clip: Clip, path: string): boolean {
  return clip.kind === "nested" && path.startsWith("input.") && INPUT_PATH.test(path);
}

/** How an input of this type blends between keys: numbers and colours glide, the rest hold. */
export function inputPropertyKind(def: Pick<InputDef, "type">): PropertyKind {
  return def.type === "number" ? "number" : def.type === "color" ? "color" : "discrete";
}

/** The typed registry row for one input definition. */
export function inputDefPropertyDef(def: InputDef): AnimatablePropertyDef {
  return {
    key: inputPath(def.id),
    label: def.name || "Input",
    kind: inputPropertyKind(def),
    group: "inputs",
    identity: def.default,
    compose: "replace",
    appliesTo: ["nested"],
    min: def.type === "number" ? def.min : undefined,
    max: def.type === "number" ? def.max : undefined,
    step: def.type === "number" ? (def.step ?? 0.01) : undefined,
  };
}

/**
 * The doc-free registry row for an `input.<id>` path. Its kind is "number",
 * which lets the VALUE decide how a key blends (numbers lerp, colours blend,
 * text/flags hold) — the typed row comes from `inputDefPropertyDef` wherever
 * the document is in hand.
 */
export function inputPropertyDef(key: string): AnimatablePropertyDef | undefined {
  if (!INPUT_PATH.test(key)) return undefined;
  return { key, label: "Input", kind: "number", group: "inputs", identity: 0, compose: "replace", appliesTo: ["nested"] };
}

/** The instance's override for one input, or undefined (the default applies). */
export function getInputProperty(clip: Clip, path: string): KeyframeValue | undefined {
  if (clip.kind !== "nested") return undefined;
  const id = inputIdOfPath(path);
  return id ? clip.inputValues?.[id] : undefined;
}

/** Write an instance's override. Returns false when the path is not an input's. */
export function setInputProperty(clip: Clip, path: string, value: KeyframeValue): boolean {
  if (clip.kind !== "nested") return false;
  const id = inputIdOfPath(path);
  if (!id) return false;
  if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") return true;
  (clip as NestedClip).inputValues = { ...(clip as NestedClip).inputValues, [id]: value };
  return true;
}

/** The definitions an instance clip answers to — its source comp's inputs. */
export function instanceInputDefs(doc: MotionDocument, clip: Clip): readonly InputDef[] {
  if (clip.kind !== "nested") return [];
  return doc.frames.find((f) => f.id === clip.sourceFrameId)?.inputs ?? [];
}

/**
 * Every input channel this clip exposes. With the document: one per input its
 * source comp defines, typed. Without: one per override the clip carries — so
 * a doc-free caller still sees (and validates) the channels in use.
 */
export function inputClipPaths(clip: Clip, doc?: MotionDocument): Array<{ path: string; def: AnimatablePropertyDef }> {
  if (clip.kind !== "nested") return [];
  if (doc) return instanceInputDefs(doc, clip).map((d) => ({ path: inputPath(d.id), def: inputDefPropertyDef(d) }));
  return Object.keys(clip.inputValues ?? {}).map((id) => ({ path: inputPath(id), def: inputPropertyDef(inputPath(id))! }));
}
