"use client";

import * as React from "react";
import { supervisor, type TaskRecord } from "@solomotion/core";

/** The supervisor's tasks, running first — every Activity surface reads this one store. */
export function useTasks(): readonly TaskRecord[] {
  return React.useSyncExternalStore(
    (fn) => supervisor.subscribe(fn),
    () => supervisor.tasks(),
    () => supervisor.tasks(),
  );
}
