import { createId } from "../ids";
import type { MotionDocument, Script, ScriptFolder } from "../schema";

/**
 * SCRIPT FILES — the project's scripts as a file tree addressed by PATH
 * (`intro/title.js`), the one name a person, a chatbox and an agent all use for
 * the same file. Folders are organisation only, like media folders.
 */

export const SCRIPT_EXT = ".js";

/** `intro/title.js` for a script; folders joined with `/`. */
export function scriptPath(doc: Pick<MotionDocument, "scriptFolders">, script: Pick<Script, "name" | "folderId">): string {
  return [...folderChain(doc.scriptFolders, script.folderId).map((f) => f.name), script.name].join("/");
}

function folderChain(folders: readonly ScriptFolder[], id: string | null): ScriptFolder[] {
  const out: ScriptFolder[] = [];
  const seen = new Set<string>();
  let cur = id ? folders.find((f) => f.id === id) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? folders.find((f) => f.id === cur!.parentId) : undefined;
  }
  return out;
}

/** A file name with the extension a script carries — `title` → `title.js`. */
export function normalizeScriptName(name: string): string {
  const base = name.trim().replace(/[\\/]+/g, "-") || "untitled";
  return base.endsWith(SCRIPT_EXT) ? base : `${base}${SCRIPT_EXT}`;
}

/**
 * A script by id, path or bare file name. A bare name matches only when it is
 * unambiguous — "title.js" in two folders is a question, not an answer.
 */
export function findScript(doc: Pick<MotionDocument, "scripts" | "scriptFolders">, ref: string): Script | undefined {
  const byId = doc.scripts.find((s) => s.id === ref);
  if (byId) return byId;
  const want = normalizePath(ref);
  const byPath = doc.scripts.find((s) => scriptPath(doc, s) === want);
  if (byPath) return byPath;
  const byName = doc.scripts.filter((s) => s.name === want);
  return byName.length === 1 ? byName[0] : undefined;
}

function normalizePath(path: string): string {
  const parts = path.split("/").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "";
  parts[parts.length - 1] = normalizeScriptName(parts[parts.length - 1]!);
  return parts.join("/");
}

/** The folder at `a/b`, created as needed (mutates a draft). Empty → root. */
export function ensureScriptFolder(draft: MotionDocument, path: string): string | null {
  let parentId: string | null = null;
  for (const name of path.split("/").map((p) => p.trim()).filter(Boolean)) {
    const found: ScriptFolder | undefined = draft.scriptFolders.find((f) => f.parentId === parentId && f.name === name);
    if (found) {
      parentId = found.id;
      continue;
    }
    const folder: ScriptFolder = { id: createId("sfold"), name, parentId };
    draft.scriptFolders.push(folder);
    parentId = folder.id;
  }
  return parentId;
}

/** `name` made unique among its siblings: `scene.js` → `scene 2.js`. */
export function uniqueScriptName(doc: Pick<MotionDocument, "scripts">, folderId: string | null, name: string, exceptId?: string): string {
  const wanted = normalizeScriptName(name);
  const taken = new Set(doc.scripts.filter((s) => s.folderId === folderId && s.id !== exceptId).map((s) => s.name));
  if (!taken.has(wanted)) return wanted;
  const stem = wanted.slice(0, -SCRIPT_EXT.length);
  for (let n = 2; ; n++) {
    const next = `${stem} ${n}${SCRIPT_EXT}`;
    if (!taken.has(next)) return next;
  }
}

/**
 * Create the script at `path`, or overwrite its source when it exists. The ONE
 * write every caller uses — the explorer's New File, `script.save`, a paste.
 */
export function saveScript(draft: MotionDocument, path: string, source: string): Script {
  const existing = findScript(draft, path);
  if (existing) {
    existing.source = source;
    return existing;
  }
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop() ?? "untitled";
  const folderId = ensureScriptFolder(draft, parts.join("/"));
  const script: Script = {
    id: createId("script"),
    name: uniqueScriptName(draft, folderId, name),
    folderId,
    source,
    onRun: "replace",
    output: { clipIds: [], frameIds: [] },
  };
  draft.scripts.push(script);
  return script;
}

/** Delete a folder with everything filed under it. */
export function deleteScriptFolder(draft: MotionDocument, folderId: string): void {
  const doomed = new Set<string>([folderId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of draft.scriptFolders) {
      if (f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) {
        doomed.add(f.id);
        grew = true;
      }
    }
  }
  draft.scriptFolders = draft.scriptFolders.filter((f) => !doomed.has(f.id));
  draft.scripts = draft.scripts.filter((s) => !s.folderId || !doomed.has(s.folderId));
}
