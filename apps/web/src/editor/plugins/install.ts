"use client";

import { identity } from "@/editor/identity";
import { PLUGIN_PROTOCOL_VERSION } from "@solomotion/plugin-sdk";
import { bundleFromDirectory, bundleFromZip, readManifest } from "./plugin-bundle";
import { usePlugins } from "./plugins-store";
import type { InstalledPlugin, PluginBundleFiles, PluginSource } from "./plugin-model";

/**
 * The ONE way a plugin enters the app — a zip anyone can upload, a dev folder
 * (Chromium), or pre-materialized files (the seeded sample). Every path lands
 * here: normalize → validate the manifest → compat-check → persist. Uniqueness is
 * the manifest id, so re-installing the same id REPLACES the row (an update),
 * keeping its enabled state and original install date.
 */

export type InstallSource =
  | { kind: "zip"; file: File }
  | { kind: "folder"; handle: FileSystemDirectoryHandle; folderName: string }
  | { kind: "files"; files: PluginBundleFiles; source: PluginSource };

export interface InstallResult {
  id: string;
  name: string;
  version: string;
  /** True when this replaced an already-installed plugin of the same id. */
  replaced: boolean;
}

export async function installPlugin(src: InstallSource): Promise<InstallResult> {
  const { files, source } = await materialize(src);

  const parsed = readManifest(files);
  if (!parsed.ok) throw new Error(`This isn't a valid ${identity.name} plugin:\n• ${parsed.errors.join("\n• ")}`);
  const manifest = parsed.manifest;

  if (manifest.api > PLUGIN_PROTOCOL_VERSION) {
    throw new Error(
      `“${manifest.name}” needs a newer ${identity.name} (plugin API v${manifest.api}; this build speaks v${PLUGIN_PROTOCOL_VERSION}).`,
    );
  }
  if (!files[manifest.main]) {
    throw new Error(`“${manifest.name}” is missing its entry file “${manifest.main}”.`);
  }

  const existing = usePlugins.getState().installed.find((p) => p.manifest.id === manifest.id);
  const now = Date.now();
  const record: InstalledPlugin = {
    manifest,
    files,
    source,
    enabled: existing?.enabled ?? true,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  };
  await usePlugins.getState().upsert(record);

  return { id: manifest.id, name: manifest.name, version: manifest.version, replaced: Boolean(existing) };
}

async function materialize(src: InstallSource): Promise<{ files: PluginBundleFiles; source: PluginSource }> {
  switch (src.kind) {
    case "zip":
      return { files: await bundleFromZip(src.file), source: { kind: "file", fileName: src.file.name } };
    case "folder":
      return {
        files: await bundleFromDirectory(src.handle),
        source: { kind: "folder", folderName: src.folderName },
      };
    case "files":
      return { files: src.files, source: src.source };
  }
}
