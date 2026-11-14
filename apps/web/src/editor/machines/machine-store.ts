"use client";

import { create } from "zustand";

/**
 * Which machine board is open — view state only (the machine lives in the
 * document). Tiny and eager so every entry point (the Character tab's Machine
 * row, the palette) can open the board without loading its chunk.
 */
interface MachineBoardState {
  open: { frameId: string; machineId: string } | null;
  tab: "board" | "code";
  openBoard: (frameId: string, machineId: string) => void;
  setTab: (tab: "board" | "code") => void;
  close: () => void;
}

export const useMachineBoard = create<MachineBoardState>((set) => ({
  open: null,
  tab: "board",
  openBoard: (frameId, machineId) => set({ open: { frameId, machineId } }),
  setTab: (tab) => set({ tab }),
  close: () => set({ open: null }),
}));
