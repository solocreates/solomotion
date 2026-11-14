"use client";

import { falloff, type ElementMode, type Falloff, type ShadingMode } from "@solomotion/core";

/**
 * The 3D viewport's own glyphs — the few things lucide has no word for
 * (element modes, shading balls, pivots, falloff curves). Drawn on lucide's
 * grid (16 view units, currentColor, 1.25 stroke) so they sit in a bar beside
 * lucide icons without looking imported.
 */

type IconProps = { className?: string };
const svg = (className: string | undefined, children: React.ReactNode, fill = "none") => (
  <svg viewBox="0 0 16 16" className={className} fill={fill} stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

/** A cube with the element kind lit — vertex, edge or face select. */
export function ElementIcon({ mode, className }: IconProps & { mode: ElementMode }) {
  return svg(
    className,
    <>
      <path d="M3 5.5 8 3l5 2.5v5L8 13l-5-2.5z" opacity="0.55" />
      <path d="M3 5.5 8 8l5-2.5M8 8v5" opacity="0.55" />
      {mode === "vertex" && <circle cx="8" cy="8" r="1.9" fill="currentColor" stroke="none" />}
      {mode === "edge" && <path d="M8 8v5" strokeWidth="2.4" />}
      {mode === "face" && <path d="M3 5.5 8 8v5l-5-2.5z" fill="currentColor" opacity="0.9" stroke="none" />}
    </>,
  );
}
export const VertexIcon = (p: IconProps) => <ElementIcon mode="vertex" {...p} />;
export const EdgeIcon = (p: IconProps) => <ElementIcon mode="edge" {...p} />;
export const FaceIcon = (p: IconProps) => <ElementIcon mode="face" {...p} />;

/** The four shading balls: wire, solid, material preview, rendered. */
export function ShadingIcon({ mode, className }: IconProps & { mode: ShadingMode }) {
  if (mode === "wireframe")
    return svg(
      className,
      <>
        <circle cx="8" cy="8" r="5.5" />
        <ellipse cx="8" cy="8" rx="2.4" ry="5.5" />
        <path d="M2.5 8h11" />
      </>,
    );
  if (mode === "solid") return svg(className, <circle cx="8" cy="8" r="5.5" fill="currentColor" stroke="none" />);
  if (mode === "material")
    return svg(
      className,
      <>
        <circle cx="8" cy="8" r="5.5" fill="currentColor" stroke="none" opacity="0.35" />
        <circle cx="6.2" cy="6.2" r="2" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="5.5" />
      </>,
    );
  return svg(
    className,
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
      <circle cx="5.6" cy="5.8" r="1.1" fill="currentColor" stroke="none" />
    </>,
  );
}
export const WireIcon = (p: IconProps) => <ShadingIcon mode="wireframe" {...p} />;
export const SolidIcon = (p: IconProps) => <ShadingIcon mode="solid" {...p} />;
export const MaterialPreviewIcon = (p: IconProps) => <ShadingIcon mode="material" {...p} />;
export const RenderedIcon = (p: IconProps) => <ShadingIcon mode="rendered" {...p} />;

/** Pivot: the median of the selection — three points and the centre between them. */
export function MedianPivotIcon({ className }: IconProps) {
  return svg(
    className,
    <>
      <circle cx="3.5" cy="4" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="6" cy="12.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="7.4" cy="7.2" r="2" />
    </>,
  );
}

/** Pivot: the 3D cursor — Blender's striped ring and cross. */
export function CursorPivotIcon({ className }: IconProps) {
  return svg(
    className,
    <>
      <circle cx="8" cy="8" r="4" strokeDasharray="2.1 2.1" />
      <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
    </>,
  );
}

/** Pivot: the active object — a filled point inside its own ring, beside a hollow one. */
export function ActivePivotIcon({ className }: IconProps) {
  return svg(
    className,
    <>
      <circle cx="6.5" cy="9.5" r="3.5" />
      <circle cx="6.5" cy="9.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="3.8" r="1.4" />
    </>,
  );
}

/** A falloff, drawn from core's own curve — so the icon cannot disagree with the edit. */
export function FalloffIcon({ kind, className }: IconProps & { kind: Falloff }) {
  const pts: string[] = [];
  for (let i = 0; i <= 16; i++) {
    const x = i / 16;
    // Symmetric bump: weight 1 at the centre, 0 at both edges.
    const t = 1 - Math.abs(x * 2 - 1);
    pts.push(`${(1.5 + x * 13).toFixed(2)},${(13.5 - falloff(kind, t) * 10).toFixed(2)}`);
  }
  return svg(
    className,
    <>
      <path d="M1.5 13.5h13" opacity="0.4" />
      <polyline points={pts.join(" ")} />
    </>,
  );
}

/** Looking through the live camera, framed. */
export function LockViewIcon({ className }: IconProps) {
  return svg(
    className,
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>,
  );
}
