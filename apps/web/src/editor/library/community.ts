"use client";

import * as React from "react";
import { create } from "zustand";
import { compareShelfOrder, isHeavyItem, type DocumentStore, type LibraryItem } from "@solomotion/core";
import { toast } from "@/lib/toast";
import { useAppShell } from "../state/app-shell";
import { copiesOf, type ProjectMeta, type ProjectOrigin } from "../state/project-index";
import { libraryClient } from "./client";
import { newProjectFromOnlineTemplate } from "./templates";
import { NAMES } from "@/editor/names";

/**
 * THE COMMUNITY SHELF — whole projects people (today: us) have published, as
 * `template` packs in the online catalogue. No new backend: the same static
 * R2 catalogue the sound library reads, one more shelf on it.
 *
 * A card is ONE published still. Never a live render, never the document: a
 * grid of community projects has to cost what a grid of pictures costs, or a
 * heavy simulation in the catalogue makes Home feel like the slow part of the
 * app. The bundle is fetched only when someone opens it.
 *
 * OPENING is clone-or-continue. A project made from an item remembers the
 * item and the exact bundle it came from (`ProjectOrigin`, its content hash).
 * Opening the same item again finds that copy and asks; opening it after the
 * item was republished does not — a new version is a new thing to start from.
 */

/** The version of an item is the hash of its bytes: republishing changes it, a blurb edit does not. */
export function originOf(item: LibraryItem): ProjectOrigin | null {
  return item.blob ? { itemId: item.id, version: item.blob.sha256 } : null;
}

type Status = "loading" | "ready" | "offline";

interface CommunityState {
  status: Status;
  items: LibraryItem[];
  /** The item waiting on "open my copy or start a new one", with the copy it found. */
  asking: { item: LibraryItem; copy: ProjectMeta; copies: number } | null;
  /** The item whose bundle is downloading right now. */
  opening: string | null;
}

export const useCommunity = create<CommunityState>(() => ({
  status: "loading",
  items: [],
  asking: null,
  opening: null,
}));

let loaded: Promise<void> | null = null;

/** Read every template pack once per session (the client caches; this de-dupes the walk). */
export function loadCommunity(force = false): Promise<void> {
  const client = libraryClient();
  if (!client) {
    useCommunity.setState({ status: "offline" });
    return Promise.resolve();
  }
  if (force) {
    client.invalidate();
    loaded = null;
  }
  loaded ??= (async () => {
    try {
      const index = await client.index();
      const packs = index.packs.filter((p) => p.kind === "template");
      const lists = await Promise.all(packs.map((p) => client.items(p.id).catch(() => [])));
      // The publisher's order (pack.json `order`), then newest first.
      const items = lists.flat().sort(compareShelfOrder);
      useCommunity.setState({ status: "ready", items });
    } catch {
      loaded = null;
      useCommunity.setState({ status: "offline" });
    }
  })();
  return loaded;
}

export function useCommunityItems(): Pick<CommunityState, "status" | "items"> {
  React.useEffect(() => void loadCommunity(), []);
  const status = useCommunity((s) => s.status);
  const items = useCommunity((s) => s.items);
  return { status, items };
}

/** Open an item: continue the copy made from this exact version if there is one (asking first), else clone it. */
export function openCommunityItem(store: DocumentStore, item: LibraryItem): void {
  const origin = originOf(item);
  if (!origin || useCommunity.getState().opening) return;
  const copies = copiesOf(origin.itemId, origin.version);
  if (copies[0]) {
    useCommunity.setState({ asking: { item, copy: copies[0], copies: copies.length } });
    return;
  }
  void cloneCommunityItem(store, item);
}

export async function cloneCommunityItem(store: DocumentStore, item: LibraryItem): Promise<void> {
  useCommunity.setState({ asking: null, opening: item.id });
  try {
    if (await newProjectFromOnlineTemplate(store, item, originOf(item))) noteHeavyOnce(item);
  } finally {
    useCommunity.setState({ opening: null });
  }
}

const HEAVY_SEEN_KEY = NAMES.storage.heavyNoticeSeen;

/**
 * The first time a heavy item opens, say so in one calm line — the card's
 * badge is easy to miss, and a slow first minute with no explanation reads as
 * a broken app. Once per item, ever: the second time it is not news.
 */
function noteHeavyOnce(item: LibraryItem): void {
  if (!isHeavyItem(item)) return;
  let seen: string[] = [];
  try {
    seen = JSON.parse(localStorage.getItem(HEAVY_SEEN_KEY) ?? "[]") as string[];
  } catch {
    seen = [];
  }
  if (seen.includes(item.id)) return;
  try {
    localStorage.setItem(HEAVY_SEEN_KEY, JSON.stringify([...seen, item.id]));
  } catch {
    /* private mode: it may show again, which is harmless */
  }
  // Short enough for the status bar beside its button — a cut-off reassurance reassures no one.
  const what = item.tags.some((t) => t === "physics" || t === "particles") ? "Real physics" : "Lots of live effects";
  const id = toast.info(`${what} in here. A little lag is normal.`, {
    action: { label: "Got it", onClick: () => toast.dismiss(id) },
  });
}

export function continueCopy(projectId: string): void {
  useCommunity.setState({ asking: null });
  useAppShell.getState().openProject(projectId);
}

export function dismissAsk(): void {
  useCommunity.setState({ asking: null });
}
