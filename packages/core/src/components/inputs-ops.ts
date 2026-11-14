import { createId } from "../ids";
import { createFrame } from "../factories";
import type { MotionDocument, Clip, Frame, GroupClip, InputDef, InputType, InputValue } from "../schema";
import { inputDefSchema, inputToken, parseInputToken } from "../schema/inputs";
import { getClipProperty, setClipProperty } from "../animation/paths";
import { clipAnimatableProperties } from "../animation/clip-properties";
import { locateClip } from "../timeline/ops";
import { componentSetId, mainVariant, variantsOf } from "../components";
import { switchFromVariants } from "../timeline/switch-ops";
import { coerceInputValue, inputDefault } from "./inputs";
import { inputPath } from "./inputs-fields";

/**
 * EDITING A COMP'S INPUTS — define, update, reorder, remove, expose a field,
 * and turn a component set's variants into one keyable Choice. All mutate a
 * draft (call inside an update); the app's panels and the agent verb
 * `component.inputs` are thin callers of exactly these.
 */

function frameOf(doc: MotionDocument, frameId: string): Frame {
  const f = doc.frames.find((x) => x.id === frameId);
  if (!f) throw new Error(`No comp "${frameId}".`);
  return f;
}

/** A name not yet taken in this comp's inputs ("Opacity", "Opacity 2", …). */
export function freeInputName(frame: Frame, wanted: string): string {
  const taken = new Set((frame.inputs ?? []).map((d) => d.name.trim().toLowerCase()));
  const base = wanted.trim() || "Input";
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

const FALLBACK_DEFAULT: Record<InputType, InputValue> = {
  number: 0,
  bool: false,
  enum: "",
  text: "",
  color: "#ffffff",
  trigger: false,
  layer: "",
};

export interface InputDraft {
  name?: string;
  type: InputType;
  default?: InputValue;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

/** Add an input to a comp. Returns its definition. */
export function defineInput(doc: MotionDocument, frameId: string, draft: InputDraft): InputDef {
  const frame = frameOf(doc, frameId);
  const options = draft.type === "enum" ? (draft.options?.length ? draft.options : ["A", "B"]) : undefined;
  const def = inputDefSchema.parse({
    id: createId("input"),
    name: freeInputName(frame, draft.name ?? "Input"),
    type: draft.type,
    default: draft.default ?? (options ? options[0] : FALLBACK_DEFAULT[draft.type]),
    min: draft.type === "number" ? draft.min : undefined,
    max: draft.type === "number" ? draft.max : undefined,
    step: draft.type === "number" ? draft.step : undefined,
    options,
  });
  def.default = inputDefault(def);
  (frame.inputs ??= []).push(def);
  return def;
}

/** Change an input's name, type, default, range or choices. Returns the result, or null. */
export function updateInput(doc: MotionDocument, frameId: string, inputId: string, patch: Partial<Omit<InputDef, "id">>): InputDef | null {
  const frame = frameOf(doc, frameId);
  const i = (frame.inputs ?? []).findIndex((d) => d.id === inputId);
  if (i < 0) return null;
  const prev = frame.inputs![i]!;
  const next: InputDef = { ...prev, ...patch, id: prev.id };
  if (patch.name !== undefined && patch.name.trim().toLowerCase() !== prev.name.trim().toLowerCase()) {
    next.name = freeInputName({ ...frame, inputs: frame.inputs!.filter((d) => d.id !== inputId) }, patch.name);
  }
  if (next.type !== "number") delete next.min, delete next.max, delete next.step;
  if (next.type !== "enum") delete next.options;
  else if (!next.options?.length) next.options = ["A", "B"];
  next.default = patch.default !== undefined || patch.type !== undefined || patch.options !== undefined ? coerceInputValue(next, next.default) : prev.default;
  if (next.type === "trigger") next.default = false;
  frame.inputs![i] = inputDefSchema.parse(next);
  return frame.inputs![i]!;
}

/** Move an input to `index` in its comp's list (the order the Inputs section shows). */
export function reorderInput(doc: MotionDocument, frameId: string, inputId: string, index: number): boolean {
  const list = frameOf(doc, frameId).inputs ?? [];
  const from = list.findIndex((d) => d.id === inputId);
  if (from < 0) return false;
  const [def] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, index)), 0, def!);
  return true;
}

/**
 * Delete an input and everything that pointed at it — cleanly:
 *  - every field bound to it (`input:<id>`) is unbound and KEEPS the value it
 *    showed on the master (the default), so nothing on the master jumps;
 *  - every instance drops its override, its keys and any driver on the channel;
 *  - linked instance frames drop their override.
 * Returns how many bindings were cut.
 */
export function removeInput(doc: MotionDocument, frameId: string, inputId: string): number {
  const frame = frameOf(doc, frameId);
  const def = frame.inputs?.find((d) => d.id === inputId);
  if (!def) return 0;
  frame.inputs = frame.inputs!.filter((d) => d.id !== inputId);
  if (frame.inputs.length === 0) delete frame.inputs;
  const path = inputPath(inputId);
  let cut = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId === frameId && clip.drivers) {
        for (const [p, token] of Object.entries(clip.drivers)) {
          if (parseInputToken(token) !== inputId) continue;
          delete clip.drivers[p];
          setClipProperty(clip, p, def.default);
          cut++;
        }
      }
      if (clip.kind === "nested" && clip.sourceFrameId === frameId) {
        if (clip.inputValues && inputId in clip.inputValues) {
          const { [inputId]: _gone, ...rest } = clip.inputValues;
          clip.inputValues = Object.keys(rest).length ? rest : undefined;
        }
        clip.keyframes = clip.keyframes.filter((t) => t.property !== path);
        if (clip.drivers?.[path]) delete clip.drivers[path];
      }
    }
  }
  for (const f of doc.frames) {
    if (f.instanceOf === frameId && f.inputValues && inputId in f.inputValues) delete f.inputValues[inputId];
  }
  return cut;
}

/** The fields bound to an input in its comp — `{clipId, path}` each. */
export function inputBindings(doc: MotionDocument, frameId: string, inputId: string): Array<{ clipId: string; path: string }> {
  const out: Array<{ clipId: string; path: string }> = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== frameId || !clip.drivers) continue;
      for (const [p, token] of Object.entries(clip.drivers)) if (parseInputToken(token) === inputId) out.push({ clipId: clip.id, path: p });
    }
  }
  return out;
}

/** The names a switch group's members answer to, top first. */
function switchMemberNames(doc: MotionDocument, group: GroupClip): string[] {
  const names: string[] = [];
  for (const t of doc.tracks) if (t.groupId === group.id) for (const c of t.clips) names.push(c.name);
  return names;
}

/**
 * EXPOSE AS INPUT (Figma's "create property"): make an input of the comp the
 * layer lives in, named from the field, typed from its value, defaulting to
 * what it shows now — and bind the field to it. A `switch` becomes a Choice of
 * its members. A field already bound to an input returns that input.
 */
export function exposeAsInput(
  doc: MotionDocument,
  clipId: string,
  path: string,
  opts: { name?: string } = {},
): { frameId: string; input: InputDef } {
  const loc = locateClip(doc, clipId);
  if (!loc) throw new Error(`No layer "${clipId}".`);
  const clip: Clip = loc.clip;
  const frame = frameOf(doc, clip.frameId);
  const bound = parseInputToken(clip.drivers?.[path]);
  const existing = bound ? frame.inputs?.find((d) => d.id === bound) : undefined;
  if (existing) return { frameId: frame.id, input: existing };
  const prop = clipAnimatableProperties(clip, doc).find((p) => p.path === path);
  if (!prop) throw new Error(`"${clip.name}" has no property "${path}".`);
  const value = getClipProperty(clip, path) ?? prop.def.identity;
  let draft: InputDraft;
  if (path === "switch" && clip.kind === "group") {
    const options = switchMemberNames(doc, clip);
    const current = typeof value === "number" ? options[value] : String(value);
    draft = { type: "enum", options, default: current ?? options[0] };
  } else if (prop.def.kind === "color") draft = { type: "color", default: String(value) };
  else if (typeof value === "number") draft = { type: "number", default: value, min: prop.def.min, max: prop.def.max, step: prop.def.step };
  else if (typeof value === "boolean") draft = { type: "bool", default: value };
  else if (typeof value === "string") draft = { type: "text", default: value };
  else throw new Error(`"${prop.def.label}" cannot be an input (it is not a number, colour, flag or text).`);
  const nameBase = opts.name ?? (prop.group && prop.group !== "Transform" && !prop.def.label.includes(prop.group) ? `${prop.def.label}` : prop.def.label);
  const input = defineInput(doc, frame.id, { ...draft, name: nameBase });
  (clip.drivers ??= {})[path] = inputToken(input.id);
  // A bound field's keys would fight the input (the driver owns the value).
  clip.keyframes = clip.keyframes.filter((t) => t.property !== path);
  return { frameId: frame.id, input };
}

/**
 * KEYABLE VARIANTS — a component set's variants as ONE comp with a `Variant`
 * Choice input: inside, a switch of one instance per variant (built by
 * `switchFromVariants`, the same brain as "Switch from variants"), its choice
 * bound to the input. Instance THIS comp and key `input.<id>`: a variant that
 * changes over time, without ever re-pointing an instance's `sourceFrameId`.
 * The new comp is a component of its own set, beside the original.
 */
export function keyableVariants(doc: MotionDocument, componentFrameId: string): { frameId: string; inputId: string; switchId: string } | null {
  const source = doc.frames.find((f) => f.id === componentFrameId);
  if (!source || !componentSetId(source)) return null;
  const setId = componentSetId(source)!;
  const main = mainVariant(doc, setId) ?? source;
  const variants = variantsOf(doc, source);
  const right = Math.max(...variants.map((v) => v.x + v.width));
  const frame = createFrame({ name: `${main.name} · Variants`, x: right + 120, y: main.y, width: main.width, height: main.height, pageId: main.pageId, overflow: 1 });
  frame.background = "#00000000";
  frame.loop = main.loop;
  frame.component = { description: "", setId: frame.id, variantName: "Main" };
  doc.frames.push(frame);
  const switchId = switchFromVariants(doc, frame.id, main.id, { name: "Variant", x: 0, y: 0 });
  if (!switchId) {
    doc.frames = doc.frames.filter((f) => f.id !== frame.id);
    return null;
  }
  const group = locateClip(doc, switchId)!.clip as GroupClip;
  const options = switchMemberNames(doc, group);
  const input = defineInput(doc, frame.id, { name: "Variant", type: "enum", options, default: options[0] });
  (group.drivers ??= {}).switch = inputToken(input.id);
  return { frameId: frame.id, inputId: input.id, switchId };
}
