import * as React from "react";
import { varName } from "@solomotion/theme";

/**
 * A LABEL — the word that leads a row, a group or a bar. The theme decides how
 * labels are cased (CAPS, as written, lower, or `--var`), and that decision is
 * CSS keyed on the root (`data-labels`), so this renders the real words plus
 * their `--var` spelling and never asks which theme is on. The words stay the
 * accessible name in every style.
 */
export const PartLabel = React.forwardRef<
  HTMLSpanElement,
  {
    text: string;
    className?: string;
    /** `head` titles a section (display face, full size); the default leads a row. */
    level?: "head";
  } & Omit<React.HTMLAttributes<HTMLSpanElement>, "children">
>(function PartLabel({ text, className, level, ...rest }, ref) {
  return (
    <span ref={ref} data-part="label" data-level={level} data-var={varName(text)} className={className} {...rest}>
      {text}
    </span>
  );
});
