import type { MotionDocument, Clip, GroupClip } from "../schema";
import { clipAncestorGroups } from "../timeline/groups";
import { switchOptions } from "../timeline/switch";
import { transformPoint } from "../world/math";
import { fromAlphabet, VISEME_IDS } from "@solomotion/lipsync";
import { artBox, restThrough2d } from "./bind";
import { sideOf, type Side } from "./sides";
import { canonicalPoseName, normalizePoseName } from "./vocabulary";

/**
 * CHARACTER PARTS — which layer of a drawing is the head, the left eye, the
 * mouth… so one click can bring it to life (`alive.ts`, ADR-characters rule 1).
 *
 * Character Animator asks a person to tag forty layers. We read what is
 * already there, strongest evidence first:
 *
 *  1. NAMES — in any of a dozen languages and the conventions people really
 *     type ("Eye_L copy 2", "left eye", "ojo izquierdo", "左目", "eyeL").
 *  2. TAGS — a component tagged `pluginData["lipsync.viseme"]` is a mouth
 *     shape, by identity, never by name (the lip-sync plugin's convention).
 *  3. STRUCTURE — a switch (or group) whose members are named by a
 *     vocabulary is that part: visemes or Rhubarb letters ⇒ a mouth,
 *     open/closed ⇒ an eye, fist/point ⇒ a hand. A plural group ("Eyes")
 *     hands its kind to members named only by side ("Left", "Right").
 *  4. GEOMETRY — the tiebreaker, and all there is for a drawing of
 *     "Ellipse 3"s: a mirrored pair high inside the head is the eyes, a pair
 *     inside them the pupils, a centred piece below them the mouth…
 *
 * Every role comes back with a confidence and the one reason that decided it,
 * so the sheet can show "found" and a person can reassign a role in one click
 * (`overrides`). Pure and deterministic: equal documents give equal maps.
 *
 * Sides follow the anatomical convention (Blender, Spine, Moho): `.L` is the
 * CHARACTER's left — the screen's right on a figure facing you. Names always
 * win over that; it only decides a pair nobody named.
 */

// ── Roles ────────────────────────────────────────────────────────────────────

export const SIDED_KINDS = ["eye", "pupil", "lid", "brow", "arm", "forearm", "hand", "leg", "shin", "foot"] as const;
export const UNSIDED_KINDS = ["head", "face", "neck", "torso", "hips", "mouth", "nose", "hair", "accessory"] as const;
export type SidedKind = (typeof SIDED_KINDS)[number];
export type UnsidedKind = (typeof UNSIDED_KINDS)[number];
export type PartKind = SidedKind | UnsidedKind;
export type PartRole = UnsidedKind | `${SidedKind}.${Side}`;

/** Every role, in the order a sheet lists them (head down, left before right). */
export const PART_ROLES: readonly PartRole[] = [
  "head", "face", "hair", "brow.L", "brow.R", "eye.L", "eye.R", "lid.L", "lid.R", "pupil.L", "pupil.R", "nose", "mouth",
  "neck", "torso", "hips", "arm.L", "arm.R", "forearm.L", "forearm.R", "hand.L", "hand.R",
  "leg.L", "leg.R", "shin.L", "shin.R", "foot.L", "foot.R", "accessory",
];

export function roleKind(role: PartRole): PartKind {
  return role.split(".")[0] as PartKind;
}
export function roleSide(role: PartRole): Side | null {
  const s = role.split(".")[1];
  return s === "L" || s === "R" ? s : null;
}
export function isSidedKind(kind: PartKind): kind is SidedKind {
  return (SIDED_KINDS as readonly string[]).includes(kind);
}
export function isPartRole(v: string): v is PartRole {
  return (PART_ROLES as readonly string[]).includes(v);
}

/** What a part's members are named by — an id in `rig/vocabulary.ts`'s registry. */
export type PartVocabulary = "visemes" | "eyes" | "hands" | "brows";

export interface PartMember {
  clipId: string;
  name: string;
  /** The canonical pose this member is (a viseme id `AI`, an eye state `Closed`…). */
  pose: string;
}

export type PartEvidence = "override" | "name" | "tag" | "structure" | "geometry";

export interface PartMatch {
  role: PartRole;
  clipId: string;
  /** The layer's own name, as the layers panel shows it. */
  name: string;
  /** 0..1 — how sure the detector is. */
  confidence: number;
  /** One short reason, ready to show: `named "Eye_L copy 2" · mirrors Eye_L`. */
  reason: string;
  via: PartEvidence;
  isSwitch: boolean;
  /** A part with named poses (a mouth's visemes, an eye's states, a hand's poses). */
  vocabulary?: PartVocabulary;
  members?: PartMember[];
  /** Where it rests, in the root's space (the space its members are written in). Null: not measurable (a world). */
  bounds: Box | null;
}

export type PartRoot =
  | { kind: "group"; groupId: string }
  /** A component instance: its parts live in its source comp, its voice in the outer one (ADR-characters amendment 9). */
  | { kind: "instance"; instanceId: string; frameId: string };

export interface PartMap {
  root: PartRoot;
  /** The comp the parts are in. */
  frameId: string;
  parts: Partial<Record<PartRole, PartMatch>>;
  /** A face on its own, or a figure with a body below the head. */
  figure: "face" | "body";
  /** The character's midline, x in the root's space (null: nothing measurable). */
  axis: number | null;
  /** Everything it holds, at rest, in the root's space. */
  bounds: Box | null;
}

/** A person's corrections: a role to a layer id, or null to drop it. */
export type PartOverrides = Partial<Record<PartRole, string | null>>;

// ── Words ────────────────────────────────────────────────────────────────────

interface KindDef {
  kind: PartKind;
  /** Lowercase, accents folded; multi-word aliases are matched as token runs. */
  aliases: string[];
  /** A group named this holds the kind's pair (its members inherit the kind). */
  plural?: string[];
  /** A sided part with no side of its own takes the side of the nearest one of these. */
  anchor?: SidedKind;
}

/**
 * The vocabulary of parts — a table, not a switch: a new part or a new
 * language is a row. Aliases are folded (lowercase, no accents) like names.
 */
const KINDS: readonly KindDef[] = [
  { kind: "head", aliases: ["head", "kopf", "cabeza", "tete", "testa", "cabeca", "голова", "頭", "头", "あたま", "머리", "سر", "رأس", "kafa", "hoofd", "glowa"], plural: ["heads"] },
  { kind: "face", aliases: ["face", "facial", "gesicht", "cara", "rostro", "visage", "viso", "rosto", "лицо", "顔", "脸", "かお", "얼굴", "صورت", "چهره", "وجه", "yuz", "gezicht"] },
  { kind: "eye", aliases: ["eye", "eyeball", "eye ball", "auge", "ojo", "oeil", "œil", "occhio", "olho", "глаз", "目", "眼", "め", "눈", "چشم", "عين", "goz", "oog", "oko"], plural: ["eyes", "augen", "ojos", "yeux", "occhi", "olhos", "глаза", "ogen", "oczy"] },
  { kind: "pupil", aliases: ["pupil", "iris", "pupille", "pupila", "pupilla", "зрачок", "瞳", "瞳孔", "黒目", "눈동자", "مردمک", "بؤبؤ", "goz bebegi"], plural: ["pupils", "pupilas", "irises"], anchor: "eye" },
  { kind: "lid", aliases: ["lid", "eyelid", "eye lid", "blink", "augenlid", "lid oben", "parpado", "paupiere", "palpebra", "веко", "まぶた", "瞼", "眼皮", "눈꺼풀", "پلک", "جفن"], plural: ["lids", "eyelids", "blinks"], anchor: "eye" },
  { kind: "brow", aliases: ["brow", "eyebrow", "eye brow", "augenbraue", "ceja", "sourcil", "sopracciglio", "sobrancelha", "бровь", "眉", "眉毛", "まゆ", "눈썹", "ابرو", "حاجب", "kas"], plural: ["brows", "eyebrows", "cejas", "sourcils", "брови"], anchor: "eye" },
  { kind: "mouth", aliases: ["mouth", "lips", "lip", "mund", "boca", "bouche", "bocca", "рот", "口", "嘴", "くち", "입", "دهان", "دهن", "فم", "agiz", "mond", "usta"] },
  { kind: "nose", aliases: ["nose", "nase", "nariz", "nez", "naso", "нос", "鼻", "はな", "코", "بینی", "دماغ", "انف", "burun", "neus"] },
  { kind: "neck", aliases: ["neck", "hals", "cuello", "cou", "collo", "pescoco", "шея", "首", "脖子", "목", "گردن", "رقبة", "boyun", "nek"] },
  { kind: "torso", aliases: ["torso", "body", "chest", "trunk", "spine", "rumpf", "korper", "koerper", "cuerpo", "pecho", "corps", "buste", "corpo", "тело", "туловище", "体", "胴", "身体", "躯干", "からだ", "몸", "بدن", "تنه", "جسم", "govde", "lichaam", "shirt"] },
  { kind: "hips", aliases: ["hips", "hip", "pelvis", "waist", "hufte", "cadera", "hanche", "bacino", "quadril", "таз", "腰", "骨盤", "엉덩이", "لگن", "ورك", "pants", "skirt"] },
  { kind: "arm", aliases: ["arm", "upper arm", "upperarm", "uparm", "oberarm", "brazo", "bras", "braccio", "braco", "рука", "плечо", "腕", "上腕", "胳膊", "うで", "팔", "بازو", "ذراع", "kol", "sleeve"], plural: ["arms", "brazos", "руки"] },
  { kind: "forearm", aliases: ["forearm", "fore arm", "lower arm", "lowerarm", "loarm", "unterarm", "antebrazo", "avant bras", "avambraccio", "antebraco", "предплечье", "前腕", "前臂", "아래팔", "ساعد"], plural: ["forearms"], anchor: "arm" },
  { kind: "hand", aliases: ["hand", "mano", "main", "mao", "кисть", "ладонь", "手", "て", "손", "دست", "يد", "glove", "palm"], plural: ["hands", "manos", "mains", "hande"], anchor: "arm" },
  { kind: "leg", aliases: ["leg", "thigh", "upper leg", "upperleg", "bein", "oberschenkel", "pierna", "muslo", "jambe", "cuisse", "gamba", "coscia", "perna", "coxa", "нога", "бедро", "脚", "腿", "太もも", "다리", "ران", "ساق", "bacak"], plural: ["legs", "piernas", "jambes", "beine", "ноги"] },
  { kind: "shin", aliases: ["shin", "calf", "lower leg", "lowerleg", "knee", "unterschenkel", "espinilla", "pantorrilla", "tibia", "mollet", "stinco", "polpaccio", "canela", "голень", "すね", "脛", "小腿", "정강이"], plural: ["shins", "calves"], anchor: "leg" },
  { kind: "foot", aliases: ["foot", "shoe", "boot", "fuss", "pie", "pied", "piede", "pe", "ступня", "стопа", "足", "발", "پا", "قدم", "ayak", "voet", "sneaker"], plural: ["feet", "shoes", "boots", "pies", "pieds", "fusse"], anchor: "leg" },
  { kind: "hair", aliases: ["hair", "fringe", "bangs", "ponytail", "haare", "haar", "pelo", "cabello", "cheveux", "capelli", "cabelo", "волосы", "髪", "头发", "かみ", "머리카락", "مو", "شعر", "sac"] },
  { kind: "accessory", aliases: ["hat", "cap", "glasses", "sunglasses", "scarf", "earring", "bow", "tie", "necklace", "crown", "helmet", "mask", "accessory", "prop", "hut", "sombrero", "chapeau", "cappello", "chapeu", "шляпа", "очки", "帽子", "眼鏡", "メガネ", "모자", "안경", "کلاه", "عینک", "قبعة", "نظارة"] },
];
const KIND_ORDER: readonly PartKind[] = KINDS.map((k) => k.kind);
const KIND_BY_ID = new Map(KINDS.map((k) => [k.kind, k]));

/**
 * Side words beyond `rig/sides.ts`'s (`L/R`, `Left/Right`, `.L`, `_l`, which
 * are read first): the other languages a layer name arrives in.
 */
const SIDE_WORDS: Record<Side, string[]> = {
  L: ["l", "left", "lft", "lt", "links", "linker", "linke", "izquierdo", "izquierda", "izq", "gauche", "sinistro", "sinistra", "sx", "esquerdo", "esquerda", "левый", "левая", "левое", "лев", "ひだり", "왼쪽", "왼", "چپ", "يسار", "ايسر", "sol", "lewy", "lewa"],
  R: ["r", "right", "rgt", "rt", "rechts", "rechter", "rechte", "derecho", "derecha", "der", "droite", "droit", "destro", "destra", "dx", "direito", "direita", "правый", "правая", "правое", "прав", "みぎ", "오른쪽", "오른", "راست", "يمين", "ايمن", "sag", "prawy", "prawa"],
};
const CJK_SIDE: Record<Side, string> = { L: "左", R: "右" };

/** Names that say nothing: what an app calls a layer nobody named. */
const GENERIC = new Set(["layer", "shape", "ellipse", "circle", "oval", "rectangle", "rect", "square", "path", "vector", "group", "image", "img", "picture", "text", "polygon", "star", "line", "frame", "switch", "rig", "untitled", "clip", "nested", "raster", "drawing", "sketch", "copy", "new", "object", "item", "part", "piece", "ebene", "capa", "calque", "livello", "слой", "レイヤー", "图层"]);
const COPY_WORDS = new Set(["copy", "kopie", "copia", "copie", "копия", "コピー"]);

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/** Lowercase, Latin accents folded, NFC — the one form names and aliases are compared in. */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").normalize("NFC").toLowerCase();
}

interface ParsedName {
  tokens: string[];
  joined: string;
  side: Side | null;
  /** "copy", "(2)": a duplicate, so the side it inherited from its original is suspect. */
  copy: boolean;
  /** Only default words and numbers. */
  generic: boolean;
}

function parseName(raw: string): ParsedName {
  // camelCase and letter|digit boundaries are word breaks ("EyeL", "eye2").
  const spaced = raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/(\p{L})(\d)/gu, "$1 $2")
    .replace(/(\d)(\p{L})/gu, "$1 $2");
  const f = fold(spaced);
  const all = f.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const copy = /\(\d+\)/.test(raw) || all.some((t) => COPY_WORDS.has(t));
  const words = all.filter((t) => !/^\d+$/.test(t) && !COPY_WORDS.has(t));
  // The bone-naming reader first (`Arm.L`, `left_eye`); our words for the rest.
  let side: Side | null = sideOf(raw.replace(/\s*(copy|kopie|copia|copie)\b.*$/i, "").trim());
  const tokens: string[] = [];
  for (const t of words) {
    const s = SIDE_WORDS.L.includes(t) ? "L" : SIDE_WORDS.R.includes(t) ? "R" : null;
    if (s) side ??= s;
    else tokens.push(t);
  }
  const joined = tokens.join("");
  if (!side) {
    if (joined.includes(CJK_SIDE.L)) side = "L";
    else if (joined.includes(CJK_SIDE.R)) side = "R";
  }
  const generic = tokens.every((t) => GENERIC.has(t));
  return { tokens, joined, side, copy, generic };
}

/** How much of a name an alias covers (0 = no match). */
function aliasCoverage(name: ParsedName, alias: string): number {
  const a = fold(alias);
  if (CJK.test(a)) return name.joined.includes(a) ? a.length * 3 : 0;
  const at = a.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const glued = at.join("");
  for (const t of name.tokens) if (t === glued) return glued.length;
  outer: for (let i = 0; i + at.length <= name.tokens.length; i++) {
    for (let k = 0; k < at.length; k++) if (name.tokens[i + k] !== at[k]) continue outer;
    return glued.length;
  }
  return 0;
}

/** The kind a name says — the most specific alias wins ("eye brow" is a brow, not an eye). */
function kindOfName(name: ParsedName): { kind: PartKind; plural: boolean } | null {
  let best: { kind: PartKind; plural: boolean; cover: number } | null = null;
  for (const k of KINDS) {
    for (const [list, plural] of [[k.aliases, false], [k.plural ?? [], true]] as const) {
      for (const a of list) {
        const c = aliasCoverage(name, a);
        if (c > (best?.cover ?? 0)) best = { kind: k.kind, plural, cover: c };
      }
    }
  }
  return best && { kind: best.kind, plural: best.plural };
}

// ── Pose vocabularies (`rig/vocabulary.ts` + `@solomotion/lipsync` alphabets) ──

/**
 * Character Animator's mouth names, which no other alphabet spells. `D`, `F`,
 * `L`, `M`, `R`, `S` are single letters here too — Rhubarb's letters win only
 * when a whole set is letters (see `readMembers`).
 */
const CHARACTER_ANIMATOR: Record<string, string> = { neutral: "X", ah: "AI", d: "S", ee: "E", f: "FV", l: "L", m: "MBP", oh: "O", r: "U", s: "S", uh: "AI", woo: "U", wo: "U" };
/** Only for a part already known to be a mouth: the loose words people use. */
const MOUTH_LOOSE: Record<string, string> = { closed: "X", close: "X", shut: "X", open: "AI", wide: "AI", smile: "E", round: "O" };
const VOCAB_KIND: Record<PartVocabulary, PartKind> = { visemes: "mouth", eyes: "eye", hands: "hand", brows: "brow" };

const VISEME_TAG = "lipsync.viseme";

function memberKey(name: string): string {
  return normalizePoseName(fold(name));
}

/** A member's viseme: its tag first, then its name in the set's alphabet. */
function visemeOf(doc: MotionDocument, c: Clip, rhubarb: boolean, loose: boolean): string | null {
  if (c.kind === "nested") {
    const tag = doc.frames.find((f) => f.id === c.sourceFrameId)?.pluginData?.[VISEME_TAG];
    if (typeof tag === "string" && (VISEME_IDS as readonly string[]).includes(tag)) return tag;
  }
  const k = memberKey(c.name);
  if (rhubarb) return fromAlphabet("rhubarb", k);
  return canonicalPoseName("visemes", k) ?? CHARACTER_ANIMATOR[k] ?? (loose ? (MOUTH_LOOSE[k] ?? null) : null);
}

/** Members read through one vocabulary; `loose` admits the everyday words a known mouth uses. */
function readMembers(doc: MotionDocument, members: readonly Clip[], vocab: PartVocabulary, loose = false): PartMember[] {
  const out: PartMember[] = [];
  if (vocab === "visemes") {
    // A set made only of letters with B…H among them is Rhubarb's / Harmony's, where "E" is round (O), not wide.
    const keys = members.map((m) => memberKey(m.name));
    const rhubarb = keys.length >= 3 && keys.every((k) => k.length === 1) && keys.some((k) => "bcdfgh".includes(k));
    for (const m of members) {
      const v = visemeOf(doc, m, rhubarb, loose);
      if (v) out.push({ clipId: m.id, name: m.name, pose: v });
    }
    return out;
  }
  for (const m of members) {
    // The state word may sit beside the part's own name ("Eye L closed").
    const hit = canonicalPoseName(vocab, memberKey(m.name)) ?? parseName(m.name).tokens.map((t) => canonicalPoseName(vocab, t)).find(Boolean) ?? null;
    if (hit) out.push({ clipId: m.id, name: m.name, pose: hit });
  }
  return out;
}

// ── Candidates ──────────────────────────────────────────────────────────────

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
const cx = (b: Box) => (b.minX + b.maxX) / 2;
const cy = (b: Box) => (b.minY + b.maxY) / 2;
const bw = (b: Box) => b.maxX - b.minX;
const bh = (b: Box) => b.maxY - b.minY;
const area = (b: Box) => Math.max(0, bw(b)) * Math.max(0, bh(b));
const inside = (b: Box, x: number, y: number) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
const union = (a: Box | null, b: Box | null): Box | null =>
  !a ? b : !b ? a : { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };

interface Cand {
  clip: Clip;
  order: number;
  depth: number;
  /** Ancestor candidates (within the root), innermost first. */
  up: Cand[];
  name: ParsedName;
  box: Box | null;
  /** A part with poses: its members are its states, not parts of their own. */
  members: Clip[];
  evidence: Map<PartKind, { score: number; reason: string; via: PartEvidence }>;
  vocab?: { vocabulary: PartVocabulary; members: PartMember[] };
}

function addEvidence(c: Cand, kind: PartKind, score: number, reason: string, via: PartEvidence): void {
  const was = c.evidence.get(kind);
  if (!was) return void c.evidence.set(kind, { score, reason, via });
  // Independent evidence agrees: noisy-or. The strongest one names the reason.
  const merged = 1 - (1 - was.score) * (1 - score);
  c.evidence.set(kind, score > was.score ? { score: merged, reason, via } : { ...was, score: merged });
}

/** The clips a root holds, top first, with the groups between (outermost first). */
function walk(doc: MotionDocument, root: PartRoot): Array<{ clip: Clip; inner: GroupClip[] }> {
  const out: Array<{ clip: Clip; inner: GroupClip[] }> = [];
  const visit = (groupId: string | null, inner: GroupClip[], frameId: string) => {
    for (const t of doc.tracks) {
      if (t.groupId !== groupId) continue;
      for (const c of t.clips) {
        if (c.kind === "audio" || c.frameId !== frameId) continue;
        out.push({ clip: c, inner });
        if (c.kind === "group") visit(c.id, [...inner, c], frameId);
      }
    }
  };
  if (root.kind === "group") {
    const g = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === root.groupId);
    if (g?.kind === "group") visit(g.id, [], g.frameId);
  } else visit(null, [], root.frameId);
  return out;
}

/** Leaf corners through the rest chain into the root's space. */
function leafBox(doc: MotionDocument, leaf: Clip, inner: GroupClip[]): Box | null {
  if (leaf.kind === "audio") return null;
  const b = artBox(doc, leaf);
  const m = restThrough2d(doc, inner, leaf);
  let out: Box | null = null;
  for (const [x, y] of [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]] as const) {
    const p = transformPoint(m, [x, y, 0]);
    out = union(out, { minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] });
  }
  return out;
}

/** Which clip a target names as a character: a group, or a component instance (its source comp). */
export function partRootOf(doc: MotionDocument, targetId: string): PartRoot | null {
  const c = doc.tracks.flatMap((t) => t.clips).find((x) => x.id === targetId);
  if (!c) return null;
  if (c.kind === "group") return { kind: "group", groupId: c.id };
  if (c.kind === "nested" && doc.frames.some((f) => f.id === c.sourceFrameId)) return { kind: "instance", instanceId: c.id, frameId: c.sourceFrameId };
  return null;
}

// ── Detection ───────────────────────────────────────────────────────────────

const MIN_SCORE = 0.3;
const W = { name: 0.9, plural: 0.7, tag: 0.85, structure: 0.88, geometry: 0.5 } as const;

/**
 * Classify a character's layers into roles. `targetId` is the character: a
 * group (rig or not) or a component instance. Null when it is neither.
 */
export function detectParts(doc: MotionDocument, targetId: string, opts: { overrides?: PartOverrides } = {}): PartMap | null {
  const root = partRootOf(doc, targetId);
  if (!root) return null;
  const frameId = root.kind === "group" ? doc.tracks.flatMap((t) => t.clips).find((c) => c.id === root.groupId)!.frameId : root.frameId;
  const flat = !doc.frames.find((f) => f.id === frameId)?.world;
  const walked = walk(doc, root);

  // Members of switches and of vocabulary groups are a part's states, not parts.
  const byId = new Map<string, Cand>();
  const cands: Cand[] = [];
  const stateOf = new Set<string>();
  walked.forEach(({ clip, inner }, order) => {
    if (inner.some((g) => stateOf.has(g.id)) || stateOf.has(clip.id)) {
      if (clip.kind === "group") stateOf.add(clip.id);
      return;
    }
    const rootGroupId = root.kind === "group" ? root.groupId : null;
    const up = clipAncestorGroups(doc, clip.id)
      .filter((g) => g.id !== rootGroupId)
      .map((g) => byId.get(g.id))
      .filter((x): x is Cand => !!x);
    const c: Cand = { clip, order, depth: inner.length, up, name: parseName(clip.name), box: null, members: [], evidence: new Map() };
    if (clip.kind === "group") {
      const kids = clip.switch ? switchOptions(doc, clip.id) : doc.tracks.filter((t) => t.groupId === clip.id).flatMap((t) => t.clips).filter((k) => k.kind !== "audio");
      c.members = kids;
      // Which vocabulary its members speak, if any: the one most of them match.
      let best: { vocabulary: PartVocabulary; members: PartMember[] } | null = null;
      for (const vocabulary of ["visemes", "eyes", "hands", "brows"] as const) {
        const m = readMembers(doc, kids, vocabulary);
        if (m.length >= 2 && m.length * 2 >= kids.length && m.length > (best?.members.length ?? 0)) best = { vocabulary, members: m };
      }
      if (best || clip.switch) {
        c.vocab = best ?? undefined;
        for (const k of kids) stateOf.add(k.id);
      }
    }
    byId.set(clip.id, c);
    cands.push(c);
  });

  // Boxes: leaves through their chain; a group is the union of what it holds.
  if (flat) {
    const leafBoxes = new Map<string, Box | null>();
    for (const { clip, inner } of walked) if (clip.kind !== "group") leafBoxes.set(clip.id, leafBox(doc, clip, inner));
    for (const c of cands) {
      if (c.clip.kind !== "group") c.box = leafBoxes.get(c.clip.id) ?? null;
      else {
        let b: Box | null = null;
        for (const { clip, inner } of walked) if (clip.kind !== "group" && inner.some((g) => g.id === c.clip.id)) b = union(b, leafBoxes.get(clip.id) ?? null);
        c.box = b;
      }
    }
  }

  // 1–3: names, tags, structure.
  for (const c of cands) {
    const named = c.name.generic ? null : kindOfName(c.name);
    if (named && !named.plural) addEvidence(c, named.kind, W.name, `named “${c.clip.name}”`, "name");
    if (!named) {
      // A plural group ("Eyes") names what it holds.
      const parent = c.up[0];
      const pk = parent && !parent.name.generic ? kindOfName(parent.name) : null;
      if (pk?.plural) addEvidence(c, pk.kind, W.plural, `in “${parent!.clip.name}”`, "name");
    }
    if (c.clip.kind === "nested") {
      const tag = doc.frames.find((f) => f.id === (c.clip as { sourceFrameId: string }).sourceFrameId)?.pluginData?.[VISEME_TAG];
      if (typeof tag === "string") addEvidence(c, "mouth", W.tag * 0.9, "a tagged mouth shape", "tag");
    }
    if (c.vocab) {
      const tagged = c.vocab.vocabulary === "visemes" && c.members.some((m) => m.kind === "nested" && typeof doc.frames.find((f) => f.id === m.sourceFrameId)?.pluginData?.[VISEME_TAG] === "string");
      const what = c.vocab.vocabulary === "visemes" ? (tagged ? "tagged mouth shapes" : "mouth shapes") : c.vocab.vocabulary === "eyes" ? "eye states" : c.vocab.vocabulary === "hands" ? "hand poses" : "brow poses";
      const score = c.vocab.vocabulary === "visemes" ? (tagged ? 0.95 : W.structure) : c.vocab.vocabulary === "brows" ? 0.6 : 0.75;
      addEvidence(c, VOCAB_KIND[c.vocab.vocabulary], score, `${what}: ${c.vocab.members.map((m) => m.name).slice(0, 4).join(" ")}`, tagged ? "tag" : "structure");
    }
  }

  // 4: geometry — the drawing's own layout, the tiebreaker.
  const axis = flat ? geometry(cands) : null;

  // Overrides first: what a person said is final.
  const parts: Partial<Record<PartRole, PartMatch>> = {};
  const taken = new Set<string>();
  const dropped = new Set<PartRole>();
  for (const role of PART_ROLES) {
    const o = opts.overrides?.[role];
    if (o === null) dropped.add(role);
    if (!o) continue;
    const c = byId.get(o) ?? null;
    const clip = c?.clip ?? doc.tracks.flatMap((t) => t.clips).find((x) => x.id === o);
    if (!clip) continue;
    parts[role] = matchOf(doc, role, c ?? null, clip, 1, "set by you", "override");
    taken.add(clip.id);
  }

  // Kinds: strongest evidence first, one clip per unsided kind and two per sided.
  type Pick = { c: Cand; kind: PartKind; score: number };
  const picks: Pick[] = [];
  for (const c of cands) for (const [kind, e] of c.evidence) if (e.score >= MIN_SCORE) picks.push({ c, kind, score: e.score });
  picks.sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.c.depth - b.c.depth || a.c.order - b.c.order);
  const chosen = new Map<PartKind, Cand[]>();
  for (const p of picks) {
    if (taken.has(p.c.clip.id)) continue;
    const sided = isSidedKind(p.kind);
    const room = (sided ? 2 : 1) - (sided ? (["L", "R"] as const).filter((s) => parts[`${p.kind as SidedKind}.${s}`]).length : parts[p.kind as UnsidedKind] ? 1 : 0);
    const have = chosen.get(p.kind) ?? [];
    if (have.length >= room) continue;
    // One part inside another of its own kind is a piece of it (an eye's white inside "Eye L").
    if (p.c.up.some((a) => have.includes(a))) continue;
    if (dropped.has(p.kind as PartRole) && !sided) continue;
    have.push(p.c);
    chosen.set(p.kind, have);
    taken.add(p.c.clip.id);
  }

  for (const kind of KIND_ORDER) {
    const list = chosen.get(kind) ?? [];
    if (!isSidedKind(kind)) {
      const c = list[0];
      if (c) {
        const e = c.evidence.get(kind)!;
        parts[kind as UnsidedKind] = matchOf(doc, kind as UnsidedKind, c, c.clip, e.score, e.reason, e.via);
      }
      continue;
    }
    for (const r of sides(kind, list, parts, axis)) {
      const role = `${kind}.${r.side}` as PartRole;
      if (dropped.has(role)) continue;
      const e = r.c.evidence.get(kind)!;
      parts[role] = matchOf(doc, role, r.c, r.c.clip, Math.round(e.score * r.trust * 100) / 100, r.why ? `${e.reason} · ${r.why}` : e.reason, e.via);
    }
  }

  const head = parts.head;
  const headBox = head ? byId.get(head.clipId)?.box : null;
  const torsoBox = parts.torso ? byId.get(parts.torso.clipId)?.box : null;
  const figure = parts.torso || parts["leg.L"] || parts["leg.R"] || parts["arm.L"] || parts["arm.R"] || (headBox && torsoBox && cy(torsoBox) > headBox.maxY) ? "body" : "face";
  let bounds: Box | null = null;
  for (const c of cands) if (c.clip.kind !== "group") bounds = union(bounds, c.box);
  return { root, frameId, parts, figure, axis, bounds };
}

function matchOf(doc: MotionDocument, role: PartRole, c: Cand | null, clip: Clip, confidence: number, reason: string, via: PartEvidence): PartMatch {
  const isSwitch = clip.kind === "group" && !!clip.switch;
  const kind = roleKind(role);
  const vocabulary: PartVocabulary | undefined = kind === "mouth" ? "visemes" : kind === "eye" ? "eyes" : kind === "hand" ? "hands" : kind === "brow" ? "brows" : undefined;
  let members: PartMember[] | undefined;
  if (vocabulary && clip.kind === "group") {
    const kids = c?.members.length ? c.members : clip.switch ? switchOptions(doc, clip.id) : doc.tracks.filter((t) => t.groupId === clip.id).flatMap((t) => t.clips);
    const m = readMembers(doc, kids, vocabulary, true);
    // A group whose members are not its states (an eye made of a white and a pupil) has none.
    if (m.length >= 2 && (isSwitch || m.length * 2 >= kids.length)) members = m;
  }
  return { role, clipId: clip.id, name: clip.name, confidence: Math.min(1, confidence), reason, via, isSwitch, ...(members && { vocabulary, members }), bounds: c?.box ?? null };
}

/**
 * Who is left and who is right among a kind's (at most two) picks. A side in
 * the name wins, then one inherited from a group ("Eye L" › "pupil"), then the
 * side of the part it sits in or beside (a pupil inside the left eye); a copy's
 * inherited side and a lone unnamed one give way; a pair nobody named splits
 * by where it stands — the character's left is the screen's right.
 */
function sides(kind: SidedKind, list: Cand[], parts: Partial<Record<PartRole, PartMatch>>, axis: number | null): Array<{ c: Cand; side: Side; why: string; trust: number }> {
  const out: Array<{ c: Cand; side: Side; why: string; trust: number }> = [];
  const free = (s: Side) => !parts[`${kind}.${s}` as PartRole] && !out.some((o) => o.side === s);
  const anchor = KIND_BY_ID.get(kind)?.anchor;
  const strong = (c: Cand): { side: Side; why: string } | null => {
    if (c.name.side && !c.name.copy) return { side: c.name.side, why: "" };
    for (const a of c.up) if (a.name.side) return { side: a.name.side, why: `in “${a.clip.name}”` };
    if (anchor && c.box) {
      let best: { side: Side; d: number; name: string } | null = null;
      for (const s of ["L", "R"] as const) {
        const m = parts[`${anchor}.${s}` as PartRole];
        const ab = m ? anchorBoxes.get(m.clipId) : null;
        if (!m || !ab) continue;
        const d = inside(ab, cx(c.box), cy(c.box)) ? -1 : Math.abs(cx(ab) - cx(c.box));
        if (!best || d < best.d) best = { side: s, d, name: m.name };
      }
      if (best) return { side: best.side, why: best.d < 0 ? `in ${best.name}` : `by ${best.name}` };
    }
    return null;
  };
  const rest: Cand[] = [];
  for (const c of list) {
    const s = strong(c);
    if (s && free(s.side)) out.push({ c, side: s.side, why: s.why, trust: 1 });
    else rest.push(c);
  }
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    const open = (["L", "R"] as const).filter(free);
    if (!open.length) break;
    if (open.length === 1) {
      const other = out.find((o) => o.side !== open[0]) ?? null;
      out.push({ c, side: open[0]!, why: other ? `mirrors ${other.c.clip.name}` : "", trust: 0.95 });
      continue;
    }
    const partner = rest[i + 1];
    if (partner && c.box && partner.box) {
      const cIsL = cx(c.box) >= cx(partner.box);
      out.push({ c, side: cIsL ? "L" : "R", why: "pair, by place", trust: 0.9 }, { c: partner, side: cIsL ? "R" : "L", why: "pair, by place", trust: 0.9 });
      i++;
      continue;
    }
    if (c.name.side) out.push({ c, side: c.name.side, why: "", trust: 0.9 });
    else out.push({ c, side: axis !== null && c.box && cx(c.box) < axis - 1 ? "R" : "L", why: "by place", trust: 0.8 });
  }
  return out;
}

/** Boxes of chosen parts, for anchoring sides — filled by `geometry`'s caller scope. */
const anchorBoxes = new Map<string, Box>();

// ── Geometry ────────────────────────────────────────────────────────────────

interface Pair {
  a: Cand;
  b: Cand;
  box: Box;
  area: number;
  aspect: number;
}

/**
 * Evidence from the layout alone. Returns the midline. Reads named parts
 * where it can (a named head frames the face) and only adds evidence — a name
 * always outweighs it.
 */
function geometry(cands: Cand[]): number | null {
  anchorBoxes.clear();
  for (const c of cands) if (c.box) anchorBoxes.set(c.clip.id, c.box);
  const items = cands.filter((c) => c.box && area(c.box) > 0);
  if (!items.length) return null;
  let all: Box | null = null;
  for (const c of items) all = union(all, c.box);
  const G = all!;
  const related = (a: Cand, b: Cand) => a.up.includes(b) || b.up.includes(a);
  const named = (kind: PartKind) => items.filter((c) => (c.evidence.get(kind)?.score ?? 0) >= 0.6).sort((a, b) => a.order - b.order)[0];

  // Mirrored pairs: alike in size, level, apart.
  const pairs: Pair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!, b = items[j]!;
      if (related(a, b)) continue;
      const A = a.box!, B = b.box!;
      const rw = bw(A) / bw(B), rh = bh(A) / bh(B);
      if (rw < 0.6 || rw > 1.67 || rh < 0.6 || rh > 1.67) continue;
      if (Math.abs(cy(A) - cy(B)) > 0.3 * Math.max(bh(A), bh(B)) + 1) continue;
      if (Math.abs(cx(A) - cx(B)) < 0.6 * Math.max(bw(A), bw(B))) continue;
      const [l, r] = cx(A) <= cx(B) ? [a, b] : [b, a];
      pairs.push({ a: l, b: r, box: union(A, B)!, area: (area(A) + area(B)) / 2, aspect: (bw(A) + bw(B)) / (bh(A) + bh(B)) });
    }
  }
  const pairInside = (H: Box, p: Pair, maxFrac: number) => inside(H, cx(p.a.box!), cy(p.a.box!)) && inside(H, cx(p.b.box!), cy(p.b.box!)) && p.area < area(H) * maxFrac;

  // The head: named, or the largest piece with a small pair inside its upper part, favouring the top.
  let head = named("head") ?? null;
  if (!head) {
    let best = -1;
    for (const c of items) {
      const H = c.box!;
      const has = pairs.some((p) => p.a !== c && p.b !== c && !p.a.up.includes(c) === !p.b.up.includes(c) && pairInside(H, p, 0.2) && cy(p.box) < H.minY + bh(H) * 0.75);
      if (!has) continue;
      const v = (cy(H) - G.minY) / Math.max(1, bh(G));
      const s = area(H) * (1 - 0.5 * v);
      if (s > best) (best = s), (head = c);
    }
    if (head) addEvidence(head, "head", 0.5, "holds the features", "geometry");
  }
  const H = head?.box ?? null;
  let axis = H ? cx(H) : cx(G);

  if (H) {
    const inHead = pairs.filter((p) => p.a !== head && p.b !== head && pairInside(H, p, 0.2)).sort((x, y) => y.area - x.area);
    const within = (small: Pair, big: Pair) => inside(big.a.box!, cx(small.a.box!), cy(small.a.box!)) && inside(big.b.box!, cx(small.b.box!), cy(small.b.box!));
    let eyes = named("eye") ? null : inHead.find((p) => p.aspect < 2.5 && inHead.some((q) => q !== p && within(q, p))) ?? inHead.find((p) => p.aspect < 2.5 && cy(p.box) < cy(H) + bh(H) * 0.15) ?? null;
    if (eyes) for (const c of [eyes.a, eyes.b]) addEvidence(c, "eye", W.geometry, "a pair high in the head", "geometry");
    const eyeA = eyes?.a.box ?? items.find((c) => (c.evidence.get("eye")?.score ?? 0) >= 0.6)?.box ?? null;
    const eyePair = eyes ?? (eyeA ? { box: eyeA } : null);
    if (eyes) axis = cx(eyes.box);
    if (eyes) {
      const pupils = inHead.find((q) => q !== eyes && within(q, eyes!));
      if (pupils) for (const c of [pupils.a, pupils.b]) addEvidence(c, "pupil", 0.5, "inside the eyes", "geometry");
    }
    if (eyePair) {
      const brows = inHead.find((p) => p !== eyes && p.aspect >= 1.8 && cy(p.box) < cy(eyePair.box) && cy(eyePair.box) - cy(p.box) < bh(H) * 0.3);
      if (brows) for (const c of [brows.a, brows.b]) addEvidence(c, "brow", 0.45, "a wide pair above the eyes", "geometry");
      // Centred pieces below the eyes: the lowest is the mouth, one between is the nose.
      const paired = new Set(pairs.flatMap((p) => [p.a, p.b]));
      const centred = items
        .filter((c) => c !== head && !paired.has(c) && !c.up.includes(head!) === !c.up.length && inside(H, cx(c.box!), cy(c.box!)) && area(c.box!) < area(H) * 0.3)
        .filter((c) => Math.abs(cx(c.box!) - axis) < bw(H) * 0.15 && cy(c.box!) > cy(eyePair.box))
        .sort((a, b) => cy(b.box!) - cy(a.box!) || a.order - b.order);
      if (centred[0]) addEvidence(centred[0], "mouth", 0.5, "centred below the eyes", "geometry");
      if (centred[1] && area(centred[1].box!) <= area(centred[0]!.box!) * 1.5) addEvidence(centred[1], "nose", 0.45, "between the eyes and the mouth", "geometry");
    }
    const hair = items.find((c) => c !== head && !c.up.includes(head!) && c.box!.minY < H.minY + bh(H) * 0.05 && cy(c.box!) < cy(H) && bw(c.box!) >= bw(H) * 0.5 && Math.abs(cx(c.box!) - axis) < bw(H) * 0.2);
    if (hair) addEvidence(hair, "hair", 0.4, "over the top of the head", "geometry");

    // A body below the head.
    const torso = named("torso") ?? items
      .filter((c) => c !== head && !c.up.includes(head!) && cy(c.box!) > H.maxY - bh(H) * 0.1 && Math.abs(cx(c.box!) - axis) < bw(G) * 0.2)
      .sort((a, b) => area(b.box!) - area(a.box!) || a.order - b.order)[0];
    if (torso && !named("torso")) addEvidence(torso, "torso", 0.5, "the largest piece below the head", "geometry");
    const T = torso?.box;
    if (T) {
      const limbs = pairs.filter((p) => p.a !== torso && p.b !== torso && cy(p.box) > H.maxY - bh(H) * 0.1);
      const arms = limbs
        .filter((p) => cx(p.b.box!) - axis > bw(T) * 0.3 && cy(p.box) <= T.maxY && cy(p.box) >= T.minY - bh(T) * 0.1)
        .sort((x, y) => Math.hypot(cx(x.b.box!) - axis - bw(T) / 2, cy(x.box) - T.minY) - Math.hypot(cx(y.b.box!) - axis - bw(T) / 2, cy(y.box) - T.minY));
      limbChain(arms, ["arm", "forearm", "hand"], "beside the body");
      const legs = limbs.filter((p) => !arms.includes(p) && cy(p.box) > cy(T) + bh(T) * 0.25).sort((x, y) => cy(x.box) - cy(y.box));
      limbChain(legs, ["leg", "shin", "foot"], "below the body");
    }
  }
  return axis;
}

/** A limb's pairs, nearest the body first: upper, lower, end — two pairs are upper and end when the second is small. */
function limbChain(pairs: Pair[], kinds: [SidedKind, SidedKind, SidedKind], where: string): void {
  if (!pairs.length) return;
  const [upper, lower, end] = kinds;
  const assign = (p: Pair | undefined, k: SidedKind, score: number) => p && [p.a, p.b].forEach((c) => addEvidence(c, k, score, `a pair ${where}`, "geometry"));
  assign(pairs[0], upper, 0.45);
  if (pairs.length === 2) assign(pairs[1], pairs[1]!.area < pairs[0]!.area * 0.6 ? end : lower, 0.4);
  else if (pairs.length >= 3) {
    assign(pairs[1], lower, 0.4);
    assign(pairs[2], end, 0.4);
  }
}
