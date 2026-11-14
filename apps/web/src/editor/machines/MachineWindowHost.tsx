"use client";

import * as React from "react";
import { useMachineBoard } from "./machine-store";
import { lazyComponent } from "@/editor/lazy-component";

/** The board is its own chunk: a project that never opens a machine never downloads it. */
const MachineBoardWindow = lazyComponent("MachineBoardWindow", () => import("./MachineBoardWindow"));

export function MachineWindowHost() {
  const open = useMachineBoard((s) => s.open);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <MachineBoardWindow frameId={open.frameId} machineId={open.machineId} />
    </React.Suspense>
  );
}
