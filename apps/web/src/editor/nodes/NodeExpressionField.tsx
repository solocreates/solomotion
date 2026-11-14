"use client";

import * as React from "react";
import { EXPRESSION_PARAM_KEY } from "@solomotion/core";
import { ExpressionEditor, useExpressionAnalysis } from "../expressions/ExpressionEditor";
import { useExprContext } from "../expressions/expression-context";

/**
 * The Expression node's body — the SAME editor the field panel uses, on a card.
 *
 * Not a lookalike: the identical component, fed the identical analysis hook, so
 * the highlighting, the autocomplete, the diagnostics and the live value are one
 * implementation appearing in two places. A node that had its own little text
 * box would drift from the panel within a release, and the promise that a
 * sentence means the same thing wherever you write it would quietly stop being
 * true.
 *
 * `expect` is null because the node's output socket is `any` — nothing
 * constrains the result until a wire carries it somewhere, and the socket rules
 * coerce at that point exactly as they do for every other wildcard output.
 */
export function NodeExpressionField({
  nodeId,
  source,
  onChange,
}: {
  nodeId: string;
  source: string;
  onChange: (next: string) => void;
}) {
  const ctx = useExprContext();
  // Seeded by the NODE's id, matching how a field-bound expression seeds from
  // the expression's id: two copies of this node wobble independently, and each
  // is identical on every replay.
  const analysis = useExpressionAnalysis(source, { expect: null, ctx, seedKey: nodeId });

  return (
    <div className="px-2.5 pb-2 pt-1" onPointerDown={(e) => e.stopPropagation()}>
      <ExpressionEditor source={source} onChange={onChange} analysis={analysis} rows={2} />
    </div>
  );
}

export { EXPRESSION_PARAM_KEY };
