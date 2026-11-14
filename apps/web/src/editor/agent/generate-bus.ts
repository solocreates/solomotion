import { create } from "zustand";

/**
 * "Generate with AI" from anywhere — the Add menu, the palette, the Media
 * panel — without importing the agent: callers set the kind here and a host
 * mounted by the editor loads the dialog (its own chunk) the first time.
 */
export type GenerateKind = "image" | "video" | "speech" | "sound" | "music";

export const useGenerate = create<{ kind: GenerateKind | null; prompt: string }>(() => ({ kind: null, prompt: "" }));

export function openGenerate(kind: GenerateKind, prompt = ""): void {
  useGenerate.setState({ kind, prompt });
}
