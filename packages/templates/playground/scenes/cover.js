// 00 · START HERE — the cover: what this is, how to use it, and a live wall
// of the scenes themselves (nested comps — every tile is the real scene,
// playing). Built last, from the comps the other scene files made.

const DUR = 9000, W = 1920, H = 1080, M = 96;
const WALL = ["02", "03", "04", "05", "06", "07", "08", "09", "10"]; // the square scenes
const INDEX = [
  ["Type", "01 Swiss Grid · 02 Font Roulette"],
  ["Styles", "03 Pixel Quest · 04 Open Late · 05 Riso Poster · 06 Paper Hills"],
  ["UI & Hints", "07 Liquid Glass · 08 Easing, explained"],
  ["Characters", "09 Pixel Talker · 10 Mochi"],
  ["Heavy", "11 Gravity Stickers · 12 Tiny Island"],
];

return {
  meta: {
    no: "00", family: "Start here", name: "Playground",
    line: "Twelve scenes in twelve styles. Each one was made by Claude Opus from the prompt on its card.",
    prompt: "Build a starter playground: twelve short scenes, each in a different 2027 style (Swiss type, pixel art, neon, riso, paper-cut, liquid glass, an easing lesson, a pixel RPG talker, a lip-synced character, physics, a 3D diorama). Put every scene on a tidy page with a card beside it holding the exact prompt that made it, so anyone can copy it, change one word and get their own.",
    remix: ["Open any scene: every layer is editable, nothing is baked.", "Copy a card's prompt, change one word, and ask Claude with the agent link on.", "The whole prompt book (81 more ideas) is in Scripts ▸ playground/PROMPTS.md."],
    tech: "pages per family · a prompt card beside every scene · this wall is nested comps · built by playground/build.js (Scripts panel)",
  },
  w: W, h: H, dur: DUR, bg: L.C.ivory,
  async build(f, made) {
    const left = async (id, x, y) => { const b = await L.box(id); await L.pos(id, x + b.width / 2, y + b.height / 2); return b; };
    const X0 = -W / 2 + M;
    const kick = await L.text(f, "STARTER  ·  PLAYGROUND", { name: "Kicker", style: { fontFamily: L.F.mono, fontSize: 22, fontWeight: 600, letterSpacing: 3, color: L.C.clay } });
    const title = await L.text(f, "Playground", { name: "Title", style: { fontFamily: L.F.serif, fontSize: 210, letterSpacing: -6, lineHeight: 1 } });
    const sub = await L.text(f, "Twelve scenes, twelve styles. Each was made by Claude Opus from one prompt, and the prompt sits right beside it. Open one, change a word, ask again.", { name: "Sub", maxWidth: 760, style: { fontSize: 30, lineHeight: 1.45, color: L.C.mute, align: "left" } });
    let y = -H / 2 + M + 8;
    y += (await left(kick, X0, y)).height + 16;
    y += (await left(title, X0 - 6, y)).height + 28;
    y += (await left(sub, X0, y)).height + 56;
    // The index: one row per page.
    const rows = [];
    for (const [i, [page, list]] of INDEX.entries()) {
      const a = await L.text(f, page.toUpperCase(), { name: `Index ${page}`, startMs: 600 + i * 90, style: { fontFamily: L.F.mono, fontSize: 18, fontWeight: 600, letterSpacing: 2, color: L.C.clay } });
      const b = await L.text(f, list, { name: `Index ${page} list`, startMs: 600 + i * 90, maxWidth: 560, style: { fontSize: 22, color: L.C.slate, align: "left", lineHeight: 1.4 } });
      rows.push([a, b]);
    }
    for (const [a, b] of rows) {
      await L.rect(f, { name: "Index rule", width: 760, height: 1.5, fill: L.C.oat, x: X0 + 380, y: y - 14 });
      await left(a, X0, y + 4);
      const bb = await left(b, X0 + 200, y);
      y += Math.max(bb.height, 28) + 30;
      for (const id of [a, b]) await ac.animation.set({ id, slot: "in", preset: "fade-up", target: "layer", durationMs: 500 });
    }
    const sig = await L.text(f, "✦  Made by Claude Opus 5.5, inside the studio", { name: "Signature", style: { fontFamily: L.F.mono, fontSize: 18, color: L.C.mute, letterSpacing: 1 } });
    await left(sig, X0, H / 2 - M - 24);

    // The live wall: 3 × 3 real scenes.
    const T = 268, G = 24, WX = W / 2 - M - (3 * T + 2 * G), WY = -(3 * T + 2 * G) / 2;
    for (const [i, no] of WALL.entries()) {
      const src = made[no];
      if (!src) continue;
      const cx = WX + (i % 3) * (T + G) + T / 2, cy = WY + Math.floor(i / 3) * (T + G) + T / 2;
      const id = (await ac.layer.create({ kind: "comp", sourceFrameId: src, frameId: f.id, startMs: 0, durationMs: DUR, name: `Tile ${no}`, x: cx, y: cy, set: { scale: T / 1080 } })).id;
      const r = 24 / (T / 1080); // in the tile's own (unscaled) pixels
      await ac.layer.patch({ id, ops: [{ op: "set", path: "borderRadius", value: { tl: r, tr: r, br: r, bl: r } }, { op: "set", path: "playback.loop", value: "loop" }] });
      const edge = await L.rect(f, { name: `Tile ${no} edge`, width: T + 3, height: T + 3, cornerRadius: 25.5, fill: null, stroke: { color: L.C.oat, width: 1.5 }, x: cx, y: cy });
      await ac.animation.set({ id: edge, slot: "in", preset: "zoom-out", target: "layer", durationMs: 700 });
      await ac.animation.set({ id, slot: "in", preset: "zoom-out", target: "layer", durationMs: 700 });
    }
    // The cover rests where everything has arrived — a project reopens each
    // comp at its own playhead, so this is the first thing anyone sees.
    await ac.frame.update({ id: f.id, ops: [{ op: "set", path: "playheadMs", value: 2000 }] });
  },
};
