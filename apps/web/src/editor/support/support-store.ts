import { create } from "zustand";

/** Whether the Support dialog is open. It opens only when someone asks. */
export const useSupport = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
