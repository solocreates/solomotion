import type { AnyCommand, CommandRegistry } from "../api/registry";
import { schemaSignature } from "../api/zod-reflect";
import { visibleFrames } from "../api/lookup";
import { CATALOGS, listCatalog, type CatalogId } from "../api/commands/animate";
import { frameDurationMs } from "../timeline/ops";
import { PROPERTY_DEFS } from "../animation/properties";
import type { MotionDocument, Script } from "../schema";
import { scriptPath } from "./files";

/**
 * THE BRIEF — what a chatbox needs to write a script for THIS project, as
 * sections the person picks from.
 *
 * Every section is derived from a source that already exists: the rules and
 * the craft from the skill's own files, the catalogs from `catalog.list`, the
 * API from the live registry, the project from the document, the person's own
 * skills and design systems from their knowledge packs. Nothing is written
 * here twice, so a brief can never teach something the app no longer does.
 *
 * Sections are cheap text; a FOCUS (`focus.ts`) is only a list of section ids.
 */

/** Commands a script cannot call (they would recurse into the runtime). */
export const SCRIPT_EXCLUDED_COMMANDS = new Set(["script.run", "api.batch"]);

export function scriptCallable(def: Pick<AnyCommand, "id">): boolean {
  return !SCRIPT_EXCLUDED_COMMANDS.has(def.id);
}

/** One command as a script calls it: `ac.layer.create(input)`. */
export function scriptSignature(def: AnyCommand, depth = 1): string {
  return `ac.${def.id}(${schemaSignature(def.input, { depth, maxArms: 6 })})`;
}

function comment(text: string): string {
  return text
    .split("\n")
    .map((l) => `// ${l}`.trimEnd())
    .join("\n");
}

/** Verbs as a `.d.ts`-shaped block — summary, usage notes, then the signature. */
function verbsBlock(defs: readonly AnyCommand[], depth: number): string {
  const out = ["```ts"];
  for (const def of [...defs].sort((a, b) => a.id.localeCompare(b.id))) {
    out.push(comment(`${def.effect === "read" ? "(read) " : ""}${def.summary}${def.details ? `\n${def.details}` : ""}`), scriptSignature(def, depth), "");
  }
  out[out.length - 1] = "```";
  return out.join("\n");
}

/** The callable verbs grouped by namespace (`layer`, `keyframes`…). */
export function scriptNamespaces(registry: CommandRegistry): Map<string, AnyCommand[]> {
  const groups = new Map<string, AnyCommand[]>();
  for (const def of registry.list().filter(scriptCallable)) {
    const ns = def.id.split(".")[0]!;
    (groups.get(ns) ?? groups.set(ns, []).get(ns)!).push(def);
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

/** The whole API in one block. */
export function scriptReference(registry: CommandRegistry, depth = 1): string {
  return verbsBlock([...scriptNamespaces(registry).values()].flat(), depth);
}

// ── Project ──────────────────────────────────────────────────────────────────

const MAX_LAYERS_PER_COMP = 30;
const MAX_ASSETS = 60;

/** Where the person is: comps, their top layers, media — ids included, so a script can name them. */
export function scriptProjectContext(doc: MotionDocument, focusFrameId: string | null): string {
  const lines: string[] = [`Project "${doc.name}"`];
  for (const f of visibleFrames(doc)) {
    const focus = f.id === focusFrameId ? " ← here (the comp the script runs in)" : "";
    lines.push(`- comp ${f.id} "${f.name}" ${f.width}×${f.height} @${f.fps}fps ${Math.round(frameDurationMs(doc, f))}ms${focus}`);
    const layers = doc.tracks.filter((t) => !t.groupId).flatMap((t) => t.clips.filter((c) => c.frameId === f.id));
    for (const c of layers.slice(0, MAX_LAYERS_PER_COMP)) lines.push(`  - ${c.kind} ${c.id} "${c.name}"`);
    if (layers.length > MAX_LAYERS_PER_COMP) lines.push(`  - …${layers.length - MAX_LAYERS_PER_COMP} more (ac.layers.list)`);
  }
  if (doc.assets.length) {
    lines.push("Media:");
    for (const a of doc.assets.slice(0, MAX_ASSETS)) lines.push(`- ${a.kind} ${a.id} "${a.name}"`);
    if (doc.assets.length > MAX_ASSETS) lines.push(`- …${doc.assets.length - MAX_ASSETS} more (ac.media.list)`);
  }
  return lines.join("\n");
}

// ── Catalogs ─────────────────────────────────────────────────────────────────

const CATALOG_TITLES: Record<CatalogId, string> = {
  "layer-effects": "Layer effects",
  "text-effects": "Text effects",
  "audio-effects": "Audio effects",
  animations: "Animation presets",
  "text-templates": "Text templates",
  transitions: "Transitions",
  easings: "Easings",
  "blend-modes": "Blend modes",
  primitives: "3D primitives",
  modifiers: "3D modifiers",
  materials: "3D materials",
  lights: "3D lights",
  forces: "Physics forces",
  emitters: "Particle emitters and looks",
  "sound-sets": "Sound sets (voices played as notes)",
  looks: "Looks (whole effect stacks by name: Paper cut-out, Stop motion, Neon…)",
};

/** A catalog row as one line: its id, then every short fact it carries. */
function catalogLine(row: unknown): string {
  if (typeof row !== "object" || row === null) return `- ${String(row)}`;
  const r = row as Record<string, unknown>;
  const id = r.id ?? r.type;
  const facts = Object.entries(r)
    .filter(([k, v]) => k !== "id" && k !== "type" && (typeof v === "string" || typeof v === "number" || (Array.isArray(v) && v.every((x) => typeof x === "string"))))
    .map(([, v]) => (Array.isArray(v) ? v.join("/") : String(v)))
    .filter(Boolean);
  return `- \`${String(id)}\`${facts.length ? ` — ${facts.join(" · ")}` : ""}`;
}

function catalogRows(id: CatalogId): unknown[] {
  const rows = listCatalog(id);
  return Array.isArray(rows) ? rows : [];
}

// ── Property paths ───────────────────────────────────────────────────────────

/**
 * Every static animatable property — the names `layer.set`, `set:` and
 * `keyframes.set` take — grouped by what they apply to. A model writing
 * blind reaches for CSS and After Effects names (`scaleX`); the real list
 * costs about a thousand tokens and removes the guess.
 */
export function propertyPaths(): string {
  const groups = new Map<string, string[]>();
  for (const d of PROPERTY_DEFS) {
    const key = `${d.group[0]!.toUpperCase()}${d.group.slice(1)} (${[...new Set(d.appliesTo)].join(", ")})`;
    const range = d.min !== undefined || d.max !== undefined ? ` ${d.min ?? ""}..${d.max ?? ""}` : "";
    const fact = d.kind === "number" ? `${JSON.stringify(d.identity)}${range}` : d.kind;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(`\`${d.key}\` ${d.label} [${fact}]`);
  }
  return [
    "## Property paths — what layer.set, `set:` on layer.create and keyframes.set take",
    "`[default range]` for numbers. Per-instance paths — a fill's colour, an effect's field (`fill.<id>.color`, `lfx.<id>.<field>`) — come from `ac.layer.properties({ id })`.",
    ...[...groups].map(([g, items]) => `### ${g}\n${items.join(" · ")}`),
  ].join("\n");
}

// ── Sections ─────────────────────────────────────────────────────────────────

export type BriefGroup = "essentials" | "craft" | "yours" | "catalog" | "api";

/** Group order is the order a model reads them in, task context last. */
export const BRIEF_GROUPS: ReadonlyArray<{ id: BriefGroup; title: string }> = [
  { id: "essentials", title: "Essentials" },
  { id: "craft", title: "Craft" },
  { id: "yours", title: "Your knowledge" },
  { id: "catalog", title: "Catalog" },
  { id: "api", title: "API" },
];

export interface BriefSection {
  /**
   * Stable, so a remembered choice survives a release: `rules`, `project`,
   * `file`, `run`, `instructions`, `skill:<path>`, `pack:<id>`,
   * `catalog:<id>`, `api:<namespace>`.
   */
  id: string;
  group: BriefGroup;
  title: string;
  /** A few words: what it gives the model. */
  blurb: string;
  text: string;
  /** Always included — a brief without it produces scripts that cannot run. */
  locked?: boolean;
  /** The task context: printed last, where a model weighs it most. */
  context?: boolean;
}

export interface BriefPack {
  id: string;
  name: string;
  kind: "skill" | "design-system";
  description: string;
  /** The pack's entry file (SKILL.md / DESIGN.md). */
  entry: string;
}

export interface BriefSources {
  /** The app, as the brief names it. */
  appName: string;
  registry: CommandRegistry;
  doc: MotionDocument;
  focusFrameId: string | null;
  /** The built-in skill, path → text (`SKILL.md`, `references/motion.md`…). */
  skill: Readonly<Record<string, string>>;
  /** Design systems and the person's own skills. */
  packs?: readonly BriefPack[];
  /** The person's standing instructions to agents. */
  instructions?: string;
  script?: Script;
  /** The open file's last run, already formatted for a model. */
  lastRun?: string;
}

/** The skill's index lines — `- \`references/x.md\` — what it covers` — as blurbs. */
function skillIndex(entry: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of entry.matchAll(/^- `(references\/[\w.-]+)` — (.+)$/gm)) out.set(m[1]!, m[2]!.trim());
  return out;
}

function titleOf(text: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? fallback;
}

/** Front matter is for the loader, not the reader. */
function stripFrontMatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

const SCRIPTING = "references/scripting.md";
/** Written for an agent filing reports through a tool a chatbox does not have. */
const NOT_FOR_SCRIPTS = new Set(["references/reporting.md"]);

function short(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function briefSections(src: BriefSources): BriefSection[] {
  const out: BriefSection[] = [];
  const entry = src.skill["SKILL.md"] ?? "";
  const index = skillIndex(entry);

  out.push({
    id: "rules",
    group: "essentials",
    title: "Script rules",
    blurb: "Always included · runtime, re-run, gotchas",
    text: stripFrontMatter(src.skill[SCRIPTING] ?? ""),
    locked: true,
  });
  if (entry) out.push({ id: "skill:SKILL.md", group: "essentials", title: `How ${src.appName} works`, blurb: "Coordinates, time, the command map, craft", text: stripFrontMatter(entry) });

  // The skill's own index order — it reads from fundamentals to specialities.
  const rank = (p: string) => {
    const i = [...index.keys()].indexOf(p);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  for (const path of Object.keys(src.skill).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    if (!path.startsWith("references/") || path === SCRIPTING || NOT_FOR_SCRIPTS.has(path)) continue;
    const text = src.skill[path]!;
    out.push({ id: `skill:${path}`, group: "craft", title: titleOf(text, path), blurb: index.get(path) ?? "", text });
  }

  for (const p of src.packs ?? []) {
    out.push({
      id: `pack:${p.id}`,
      group: p.kind === "design-system" ? "craft" : "yours",
      title: p.name,
      blurb: p.kind === "design-system" ? `Design system${p.description ? ` · ${p.description}` : ""}` : p.description,
      text: stripFrontMatter(p.entry),
    });
  }
  if (src.instructions?.trim()) {
    out.push({ id: "instructions", group: "yours", title: "Your instructions", blurb: "What you tell every agent", text: `# Standing instructions\n\n${src.instructions.trim()}` });
  }

  out.push({ id: "catalog:properties", group: "catalog", title: "Property paths", blurb: `${PROPERTY_DEFS.length} names for set and keyframes`, text: propertyPaths() });
  for (const id of CATALOGS) {
    const rows = catalogRows(id);
    if (!rows.length) continue;
    out.push({
      id: `catalog:${id}`,
      group: "catalog",
      title: CATALOG_TITLES[id],
      blurb: short(rows.length, "id"),
      text: `## ${CATALOG_TITLES[id]} — use these ids exactly\n${rows.map(catalogLine).join("\n")}`,
    });
  }

  for (const [ns, defs] of scriptNamespaces(src.registry)) {
    const verbs = defs.map((d) => d.id.slice(ns.length + 1));
    out.push({
      id: `api:${ns}`,
      group: "api",
      title: `ac.${ns}`,
      blurb: verbs.length > 4 ? `${verbs.slice(0, 4).join(", ")} +${verbs.length - 4}` : verbs.join(", "),
      text: `## ac.${ns}\n${verbsBlock(defs, 1)}`,
    });
  }

  out.push({ id: "project", group: "essentials", title: "This project", blurb: "Comps, layers, media — with ids", text: `## This project\n${scriptProjectContext(src.doc, src.focusFrameId)}`, context: true });
  if (src.script?.source.trim()) {
    const path = scriptPath(src.doc, src.script);
    out.push({ id: "file", group: "essentials", title: "Current file", blurb: path, text: `## Current file: ${path}\n\`\`\`js\n${src.script.source}\n\`\`\``, context: true });
  }
  if (src.lastRun) out.push({ id: "run", group: "essentials", title: "Last run", blurb: "Its result or error", text: `## Its last run\n${src.lastRun}`, context: true });
  return out;
}

const preamble = (appName: string) => [
  `# ${appName} script brief`,
  `Write JavaScript for ${appName}'s Scripts panel. Reply with ONE \`\`\`js block I can paste and run.`,
  "Every command is `await ac.<namespace>.<verb>(input)`. The guides below name commands as tools (`layer_create`) — in a script that is `ac.layer.create`. Use ids from the catalogs exactly; never invent one.",
  "The script runs in `here` — the comp the person is on ({ frameId, name, width, height, fps, durationMs }). Calls without a `frameId` land there; build in it rather than creating a comp, unless asked for one.",
].join("\n\n");

/**
 * The paste: the preamble, then the chosen sections — knowledge first, the
 * task context (project, file, last run) last. Locked sections are always in.
 */
export function composeBrief(sections: readonly BriefSection[], chosen: ReadonlySet<string>, appName: string): string {
  const picked = sections.filter((s) => s.locked || chosen.has(s.id));
  const order = (s: BriefSection) => (s.context ? BRIEF_GROUPS.length : BRIEF_GROUPS.findIndex((g) => g.id === s.group));
  const sorted = picked.map((s, i) => ({ s, i })).sort((a, b) => order(a.s) - order(b.s) || a.i - b.i);
  return [preamble(appName), ...sorted.map(({ s }) => s.text.trim())].join("\n\n---\n\n");
}

/** A rough token count (≈4 chars each) — enough to say "this will not fit". */
export function briefTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
