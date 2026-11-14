import { createProfiler } from "@solomotion/core";

/**
 * The app's ONE render profiler.
 *
 * A module singleton rather than a store value, deliberately: it is written to
 * dozens of times per frame by the render loop and read a couple of times a
 * second by a HUD. Putting it in zustand would re-render React on every layer
 * of every frame to carry numbers nobody is looking at yet — which is a
 * profiler that makes the thing it measures slower, and therefore lies.
 *
 * The stage hands this to `DrawOptions.profiler` only while the HUD is open; the
 * rest of the time the renderer sees null and pays one truthiness check per
 * layer.
 */
export const renderProfiler = createProfiler(90);
