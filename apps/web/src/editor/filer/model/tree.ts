/**
 * The headless file-manager tree — pure, item-agnostic data + derivations.
 *
 * A "filer" is a tree of folders and items (`parentId`, null = root). The item
 * payload `T` is opaque here: projects put a `ProjectRecord`, the media library
 * will put an `Asset`. Everything the UI needs — the current folder's contents,
 * the breadcrumb path, sorted + searched views, folder previews — is derived by
 * the pure functions below. No React, no storage, no DOM: trivially testable and
 * reused verbatim by every surface (see `adapter.ts`).
 */

export interface FilerFolder {
  kind: "folder";
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FilerItem<T = unknown> {
  kind: "item";
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Opaque surface payload the card renders (e.g. a ProjectRecord). */
  data: T;
}

export type FilerNode<T = unknown> = FilerFolder | FilerItem<T>;

export interface FilerTree<T = unknown> {
  folders: FilerFolder[];
  items: FilerItem<T>[];
}

export type SortKey = "updated" | "created" | "name";
export type SortDir = "asc" | "desc";
export interface SortSpec {
  key: SortKey;
  dir: SortDir;
}

export interface SearchSpec {
  query: string;
  /** Search the whole subtree instead of just the current folder. */
  recursive: boolean;
  /** Every item in the tree, folders ignored — Home's "Recents". */
  flat?: boolean;
}

/** The derived, ready-to-render view for one folder + toolbar state. */
export interface FilerView<T = unknown> {
  /** Root → current folder chain (empty at root). */
  path: FilerFolder[];
  folders: FilerFolder[];
  items: FilerItem<T>[];
  /** Visible node ids in render order — the selection model's ordered domain. */
  order: string[];
  /** True when the view is a search result set (flattened, folders hidden). */
  searching: boolean;
}

// ── Derivations ────────────────────────────────────────────────────────────

/** Breadcrumb chain from root down to `folderId` (inclusive). */
export function buildPath<T>(tree: FilerTree<T>, folderId: string | null): FilerFolder[] {
  const byId = new Map(tree.folders.map((f) => [f.id, f] as const));
  const path: FilerFolder[] = [];
  let cur = folderId;
  const guard = new Set<string>();
  while (cur) {
    const folder = byId.get(cur);
    if (!folder || guard.has(cur)) break;
    guard.add(cur);
    path.unshift(folder);
    cur = folder.parentId;
  }
  return path;
}

/** True if `ancestorId` is `folderId` or one of its ancestors (cycle-safe). */
export function isDescendant<T>(tree: FilerTree<T>, folderId: string | null, ancestorId: string): boolean {
  const byId = new Map(tree.folders.map((f) => [f.id, f] as const));
  let cur = folderId;
  const guard = new Set<string>();
  while (cur) {
    if (cur === ancestorId) return true;
    if (guard.has(cur)) break;
    guard.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

/** All items anywhere beneath `folderId` (its whole subtree). */
export function descendantItems<T>(tree: FilerTree<T>, folderId: string): FilerItem<T>[] {
  const childFolders = new Map<string | null, FilerFolder[]>();
  for (const f of tree.folders) {
    const list = childFolders.get(f.parentId) ?? [];
    list.push(f);
    childFolders.set(f.parentId, list);
  }
  const out: FilerItem<T>[] = [];
  const stack = [folderId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const it of tree.items) if (it.parentId === id) out.push(it);
    for (const f of childFolders.get(id) ?? []) stack.push(f.id);
  }
  return out;
}

/** Direct child count (folders + items) of a folder — for folder card meta. */
export function childCount<T>(tree: FilerTree<T>, folderId: string): number {
  let n = 0;
  for (const f of tree.folders) if (f.parentId === folderId) n++;
  for (const it of tree.items) if (it.parentId === folderId) n++;
  return n;
}

function compare(a: FilerNode, b: FilerNode, sort: SortSpec): number {
  const mul = sort.dir === "asc" ? 1 : -1;
  if (sort.key === "name") return mul * a.name.localeCompare(b.name, undefined, { numeric: true });
  const av = sort.key === "created" ? a.createdAt : a.updatedAt;
  const bv = sort.key === "created" ? b.createdAt : b.updatedAt;
  return mul * (av - bv);
}

function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

/**
 * Build the view for one folder given sort + search. Folders always sort ahead
 * of items. Search: empty query → the folder's direct children; `*` → every
 * item in scope regardless of name; otherwise a name filter. Recursive (or `*`)
 * searches the whole subtree and flattens to a single item list (folders hidden).
 */
export function computeView<T>(
  tree: FilerTree<T>,
  currentFolderId: string | null,
  sort: SortSpec,
  search: SearchSpec,
): FilerView<T> {
  const path = buildPath(tree, currentFolderId);
  const query = search.query.trim();
  const wildcard = query === "*";
  const recursive = search.recursive || wildcard;

  let folders: FilerFolder[];
  let items: FilerItem<T>[];

  if (search.flat) {
    folders = [];
    items = query && !wildcard ? tree.items.filter((it) => matches(it.name, query)) : tree.items.slice();
  } else if (query && recursive) {
    // Flattened subtree search — hide folders, show matching items only.
    const scope = currentFolderId === null ? tree.items : descendantItems(tree, currentFolderId);
    folders = [];
    items = wildcard ? scope.slice() : scope.filter((it) => matches(it.name, query));
  } else {
    folders = tree.folders.filter((f) => f.parentId === currentFolderId);
    items = tree.items.filter((it) => it.parentId === currentFolderId);
    if (query) {
      folders = folders.filter((f) => matches(f.name, query));
      items = items.filter((it) => matches(it.name, query));
    }
  }

  folders.sort((a, b) => compare(a, b, sort));
  items.sort((a, b) => compare(a, b, sort));
  const order = [...folders.map((f) => f.id), ...items.map((it) => it.id)];
  return { path, folders, items, order, searching: Boolean(query) };
}
