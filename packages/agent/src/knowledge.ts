import type { ToolDef } from "./types";

/**
 * KNOWLEDGE PACKS — skills and design systems, one concept.
 *
 * A pack is a folder of Markdown with an entry file: `SKILL.md` for a skill
 * (how to work), `DESIGN.md` for a design system (what things should look
 * like). Both follow the Agent Skills layout — YAML frontmatter with a name and
 * description, a body, and `references/` the model reads only when it needs
 * them — so a skill written for Claude Code or any other agent drops in as is,
 * and ours can be published for them.
 *
 * Progressive disclosure keeps them cheap: the ENTRY of every enabled pack is
 * in the system prompt (cached after the first turn); everything else is
 * listed by path and read on demand through `skill_read`. A pack can come from
 * the app itself, a GitHub repo, a URL, text the user pasted or files they
 * dropped, or a plugin — which is how a plugin teaches the agent to use it.
 */

export type PackKind = "skill" | "design-system";

export type PackSource =
  | { type: "builtin" }
  | { type: "github"; repo: string; ref?: string; path?: string }
  | { type: "url"; url: string }
  | { type: "local" }
  | { type: "plugin"; pluginId: string };

export interface KnowledgePack {
  id: string;
  kind: PackKind;
  name: string;
  description: string;
  version?: string;
  source: PackSource;
  /** Path → text. Paths are relative to the pack root. */
  files: Record<string, string>;
  /** The file that goes in the prompt: SKILL.md, DESIGN.md, or README.md. */
  entry: string;
  enabled: boolean;
  updatedAt: number;
}

const ENTRY_NAMES: Record<PackKind, string[]> = {
  skill: ["SKILL.md", "skill.md", "README.md"],
  "design-system": ["DESIGN.md", "design.md", "README.md", "SKILL.md"],
};

/** Split YAML-ish frontmatter off a Markdown file. Flat `key: value` lines only. */
export function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: md.slice(m[0].length) };
}

/** Build a pack from files, finding its entry and reading name/description off it. */
export function packFromFiles(
  kind: PackKind,
  files: Record<string, string>,
  source: PackSource,
  fallbackName = "Untitled",
): KnowledgePack {
  const names = Object.keys(files);
  const entry =
    ENTRY_NAMES[kind].map((n) => names.find((p) => p === n || p.endsWith(`/${n}`))).find(Boolean) ??
    names.find((p) => p.toLowerCase().endsWith(".md")) ??
    names[0];
  if (!entry) throw new Error("The pack has no files.");
  const { meta, body } = parseFrontmatter(files[entry]!);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1];
  const name = meta.name ?? heading ?? fallbackName;
  return {
    id: `${kind}:${slug(name)}:${Date.now().toString(36)}`,
    kind,
    name,
    description: meta.description ?? firstParagraph(body),
    version: meta.version,
    source,
    files,
    entry,
    enabled: true,
    updatedAt: Date.now(),
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "pack";
}

function firstParagraph(body: string): string {
  const p = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .find((b) => b && !b.startsWith("#"));
  return (p ?? "").replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Read a pack from a GitHub repository — `owner/repo`, a repo URL, or a URL to
 * a folder inside one (`…/tree/main/skills/<name>`). Public repos need no
 * token. Only text files come across, under a size budget, because a skill is
 * words and a repo is not always only a skill.
 */
export async function fetchGithubPack(kind: PackKind, input: string, signal?: AbortSignal): Promise<KnowledgePack> {
  const m =
    /github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^/\s]+)\/?(.*))?/.exec(input) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(input.trim());
  if (!m) throw new Error("Paste a GitHub repo (owner/repo) or a folder URL inside one.");
  const [, owner, rawRepo, refIn, pathIn] = m;
  const repo = rawRepo!.replace(/\.git$/, "");
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const ref = refIn ?? ((await getJson(api, signal)) as { default_branch?: string }).default_branch ?? "main";
  const tree = (await getJson(`${api}/git/trees/${encodeURIComponent(ref)}?recursive=1`, signal)) as {
    tree?: Array<{ path: string; type: string; size?: number }>;
  };
  const root = (pathIn ?? "").replace(/\/$/, "");
  const wanted = (tree.tree ?? [])
    .filter((t) => t.type === "blob" && /\.(md|mdx|txt|json|ya?ml|css)$/i.test(t.path))
    .filter((t) => !root || t.path === root || t.path.startsWith(`${root}/`))
    .filter((t) => (t.size ?? 0) < 400_000)
    .slice(0, 80);
  if (!wanted.length) throw new Error("No Markdown found there.");
  const files: Record<string, string> = {};
  let budget = 2_000_000;
  for (const t of wanted) {
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${t.path}`, { signal });
    if (!res.ok) continue;
    const text = await res.text();
    budget -= text.length;
    if (budget < 0) break;
    files[root ? t.path.slice(root.length + 1) || t.path : t.path] = text;
  }
  return packFromFiles(kind, files, { type: "github", repo: `${owner}/${repo}`, ref, path: root || undefined }, repo);
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { accept: "application/vnd.github+json" } });
  if (res.status === 404) throw new Error("GitHub says that repo or folder does not exist (or it is private).");
  if (res.status === 403) throw new Error("GitHub's rate limit for anonymous requests was hit. Try again in a few minutes.");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return res.json();
}

// ── The prompt ───────────────────────────────────────────────────────────────

export const SKILL_READ_TOOL: ToolDef = {
  name: "skill_read",
  description:
    "Read a file from an enabled skill or design system — a reference the entry file points to. Read what the task needs, when it needs it; do not read everything up front.",
  inputSchema: {
    type: "object",
    properties: {
      pack: { type: "string", description: "The pack's name as listed in the system prompt." },
      path: { type: "string", description: "A path listed under that pack." },
    },
    required: ["pack", "path"],
  },
  effect: "read",
};

export function readPackFile(packs: KnowledgePack[], packName: string, path: string): string {
  const pack = packs.find((p) => p.enabled && (p.name === packName || p.id === packName));
  if (!pack) throw new Error(`No enabled pack "${packName}". Enabled: ${packs.filter((p) => p.enabled).map((p) => p.name).join(", ")}.`);
  const file = pack.files[path] ?? pack.files[path.replace(/^\.?\//, "")];
  if (file === undefined) throw new Error(`"${pack.name}" has no "${path}". Files: ${Object.keys(pack.files).join(", ")}.`);
  return file;
}

export interface PromptInput {
  /** Who the agent is and how it works — the product's own preface. */
  identity: string;
  packs: KnowledgePack[];
  /** The user's own standing instructions, verbatim. */
  instructions?: string;
}

/**
 * The system prompt. ORDER IS CACHE: everything here is stable across a chat
 * (identity, then packs sorted by id, then instructions), so it is written once
 * and read from cache on every later turn. Anything that changes per turn — the
 * selection, the playhead — goes in the user message, never here.
 */
export function buildSystemPrompt(input: PromptInput): string {
  const sections: string[] = [input.identity.trim()];
  const enabled = input.packs.filter((p) => p.enabled).sort((a, b) => a.id.localeCompare(b.id));
  for (const kind of ["skill", "design-system"] as const) {
    for (const pack of enabled.filter((p) => p.kind === kind)) {
      const { body } = parseFrontmatter(pack.files[pack.entry] ?? "");
      const others = Object.keys(pack.files)
        .filter((f) => f !== pack.entry)
        .sort();
      const tag = kind === "skill" ? "skill" : "design_system";
      sections.push(
        `<${tag} name="${pack.name}"${pack.version ? ` version="${pack.version}"` : ""}>\n${body.trim()}${
          others.length ? `\n\nFiles you can read with skill_read (pack "${pack.name}"):\n${others.map((f) => `- ${f}`).join("\n")}` : ""
        }\n</${tag}>`,
      );
    }
  }
  if (input.instructions?.trim()) {
    sections.push(`<user_instructions>\nThe user's standing instructions. Follow them unless they conflict with safety.\n${input.instructions.trim()}\n</user_instructions>`);
  }
  return sections.join("\n\n");
}
