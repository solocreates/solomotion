"use client";

import {
  cssColorToHex,
  iconSvg,
  parseVarToken,
  resolveColor,
  type MotionDocument,
  type Clip,
  type IconData,
  type IconRef,
  type IconSet,
  iconId,
  type LayerAnimationSpec,
  type LibrarySnapshot,
  type Paint,
} from "@solomotion/core";
import { svgToClips } from "../../assets/svg-import";
import { settleSvg } from "./settle-svg";
import type { DragPreview } from "../../state/session";

/**
 * An icon → the layers it becomes.
 *
 * There is no icon layer kind and there must not be one: an icon is vector
 * artwork, and the app already has the whole machinery for vector artwork —
 * the SVG importer (`svgToClips`), which splits every disjoint piece into its
 * own path clip and groups them. So an icon lands as exactly what a dropped
 * .svg lands as, with every capability a path has (nodes, strokes, trim,
 * morph, effects, keyframes, the draw-on) on day one and for free.
 *
 * This file only decides what the SVG SAYS before it goes in: the ink, the
 * size, the pen, and the default animation the group wears — and it stamps
 * each path with where it came from (`origin`), because once the icon is
 * paths nothing else in the document remembers the set, the id or the licence.
 */

export interface IconDropOptions {
  /** A literal colour or a `var:` token — the token is kept on every paint. */
  color: string;
  /** Landing size in frame px (the icon's longer side). */
  size: number;
  /** Line width in the icon's own units; null = as drawn. */
  strokeWidth: number | null;
  animIn: LayerAnimationSpec | null;
  animOut: LayerAnimationSpec | null;
  /** Span of the placed layers. */
  durationMs?: number;
}

export interface IconClips {
  snapshot: LibrarySnapshot;
  /** The exact markup the layers were built from — the drag ghost's picture. */
  preview: DragPreview;
  name: string;
}

/** `arrow-up-right` → `Arrow up right`. */
export function iconDisplayName(ref: IconRef): string {
  const words = ref.name.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : ref.name;
}

/** Build the snapshot an icon drops as, or null when its body holds nothing drawable. */
export function iconClips(doc: MotionDocument, ref: IconRef, set: IconSet, icon: IconData, opts: IconDropOptions): IconClips | null {
  const token = parseVarToken(opts.color) ? opts.color : null;
  const literal = token ? resolveColor(doc, opts.color) : opts.color;
  // Settled: a set's own SMIL animation is not the layer's animation.
  const markup = settleSvg(iconSvg(icon, { size: opts.size, color: literal, strokeWidth: opts.strokeWidth ?? undefined }));
  const name = iconDisplayName(ref);
  const built = svgToClips(markup, name, { frameId: "", startMs: 0, durationMs: opts.durationMs ?? 5000, x: 0, y: 0 });
  if (!built) return null;

  const members = built.clips.filter((c) => c.id !== built.group?.id);
  // Provenance rides the LEAVES: the paths are what came from the icon, the
  // group is the app's container and derives its answer from them.
  for (const clip of members) clip.origin = { kind: "icon", id: iconId(ref), license: set.license.spdx, author: set.author.name };
  if (token) {
    // The importer resolved `currentColor` to the literal; put the variable
    // back where that literal landed, so the icon follows the swatch.
    const want = cssColorToHex(literal)?.slice(0, 7).toLowerCase();
    for (const clip of members) relink(clip, want, token);
  }

  // The default animation rides on the thing that will be selected: the
  // group when there is one (a draw-on then reads through to every strand),
  // the lone path otherwise.
  const carrier: Clip | null = built.group ?? members[0] ?? null;
  if (carrier && carrier.kind !== "audio") {
    carrier.animIn = opts.animIn ? structuredClone(opts.animIn) : null;
    carrier.animOut = opts.animOut ? structuredClone(opts.animOut) : null;
  }

  return {
    name,
    snapshot: { v: 2, clips: members, group: built.group },
    preview: { kind: "svg", markup, width: opts.size, height: opts.size },
  };
}

function relink(clip: Clip, literal6: string | undefined, token: string): void {
  if (clip.kind === "audio" || !literal6) return;
  const swap = (p: Paint) => {
    if (p.type === "solid" && p.color.slice(0, 7).toLowerCase() === literal6) p.color = token;
  };
  clip.fills.forEach(swap);
  for (const s of clip.strokes) swap(s.paint);
}
