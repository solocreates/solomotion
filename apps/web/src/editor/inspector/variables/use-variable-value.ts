import type { Variable } from "@solomotion/core";
import { useDocStore } from "../../state/document-context";
import { useParkedPlayhead } from "../../state/session";
import { applyVariableValue, variableDisplayValue } from "./variable-editing";

/**
 * The ONE read/write hook for a variable's value — shared by the Variables
 * window and the Variables node so both edit through the identical keyframe-aware
 * policy (a key at the playhead when animated, else the static literal). Returns
 * the effective value at the playhead and a committing setter.
 */
export function useVariableValue(variable: Variable): {
  value: Variable["value"];
  setValue: (value: Variable["value"]) => void;
} {
  const store = useDocStore();
  const playheadMs = useParkedPlayhead();
  const value = variableDisplayValue(variable, playheadMs);
  const setValue = (v: Variable["value"]) =>
    store.update(
      "Edit variable",
      (d) => {
        const vv = d.variables.find((x) => x.id === variable.id);
        if (vv) applyVariableValue(vv, v, playheadMs);
      },
      { mergeKey: `var-${variable.id}` },
    );
  return { value, setValue };
}
