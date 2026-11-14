"use client";

import * as React from "react";
import { iconId, type IconData, type IconRef, type IconSet } from "@solomotion/core";
import { iconCatalog } from "./icon-catalog";

/**
 * One icon's body for one tile — BATCHED across every tile that asks in the
 * same tick.
 *
 * A virtualised grid mounts thirty or eighty tiles at once, each knowing only
 * its own name. Each asking the client alone would be eighty requests (the
 * client de-duplicates identical URLs, not adjacent ones). So a tile drops
 * its name in a per-set bucket and the bucket flushes on the next microtask
 * as ONE `icons(prefix, names)` call. The client's own cache then answers
 * every re-mount from memory, and the Cache API answers the next session.
 */

type Pending = { names: Set<string>; waiters: Map<string, Array<(d: IconData | null) => void>> };
const buckets = new Map<string, Pending>();
let scheduled = false;

function flush(): void {
  scheduled = false;
  const client = iconCatalog();
  for (const [prefix, bucket] of buckets) {
    buckets.delete(prefix);
    const names = [...bucket.names];
    client
      .icons(prefix, names)
      .then((got) => {
        for (const name of names) for (const w of bucket.waiters.get(name) ?? []) w(got.get(name) ?? null);
      })
      .catch(() => {
        for (const name of names) for (const w of bucket.waiters.get(name) ?? []) w(null);
      });
  }
}

/** The body for one icon, coalesced with everything else asked this tick. */
export function requestIconData(ref: IconRef): Promise<IconData | null> {
  return new Promise((resolve) => {
    let bucket = buckets.get(ref.prefix);
    if (!bucket) {
      bucket = { names: new Set(), waiters: new Map() };
      buckets.set(ref.prefix, bucket);
    }
    bucket.names.add(ref.name);
    const list = bucket.waiters.get(ref.name) ?? [];
    list.push(resolve);
    bucket.waiters.set(ref.name, list);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  });
}

/** `undefined` while loading, `null` when the set has no such icon. */
export function useIconData(ref: IconRef): IconData | null | undefined {
  const [data, setData] = React.useState<IconData | null | undefined>(undefined);
  const id = iconId(ref);
  React.useEffect(() => {
    let live = true;
    setData(undefined);
    void requestIconData(ref).then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
    // The ref is an object per render; its id is the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return data;
}

/**
 * Every set the panel may offer. Fetched once per mount through the cached
 * client; the inspector uses it too, to name a layer's set from its prefix.
 */
export function useIconSets(): {
  sets: IconSet[] | null;
  error: boolean;
  retry: () => void;
} {
  const [sets, setSets] = React.useState<IconSet[] | null>(null);
  const [error, setError] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    setError(false);
    iconCatalog()
      .sets()
      .then((s) => live && setSets(s))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [attempt]);
  return { sets, error, retry: () => setAttempt((n) => n + 1) };
}
