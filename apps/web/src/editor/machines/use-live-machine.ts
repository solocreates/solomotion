"use client";

import * as React from "react";
import {
  clipLookup,
  instanceScope,
  machineAt,
  machineClockMs,
  machineScopeOf,
  readInput,
  scopeMachineInputs,
  type MotionDocument,
  type Clip,
  type ExprInstanceScope,
  type MachineReading,
  type NestedClip,
} from "@solomotion/core";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { activeCompId } from "../timeline/time-axes";

/**
 * WHERE A MACHINE IS NOW — for the board and the Character tab's Machine row.
 *
 * The playhead moves every frame; React must not. The hook folds on every
 * session tick (a lookup once the fold has passed that instant) but commits a
 * render only when what it shows changes: a layer's state, the transition
 * that took it there, the loop flag, an input's value. Scrubbing across a
 * hold costs no render at all.
 */

/** The instance a machine is read through: the selected instance of its comp, else none (the master at its defaults). */
export function machineInstance(doc: MotionDocument, frameId: string, selected: readonly string[]): NestedClip | null {
  const clipOf = clipLookup(doc);
  for (let i = selected.length - 1; i >= 0; i--) {
    const c: Clip | undefined = clipOf(selected[i]!);
    if (c?.kind === "nested" && c.sourceFrameId === frameId) return c;
  }
  return null;
}

/** The scope and comp time a machine of `frameId` is read at, given where the person is standing. */
export function machineReadPoint(doc: MotionDocument, frameId: string, instance: NestedClip | null): { scope: ExprInstanceScope | null; timeMs: number } {
  const s = useSession.getState();
  const here = activeCompId(doc, s.activeFrameId);
  if (instance && here === instance.frameId) {
    const local = s.playheadMs - instance.startMs;
    return { scope: instanceScope(doc, instance, local, null), timeMs: local };
  }
  if (here === frameId) return { scope: null, timeMs: s.playheadMs };
  return { scope: null, timeMs: doc.frames.find((f) => f.id === frameId)?.playheadMs ?? 0 };
}

export interface LiveMachine {
  reading: MachineReading;
  /** Input values at the read point, by input id. */
  values: Record<string, string | number | boolean>;
  instance: NestedClip | null;
  /** The machine clock at the read point (an instance's local time, else the comp's). */
  clockMs: number;
}

export function useLiveMachine(frameId: string, machineId: string): LiveMachine | null {
  const doc = useDoc();
  const selected = useSession((s) => s.selectedClipIds);
  const instance = React.useMemo(() => machineInstance(doc, frameId, selected), [doc, frameId, selected]);
  const compute = React.useCallback((): LiveMachine | null => {
    const frame = doc.frames.find((f) => f.id === frameId);
    const machine = frame?.machines?.find((m) => m.id === machineId);
    if (!frame || !machine) return null;
    const { scope, timeMs } = machineReadPoint(doc, frameId, instance);
    const reading = machineAt(machineScopeOf(doc, frameId, scope), machine, scopeMachineInputs(doc, scope, frameId), machineClockMs(scope, timeMs));
    const values: Record<string, string | number | boolean> = {};
    for (const def of frame.inputs ?? []) {
      const v = readInput(doc, scope, frameId, def.id);
      if (v !== undefined) values[def.id] = v;
    }
    return { reading, values, instance, clockMs: machineClockMs(scope, timeMs) };
  }, [doc, frameId, machineId, instance]);

  const signature = (l: LiveMachine | null) =>
    l
      ? `${l.reading.layers.map((x) => `${x.stateId}|${x.transition?.id ?? ""}|${x.enteredAtMs}|${x.cut ? 1 : 0}`).join(";")}#${JSON.stringify(l.values)}`
      : "";
  const [live, setLive] = React.useState(compute);
  const sig = React.useRef(signature(live));

  React.useEffect(() => {
    const tick = () => {
      const next = compute();
      const s = signature(next);
      if (s !== sig.current) {
        sig.current = s;
        setLive(next);
      }
    };
    // The document changed (or the instance did): recompute and always commit.
    const first = compute();
    sig.current = signature(first);
    setLive(first);
    return useSession.subscribe(tick);
  }, [compute]);

  return live;
}
