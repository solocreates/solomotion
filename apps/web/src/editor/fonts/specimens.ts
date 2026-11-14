"use client";

import * as React from "react";
import type { FontFamilyMeta } from "@solomotion/core";
import { SPECIMEN_STORE, idbGet, idbPrune, idbPut } from "./font-db";

/**
 * SPECIMENS — how a font browser draws a thousand families without loading a
 * thousand fonts.
 *
 * A specimen is a family cut down to the few characters one row sets: Google's
 * `text=` API returns a font file holding only those glyphs, a few KB instead
 * of a few hundred. Four decisions make browsing cheap and steady:
 *
 *  • PRIVATE ALIAS. A specimen is registered under its own family name
 *    (`__sp…`), never the real one. The old picker used the real name, so the
 *    moment a hover loaded the FULL family for the stage preview, the row's
 *    text re-matched to the new, still-downloading face and fell back until it
 *    arrived — the blink on every hover. A row now draws from a face nothing
 *    else can replace.
 *
 *  • DEMAND, NOT MOUNT. A request is queued when a row mounts and dropped if
 *    the row unmounts before the queue drains, so flinging past four hundred
 *    rows fetches the ones you stopped on, not everything you flew over.
 *
 *  • BATCHED. A dozen families go to Google as ONE stylesheet request
 *    (`family=A&family=B&…`), asking for the UNION of their characters — every
 *    list row sets a different name, so batching only rows with identical
 *    text batched nothing (forty requests for twenty-eight rows). Each file
 *    carries a few glyphs it does not need; a few hundred bytes, one round
 *    trip instead of twelve.
 *
 *  • CACHED ON THE DEVICE. Each specimen's bytes land in the app's font
 *    database (`font-db`), so a family you have seen once is drawn from disk
 *    on every later open, across projects, with no network at all. Google's
 *    subset URLs expire within a day; the HTTP cache alone would refetch them.
 *
 * Local families — your uploads and the OS's — need none of this: the browser
 * already has them, so their "specimen" is the family itself, synchronously.
 */

export type SpecimenWeights = "regular" | "all";

export interface SpecimenRequest {
  meta: FontFamilyMeta;
  /** Every character the row will set. */
  text: string;
  /**
   * `regular` — one upright face near 400 (a list row).
   * `all` — every upright weight (a card with a weight ramp): one file on a
   * variable axis, one per weight otherwise.
   */
  weights: SpecimenWeights;
}

interface StoredSpecimen {
  key: string;
  at: number;
  faces: Array<{ weight: string; style: string; data: ArrayBuffer }>;
}

/** Families per stylesheet request. Long enough to matter, short enough for any URL limit. */
const BATCH = 12;
/** Stylesheet requests in flight at once. */
const PARALLEL = 3;
/** How long the queue waits for a scroll to settle before asking. */
const SETTLE_MS = 70;
const MAX_CACHED = 3000;

const ready = new Map<string, string>();
const failed = new Set<string>();
const inFlight = new Set<string>();
const demand = new Map<string, number>();
const queued = new Map<string, SpecimenRequest>();
const listeners = new Map<string, Set<() => void>>();

function uniqueChars(text: string): string {
  return [...new Set([...text])].sort().join("");
}

function weightSpec(meta: FontFamilyMeta, weights: SpecimenWeights): string {
  const up = meta.weights;
  if (weights === "regular") {
    // The upright face nearest Regular that actually exists — asking for a
    // weight a family does not ship fails the whole batch.
    const w = meta.variable
      ? Math.min(meta.variable.max, Math.max(meta.variable.min, 400))
      : up.reduce((best, x) => (Math.abs(x - 400) < Math.abs(best - 400) ? x : best), up[0] ?? 400);
    return up.length > 0 || meta.variable ? `wght@${w}` : `ital,wght@1,${meta.italics[0] ?? 400}`;
  }
  if (meta.variable) return `wght@${meta.variable.min}..${meta.variable.max}`;
  return `wght@${up.join(";")}`;
}

export function specimenKey(req: SpecimenRequest): string {
  return `${req.meta.family}|${req.weights}|${uniqueChars(req.text)}`;
}

function aliasFor(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return `__sp${(h >>> 0).toString(36)}`;
}

function notify(key: string): void {
  for (const l of [...(listeners.get(key) ?? [])]) l();
}

async function register(key: string, faces: StoredSpecimen["faces"]): Promise<boolean> {
  const alias = aliasFor(key);
  try {
    await Promise.all(
      faces.map(async (f) => {
        const face = new FontFace(alias, f.data, { weight: f.weight, style: f.style });
        await face.load();
        document.fonts.add(face);
      }),
    );
  } catch {
    return false;
  }
  ready.set(key, `"${alias}"`);
  notify(key);
  return true;
}

/** Parse a css2 response into faces per family: `{ family: [{weight, style, url}] }`. */
function parseCss(css: string): Map<string, Array<{ weight: string; style: string; url: string }>> {
  const out = new Map<string, Array<{ weight: string; style: string; url: string }>>();
  for (const block of css.split("@font-face").slice(1)) {
    const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
    const url = /url\((https:[^)]+)\)/.exec(block)?.[1];
    if (!family || !url) continue;
    const weight = /font-weight:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? "400";
    const style = /font-style:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? "normal";
    const list = out.get(family) ?? [];
    list.push({ weight, style, url });
    out.set(family, list);
  }
  return out;
}

async function fetchBatch(reqs: SpecimenRequest[]): Promise<void> {
  const text = reqs.map((r) => r.text).join("");
  const params = reqs.map(
    (r) => `family=${encodeURIComponent(r.meta.family).replace(/%20/g, "+")}:${weightSpec(r.meta, r.weights)}`,
  );
  const url = `https://fonts.googleapis.com/css2?${params.join("&")}&text=${encodeURIComponent(uniqueChars(text))}&display=block`;
  let css: string;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    css = await res.text();
  } catch {
    // One bad family fails a whole batch (Google answers 400 for all of it).
    // Retry alone, so one family's problem stays that family's.
    if (reqs.length > 1) {
      await Promise.all(reqs.map((r) => fetchBatch([r])));
      return;
    }
    const key = specimenKey(reqs[0]!);
    failed.add(key);
    inFlight.delete(key);
    notify(key);
    return;
  }

  const byFamily = parseCss(css);
  await Promise.all(
    reqs.map(async (r) => {
      const key = specimenKey(r);
      try {
        const faces = await Promise.all(
          (byFamily.get(r.meta.family) ?? []).map(async (f) => ({
            weight: f.weight,
            style: f.style,
            data: await (await fetch(f.url)).arrayBuffer(),
          })),
        );
        if (faces.length === 0 || !(await register(key, faces))) {
          failed.add(key);
          notify(key);
          return;
        }
        void idbPut(SPECIMEN_STORE, { key, at: Date.now(), faces } satisfies StoredSpecimen);
      } catch {
        failed.add(key);
        notify(key);
      } finally {
        inFlight.delete(key);
      }
    }),
  );
}

let timer: ReturnType<typeof setTimeout> | null = null;
let writesSincePrune = 0;

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void drain();
  }, SETTLE_MS);
}

async function drain(): Promise<void> {
  // Only what is still wanted. A row that scrolled away took its demand with it.
  const wanted = [...queued.entries()].filter(([key]) => (demand.get(key) ?? 0) > 0);
  queued.clear();
  if (wanted.length === 0) return;

  // Disk first: a family seen in any earlier session costs no network.
  const misses: SpecimenRequest[] = [];
  await Promise.all(
    wanted.map(async ([key, req]) => {
      inFlight.add(key);
      const hit = await idbGet<StoredSpecimen>(SPECIMEN_STORE, key);
      if (hit && (await register(key, hit.faces))) {
        inFlight.delete(key);
        return;
      }
      misses.push(req);
    }),
  );

  // Group by what one stylesheet request must share: the weight set. The
  // text is pooled per batch (see the header).
  const groups = new Map<string, SpecimenRequest[]>();
  for (const r of misses) groups.set(r.weights, [...(groups.get(r.weights) ?? []), r]);
  const batches: SpecimenRequest[][] = [];
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));
  }

  const next = async (): Promise<void> => {
    const batch = batches.shift();
    if (!batch) return;
    await fetchBatch(batch);
    writesSincePrune += batch.length;
    await next();
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, next));
  if (writesSincePrune > 200) {
    writesSincePrune = 0;
    void idbPrune(SPECIMEN_STORE, MAX_CACHED);
  }
}

function want(key: string, req: SpecimenRequest): () => void {
  demand.set(key, (demand.get(key) ?? 0) + 1);
  if (!ready.has(key) && !failed.has(key) && !inFlight.has(key)) {
    queued.set(key, req);
    schedule();
  }
  return () => {
    const n = (demand.get(key) ?? 1) - 1;
    if (n <= 0) demand.delete(key);
    else demand.set(key, n);
  };
}

/**
 * The CSS `font-family` to draw a specimen with — the family itself for a local
 * font, its private alias once a web specimen has loaded, and `null` while it
 * is on its way (or could not be had: the row keeps the UI font).
 */
export function useSpecimen(req: SpecimenRequest | null): string | null {
  const local = req && req.meta.source !== "google";
  const key = req && !local ? specimenKey(req) : null;

  const subscribe = React.useCallback(
    (onChange: () => void) => {
      if (!key || !req) return () => undefined;
      const set = listeners.get(key) ?? new Set();
      set.add(onChange);
      listeners.set(key, set);
      const release = want(key, req);
      return () => {
        set.delete(onChange);
        if (set.size === 0) listeners.delete(key);
        release();
      };
    },
    // `req` is described by `key`; a new object with the same key is the same ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const alias = React.useSyncExternalStore(
    subscribe,
    () => (key ? (ready.get(key) ?? null) : null),
    () => null,
  );
  if (!req) return null;
  if (local) return `"${req.meta.family}"`;
  return alias;
}
