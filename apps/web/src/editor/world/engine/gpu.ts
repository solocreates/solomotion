"use client";

import * as THREE from "three";
import { create } from "zustand";
import { toast } from "@/lib/toast";

/**
 * THE GPU, as one fact the app can read: can we make a WebGL renderer right now?
 *
 * Every 3D renderer is created HERE. When the browser refuses (it turns WebGL
 * off for a page whose GPU context was lost too often, or the GPU process is
 * gone), the refusal is recorded once, said once, and retried with a backoff —
 * instead of every frame of every world throwing "A WebGL context could not be
 * created" into the console, which buried the editor in errors while the 2D
 * parts would have worked fine.
 */
export const useGpu = create<{ available: boolean; reason: string | null }>(() => ({ available: true, reason: null }));

const RETRY_MS = 15_000;
let refusedAt = 0;
let told = false;

/** A WebGL renderer, or null while the browser will not give us one. Never throws. */
export function createRenderer(params: THREE.WebGLRendererParameters): THREE.WebGLRenderer | null {
  if (!useGpu.getState().available && performance.now() - refusedAt < RETRY_MS) return null;
  try {
    const r = new THREE.WebGLRenderer(params);
    if (!useGpu.getState().available) useGpu.setState({ available: true, reason: null });
    return r;
  } catch (e) {
    refusedAt = performance.now();
    const reason = e instanceof Error ? e.message : String(e);
    useGpu.setState({ available: false, reason });
    if (!told) {
      told = true;
      console.warn("[3D] WebGL is unavailable; 3D pictures are paused.", reason);
      toast.error("3D is paused — this browser turned off WebGL for the tab. Reload it; if 3D stays off, restart the browser.");
    }
    return null;
  }
}
