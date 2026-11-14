"use client";

import * as React from "react";
import { NAMES } from "@/editor/names";

/**
 * WHO IS PUBLISHING — a keypair on this device, not an account.
 *
 * The app opens without a login, and that is a feature: a desktop tool that
 * demands a session before you can draw a rectangle feels like a website. So
 * publishing does not bring auth with it. A publisher has a public id and a
 * secret, the server checks the pair against a roster, and everything published
 * is stamped with the id — which is what makes "you may edit only your own"
 * enforceable from the first day, before there is any database to enforce it
 * with.
 *
 * When the roster outgrows an env var it becomes a table and `verifyPublisher`
 * looks somewhere else. Nothing here changes. That is the point of choosing a
 * keypair over an account now: it is the cheap half of auth, and it is the half
 * that has to exist either way.
 */

export interface PublisherIdentity {
  id: string;
  secret: string;
  /** Remembered for the greeting; the server is the authority on the name. */
  name?: string;
}

const KEY = NAMES.storage.publisher;

let snapshot: PublisherIdentity | null | undefined;
const listeners = new Set<() => void>();

export function getPublisher(): PublisherIdentity | null {
  if (snapshot !== undefined) return snapshot;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    snapshot = raw ? (JSON.parse(raw) as PublisherIdentity) : null;
  } catch {
    snapshot = null;
  }
  return snapshot;
}

export function setPublisher(identity: PublisherIdentity | null): void {
  if (identity) window.localStorage.setItem(KEY, JSON.stringify(identity));
  else window.localStorage.removeItem(KEY);
  snapshot = identity;
  for (const cb of listeners) cb();
}

export function usePublisher(): PublisherIdentity | null {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getPublisher,
    () => null,
  );
}
