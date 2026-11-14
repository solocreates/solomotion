"use client";

import { lazyModule, type MotionDocument } from "@solomotion/core";
import type { WorldEngine } from "./engine";

/**
 * THE ONE DOOR TO THE 3D ENGINE — and it imports no three.js.
 *
 * Everything outside `world/engine` and `world/viewport` touches 3D through
 * this file, so the engine (three.js, its loaders and exporters) is a chunk a
 * project without a world never downloads. Synchronous callers — the 2D
 * render walk above all — ask `worldEngine()` and get null until the chunk
 * has arrived; they paint a placeholder and are re-asked when it lands
 * (`onWorldEngineReady` marks the stage dirty). Asynchronous callers — export,
 * import — `await loadWorldEngine()`. The fetching itself is core's
 * `lazyModule`: one fetch, retried on a flaky network, never a failure
 * remembered.
 */

const ENGINE = lazyModule("world-engine", () => import("./engine").then((m) => m.createWorldEngine()), { label: "3D engine" });

/** The engine if it is here; on a miss, the fetch starts (and its arrival is announced). */
export function worldEngine(): WorldEngine | null {
  return ENGINE.want();
}

export function loadWorldEngine(): Promise<WorldEngine> {
  return ENGINE.load();
}

/** Called once the engine is ready (immediately if it already is). */
export function onWorldEngineReady(cb: () => void): () => void {
  return ENGINE.onReady(() => cb());
}

/**
 * Before an export draws a single frame: the engine is loaded and every
 * imported model is parsed, so no exported frame is ever a placeholder. A
 * project without a world returns at once and downloads nothing.
 */
export async function prepareWorldsForExport(doc: MotionDocument): Promise<void> {
  if (!doc.frames.some((f) => f.world)) return;
  const engine = await loadWorldEngine();
  await engine.preloadModels(doc);
}
