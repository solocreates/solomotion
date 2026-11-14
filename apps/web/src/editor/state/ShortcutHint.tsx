"use client";

import * as React from "react";
import { Kbd } from "@/components/ui/kbd";
import { formatCombo, useCombo } from "./shortcut-registry";

/**
 * THE shortcut hint. Give it a command id and it renders that command's LIVE
 * combo — so a rebind in Settings moves through every menu, tooltip and palette
 * row at once, and a menu can never advertise a key that no longer works.
 *
 * There used to be a private copy of this in each menu file (`Sc` in the
 * selection menu, `Combo` in the app menu) plus hand-typed "⌘V" strings in the
 * media library and the filer — four spellings of one fact, three of which the
 * shortcut editor could not reach. This is the only one.
 *
 * Renders nothing when the command is unbound, which is what makes it safe to
 * drop on every menu row: a row shows a hint automatically if one exists.
 */
export function ShortcutHint({ id, className }: { id: string; className?: string }) {
  const combo = useCombo(id);
  if (!combo) return null;
  return <Kbd className={className}>{formatCombo(combo)}</Kbd>;
}
