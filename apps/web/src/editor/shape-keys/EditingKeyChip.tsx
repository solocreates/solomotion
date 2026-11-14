"use client";

import * as React from "react";
import { useDocStore } from "../state/document-context";
import { useShapeKeyUi } from "./state";

/** The stage's context-bar chip while a key is armed: "Editing key · Smile". Click or Esc saves it. */
export function EditingKeyChip({ icon }: { icon?: React.ReactNode }) {
  const store = useDocStore();
  const name = useShapeKeyUi((s) => (s.session ? s.keyName : null));
  React.useEffect(() => {
    if (name === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      useShapeKeyUi.getState().done(store);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [name, store]);
  if (name === null) return null;
  return (
    <button
      type="button"
      title="Done editing the key (Esc)"
      onClick={() => useShapeKeyUi.getState().done(store)}
      className="flex items-center gap-1 rounded-lg bg-primary/15 px-1.5 py-1 font-medium text-primary transition-colors hover:bg-primary/25"
    >
      {icon}
      Editing key · {name}
    </button>
  );
}
