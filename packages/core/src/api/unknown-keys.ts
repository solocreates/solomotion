import type { ZodTypeAny } from "zod";

/**
 * KEYS THE SCHEMA DROPPED. zod strips object keys it does not know, so a
 * misspelled or misplaced field was accepted and silently ignored: `stroke:
 * {paint: {…}}` drew a WHITE stroke (the field is `color`), `torus {radius,
 * tube}` built a default torus that, scaled up, whited out a whole frame. An
 * agent cannot see a field vanish. Comparing what was sent with what the schema
 * kept finds every one, by path, with the fields that DO exist there.
 */
export interface DroppedKey {
  path: string;
  /** The fields that exist at that place (what the schema kept). */
  known: string[];
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function droppedKeys(sent: unknown, kept: unknown, path = ""): DroppedKey[] {
  if (Array.isArray(sent) && Array.isArray(kept)) {
    return sent.flatMap((s, i) => (i < kept.length ? droppedKeys(s, kept[i], `${path}[${i}]`) : []));
  }
  if (!isPlain(sent) || !isPlain(kept)) return [];
  const out: DroppedKey[] = [];
  for (const [k, v] of Object.entries(sent)) {
    const at = path ? `${path}.${k}` : k;
    if (!(k in kept)) {
      if (v !== undefined) out.push({ path: at, known: Object.keys(kept) });
      continue;
    }
    out.push(...droppedKeys(v, kept[k], at));
  }
  return out;
}

/** The nearest known name, when one is close enough to be a typo. */
export function nearest(word: string, known: readonly string[]): string | null {
  const w = word.toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = distance(w, k.toLowerCase());
    if (d < bestD) (bestD = d), (best = k);
  }
  return best !== null && bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** One line per dropped key, the way an agent can act on it. */
export function describeDropped(dropped: DroppedKey[]): string {
  return dropped
    .slice(0, 6)
    .map((d) => {
      const leaf = d.path.split(/[.[]/).pop()!.replace(/]$/, "");
      const near = nearest(leaf, d.known);
      return `${d.path}: not a field here${near ? ` — did you mean "${near}"?` : ""}${d.known.length ? ` (fields: ${d.known.slice(0, 12).join(", ")})` : ""}`;
    })
    .join("; ");
}

/**
 * The field names a schema declares at a path — the real vocabulary to suggest
 * from (what was kept may be empty: an object with no defaults keeps only what
 * was sent). Unwraps optional / default / nullable / effects / lazy; a union
 * offers every arm's fields.
 */
export function schemaKeysAt(schema: ZodTypeAny, path: string, sent?: unknown): string[] {
  const steps = path.split(/\.|\[(\d+)\]/).filter((s) => s !== undefined && s !== "");
  steps.pop(); // the dropped key itself
  let nodes: ZodTypeAny[] = [schema];
  let value = sent;
  for (const step of steps) {
    const here = value;
    value = isPlain(here) || Array.isArray(here) ? (here as Record<string, unknown>)[step] : undefined;
    nodes = nodes.flatMap((n) => unwrap(n, here)).flatMap((n) => {
      const t = n._def.typeName as string;
      if (t === "ZodObject") {
        const next = (n as unknown as { shape: Record<string, ZodTypeAny> }).shape[step];
        return next ? [next] : [];
      }
      if (t === "ZodArray" && /^\d+$/.test(step)) return [n._def.type as ZodTypeAny];
      if (t === "ZodRecord") return [n._def.valueType as ZodTypeAny];
      return [];
    });
  }
  const keys = new Set<string>();
  for (const n of nodes.flatMap((x) => unwrap(x, value))) {
    if (n._def.typeName === "ZodObject") for (const k of Object.keys((n as unknown as { shape: object }).shape)) keys.add(k);
  }
  return [...keys];
}

/**
 * The object schemas a node stands for. With the value that was SENT there, a
 * discriminated union answers with the one arm that value chose — offering
 * every arm's fields made `layer.create {kind: "shape", rotation}` list text
 * fields, and a text `fills` answer `did you mean "fills"?` (the shape arm's).
 */
function unwrap(n: ZodTypeAny, value?: unknown): ZodTypeAny[] {
  const d = n._def as Record<string, unknown> & { typeName: string };
  const again = (x: unknown) => unwrap(x as ZodTypeAny, value);
  switch (d.typeName) {
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodReadonly":
    case "ZodCatch":
      return again(d.innerType);
    case "ZodEffects":
      return again(d.schema);
    case "ZodLazy":
      return again((d.getter as () => ZodTypeAny)());
    case "ZodBranded":
      return again(d.type);
    case "ZodPipeline":
      return again(d.in);
    case "ZodDiscriminatedUnion": {
      const chosen = isPlain(value) ? (d.optionsMap as Map<unknown, ZodTypeAny>).get(value[d.discriminator as string]) : undefined;
      if (chosen) return again(chosen);
      return (d.options as ZodTypeAny[]).flatMap(again);
    }
    case "ZodUnion": {
      const opts = d.options as ZodTypeAny[];
      return opts.flatMap(again);
    }
    case "ZodIntersection":
      return [...again(d.left), ...again(d.right)];
    default:
      return [n];
  }
}
