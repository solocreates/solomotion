import {
  buildSnapCandidates,
  createId,
  guideOwner,
  pageOfFrame,
  resolveGuideDrop,
  snapPoint,
  type AABB,
  type DocumentStore,
} from "@solomotion/core";
import { hitAABB, stageHitRects } from "./stage-geometry";
import { useSession, useStageView } from "../state/session";
import { RULER_SIZE } from "./RulerOverlay";

/**
 * A guide being dragged out of a ruler, or null at rest. `frameId` is the
 * OWNER it would land in — a frame, or the page (D17) — and `pos` is in that
 * owner's space; it is re-resolved on every move, so the draft says where the
 * drop will go before it happens.
 */
export interface GuideDraft {
  frameId: string;
  axis: "x" | "y";
  pos: number;
}

// A tiny pub/sub so the Stage render loop can flash the draft guide without
// routing a 60 Hz value through zustand (which would re-render half the app).
let draft: GuideDraft | null = null;
const subs = new Set<() => void>();
export const guideDraft = {
  get current(): GuideDraft | null {
    return draft;
  },
  set(v: GuideDraft | null) {
    draft = v;
    for (const f of subs) f();
  },
};
export function onGuideDraftChange(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/**
 * Pull a new guide out of a ruler. `axis` is what the guide is pinned on: "y"
 * for a horizontal guide from the TOP ruler, "x" for a vertical one from the
 * LEFT ruler. While dragging it snaps to the frame's layers + page edges/center
 * (like any moving object — never to other guides), when guides snapping is on.
 * Dropped inside the frame it commits; dropped back on the ruler (or outside the
 * artboard) it's discarded.
 */
export function beginGuideDrag(e: React.PointerEvent, axis: "x" | "y", store: DocumentStore): void {
  e.preventDefault();
  const container = document.querySelector<HTMLElement>("[data-stage-drop]");
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const session = useSession.getState();
  const doc = store.getState();
  // The board's page: guides dropped outside every frame land on it (D17).
  const pageId = session.activePageId && doc.pages.some((p) => p.id === session.activePageId) ? session.activePageId : doc.pages[0]?.id;
  if (!pageId) return;
  const frames = doc.frames.filter((f) => pageOfFrame(doc, f) === pageId);

  // Snap candidates: every layer and frame on the board, EXCLUDING guides (a
  // guide reacts to objects, not to its siblings). Built once — nothing moves.
  const targets: AABB[] = [
    ...stageHitRects.current.filter((h) => frames.some((f) => f.id === h.frameId)).map(hitAABB),
    ...frames.map((f) => ({ minX: f.x, minY: f.y, maxX: f.x + f.width, maxY: f.y + f.height })),
  ];
  const cand = buildSnapCandidates(targets, null, { ...session.guideSettings, toGuides: false });

  let curSx = 0;
  let curSy = 0;
  let drop: ReturnType<typeof resolveGuideDrop> | null = null;

  const onMove = (ev: PointerEvent) => {
    const view = useStageView.getState();
    curSx = ev.clientX - rect.left;
    curSy = ev.clientY - rect.top;
    let wx = (curSx - view.tx) / view.scale;
    let wy = (curSy - view.ty) / view.scale;
    if (useSession.getState().guides) {
      const threshold = session.guideSettings.thresholdPx / view.scale;
      const s = snapPoint(wx, wy, cand, threshold);
      wx = s.x;
      wy = s.y;
    }
    drop = resolveGuideDrop(frames, pageId, axis, { x: wx, y: wy });
    guideDraft.set({ frameId: drop.ownerId, axis, pos: drop.pos });
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    guideDraft.set(null);
    // Dropped back on a ruler strip → discard. Anywhere else is a guide: in a
    // frame it rides with the frame, on the board it is a page guide.
    const onRuler = (axis === "y" ? curSy : curSx) < RULER_SIZE;
    const at = drop;
    if (onRuler || !at) return;
    store.update(at.kind === "page" ? "Add page guide" : "Add guide", (d) => {
      guideOwner(d, at.ownerId, true)?.guides.push({ id: createId("guide"), axis, pos: Math.round(at.pos), color: null, style: null });
    });
    // MAKING a guide un-hides them. Placing one you then cannot see is not a
    // state anyone means to be in, and the alternative — refusing the drag
    // while hidden — takes the ruler's whole purpose away to enforce a
    // preference the gesture has just overruled.
    useSession.getState().setRulerGuides(true);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  onMove(e.nativeEvent); // seed the draft at the press point
}
