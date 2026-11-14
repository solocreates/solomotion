"use client";

import { create } from "zustand";
import { beginKeyEdit, endKeyEdit, locateClip, type DocumentStore, type KeyEditSession } from "@solomotion/core";
import { toast } from "@/lib/toast";

/**
 * EDIT KEY — the one armed shape key, if any. View state (never in history);
 * the two document writes it makes go through core `beginKeyEdit` /
 * `endKeyEdit`, so every editing tool edits the key without knowing it.
 */
interface ShapeKeyUi {
  session: KeyEditSession | null;
  keyName: string;
  arm(store: DocumentStore, clipId: string, keyId: string, name: string): void;
  done(store: DocumentStore): void;
}

export const useShapeKeyUi = create<ShapeKeyUi>((set, get) => ({
  session: null,
  keyName: "",
  arm(store, clipId, keyId, name) {
    if (get().session) get().done(store);
    let s: KeyEditSession | null = null;
    store.update(`Edit key · ${name}`, (d) => {
      s = beginKeyEdit(d, clipId, keyId);
    });
    if (s) set({ session: s, keyName: name });
  },
  done(store) {
    const s = get().session;
    if (!s) return;
    set({ session: null, keyName: "" });
    if (!locateClip(store.getState(), s.clipId)) return;
    const result: { v: ReturnType<typeof endKeyEdit> } = { v: "gone" };
    store.update("Save key", (d) => {
      result.v = endKeyEdit(d, s);
    });
    if (result.v === "topology") toast.error("Points were added or removed while editing the key — the key keeps its shape.");
  },
}));
