import {
  alignBoxes,
  distributeBoxes,
  locateClip,
  type AABB,
  type AlignMode,
  type DistributeMode,
  type DocumentStore,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { hitAABB, stageHitRects, unionAABB } from "../stage/stage-geometry";
import { writeAnimatable } from "../inspector/animatable";
import { useSession } from "./session";

/**
 * One selection UNIT for alignment: either a lone layer or a whole group that
 * must move as a block. A group counts as ONE unit (its members shift by the
 * same delta, so the group's internal design is untouched) UNLESS you've entered
 * that group — then each child is its own unit and they align individually.
 * Exactly Figma: align operates on objects, and a group is an object.
 */
interface AlignUnit {
  clipIds: string[];
  box: AABB;
}

/** Partition the current selection into alignment units + their world boxes. */
function selectionUnits(store: DocumentStore): { units: AlignUnit[]; frameId: string | null } {
  const session = useSession.getState();
  const doc = store.getState();
  const hits = stageHitRects.current;
  const groups = new Map<string, string[]>();
  let frameId: string | null = null;
  for (const id of session.selectedClipIds) {
    const loc = locateClip(doc, id);
    if (!loc || loc.clip.kind === "audio") continue;
    frameId ??= loc.clip.frameId;
    // A grouped layer folds into its group unit; an entered group's members (and
    // ungrouped layers) each stand alone.
    const gid = loc.track.groupId;
    const key = gid && gid !== session.enteredGroupId ? `g:${gid}` : `c:${id}`;
    const arr = groups.get(key);
    if (arr) arr.push(id);
    else groups.set(key, [id]);
  }
  const units: AlignUnit[] = [];
  for (const clipIds of groups.values()) {
    const boxes = clipIds.map((id) => hits.find((h) => h.clipId === id)).filter((h): h is NonNullable<typeof h> => !!h).map(hitAABB);
    const box = unionAABB(boxes);
    if (box) units.push({ clipIds, box });
  }
  return { units, frameId };
}

/** Apply a per-unit {dx,dy} translation to every member clip's transform. */
function applyDeltas(store: DocumentStore, units: AlignUnit[], deltas: Array<{ dx: number; dy: number }>, label: string) {
  const playhead = useSession.getState().playheadMs;
  store.update(label, (d) => {
    units.forEach((u, i) => {
      const { dx, dy } = deltas[i]!;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      for (const id of u.clipIds) {
        const loc = locateClip(d, id);
        if (!loc || loc.clip.kind === "audio") continue;
        const nx = Math.round(loc.clip.transform.x + dx);
        const ny = Math.round(loc.clip.transform.y + dy);
        writeAnimatable(loc.clip, "x", nx, playhead, (c) => {
          if (c.kind !== "audio") c.transform.x = nx;
        });
        writeAnimatable(loc.clip, "y", ny, playhead, (c) => {
          if (c.kind !== "audio") c.transform.y = ny;
        });
      }
    });
  });
}

const ALIGN_LABEL: Record<AlignMode, string> = {
  left: "Align left",
  hcenter: "Align horizontal centers",
  right: "Align right",
  top: "Align top",
  vcenter: "Align vertical centers",
  bottom: "Align bottom",
};

/**
 * Align the selection. With several units they flush to their shared bounds;
 * with a single unit it centers/flushes inside its frame (so one click can
 * "centralize" a lone layer or a whole group on the page).
 */
export function alignSelection(store: DocumentStore, mode: AlignMode): void {
  const { units, frameId } = selectionUnits(store);
  if (units.length === 0) return;
  let container: AABB | null;
  if (units.length >= 2) {
    container = unionAABB(units.map((u) => u.box));
  } else {
    const f = store.getState().frames.find((fr) => fr.id === frameId);
    container = f ? { minX: f.x, minY: f.y, maxX: f.x + f.width, maxY: f.y + f.height } : null;
  }
  if (!container) return;
  applyDeltas(store, units, alignBoxes(units.map((u) => u.box), container, mode), ALIGN_LABEL[mode]);
}

/** Distribute the selection so the gaps between units are equal (needs 3+). */
export function distributeSelection(store: DocumentStore, mode: DistributeMode): void {
  const { units } = selectionUnits(store);
  if (units.length < 3) {
    toast("Select 3 or more layers to distribute");
    return;
  }
  const axis = mode === "dist-h" ? "h" : "v";
  applyDeltas(store, units, distributeBoxes(units.map((u) => u.box), axis), mode === "dist-h" ? "Distribute horizontally" : "Distribute vertically");
}
