import { Activity, AudioLines, Eye, EyeOff, Repeat, Speech, Waves, Workflow, Wind, Zap, type LucideIcon } from "lucide-react";

/**
 * HOW A BEHAVIOR LOOKS, everywhere it shows — its card in the stack, its
 * blocks on the timeline, its chip on a lane's header. One table, so a blink is
 * the same blue in all three and a person learns the colour once.
 */

const ICON: Record<string, LucideIcon> = {
  lipSync: Speech,
  blink: EyeOff,
  glance: Eye,
  breathe: Wind,
  sway: Waves,
  nod: AudioLines,
  cycle: Repeat,
  machine: Workflow,
};

/** Tints chosen to read on both themes over the timeline's lane background. */
const TINT: Record<string, string> = {
  lipSync: "#e8678a",
  blink: "#5aa9e6",
  glance: "#7bc4b2",
  breathe: "#8bc06a",
  sway: "#b59cf0",
  nod: "#e8a35a",
  cycle: "#e0c25a",
  machine: "#9a8cff",
};

export function behaviorIcon(type: string): LucideIcon {
  return ICON[type] ?? (type ? Zap : Activity);
}

export function behaviorTint(type: string): string {
  return TINT[type] ?? "#9aa0a6";
}

/** Hatching in a behavior's tint: generated, not yours. */
export function behaviorHatch(type: string): string {
  const c = behaviorTint(type);
  return `repeating-linear-gradient(135deg, color-mix(in oklab, ${c} 28%, transparent) 0 4px, color-mix(in oklab, ${c} 10%, transparent) 4px 8px)`;
}
