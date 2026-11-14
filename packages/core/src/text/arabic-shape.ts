/**
 * Arabic/Persian/Urdu contextual JOINING for per-grapheme drawing.
 *
 * The renderer draws one grapheme per `fillText` (so every letter can animate
 * on its own), which means the font's shaper never sees a letter's
 * neighbours and would draw every letter isolated. This module decides, from
 * each letter's Joining_Type and its nearest non-transparent neighbours,
 * whether it joins the letter before it, after it, both or neither — and then
 * says so in one of two ways:
 *
 *   `shapeArabicGraphemes`  wraps the letter in ZERO-WIDTH JOINERS on the
 *                           sides it connects (ZWJ ل ZWJ = medial lam). The
 *                           browser's own shaper then picks the FONT's
 *                           contextual glyph — the same one the DOM, and the
 *                           inline editor, draw. This is what the canvas uses.
 *
 *   `presentationForm`      swaps in the Unicode Presentation-Forms codepoint
 *                           for consumers with no shaper at all (the
 *                           opentype.js outliner reads the cmap directly).
 *
 * The canvas used to get presentation forms too, and that was the "some
 * letters of some fonts look wrong" bug: that block is a legacy
 * compatibility table. Many fonts draw it crudely or not at all, it has no
 * forms for many Persian and Urdu letters, and it bypasses the font's own
 * joining design — so the same word looked right while editing (DOM) and wrong
 * on the canvas, in a way that varied by font.
 *
 * Strictly 1:1 with graphemes: the codebase addresses text by grapheme index
 * everywhere (range styling, per-letter animation, hit-testing, caret
 * mapping). The one MANDATORY ligature, lam-alef, keeps that shape: the lam's
 * slot draws the pair (the font forms its real ligature) and the alef's slot
 * draws nothing, with no advance — so indices hold and the word matches the
 * editor, which always ligates.
 *
 * Table generated from the Unicode Character Database (DerivedJoiningType.txt
 * for Joining_Type, UnicodeData.txt decomposition mappings for the
 * presentation-form codepoints), scoped to U+0600–U+08FF (Arabic, Arabic
 * Supplement, Arabic Extended-A/B — covers Persian/Urdu/Sindhi/Uyghur extra
 * letters) and their U+FB50–FDFF / U+FE70–U+FEFF presentation forms. Rows
 * without an encoded presentation form keep their Joining_Type, so they join
 * correctly on the canvas even though `presentationForm` cannot express them.
 */

type JoinType = "D" | "R" | "C";

// [base, type, isolated, initial, medial, final] — 0 = no form encoded.
// prettier-ignore
const TABLE: Array<[number, JoinType, number, number, number, number]> = [[0x620,"D",0,0,0,0],[0x622,"R",0xFE81,0,0,0xFE82],[0x623,"R",0xFE83,0,0,0xFE84],[0x624,"R",0xFE85,0,0,0xFE86],[0x625,"R",0xFE87,0,0,0xFE88],[0x626,"D",0xFE89,0xFE8B,0xFE8C,0xFE8A],[0x627,"R",0xFE8D,0,0,0xFE8E],[0x628,"D",0xFE8F,0xFE91,0xFE92,0xFE90],[0x629,"R",0xFE93,0,0,0xFE94],[0x62A,"D",0xFE95,0xFE97,0xFE98,0xFE96],[0x62B,"D",0xFE99,0xFE9B,0xFE9C,0xFE9A],[0x62C,"D",0xFE9D,0xFE9F,0xFEA0,0xFE9E],[0x62D,"D",0xFEA1,0xFEA3,0xFEA4,0xFEA2],[0x62E,"D",0xFEA5,0xFEA7,0xFEA8,0xFEA6],[0x62F,"R",0xFEA9,0,0,0xFEAA],[0x630,"R",0xFEAB,0,0,0xFEAC],[0x631,"R",0xFEAD,0,0,0xFEAE],[0x632,"R",0xFEAF,0,0,0xFEB0],[0x633,"D",0xFEB1,0xFEB3,0xFEB4,0xFEB2],[0x634,"D",0xFEB5,0xFEB7,0xFEB8,0xFEB6],[0x635,"D",0xFEB9,0xFEBB,0xFEBC,0xFEBA],[0x636,"D",0xFEBD,0xFEBF,0xFEC0,0xFEBE],[0x637,"D",0xFEC1,0xFEC3,0xFEC4,0xFEC2],[0x638,"D",0xFEC5,0xFEC7,0xFEC8,0xFEC6],[0x639,"D",0xFEC9,0xFECB,0xFECC,0xFECA],[0x63A,"D",0xFECD,0xFECF,0xFED0,0xFECE],[0x63B,"D",0,0,0,0],[0x63C,"D",0,0,0,0],[0x63D,"D",0,0,0,0],[0x63E,"D",0,0,0,0],[0x63F,"D",0,0,0,0],[0x640,"C",0,0,0,0],[0x641,"D",0xFED1,0xFED3,0xFED4,0xFED2],[0x642,"D",0xFED5,0xFED7,0xFED8,0xFED6],[0x643,"D",0xFED9,0xFEDB,0xFEDC,0xFEDA],[0x644,"D",0xFEDD,0xFEDF,0xFEE0,0xFEDE],[0x645,"D",0xFEE1,0xFEE3,0xFEE4,0xFEE2],[0x646,"D",0xFEE5,0xFEE7,0xFEE8,0xFEE6],[0x647,"D",0xFEE9,0xFEEB,0xFEEC,0xFEEA],[0x648,"R",0xFEED,0,0,0xFEEE],[0x649,"D",0xFEEF,0xFBE8,0xFBE9,0xFEF0],[0x64A,"D",0xFEF1,0xFEF3,0xFEF4,0xFEF2],[0x66E,"D",0,0,0,0],[0x66F,"D",0,0,0,0],[0x671,"R",0xFB50,0,0,0xFB51],[0x672,"R",0,0,0,0],[0x673,"R",0,0,0,0],[0x675,"R",0,0,0,0],[0x676,"R",0,0,0,0],[0x677,"R",0xFBDD,0,0,0],[0x678,"D",0,0,0,0],[0x679,"D",0xFB66,0xFB68,0xFB69,0xFB67],[0x67A,"D",0xFB5E,0xFB60,0xFB61,0xFB5F],[0x67B,"D",0xFB52,0xFB54,0xFB55,0xFB53],[0x67C,"D",0,0,0,0],[0x67D,"D",0,0,0,0],[0x67E,"D",0xFB56,0xFB58,0xFB59,0xFB57],[0x67F,"D",0xFB62,0xFB64,0xFB65,0xFB63],[0x680,"D",0xFB5A,0xFB5C,0xFB5D,0xFB5B],[0x681,"D",0,0,0,0],[0x682,"D",0,0,0,0],[0x683,"D",0xFB76,0xFB78,0xFB79,0xFB77],[0x684,"D",0xFB72,0xFB74,0xFB75,0xFB73],[0x685,"D",0,0,0,0],[0x686,"D",0xFB7A,0xFB7C,0xFB7D,0xFB7B],[0x687,"D",0xFB7E,0xFB80,0xFB81,0xFB7F],[0x688,"R",0xFB88,0,0,0xFB89],[0x689,"R",0,0,0,0],[0x68A,"R",0,0,0,0],[0x68B,"R",0,0,0,0],[0x68C,"R",0xFB84,0,0,0xFB85],[0x68D,"R",0xFB82,0,0,0xFB83],[0x68E,"R",0xFB86,0,0,0xFB87],[0x68F,"R",0,0,0,0],[0x690,"R",0,0,0,0],[0x691,"R",0xFB8C,0,0,0xFB8D],[0x692,"R",0,0,0,0],[0x693,"R",0,0,0,0],[0x694,"R",0,0,0,0],[0x695,"R",0,0,0,0],[0x696,"R",0,0,0,0],[0x697,"R",0,0,0,0],[0x698,"R",0xFB8A,0,0,0xFB8B],[0x699,"R",0,0,0,0],[0x69A,"D",0,0,0,0],[0x69B,"D",0,0,0,0],[0x69C,"D",0,0,0,0],[0x69D,"D",0,0,0,0],[0x69E,"D",0,0,0,0],[0x69F,"D",0,0,0,0],[0x6A0,"D",0,0,0,0],[0x6A1,"D",0,0,0,0],[0x6A2,"D",0,0,0,0],[0x6A3,"D",0,0,0,0],[0x6A4,"D",0xFB6A,0xFB6C,0xFB6D,0xFB6B],[0x6A5,"D",0,0,0,0],[0x6A6,"D",0xFB6E,0xFB70,0xFB71,0xFB6F],[0x6A7,"D",0,0,0,0],[0x6A8,"D",0,0,0,0],[0x6A9,"D",0xFB8E,0xFB90,0xFB91,0xFB8F],[0x6AA,"D",0,0,0,0],[0x6AB,"D",0,0,0,0],[0x6AC,"D",0,0,0,0],[0x6AD,"D",0xFBD3,0xFBD5,0xFBD6,0xFBD4],[0x6AE,"D",0,0,0,0],[0x6AF,"D",0xFB92,0xFB94,0xFB95,0xFB93],[0x6B0,"D",0,0,0,0],[0x6B1,"D",0xFB9A,0xFB9C,0xFB9D,0xFB9B],[0x6B2,"D",0,0,0,0],[0x6B3,"D",0xFB96,0xFB98,0xFB99,0xFB97],[0x6B4,"D",0,0,0,0],[0x6B5,"D",0,0,0,0],[0x6B6,"D",0,0,0,0],[0x6B7,"D",0,0,0,0],[0x6B8,"D",0,0,0,0],[0x6B9,"D",0,0,0,0],[0x6BA,"D",0xFB9E,0,0,0xFB9F],[0x6BB,"D",0xFBA0,0xFBA2,0xFBA3,0xFBA1],[0x6BC,"D",0,0,0,0],[0x6BD,"D",0,0,0,0],[0x6BE,"D",0xFBAA,0xFBAC,0xFBAD,0xFBAB],[0x6BF,"D",0,0,0,0],[0x6C0,"R",0xFBA4,0,0,0xFBA5],[0x6C1,"D",0xFBA6,0xFBA8,0xFBA9,0xFBA7],[0x6C2,"D",0,0,0,0],[0x6C3,"R",0,0,0,0],[0x6C4,"R",0,0,0,0],[0x6C5,"R",0xFBE0,0,0,0xFBE1],[0x6C6,"R",0xFBD9,0,0,0xFBDA],[0x6C7,"R",0xFBD7,0,0,0xFBD8],[0x6C8,"R",0xFBDB,0,0,0xFBDC],[0x6C9,"R",0xFBE2,0,0,0xFBE3],[0x6CA,"R",0,0,0,0],[0x6CB,"R",0xFBDE,0,0,0xFBDF],[0x6CC,"D",0xFBFC,0xFBFE,0xFBFF,0xFBFD],[0x6CD,"R",0,0,0,0],[0x6CE,"D",0,0,0,0],[0x6CF,"R",0,0,0,0],[0x6D0,"D",0xFBE4,0xFBE6,0xFBE7,0xFBE5],[0x6D1,"D",0,0,0,0],[0x6D2,"R",0xFBAE,0,0,0xFBAF],[0x6D3,"R",0xFBB0,0,0,0xFBB1],[0x6D5,"R",0,0,0,0],[0x6EE,"R",0,0,0,0],[0x6EF,"R",0,0,0,0],[0x6FA,"D",0,0,0,0],[0x6FB,"D",0,0,0,0],[0x6FC,"D",0,0,0,0],[0x6FF,"D",0,0,0,0],[0x710,"R",0,0,0,0],[0x712,"D",0,0,0,0],[0x713,"D",0,0,0,0],[0x714,"D",0,0,0,0],[0x715,"R",0,0,0,0],[0x716,"R",0,0,0,0],[0x717,"R",0,0,0,0],[0x718,"R",0,0,0,0],[0x719,"R",0,0,0,0],[0x71A,"D",0,0,0,0],[0x71B,"D",0,0,0,0],[0x71C,"D",0,0,0,0],[0x71D,"D",0,0,0,0],[0x71E,"R",0,0,0,0],[0x71F,"D",0,0,0,0],[0x720,"D",0,0,0,0],[0x721,"D",0,0,0,0],[0x722,"D",0,0,0,0],[0x723,"D",0,0,0,0],[0x724,"D",0,0,0,0],[0x725,"D",0,0,0,0],[0x726,"D",0,0,0,0],[0x727,"D",0,0,0,0],[0x728,"R",0,0,0,0],[0x729,"D",0,0,0,0],[0x72A,"R",0,0,0,0],[0x72B,"D",0,0,0,0],[0x72C,"R",0,0,0,0],[0x72D,"D",0,0,0,0],[0x72E,"D",0,0,0,0],[0x72F,"R",0,0,0,0],[0x74D,"R",0,0,0,0],[0x74E,"D",0,0,0,0],[0x74F,"D",0,0,0,0],[0x750,"D",0,0,0,0],[0x751,"D",0,0,0,0],[0x752,"D",0,0,0,0],[0x753,"D",0,0,0,0],[0x754,"D",0,0,0,0],[0x755,"D",0,0,0,0],[0x756,"D",0,0,0,0],[0x757,"D",0,0,0,0],[0x758,"D",0,0,0,0],[0x759,"R",0,0,0,0],[0x75A,"R",0,0,0,0],[0x75B,"R",0,0,0,0],[0x75C,"D",0,0,0,0],[0x75D,"D",0,0,0,0],[0x75E,"D",0,0,0,0],[0x75F,"D",0,0,0,0],[0x760,"D",0,0,0,0],[0x761,"D",0,0,0,0],[0x762,"D",0,0,0,0],[0x763,"D",0,0,0,0],[0x764,"D",0,0,0,0],[0x765,"D",0,0,0,0],[0x766,"D",0,0,0,0],[0x767,"D",0,0,0,0],[0x768,"D",0,0,0,0],[0x769,"D",0,0,0,0],[0x76A,"D",0,0,0,0],[0x76B,"R",0,0,0,0],[0x76C,"R",0,0,0,0],[0x76D,"D",0,0,0,0],[0x76E,"D",0,0,0,0],[0x76F,"D",0,0,0,0],[0x770,"D",0,0,0,0],[0x771,"R",0,0,0,0],[0x772,"D",0,0,0,0],[0x773,"R",0,0,0,0],[0x774,"R",0,0,0,0],[0x775,"D",0,0,0,0],[0x776,"D",0,0,0,0],[0x777,"D",0,0,0,0],[0x778,"R",0,0,0,0],[0x779,"R",0,0,0,0],[0x77A,"D",0,0,0,0],[0x77B,"D",0,0,0,0],[0x77C,"D",0,0,0,0],[0x77D,"D",0,0,0,0],[0x77E,"D",0,0,0,0],[0x77F,"D",0,0,0,0],[0x7CA,"D",0,0,0,0],[0x7CB,"D",0,0,0,0],[0x7CC,"D",0,0,0,0],[0x7CD,"D",0,0,0,0],[0x7CE,"D",0,0,0,0],[0x7CF,"D",0,0,0,0],[0x7D0,"D",0,0,0,0],[0x7D1,"D",0,0,0,0],[0x7D2,"D",0,0,0,0],[0x7D3,"D",0,0,0,0],[0x7D4,"D",0,0,0,0],[0x7D5,"D",0,0,0,0],[0x7D6,"D",0,0,0,0],[0x7D7,"D",0,0,0,0],[0x7D8,"D",0,0,0,0],[0x7D9,"D",0,0,0,0],[0x7DA,"D",0,0,0,0],[0x7DB,"D",0,0,0,0],[0x7DC,"D",0,0,0,0],[0x7DD,"D",0,0,0,0],[0x7DE,"D",0,0,0,0],[0x7DF,"D",0,0,0,0],[0x7E0,"D",0,0,0,0],[0x7E1,"D",0,0,0,0],[0x7E2,"D",0,0,0,0],[0x7E3,"D",0,0,0,0],[0x7E4,"D",0,0,0,0],[0x7E5,"D",0,0,0,0],[0x7E6,"D",0,0,0,0],[0x7E7,"D",0,0,0,0],[0x7E8,"D",0,0,0,0],[0x7E9,"D",0,0,0,0],[0x7EA,"D",0,0,0,0],[0x7FA,"C",0,0,0,0],[0x840,"R",0,0,0,0],[0x841,"D",0,0,0,0],[0x842,"D",0,0,0,0],[0x843,"D",0,0,0,0],[0x844,"D",0,0,0,0],[0x845,"D",0,0,0,0],[0x846,"R",0,0,0,0],[0x847,"R",0,0,0,0],[0x848,"D",0,0,0,0],[0x849,"R",0,0,0,0],[0x84A,"D",0,0,0,0],[0x84B,"D",0,0,0,0],[0x84C,"D",0,0,0,0],[0x84D,"D",0,0,0,0],[0x84E,"D",0,0,0,0],[0x84F,"D",0,0,0,0],[0x850,"D",0,0,0,0],[0x851,"D",0,0,0,0],[0x852,"D",0,0,0,0],[0x853,"D",0,0,0,0],[0x854,"R",0,0,0,0],[0x855,"D",0,0,0,0],[0x856,"R",0,0,0,0],[0x857,"R",0,0,0,0],[0x858,"R",0,0,0,0],[0x860,"D",0,0,0,0],[0x862,"D",0,0,0,0],[0x863,"D",0,0,0,0],[0x864,"D",0,0,0,0],[0x865,"D",0,0,0,0],[0x867,"R",0,0,0,0],[0x868,"D",0,0,0,0],[0x869,"R",0,0,0,0],[0x86A,"R",0,0,0,0],[0x870,"R",0,0,0,0],[0x871,"R",0,0,0,0],[0x872,"R",0,0,0,0],[0x873,"R",0,0,0,0],[0x874,"R",0,0,0,0],[0x875,"R",0,0,0,0],[0x876,"R",0,0,0,0],[0x877,"R",0,0,0,0],[0x878,"R",0,0,0,0],[0x879,"R",0,0,0,0],[0x87A,"R",0,0,0,0],[0x87B,"R",0,0,0,0],[0x87C,"R",0,0,0,0],[0x87D,"R",0,0,0,0],[0x87E,"R",0,0,0,0],[0x87F,"R",0,0,0,0],[0x880,"R",0,0,0,0],[0x881,"R",0,0,0,0],[0x882,"R",0,0,0,0],[0x883,"C",0,0,0,0],[0x884,"C",0,0,0,0],[0x885,"C",0,0,0,0],[0x886,"D",0,0,0,0],[0x889,"D",0,0,0,0],[0x88A,"D",0,0,0,0],[0x88B,"D",0,0,0,0],[0x88C,"D",0,0,0,0],[0x88D,"D",0,0,0,0],[0x88E,"R",0,0,0,0],[0x88F,"D",0,0,0,0],[0x8A0,"D",0,0,0,0],[0x8A1,"D",0,0,0,0],[0x8A2,"D",0,0,0,0],[0x8A3,"D",0,0,0,0],[0x8A4,"D",0,0,0,0],[0x8A5,"D",0,0,0,0],[0x8A6,"D",0,0,0,0],[0x8A7,"D",0,0,0,0],[0x8A8,"D",0,0,0,0],[0x8A9,"D",0,0,0,0],[0x8AA,"R",0,0,0,0],[0x8AB,"R",0,0,0,0],[0x8AC,"R",0,0,0,0],[0x8AE,"R",0,0,0,0],[0x8AF,"D",0,0,0,0],[0x8B0,"D",0,0,0,0],[0x8B1,"R",0,0,0,0],[0x8B2,"R",0,0,0,0],[0x8B3,"D",0,0,0,0],[0x8B4,"D",0,0,0,0],[0x8B5,"D",0,0,0,0],[0x8B6,"D",0,0,0,0],[0x8B7,"D",0,0,0,0],[0x8B8,"D",0,0,0,0],[0x8B9,"R",0,0,0,0],[0x8BA,"D",0,0,0,0],[0x8BB,"D",0,0,0,0],[0x8BC,"D",0,0,0,0],[0x8BD,"D",0,0,0,0],[0x8BE,"D",0,0,0,0],[0x8BF,"D",0,0,0,0],[0x8C0,"D",0,0,0,0],[0x8C1,"D",0,0,0,0],[0x8C2,"D",0,0,0,0],[0x8C3,"D",0,0,0,0],[0x8C4,"D",0,0,0,0],[0x8C5,"D",0,0,0,0],[0x8C6,"D",0,0,0,0],[0x8C7,"D",0,0,0,0],[0x8C8,"D",0,0,0,0],];

// prettier-ignore
const TRANSPARENT_RANGES: Array<[number, number]> = [[0x610,0x61A],[0x61C,0x61C],[0x64B,0x65F],[0x670,0x670],[0x6D6,0x6DC],[0x6DF,0x6E4],[0x6E7,0x6E8],[0x6EA,0x6ED],[0x70F,0x70F],[0x711,0x711],[0x730,0x74A],[0x7A6,0x7B0],[0x7EB,0x7F3],[0x7FD,0x7FD],[0x816,0x819],[0x81B,0x823],[0x825,0x827],[0x829,0x82D],[0x859,0x85B],[0x897,0x89F],[0x8CA,0x8E1],[0x8E3,0x8FF]];

interface JoinEntry {
  type: JoinType;
  isolated: number;
  initial: number;
  medial: number;
  final: number;
}

const byBase = new Map<number, JoinEntry>();
for (const [base, type, isolated, initial, medial, final] of TABLE) {
  byBase.set(base, { type, isolated, initial, medial, final });
}

function isTransparent(cp: number): boolean {
  for (const [start, end] of TRANSPARENT_RANGES) {
    if (cp >= start && cp <= end) return true;
    if (cp < start) break;
  }
  return false;
}

/** Can this letter extend a cursive connection forward to the next letter? */
function canJoinNext(type: JoinType | undefined): boolean {
  return type === "D" || type === "C";
}
/** Can this letter receive a cursive connection from the preceding letter? */
function canJoinPrev(type: JoinType | undefined): boolean {
  return type === "D" || type === "R" || type === "C";
}

export type JoinForm = "isolated" | "initial" | "medial" | "final";

const ZWJ = "\u200D";
const ZWNJ = "\u200C";

/**
 * The joining form of every grapheme — null for anything that does not join
 * (Latin, digits, spaces, transparent marks). Same length as the input.
 */
export function arabicJoinForms(chars: readonly string[]): Array<JoinForm | null> {
  const n = chars.length;
  const out: Array<JoinForm | null> = new Array(n).fill(null);
  if (n === 0) return out;

  const leadCp: number[] = new Array(n);
  const types: Array<JoinType | undefined> = new Array(n);
  let anyJoining = false;
  for (let i = 0; i < n; i++) {
    const cp = chars[i]!.codePointAt(0) ?? 0;
    leadCp[i] = cp;
    if (isTransparent(cp)) {
      types[i] = undefined; // transparent: skip over, not a joining boundary
    } else {
      const entry = byBase.get(cp);
      types[i] = entry?.type;
      if (entry) anyJoining = true;
    }
  }
  if (!anyJoining) return out; // nothing Arabic-block in this run — skip the pass entirely

  for (let i = 0; i < n; i++) {
    const entry = byBase.get(leadCp[i]!);
    if (!entry || isTransparent(leadCp[i]!)) continue;
    let p = i - 1;
    while (p >= 0 && isTransparent(leadCp[p]!)) p--;
    let nx = i + 1;
    while (nx < n && isTransparent(leadCp[nx]!)) nx++;
    // A ZERO-WIDTH NON-JOINER (Persian's half-space, می‌خواهم) clusters onto
    // the letter before it, and forbids that letter joining forward.
    const joinsPrev = p >= 0 && canJoinNext(types[p]) && !chars[p]!.includes(ZWNJ) && canJoinPrev(entry.type);
    const joinsNext = nx < n && canJoinNext(entry.type) && !chars[i]!.includes(ZWNJ) && canJoinPrev(types[nx]);
    out[i] = joinsPrev && joinsNext ? "medial" : joinsPrev ? "final" : joinsNext ? "initial" : "isolated";
  }
  return out;
}

/**
 * Shape graphemes for a canvas that draws them one at a time: each joining
 * letter is wrapped in zero-width joiners on the sides it connects, so the
 * font's own shaper produces its real contextual glyph. 1:1 with the input;
 * a ZWJ has no advance, so measuring the result measures the glyph.
 */
export function shapeArabicGraphemes(chars: string[]): string[] {
  const forms = arabicJoinForms(chars);
  if (!forms.some(Boolean)) return chars;
  const out = chars.map((c, i) => {
    const f = forms[i];
    if (f === "medial") return ZWJ + c + ZWJ;
    if (f === "final") return ZWJ + c;
    if (f === "initial") return c + ZWJ;
    return c;
  });
  // Lam joined to the alef right after it: one draw of the pair, so the font
  // produces its ligature; the alef's slot goes empty (see the header).
  for (let i = 0; i + 1 < chars.length; i++) {
    const lamJoins = forms[i] === "initial" || forms[i] === "medial";
    if (!lamJoins || chars[i]!.codePointAt(0) !== LAM || !ALEFS.has(chars[i + 1]!.codePointAt(0) ?? 0)) continue;
    out[i] = (forms[i] === "medial" ? ZWJ : "") + chars[i] + chars[i + 1];
    out[i + 1] = "";
  }
  return out;
}

const LAM = 0x644;
/** Alef with madda, hamza above, hamza below, and plain — each ligates with lam. */
const ALEFS = new Set([0x622, 0x623, 0x625, 0x627]);
/** [isolated, final] lam-alef presentation ligatures per alef. */
const LAM_ALEF: Record<number, [number, number]> = {
  0x622: [0xfef5, 0xfef6],
  0x623: [0xfef7, 0xfef8],
  0x625: [0xfef9, 0xfefa],
  0x627: [0xfefb, 0xfefc],
};

/**
 * The canvas `direction` a shaped grapheme must be measured AND drawn in.
 *
 * Browsers only let a zero-width joiner shape its neighbour when the joiner
 * falls in the same right-to-left run: in the canvas's default LTR context
 * `س‍` measures as the isolated seen (88px at 96px Noto) and in an RTL one as
 * the initial form (71px). Measuring in one and drawing in the other would
 * also misplace every letter, so both sides ask here.
 */
export function glyphDirection(shaped: string): "rtl" | "inherit" {
  return shaped.includes(ZWJ) || /[\u0600-\u08FF\uFB50-\uFEFF]/.test(shaped) ? "rtl" : "inherit";
}

/**
 * A shaped grapheme (from `shapeArabicGraphemes`) as its Presentation-Forms
 * codepoint, for a consumer with no shaper. Graphemes that are not joined, or
 * whose form has no encoded codepoint, come back as their plain letter.
 */
export function presentationForm(shaped: string): string {
  // A whole WORD (the painter draws joined words in one unit): shape it here
  // and map each letter, so a shaper-less consumer still gets joined forms.
  const letters = [...shaped.replace(/\u200D/g, "")];
  const isPair = letters.length === 2 && letters[0]!.codePointAt(0) === LAM;
  if (letters.length > 1 && !isPair) {
    return shapeArabicGraphemes(letters).map((c) => (c ? presentationForm(c) : "")).join("");
  }
  const before = shaped.startsWith(ZWJ);
  // The lam-alef pair: its presentation ligature, final when the lam joins back.
  const pair = [...shaped.replace(/\u200D/g, "")];
  if (pair.length === 2 && pair[0]!.codePointAt(0) === LAM) {
    const lig = LAM_ALEF[pair[1]!.codePointAt(0) ?? 0];
    if (lig) return String.fromCodePoint(before ? lig[1] : lig[0]);
  }
  const after = shaped.endsWith(ZWJ) && shaped.length > 1;
  const core = shaped.slice(before ? 1 : 0, after ? -1 : undefined);
  const cp = core.codePointAt(0) ?? 0;
  const entry = byBase.get(cp);
  if (!entry) return core;
  const form = before && after ? entry.medial : before ? entry.final : after ? entry.initial : entry.isolated;
  if (!form) return core;
  return String.fromCodePoint(form) + core.slice(cp > 0xffff ? 2 : 1);
}
