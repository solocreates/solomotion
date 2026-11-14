"use client";

import * as React from "react";

/**
 * A clock a render can read: the time is STATE, ticking every `everyMs` while
 * `active`, so it reaches the view through React rather than from a
 * `Date.now()` the render calls itself (which the React Compiler would cache).
 * `read` picks the clock — `performance.now` for task timings, `Date.now` for
 * wall-clock stamps.
 */
export function useNow(active: boolean, read: () => number = () => performance.now(), everyMs = 250): number {
  const [t, setT] = React.useState(read);
  React.useEffect(() => {
    if (!active) return;
    setT(read());
    const id = window.setInterval(() => setT(read()), everyMs);
    return () => window.clearInterval(id);
    // `read` is a clock, not an input: swapping it mid-tick is not a thing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, everyMs]);
  return t;
}
