/**
 * Folder → files, the headless brain behind "import a folder" (drag a folder
 * onto the media library, or pick one from a menu). Recurses a dropped directory
 * via the HTML5 entries API, with a `<input webkitdirectory>` picker as the
 * fallback where entries aren't available (Safari). Every file keeps its
 * **relative path** so the caller can rebuild the folder as real media bins —
 * dropping `Photos/` lands a `Photos` folder, nested subfolders and all, instead
 * of dumping the contents loose. The caller filters for importable kinds and
 * feeds them to the ONE import pipeline; this file only reads the tree.
 */

/** One file found under a drop/pick, with its path relative to the drop root. */
export interface DroppedFile {
  file: File;
  /** POSIX path relative to what was dropped, e.g. `Photos/trip/a.png`. A loose
   *  (non-foldered) file's relPath is just its name. */
  relPath: string;
}

/** A minimal view of the non-standard FileSystem entries API (Chromium/WebKit). */
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}
interface FsFileEntry extends FsEntry {
  isFile: true;
  file(onSuccess: (f: File) => void, onError?: (e: unknown) => void): void;
}
interface FsDirEntry extends FsEntry {
  isDirectory: true;
  createReader(): {
    readEntries(onSuccess: (entries: FsEntry[]) => void, onError?: (e: unknown) => void): void;
  };
}

const isDir = (e: FsEntry): e is FsDirEntry => e.isDirectory;
const isFile = (e: FsEntry): e is FsFileEntry => e.isFile;

function entryFile(entry: FsFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Read one directory's children (the API pages results — loop until drained). */
function readDir(entry: FsDirEntry): Promise<FsEntry[]> {
  const reader = entry.createReader();
  const all: FsEntry[] = [];
  return new Promise((resolve, reject) => {
    const pump = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          pump();
        }
      }, reject);
    pump();
  });
}

/** Depth-first collect every file under an entry, carrying its relative path. */
async function collectEntry(entry: FsEntry, prefix: string, out: DroppedFile[]): Promise<void> {
  if (isFile(entry)) {
    try {
      out.push({ file: await entryFile(entry), relPath: `${prefix}${entry.name}` });
    } catch {
      /* unreadable file — skip it */
    }
    return;
  }
  if (isDir(entry)) {
    for (const child of await readDir(entry)) await collectEntry(child, `${prefix}${entry.name}/`, out);
  }
}

/**
 * True when a drop carries at least one directory (so the caller knows to take
 * the recursive path instead of the flat `dataTransfer.files`).
 */
export function dropHasDirectory(dt: DataTransfer): boolean {
  return Array.from(dt.items).some((it) => {
    const getEntry = (it as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry;
    return typeof getEntry === "function" && getEntry.call(it)?.isDirectory === true;
  });
}

/**
 * Every file inside a drop WITH its relative path, recursing dropped folders.
 * Falls back to the flat file list (each file's relPath = its name) when the
 * entries API is unavailable, so a plain multi-file drop still works everywhere.
 */
export async function readDataTransferFiles(dt: DataTransfer): Promise<DroppedFile[]> {
  const entries: FsEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const getEntry = (item as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry;
    const entry = typeof getEntry === "function" ? getEntry.call(item) : null;
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return Array.from(dt.files).map((file) => ({ file, relPath: file.name }));

  const out: DroppedFile[] = [];
  for (const entry of entries) await collectEntry(entry, "", out);
  return out;
}

/**
 * Every file inside a drop, flattened (relative paths discarded) — the plain
 * import path for surfaces that don't build folder bins (e.g. the canvas).
 */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  return (await readDataTransferFiles(dt)).map((d) => d.file);
}

/**
 * Open a native folder picker and resolve every file inside it (recursive),
 * each with its relative path (from `webkitRelativePath`). The fallback for a
 * menu action and for browsers without dropped-folder entry support. Resolves
 * [] if the user cancels.
 */
export function pickFolder(): Promise<DroppedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    // Non-standard but widely supported: turns the picker into a folder chooser.
    (input as unknown as { webkitdirectory: boolean }).webkitdirectory = true;
    input.style.display = "none";
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.addEventListener(
      "change",
      () =>
        resolve(
          Array.from(input.files ?? []).map((file) => ({
            file,
            // webkitRelativePath is "PickedFolder/sub/a.png"; fall back to name.
            relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
          })),
        ),
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
    input.remove();
  });
}
