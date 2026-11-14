import type { Bone, Rig } from "../schema";

/**
 * SIDES — which side of a character a bone is on, read from its NAME, the way
 * every rigging tool a person comes from reads it (Blender's flip-name rules,
 * Maya's `l_`/`r_`, Spine's and Moho's "Left arm"). A side is never stored:
 * the name says it, so renaming a bone moves it, and nothing can disagree.
 *
 * Conventions understood, case kept when flipped:
 *   suffix   `Arm.L` `arm_l` `Arm-R` `Arm R`        (+ a trailing number: `Finger.L.001`, `toe_R2`)
 *   prefix   `L_arm` `r.leg` `L Arm`
 *   middle   `arm_L_ctrl` `Leg.R.FK`
 *   words    `LeftArm` `armLeft` `Arm_Left` `left_arm` `LEFT_EYE` `Right`
 * A word must stand alone (a separator, a digit, a camel-case step or the
 * end beside it): `Leftover`, `Cleft` and `upright` are centre bones.
 * A lone `L` or `R` is a name, not a side.
 */

export type Side = "L" | "R";

/** The default colour of each side (Blender bone colour sets; Maya's red/blue pair). Centre: null — by role. */
export const SIDE_COLORS: Readonly<Record<Side, string>> = { L: "#ff5a5f", R: "#3fa7ff" };

const SEP = "._- ";
const isSep = (c: string | undefined) => !!c && SEP.includes(c);
const isDigit = (c: string | undefined) => !!c && c >= "0" && c <= "9";
const isUpper = (c: string | undefined) => !!c && c !== c.toLowerCase() && c === c.toUpperCase();
const isLower = (c: string | undefined) => !!c && c !== c.toUpperCase() && c === c.toLowerCase();

interface Token {
  /** Where the side token sits in the name. */
  start: number;
  end: number;
  side: Side;
}

/** A trailing number (`.001`, `_2`, `12`) — a side before it still counts. */
const TRAILING_NUMBER = /^(.*?)([._\- ]?\d+)$/;

function tokenIn(core: string): Token | null {
  const n = core.length;
  if (n < 2) return null;
  const letter = (c: string): Side => (c === "L" || c === "l" ? "L" : "R");
  // Suffix letter: `Arm.L`.
  {
    const c = core[n - 1]!;
    if ("LlRr".includes(c) && isSep(core[n - 2]) && n >= 3) return { start: n - 1, end: n, side: letter(c) };
  }
  // Prefix letter: `L_arm`.
  {
    const c = core[0]!;
    if ("LlRr".includes(c) && isSep(core[1]) && n >= 3) return { start: 0, end: 1, side: letter(c) };
  }
  // Suffix word: `ArmLeft`, `arm_left`, `Left`.
  for (const w of ["left", "right"] as const) {
    if (n < w.length || core.slice(n - w.length).toLowerCase() !== w) continue;
    const word = core.slice(n - w.length);
    const before = core.slice(0, n - w.length);
    const last = before[before.length - 1];
    const camel = isUpper(word[0]) && word !== word.toUpperCase() && isLower(last);
    if (!before || isSep(last) || isDigit(last) || camel) return { start: n - w.length, end: n, side: w === "left" ? "L" : "R" };
  }
  // Prefix word: `LeftArm`, `left_arm`, `leftArm`.
  for (const w of ["left", "right"] as const) {
    if (n < w.length || core.slice(0, w.length).toLowerCase() !== w) continue;
    const word = core.slice(0, w.length);
    const next = core[w.length];
    const camel = word !== word.toUpperCase() && isUpper(next);
    if (next === undefined || isSep(next) || isDigit(next) || camel) return { start: 0, end: w.length, side: w === "left" ? "L" : "R" };
  }
  // Middle, between separators: `arm_L_ctrl`, `leg.left.fk`.
  const mid = /[._\- ](left|right|[LlRr])(?=[._\- ])/i.exec(core);
  if (mid) {
    const t = mid[1]!;
    const start = mid.index + 1;
    return { start, end: start + t.length, side: t.length === 1 ? letter(t) : t.toLowerCase() === "left" ? "L" : "R" };
  }
  return null;
}

function locate(name: string): Token | null {
  const num = TRAILING_NUMBER.exec(name);
  if (num && num[1]) {
    const t = tokenIn(num[1]);
    if (t) return t;
  }
  return tokenIn(name);
}

/** The side a bone's name puts it on, or null for a centre bone. */
export function sideOf(name: string): Side | null {
  return locate(name)?.side ?? null;
}

/** The other side. */
export const otherSide = (s: Side): Side => (s === "L" ? "R" : "L");

/** A side token flipped, its case kept: `L`→`R`, `l`→`r`, `Left`→`Right`, `LEFT`→`RIGHT`. */
function flipToken(t: string): string {
  if (t.length === 1) return { L: "R", R: "L", l: "r", r: "l" }[t] ?? t;
  const to = t.toLowerCase() === "left" ? "right" : "left";
  if (t === t.toUpperCase()) return to.toUpperCase();
  if (isUpper(t[0])) return to[0]!.toUpperCase() + to.slice(1);
  return to;
}

/** The name of the bone on the other side (`Arm.L` → `Arm.R`); a centre name comes back unchanged. */
export function mirrorName(name: string): string {
  const t = locate(name);
  if (!t) return name;
  return name.slice(0, t.start) + flipToken(name.slice(t.start, t.end)) + name.slice(t.end);
}

/**
 * The name with its side taken out, folded for matching across conventions:
 * `Arm.L`, `arm_R`, `LeftArm` and `Arm Right` all have the stem `arm`.
 */
export function sideStem(name: string): string {
  const t = locate(name);
  const bare = t ? name.slice(0, t.start) + name.slice(t.end) : name;
  return bare.toLowerCase().replace(/[._\- ]+/g, "");
}

/**
 * The bone on the other side of `boneId` — by its mirrored name exactly, then
 * ignoring case, then (mixed conventions: `Arm.L` with `arm_R`) the ONE bone
 * of the other side with the same stem. Null for a centre bone, or when the
 * other side is not there (or is ambiguous).
 */
export function pairOf(rig: Rig, boneId: string): Bone | null {
  const bone = rig.bones.find((b) => b.id === boneId);
  if (!bone) return null;
  const side = sideOf(bone.name);
  if (!side) return null;
  const want = mirrorName(bone.name);
  const others = rig.bones.filter((b) => b.id !== bone.id);
  const exact = others.find((b) => b.name === want);
  if (exact) return exact;
  const folded = others.filter((b) => b.name.toLowerCase() === want.toLowerCase());
  if (folded.length === 1) return folded[0]!;
  const stem = sideStem(bone.name);
  const byStem = others.filter((b) => sideOf(b.name) === otherSide(side) && sideStem(b.name) === stem);
  return byStem.length === 1 ? byStem[0]! : null;
}

/**
 * The colour a bone is drawn in: its own, else its side's (DERIVED, never
 * stored — rename `Arm` to `Arm.L` and it turns red), else null (by role: the
 * surface's default for a deforming bone or a control).
 */
export function boneColor(bone: Pick<Bone, "name" | "color">): string | null {
  if (bone.color) return bone.color;
  const s = sideOf(bone.name);
  return s ? SIDE_COLORS[s] : null;
}
