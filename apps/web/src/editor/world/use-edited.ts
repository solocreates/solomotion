"use client";

import * as React from "react";
import { locateClip, type Clip } from "@solomotion/core";
import { useDocStore } from "../state/document-context";
import { useWorldUi } from "./state";

/**
 * The kind of the layer edit mode is editing — a selector, so the chrome
 * re-renders when the KIND changes, not on every edit to the document.
 */
export function useEditedKind(): Clip["kind"] | null {
  const store = useDocStore();
  const id = useWorldUi((s) => (s.mode === "edit" ? s.editClipId : null));
  const read = React.useCallback(() => (id ? (locateClip(store.getState(), id)?.clip.kind ?? null) : null), [store, id]);
  return React.useSyncExternalStore(store.subscribe, read, read);
}
