import type { MotionDocument } from "../schema/document";
import type { GroupMode } from "../schema/clips";
import { groupRoles, modeUsesStencil } from "./group-composite";
import { clipAncestorGroups } from "./groups";

/**
 * IS A LAYER SHOWING HERE? — the composite tree's answer, headless.
 *
 * A layer inside a mask group paints only where its stencil is; inside a
 * subtract group, only where the stencil is NOT; and a stencil paints nothing
 * of its own at all — it is a matte. So the pixels a layer HAS under a point
 * are not its box: they are its box, clipped by every masking ancestor on the
 * way up. A click on the part a mask cut away lands on nothing of that layer
 * — the layer beneath is what you see, and what you should get.
 *
 * The policy lives here so every surface that asks "what is under this
 * point?" gets one answer; the GEOMETRY (is this point inside that stencil's
 * silhouette?) is the caller's, because only the renderer knows where the
 * stencil's pixels are. Two probes cover it: `painted` — the renderer drew
 * this layer this frame (a stencil outside its time window cuts nothing, and
 * the renderer then shows the content plain) — and `inside`.
 */
export interface ShowsAtProbe {
  /** Did the renderer paint this layer this frame? */
  painted(clipId: string): boolean;
  /** Is the point inside this layer's silhouette (a group's: any descendant's)? */
  inside(clipId: string): boolean;
}

export interface ShowsAt {
  /** The layer has pixels of its own under the point. */
  visible: boolean;
  /**
   * The layer is a stencil somewhere up its chain: it paints nothing directly,
   * you only see what it lets through. Reachable, but never over a layer that
   * genuinely shows here — a pick falls to it only when nothing else is there.
   */
  matte: boolean;
}

/** Which side of the stencil a mode keeps its content on. */
function keepsContent(mode: GroupMode): "inside" | "outside" {
  return mode === "mask" || mode === "intersect" ? "inside" : "outside";
}

export function layerShowsAt(doc: MotionDocument, clipId: string, probe: ShowsAtProbe): ShowsAt {
  let matte = false;
  let child = clipId;
  // Innermost → outermost, carrying the child-on-path so the role at each
  // level is the DIRECT member's — a nested group can be the stencil, and then
  // everything inside it is matte.
  for (const group of clipAncestorGroups(doc, clipId)) {
    if (modeUsesStencil(group.mode)) {
      const roles = groupRoles(doc, group.id);
      const stencils = roles.stencils.filter((c) => probe.painted(c.id));
      const contents = roles.contents.filter((c) => probe.painted(c.id));
      // The renderer's own degenerate rule: a side missing → everything paints plain.
      if (stencils.length > 0 && contents.length > 0) {
        if (stencils.some((c) => c.id === child)) matte = true;
        else {
          const inStencil = stencils.some((c) => probe.inside(c.id));
          if (inStencil !== (keepsContent(group.mode) === "inside")) return { visible: false, matte };
        }
      }
    }
    child = group.id;
  }
  return { visible: !matte, matte };
}
