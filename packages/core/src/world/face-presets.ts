import { ARKIT_VISEME_WEIGHTS, VISEME_ORDER, toAlphabet, type VisemeId } from "@solomotion/lipsync";
import type { MotionDocument, GroupClip, PoseValue, ShapeKey } from "../schema";
import { keyPath } from "../shape-keys/fields";
import { locateClip } from "../timeline/ops";
import { groupClips } from "../timeline/groups";
import { createPoseSet, poseSetOf } from "../rig/pose-ops";
import { addBehavior } from "../behaviors/ops";
import { characterOf } from "../rig/poses";
import { createId } from "../ids";

/**
 * FACE PRESETS — "drop an avatar → it talks" as one step. Given a mesh's
 * shape keys, recognise the blendshape convention it was built in and build
 * the two pose sets a talking face needs: a Mouth set in the `visemes`
 * vocabulary (each viseme a weighted mix of keys) and an Eyes set (Open,
 * Half, Closed — Wide and Squint where the face has them). Lip sync then
 * drives `pose.<mouth>` and PoseMix eases between the mixes.
 *
 * Conventions, in the order they win when a face carries several (a Ready
 * Player Me avatar ships Oculus visemes AND ARKit shapes; the artist-made
 * visemes read better than an ARKit recipe):
 *
 *   oculus  Meta OVR's 15 (`viseme_aa`, VRChat `vrc.v_aa`, bare `PP`, `kk`…)
 *   arkit   Apple's 52 (`jawOpen`, `mouthFunnel`, `eyeBlinkLeft` / `eyeBlink_L`)
 *   vrm     VRoid/VRM's vowels (`Fcl_MTH_A`, `A I U E O`, VRM 1.0 `aa ih ou ee oh`)
 *   visemes the app's own nine (`AI`, `MBP`, `FV`… — the procedural head)
 *
 * Name matching is alias-tolerant: case, `_ - . :` and spaces are ignored,
 * an exporter's prefix (`blendShape1.`, `BS_`, `ARKit_`, `Face:`) is
 * dropped, and `Left/Right` read as `L/R` — so `jawOpen`, `JawOpen`,
 * `jaw_open` and `blendShape.jawOpen` are one key.
 */

export type FaceConvention = "oculus" | "arkit" | "vrm" | "visemes";

/** A key name reduced to what identifies it (see the module doc). */
export function normalizeKeyName(name: string): string {
  let s = name.trim();
  // Exporter namespaces: `blendShape1.jawOpen`, `Face:jawOpen`, `vrc.v_aa`.
  const cut = Math.max(s.lastIndexOf("."), s.lastIndexOf(":"));
  if (cut >= 0 && cut < s.length - 1) s = s.slice(cut + 1);
  s = s.toLowerCase().replace(/^(blendshape\d*_|bs_|arkit_|shapekey_)/, "");
  s = s.replace(/[^a-z0-9]+/g, "");
  return s.replace(/left$/, "l").replace(/right$/, "r");
}

const OCULUS = ["sil", "pp", "ff", "th", "dd", "kk", "ch", "ss", "nn", "rr", "aa", "e", "ih", "oh", "ou"] as const;
/** Oculus names nobody else uses — what tells a bare `E` of Oculus from a VRM vowel. */
const OCULUS_DISTINCT = new Set(["sil", "pp", "ff", "th", "dd", "kk", "ch", "ss", "nn", "rr"]);

/**
 * VRM's vowels per viseme. Minimal and local (the lipsync package carries no
 * VRM table): A I U E O cover the vowels, `Close` the closures; consonants
 * borrow the nearest vowel at a fraction.
 */
const VRM_VISEME_WEIGHTS: Record<VisemeId, Partial<Record<"a" | "i" | "u" | "e" | "o" | "close", number>>> = {
  X: {},
  MBP: { close: 1 },
  S: { i: 0.55, e: 0.15 },
  E: { e: 0.8, i: 0.25 },
  AI: { a: 1 },
  O: { o: 1 },
  U: { u: 1 },
  FV: { i: 0.3, u: 0.15 },
  L: { a: 0.4, e: 0.25 },
};

export interface FaceViseme {
  name: VisemeId;
  /** Key id → weight; every key the set touches is listed (0 where unused). */
  weights: Record<string, number>;
}

export interface FaceRecognition {
  convention: FaceConvention | null;
  visemes: FaceViseme[];
  /** Visemes that came out as the rest pose because the face has nothing for them. */
  missing: VisemeId[];
  /** Eyes poses (Open/Half/Closed[/Wide/Squint]); empty when no blink key exists. */
  eyes: Array<{ name: string; weights: Record<string, number> }>;
}

/** Key lookup by normalized name (first key wins on a clash). */
function indexKeys(keys: ReadonlyArray<ShapeKey>): Map<string, ShapeKey> {
  const m = new Map<string, ShapeKey>();
  for (const k of keys) {
    const n = normalizeKeyName(k.name);
    if (!m.has(n)) m.set(n, k);
  }
  return m;
}

/** Oculus/RPM/VRChat names arrive as `viseme_aa` / `v_aa`; VRoid's as `fcl_mth_a`. */
function stripped(index: Map<string, ShapeKey>, prefixes: readonly string[]): Map<string, ShapeKey> {
  const out = new Map<string, ShapeKey>();
  for (const [n, k] of index) {
    for (const p of prefixes) {
      if (p && n.startsWith(p) && n.length > p.length) {
        const rest = n.slice(p.length);
        if (!out.has(rest)) out.set(rest, k);
      }
    }
    if (prefixes.includes("") && !out.has(n)) out.set(n, k);
  }
  return out;
}

function arkitName(shape: string): string {
  return normalizeKeyName(shape);
}

/** Recognise the convention and build the viseme and eye mixes (pure). */
export function recognizeFace(keys: ReadonlyArray<ShapeKey>): FaceRecognition {
  const index = indexKeys(keys);
  const oculus = stripped(index, ["viseme", "v", ""]);
  const vrm = stripped(index, ["fclmth", ""]);
  const vrm1: Record<string, "a" | "i" | "u" | "e" | "o"> = { aa: "a", ih: "i", ou: "u", ee: "e", oh: "o" };

  const oculusHits = OCULUS.filter((n) => oculus.has(n)).length;
  const oculusDistinct = OCULUS.filter((n) => OCULUS_DISTINCT.has(n) && oculus.has(n)).length;
  const arkitHits = new Set(Object.values(ARKIT_VISEME_WEIGHTS).flatMap((w) => Object.keys(w).filter((s) => index.has(arkitName(s))))).size;
  const vrmKey = (v: "a" | "i" | "u" | "e" | "o" | "close") =>
    vrm.get(v) ?? (v === "close" ? undefined : vrm.get(Object.keys(vrm1).find((k) => vrm1[k] === v)!));
  const vrmHits = (["a", "i", "u", "e", "o"] as const).filter((v) => vrmKey(v)).length;
  const own = new Map<VisemeId, ShapeKey>();
  for (const v of VISEME_ORDER) {
    const k = index.get(v.toLowerCase());
    if (k) own.set(v, k);
  }

  let convention: FaceConvention | null = null;
  if (oculusHits >= 8 && oculusDistinct >= 3) convention = "oculus";
  else if (arkitHits >= 3 && index.has("jawopen")) convention = "arkit";
  // the app's names share E/O/U with VRM's vowels; AI, MBP and FV are its own.
  else if (own.size >= 4 && ["AI", "MBP", "FV"].filter((v) => own.has(v as VisemeId)).length >= 2) convention = "visemes";
  else if (vrmHits >= 3) convention = "vrm";
  else if (oculusDistinct >= 3) convention = "oculus";

  const raw: Array<{ name: VisemeId; mix: Array<[ShapeKey, number]> }> = VISEME_ORDER.map((v) => {
    const mix: Array<[ShapeKey, number]> = [];
    if (convention === "visemes") {
      const k = own.get(v);
      if (k) mix.push([k, 1]);
    } else if (convention === "oculus") {
      const shape = toAlphabet("oculus", v);
      const k = shape ? oculus.get(normalizeKeyName(shape)) ?? (shape === "ih" ? oculus.get("i") : shape === "oh" ? oculus.get("o") : shape === "ou" ? oculus.get("u") : undefined) : undefined;
      // Silence is the rest pose: a `sil` key is usually the neutral itself.
      if (k && v !== "X") mix.push([k, 1]);
    } else if (convention === "arkit") {
      for (const [shape, w] of Object.entries(ARKIT_VISEME_WEIGHTS[v])) {
        const k = index.get(arkitName(shape));
        if (k && w) mix.push([k, w]);
      }
    } else if (convention === "vrm") {
      for (const [vowel, w] of Object.entries(VRM_VISEME_WEIGHTS[v]) as Array<["a" | "i" | "u" | "e" | "o" | "close", number]>) {
        const k = vrmKey(vowel);
        if (k && w) mix.push([k, w]);
      }
    }
    return { name: v, mix };
  });
  const touched = [...new Set(raw.flatMap((r) => r.mix.map(([k]) => k.id)))];
  const visemes = raw.map(({ name, mix }) => {
    const weights: Record<string, number> = Object.fromEntries(touched.map((id) => [id, 0]));
    for (const [k, w] of mix) weights[k.id] = Math.max(weights[k.id] ?? 0, w);
    return { name, weights };
  });
  const missing = raw.filter((r) => r.name !== "X" && r.mix.length === 0).map((r) => r.name);
  return { convention, visemes, missing, eyes: eyePoses(index) };
}

/** The blink key(s): a left/right pair where the face has one, else a single both-eyes key. */
function eyePoses(index: Map<string, ShapeKey>): FaceRecognition["eyes"] {
  const find = (...names: string[]) => names.map((n) => index.get(n)).find((k) => !!k);
  const pair = (stem: string[]) => {
    const l = find(...stem.map((s) => `${s}l`));
    const r = find(...stem.map((s) => `${s}r`));
    return l && r && l !== r ? [l, r] : null;
  };
  const blink = pair(["eyeblink", "blink", "fcleyeclose", "eyeclose", "eyesclosed"]) ?? [find("blink", "eyeblink", "fcleyeclose", "eyesclosed", "eyeclose", "closeeyes")].filter((k): k is ShapeKey => !!k);
  if (!blink.length) return [];
  const wide = pair(["eyewide"]) ?? [];
  const squint = pair(["eyesquint"]) ?? [];
  const all = [...blink, ...wide, ...squint];
  const pose = (name: string, set: Array<[ShapeKey[], number]>) => {
    const weights: Record<string, number> = Object.fromEntries(all.map((k) => [k.id, 0]));
    for (const [ks, w] of set) for (const k of ks) weights[k.id] = w;
    return { name, weights };
  };
  return [
    pose("Open", []),
    pose("Half", [[blink, 0.5]]),
    pose("Closed", [[blink, 1]]),
    ...(wide.length ? [pose("Wide", [[wide, 1]])] : []),
    ...(squint.length ? [pose("Squint", [[squint, 1], [blink, 0.2]])] : []),
  ];
}

/** The group a face's pose sets live on: its character, its own group, or a new one around it. */
function faceGroup(doc: MotionDocument, meshId: string, name: string): GroupClip | null {
  const owner = characterOf(doc, meshId);
  if (owner) return owner;
  const loc = locateClip(doc, meshId);
  if (!loc) return null;
  const parentId = loc.track.groupId;
  if (parentId) {
    const g = locateClip(doc, parentId)?.clip;
    if (g?.kind === "group") return g;
  }
  const id = groupClips(doc, [meshId], name);
  const g = id ? locateClip(doc, id)?.clip : null;
  return g?.kind === "group" ? g : null;
}

export interface FacePosesResult {
  groupId: string;
  convention: FaceConvention | null;
  mouthSetId: string | null;
  eyesSetId: string | null;
  missing: VisemeId[];
}

/**
 * Build (or rebuild) a face's Mouth and Eyes pose sets on its character
 * group — the group is made around the mesh when it has none. Re-running
 * replaces each set's poses IN PLACE (same set id, so `pose.<set>` keys and
 * a lip-sync driver keep working). Mutates a draft; null when the clip has
 * no shape keys a face can speak with.
 */
export function applyFacePoses(doc: MotionDocument, meshId: string, opts: { blendMs?: number } = {}): FacePosesResult | null {
  const mesh = locateClip(doc, meshId)?.clip;
  if (!mesh || mesh.kind !== "mesh" || !mesh.shapeKeys?.length) return null;
  const face = recognizeFace(mesh.shapeKeys);
  if (!face.convention && !face.eyes.length) return null;
  const group = faceGroup(doc, meshId, mesh.name || "Face");
  if (!group) return null;
  const values = (weights: Record<string, number>): PoseValue[] => Object.entries(weights).map(([id, value]) => ({ clipId: meshId, path: keyPath(id), value }));
  const upsert = (vocabulary: "visemes" | "eyes", name: string, poses: Array<{ name: string; weights: Record<string, number> }>, show: string): string | null => {
    if (!poses.length) return null;
    const list = poses.map((p) => ({ name: p.name, values: values(p.weights) }));
    const existing = group.poses?.find((s) => s.vocabulary === vocabulary);
    if (existing) {
      existing.poses = list.map((p) => ({ id: existing.poses.find((q) => q.name === p.name)?.id ?? createId("pose"), ...p }));
      return existing.id;
    }
    const id = createPoseSet(doc, group.id, { name, vocabulary, poses: list, ...(opts.blendMs !== undefined && { blend: { ms: opts.blendMs } }) });
    const at = id ? poseSetOf(doc, group.id, id) : null;
    if (at) at.set.show = show;
    return id;
  };
  const mouthSetId = face.convention ? upsert("visemes", "Mouth", face.visemes, "X") : null;
  // A face talks the way a 2D character does: a Lip sync behavior on its
  // Mouth, hearing whichever voice plays. Kept when it is already there.
  if (mouthSetId && !group.behaviors?.some((b) => b.type === "lipSync" && b.set === mouthSetId)) addBehavior(doc, group.id, "lipSync", { set: mouthSetId });
  return {
    groupId: group.id,
    convention: face.convention,
    mouthSetId,
    eyesSetId: upsert("eyes", "Eyes", face.eyes, "Open"),
    missing: face.missing,
  };
}
