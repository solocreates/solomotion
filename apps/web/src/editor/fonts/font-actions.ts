"use client";

import type { FaceStyle, MarkRef } from "@solomotion/core";
import { toast } from "@/lib/toast";
import {
  addCustomFont,
  customFacesOf,
  getCustomFontBlob,
  installCustomFontBytes,
  removeCustomFont,
  type CustomFont,
} from "../stage/render/fonts";

/**
 * What the font browsers DO, once, for both of them. A font is marked by its
 * family name — the one identity that is the same across every source, which
 * is also why a family is only ever listed once.
 */
export const fontMark = (family: string): MarkRef => ({ domain: "font", id: family });

export const FONT_FILE_ACCEPT = ".ttf,.otf,.woff,.woff2";

/**
 * Add font files to this device. Several at once is the normal case — a family
 * arrives as its Regular, Bold and Italic — and each file lands as a FACE of
 * the family its own name table names, so the three become one family with
 * three weights rather than three families.
 *
 * Returns the first face added (what a caller selects), or null.
 */
export async function uploadFontFiles(files: Iterable<File>): Promise<CustomFont | null> {
  const list = [...files];
  if (list.length === 0) return null;
  const added: CustomFont[] = [];
  const failed: string[] = [];
  for (const file of list) {
    try {
      added.push(await addCustomFont(file));
    } catch {
      failed.push(file.name);
    }
  }
  const families = [...new Set(added.map((f) => f.family))];
  if (families.length === 1) {
    const faces = added.length;
    toast.success(faces > 1 ? `${families[0]} added · ${faces} styles` : `${families[0]} added`);
  } else if (families.length > 1) {
    toast.success(`${families.length} font families added`);
  }
  if (failed.length > 0) toast.error(failed.length === 1 ? `Couldn't read ${failed[0]}` : `Couldn't read ${failed.length} files`);
  // Upright Regular first: it is what a text layer should start in.
  return added.sort((a, b) => Number(a.italic) - Number(b.italic) || Math.abs(a.weight - 400) - Math.abs(b.weight - 400))[0] ?? null;
}

/**
 * Remove one of YOUR families from this device, with an Undo. The bytes are
 * read back first so Undo restores exactly what was there — every face, under
 * the same name — rather than asking for the files again.
 */
export async function removeFontFamily(family: string): Promise<void> {
  const faces = customFacesOf(family);
  const kept: Array<{ fileName: string; style: FaceStyle; data: ArrayBuffer }> = [];
  for (const f of faces) {
    const blob = await getCustomFontBlob(f.family, f.weight, f.italic);
    if (blob) kept.push({ fileName: blob.fileName, style: { weight: blob.weight, italic: blob.italic }, data: blob.data });
  }
  await removeCustomFont(family);
  toast(`${family} removed`, {
    action: {
      label: "Undo",
      onClick: () => {
        void Promise.all(kept.map((k) => installCustomFontBytes(family, k.fileName, k.data, k.style, "upload")));
      },
    },
  });
}
