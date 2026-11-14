"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { Button as BrandButton, buttonFrame, type ButtonProps } from "@solomotion/ui";
import { cn } from "@/lib/utils";

/**
 * The editor's button: the shared FRAME (sizes, press, focus — one table with
 * the marketing site) painted by the theme. `variant` says what the button is
 * FOR; the theme's button dialect (`data-button` on the root, `parts.css`)
 * says how that is drawn — a pane of accent glass, a solid fill, a frame, a
 * keycap, an offset print. The component never learns which.
 *
 * `brand` is the product's identity gradient (the upgrade CTA) and is not a
 * theme decision, so it stays the shared Button's own.
 */
const INTENT = {
  primary: "primary",
  default: "primary",
  accent: "accent",
  secondary: "secondary",
  outline: "outline",
  ghost: "ghost",
  link: "link",
  destructive: "danger",
  danger: "danger",
} as const;

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  if (variant === "brand") return <BrandButton className={className} variant="brand" size={size} asChild={asChild} {...props} />;
  const intent = INTENT[(variant ?? "primary") as keyof typeof INTENT] ?? "primary";
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-part="button"
      data-variant={intent}
      className={cn(buttonFrame({ size }), size === "xs" && intent === "primary" && "[&_svg]:size-3.5", className)}
      {...props}
    />
  );
}

export { Button, type ButtonProps };
export { buttonVariants } from "@solomotion/ui";
