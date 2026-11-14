import * as React from "react";
import type { DragOutOptions } from "../panels/drag-out";
import { useMarks } from "../state/marks";

type StartDragOut = (e: React.PointerEvent, opts: DragOutOptions) => void;

/**
 * DROPPING A THING INTO A COLLECTION, wherever the thing came from.
 *
 * Collections are deliberately mixed-domain — a "Trailer kit" holds six sounds
 * and four icons — so the gesture that fills one cannot belong to the sound
 * browser. It belongs beside `marks`, and every browser that can drag an item
 * out is a browser that can drop one in.
 *
 * Hit-testing rather than HTML5 drag-and-drop, because the panels use a POINTER
 * drag (`useDragOut`): it survives a scroll, draws its own ghost and works on
 * touch, none of which `dataTransfer` does. The cost is that a drop target is
 * not a listener but a rectangle you have to look under the cursor for — which
 * is what this is.
 *
 * The attribute goes on a WRAPPER around the row, never the row's button: a
 * label or a count inside it would otherwise be a hole in its own target.
 */
export const COLLECTION_DROP_ATTR = "data-collection-id";

/** The collection under this point, if any. */
export function collectionAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const hit = el?.closest<HTMLElement>(`[${COLLECTION_DROP_ATTR}]`);
  return hit?.getAttribute(COLLECTION_DROP_ATTR) ?? null;
}

/** Spread onto the wrapper that should accept drops for `id`. */
export function collectionDropProps(id: string) {
  return { [COLLECTION_DROP_ATTR]: id } as Record<string, string>;
}

/**
 * Make every drag out of a browser also a drag INTO a collection.
 *
 * Wrapping the panel's drag once — rather than teaching each row about
 * collections — means a row declares only what it is (`collect`) and any row
 * added later is droppable for free. `onDropElsewhere` is the hook the drag
 * system already exposes for "released somewhere the editor does not own",
 * which is exactly what a rail row is.
 *
 * Returns the wrapped starter plus the collection currently under the pointer,
 * which is what the rail draws its drop ring from.
 */
export function useCollectionDrop(beginDrag: StartDragOut): {
  startDragOut: StartDragOut;
  dropId: string | null;
} {
  const addTo = useMarks((s) => s.addTo);
  const [dropId, setDropId] = React.useState<string | null>(null);

  const startDragOut = React.useCallback<StartDragOut>(
    (e, opts) => {
      const ref = opts.collect;
      beginDrag(e, {
        ...opts,
        onHover: ref ? (x, y) => setDropId(collectionAt(x, y)) : opts.onHover,
        onDropElsewhere: ref
          ? (x, y) => {
              const id = collectionAt(x, y);
              if (!id) return false;
              addTo(id, ref);
              return true;
            }
          : opts.onDropElsewhere,
        onEnd: () => {
          setDropId(null);
          opts.onEnd?.();
        },
      });
    },
    [beginDrag, addTo],
  );

  return { startDragOut, dropId };
}
