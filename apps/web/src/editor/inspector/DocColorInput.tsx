"use client";

import { ColorInput } from "@/components/ui/color-picker";
import { solidPaint } from "@solomotion/core";
import { PaintLibrary } from "../paint/PaintLibrary";

/** A bare colour slot holds a `var:` token, so only colour variables fit. */
const COLOR_STYLES = ["color"] as const;
import { useColorVariableBinding } from "./color-variable-binding";

/**
 * ColorInput bound to the document's color variables. Slots may hold a
 * `var:<id>` token; this resolves it for display and offers the variables list
 * in the picker. All of the binding policy lives in `useColorVariableBinding`,
 * so this row control and the inline paint picker behave identically.
 */
export function DocColorInput({
  value,
  onChange,
  mixed,
  className,
  variant,
}: {
  /** Literal color or `var:` token. */
  value: string | undefined;
  /** Receives a literal color, or a `var:` token when the user links one. */
  onChange: (color: string) => void;
  mixed?: boolean;
  className?: string;
  /** `"badge"` for a tool bar — the swatch alone. See `ColorInputProps`. */
  variant?: "field" | "badge";
}) {
  const binding = useColorVariableBinding(value, onChange);
  return (
    <ColorInput
      value={binding.resolved}
      mixed={mixed}
      className={className}
      variant={variant}
      {...binding.props}
      // The SAME browser the paint editor opens, filtered to colours. A colour
      // row used to get a private variables rail and the fill editor a separate
      // shelf, so "my styles" meant two different things depending on which
      // control you happened to click.
      library={
        <PaintLibrary
          kind="solid"
          styleTypes={COLOR_STYLES}
          current={solidPaint(binding.resolved ?? "#ffffff")}
          boundId={binding.props.linkedId ?? null}
          onBind={binding.bindVariable}
          onDetach={() => binding.props.onLinkVariable?.(null)}
          onApply={(paint) => paint.type === "solid" && onChange(paint.color)}
        />
      }
    />
  );
}
