"use client";

import * as React from "react";
import { lazyModule } from "@solomotion/core";

/**
 * A component whose code arrives later — `React.lazy` over core's
 * `lazyModule`, so a UI chunk gets what every lazy part of the app gets: one
 * fetch, retries on a flaky network, a stale deploy named (the update pill
 * offers the reload), and `prefetch()` for the moment before it is needed
 * (a hover, a tab about to open).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy's own bound
export function lazyComponent<T extends React.ComponentType<any>>(
  id: string,
  load: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> & { prefetch(): void } {
  const mod = lazyModule(`ui/${id}`, load);
  const Lazy = React.lazy(() => mod.load()) as React.LazyExoticComponent<T> & { prefetch(): void };
  Lazy.prefetch = () => mod.prefetch();
  return Lazy;
}
