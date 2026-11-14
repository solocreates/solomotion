import { produce } from "immer";
import type { MotionDocument, Clip, Frame } from "../schema";
import { createDocumentStore } from "../history/document-store";
import type { CommandContext } from "../api/command";
import type { CommandRegistry } from "../api/registry";
import { locateClip } from "../timeline/ops";
import { clearScriptOutput } from "./output";
import { clipAnimatableProperties } from "../animation/clip-properties";
import { getClipProperty } from "../animation/paths";
import { Namer, Ref, Tpl, nameMap, printProgram, resolveValue, type Binding, type Scope, type Stmt } from "./reify-code";
import { canonicalClips, canonicalDiff, definedIds, flattenTree, reifyEqual, subjectTree, type SubjectNode } from "./reify-equal";

/**
 * REIFY — CODE = VISUAL. Any piece of a project printed as a script of `ac.*`
 * registry calls that rebuilds it; run in `replace` mode, running it IS
 * editing it (docs/adr/characters/reify.md).
 *
 * Two halves with one contract between them:
 *
 *  • PRINTERS (a registry — `registerReifier`) write IDIOMATIC calls: the
 *    verb a person would reach for, names not ids, defaults left out. A
 *    printer is about readability. It may say less than the data holds.
 *
 *  • THE BRIDGE makes the result EXACT. It runs the printed program on a copy
 *    of the document without the subject, measures every difference from the
 *    original (≅, `reify-equal.ts`) and appends the smallest residual edits —
 *    `layer.patch` by position, `text.set`, `timeline.trim`, `frame.update` —
 *    then runs it all again and reports whatever still differs as a warning.
 *    Losslessness is measured, never assumed, so a field added to the schema
 *    next month round-trips the day it lands, printer or not.
 */

// ── The printer registry ─────────────────────────────────────────────────────

export interface ReifyContext {
  readonly doc: MotionDocument;
  /** The comp being built: a Ref when the code creates it, null = `here`. */
  readonly frame: Ref | null;
  /** Append a call. Returns a Ref to its result. Ids in `input` that the script knows by then become refs. */
  call(command: string, input: Record<string, unknown>, opts?: { name?: string; owner?: string }): Ref;
  /** `const <name> = Object.fromEntries(<from>.map((b) => [b.name, b.id]))` — a name → id map. */
  names(from: Ref, hint: string): Ref;
  comment(text: string): void;
  gap(): void;
  /** Record that the script knows `id` as `value` from here on (a clip, an effect, a bone…). */
  bindId(id: string, value: Ref | Tpl): void;
  /** Record that `clipId` is created, its id at `idRef`. */
  bindLayer(clipId: string, idRef: Ref): void;
  /** The script's handle on a layer: a Ref for one it made, else its unique name (or id). */
  layer(clipId: string): Ref | string;
  /** A readable reference to something outside the subject (a comp, an asset): its name when unique. */
  outside(kind: "frame" | "asset" | "clip", id: string): string;
  /** Where a newly created LEAF of the subject must land to keep its z (undefined = on top). */
  placement(clipId: string): Record<string, unknown> | undefined;
  /** Is this clip part of what is being printed? */
  inSubject(clipId: string): boolean;
  /** Ids defined inside the subject that are referenced anywhere else in it. */
  referenced(id: string): boolean;
  /** Something the code cannot say. */
  warn(text: string): void;
}

/**
 * What a printer prints, and when:
 *  • `create`  brings a layer of one of `kinds` into being (exactly one per kind),
 *  • `layer`   adds to EVERY subject layer once all of them exist — so a driver
 *              may read a layer made after it, and cycles print in a legal order,
 *  • `comp`    adds to a comp the script creates (inputs, machines, simulation).
 * `order` sorts printers within a phase (lower first; ties by kind).
 * `part` prints ONE part of a comp on its own (the machine board's Code tab).
 */
export interface Reifier {
  phase: "create" | "layer" | "comp";
  kinds?: readonly Clip["kind"][];
  order?: number;
  print?(clip: Clip, cx: ReifyContext): void;
  comp?(frame: Frame, cx: ReifyContext): void;
  part?(frame: Frame, partId: string, cx: ReifyContext): boolean;
}

const REIFIERS = new Map<string, Reifier>();

/**
 * Register a printer under a unique `kind` ("text", "effects", "poses",
 * "machine"…). Re-registering a kind replaces it (hot reload); see
 * docs/adr/characters/reify.md for the recipe.
 */
export function registerReifier(kind: string, reifier: Reifier): () => void {
  REIFIERS.set(kind, reifier);
  return () => {
    if (REIFIERS.get(kind) === reifier) REIFIERS.delete(kind);
  };
}

export function reifierKinds(): string[] {
  return [...REIFIERS.keys()];
}

function inPhase(phase: Reifier["phase"]): Array<[string, Reifier]> {
  return [...REIFIERS.entries()].filter(([, r]) => r.phase === phase).sort(([ka, a], [kb, b]) => (a.order ?? 50) - (b.order ?? 50) || (ka < kb ? -1 : 1));
}

function creatorFor(kind: Clip["kind"]): Reifier | undefined {
  return inPhase("create").find(([, r]) => r.kinds?.includes(kind))?.[1];
}

// ── Targets and results ──────────────────────────────────────────────────────

export type ReifyTarget =
  /** Layers (a selection). Built in `here`; groups take what they hold. */
  | { layers: readonly string[] }
  /** A whole comp, created by the code. */
  | { comp: string }
  /** One part of a comp alone, by the printer that owns it (`{ part: "machine", frameId, id }`). */
  | { part: string; frameId: string; id: string };

export interface ReifyOptions {
  /**
   * The registry the program is measured against — `createCommandApi()` or
   * the host's (core verbs are all a printer may use). Without one nothing is
   * measured: no residual, no losses reported, `exact` false. A `part` never
   * needs one (its printer's verb replaces the part whole).
   */
  registry?: CommandRegistry;
}

export interface ReifyResult {
  code: string;
  warnings: string[];
  /** The ids the program re-creates — what a script's ledger adopts so its first replace run edits in place. */
  owns: { clipIds: string[]; frameIds: string[] };
  /** Whether the measured round trip came back ≅. */
  exact: boolean;
}

// ── The program builder ──────────────────────────────────────────────────────

interface IdBinding {
  value: Ref | Tpl;
  /** Statement index from which the script knows it. */
  at: number;
}

class Builder implements ReifyContext {
  readonly stmts: Stmt[] = [];
  readonly warnings: string[] = [];
  readonly ids = new Map<string, IdBinding>();
  readonly layerRefs = new Map<string, Ref>();
  readonly namer = new Namer();
  frame: Ref | null = null;
  private readonly subject: Set<string>;
  private readonly counts: Map<string, number>;

  constructor(
    readonly doc: MotionDocument,
    subjectIds: readonly string[],
    private readonly placements: Map<string, Record<string, unknown>>,
  ) {
    this.subject = new Set(subjectIds);
    const json = JSON.stringify(subjectIds.map((id) => locateClip(doc, id)?.clip ?? null));
    this.counts = new Map();
    for (const id of subjectIds) {
      const c = locateClip(doc, id)?.clip;
      if (!c) continue;
      for (const d of definedIds(c)) this.counts.set(d.id, json.split(d.id).length - 1);
    }
  }

  call(command: string, input: Record<string, unknown>, opts: { name?: string; owner?: string } = {}): Ref {
    const bind: Binding = { name: this.namer.name(opts.name ?? command.split(".").pop()!, "result"), used: false };
    this.stmts.push({ t: "call", command, input, bind, ...(opts.owner ? { owner: opts.owner } : {}) });
    return new Ref(bind);
  }

  names(from: Ref, hint: string): Ref {
    const bind: Binding = { name: this.namer.name(hint, "names"), used: false };
    this.stmts.push({ t: "names", bind, from });
    return new Ref(bind);
  }

  comment(text: string): void {
    this.stmts.push({ t: "comment", text: text.replace(/\s*\n\s*/g, " ") });
  }

  gap(): void {
    this.stmts.push({ t: "gap" });
  }

  bindId(id: string, value: Ref | Tpl): void {
    if (!this.ids.has(id)) this.ids.set(id, { value, at: this.stmts.length });
  }

  bindLayer(clipId: string, idRef: Ref): void {
    this.layerRefs.set(clipId, idRef);
    this.bindId(clipId, idRef);
  }

  layer(clipId: string): Ref | string {
    return this.layerRefs.get(clipId) ?? this.outside("clip", clipId);
  }

  outside(kind: "frame" | "asset" | "clip", id: string): string {
    const doc = this.doc;
    const list: Array<{ id: string; name: string }> =
      kind === "frame" ? doc.frames : kind === "asset" ? doc.assets : doc.tracks.flatMap((t) => t.clips);
    const self = list.find((x) => x.id === id);
    if (!self) return id;
    return list.filter((x) => x.name === self.name).length === 1 ? self.name : id;
  }

  placement(clipId: string): Record<string, unknown> | undefined {
    return this.placements.get(clipId);
  }

  inSubject(clipId: string): boolean {
    return this.subject.has(clipId);
  }

  referenced(id: string): boolean {
    return (this.counts.get(id) ?? 0) > 1;
  }

  warn(text: string): void {
    if (!this.warnings.includes(text)) this.warnings.push(text);
  }
}

/**
 * Every string in `value` that mentions an id the script knows by statement
 * `at` becomes a Ref / Tpl — the ONE place ids turn into names in code.
 */
function substitute(value: unknown, ids: Map<string, IdBinding>, at: number, re: RegExp | null): unknown {
  if (!re) return value;
  if (value instanceof Ref || value instanceof Tpl) return value;
  if (typeof value === "string") {
    const parts: Array<string | Ref> = [];
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(value); m; m = re.exec(value)) {
      const b = ids.get(m[0]);
      if (!b || b.at > at) continue;
      if (m.index > last) parts.push(value.slice(last, m.index));
      if (b.value instanceof Tpl) parts.push(...b.value.parts);
      else parts.push(b.value);
      last = m.index + m[0].length;
    }
    if (!parts.length) return value;
    if (last < value.length) parts.push(value.slice(last));
    return parts.length === 1 && parts[0] instanceof Ref ? parts[0] : new Tpl(parts);
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, ids, at, re));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, ids, at, re)]));
  }
  return value;
}

function idPattern(ids: Map<string, IdBinding>): RegExp | null {
  const keys = [...ids.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  return keys.length ? new RegExp(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null;
}

/** The program with every known id written as the script's own reference. */
function finalize(b: Builder): Stmt[] {
  const re = idPattern(b.ids);
  return b.stmts.map((s, i) => (s.t === "call" ? { ...s, input: substitute(s.input, b.ids, i, re) as Record<string, unknown> } : s));
}

// ── Running the program in-process ───────────────────────────────────────────

interface RunOutcome {
  doc: MotionDocument;
  scope: Scope;
  errors: string[];
}

async function execute(registry: CommandRegistry, start: MotionDocument, focus: string | null, stmts: readonly Stmt[]): Promise<RunOutcome> {
  const store = createDocumentStore(start);
  const ctx: CommandContext = {
    store,
    actor: "Reify",
    session: { focusFrameId: () => focus, playheadMs: () => 0, selection: () => [] },
  };
  const scope: Scope = new Map();
  const errors: string[] = [];
  for (const s of stmts) {
    if (s.t === "names") scope.set(s.bind, nameMap(resolveValue(s.from, scope)));
    if (s.t !== "call") continue;
    const res = await registry.call(s.command, resolveValue(s.input, scope), ctx);
    if (res.ok) scope.set(s.bind, res.value);
    else errors.push(`ac.${s.command}: ${res.error}`);
  }
  return { doc: store.getState(), scope, errors };
}

// ── Residual: the edits the idiomatic program missed ─────────────────────────

const SAFE_KEY = /^[A-Za-z_$][\w$]*$/;
const UNPATCHABLE = new Set(["id", "kind", "frameId", "text", "startMs", "durationMs"]);

type PatchOp = { op: "set"; path: string; value: unknown } | { op: "merge"; path: string; value: Record<string, unknown> } | { op: "remove"; path: string };

/** Values to write, with ids nothing else mentions left for the API to mint. */
function stripLoneIds(value: unknown, referenced: (id: string) => boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => stripLoneIds(v, referenced));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "id" && typeof v === "string" && !referenced(v)) continue;
      out[k] = stripLoneIds(v, referenced);
    }
    return out;
  }
  return value;
}

/**
 * Patch ops turning `scratch` into `orig`, walking raw values (which carry
 * real ids) under canonical comparison (which ignores them). Positional, so
 * no op names an id the script cannot know.
 */
function residualOps(orig: unknown, scratch: unknown, co: unknown, cs: unknown, path: string, ops: PatchOp[], referenced: (id: string) => boolean): void {
  if (JSON.stringify(co) === JSON.stringify(cs)) return;
  const setHere = (): void => void ops.push({ op: "set", path, value: stripLoneIds(orig, referenced) });
  if (Array.isArray(orig) && Array.isArray(scratch) && Array.isArray(co) && Array.isArray(cs) && orig.length === scratch.length && path.split(".").pop() !== "keyframes") {
    orig.forEach((o, i) => residualOps(o, scratch[i], co[i], cs[i], `${path}[${i}]`, ops, referenced));
    return;
  }
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(orig) || !isObj(scratch) || !isObj(co) || !isObj(cs)) return setHere();
  // Canonical keys are renamed ids; pair raw keys through them.
  const rawKey = (raw: Record<string, unknown>, can: Record<string, unknown>) => {
    const out = new Map<string, string>();
    const rk = Object.keys(raw).filter((k) => raw[k] !== undefined).sort();
    // canonicalClips inserts keys in sorted RAW order, then renames them — so
    // the canonical object's own key order pairs with the sorted raw keys.
    const ck = Object.keys(can);
    if (rk.length !== ck.length) return null;
    rk.forEach((k, i) => out.set(ck[i]!, k));
    return out;
  };
  const ko = rawKey(orig, co);
  const ks = rawKey(scratch, cs);
  if (!ko || !ks) return setHere();
  const merge: Record<string, unknown> = {};
  let wholeObject = false;
  for (const ck of [...new Set([...ko.keys(), ...ks.keys()])].sort()) {
    const ro = ko.get(ck);
    const rs = ks.get(ck);
    const safe = (k: string | undefined) => k !== undefined && SAFE_KEY.test(k);
    if (ro === undefined) {
      if (safe(rs)) ops.push({ op: "remove", path: path ? `${path}.${rs}` : rs! });
      else wholeObject = true;
      continue;
    }
    if (!path && UNPATCHABLE.has(ro)) continue;
    if (JSON.stringify(co[ck]) === JSON.stringify(cs[ck])) continue;
    if (!safe(ro)) {
      merge[ro] = stripLoneIds(orig[ro], referenced);
      continue;
    }
    const sub = path ? `${path}.${ro}` : ro;
    if (rs === undefined) ops.push({ op: "set", path: sub, value: stripLoneIds(orig[ro], referenced) });
    else residualOps(orig[ro], scratch[rs], co[ck], cs[ck], sub, ops, referenced);
  }
  if (wholeObject && path) return void ops.splice(0, ops.length, ...ops.filter((o) => !o.path.startsWith(path)), { op: "set", path, value: stripLoneIds(orig, referenced) });
  if (Object.keys(merge).length) ops.push({ op: "merge", path, value: merge });
}

// ── reify() ──────────────────────────────────────────────────────────────────

interface Plan {
  frame: Frame | null;
  roots: string[];
  tree: SubjectNode[];
  /** Comp target: the comp the code creates. */
  comp?: Frame;
}

function planFor(doc: MotionDocument, target: ReifyTarget): Plan {
  if ("comp" in target) {
    const comp = doc.frames.find((f) => f.id === target.comp || f.name === target.comp);
    if (!comp) throw new Error(`No comp "${target.comp}".`);
    const roots = doc.tracks.filter((t) => !t.groupId).flatMap((t) => t.clips.filter((c) => c.frameId === comp.id).map((c) => c.id));
    return { frame: comp, roots, tree: subjectTree(doc, roots), comp };
  }
  if ("part" in target) {
    const frame = doc.frames.find((f) => f.id === target.frameId) ?? null;
    return { frame, roots: [], tree: [] };
  }
  // A layer inside a selected group is printed by its group: keep only the roots.
  const ids = new Set(target.layers.filter((id) => locateClip(doc, id)));
  const parentOf = (id: string) => doc.tracks.find((t) => t.clips.some((c) => c.id === id))?.groupId ?? null;
  const roots = [...ids].filter((id) => {
    for (let p = parentOf(id); p; p = parentOf(p)) if (ids.has(p)) return false;
    return true;
  });
  const first = roots[0] ? locateClip(doc, roots[0])!.clip : null;
  const frame = first ? (doc.frames.find((f) => f.id === first.frameId) ?? null) : null;
  return { frame, roots: roots.filter((id) => locateClip(doc, id)!.clip.frameId === frame?.id), tree: subjectTree(doc, roots) };
}

const overlaps = (a: Clip, b: Clip) => a.startMs < b.startMs + b.durationMs && b.startMs < a.startMs + a.durationMs;

/** Where each leaf a root creates must land so the rebuilt layers keep their place among the rest. */
function placementsFor(doc: MotionDocument, plan: Plan, out: ReifyContext["outside"]): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (plan.comp) return result;
  const subject = new Set(flattenTree(plan.tree).map((n) => n.clip.id));
  for (const root of plan.tree) {
    if (root.clip.kind === "audio") continue;
    const scope = doc.tracks[root.trackIndex]?.groupId ?? null;
    let above: Clip | null = null;
    for (let i = root.trackIndex - 1; i >= 0 && !above; i--) {
      const t = doc.tracks[i]!;
      if ((t.groupId ?? null) !== scope) continue;
      above = t.clips.find((c) => !subject.has(c.id) && c.kind !== "audio" && c.frameId === root.clip.frameId && overlaps(c, root.clip)) ?? null;
    }
    const where = above ? { below: out("clip", above.id) } : scope ? { groupId: out("clip", scope) } : null;
    if (!where) continue;
    for (const n of flattenTree([root])) if (n.clip.kind !== "group") result.set(n.clip.id, where);
  }
  return result;
}

/** Bottom of the stack first — the order a script creates layers in so each lands on the last. */
function bottomUp(nodes: readonly SubjectNode[]): SubjectNode[] {
  return [...nodes].sort((a, b) => b.trackIndex - a.trackIndex || a.clip.startMs - b.clip.startMs);
}

export async function reify(doc: MotionDocument, target: ReifyTarget, opts: ReifyOptions = {}): Promise<ReifyResult> {
  const plan = planFor(doc, target);
  const flat = flattenTree(plan.tree);
  const probe = new Builder(doc, [], new Map());
  const b = new Builder(doc, flat.map((n) => n.clip.id), placementsFor(doc, plan, probe.outside.bind(probe)));

  if ("part" in target) {
    const r = REIFIERS.get(target.part);
    if (!plan.frame || !r?.part || !r.part(plan.frame, target.id, b)) throw new Error(`Nothing to print for ${target.part} "${target.id}".`);
    return { code: printProgram(finalize(b)), warnings: b.warnings, owns: { clipIds: [], frameIds: [] }, exact: true };
  }
  if (!plan.frame || (!flat.length && !plan.comp)) throw new Error("Nothing to print — select layers or a comp.");
  const frame = plan.frame;

  if (plan.comp) {
    const c = plan.comp;
    const ref = b.call(
      "frame.create",
      {
        name: c.name,
        ...(c.mode !== "timeline" ? { mode: c.mode } : {}),
        width: c.width,
        height: c.height,
        ...(c.background !== "#0E0E11" ? { background: c.background } : {}),
        ...(c.fps !== 30 ? { fps: c.fps } : {}),
        ...(c.durationMs ? { durationMs: c.durationMs } : {}),
      },
      { name: c.name },
    );
    b.frame = ref.at("id");
    b.bindId(c.id, b.frame);
    b.gap();
  }

  // Create: children before the group that holds them, bottom of each stack first.
  const creates = new Map<string, number>();
  const walk = (nodes: readonly SubjectNode[]) => {
    for (const n of bottomUp(nodes)) {
      if (n.children.length) walk(n.children);
      const creator = creatorFor(n.clip.kind);
      const before = b.stmts.length;
      if (!creator?.print) {
        b.warn(`"${n.clip.name}" (${n.clip.kind}) has no code form yet — it is left out.`);
        continue;
      }
      creator.print(n.clip, b);
      creates.set(n.clip.id, before);
    }
  };
  walk(plan.tree);

  // Base values the create call did not set — measured on a first run.
  const focus = frame.id;
  const base = produce(doc, (d) => void clearScriptOutput(d, { clipIds: plan.roots, frameIds: plan.comp ? [plan.comp.id] : [] }));
  const live = (scope: Scope, clipId: string): string | null => {
    const ref = b.layerRefs.get(clipId);
    const v = ref ? resolveValue(ref, scope) : null;
    return typeof v === "string" ? v : null;
  };
  const registry = opts.registry;
  if (registry) {
    const first = await execute(registry, base, plan.comp ? null : focus, finalize(b));
    const extra = new Map<number, Array<{ clip: Clip; values: Record<string, unknown> }>>();
    for (const n of flat) {
      const at = creates.get(n.clip.id);
      const id = live(first.scope, n.clip.id);
      const made = id ? locateClip(first.doc, id)?.clip : null;
      if (at === undefined || !made) continue;
      const values = staticDiff(n.clip, made);
      if (!Object.keys(values).length) continue;
      const stmt = b.stmts.slice(at).find((s) => s.t === "call");
      if (stmt?.t === "call" && stmt.command === "layer.create") stmt.input.set = { ...((stmt.input.set as object) ?? {}), ...values };
      else {
        const slot = b.stmts.findIndex((s, i) => i > at && s.t === "call" && b.layerRefs.get(n.clip.id)?.binding === s.bind);
        (extra.get(slot) ?? extra.set(slot, []).get(slot)!).push({ clip: n.clip, values });
      }
    }
    // Groups, rigs and switches take theirs right after they are made.
    for (const [slot, list] of [...extra.entries()].sort((x, y) => y[0] - x[0])) {
      const stmts = list.map(({ clip, values }) => ({ t: "call" as const, command: "layer.set", input: { ids: b.layer(clip.id), values, mode: "base" }, bind: { name: "_", used: false } }));
      b.stmts.splice(slot + 1, 0, ...stmts);
    }
  }

  // Layer aspects, in printer order, once everything exists.
  const layerPrinters = inPhase("layer");
  for (const [, r] of layerPrinters) {
    for (const n of flat) {
      if (!b.layerRefs.has(n.clip.id)) continue;
      r.print?.(n.clip, b);
    }
  }
  if (plan.comp) for (const [, r] of inPhase("comp")) r.comp?.(plan.comp, b);

  let program = finalize(b);
  const owns = { clipIds: plan.comp ? [] : [...plan.roots], frameIds: plan.comp ? [plan.comp.id] : [] };
  const header = plan.comp
    ? [`"${plan.comp.name}" as code. Run in replace mode to rebuild it from this file.`]
    : [`${plan.roots.length === 1 ? `"${locateClip(doc, plan.roots[0]!)!.clip.name}"` : `${plan.roots.length} layers`} as code — runs in \`here\`. Edit, then run in replace mode to rebuild.`];
  if (!registry) return { code: printProgram(program, header), warnings: b.warnings, owns, exact: false };

  // Run, measure, append what the verbs could not say.
  const run1 = await execute(registry, base, plan.comp ? null : focus, program);
  for (const e of run1.errors) b.warn(e);
  const residual: Stmt[] = [];
  const pairs = flat.map((n) => ({ orig: n.clip, id: live(run1.scope, n.clip.id) })).filter((p): p is { orig: Clip; id: string } => !!p.id && !!locateClip(run1.doc, p.id));
  const labels = new Map(pairs.flatMap((p, i) => [[p.orig.id, `L${i}`], [p.id, `L${i}`]] as const));
  const compId = plan.comp ? (resolveValue(b.frame, run1.scope) as string | undefined) : focus;
  const canonO = canonicalClips(doc, pairs.map((p) => p.orig), { label: (id) => labels.get(id) ?? id, frameId: plan.comp?.id ?? focus });
  const canonS = canonicalClips(run1.doc, pairs.map((p) => locateClip(run1.doc, p.id)!.clip), { label: (id) => labels.get(id) ?? id, frameId: compId });
  const mk = (command: string, input: Record<string, unknown>): Stmt => ({ t: "call", command, input, bind: { name: "_", used: false } });
  for (const p of pairs) {
    const made = locateClip(run1.doc, p.id)!.clip;
    const ref = b.layer(p.orig.id);
    // An id a verb minted but never returned (a contour's, a range's) that other
    // data names: the script cannot know the new one, so it keeps the old one.
    const ops: PatchOp[] = [];
    const minted = new Map(definedIds(made).map((d) => [d.path, d.id]));
    for (const d of definedIds(p.orig)) {
      const now = minted.get(d.path);
      if (now && now !== d.id && b.referenced(d.id) && !b.ids.has(d.id)) ops.push({ op: "set", path: `${d.path}.id`, value: d.id });
    }
    residualOps(p.orig, made, canonO.get(p.orig.id), canonS.get(p.id), "", ops, (id) => b.referenced(id));
    const steps: Stmt[] = [];
    if (p.orig.kind === "text" && made.kind === "text" && p.orig.text !== made.text) steps.push(mk("text.set", { id: ref, text: p.orig.text }));
    if (p.orig.startMs !== made.startMs || p.orig.durationMs !== made.durationMs) {
      steps.push(mk("timeline.trim", { id: ref, startMs: p.orig.startMs, endMs: p.orig.startMs + p.orig.durationMs }));
    }
    if (ops.length) steps.push(mk("layer.patch", { id: ref, ops }));
    if (steps.length) residual.push(...steps);
  }
  if (plan.comp && compId) {
    const madeFrame = run1.doc.frames.find((f) => f.id === compId);
    if (madeFrame) {
      const [co, cs] = [canonicalFrameOf(doc, plan.comp, "@comp"), canonicalFrameOf(run1.doc, madeFrame, "@comp")];
      const ops: PatchOp[] = [];
      residualOps(stripFrame(plan.comp), stripFrame(madeFrame), co, cs, "", ops, () => true);
      const frameOps = ops.filter((o) => !["mode", "stillMs"].includes(o.path.split(/[.[]/)[0]!));
      if (frameOps.length) residual.push(mk("frame.update", { id: b.frame, ops: frameOps }));
    }
  }
  if (residual.length) {
    b.gap();
    b.comment("Exact details the calls above do not cover.");
    b.stmts.push(...residual);
    program = finalize(b);
  }

  // Verify: run it all once more and compare.
  const run2 = await execute(registry, base, plan.comp ? null : focus, program);
  for (const e of run2.errors) b.warn(e);
  let exact: boolean;
  if (plan.comp) {
    const made = run2.doc.frames.find((f) => f.id === resolveValue(b.frame, run2.scope));
    const rootsAfter = made ? run2.doc.tracks.filter((t) => !t.groupId).flatMap((t) => t.clips.filter((c) => c.frameId === made.id).map((c) => c.id)) : [];
    const eq = reifyEqual({ doc, roots: plan.roots, frameId: plan.comp.id }, { doc: run2.doc, roots: rootsAfter, frameId: made?.id });
    const fd = made ? canonicalDiff(canonicalFrameOf(doc, plan.comp, "@comp"), canonicalFrameOf(run2.doc, made, "@comp")) : ["the comp was not made"];
    exact = eq.equal && !fd.length;
    for (const d of [...eq.diffs, ...fd.map((x) => `comp ${x}`)]) b.warn(`Not reproduced: ${d}`);
  } else {
    const rootsAfter = plan.roots.map((id) => live(run2.scope, id)).filter((x): x is string => !!x);
    const eq = reifyEqual({ doc, roots: plan.roots, frameId: focus }, { doc: run2.doc, roots: rootsAfter, frameId: focus });
    exact = eq.equal;
    for (const d of eq.diffs) b.warn(`Not reproduced: ${d}`);
  }
  return { code: printProgram(program, header), warnings: b.warnings, owns, exact };
}

/** The scalar base values (static property paths) where `made` differs from `orig`. */
function staticDiff(orig: Clip, made: Clip): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of animatablePaths(made)) {
    if (SKIP_SET.has(p) || /[a-z]+_[0-9a-z]{12}/.test(p) || /^(pose|key|input|bone|lfx|tfx|afx|mdf|mod|force|fill|stroke)\./.test(p)) continue;
    const a = getPath(orig, p);
    const m = getPath(made, p);
    if (a === undefined || !(typeof a === "number" || typeof a === "string" || typeof a === "boolean")) continue;
    if (a !== m) out[p] = a;
  }
  return out;
}

const SKIP_SET = new Set(["x", "y", "text", "geometry", "switch", "capture"]);

function animatablePaths(clip: Clip): string[] {
  return clipAnimatableProperties(clip).map((p) => p.path);
}
function getPath(clip: Clip, path: string): unknown {
  return getClipProperty(clip, path);
}

function stripFrame(f: Frame): Record<string, unknown> {
  const { id: _i, x: _x, y: _y, pageId: _p, playheadMs: _ph, pluginData: _pd, name: _n, width: _w, height: _h, ...rest } = f;
  void [_i, _x, _y, _p, _ph, _pd, _n, _w, _h];
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}

/** A comp in canonical form, ids defined inside it renamed by place. */
function canonicalFrameOf(doc: MotionDocument, f: Frame, label: string): unknown {
  const stripped = { ...stripFrame(f), id: f.id };
  return canonicalClips(doc, [stripped as unknown as Clip], { label: () => label }).get(f.id);
}
