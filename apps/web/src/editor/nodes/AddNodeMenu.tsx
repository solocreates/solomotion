"use client";

import * as React from "react";
import { CATEGORY_META, NODE_CATEGORIES, defaultNodeRegistry, type NodeCategory, type NodeContext } from "@solomotion/core";
import { BoardAddMenu, type BoardAddAnchor, type BoardAddGroup } from "../board/BoardAddMenu";

/**
 * The add-node palette — the shared board Shift+A (`board/BoardAddMenu`) fed
 * the node registry for this context, grouped by category.
 */

export type AddMenuAnchor = BoardAddAnchor;

export function AddNodeMenu({
  anchor,
  context,
  onPick,
  onClose,
}: {
  anchor: AddMenuAnchor;
  context: NodeContext;
  onPick: (type: string) => void;
  onClose: () => void;
}) {
  const groups = React.useMemo((): BoardAddGroup[] => {
    const map = new Map<NodeCategory, Array<{ id: string; label: string; color: string }>>();
    // `hidden` types are materialised by the app (the per-effect cards mirror
    // the layer's stack), so they never belong in the palette.
    for (const def of defaultNodeRegistry.forContext(context)) {
      if (def.hidden) continue;
      const list = map.get(def.category) ?? [];
      list.push({ id: def.type, label: def.title, color: CATEGORY_META[def.category].color });
      map.set(def.category, list);
    }
    return NODE_CATEGORIES.filter((c) => map.has(c)).map((c) => ({ heading: CATEGORY_META[c].label, items: map.get(c)! }));
  }, [context]);
  return <BoardAddMenu anchor={anchor} groups={groups} placeholder="Add node…" empty="No nodes found." onPick={onPick} onClose={onClose} />;
}
