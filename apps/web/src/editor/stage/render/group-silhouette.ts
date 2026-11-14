import {
  clipBox,
  clipRenderLocalTime,
  cropWindow,
  clipsUnderGroup,
  flattenClipsToPath,
  isIdentityPose,
  layerPoseAt,
  locateClip,
  trackLocalTime,
  type MotionDocument,
  type Contour,
  type GroupClip,
  type PathPoint,
  type Vec2,
  type VisualClip,
} from "@solomotion/core";

/**
 * A GROUP'S COMBINED SILHOUETTE — the outline you get by treating everything
 * inside it as one shape.
 *
 * This is what a stroke on a group runs along, and it is the difference between
 * a group that looks designed and one that looks outlined-in-parts. Stroking
 * each member separately draws the seams between them; stroking the union draws
 * the edge of the thing.
 *
 * It is `flattenClipsToPath` — the same reducer behind ⌘E — pointed at the
 * group, so the outline honours the group's composite mode at every depth: the
 * stroke around a subtract group follows what the subtract actually leaves.
 * There is no second silhouette engine, and there cannot be one that disagrees.
 *
 * NOT baked, and not static either: it is the outline of what the group looks
 * like AT THIS MOMENT. A member that is moving, scaling, morphing or simply not
 * on screen yet changes the shape of the thing, so the silhouette is sampled at
 * the playhead (`atMs`) — otherwise the stroke sits where the art used to be,
 * which is precisely what "the outline drifts off my animation" is.
 *
 * ## The cache
 *
 * Keyed on the DOCUMENT OBJECT, which the store replaces on every edit, so an
 * edit invalidates it by construction and there is no signature to keep in sync.
 * Within one document it holds ONE entry per group — the time last asked for —
 * rather than a growing map per frame: playback moves forward, and the several
 * passes that ask within a single frame (paint, export, hit-test) all ask for
 * the same moment. A group whose subtree holds no animation is keyed by which
 * members are showing (`groupShowingKey`), so the common case computes once per
 * edit of that set rather than once per frame.
 */
interface CacheEntry {
  key: string;
  contours: Contour[] | null;
}
const cache = new WeakMap<MotionDocument, Map<string, CacheEntry>>();

/**
 * The outline for every layer core cannot turn into curves — media, rasters,
 * nested comps, and text whose glyphs would need an async font load the
 * renderer has no way to wait for.
 *
 * It is the layer's VISIBLE box: the crop window, with its corner radii, which
 * is exactly the rectangle `withBoxClip` paints into. Not the raw box, and not
 * the media's natural size — the silhouette has to be the edge of what is on
 * screen or the stroke describes a shape nobody can see.
 *
 * An approximation, honestly: a PNG's alpha holes are not in here. It is an
 * unacceptable approximation in ⌘E — flatten REPLACES your artwork, so a wrong
 * outline is destructive, which is why core only ever consults `outlineOf`
 * (and ⌘E supplies it for text alone). A stroke draws BESIDE the artwork, so
 * the failure mode is a rectangle where you wanted letterforms: visible,
 * harmless, and far better than a group that silently refuses to take a stroke
 * because it contains a photo.
 */
function boxOutline(doc: MotionDocument, clip: VisualClip): Contour[] | null {
  // A processor has no silhouette. Its "box" is the whole comp, and a group
  // that stroked around that would draw a frame-sized rectangle for a layer
  // that paints nothing of its own.
  if (clip.kind === "adjustment") return null;
  // The CROP WINDOW, not the whole box — a cropped photo's silhouette is the
  // rectangle you can see, which is the same rectangle `withBoxClip` paints
  // into. Reading the raw box instead drew the stroke around footage that had
  // been cropped away.
  const box = cropWindow(clip.crop, clipBox(doc, clip));
  if (!(box.width > 0) || !(box.height > 0)) return null;
  const x0 = box.cx - box.width / 2;
  const y0 = box.cy - box.height / 2;
  const x1 = box.cx + box.width / 2;
  const y1 = box.cy + box.height / 2;
  // Rounded corners are part of that silhouette too, and they are a real
  // quarter-circle rather than a corner the stroke cuts across. `K` is the
  // usual circle-from-cubics constant; the radii clamp the same way the box
  // clip clamps them, so outline and pixels round identically.
  const r = clip.borderRadius;
  const lim = Math.min(box.width, box.height) / 2;
  const c = (v: number) => Math.max(0, Math.min(v, lim));
  const [tl, tr, br, bl] = [c(r.tl), c(r.tr), c(r.br), c(r.bl)];
  if (tl + tr + br + bl < 0.01) {
    return [
      {
        closed: true,
        points: [
          { x: x0, y: y0, hIn: null, hOut: null },
          { x: x1, y: y0, hIn: null, hOut: null },
          { x: x1, y: y1, hIn: null, hOut: null },
          { x: x0, y: y1, hIn: null, hOut: null },
        ],
      },
    ];
  }
  const K = 0.5522847498;
  const pt = (x: number, y: number, hIn: Vec2 | null, hOut: Vec2 | null): PathPoint => ({ x, y, hIn, hOut });
  const points: PathPoint[] = [
    // top-left corner: arc from the left edge round to the top edge
    pt(x0, y0 + tl, null, tl ? { x: x0, y: y0 + tl - tl * K } : null),
    pt(x0 + tl, y0, tl ? { x: x0 + tl - tl * K, y: y0 } : null, null),
    pt(x1 - tr, y0, null, tr ? { x: x1 - tr + tr * K, y: y0 } : null),
    pt(x1, y0 + tr, tr ? { x: x1, y: y0 + tr - tr * K } : null, null),
    pt(x1, y1 - br, null, br ? { x: x1, y: y1 - br + br * K } : null),
    pt(x1 - br, y1, br ? { x: x1 - br + br * K, y: y1 } : null, null),
    pt(x0 + bl, y1, null, bl ? { x: x0 + bl - bl * K, y: y1 } : null),
    pt(x0, y1 - bl, bl ? { x: x0, y: y1 - bl + bl * K } : null, null),
  ];
  return [{ closed: true, points }];
}

/**
 * The cache key for a group's silhouette at one moment.
 *
 * A silhouette changes for two reasons and only two: something inside is
 * ANIMATING (a keyframe, a driver, a modulator, a tracker — the geometry moves
 * every frame), or the set of members that are ON SCREEN changed (one started,
 * one ended, a nested window closed). The first is expensive to detect finely,
 * so any animation at all keys by time. The second is what a group with a
 * member laid end to end after another needed and did not have: keyed
 * statically, the stroke ran around a rectangle that had not started yet, and
 * cut across the shape that had. So a still subtree keys by WHO IS SHOWING —
 * the same answer at every frame between two edges, a new one at each edge.
 *
 * EXPORTED because the layer cache needs the identical answer. A group's
 * buffer has exactly the same two reasons to change as its outline does, and
 * a group cached across a member's in-point would show a picture missing a
 * layer that had started — the pixel version of the stroke bug above. Two
 * functions answering this would be two chances to disagree about when a
 * group's picture changed; there is one, and both read it.
 */
export function groupShowingKey(doc: MotionDocument, groupId: string, atMs: number): string {
  const showing: string[] = [];
  for (const id of clipsUnderGroup(doc, groupId)) {
    const loc = locateClip(doc, id);
    if (!loc || loc.clip.kind === "audio") continue;
    const clip = loc.clip;
    if (
      clip.keyframes.length > 0 ||
      Object.keys(clip.drivers ?? {}).length > 0 ||
      (clip.modulators?.length ?? 0) > 0 ||
      clip.trackBinding?.enabled === true
    ) {
      return `t:${atMs}`;
    }
    if (clip.hidden || loc.track.hidden) continue;
    const local = clipRenderLocalTime(loc.track, clip, trackLocalTime(loc.track, clip.frameId, atMs));
    if (!local) continue;
    // Mid in/out animation the member is a different shape every frame; at
    // rest it is the same shape until the next edge.
    if (!isIdentityPose(layerPoseAt(clip, local.local))) return `t:${atMs}`;
    showing.push(id);
  }
  return `s:${showing.join(",")}`;
}

/**
 * The group's outline in FRAME space at `atMs` (comp time), or null when it
 * encloses no geometry.
 */
export function groupSilhouette(
  doc: MotionDocument,
  group: GroupClip,
  atMs: number,
): Contour[] | null {
  let byGroup = cache.get(doc);
  if (!byGroup) {
    byGroup = new Map();
    cache.set(doc, byGroup);
  }
  const key = groupShowingKey(doc, group.id, atMs);
  const hit = byGroup.get(group.id);
  if (hit && hit.key === key) return hit.contours;

  // Always sampled AT THIS MOMENT: the outline is of what is on screen now,
  // so a member that has not started, or has ended, is not in it.
  const result = flattenClipsToPath(doc, [group.id], {
    outlineOf: (clip) => boxOutline(doc, clip),
    atMs,
  });
  const contours = result && result.subpaths.length > 0 ? result.subpaths : null;
  byGroup.set(group.id, { key, contours });
  return contours;
}
