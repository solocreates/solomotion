import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

/**
 * The ONE Button for the whole product — the marketing site AND the editor app
 * both consume this exact component (the editor re-exports it), so there is a
 * single source of truth for how a button looks, presses and focuses.
 *
 * Design notes:
 *  • `primary` (alias `default`) wears the app's MATERIAL: a pane of accent-tinted
 *    glass with the accent carried by the label. This is the same object as an
 *    armed tool, a selected tab and an open panel, so "the thing you press" and
 *    "the thing that is active" finally look related instead of being a gradient
 *    sticker next to a design system.
 *  • `brand` is the old gradient, kept for the two places identity outranks
 *    consistency: the marketing site's hero and the upgrade CTA. It is opt-in
 *    now — it used to be the default, which is how a marketing treatment ended
 *    up on every button in a 44px editor toolbar.
 *  • Every variant has a *tactile* press: it physically sinks 1px and its shadow
 *    collapses on `:active` (the Cloudflare "buttony" feel), and a crisp focus ring.
 *  • The variant vocabulary is the SUPERSET of both apps: `default`≡`primary`,
 *    plus outline/secondary/ghost/link/destructive; sizes cover sm→lg, default,
 *    icon and icon-sm. No call site in either app has to change.
 */
// The brand button: gradient + a blurred gradient halo (::before) + a collapsing
// "ledge" shadow so the press reads as a real physical push. Shared by both the
// `primary` and `default` variant names (the two apps use different words for it).
// The halo is a REST-STATE WHISPER that blooms on hover. It used to sit at 45%
// opacity / blur-md all the time, which reads as a marketing hero on a landing
// page and as a smudge on a 44px editor toolbar — the button appeared to bleed
// into the chrome below it. Rest is now barely there; hover is where it glows.
const BRAND = [
  "text-white [background-image:var(--gradient-brand)] bg-[length:200%_100%] bg-[position:0%_0%]",
  "shadow-[0_1px_6px_-3px_var(--brand-glow),0_2px_0_-1px_var(--brand-shadow)]",
  "hover:bg-[position:100%_0%] hover:brightness-[1.06]",
  "hover:shadow-[0_2px_10px_-3px_var(--brand-glow),0_2px_0_-1px_var(--brand-shadow)]",
  "active:shadow-[0_1px_4px_-3px_var(--brand-glow),0_1px_0_-1px_var(--brand-shadow)]",
  "before:absolute before:inset-x-1 before:inset-y-0 before:-z-10 before:rounded-[inherit] before:[background-image:var(--gradient-brand)]",
  "before:opacity-0 before:blur-[6px] before:transition-opacity before:duration-300 before:content-['']",
  "hover:before:opacity-55 active:before:opacity-30",
].join(" ");

const ACTION = [
  "text-primary",
  "bg-[color-mix(in_srgb,var(--primary)_28%,transparent)]",
  "shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.14),inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_40%,transparent),0_1px_2px_rgb(0_0_0_/_0.3)]",
  "hover:bg-[color-mix(in_srgb,var(--primary)_38%,transparent)]",
  "active:bg-[color-mix(in_srgb,var(--primary)_44%,transparent)]",
].join(" ");

/**
 * The button's FRAME — shape-free metrics, press and focus, and the sizes —
 * shared by this Button and by any host that paints buttons another way (the
 * editor's themed button draws its variants from the theme's dialect). One
 * size table, so a `size="sm"` is the same box everywhere.
 */
const FRAME_BASE = [
  "relative isolate inline-flex select-none items-center justify-center gap-2 whitespace-nowrap text-sm font-medium",
  "outline-none transition-[transform,background,color,box-shadow,filter,opacity] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  "disabled:pointer-events-none disabled:opacity-50",
  "active:translate-y-px active:duration-75",
  "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
].join(" ");

const BUTTON_SIZES = {
  // `xs` is the toolbar size — it clears the chrome around it.
  xs: "h-(--button-h-xs,1.75rem) gap-1.5 px-2.5 text-xs",
  sm: "h-(--button-h-sm,2rem) px-(--button-px,0.75rem) text-(length:--button-text,0.8125rem)",
  default: "h-(--button-h,2.25rem) px-(--button-px,1rem) text-(length:--button-text,0.875rem)",
  md: "h-(--button-h-md,2.5rem) px-(--button-px,1rem) text-(length:--button-text,0.875rem)",
  lg: "h-(--button-h-lg,2.75rem) px-(--button-px-lg,1.5rem) text-(length:--button-text-lg,0.9375rem)",
  icon: "size-(--button-h,2.25rem)",
  "icon-sm": "size-(--button-h-xs,1.75rem)",
} as const;

/** The frame alone: no radius, no paint. */
const buttonFrame = cva(FRAME_BASE, { variants: { size: BUTTON_SIZES }, defaultVariants: { size: "default" } });

const buttonVariants = cva(
  `${FRAME_BASE} rounded-md`,
  {
    variants: {
      variant: {
        // The material, expressed without depending on an app-level utility so
        // the shared package stays self-contained (the marketing site does not
        // load the editor's stylesheet). Same recipe as `material-action`.
        primary: ACTION,
        default: ACTION,
        brand: BRAND,
        // SOLID ACCENT — the workhorse "this is the action" button, Figma's
        // Share. The system had only the gradient (identity, and far too loud
        // for a permanent toolbar) and ghost (no presence at all), so every
        // real action had to pick between shouting and disappearing.
        accent:
          "bg-primary text-primary-foreground shadow-[0_1px_2px_rgb(0_0_0/0.3),0_2px_0_-1px_color-mix(in_srgb,var(--primary)_60%,black)] hover:brightness-110 active:shadow-none",
        secondary:
          "bg-secondary text-secondary-foreground border border-border shadow-[0_2px_0_-1px_rgba(0,0,0,0.35)] hover:bg-accent hover:text-accent-foreground active:shadow-none",
        outline:
          "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
        ghost:
          "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline active:translate-y-0",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[0_2px_0_-1px_rgba(0,0,0,0.4)] hover:brightness-110 active:shadow-none",
        // The the app 5 name for the same thing (D-briefs say primary ·
        // secondary · ghost · danger); `destructive` stays for existing callers.
        danger:
          "bg-destructive text-destructive-foreground shadow-[0_2px_0_-1px_rgba(0,0,0,0.4)] hover:brightness-110 active:shadow-none",
      },
      // SIZES READ THE HOST'S METRICS. The site and the editor share this one
      // button but not one density: a marketing hero wants 44px, a panel
      // wants nothing taller than 32 (v5 redesign, D7). Each size is a CSS
      // variable with the site's value as its fallback, and the editor's
      // globals.css points them at `--control-h-*` — so `size="lg"` in a
      // dialog is 32 in the app and 44 on the site, and neither app has to
      // know the other exists. A host that sets nothing gets the old sizes.
      size: BUTTON_SIZES,
    },
    compoundVariants: [
      // Icon-only buttons get no gradient halo — it would bloom past the square.
      { variant: "brand", size: "icon", class: "before:hidden" },
      { variant: "brand", size: "icon-sm", class: "before:hidden" },
      { variant: "brand", size: "xs", class: "[&_svg]:size-3.5" },
      { variant: "primary", size: "xs", class: "[&_svg]:size-3.5" },
      { variant: "default", size: "xs", class: "[&_svg]:size-3.5" },
    ],
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />
  );
}

export { Button, buttonVariants, buttonFrame, BUTTON_SIZES };
