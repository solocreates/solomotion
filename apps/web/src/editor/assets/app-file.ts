import type { AppFile } from "@solomotion/platform";

/**
 * Realize a platform {@link AppFile} (a clipboard image blob, or a native OS
 * file the desktop shell read) as a browser `File`, the currency the whole
 * import pipeline speaks. Dependency-free so any paste/drop path can share it.
 */
export async function appFileToFile(f: AppFile): Promise<File> {
  const bytes = await f.read();
  // Copy into a fresh ArrayBuffer so a possibly-shared/pooled view is safe.
  return new File([new Uint8Array(bytes)], f.name, { type: f.mime ?? "" });
}

/** Realize a batch of AppFiles as browser Files, in order. */
export function appFilesToFiles(files: AppFile[]): Promise<File[]> {
  return Promise.all(files.map(appFileToFile));
}
