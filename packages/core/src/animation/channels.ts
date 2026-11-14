import type { Clip, KeyframeValue } from "../schema";
import { propertyHasKeys, sampleKeyframes, setKeyframe } from "./keyframes";
import { getClipProperty, setClipProperty } from "./paths";

/**
 * LINKED CHANNELS — two stored tracks that are one value to a person.
 *
 * Position, scale, skew and the pivot are each ONE property in every tool a
 * motion designer knows (After Effects keys `Scale` as [x, y]), but the
 * document stores each axis as its own track so either can be driven alone.
 * That split is fine until only ONE half is animated: key the scale diamond,
 * which keyed `scale`, then type a Y at keyframe A — `scaleY` had no track, so
 * the write went to its STATIC value, which every keyframe shares. Keyframe B
 * changed too. Editing keyframe A must never touch keyframe B.
 *
 * So the pair is keyed as a unit: once either half is animated, a write to the
 * other first gives it a track holding exactly what it already showed at each
 * of its partner's key times, and only then keys the new value. Nothing on
 * screen moves except the instant you edited.
 */
export const LINKED_CHANNELS: readonly (readonly string[])[] = [
  ["x", "y", "z"],
  ["scale", "scaleY", "scaleZ"],
  ["rotationX", "rotationY", "rotation"],
  ["skewX", "skewY"],
  ["anchor.x", "anchor.y"],
];

/** The other halves of `path`'s linked pair (empty for a lone property). */
export function channelPartners(path: string): readonly string[] {
  const group = LINKED_CHANNELS.find((g) => g.includes(path));
  return group ? group.filter((p) => p !== path) : [];
}

/** What `path` evaluates to at a clip-local instant — keyed, base, or its uniform partner. */
export function channelValueAt(clip: Clip, path: string, localMs: number): KeyframeValue | undefined {
  // A null scaleY is "uniform": it IS the scale, keys and all — unless it has
  // keys of its own, which always win (`sampledScaleY`).
  if (path === "scaleY" && "transform" in clip && clip.transform.scaleY == null && !propertyHasKeys(clip.keyframes, "scaleY")) {
    return channelValueAt(clip, "scale", localMs);
  }
  if (path === "scaleZ" && "transform" in clip && clip.transform.scaleZ == null) {
    return channelValueAt(clip, "scale", localMs);
  }
  if (propertyHasKeys(clip.keyframes, path)) {
    const sampled = sampleKeyframes(clip.keyframes, localMs)[path];
    if (sampled !== undefined) return sampled;
  }
  return getClipProperty(clip, path);
}

/**
 * THE animatable write: a keyframe at `localMs` when the property — or its
 * linked partner — is animated (or `forceKey`, i.e. record mode), otherwise
 * its base value. Every writer (inspector fields, canvas gestures, the agent
 * API) goes through here, so the linked-pair rule cannot be forgotten by one
 * of them. Mutates; call inside a document update.
 */
export function writeChannel(
  clip: Clip,
  path: string,
  localMs: number,
  value: KeyframeValue,
  opts: { forceKey?: boolean } = {},
): "key" | "base" {
  const own = propertyHasKeys(clip.keyframes, path);
  const keyedPartners = channelPartners(path).filter((p) => propertyHasKeys(clip.keyframes, p));
  if (!own && !opts.forceKey && keyedPartners.length === 0) {
    setClipProperty(clip, path, value);
    return "base";
  }
  if (!own && keyedPartners.length > 0) seedFromPartners(clip, path, keyedPartners);
  setKeyframe(clip.keyframes, path, localMs, value);
  return "key";
}

/**
 * Give `path` a track that reproduces what it shows today at every partner
 * key time — the step that makes keying one instant local. A uniform scaleY
 * is made concrete first, since the renderer only reads scaleY keys once it
 * has a value of its own.
 */
function seedFromPartners(clip: Clip, path: string, partners: readonly string[]): void {
  const times = new Map<number, (typeof clip.keyframes)[number]["keys"][number]>();
  for (const track of clip.keyframes) {
    if (!partners.includes(track.property) || track.range) continue;
    for (const k of track.keys) if (!times.has(k.timeMs)) times.set(k.timeMs, k);
  }
  const held = [...times.values()].map((k) => ({ k, v: channelValueAt(clip, path, k.timeMs) }));
  if (path === "scaleY" && "transform" in clip && clip.transform.scaleY == null) {
    clip.transform.scaleY = clip.transform.scale;
  }
  for (const { k, v } of held) {
    if (v !== undefined) setKeyframe(clip.keyframes, path, k.timeMs, v, k.easing);
  }
}
