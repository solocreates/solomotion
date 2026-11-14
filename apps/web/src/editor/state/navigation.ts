"use client";

/**
 * THE navigation slice — the editor's single answer to "where am I?".
 *
 * ## The model
 *
 * Navigation is ONE value: an `EditPath` (a root comp + the nested clips you
 * stepped through) plus an optional LEAF (a clip whose own interior editor is
 * open: glyphs, Bézier nodes, shape corners, crop handles). Everything the UI
 * used to store separately — the active comp, the drill breadcrumb, which clip
 * is in text edit, which is in vector edit — is derived from that one value.
 *
 * That matters because the old shape stored the same fact twice. `activeFrameId`
 * and `timelinePath` were independent fields, so any code path that set one and
 * forgot the other produced a state that *looked* legal and rendered nonsense:
 * the "Frame 1 ▸ Frame 1" breadcrumb, the drill silently lost on a tab switch,
 * and a click on an inner layer teleporting you back to the root. None of those
 * are reachable now — the target frame is a function of the path, so it cannot
 * disagree with it.
 *
 * ## Projections
 *
 * Legacy readers still want `activeFrameId` / `timelinePath` / `editingClipId` /
 * `vectorEditClipId` / `shapeEditClipId` / `cropClipId`. Those fields remain in
 * the store as PROJECTIONS of `nav`, computed here and written by exactly one
 * function (`navProjection`). They are read-only by convention: nothing else
 * assigns them, so they cannot drift from the canonical value. New code should
 * read `useEditContext()` / `session.nav` instead.
 *
 * ## Per-tab memory
 *
 * A timeline tab is a ROOT comp; the hops are your cursor inside it. Switching
 * tabs remembers each tab's hops (`hopsByTab`), so coming back puts you exactly
 * where you left — instead of dumping you at the root, which is what made tabs
 * feel like they threw your work away.
 */

import { timeSurfaceOf, type TimeAxes } from "../timeline/time-axes";
import {
  editPath,
  enterPath,
  locateClip,
  normalizePath,
  parentPath,
  pathAtDepth,
  pathToFrame,
  pathsEqual,
  playheadBetweenPaths,
  resolveEditContext,
  targetFrameId,
  walkPath,
  type MotionDocument,
  type EditContext,
  type EditPath,
} from "@solomotion/core";

/** A clip's own interior editor — the terminal step of a navigation. */
export type LeafMode = "text" | "vectorNodes" | "shapeCorners" | "crop" | "pivot";

export interface EditLeaf {
  clipId: string;
  mode: LeafMode;
}

export interface NavState {
  /** The canonical path: root comp + nested clips stepped through. */
  path: EditPath;
  /** Open interior editor within the target comp, if any. */
  leaf: EditLeaf | null;
  /** Per-tab cursor memory: root frame id → hop clip ids. */
  hopsByTab: Record<string, string[]>;
}

/** The store fields this slice OWNS and is the only writer of. */
export interface NavProjection {
  nav: NavState;
  activeFrameId: string | null;
  timelinePath: Array<{ frameId: string; clipId: string }>;
  editingClipId: string | null;
  vectorEditClipId: string | null;
  shapeEditClipId: string | null;
  cropClipId: string | null;
  pivotClipId: string | null;
  /**
   * The clip whose INSIDE is currently being edited — a text caret, vector
   * nodes, shape corners, a crop frame. Derived from the leaf, so it is exactly
   * "every leaf mode except `pivot`", which is the one mode that edits the
   * layer AS a layer rather than its contents.
   *
   * Chrome that describes the whole layer (the pivot crosshair above all) must
   * disappear while you are inside it: an anchor point floating over a glyph
   * caret or a Bézier field is clutter you can hit by accident. Asking the nav
   * once, here, is what stops each overlay from re-deriving "am I nested in?"
   * from four separate projections and getting it wrong in a fifth.
   */
  contentEditClipId: string | null;
  /**
   * WHOSE TIME AXIS the bottom region is showing — the flipbook when one (or
   * one of its cell drawings) is open, the comp you are standing in otherwise.
   *
   * A projection because it is a function of the nav and nothing else, and
   * because it is the KEY the zoom memory is stored under: a stored "current
   * surface" would be a second fact able to disagree with where you are.
   */
  timeSurfaceId: string;
  /** The axes that surface opens at, before any of the user's own zooming. */
  timeSurfaceDefaults: TimeAxes;
}

export const EMPTY_NAV: NavState = { path: editPath(""), leaf: null, hopsByTab: {} };

/** The axes an editor with nothing open reports — never read in practice, but
 *  the store needs a value before the first document arrives. */
export const EMPTY_TIME_AXES: TimeAxes = { pxPerSec: 90, laneZoom: 1 };

/**
 * Build the full projection from a canonical nav value. The ONE place any of
 * these fields is computed — which is what makes them incapable of disagreeing.
 */
export function navProjection(doc: MotionDocument, nav: NavState): NavProjection {
  const links = walkPath(doc, nav.path);
  const leaf = nav.leaf;
  const activeFrameId = nav.path.rootFrameId ? targetFrameId(doc, nav.path) : null;
  const surface = timeSurfaceOf(doc, activeFrameId, nav.path.rootFrameId);
  return {
    nav,
    activeFrameId,
    timeSurfaceId: surface.id,
    timeSurfaceDefaults: surface.defaults,
    timelinePath: links.map((l) => ({ frameId: l.parentFrameId, clipId: l.clipId })),
    editingClipId: leaf?.mode === "text" ? leaf.clipId : null,
    vectorEditClipId: leaf?.mode === "vectorNodes" ? leaf.clipId : null,
    shapeEditClipId: leaf?.mode === "shapeCorners" ? leaf.clipId : null,
    cropClipId: leaf?.mode === "crop" ? leaf.clipId : null,
    pivotClipId: leaf?.mode === "pivot" ? leaf.clipId : null,
    contentEditClipId: leaf && leaf.mode !== "pivot" ? leaf.clipId : null,
  };
}

/**
 * Move to a path. Normalises it first (a path pointing at deleted clips is
 * truncated, never stored broken), remembers the tab's cursor, and drops the
 * leaf editor unless the target comp is unchanged.
 */
export function navigateNav(
  doc: MotionDocument,
  nav: NavState,
  next: EditPath,
  opts: { leaf?: EditLeaf | null } = {},
): NavState {
  const path = normalizePath(doc, next) ?? editPath(next.rootFrameId);
  const sameTarget = targetFrameId(doc, path) === targetFrameId(doc, nav.path);
  return {
    path,
    leaf: opts.leaf !== undefined ? opts.leaf : sameTarget ? nav.leaf : null,
    hopsByTab: { ...nav.hopsByTab, [path.rootFrameId]: [...path.hops] },
  };
}

/**
 * Step INTO a clip from where we stand. Returns null when the clip has no
 * inside (the caller then treats the gesture as "open this clip's own editor",
 * or as nothing at all).
 */
export function enterNav(doc: MotionDocument, nav: NavState, clipId: string): NavState | null {
  const next = enterPath(doc, nav.path, clipId);
  if (!next || pathsEqual(next, nav.path)) return null;
  return navigateNav(doc, nav, next, { leaf: null });
}

/** Open a clip's interior editor as the terminal step of the current path. */
export function enterLeafNav(nav: NavState, leaf: EditLeaf | null): NavState {
  return { ...nav, leaf };
}

/**
 * ONE step out — the Escape/back semantic, in the order a person expects:
 * close the interior editor first, then leave the innermost comp, and only
 * then admit there's nowhere left to go (returns null so the caller can decide
 * whether to also clear the selection).
 */
export function exitNav(doc: MotionDocument, nav: NavState): NavState | null {
  if (nav.leaf) return { ...nav, leaf: null };
  if (nav.path.hops.length === 0) return null;
  return navigateNav(doc, nav, parentPath(nav.path), { leaf: null });
}

/** Jump to a breadcrumb depth (0 = the root comp). */
export function jumpNav(doc: MotionDocument, nav: NavState, depth: number): NavState {
  return navigateNav(doc, nav, pathAtDepth(nav.path, depth), { leaf: null });
}

/**
 * Switch to another root comp (a timeline tab, a frame click, the library),
 * restoring that tab's remembered cursor. Opening a comp that is somebody's
 * private inside re-roots through its owner chain instead, so you land INSIDE
 * the thing that contains it rather than staring at a naked orphan artboard.
 */
export function openRootNav(doc: MotionDocument, nav: NavState, frameId: string): NavState {
  const owned = pathToFrame(doc, frameId);
  if (owned.hops.length > 0) return navigateNav(doc, nav, owned, { leaf: null });
  const remembered = nav.hopsByTab[frameId] ?? [];
  return navigateNav(doc, nav, editPath(frameId, remembered), { leaf: null });
}

/**
 * The playhead that keeps the SAME INSTANT while the path changes. Entering
 * maps the current time down into the child; leaving maps it back up. Without
 * this, every drill jumps the picture, which is what makes nesting feel like
 * teleporting rather than zooming.
 */
export function playheadForNav(
  doc: MotionDocument,
  from: NavState,
  to: NavState,
  playheadMs: number,
): number {
  return playheadBetweenPaths(doc, from.path, to.path, playheadMs);
}

/** Resolve the live context for a nav value. */
export function contextOf(
  doc: MotionDocument,
  nav: NavState,
  playheadMs: number,
): EditContext | null {
  if (!nav.path.rootFrameId) return null;
  return resolveEditContext(doc, nav.path, playheadMs);
}
