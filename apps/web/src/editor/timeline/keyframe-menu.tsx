"use client";

import * as React from "react";
import { EASING_PRESET_LABELS, type DocumentStore, type EasingPresetName } from "@solomotion/core";
import { toast } from "@/lib/toast";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { EasingCurve } from "@/components/ui/easing-editor";
import { useSession } from "../state/session";
import { lastPointer } from "../ui/EasingShortcutOverlay";
import {
  applyEasingToSelectedKeyframes,
  copyKeyframes,
  cutKeyframes,
  deleteKeyframes,
  pasteKeyframes,
} from "../state/keyframe-actions";

/**
 * The ONE keyframe right-click vocabulary — curves panel and dope sheet share
 * it verbatim. It acts on session.selectedKeyframeIds (both surfaces select
 * the pressed key on right-click first), so right-clicking empty space with a
 * selection still works on that selection.
 */
export function KeyframeMenuItems({ store }: { store: DocumentStore }) {
  const count = useSession((s) => s.selectedKeyframeIds.length);

  /** The full easing editor at the cursor — DEFERRED a tick, so the menu's own
   *  closing click can't land "outside" the popover and instantly dismiss it. */
  const openEasingEditor = () => {
    const at = { x: lastPointer.x, y: lastPointer.y };
    window.setTimeout(() => useSession.getState().setEasingPopoverAt(at), 0);
  };

  return (
    <>
      {/* Live-preview easing tiles — same visual language as the easing panel. */}
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={count === 0}>Set easing</ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56 p-1.5">
          <div className="grid grid-cols-3 gap-1">
            {Object.entries(EASING_PRESET_LABELS).map(([name, label]) => (
              <button
                key={name}
                type="button"
                onClick={() => applyEasingToSelectedKeyframes(store, { kind: "preset", name: name as EasingPresetName })}
                className="flex flex-col items-center gap-0.5 rounded-md border p-1.5 text-[9px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <EasingCurve
                  easing={{ kind: "preset", name: name as EasingPresetName }}
                  className="size-7 text-foreground/70"
                />
                <span className="w-full truncate text-center">{label}</span>
              </button>
            ))}
          </div>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem disabled={count === 0} onClick={openEasingEditor}>
        Easing editor…
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">E</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={count === 0}
        onClick={() => {
          const n = copyKeyframes(store);
          if (n) toast(`Copied ${n} keyframe${n > 1 ? "s" : ""}`);
        }}
      >
        Copy
      </ContextMenuItem>
      <ContextMenuItem
        disabled={count === 0}
        onClick={() => {
          const n = cutKeyframes(store);
          if (n) toast(`Cut ${n} keyframe${n > 1 ? "s" : ""}`);
        }}
      >
        Cut
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          const n = pasteKeyframes(store);
          if (n) toast(`Pasted ${n} keyframe${n > 1 ? "s" : ""} at the playhead`);
        }}
      >
        Paste at playhead
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={count === 0}
        className="text-destructive focus:text-destructive"
        onClick={() => deleteKeyframes(store)}
      >
        Delete {count > 1 ? `${count} keyframes` : "keyframe"}
      </ContextMenuItem>
    </>
  );
}
