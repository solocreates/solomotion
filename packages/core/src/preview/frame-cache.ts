import type { MotionDocument } from "../schema";
import { diffDocumentPicture, footprint, inSpans, type DocumentDelta, type TimeSpan } from "./picture-change";

/**
 * THE FRAME CACHE — the green bar, and the reason the second pass is real time.
 *
 * The layer cache remembers one LAYER's finished pixels while you sit still.
 * This remembers a whole COMPOSITE at one instant, so playing a range a second
 * time is a blit per frame instead of a render per frame. They are not the same
 * structure and neither replaces the other: the layer cache is keyed on
 * identity and dies the moment the playhead moves, which is exactly the thing
 * this is keyed on.
 *
 * ## The key, which is the irreversible decision
 *
 *     (comp, the frame index the playhead is inside)
 *
 * and nothing else. That is legitimate only because the renderer quantizes
 * every time through the render clock already (`compRenderTimeMs`): a comp
 * genuinely only exists at grid instants, so two different playhead
 * milliseconds inside one frame ARE the same picture, by construction rather
 * than by rounding. Without that property this cache would miss every single
 * lookup during playback, because the transport advances by wall-clock delta
 * and never visits the same millisecond twice.
 *
 * Everything else that could change the picture is handled as VALIDITY, not as
 * key material, and it comes in exactly three shapes:
 *
 *  1. A VARIANT, for everything that is neither the document nor the playhead —
 *     the camera, the canvas size, the quality tier, the navigation. It is part
 *     of the KEY, not a reason to throw anything away, and that distinction is
 *     the whole difference between a cache that accumulates and one that feels
 *     like it is fighting you.
 *
 *     It began as an epoch counter that cleared the table on every change, and
 *     the result was a cache that erased itself constantly for reasons nobody
 *     could connect to anything: zoom in and back out and a range you waited
 *     for was gone, even though the pixels for the view you returned to were
 *     perfectly good and still in memory. Keying instead means a variant you
 *     leave is simply unreachable until you come back to it, and the LRU budget
 *     — which already has to exist — is what eventually reclaims one you never
 *     do. Nothing is thrown away because a setting moved; things are thrown
 *     away because they went stale or because memory ran out, which are the
 *     only two honest reasons a cache drops anything.
 *
 *  2. CONTRIBUTOR IDENTITY, for edits — see below. This is the one that makes
 *     it the real thing rather than v1.
 *
 *  3. FIDELITY AT THE DOOR, for what arrives from outside the document — a
 *     video frame decoding, an image loading. A frame is only ever ADMITTED if
 *     every picture it drew was the exact picture of its instant (the app's
 *     renderer knows: it asked the media for time T and was told whether it got
 *     T). An exact picture of an instant can never go stale, so nothing outside
 *     the document ever has to invalidate a cached frame.
 *
 *     This replaced "provisional" frames that a later decode revoked. That was
 *     the wrong direction: a playing video reports a new picture many times a
 *     second, so the revocations ran continuously, and every frame kept in the
 *     meantime was a photograph of a moving element that replayed as jitter.
 *     Refusing a guess is cheaper than storing one and taking it back.
 *
 *     `invalidateSubject` remains for the one outside event that genuinely
 *     changes an exact picture: the SOURCE itself changing (a relinked file).
 *
 * ## Clip-based invalidation, which is the whole point
 *
 * "Clear everything on any edit" is not a frame cache, it is a frame-cache
 * shaped hole. What After Effects does — and what this does — is remember that
 * editing a layer at frame 300 has nothing to say about frames 1 to 299.
 *
 * Every cached frame records WHO PAINTED INTO IT: the clip ids the renderer
 * actually walked, at any depth, inside groups and nested comps. That list
 * comes from the painter itself (`FrameLedger`, fed at the one seam every layer
 * passes through) rather than from a model of the document, so it cannot
 * disagree with the picture — a container's contents, a component instance's
 * source, a glass card's backdrop and an adjustment layer's reach are all
 * covered because all four are literally the layers that were drawn.
 *
 * An edit replaces that clip's object (the store is immer), so a diff of the
 * two documents is a reference comparison, and the reverse index turns the
 * changed ids straight into the frames to drop. Frames where that clip was not
 * on screen never listed it and survive untouched.
 *
 * ADDING OR REMOVING a clip is the one case identity cannot answer: a frame
 * cached before the clip existed cannot list it. Those are STRUCTURAL and drop
 * every frame of the comps they touch — safe, and still far short of "clear
 * everything", because every other comp survives.
 *
 * ## At the ceiling: roll, or hold
 *
 * Victims come from OTHER comps and variants first (least recently used) —
 * a view you left is the cheapest thing to give up. Past that, the range being
 * built has to pay for itself, and there are two honest answers, chosen by the
 * person (`CacheAdmission`):
 *
 *   ROLL (default) — the open-world streaming model. The cache is a window that
 *   travels with the playhead: what lies furthest BEHIND it goes first (it was
 *   played and will not be needed until a loop comes round), then what lies
 *   furthest ahead. A long timeline under a small budget keeps the stretch you
 *   are working in green wherever you are.
 *   HOLD — fill to the ceiling and keep it. A fixed range that fits plays from
 *   the cache on every loop; once full, new instants are simply not kept.
 *
 * A plain LRU is neither: over a sequential range larger than the budget it
 * evicts each frame just before a loop needs it, so every pass misses.
 *
 * ## Empty instants
 *
 * An instant the painter drew NOTHING at (a gap in the timeline) is not worth
 * a single byte: its render is the board fill. It is recorded as EMPTY instead
 * — resolved, costing nothing, never green on a bar — so a range build skips it
 * and "is this range ready" does not count it as missing. An empty mark dies
 * with any edit that touches its comp, because the clip that fills the gap
 * tomorrow is not in any contributor list today.
 *
 * ## Driven documents cache here, and that is not an accident
 *
 * The layer cache refuses graphs, expressions and variables, because
 * `resolvedDocAt` re-bakes fresh clip objects at every instant and identity
 * stops meaning anything. This cache does not have that problem, provided one
 * rule is kept: DIFF THE RAW DOCUMENT, NEVER THE RESOLVED ONE. A resolved
 * document is a pure function of the raw document and the instant, and both are
 * already accounted for — the instant is the key, the raw document is the
 * validity. So the documents that need caching most are the ones that get it.
 */

/**
 * WHY AN ENTRY LEFT — and it matters, because only one of these answers means
 * the pixels were WRONG.
 *
 * Running out of room is not the same event as going stale, and a store that
 * cannot tell them apart cannot have a second tier: demoting an evicted frame
 * to cheaper storage is right, and demoting an invalidated one is how you serve
 * a picture of a document that no longer exists.
 */
export type FrameDropReason = "evicted" | "invalidated";

/** What the app stores. Core never touches pixels; it accounts for them. */
export interface FramePayload {
  /** Real backing-store bytes, for the budget. */
  bytes: number;
  /**
   * Called exactly once when the pixels leave the table — for a SHARED payload,
   * when its last holder does.
   */
  release(reason: FrameDropReason): void;
  /**
   * Instants that are provably the same picture share ONE payload. A steady
   * stretch of the timeline — every contributor holding still — is one set of
   * pixels however many frames it spans, and it is accounted once: the bytes
   * are counted when the first holder arrives and returned when the last one
   * leaves. Invalidation and eviction still act per instant.
   */
  shareKey?: string;
}

/** Who painted into one frame — reported by the renderer, never derived. */
export interface FrameContributors {
  clipIds: ReadonlySet<string>;
  /** Every comp walked, the host included — a nested comp's edits land here. */
  frameIds: ReadonlySet<string>;
}

export interface FrameCacheStats {
  bytes: number;
  entries: number;
  budget: number;
}

/** What a full cache does with a new frame of the range it is building. */
export type CacheAdmission = "roll" | "hold";

export interface FrameCacheOptions {
  budgetBytes: number;
  admission?: CacheAdmission;
  /** Coverage arrived — the bar wants to know. */
  onCover?: (compId: string, variant: string, timeMs: number) => void;
  /** Coverage left — see `FrameDropReason`. */
  onUncover?: (compId: string, variant: string, timeMs: number, reason: FrameDropReason) => void;
}

export interface FrameCache<P extends FramePayload> {
  get(compId: string, variant: string, timeMs: number): P | null;
  has(compId: string, variant: string, timeMs: number): boolean;
  put(
    compId: string,
    variant: string,
    timeMs: number,
    payload: P,
    refs: FrameContributors,
  ): void;
  /** The painter drew nothing at this instant — resolved, and costs nothing. */
  markEmpty(compId: string, variant: string, timeMs: number): void;
  isEmpty(compId: string, variant: string, timeMs: number): boolean;
  /**
   * Drop what an edit changed — and ONLY where it changed it. See
   * `picture-change.ts`: the delta names, per clip, the comp instants whose
   * composite differs, so moving a clip from 2–4s to 3–5s drops 2–5s and
   * nothing else, and editing one keyframe drops the window around it.
   */
  applyDelta(delta: DocumentDelta): void;
  /** `applyDelta(diffDocumentPicture(prev, next))`, for callers with no delta in hand. */
  applyDocumentChange(prev: MotionDocument, next: MotionDocument): void;
  /** A clip's SOURCE changed (a relinked file). `null` means "something, unknown". */
  invalidateSubject(clipId: string | null): void;
  /** Drop what this clip painted into, within `[fromMs, toMs]` of `compId`'s time. */
  invalidateSubjectIn(clipId: string, compId: string, fromMs: number, toMs: number): void;
  clear(): void;
  /**
   * Change the ceiling at runtime, evicting down to it if it shrank.
   *
   * A ceiling belongs to the PERSON, not to a guess about their machine: the
   * only browser API for this (`deviceMemory`) is coarse where it exists and
   * absent where it does not, so a derived default is a number that is wrong
   * for most people in both directions. Every tool in this category asks
   * instead — After Effects calls it "RAM reserved for other applications" —
   * and so does this.
   */
  setBudget(bytes: number): void;
  setAdmission(admission: CacheAdmission): void;
  /** Where the playhead is, for ROLL's choice of what to give up. */
  setFocus(compId: string, variant: string, timeMs: number): void;
  /** The payload already held under this share key, if any instant still holds it. */
  shared(shareKey: string): P | null;
  /** Grid instants held for this comp AND variant, ascending — the bar. */
  coveredTimes(compId: string, variant: string): number[];
  stats(): FrameCacheStats;
}

interface Entry<P> {
  compId: string;
  variant: string;
  timeMs: number;
  payload: P;
  clipIds: ReadonlySet<string>;
  frameIds: ReadonlySet<string>;
  used: number;
}

/**
 * An instant's slot, keyed to the MICROSECOND. Instants are thirds of a
 * millisecond at 30fps, so the same frame arrives as different doubles
 * depending on how it was computed — quantized by the stage, or stepped to as
 * `t + i·step` by a lookahead — and keying the raw double made two frames in
 * three unfindable by anything that computed its instant (the run ahead never
 * engaged). Grid instants are milliseconds apart; a microsecond merges none.
 */
const slotOf = (compId: string, variant: string, timeMs: number) =>
  `${compId}\u0000${variant}\u0000${Math.round(timeMs * 1000)}`;

export function createFrameCache<P extends FramePayload>(opts: FrameCacheOptions): FrameCache<P> {
  let budgetBytes = opts.budgetBytes;
  const entries = new Map<string, Entry<P>>();
  /** clip id to the slots it painted into. The reverse index IS the feature. */
  const byClip = new Map<string, Set<string>>();
  const byFrame = new Map<string, Set<string>>();
  let bytes = 0;
  let useClock = 0;
  /** One set of pixels, many instants. Bytes are the share's, counted once. */
  const shares = new Map<string, { payload: P; holders: number }>();

  const unindex = (slot: string, e: Entry<P>): void => {
    for (const id of e.clipIds) {
      const set = byClip.get(id);
      if (!set) continue;
      set.delete(slot);
      if (set.size === 0) byClip.delete(id);
    }
    for (const id of e.frameIds) {
      const set = byFrame.get(id);
      if (!set) continue;
      set.delete(slot);
      if (set.size === 0) byFrame.delete(id);
    }
  };

  const drop = (slot: string, reason: FrameDropReason): void => {
    const e = entries.get(slot);
    if (!e) return;
    entries.delete(slot);
    unindex(slot, e);
    const key = e.payload.shareKey;
    const share = key ? shares.get(key) : undefined;
    if (share) {
      share.holders--;
      if (share.holders === 0) {
        shares.delete(key!);
        bytes -= share.payload.bytes;
        share.payload.release(reason);
      }
    } else {
      bytes -= e.payload.bytes;
      e.payload.release(reason);
    }
    opts.onUncover?.(e.compId, e.variant, e.timeMs, reason);
  };

  const dropAllFrom = (index: Map<string, Set<string>>, id: string): void => {
    const slots = index.get(id);
    if (!slots) return;
    // Copied: `drop` mutates the very set this is walking.
    for (const slot of [...slots]) drop(slot, "invalidated");
  };

  /**
   * Least recently used out until the total fits — sparing `protect`, the
   * range being built (see "A range never eats itself"). Returns whether the
   * budget now holds.
   *
   * A FRAME ROLLS BEFORE WHAT IT IS MADE OF. A comp whose pictures another held
   * comp's frames walked (a precomp: a scene nested as a tile) is a FEEDER, and
   * goes last — after unrelated comps, and after the range being played rolls.
   * Its pictures are what make every composite of it cheap to make again: the
   * Playground cover's 2 MB frames re-composite from nine kept tiles in ~5 ms,
   * while each 72 KB tile costs 5–27 ms to make. Evicted LRU-first as "another
   * range", the tiles went to make room for the frames built on them, and every
   * frame after the ceiling re-made its tiles — the wall thrashed back to an
   * eighth.
   */
  let admission: CacheAdmission = opts.admission ?? "roll";
  let focus: { compId: string; variant: string; timeMs: number } | null = null;

  /** Does another held comp's frame walk this comp? (`byFrame` names every comp a frame walked.) */
  const feedsAnother = (compId: string, memo: Map<string, boolean>): boolean => {
    let hit = memo.get(compId);
    if (hit !== undefined) return hit;
    hit = false;
    const prefix = `${compId}\u0000`;
    for (const slot of byFrame.get(compId) ?? []) {
      if (!slot.startsWith(prefix)) {
        hit = true;
        break;
      }
    }
    memo.set(compId, hit);
    return hit;
  };

  const evictToBudget = (protect?: { compId: string; variant: string; timeMs: number }): boolean => {
    if (bytes <= budgetBytes) return true;
    const byAge = [...entries.entries()].sort((a, b) => a[1].used - b[1].used);
    const own: Array<[string, Entry<P>]> = [];
    const feeders: Array<[string, Entry<P>]> = [];
    const memo = new Map<string, boolean>();
    for (const [slot, e] of byAge) {
      if (bytes <= budgetBytes) return true;
      if (protect && e.compId === protect.compId && e.variant === protect.variant) {
        own.push([slot, e]);
        continue;
      }
      if (feedsAnother(e.compId, memo)) {
        feeders.push([slot, e]);
        continue;
      }
      drop(slot, "evicted");
    }
    if (bytes <= budgetBytes) return true;
    if (protect && admission === "hold") return false;
    if (protect) {
      // ROLL: furthest behind the playhead first, then furthest ahead.
      const at = focus && focus.compId === protect.compId && focus.variant === protect.variant ? focus.timeMs : protect.timeMs;
      const rank = (t: number) => (t < at ? 1e15 + (at - t) : t - at);
      own.sort((a, b) => rank(b[1].timeMs) - rank(a[1].timeMs));
      for (const [slot, e] of own) {
        if (bytes <= budgetBytes) return true;
        if (e.timeMs === protect.timeMs) continue;
        drop(slot, "evicted");
      }
    }
    for (const [slot] of feeders) {
      if (bytes <= budgetBytes) return true;
      drop(slot, "evicted");
    }
    return bytes <= budgetBytes;
  };

  /** EMPTY marks per comp, slot → instant. Cleared by the edits that reach them. */
  const empties = new Map<string, Map<string, number>>();
  const unmarkEmpty = (compId: string, slot: string): void => {
    const set = empties.get(compId);
    if (!set) return;
    set.delete(slot);
    if (set.size === 0) empties.delete(compId);
  };

  const clear = (): void => {
    for (const slot of [...entries.keys()]) drop(slot, "invalidated");
    byClip.clear();
    byFrame.clear();
    empties.clear();
    shares.clear();
    bytes = 0;
  };

  return {
    get(compId, variant, timeMs) {
      const e = entries.get(slotOf(compId, variant, timeMs));
      if (!e) return null;
      e.used = ++useClock;
      return e.payload;
    },
    has(compId, variant, timeMs) {
      return entries.has(slotOf(compId, variant, timeMs));
    },
    put(compId, variant, timeMs, payload, refs) {
      // NON-FINITE INSTANTS NEVER ENTER. `String(NaN) === String(NaN)`, so a
      // poisoned key matches forever after and serves the wrong picture for the
      // life of the session — the same trap the layer cache refuses at.
      if (!Number.isFinite(timeMs) || !Number.isFinite(payload.bytes) || payload.bytes <= 0) {
        payload.release("invalidated");
        return;
      }
      // One frame larger than the whole budget would evict everything and still
      // not fit. Let it stay uncached rather than thrash.
      if (payload.bytes > budgetBytes) {
        payload.release("evicted");
        return;
      }
      const slot = slotOf(compId, variant, timeMs);
      const existing = entries.get(slot);
      // Already holding this very picture: nothing to do. Asked FIRST, because
      // replacing it would release the share's last holder — handing its pixels
      // back to the app's pool — while the incoming payload still points at them.
      if (existing && payload.shareKey && existing.payload.shareKey === payload.shareKey) {
        existing.used = ++useClock;
        return;
      }
      drop(slot, "invalidated"); // replace, never accumulate
      unmarkEmpty(compId, slot);
      // A SHARED picture already held costs nothing more to hold again.
      const share = payload.shareKey ? shares.get(payload.shareKey) : undefined;
      const cost = share ? 0 : payload.bytes;
      // Make room from OTHER ranges first; if that is not enough, this range
      // is at the ceiling and the frame is refused rather than bought with one
      // of its own neighbours.
      bytes += cost;
      const fits = evictToBudget({ compId, variant, timeMs });
      bytes -= cost;
      if (!fits) {
        if (!share) payload.release("evicted");
        return;
      }
      if (share) share.holders++;
      else if (payload.shareKey) shares.set(payload.shareKey, { payload, holders: 1 });
      entries.set(slot, {
        compId,
        variant,
        timeMs,
        payload,
        clipIds: refs.clipIds,
        frameIds: refs.frameIds,
        used: ++useClock,
      });
      bytes += cost;
      for (const id of refs.clipIds) {
        let set = byClip.get(id);
        if (!set) byClip.set(id, (set = new Set()));
        set.add(slot);
      }
      for (const id of refs.frameIds) {
        let set = byFrame.get(id);
        if (!set) byFrame.set(id, (set = new Set()));
        set.add(slot);
      }
      opts.onCover?.(compId, variant, timeMs);
    },
    markEmpty(compId, variant, timeMs) {
      if (!Number.isFinite(timeMs)) return;
      const slot = slotOf(compId, variant, timeMs);
      drop(slot, "invalidated");
      let marks = empties.get(compId);
      if (!marks) empties.set(compId, (marks = new Map()));
      marks.set(slot, timeMs);
    },
    isEmpty(compId, variant, timeMs) {
      return empties.get(compId)?.has(slotOf(compId, variant, timeMs)) ?? false;
    },
    applyDelta(delta) {
      if (delta.total) {
        clear();
        return;
      }
      for (const id of delta.changedFrames) {
        dropAllFrom(byFrame, id);
        empties.delete(id);
      }
      for (const [clipId, d] of delta.clips) {
        const { comp, withinPaint } = d.change;
        const homes = new Set<string>();
        if (d.next) homes.add(d.next.frameId);
        if (d.prev) homes.add(d.prev.frameId);
        const footprints: TimeSpan[] = [];
        if (d.next) footprints.push(footprint(d.next));
        if (d.prev) footprints.push(footprint(d.prev));
        for (const home of homes) {
          if (comp === "all") {
            dropAllFrom(byFrame, home);
            empties.delete(home);
            continue;
          }
          const slots = byFrame.get(home);
          if (slots) {
            for (const slot of [...slots]) {
              const e = entries.get(slot);
              if (!e) continue;
              const listed = e.clipIds.has(clipId);
              const stale =
                e.compId === home
                  ? // In its own comp, by TIME — plus anything the clip painted
                    // outside its own footprint (footage holding an edge frame
                    // across a gap), which no window of the clip's names.
                    inSpans(comp, e.timeMs) || (listed && !inSpans(footprints, e.timeMs))
                  : // A comp that NESTS this one runs on another clock. Where the
                    // change stayed inside the clip's own paint, a frame that did
                    // not list the clip cannot have changed; otherwise it might.
                    !withinPaint || listed;
              if (stale) drop(slot, "invalidated");
            }
          }
          const marks = empties.get(home);
          if (marks) {
            for (const [slot, t] of [...marks]) if (inSpans(comp, t)) marks.delete(slot);
            if (marks.size === 0) empties.delete(home);
          }
        }
      }
    },
    applyDocumentChange(prev, next) {
      this.applyDelta(diffDocumentPicture(prev, next));
    },
    invalidateSubjectIn(clipId, compId, fromMs, toMs) {
      const slots = byClip.get(clipId);
      if (!slots) return;
      for (const slot of [...slots]) {
        const e = entries.get(slot);
        if (e && e.compId === compId && e.timeMs >= fromMs && e.timeMs <= toMs) drop(slot, "invalidated");
      }
    },
    invalidateSubject(clipId) {
      if (clipId === null) {
        clear();
        return;
      }
      dropAllFrom(byClip, clipId);
    },
    clear,
    setBudget(next) {
      if (!Number.isFinite(next) || next <= 0 || next === budgetBytes) return;
      budgetBytes = next;
      evictToBudget(); // a smaller ceiling spares nobody
    },
    setAdmission(next) {
      admission = next;
    },
    setFocus(compId, variant, timeMs) {
      focus = { compId, variant, timeMs };
    },
    shared(shareKey) {
      return shares.get(shareKey)?.payload ?? null;
    },
    coveredTimes(compId, variant) {
      const out: number[] = [];
      for (const e of entries.values()) if (e.compId === compId && e.variant === variant) out.push(e.timeMs);
      return out.sort((a, b) => a - b);
    },
    stats() {
      return { bytes, entries: entries.size, budget: budgetBytes };
    },
  };
}
