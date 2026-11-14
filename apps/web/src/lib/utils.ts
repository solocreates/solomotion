/**
 * The app's class merger IS the shared one: it carries the tailwind-merge
 * config that knows the design system's own utilities (the v5 redesign type
 * scale, `h-(--var)` heights). A second plain `twMerge` here dropped
 * `text-body` whenever a text colour followed it.
 */
export { cn } from "@solomotion/ui";
