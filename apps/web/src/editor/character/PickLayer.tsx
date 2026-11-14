"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { CHROME_CAPSULE } from "../stage/StageChrome";
import { clipSpace } from "../stage/edit-space";
import { useDocStore } from "../state/document-context";
import { useCharacterPick, type CharacterPick } from "./pick-state";

/**
 * The stage while a flat picture is being made a character: a crosshair
 * surface over the canvas and one chip saying the step. Each click lands in
 * the picture's comp space; a lid takes its colour from the art just above
 * the eye, read off the stage canvas (skin, not iris).
 */
export function PickLayer() {
  const pick = useCharacterPick((s) => s.pick);
  const store = useDocStore();
  const ref = React.useRef<HTMLDivElement>(null);

  const finish = React.useCallback(
    (p: CharacterPick) => {
      useCharacterPick.getState().cancel();
      if (!p.mouth) return;
      const mouth = p.mouth;
      void import("./make-character").then((m) => (p.mode === "mouth" ? m.addMouth(store, p.pictureId, mouth) : m.makeFlatCharacter(store, p.pictureId, { mouth, eyes: p.eyes })));
    },
    [store],
  );

  React.useEffect(() => {
    if (!pick) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        useCharacterPick.getState().cancel();
      } else if (e.key === "Enter" && pick.step === "eyes") {
        e.preventDefault();
        finish(pick);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [pick, finish]);

  if (!pick) return null;

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = ref.current!.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const space = clipSpace(pick.pictureId);
    if (!space) return;
    const at = space.fromScreen(screen);
    if (pick.step === "mouth" && pick.mode === "mouth") return finish({ ...pick, mouth: at });
    if (pick.step === "mouth") return useCharacterPick.getState().set({ ...pick, step: "eyes", mouth: at });
    const next = { ...pick, eyes: [...pick.eyes, { ...at, colour: sampleAbove(ref.current!, screen) }] };
    if (next.eyes.length >= 2) finish(next);
    else useCharacterPick.getState().set(next);
  };

  return (
    <>
      <div ref={ref} data-character-pick className="absolute inset-0 z-20 cursor-crosshair touch-none" onPointerDown={onDown} />
      <div data-stage-chrome className={cn(CHROME_CAPSULE, "pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 px-2 py-1 text-xs")}>
        {pick.step === "mouth" ? (
          <span className="font-medium">{pick.mode === "mouth" ? "Click where the mouth goes" : "Click the mouth"}</span>
        ) : (
          <span>
            <span className="font-medium">Click each eye</span> · <span className="text-muted-foreground">Enter to skip</span>
          </span>
        )}
      </div>
    </>
  );
}

/** The art's colour a little above a stage point — the lid's skin. Null when the canvas cannot be read. */
function sampleAbove(surface: HTMLElement, p: { x: number; y: number }): string | undefined {
  const canvas = surface.parentElement?.querySelector("canvas");
  if (!canvas) return undefined;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) return undefined;
    const sx = canvas.width / canvas.clientWidth, sy = canvas.height / canvas.clientHeight;
    const d = ctx.getImageData(Math.round(p.x * sx), Math.round((p.y - 18) * sy), 1, 1).data;
    if (d[3]! < 128) return undefined;
    return `#${[d[0], d[1], d[2]].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return undefined;
  }
}
