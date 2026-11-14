"use client";

import * as React from "react";
import { Group as GroupIcon } from "lucide-react";
import type { GroupMode } from "@solomotion/core";

/**
 * Figma-style boolean/mask glyphs (two overlapping squares; the filled region
 * is the result). lucide 0.469 predates its boolean set, so these are local —
 * same 16-grid, currentColor, stroke metrics tuned to read at 12–14px. One
 * `COMPOSITE_ICONS` map keyed by group mode, shared by the inspector's Combine
 * row, the right-click menu and the layers panel.
 */

type IconProps = React.SVGProps<SVGSVGElement>;

function Svg(props: IconProps & { children: React.ReactNode }) {
  const { children, ...rest } = props;
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Both squares as one solid silhouette. */
export function UnionIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 2h8.5v3.5H14V14H5.5v-3.5H2Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** The bottom square minus the one above it. */
export function SubtractIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 2h8.5v3.5H5.5v5H2Z" fill="currentColor" stroke="none" />
      <rect x="5.5" y="5.5" width="8.5" height="8.5" />
    </Svg>
  );
}

/** Only where the squares overlap. */
export function IntersectIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 2h8.5v8.5H2Z" opacity="0.45" />
      <path d="M5.5 5.5H14V14H5.5Z" opacity="0.45" />
      <path d="M5.5 5.5h5v5h-5Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Both squares with the overlap knocked out. */
export function ExcludeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M2 2h8.5v3.5H14V14H5.5v-3.5H2Z M5.5 5.5v5h5v-5Z"
        fill="currentColor"
        fillRule="evenodd"
        stroke="none"
      />
    </Svg>
  );
}

/** A stencil over content: circle clipped to the square. */
export function MaskIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M8 2a6 6 0 0 1 0 12 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

function PassIcon(props: IconProps) {
  const { className } = props;
  return <GroupIcon className={className} aria-hidden />;
}

/** Mode → glyph. `pass` renders the plain group icon. */
export const COMPOSITE_ICONS: Record<GroupMode, React.ComponentType<IconProps>> = {
  pass: PassIcon,
  union: UnionIcon,
  subtract: SubtractIcon,
  intersect: IntersectIcon,
  exclude: ExcludeIcon,
  mask: MaskIcon,
};
