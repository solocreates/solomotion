import { CAPTION_STATES } from "../schema/clips";
import { createId } from "../ids";
import { formatHexColor, parseHexColor, propertyDef } from "../animation/properties";
import { sampleKeyframes } from "../animation/keyframes";
import { applyModulators } from "../animation/modulators";
import { paintProperty, setPaintProperty } from "../animation/paint";
import type {
  MotionDocument,
  Clip,
  KeyframeValue,
  Paint,
  SolidPaint,
  TextStyle,
  Variable,
  VariableFolder,
  VariableType,
  VariableValueOf,
} from "../schema";
import {
  VAR_TOKEN_PREFIX,
  VARIABLE_TRACK_KEY,
  STAGE_BACKGROUND_THEME,
  isGradientPaint,
  parseDriverToken,
  parseVarAlpha,
  parseVarToken,
  varToken,
} from "../schema";
import { resolveFxToken } from "../expressions/scope";
import { isColorPath } from "../scope";
import type { ScopeOverlay } from "../schema/scope";
import type { ExprType, ExprValue } from "../expressions/types";
import { stampedId } from "../identity";

/**
 * Document variables — the typed, headless value table. Any bindable slot holds
 * either a literal OR the reference token `var:<id>`; renderers resolve it
 * through `doc.variables`, so editing a variable updates every linked slot.
 *
 * ONE token scheme, ONE resolver funnel (`resolveVar`), ONE usage/detach engine
 * (`visitValueSlots`) serve every type — colors, numbers, fonts. Colors keep
 * their historical helper names as thin aliases so existing call sites are
 * untouched.
 */

// ── Animated values (keyframable variables) ──────────────────────────────────
//
// A variable may carry its own keyframe track (`variable.keyframes`, property
// key `"value"`). Static contexts read the literal `variable.value`; the render
// pipeline sets an AMBIENT clock (the document playhead) for the whole draw
// tree — mirroring the node driver-env — so EVERY typed resolver funnels the
// time-varying value through ONE seam (`variableValueNow`) with no extra
// threading. Numbers lerp, colors blend, fonts hold: the value decides, so
// keyframing works for every variable type for free.

let variableClock: number | null = null;

/** Set the ambient time (document ms) keyframed variables resolve at. Pass
 *  `null` to clear (static contexts read the literal value). Render sets this
 *  once per draw and restores it, exactly like the node driver env. */
export function setVariableClock(timeMs: number | null): void {
  variableClock = timeMs;
}

/** The current ambient variable clock, or null when unset. */
export function getVariableClock(): number | null {
  return variableClock;
}

/**
 * A variable's value sampled at an explicit time — static when it has no track.
 *
 * A PAINT variable animates through its sub-properties instead of the bare
 * `"value"` key, because "the value" of a gradient is not one number: it is
 * every stop's colour and offset and both handles. So its tracks are keyed
 * `value.<sub>` and replayed through the SAME `setPaintProperty` the clip paint
 * engine uses — which is why keyframing a shared gradient's stop needed no new
 * interpolator, no new curve editor and no new dope-sheet row.
 */
export function variableValueAt(v: Variable, timeMs: number): Variable["value"] {
  if (!v.keyframes || v.keyframes.length === 0) return v.value;
  const sampled = sampleKeyframes(v.keyframes, timeMs);
  if (v.type === "paint") return applyPaintTracks(v.value, sampled);
  const direct = sampled[VARIABLE_TRACK_KEY];
  if (typeof direct === "number" || typeof direct === "string") return direct;
  return v.value;
}

/** The prefix a paint variable's sub-property tracks carry: `value.<sub>`. */
const PAINT_TRACK_PREFIX = `${VARIABLE_TRACK_KEY}.`;

/** Replay `value.<sub>` tracks onto a copy of the paint. Returns the original
 *  when nothing addressed it, so the static case allocates nothing. */
function applyPaintTracks(paint: Paint, sampled: Record<string, KeyframeValue>): Paint {
  let out: Paint | null = null;
  for (const [key, value] of Object.entries(sampled)) {
    if (!key.startsWith(PAINT_TRACK_PREFIX)) continue;
    if (!out) out = structuredClone(paint);
    setPaintProperty(out, key.slice(PAINT_TRACK_PREFIX.length), value);
  }
  return out ?? paint;
}

// ── Driven variables (the Variables node's INPUT half) ──────────────────────
//
// A variable may be driven by a node graph (`variable.driver`). Resolution is
// injected rather than imported, exactly like the expression scope's sampler:
// the graph engine lives above this module, and reaching up for it would close
// an import loop. The renderer installs a resolver for the duration of a draw.

type VariableDriverResolver = (variable: Variable) => Variable["value"] | undefined;

let driverResolver: VariableDriverResolver | null = null;
/** Variables currently being resolved — a graph that reads the very variable it
 *  drives would otherwise recurse forever. Re-entry falls back to the literal,
 *  which is cheap, finite and predictable (the same rule `readProperty` follows
 *  for driven clip properties). */
const resolving = new Set<string>();

/** Install the resolver that turns `variable.driver` into a value. Pass null to
 *  clear; the renderer sets and restores it around a draw. */
export function setVariableDriverResolver(fn: VariableDriverResolver | null): void {
  driverResolver = fn;
}

/**
 * A variable's value at the ambient clock — the ONE seam every resolver uses.
 *
 * A driver wins over a keyframe track, which wins over the literal, and
 * MODULATORS shape whatever came out. That last order is the app's universal
 * one (`animation/modulators.ts`): a signal modifies the already-animated
 * value, so "ramp this up, then let it breathe" stays two independent
 * decisions. Routing variables through it is what makes a shared accent colour
 * or a shared gradient's angle wiggle-able with nothing variable-specific
 * written — the modulator brain already speaks property paths and was simply
 * never asked about this table.
 */
export function variableValueNow(v: Variable): Variable["value"] {
  if (v.driver && driverResolver && !resolving.has(v.id)) {
    resolving.add(v.id);
    try {
      const driven = driverResolver(v);
      if (driven !== undefined) return modulateVariable(v, driven);
    } finally {
      resolving.delete(v.id);
    }
  }
  const base = variableClock !== null ? variableValueAt(v, variableClock) : v.value;
  return modulateVariable(v, base);
}

/**
 * Apply a variable's own modulators to a resolved value.
 *
 * Numbers are the direct case. A PAINT's modulators target its sub-properties
 * (`value.<sub>`), which is the same addressing its keyframes use, so one
 * modulator can shake a gradient's angle while another breathes a pattern's
 * scale. Colours and strings hold — a modulator is a numeric signal, and
 * pretending it could shape a font family would be a control that does nothing.
 */
function modulateVariable(v: Variable, value: Variable["value"]): Variable["value"] {
  const mods = v.modulators;
  if (!mods || mods.length === 0) return value;
  const timeSec = (variableClock ?? 0) / 1000;
  if (typeof value === "number") {
    return applyModulators(mods, VARIABLE_TRACK_KEY, value, timeSec);
  }
  if (v.type !== "paint" || typeof value !== "object") return value;
  let out: Paint | null = null;
  for (const m of mods) {
    if (!m.target.startsWith(PAINT_TRACK_PREFIX)) continue;
    const sub = m.target.slice(PAINT_TRACK_PREFIX.length);
    const current = paintProperty(out ?? (value as Paint), sub);
    if (typeof current !== "number") continue;
    const next = applyModulators(mods, m.target, current, timeSec);
    if (next === current) continue;
    if (!out) out = structuredClone(value as Paint);
    setPaintProperty(out, sub, next);
  }
  return out ?? value;
}

/**
 * Which graph currently drives each variable. ONE query behind every surface
 * that has to answer "is this input already taken?" — the node board (to disable
 * a socket and explain why), the drop handler (to offer force-connect), and the
 * variables manager (to show a variable is not yours to type into). Asking it in
 * three places with three implementations is exactly how they would start
 * disagreeing.
 */
export function variableDrivers(doc: MotionDocument): Map<string, { graphId: string; token: string }> {
  const map = new Map<string, { graphId: string; token: string }>();
  for (const v of doc.variables) {
    if (!v.driver) continue;
    const parsed = parseDriverToken(v.driver);
    if (parsed) map.set(v.id, { graphId: parsed.graphId, token: v.driver });
  }
  return map;
}

/**
 * WHO ELSE ALREADY OWNS THIS VARIABLE. A variable takes its value from exactly
 * one place, so a second graph wiring the same row is not a merge — it is a
 * silent theft, and whichever graph was edited last would win a race nobody
 * could see. This names the conflict from the SAME map every other surface reads,
 * so the board's disabled socket, the drop confirm and the sync that refuses the
 * write cannot disagree about who holds it.
 *
 * Keyed by variable id, listing only drivers owned by a graph OTHER than the one
 * asking.
 */
export interface VariableWriteConflict {
  variableId: string;
  variableName: string;
  /** The graph that currently drives it, and the token pointing into it. */
  graphId: string;
  graphName: string;
  token: string;
}

export function variableWriteConflicts(
  doc: MotionDocument,
  graphId: string,
): Map<string, VariableWriteConflict> {
  const out = new Map<string, VariableWriteConflict>();
  for (const [variableId, driver] of variableDrivers(doc)) {
    if (driver.graphId === graphId) continue;
    const variable = doc.variables.find((v) => v.id === variableId);
    const graph = doc.graphs.find((g) => g.id === driver.graphId);
    out.set(variableId, {
      variableId,
      variableName: variable?.name ?? variableId,
      graphId: driver.graphId,
      graphName: graph?.name || "another graph",
      token: driver.token,
    });
  }
  return out;
}

// ── Tokens ───────────────────────────────────────────────────────────────────
//
// The grammar itself lives in `schema/variables` — beside the prefix, and
// reachable from the driver env and the schema without importing this module.
// Re-exported here so every existing call site keeps its import.

export { parseVarAlpha, parseVarToken, varToken, withVarAlpha } from "../schema/variables";

/** The variable a token points at, or null (unknown id or a literal value). */
export function resolveVar(doc: MotionDocument, value: unknown): Variable | null {
  const id = parseVarToken(value);
  if (!id) return null;
  return doc.variables.find((v) => v.id === id) ?? null;
}

// ── Expressions ──────────────────────────────────────────────────────────────
//
// A slot may hold `fx:<id>` as readily as `var:<id>`, so the resolvers below
// try an expression FIRST and fall through untouched when the value isn't one.
// Handling it here — in the funnel every render, measure and export path
// already calls — is what puts expressions on every colour and typography slot
// without changing a single one of those call sites.

/** Resolve an `fx:` token in a slot, or undefined when the value isn't one. */
function resolveFx(doc: MotionDocument, value: unknown, expect: ExprType): ExprValue | undefined {
  return resolveFxToken(
    value,
    doc.expressions,
    doc.variables,
    (v) => variableValueNow(v) as ExprValue,
    expect,
  );
}

// ── Typed resolvers — each funnels through resolveVar, type-checked ───────────

/**
 * Apply a slot's own alpha to a colour it resolved from a reference.
 *
 * MULTIPLICATIVE, not a replacement: a variable may itself be translucent (a
 * scrim, a 40% overlay tint), and a slot asking for 50% is asking for half of
 * whatever that variable is — not for it to become opaque at 50%. Replacing
 * would make the very act of setting a slot's alpha reach back through the
 * reference and discard a property of the palette.
 */
function tintAlpha(color: string, alpha: number | null): string {
  if (alpha === null) return color;
  const rgba = parseHexColor(color);
  return rgba ? formatHexColor({ ...rgba, a: rgba.a * alpha }) : color;
}

/** Resolve a (possibly tokenized) color to a literal. Missing/mistyped → magenta. */
export function resolveColor(doc: MotionDocument, value: string): string {
  const fx = resolveFx(doc, value, "color");
  if (fx !== undefined) return String(fx);
  if (parseVarToken(value) === null) return value;
  const v = resolveVar(doc, value);
  if (!v) return "#FF00FF";
  const alpha = parseVarAlpha(value);
  if (v.type === "color") return tintAlpha(String(variableValueNow(v)), alpha);
  /**
   * A FILL variable is accepted here when — and only when — it is a solid.
   *
   * The two types are not redundant, and this is the line that says exactly how
   * they differ. They are distinguished by which SLOTS accept them, not by what
   * they can hold: a fill variable belongs in `fills[]`, which can carry a
   * gradient or a hatch, while a colour variable belongs in a colour slot — a
   * gradient STOP, a shadow, a pattern's mark. Those slots hold one colour and
   * there is no sane answer to "what colour is this hatch", so they cannot
   * simply be widened to take any fill.
   *
   * But a solid fill has an unambiguous colour, and refusing it was pedantry
   * that showed up as magenta. So the type stays typed and the one case that
   * genuinely has an answer is answered.
   */
  if (v.type === "paint") {
    const paint = variableValueNow(v);
    if (paint && typeof paint === "object" && (paint as Paint).type === "solid") {
      return tintAlpha(resolveColor(doc, (paint as SolidPaint).color), alpha);
    }
  }
  return "#FF00FF";
}

/**
 * WHAT A COLOUR EDIT MEANS FOR A SLOT — the one rule, headless.
 *
 * Editing the COLOUR of a bound slot detaches it (Figma): a variable is a
 * reference, and "make this one shape bluer" must never silently restyle every
 * other layer sharing it. Editing only its ALPHA does not, because opacity is
 * not a property of the brand colour — it is how much of it this slot lets
 * through, which belongs with blend mode. Detaching on it meant the ordinary
 * act of fading a layer out quietly broke its link to the palette.
 *
 * The test is simply WHAT MOVED. Channels equal and alpha different was an
 * alpha edit, whatever control produced it — which is why no colour control in
 * the app needed a second callback for this: a row's opacity field, the
 * picker's alpha track and its A field all arrive here as an ordinary colour
 * and are all recognised.
 *
 * @param slot   what the slot holds now (a literal, or a `var:` token)
 * @param next   the literal colour the control just produced
 * @returns      what to store — the same reference at a new alpha, or `next`
 */
export function applyColorEdit(doc: MotionDocument, slot: string | undefined, next: string): string {
  const id = slot === undefined ? null : parseVarToken(slot);
  if (id === null || slot === undefined) return next;

  const before = parseHexColor(resolveColor(doc, slot));
  const after = parseHexColor(next);
  if (!before || !after) return next;
  const alphaOnly = before.r === after.r && before.g === after.g && before.b === after.b && before.a !== after.a;
  if (!alphaOnly) return next;

  /*
   * The slot's alpha MULTIPLIES into the variable's own, so the number the
   * control is showing is not the number to store. Dividing the variable's own
   * alpha back out is what makes "drag this to 40%" land on 40% on screen
   * rather than on 40% of something the person cannot see.
   */
  const own = parseHexColor(resolveColor(doc, varToken(id)))?.a ?? 1;
  return varToken(id, own > 0 ? Math.min(1, after.a / own) : after.a);
}

/**
 * Point a slot at a variable, KEEPING the opacity it already had. You asked for
 * this colour, not for the fade you had already dialled in to be thrown away.
 * One verb, so the row, the library and the picker cannot disagree about it.
 */
export function linkColorSlot(doc: MotionDocument, slot: string | undefined, id: string): string {
  const alpha =
    slot === undefined
      ? null
      : (parseVarAlpha(slot) ?? parseHexColor(resolveColor(doc, slot))?.a ?? null);
  return alpha === null || alpha >= 1 ? varToken(id) : varToken(id, alpha);
}

/**
 * The stage surround, as a literal colour — or `null` when the document has
 * asked to FOLLOW THE THEME (`STAGE_BACKGROUND_THEME`).
 *
 * Null is the honest answer, not a fallback: the theme's stage tone lives in a
 * CSS custom property that changes under the running app, so the correct thing
 * for the surface to do is paint nothing and let its `--stage` class through.
 * Resolving the sentinel to a hex here would freeze the value at render time
 * and the surround would stop following the theme the moment it was read.
 *
 * ONE reader, so the stage, the node board, an export and anything added later
 * cannot disagree about what "theme" means.
 */
export function resolveStageBackground(doc: MotionDocument): string | null {
  if (doc.stageBackground === STAGE_BACKGROUND_THEME) return null;
  return resolveColor(doc, doc.stageBackground);
}

/**
 * Resolve a paint that may BE a variable reference — the funnel every surface
 * that draws, previews or exports a paint calls first.
 *
 * The entry's own compositing wins over the variable's. That is the whole
 * contract of a shared style: the variable says what the paint LOOKS like, the
 * entry says how this layer lays it down, so two layers can share one gradient
 * and still fade independently. Handing back the variable's stored `opacity`
 * would make changing one layer's fade change every layer's.
 *
 * A missing or mistyped reference resolves to magenta, exactly as a dangling
 * colour token does — visible, not silent, and never a crash mid-frame.
 * Reference chains are followed with a guard, because a paint variable may hold
 * another paint variable and a cycle must cost one lookup, not the frame.
 */
export function resolvePaint(doc: MotionDocument, paint: Paint): Paint {
  if (paint.type !== "variable") return paint;
  const seen = new Set<string>();
  // Innermost first, so the walk collects them in the order they must apply.
  const chain: Array<Record<string, string | number>> = [];
  let current: Paint = paint;
  while (current.type === "variable") {
    const refId: string = current.variableId;
    if (seen.has(refId)) return MISSING_PAINT;
    seen.add(refId);
    chain.unshift(...overrideChain(current));
    const v: Variable | undefined = doc.variables.find((x) => x.id === refId);
    if (!v || v.type !== "paint") return MISSING_PAINT;
    const value = variableValueNow(v);
    if (!value || typeof value !== "object") return MISSING_PAINT;
    current = value;
  }
  // Identity and compositing come from the ENTRY, the look from the variable,
  // and anything this entry has moved for itself comes from its OVERRIDES —
  // applied outermost-last, so a link through a link still lets the near end
  // win. Cloned first: the value belongs to the variable, and writing an
  // override into it would edit the style for everyone who uses it.
  //
  // The deep clone is paid for ONLY when something will actually be written
  // into it. `resolvePaint` runs for every style in the picker on every
  // document change — so during a colour drag that was a structuredClone per
  // style per frame, which is most of why choosing a colour felt slow. With no
  // overrides there is nothing to mutate, and the shallow copy that this
  // function always returned is contract enough.
  const overriding = chain.some((o) => Object.keys(o).length > 0);
  const base = overriding ? structuredClone(current) : current;
  const merged: Paint = { ...base, id: paint.id, enabled: paint.enabled, opacity: paint.opacity, blendMode: paint.blendMode };
  for (const overrides of chain) {
    for (const [sub, value] of Object.entries(overrides)) setPaintProperty(merged, sub, value);
  }
  return merged;
}

/**
 * The overrides a linked paint carries, innermost first. A link to a link
 * contributes both, and the OUTER one is applied last — the end nearest the
 * artwork is the end you were editing.
 */
function overrideChain(paint: Paint): Array<Record<string, string | number>> {
  return paint.type === "variable" && paint.overrides ? [paint.overrides] : [];
}

/** What a dangling paint reference draws as — the same loud magenta a dangling
 *  colour token resolves to, for the same reason: silence hides the bug. */
const MISSING_PAINT: Paint = {
  id: "missing",
  type: "solid",
  color: "#FF00FF",
  enabled: true,
  opacity: 1,
  blendMode: "normal",
};

/** Resolve every paint in a list. The shape fills and stroke stacks want. */
export function resolvePaints(doc: MotionDocument, paints: readonly Paint[]): Paint[] {
  let changed = false;
  const out = paints.map((p) => {
    const r = resolvePaint(doc, p);
    if (r !== p) changed = true;
    return r;
  });
  return changed ? out : (paints as Paint[]);
}

/** Resolve a bindable number. Literals pass through; missing/mistyped → fallback. */
export function resolveNumber(
  doc: MotionDocument,
  value: number | string,
  fallback = 0,
): number {
  if (typeof value === "number") return value;
  const fx = resolveFx(doc, value, "float");
  if (typeof fx === "number") return fx;
  const v = resolveVar(doc, value);
  if (v) {
    const now = variableValueNow(v);
    if (typeof now === "number") return now;
  }
  return fallback;
}

/** Resolve a bindable font family. Missing/mistyped → the token string itself. */
export function resolveFontFamily(doc: MotionDocument, value: string): string {
  const fx = resolveFx(doc, value, "string");
  if (fx !== undefined) return String(fx);
  if (parseVarToken(value) === null) return value;
  const v = resolveVar(doc, value);
  return v && v.type === "fontFamily" ? String(variableValueNow(v)) : value;
}

/** Resolve a bindable font weight. Literals pass through; missing → fallback. */
export function resolveFontWeight(
  doc: MotionDocument,
  value: number | string,
  fallback = 400,
): number {
  if (typeof value === "number") return value;
  const fx = resolveFx(doc, value, "float");
  if (typeof fx === "number") return fx;
  const v = resolveVar(doc, value);
  if (v && v.type === "fontWeight") {
    const now = variableValueNow(v);
    if (typeof now === "number") return now;
  }
  return fallback;
}

/** Resolve a bindable string. Missing/mistyped → the token string itself. */
export function resolveString(doc: MotionDocument, value: string): string {
  const fx = resolveFx(doc, value, "string");
  if (fx !== undefined) return String(fx);
  if (parseVarToken(value) === null) return value;
  const v = resolveVar(doc, value);
  return v && (v.type === "string" || v.type === "fontFamily") ? String(variableValueNow(v)) : value;
}

/**
 * A text style with its bindable typography resolved to literals. Every render/
 * measure/export path goes through `resolveTextStyle` so the rest of the
 * pipeline never sees a `var:<id>` token where it expects a number/family.
 */
export type ResolvedTextStyle = Omit<TextStyle, "fontFamily" | "fontSize" | "fontWeight"> & {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
};

/** Resolve a text style's bound font family / size / weight to literals. */
export function resolveTextStyle(doc: MotionDocument, style: TextStyle): ResolvedTextStyle {
  return {
    ...style,
    fontFamily: resolveFontFamily(doc, style.fontFamily),
    fontSize: resolveNumber(doc, style.fontSize, 16),
    fontWeight: resolveFontWeight(doc, style.fontWeight),
  };
}

// ── Create / rename / delete ─────────────────────────────────────────────────

/** A name unique within the table (case-insensitive), auto-suffixed on clash. */
// ── Variables by their --name ───────────────────────────────────────────────

/**
 * A variable's name as it is TYPED into a field: "Brand deep" → "--brand-deep".
 * Typing `--` in any value field suggests the document's variables by this
 * spelling, so a person can link one without leaving the keyboard.
 */
export function variableCssName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `--${slug || "variable"}`;
}

/** The variable a typed `--name` means, if there is exactly that one. */
export function findVariableByCssName(doc: MotionDocument, text: string): Variable | null {
  const want = text.trim().toLowerCase();
  if (!want.startsWith("--")) return null;
  return doc.variables.find((v) => variableCssName(v.name) === want) ?? null;
}

/**
 * What a field offers while someone types `--…`: variables of a type the slot
 * accepts, best match first (prefix of the --name, then anywhere in it, then
 * the plain name), stable within a tier.
 */
export function suggestVariables(
  doc: MotionDocument,
  query: string,
  types?: readonly VariableType[],
  limit = 8,
): Variable[] {
  const q = query.replace(/^-+/, "").toLowerCase();
  const tiers: Variable[][] = [[], [], []];
  for (const v of doc.variables) {
    if (types && !types.includes(v.type)) continue;
    const css = variableCssName(v.name).slice(2);
    if (!q || css.startsWith(q)) tiers[0]!.push(v);
    else if (css.includes(q)) tiers[1]!.push(v);
    else if (v.name.toLowerCase().includes(q)) tiers[2]!.push(v);
  }
  return tiers.flat().slice(0, limit);
}

export function uniqueVariableName(doc: MotionDocument, desired: string, ignoreId?: string): string {
  const taken = new Set(
    doc.variables.filter((v) => v.id !== ignoreId).map((v) => v.name.trim().toLowerCase()),
  );
  const base = desired.trim() || "Variable";
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function addVariable<T extends VariableType>(
  doc: MotionDocument,
  type: T,
  name: string,
  value: VariableValueOf<T>,
): Variable {
  const variable = { id: createId("var"), name: uniqueVariableName(doc, name), type, value, keyframes: [] } as Variable;
  doc.variables.push(variable);
  return variable;
}

/** Rename a variable (id-stable — every linked slot follows automatically). */
export function renameVariable(doc: MotionDocument, id: string, name: string): void {
  const v = doc.variables.find((x) => x.id === id);
  if (v) v.name = uniqueVariableName(doc, name, id);
}

/**
 * Delete a variable. Every linked slot is detached to the variable's last
 * literal value (type-appropriate), so nothing on the canvas changes visually.
 *
 * A PAINT variable detaches through the other kind of reference — the fill or
 * stroke entries that ARE it — and gets the paint itself, keeping each entry's
 * own id and compositing. Deleting a shared gradient must leave every layer
 * looking identical and merely un-shared; it must never leave a magenta hole
 * where a fill was.
 */
export function deleteVariable(doc: MotionDocument, id: string): void {
  const variable = doc.variables.find((v) => v.id === id);
  if (!variable) return;
  if (variable.type === "paint") {
    const look = variable.value;
    visitPaintRefs(doc, (entry) =>
      entry.variableId === id
        ? { ...structuredClone(look), id: entry.id, enabled: entry.enabled, opacity: entry.opacity, blendMode: entry.blendMode }
        : undefined,
    );
  } else {
    visitValueSlots(doc, (value) => (parseVarToken(value) === id ? (variable.value as string | number) : undefined));
  }
  doc.variables = doc.variables.filter((v) => v.id !== id);
}

// ── Slot visiting: usage + detach across every bindable slot ─────────────────

/**
 * The visitor contract: given a slot's stored value and the variable TYPE that
 * slot binds, return a replacement to write, or undefined to leave it.
 */
export type ValueVisitor = (
  value: string | number,
  type: VariableType,
) => string | number | undefined;

/** Visit the bindable typography slots on one text style, in place. */
function visitStyleValueSlots(
  style: { fontFamily?: unknown; fontSize?: unknown; fontWeight?: unknown },
  visit: ValueVisitor,
): void {
  const apply = (key: "fontFamily" | "fontSize" | "fontWeight", type: VariableType) => {
    const v = style[key];
    if (typeof v === "string" || typeof v === "number") {
      const next = visit(v, type);
      if (next !== undefined) style[key] = next;
    }
  };
  apply("fontFamily", "fontFamily");
  apply("fontSize", "number");
  apply("fontWeight", "fontWeight");
}

/** The typography half of an overlay — the same three bindable slots, flat. */
function visitOverlayValueSlots(ov: ScopeOverlay, visit: ValueVisitor): void {
  const apply = (key: "fontFamily" | "fontSize" | "fontWeight", type: VariableType) => {
    const v = ov.props[key];
    if (typeof v === "string" || typeof v === "number") {
      const next = visit(v, type);
      if (next !== undefined) ov.props[key] = next;
    }
  };
  apply("fontFamily", "fontFamily");
  apply("fontSize", "number");
  apply("fontWeight", "fontWeight");
}

/**
 * Visit every COLOR slot on ONE clip (mutating in place): layer-effect colors,
 * color-kind keyframes, every fill/stroke paint (+ gradient stops), and — for
 * text — style + range/focus/highlight colors. Shared by the doc-wide sweep
 * and the selection-scoped color tools.
 */
export function visitClipColorSlots(clip: Clip, visit: (value: string) => string | undefined): void {
  const apply = <T, K extends keyof T>(obj: T, key: K) => {
    const v = obj[key];
    if (typeof v === "string") {
      const next = visit(v);
      if (next !== undefined) obj[key] = next as T[K];
    }
  };
  const visitStyle = (style: {
    color?: string;
    effects?: Array<Record<string, unknown>>;
    highlight?: { color: string } | null;
  }) => {
    apply(style, "color");
    if (style.effects) for (const fx of style.effects) if ("color" in fx) apply(fx, "color");
    if (style.highlight) apply(style.highlight, "color");
  };
  const visitPaint = (paint: Paint) => {
    if (paint.type === "solid") apply(paint, "color");
    else if (isGradientPaint(paint)) for (const stop of paint.stops) apply(stop, "color");
    else if (paint.type === "pattern") for (const slot of ["color", "background"] as const) apply(paint.pattern, slot);
    // Media paints carry no colour slot, and a VARIABLE paint's colours belong
    // to the variable — retinting them from here would edit a shared style
    // through one of the layers that merely uses it.
  };
  const visitColorKeys = () => {
    for (const kf of clip.keyframes) {
      if (propertyDef(kf.property)?.kind !== "color") continue;
      for (const key of kf.keys) {
        if (typeof key.value === "string") {
          const next = visit(key.value);
          if (next !== undefined) key.value = next;
        }
      }
    }
  };

  if (clip.kind === "audio") return; // no color slots
  for (const fx of clip.effects) if ("color" in fx) apply(fx, "color");
  visitColorKeys();
  if (clip.kind === "shape" || clip.kind === "path") {
    for (const p of clip.fills) visitPaint(p);
    for (const s of clip.strokes) visitPaint(s.paint);
    return;
  }
  if (clip.kind !== "text") return;
  visitStyle(clip.style);
  // A scope's colours live in its overlay's flat prop map (plus any paint or
  // effect it adds outright), so one walker covers ranges and focus alike.
  const visitOverlayColors = (ov: ScopeOverlay) => {
    for (const path of Object.keys(ov.props)) {
      const v = ov.props[path];
      if (!isColorPath(path) || typeof v !== "string") continue;
      const next = visit(v);
      if (next !== undefined) ov.props[path] = next;
    }
    for (const fx of ov.added.effects) if ("color" in fx) apply(fx as Record<string, unknown>, "color");
    for (const p of ov.added.fills) visitPaint(p);
    for (const st of ov.added.strokes) visitPaint(st.paint);
  };
  for (const r of clip.ranges) visitOverlayColors(r.overlay);
  if (clip.caption) for (const st of CAPTION_STATES) visitOverlayColors(clip.caption.states[st].overlay);
}

/**
 * Visit every PAINT ENTRY in the document — a layer's fills and stroke paints,
 * a frame's fills, and everything a text scope adds — with the chance to
 * REPLACE it.
 *
 * The colour walker above cannot do this job: it visits colour STRINGS inside a
 * paint, and a paint reference has no colour string to visit. They are two
 * genuinely different questions ("which colours are used" vs "which paints are
 * this style"), so they are two walkers over the same tree rather than one
 * walker with a mode flag that half its call sites would pass wrong.
 */
export function visitClipPaints(clip: Clip, visit: (paint: Paint) => Paint | undefined): void {
  const mapList = (list: Paint[]) => {
    for (let i = 0; i < list.length; i++) {
      const next = visit(list[i]!);
      if (next !== undefined) list[i] = next;
    }
  };
  const mapStrokes = (list: Array<{ paint: Paint }>) => {
    for (const s of list) {
      const next = visit(s.paint);
      if (next !== undefined) s.paint = next;
    }
  };
  if (clip.kind === "audio") return;
  if ("fills" in clip && Array.isArray(clip.fills)) mapList(clip.fills as Paint[]);
  if ("strokes" in clip && Array.isArray(clip.strokes)) mapStrokes(clip.strokes as Array<{ paint: Paint }>);
  if (clip.kind !== "text") return;
  const overlays: ScopeOverlay[] = [
    ...clip.ranges.map((r) => r.overlay),
    ...(clip.caption ? CAPTION_STATES.map((st) => clip.caption!.states[st].overlay) : []),
  ];
  for (const ov of overlays) {
    mapList(ov.added.fills);
    mapStrokes(ov.added.strokes);
  }
}

/** Every paint entry in the document, replaceable. Behind paint-variable usage
 *  counts and delete-detach, exactly as `visitValueSlots` is for the rest. */
export function visitPaintRefs(
  doc: MotionDocument,
  visit: (paint: Extract<Paint, { type: "variable" }>) => Paint | undefined,
): void {
  const forEntry = (p: Paint) => (p.type === "variable" ? visit(p) : undefined);
  for (const frame of doc.frames) {
    for (let i = 0; i < frame.fills.length; i++) {
      const next = forEntry(frame.fills[i]!);
      if (next !== undefined) frame.fills[i] = next;
    }
  }
  for (const track of doc.tracks) for (const clip of track.clips) visitClipPaints(clip, forEntry);
}

/** Visit every color slot in the whole document (frame backgrounds + clips). */
export function visitColorSlots(doc: MotionDocument, visit: (value: string) => string | undefined): void {
  for (const frame of doc.frames) {
    const next = visit(frame.background);
    if (next !== undefined) frame.background = next;
  }
  for (const track of doc.tracks) for (const clip of track.clips) visitClipColorSlots(clip, visit);
}

/**
 * Visit EVERY bindable slot in the document (colors + typography), tagged with
 * the variable type it binds. The one engine behind usage counts and
 * delete-detach for every variable type.
 */
export function visitValueSlots(doc: MotionDocument, visit: ValueVisitor): void {
  // Colors: reuse the color walker, forwarding the color type tag.
  visitColorSlots(doc, (value) => {
    const next = visit(value, "color");
    return next === undefined ? undefined : String(next);
  });
  // Typography: bindable font family / size / weight on every text style —
  // the layer's, its ranges', and a caption's focus scope.
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "text") continue;
      visitStyleValueSlots(clip.style, visit);
      for (const r of clip.ranges) visitOverlayValueSlots(r.overlay, visit);
      if (clip.caption) {
        for (const st of CAPTION_STATES) visitOverlayValueSlots(clip.caption.states[st].overlay, visit);
      }
    }
  }
}

/** How many slots reference each variable (by id, any type). */
export function variableUsage(doc: MotionDocument): Map<string, number> {
  const usage = new Map<string, number>();
  const bump = (id: string) => usage.set(id, (usage.get(id) ?? 0) + 1);
  visitValueSlots(doc, (value) => {
    const id = parseVarToken(value);
    if (id) bump(id);
    return undefined;
  });
  // Paint variables are referenced by an ENTRY, not by a token in a slot, so
  // they are invisible to the walker above. Counting them here — rather than in
  // a second usage function the manager would have to remember to call — is why
  // one number on a row means the same thing for every type.
  visitPaintRefs(doc, (entry) => {
    bump(entry.variableId);
    return undefined;
  });
  return usage;
}

// ── Color back-compat aliases (unchanged call sites keep working) ────────────

export const colorVarToken = varToken;
export const parseColorVarToken = parseVarToken;

export function addColorVariable(doc: MotionDocument, name: string, value: string): Variable {
  return addVariable(doc, "color", name, value);
}

export function deleteColorVariable(doc: MotionDocument, id: string): void {
  deleteVariable(doc, id);
}

export const colorVariableUsage = variableUsage;

// ── Folders, libraries and the file on disk ─────────────────────────────────
//
// A folder is the ONE container: a personal grouping, a theme, an imported
// palette. See `variableFolderSchema` for why libraries are not a second kind.

/** A new folder. Names are free-form — folders are addressed by id, so two
 *  siblings may share a name without anything breaking. */
export function addVariableFolder(
  doc: MotionDocument,
  name: string,
  parentId: string | null = null,
): VariableFolder {
  const folder: VariableFolder = { id: createId("vfolder"), name: name.trim() || "Folder", parentId };
  doc.variableFolders.push(folder);
  return folder;
}

export function renameVariableFolder(doc: MotionDocument, id: string, name: string): void {
  const f = doc.variableFolders.find((x) => x.id === id);
  if (f) f.name = name.trim() || f.name;
}

/** Every folder inside `id`, itself included — the subtree a move, an export or
 *  a delete acts on. Cycle-guarded, because a drag that made a folder its own
 *  ancestor would otherwise hang the app rather than being refused. */
export function variableFolderSubtree(doc: MotionDocument, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (fid: string) => {
    if (seen.has(fid)) return;
    seen.add(fid);
    out.push(fid);
    for (const f of doc.variableFolders) if (f.parentId === fid) walk(f.id);
  };
  walk(id);
  return out;
}

/**
 * Delete a folder. Its contents move UP to its parent by default, because
 * deleting a container is a statement about the container — losing nine
 * colours to a mis-click on a folder chip is not a thing a design tool should
 * make possible. `withContents` is the deliberate version, and it detaches
 * every linked slot exactly as deleting each variable would.
 */
export function deleteVariableFolder(
  doc: MotionDocument,
  id: string,
  opts: { withContents?: boolean } = {},
): void {
  const folder = doc.variableFolders.find((f) => f.id === id);
  if (!folder) return;
  const subtree = new Set(variableFolderSubtree(doc, id));
  if (opts.withContents) {
    for (const v of doc.variables.filter((v) => v.folderId && subtree.has(v.folderId))) deleteVariable(doc, v.id);
  } else {
    for (const v of doc.variables) if (v.folderId === id) v.folderId = folder.parentId;
    for (const f of doc.variableFolders) if (f.parentId === id) f.parentId = folder.parentId;
    subtree.clear();
    subtree.add(id);
  }
  doc.variableFolders = doc.variableFolders.filter((f) => !subtree.has(f.id));
}

/** File variables under a folder (null = the root). The write half of the drag. */
export function moveVariables(doc: MotionDocument, ids: readonly string[], folderId: string | null): void {
  const set = new Set(ids);
  for (const v of doc.variables) if (set.has(v.id)) v.folderId = folderId;
}

/** Re-parent a folder, refusing a drop into its own subtree — that would make
 *  the tree a cycle and orphan everything inside it. */
export function moveVariableFolder(doc: MotionDocument, id: string, parentId: string | null): boolean {
  if (parentId !== null && variableFolderSubtree(doc, id).includes(parentId)) return false;
  const f = doc.variableFolders.find((x) => x.id === id);
  if (!f) return false;
  f.parentId = parentId;
  return true;
}

/** Folder names from the root down to `id` — the breadcrumb, computed rather
 *  than stored, so a rename or a move never leaves a stale path behind. */
export function variableFolderPath(doc: MotionDocument, id: string): VariableFolder[] {
  const byId = new Map(doc.variableFolders.map((f) => [f.id, f]));
  const out: VariableFolder[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

/**
 * Duplicate variables (and optionally a whole folder subtree) with fresh ids.
 * The one copier behind duplicate, paste and "import into this document", so
 * the three cannot disagree about what a copy of a palette is.
 */
export function duplicateVariables(
  doc: MotionDocument,
  ids: readonly string[],
  folderId: string | null = null,
): Variable[] {
  const made: Variable[] = [];
  for (const id of ids) {
    const src = doc.variables.find((v) => v.id === id);
    if (!src) continue;
    const copy = structuredClone(src);
    copy.id = createId("var");
    copy.name = uniqueVariableName(doc, src.name);
    copy.folderId = folderId ?? src.folderId ?? null;
    // A driver points at a graph socket that still drives the ORIGINAL. Copying
    // it would silently give one socket two owners, which the write-conflict
    // machinery exists to prevent — so a duplicate arrives undriven.
    copy.driver = null;
    doc.variables.push(copy);
    made.push(copy);
  }
  return made;
}

/** The interchange format: a folder subtree and its variables, portable between
 *  documents and devices. Versioned from day one, because a palette someone
 *  exported is a file that outlives the app version that wrote it. */
export interface VariableFile {
  /** `<ns>.variables`: written by the exporting product, read for any (identity.ts). */
  kind: string;
  version: 1;
  name: string;
  folders: VariableFolder[];
  variables: Variable[];
}

/** Export a folder subtree (or the whole table when `folderId` is null). */
export const VARIABLE_FILE_KIND = stampedId("", ".", "variables");

export function exportVariables(doc: MotionDocument, folderId: string | null, ns: string): VariableFile {
  const subtree = folderId ? new Set(variableFolderSubtree(doc, folderId)) : null;
  const folders = doc.variableFolders.filter((f) => !subtree || subtree.has(f.id));
  const variables = doc.variables.filter((v) =>
    subtree ? v.folderId !== null && v.folderId !== undefined && subtree.has(v.folderId) : true,
  );
  const root = folderId ? doc.variableFolders.find((f) => f.id === folderId) : undefined;
  return {
    kind: VARIABLE_FILE_KIND.of(ns),
    version: 1,
    name: root?.name ?? doc.name,
    // Deep copies with the export's own root detached from its parent: a
    // palette imported elsewhere must not arrive claiming a parent folder that
    // document has never heard of.
    folders: folders.map((f) => (f.id === folderId ? { ...f, parentId: null } : { ...f })),
    variables: variables.map((v) => structuredClone(v)),
  };
}

/** True for anything shaped like an exported variables file. */
export function isVariableFile(value: unknown): value is VariableFile {
  const f = value as Partial<VariableFile> | null;
  return !!f && VARIABLE_FILE_KIND.matches(f.kind) && Array.isArray(f.folders) && Array.isArray(f.variables);
}

/**
 * Import an exported file, minting fresh ids throughout.
 *
 * Ids are ALWAYS remapped, never reused. Two documents that both imported the
 * same palette and then edited it differently would otherwise collide the
 * moment one was pasted into the other, and the winner would be whichever
 * happened to be written second. Names are uniquified for the same reason
 * `addVariable` does it — a table with two "Accent"s is a table you cannot use.
 */
export function importVariables(
  doc: MotionDocument,
  file: VariableFile,
  parentId: string | null = null,
): { folders: VariableFolder[]; variables: Variable[] } {
  const folderIds = new Map<string, string>();
  for (const f of file.folders) folderIds.set(f.id, createId("vfolder"));

  const folders = file.folders.map((f) => {
    const next: VariableFolder = {
      ...f,
      id: folderIds.get(f.id)!,
      parentId: f.parentId ? (folderIds.get(f.parentId) ?? parentId) : parentId,
    };
    doc.variableFolders.push(next);
    return next;
  });

  const variables = file.variables.map((v) => {
    const next = structuredClone(v);
    next.id = createId("var");
    next.name = uniqueVariableName(doc, v.name);
    next.folderId = v.folderId ? (folderIds.get(v.folderId) ?? parentId) : parentId;
    next.driver = null;
    doc.variables.push(next);
    return next;
  });

  return { folders, variables };
}
