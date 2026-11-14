"use client";

import * as React from "react";
import { Home } from "lucide-react";
import { buildPath } from "./model/tree";
import { useFiler, type FilerStore } from "./use-file-manager";
import { Crumbs, type Crumb } from "../ui/Crumbs";

/**
 * The path from root to the current folder. A thin ADAPTER over the shared
 * `Crumbs` primitive: it resolves the folder chain, and the primitive owns the
 * look, the overflow collapsing and the drop targets — the same ones the preset
 * browser gets for free.
 */
export function Breadcrumb<T>({ fm, maxDepth, compact }: { fm: FilerStore<T>; maxDepth?: number; compact?: boolean }) {
  const tree = useFiler(fm, (s) => s.tree);
  const currentFolderId = useFiler(fm, (s) => s.currentFolderId);
  const trail = React.useMemo<Crumb[]>(
    () => [
      { id: null, icon: <Home className="size-3.5" /> },
      ...buildPath(tree, currentFolderId).map((f) => ({ id: f.id, label: f.name })),
    ],
    [tree, currentFolderId],
  );

  return (
    <Crumbs
      trail={trail}
      currentId={currentFolderId}
      onNavigate={(id) => fm.getState().navigate(id)}
      maxDepth={maxDepth}
      compact={compact}
      dropAttribute="parent"
    />
  );
}
