"use client";

import * as React from "react";
import { Stage } from "../stage/Stage";
import { useWorldViewportFrame } from "../world/state";
import { lazyComponent } from "@/editor/lazy-component";

// The 3D workspace is its own chunk (three.js and all): a project that never
// opens a world never downloads it.
const WorldStage = lazyComponent("WorldStage", () => import("../world/WorldStage"));

/**
 * The centre surface: the pixel Stage, or — when you are inside a 3D world —
 * the 3D viewport. The node board floats over either (`NodeBoardWindow`).
 */
export function CenterStage() {
  const worldId = useWorldViewportFrame();
  if (worldId) {
    return (
      <React.Suspense fallback={<div className="flex h-full w-full items-center justify-center bg-[#2f3035] text-[12px] text-white/50">Opening 3D…</div>}>
        <WorldStage key={worldId} frameId={worldId} />
      </React.Suspense>
    );
  }
  return <Stage />;
}
