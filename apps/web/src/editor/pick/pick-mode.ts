"use client";

import { create } from "zustand";
import { pickAccepts, pickFilterNoun, resolvePick, type PickCandidate, type PickFilter } from "@solomotion/core";
import { peekDoc } from "../state/document-context";
import { CLAIM_SLOP_PX, claimPointer, multiFingerDown, subscribePointerEnd } from "../input/pointer-gestures";
import { isTypingTarget } from "../input/typing-target";

/**
 * PICK MODE — "point this field at something", the app-wide armed state.
 *
 * Blender's eyedropper, done as a MODE with one owner, like the lasso arm: a
 * field asks (`enterPick`), and until the pick lands or is abandoned the whole
 * app is the picker. Candidates light up wherever they appear — the stage, the
 * timeline's clip bars, the layers list — non-candidates dim, the thing under
 * the pointer gets one designed box, and a chip says what is being asked so the
 * app never looks like it stopped responding.
 *
 * WHY ONE WINDOW-LEVEL DISPATCHER, not a handler per surface. Every surface
 * already has a press handler that means something else (select, drag, scrub,
 * marquee). Teaching each one "unless a pick is armed" is nine edits that each
 * can forget, and the one that forgets is the bug. So while armed, a capture
 * listener on the window takes the press BEFORE any of them, and decides by
 * asking two seams that already exist:
 *
 *   DOM surfaces   the attributes they tag their items with anyway —
 *                  `data-clip-drop-id` (timeline bars, layer rows) and the
 *                  generic `data-pick-key="<key>"` for anything else.
 *   canvases       a registered `PickSurface` (the stage), whose hit test is
 *                  the stage's own `hitStackAt` — the same one a click runs.
 *
 * Validity is core's `pickAccepts` — the SAME predicate the field's dropdown is
 * built with — so the canvas can never light up a layer the list would refuse.
 *
 * WHERE a pick may land is the request's, too (`on`): every surface names its
 * AREA — a canvas when it registers, a docked panel by `data-pick-area` on its
 * host — and a request that says `on: ["stage"]` dims the timeline and the
 * layers list whole. The filter says WHAT; the areas say WHERE; neither knows
 * about the other.
 *
 * Exits are every gesture that means "never mind": Esc, right-click, a tap on
 * nothing, the chip's ×. A press on a dimmed (not pickable) thing does NOT exit:
 * missing a small target should not cost you the mode.
 *
 * Pointer rules (docs/responsive-and-gestures.md): a tap picks with any pointer;
 * a finger dragging on a canvas pans it, on a scroller scrolls it natively; two
 * fingers navigate (the arbiter supersedes our press); the long press is off for
 * the duration (`data-no-longpress` on the root) because a hold means nothing
 * here; every press ends through `subscribePointerEnd`, so a cancelled touch can
 * never leave a press armed.
 */

/** A box in CLIENT px: centre, size, and the layer's own rotation/shear. */
export interface PickBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
  skewX: number;
  skewY: number;
}

export const boxOfRect = (r: DOMRect, outset = 0): PickBox => ({
  cx: r.left + r.width / 2,
  cy: r.top + r.height / 2,
  w: r.width + outset * 2,
  h: r.height + outset * 2,
  rotation: 0,
  skewX: 0,
  skewY: 0,
});

/**
 * Where on screen a pick can land. Open-ended: a panel is an area by putting
 * `data-pick-area="<id>"` on its host (its panel id), a canvas by naming one
 * when it registers.
 */
export type PickArea = "stage" | "timeline" | "layers" | "nodes" | "inspector" | (string & {});

/** A canvas that cannot tag DOM nodes — the stage — answers for itself. */
export interface PickSurface {
  element: HTMLElement;
  area: PickArea;
  /** The topmost candidate under a client point; "blocked" when something is
   *  there but is not pickable; null over nothing. */
  hit: (x: number, y: number, accepts: (key: string) => boolean) => { key: string; box: PickBox } | "blocked" | null;
  /** Every candidate's box on this surface — the veil cuts these out. */
  boxes: (accepts: (key: string) => boolean) => Array<{ key: string; box: PickBox }>;
  /** Where one key is on this surface, for a list row's hover preview. */
  boxOf: (key: string) => PickBox | null;
  /** Changes whenever geometry does (camera, redraw) — the layer polls it. */
  version: () => unknown;
  /** One finger dragging on this surface moves its camera. */
  pan?: (dx: number, dy: number) => void;
}

/** After a pick: choose WITHIN it (a pick-whip landed on a layer — which value?). */
export interface PickRefinement {
  filter: PickFilter;
  /** A key to list first and pre-select (the property with the field's own path). */
  prefer?: string;
  /** Offer the picked thing itself as the first row ("Whole layer"). */
  allowPicked?: string;
}

export interface PickRequest {
  /** Who asked. The field whose aim button shows armed. */
  owner: string;
  filter: PickFilter;
  /** What the chip asks for — "voice", "body". Default: the filter's kinds. */
  noun?: string;
  /** Only these areas take the pick; the rest dim whole. Default: everywhere. */
  on?: readonly PickArea[];
  onPick: (candidate: PickCandidate) => void;
  refine?: (picked: PickCandidate) => PickRefinement | null;
  onExit?: (reason: PickExit) => void;
}

export type PickExit = "picked" | "cancel" | "replaced";

export interface PickHover {
  key: string;
  box: PickBox;
}

interface RefineState {
  picked: PickCandidate;
  refinement: PickRefinement;
  at: { x: number; y: number };
}

interface PickModeState {
  request: PickRequest | null;
  /** The candidate under the pointer. */
  hover: PickHover | null;
  /** Something is under the pointer, but it cannot be picked. */
  blocked: boolean;
  /** A list row's hover — the object it names, shown where it lives. */
  preview: string | null;
  refine: RefineState | null;
  /** Bumped when a press lands on something unpickable — the chip nods. */
  refusals: number;
}

export const usePickMode = create<PickModeState>(() => ({
  request: null,
  hover: null,
  blocked: false,
  preview: null,
  refine: null,
  refusals: 0,
}));

export const pickArmed = (): boolean => usePickMode.getState().request !== null;

/** "Pick a voice", "Pick a layer or frame". */
export function pickPrompt(request: PickRequest): string {
  return `Pick a ${request.noun ?? pickFilterNoun(request.filter)}`;
}

// ── Surfaces ─────────────────────────────────────────────────────────────────

const surfaces = new Set<PickSurface>();

export function registerPickSurface(surface: PickSurface): () => void {
  surfaces.add(surface);
  return () => surfaces.delete(surface);
}

export function pickSurfaces(): ReadonlySet<PickSurface> {
  return surfaces;
}

const AREA = "[data-pick-area]";

/** The area an element sits in — its nearest tagged host. */
export function pickAreaOf(el: Element): PickArea | null {
  return el.closest(AREA)?.getAttribute("data-pick-area") ?? null;
}

/** May the armed request land in this area? Everything may when it names none. */
export function pickAreaAllowed(area: PickArea | null): boolean {
  const on = usePickMode.getState().request?.on;
  return !on || (area !== null && on.includes(area));
}

// ── Keys from the DOM ────────────────────────────────────────────────────────

export const PICK_TAGGED = "[data-pick-key],[data-clip-drop-id]";

export function keyOfElement(el: Element): string | null {
  const key = el.getAttribute("data-pick-key");
  if (key) return key;
  const clip = el.getAttribute("data-clip-drop-id");
  return clip ? `clip:${clip}` : null;
}

/** Where a key is on screen right now: a canvas's box, else its first tagged
 *  DOM node that is actually laid out. */
export function locateKey(key: string): PickBox | null {
  for (const s of surfaces) {
    const box = s.boxOf(key);
    if (box) return box;
  }
  if (typeof document === "undefined") return null;
  const parsed = key.startsWith("clip:") ? key.slice(5) : null;
  const selector = parsed ? `[data-clip-drop-id="${CSS.escape(parsed)}"],[data-pick-key="${CSS.escape(key)}"]` : `[data-pick-key="${CSS.escape(key)}"]`;
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return boxOfRect(r, 2);
  }
  return null;
}

// ── Enter / exit ─────────────────────────────────────────────────────────────

let teardown: { visuals: () => void; listeners: () => void } | null = null;
let accepts: (key: string) => boolean = () => false;

export function enterPick(request: PickRequest): void {
  const previous = usePickMode.getState().request;
  if (previous) finish("replaced");
  // Validity against the document AS IT IS NOW, memoised per key and per
  // snapshot — the hover runs this on every frame the pointer moves.
  let memoDoc: unknown = null;
  const memo = new Map<string, boolean>();
  accepts = (key) => {
    const doc = peekDoc();
    if (!doc) return false;
    if (doc !== memoDoc) {
      memoDoc = doc;
      memo.clear();
    }
    let ok = memo.get(key);
    if (ok === undefined) memo.set(key, (ok = pickAccepts(doc, request.filter, key)));
    return ok;
  };
  usePickMode.setState({ request, hover: null, blocked: false, refine: null, preview: null });
  teardown?.listeners();
  teardown = install();
}

/** Leave the mode. Safe to call when it is not armed. */
export function exitPick(reason: PickExit = "cancel"): void {
  if (usePickMode.getState().request) finish(reason);
}

function finish(reason: PickExit) {
  const { request } = usePickMode.getState();
  usePickMode.setState({ request: null, hover: null, blocked: false, refine: null });
  accepts = () => false;
  aimDrag = null;
  press = null;
  // The look goes NOW; the listeners outlive the mode just long enough to eat
  // the click that follows the picking release (and a touch's synthetic one),
  // so the timeline does not also select the clip you picked.
  const installed = teardown;
  teardown = null;
  if (installed) {
    installed.visuals();
    const t = setTimeout(installed.listeners, TRAILING_CLICK_MS);
    teardown = {
      visuals: () => {},
      listeners: () => {
        clearTimeout(t);
        installed.listeners();
      },
    };
  }
  request?.onExit?.(reason);
}

const TRAILING_CLICK_MS = 400;

/** The current mode's accept test (false when nothing is armed). */
export const pickAcceptsKey = (key: string): boolean => accepts(key);

/**
 * Commit a candidate — from the canvas, a DOM row, or a field's own list. A
 * request with a refinement opens it at `at` instead of finishing.
 */
export function commitPick(candidate: PickCandidate, at?: { x: number; y: number }): void {
  const { request } = usePickMode.getState();
  if (!request) return;
  const refinement = request.refine?.(candidate) ?? null;
  if (refinement) {
    usePickMode.setState({ refine: { picked: candidate, refinement, at: at ?? centre() }, hover: null });
    return;
  }
  request.onPick(candidate);
  finish("picked");
}

/** The refinement's answer — a row of the menu it opened. */
export function commitRefined(candidate: PickCandidate): void {
  const { request } = usePickMode.getState();
  if (!request) return;
  request.onPick(candidate);
  finish("picked");
}

const centre = () => ({ x: window.innerWidth / 2, y: window.innerHeight / 3 });

/**
 * PICK-WHIP: press the aim button and DRAG to the target; release picks. A
 * press that does not travel is a click instead, and leaves the mode armed for
 * a tap — the same button serves both habits (AE's whip, Blender's eyedropper).
 */
export function beginPickDrag(e: { pointerId: number; clientX: number; clientY: number; travel?: number }, request: PickRequest): void {
  enterPick(request);
  aimDrag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, travel: e.travel ?? 0 };
  // Stationary-first: the browser must not take this finger as a scroll of the
  // inspector it started in.
  claimPointer(e.pointerId, "drag");
}

export function setPickPreview(key: string | null): void {
  if (usePickMode.getState().preview !== key) usePickMode.setState({ preview: key });
}

// ── The dispatcher ───────────────────────────────────────────────────────────

interface Press {
  id: number;
  x0: number;
  y0: number;
  lastX: number;
  lastY: number;
  travel: number;
  surface: PickSurface | null;
  touch: boolean;
}

let press: Press | null = null;
let aimDrag: { id: number; x0: number; y0: number; travel: number } | null = null;

type Resolution =
  | { kind: "ui" }
  | { kind: "candidate"; key: string; box: PickBox; surface: PickSurface | null }
  | { kind: "blocked"; surface: PickSurface | null }
  | { kind: "empty"; surface: PickSurface | null };

const inPickUi = (t: EventTarget | null) => t instanceof Element && !!t.closest("[data-pick-ui]");

function resolveAt(x: number, y: number): Resolution {
  // `elementFromPoint`, not the event target: a touch's events stay on the
  // element it went down on, and a drag from the aim button is over something
  // else entirely. Our own overlays are `pointer-events: none`, so they are
  // transparent to this.
  const el = document.elementFromPoint(x, y);
  if (!el) return { kind: "empty", surface: null };
  if (el.closest("[data-pick-ui]")) return { kind: "ui" };
  for (const s of surfaces) {
    if (!s.element.contains(el)) continue;
    if (!pickAreaAllowed(s.area)) return { kind: "blocked", surface: s };
    // Something the canvas draws in the DOM over itself (a tracker's outline)
    // is more specific than the pixels under it, and needs no hit test.
    const over = el.closest(PICK_TAGGED);
    const overKey = over && s.element.contains(over) ? keyOfElement(over) : null;
    if (over && overKey && accepts(overKey)) return { kind: "candidate", key: overKey, box: boxOfRect(over.getBoundingClientRect(), 2), surface: s };
    const hit = s.hit(x, y, accepts);
    if (hit === "blocked") return { kind: "blocked", surface: s };
    return hit ? { kind: "candidate", ...hit, surface: s } : { kind: "empty", surface: s };
  }
  const tagged = el.closest(PICK_TAGGED);
  const key = tagged ? keyOfElement(tagged) : null;
  if (!tagged || !key) return { kind: "empty", surface: null };
  if (!pickAreaAllowed(pickAreaOf(tagged))) return { kind: "blocked", surface: null };
  return accepts(key) ? { kind: "candidate", key, box: boxOfRect(tagged.getBoundingClientRect(), 2), surface: null } : { kind: "blocked", surface: null };
}

function showHover(r: Resolution) {
  const s = usePickMode.getState();
  if (s.refine) return;
  const hover = r.kind === "candidate" ? { key: r.key, box: r.box } : null;
  const blocked = r.kind === "blocked";
  const same = hover?.key === s.hover?.key && sameBox(hover?.box, s.hover?.box);
  if (!same || blocked !== s.blocked) usePickMode.setState({ hover, blocked });
  document.documentElement.dataset.picking = blocked ? "blocked" : hover ? "over" : "on";
}

const sameBox = (a: PickBox | undefined, b: PickBox | undefined) =>
  a === b || (!!a && !!b && a.cx === b.cx && a.cy === b.cy && a.w === b.w && a.h === b.h && a.rotation === b.rotation);

function pickAt(x: number, y: number): "picked" | "blocked" | "empty" {
  const r = resolveAt(x, y);
  if (r.kind === "candidate") {
    const doc = peekDoc();
    const candidate = doc ? resolvePick(doc, r.key) : null;
    if (candidate) {
      commitPick(candidate, { x, y });
      return "picked";
    }
  }
  return r.kind === "blocked" ? "blocked" : "empty";
}

const refuse = () => usePickMode.setState((s) => ({ refusals: s.refusals + 1 }));

function install(): { visuals: () => void; listeners: () => void } {
  const root = document.documentElement;
  root.dataset.picking = "on";
  // A hold means nothing in this mode; the app-wide long press must not turn
  // a slow tap into a context menu (which would read as an exit).
  root.setAttribute("data-no-longpress", "");

  let raf = 0;
  let pending: { x: number; y: number } | null = null;
  const flush = () => {
    raf = 0;
    if (pending && usePickMode.getState().request) showHover(resolveAt(pending.x, pending.y));
    pending = null;
  };

  const swallow = (e: Event) => {
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
  };
  const armed = () => usePickMode.getState().request !== null;

  const onDown = (e: PointerEvent) => {
    if (!armed() || inPickUi(e.target)) return;
    // Middle-drag still navigates a canvas; a second finger is a pinch.
    if (e.button === 1 || multiFingerDown() || press) return;
    swallow(e);
    if (e.button === 2) return exitPick("cancel");
    // A refinement menu is open: anything outside it is "never mind".
    if (usePickMode.getState().refine) return exitPick("cancel");
    const r = resolveAt(e.clientX, e.clientY);
    press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY, travel: 0, surface: r.kind === "ui" ? null : r.surface, touch: e.pointerType === "touch" };
  };

  const onMove = (e: PointerEvent) => {
    if (!armed()) return;
    if (aimDrag?.id === e.pointerId) aimDrag.travel = Math.max(aimDrag.travel, Math.hypot(e.clientX - aimDrag.x0, e.clientY - aimDrag.y0));
    if (press?.id === e.pointerId) {
      press.travel = Math.max(press.travel, Math.hypot(e.clientX - press.x0, e.clientY - press.y0));
      // A finger dragging on a canvas is navigation, exactly as it is outside
      // the mode — the canvas cannot scroll natively, so it is handed the delta.
      if (press.touch && press.surface?.pan && press.travel > CLAIM_SLOP_PX) {
        press.surface.pan(e.clientX - press.lastX, e.clientY - press.lastY);
      }
      press.lastX = e.clientX;
      press.lastY = e.clientY;
    }
    // Canvases have hover behaviours of their own (outlines, cursors) that
    // would contradict ours; DOM surfaces keep theirs.
    if (e.target instanceof Element && [...surfaces].some((s) => s.element.contains(e.target as Element))) e.stopPropagation();
    pending = { x: e.clientX, y: e.clientY };
    if (!raf) raf = requestAnimationFrame(flush);
  };

  const onUp = (e: PointerEvent) => {
    if (!armed()) return;
    if (aimDrag?.id === e.pointerId) {
      const drag = aimDrag;
      aimDrag = null;
      // Barely moved: that was a CLICK on the aim button — stay armed for a tap.
      if (drag.travel <= CLAIM_SLOP_PX) return;
      swallow(e);
      if (pickAt(e.clientX, e.clientY) !== "picked") exitPick("cancel");
      return;
    }
    if (press?.id !== e.pointerId) return;
    const p = press;
    press = null;
    swallow(e);
    if (p.travel > CLAIM_SLOP_PX) return; // a pan or a scroll, not a pick
    const result = pickAt(e.clientX, e.clientY);
    if (result === "blocked") refuse();
    else if (result === "empty") exitPick("cancel");
  };

  // Every ending that is not a release ABORTS — never commits.
  const stopEnd = subscribePointerEnd((id, reason) => {
    if (reason === "up") return;
    if (press?.id === id) press = null;
    if (aimDrag?.id === id) {
      aimDrag = null;
      exitPick("cancel");
    }
  });

  // The compatibility events a press would have produced, and the click that
  // follows a pick — nothing underneath may act on them.
  const onMouse = (e: MouseEvent) => {
    if (inPickUi(e.target)) return;
    if (!armed() && e.type !== "click" && e.type !== "mouseup") return;
    swallow(e);
  };
  const onContext = (e: MouseEvent) => {
    if (!armed()) return;
    swallow(e);
    exitPick("cancel");
  };

  const onKey = (e: KeyboardEvent) => {
    if (!armed()) return;
    if (e.key === "Escape") {
      swallow(e);
      exitPick("cancel");
      return;
    }
    // Typing (the refinement's search, a field's own) and ⌘/Ctrl chords (zoom
    // to find the target) pass; every other shortcut would act on a document
    // you are in the middle of pointing at.
    if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || inPickUi(e.target)) return;
    swallow(e);
  };

  // Dim what cannot be picked, wherever it is tagged — including rows that
  // mount while the mode is armed (a scrolled list, an opened group).
  let tagRaf = 0;
  const tag = () => {
    tagRaf = 0;
    for (const el of document.querySelectorAll(PICK_TAGGED)) {
      const key = keyOfElement(el);
      const state = key && accepts(key) && pickAreaAllowed(pickAreaOf(el)) ? "on" : "off";
      if (el.getAttribute("data-pick") !== state) el.setAttribute("data-pick", state);
    }
  };
  const observer = new MutationObserver(() => {
    if (!tagRaf) tagRaf = requestAnimationFrame(tag);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-clip-drop-id", "data-pick-key"] });
  tag();

  const opts = { capture: true } as const;
  window.addEventListener("pointerdown", onDown, opts);
  window.addEventListener("pointermove", onMove, opts);
  window.addEventListener("pointerup", onUp, opts);
  for (const type of ["mousedown", "mouseup", "click", "dblclick", "auxclick"] as const) window.addEventListener(type, onMouse, opts);
  window.addEventListener("contextmenu", onContext, opts);
  window.addEventListener("keydown", onKey, opts);

  const visuals = () => {
    observer.disconnect();
    if (raf) cancelAnimationFrame(raf);
    if (tagRaf) cancelAnimationFrame(tagRaf);
    raf = tagRaf = 0;
    delete root.dataset.picking;
    root.removeAttribute("data-no-longpress");
    for (const el of document.querySelectorAll("[data-pick]")) el.removeAttribute("data-pick");
  };
  const listeners = () => {
    visuals();
    window.removeEventListener("pointerdown", onDown, opts);
    window.removeEventListener("pointermove", onMove, opts);
    window.removeEventListener("pointerup", onUp, opts);
    for (const type of ["mousedown", "mouseup", "click", "dblclick", "auxclick"] as const) window.removeEventListener(type, onMouse, opts);
    window.removeEventListener("contextmenu", onContext, opts);
    window.removeEventListener("keydown", onKey, opts);
    stopEnd();
  };
  return { visuals, listeners };
}
