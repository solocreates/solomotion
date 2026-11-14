"use client";

import * as React from "react";
import {
  addColorVariable,
  applyColorEdit,
  colorVarToken,
  deleteColorVariable,
  linkColorSlot,
  parseColorVarToken,
  resolveColor,
  uniqueVariableName,
} from "@solomotion/core";
import type { ColorInputProps } from "@/components/ui/color-picker";
import { toast } from "@/lib/toast";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";

/**
 * THE colour-variable binding policy, in one place. Every colour slot in the
 * app (inspector rows, paint fills/strokes, gradient stops, pattern colours)
 * goes through this hook, so they cannot drift apart.
 *
 * THE RULE — editing the COLOUR of a bound slot detaches it (Figma). A variable
 * is a reference, and "change the colour of this one shape" must never silently
 * restyle every other layer that happens to share the reference. Retinting the
 * variable itself is an explicit act: do it in the Variables manager, where the
 * usage count tells you what you're about to change. This is the same rule
 * `BindableField` applies to numbers and typography — one model, every type.
 *
 * ALPHA IS THE EXCEPTION, and it is not a loophole — it is the rule applied
 * correctly. Opacity is not a property of the brand colour; it is how much of
 * it this slot lets through, which belongs with blend mode. Detaching on it
 * meant the ordinary act of fading a layer out silently broke its link to the
 * palette, with nothing on screen saying so. A bound slot carries its own alpha
 * (`var:<id>/<a>` — see the token grammar in core), so it stays linked.
 *
 * The test is simply WHAT MOVED: a value whose channels are unchanged and whose
 * alpha is not was an alpha edit, whatever control produced it. That is why no
 * colour control in the app needed a second callback for this — the row's alpha
 * field, the picker's alpha track and its A field all arrive here as an
 * ordinary colour and are all recognised.
 */
export function useColorVariableBinding(
  /** The slot's stored value: a literal colour, or a `var:<id>` token. */
  value: string | undefined,
  /** Writes the slot — a literal, or a token when the user links one. */
  onChange: (next: string) => void,
): {
  /** The literal colour to display (the variable's value while bound). */
  resolved: string | undefined;
  /** Everything `ColorInput` / `PickerPanel` need to render the variables UI. */
  props: Pick<ColorInputProps, "variables" | "linkedId" | "onChange" | "onLinkVariable">;
  /** Point this slot at a colour variable — the library's bind verb. */
  bindVariable: (id: string) => void;
  /** Save the slot's current colour as a new variable, and link to it. */
  saveVariable: (color: string) => void;
} {
  const doc = useDoc();
  const store = useDocStore();
  const openManager = useSession((s) => s.setVariablesOpen);

  const linkedId = value ? parseColorVarToken(value) : null;
  const resolved = value !== undefined ? resolveColor(doc, value) : undefined;
  const variables = React.useMemo(
    () => doc.variables.filter((v) => v.type === "color"),
    [doc.variables],
  );

  const linkedName = linkedId ? variables.find((v) => v.id === linkedId)?.name : undefined;

  /** Bind, keeping the slot's opacity. The row, the library and the picker all
   *  come through here, so they cannot disagree about what linking does. */
  const link = (id: string) => onChange(linkColorSlot(doc, value, id));

  return {
    resolved,
    props: {
      variables,
      linkedId,
      onChange: (c: string) => {
        // `applyColorEdit` is the rule; this is only the part of it that has a
        // face. A colour edit detaches (and says so once); an alpha edit comes
        // back as the same reference at a new opacity and says nothing,
        // because nothing was broken.
        const next = applyColorEdit(doc, value, c);
        if (linkedId && parseColorVarToken(next) === null) {
          toast(`Detached from “${linkedName ?? "variable"}”`);
        }
        onChange(next);
      },
      onLinkVariable: (id: string | null) => (id ? link(id) : onChange(resolved ?? "#ffffff")),
    },
    bindVariable: link,
    saveVariable: (c: string) => {
      let id: string | null = null;
      store.update("Create color variable", (d) => {
        id = addColorVariable(d, uniqueVariableName(d, "Color"), c).id;
      });
      if (id) onChange(colorVarToken(id));
    },
  };
}
