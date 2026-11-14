"use client";

import { identity } from "@/editor/identity";
import { LibraryClient } from "@solomotion/core";
import { NAMES } from "@/editor/names";

/**
 * The web binding of the online catalogue — one client for the whole app.
 *
 * The base URL is build-time public config, never a secret: the editor makes
 * plain public GETs against static JSON on R2 and holds no credential of any
 * kind. When it is unset the online half is simply ABSENT — every built-in
 * preset, saved component and project sound still works, offline, exactly as
 * before. That is the offline story, and it costs nothing because the local
 * catalogue was never the remote one's client.
 */

/**
 * Our catalogue origin, with the env var as an OVERRIDE rather than the only
 * source. The same shape `icon-catalog.ts` uses, and for the same reason: this
 * is public build config, not a secret, and a default is what makes a
 * production build work without anyone remembering to inject it.
 *
 * Learned the hard way. The URL lived only in `.env.local`, which is
 * gitignored, so every deployed build shipped with NO catalogue at all and the
 * panel said "unreachable" — while Icons, which already had a default, worked
 * fine beside it.
 */
const BASE_URL = process.env.NEXT_PUBLIC_LIBRARY_BASE_URL?.trim() || identity.hosts.library;

let client: LibraryClient | null | undefined;

/**
 * Dev only: `localStorage[NAMES.storage.libraryBaseUrl]` points this browser at
 * another catalogue — a locally served `dist/` after `pnpm library:build`, so
 * a publish can be opened and checked before it is synced to R2.
 */
function devOverride(): string | null {
  if (process.env.NODE_ENV === "production" || typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(NAMES.storage.libraryBaseUrl)?.trim() || null;
  } catch {
    return null;
  }
}

export function libraryClient(): LibraryClient | null {
  if (client !== undefined) return client;
  const baseUrl = devOverride() ?? BASE_URL;
  client = baseUrl ? new LibraryClient({ baseUrl }) : null;
  return client;
}

/** Is there an online catalogue configured at all? */
export const hasOnlineLibrary = Boolean(BASE_URL);
