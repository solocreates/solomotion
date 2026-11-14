"use client";

import * as React from "react";
import {
  compileExpression,
  evaluateProgram,
  exprLayerFor,
  exprTypeForVariable,
  makeExprContext,
  seedFor,
  variablesByName,
  variableValueNow,
  type EvalScope,
  type ExprContext,
  type ExprLayer,
  type ExprType,
  type ExprValue,
  type Variable,
} from "@solomotion/core";
import { useDoc } from "../state/document-context";
import { activeCompId } from "../timeline/timeline-utils";
import { useSession, useParkedPlayhead } from "../state/session";

/**
 * The editor's hooks over the ONE evaluation contract — `makeExprContext` and
 * `exprLayerFor` live in core (`evaluate/expr-context.ts`), so a preview, the
 * canvas and a headless test build the same context.
 */

/**
 * The layer an inspector field belongs to: the one selected clip, or null when
 * the selection is empty or multiple.
 *
 * Without this the editor's preview and the canvas answer `#layer.time`
 * differently — the renderer scopes it per clip, and a panel that guessed `null`
 * would confidently show 100 while the frame drew 678. A preview that disagrees
 * with the render is worse than no preview.
 */
export function useSelectedExprLayer(): ExprLayer | null {
  const doc = useDoc();
  const selectedIds = useSession((s) => s.selectedClipIds);
  return React.useMemo(() => {
    if (selectedIds.length !== 1) return null;
    const id = selectedIds[0];
    for (const [trackIndex, track] of doc.tracks.entries()) {
      const clip = track.clips.find((c) => c.id === id);
      if (clip) return exprLayerFor(doc, clip, trackIndex);
    }
    return null;
  }, [doc, selectedIds]);
}

/**
 * The editor's live context: the playhead, the comp on screen, the transport,
 * and — unless the caller names one — the selected layer.
 */
export function useExprContext(layer?: ExprLayer | null): ExprContext {
  const doc = useDoc();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const playheadMs = useParkedPlayhead();
  const playing = useSession((s) => s.playing);
  const selected = useSelectedExprLayer();
  const compId = activeCompId(doc, activeFrameId);
  const effective = layer === undefined ? selected : layer;
  return React.useMemo(
    () => makeExprContext(doc, playheadMs, compId, playing, effective),
    [doc, playheadMs, compId, playing, effective],
  );
}

/**
 * The evaluation scope the EDITOR uses — the same shape `makeExprScope` builds
 * for the renderer, but against an explicit context instead of the ambient one,
 * because a preview has to answer for the playhead the user is looking at while
 * the renderer may be mid-draw somewhere else.
 */
export function makeEditorScope(variables: Variable[], ctx: ExprContext, seedKey: string): EvalScope {
  const byName = variablesByName(variables);
  return {
    ctx: { ...ctx, seed: seedFor(seedKey) },
    readVariable: (name) => {
      const v = byName.get(name.trim().toLowerCase());
      if (!v) return undefined;
      const type = exprTypeForVariable(v.type);
      return type ? { id: v.id, value: variableValueNow(v) as ExprValue, type } : undefined;
    },
  };
}

/** One expression's value at the playhead — what a bound field's chip shows. */
export function evaluateAt(
  source: string,
  variables: Variable[],
  ctx: ExprContext,
  seedKey: string,
): { value: ExprValue; type: ExprType } | null {
  return evaluateProgram(compileExpression(source), makeEditorScope(variables, ctx, seedKey)) ?? null;
}
