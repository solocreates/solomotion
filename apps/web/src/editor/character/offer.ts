import { characterOf, detectParts, locateClip, type MotionDocument, type PartMap } from "@solomotion/core";

/**
 * Should "Make character" be offered for this layer — the chip, the menu
 * item — and what was found (the chip's tooltip). Light on purpose: the
 * stage imports it; the verb and the mouth pack load on click.
 */
export function characterOffer(doc: MotionDocument, id: string): { map: PartMap; found: string } | null {
  const at = locateClip(doc, id)?.clip;
  if (!at || (at.kind !== "group" && at.kind !== "nested")) return null;
  if (at.kind === "group" && characterOf(doc, id)?.poses?.length) return null;
  const map = detectParts(doc, id);
  if (!map) return null;
  const p = map.parts;
  const mouth = p.mouth?.members?.length ?? 0;
  const eyes = !!(p["eye.L"] || p["eye.R"]);
  const blink = eyes && [p["eye.L"], p["eye.R"], p["lid.L"], p["lid.R"]].some((m) => m && (m.role.startsWith("lid") || m.members?.some((x) => x.pose === "Closed")));
  if (!mouth && !eyes) return null;
  const found = [mouth && `mouth (${mouth})`, eyes && "eyes", blink && "blink", (p["brow.L"] || p["brow.R"]) && "brows", (p["hand.L"] || p["hand.R"]) && "hands"].filter(Boolean).join(", ");
  return { map, found: `Found: ${found}` };
}

