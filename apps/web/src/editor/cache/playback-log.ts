"use client";

/**
 * A SHORT MEMORY OF WHAT THE TRANSPORT AND THE MEDIA DID — for reading a
 * playback problem after the fact, not for shipping behaviour on.
 *
 * Bounded (the newest few hundred events), allocation-light, and silent: it
 * never logs to the console. In development it is reachable from a console or
 * a driving script as `__<ns>.playbackLog()`, next to the presentation
 * signal it is read alongside.
 */

export interface PlaybackEvent {
  /** performance.now() */
  at: number;
  kind: string;
  /** The instant or source time the event concerns (ms or s, per kind). */
  value: number;
  detail?: string;
}

const CAPACITY = 400;
const ring: PlaybackEvent[] = [];
let head = 0;

export function notePlaybackEvent(kind: string, value: number, detail?: string): void {
  const e: PlaybackEvent = { at: performance.now(), kind, value, detail };
  if (ring.length < CAPACITY) ring.push(e);
  else ring[head] = e;
  head = (head + 1) % CAPACITY;
}

/** Oldest first. */
export function playbackLog(): PlaybackEvent[] {
  return ring.length < CAPACITY ? ring.slice() : [...ring.slice(head), ...ring.slice(0, head)];
}


