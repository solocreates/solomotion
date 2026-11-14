import type { MotionDocument } from "../schema";

/**
 * THE MEDIA A RENDER OF THIS COMP READS — every asset whose bytes the frame,
 * its layers and every comp nested inside it need: pictures, footage, a
 * layer's sound, a hit sound's custom file, a fill's image.
 *
 * "Needs" is answered the way `media.remove` answers "in use": an asset id is a
 * unique token, so an id that appears in the frame or one of its clips is a
 * reference — whatever field it sits in. A list of known fields would miss
 * the next one added (a physics hit sound, a pattern fill), and a missed
 * reference here is an export that ships without that media.
 *
 * This is what an export checks before it renders, so a file whose bytes are
 * gone from this device is named up front instead of being discovered as a
 * silent soundtrack or a blank layer in the finished file.
 */
export function assetsUsedByFrame(doc: MotionDocument, frameId: string): string[] {
  if (doc.assets.length === 0) return [];
  const seen = new Set<string>();
  const texts: string[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const frame = doc.frames.find((f) => f.id === id);
    if (frame) texts.push(JSON.stringify(frame));
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.frameId !== id) continue;
        texts.push(JSON.stringify(clip));
        if (clip.kind === "nested") visit(clip.sourceFrameId);
      }
    }
  };
  visit(frameId);
  const text = texts.join("\n");
  return doc.assets.filter((a) => text.includes(a.id)).map((a) => a.id);
}
