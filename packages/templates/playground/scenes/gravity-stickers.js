// 11 · GRAVITY STICKERS — real physics, no keyframes.
//
// Every sticker is a group (a disc or a pill + its word) made a rigid body;
// each enters at its own clip start above the frame and falls. Walls and the
// floor are the comp's edges. The pile is never animated by hand.

const DUR = 7000;
const DESK = "#EDE5D6", INK = "#262624";
const WORDS = ["idea", "draft", "again", "nope", "maybe", "v2", "v3", "final", "final_2", "sketch", "hmm", "wow", "undo", "redo", "tweak", "kern", "ease", "boil", "pop", "loop", "key", "oops"];
const FILLS = ["#FAF9F5", "#E8B866", "#9DBEDC", "#C46686", "#788C5D", "#E3DACC"];
const INKON = { "#FAF9F5": INK, "#E8B866": INK, "#9DBEDC": INK, "#C46686": "#FAF9F5", "#788C5D": "#FAF9F5", "#E3DACC": INK };

return {
  meta: {
    no: "11", family: "Physics", name: "Gravity Stickers",
    line: "Twenty-two stickers of the creative process rain onto the desk and pile up. Then one more.",
    prompt: "Twenty-two round and pill-shaped stickers with tiny words (idea, draft, again, nope, v2, final_2, undo…) rain onto a paper desk, bounce, tumble and pile up — real physics, no keyframes. The last one, a big clay 'ship it' sticker, lands on top. A small serif line: 'Every good thing is a pile of drafts.' 7 s.",
    remix: ["Use your team's names or your product's features as the stickers.", "Turn gravity off and let a wind field push them sideways.", "Make the stickers letters that pile into a word."],
    tech: "groups as rigid bodies · staggered clip starts as spawn times · walls + floor · sphere and box colliders",
    heavy: true,
  },
  w: 1080, h: 1080, dur: DUR, bg: DESK, seed: 21,
  async build(f) {
    const line = await L.text(f, "Every good thing is a pile of drafts.", { name: "Line", startMs: 300, style: { fontFamily: L.F.serif, fontSize: 52, italic: true, color: INK } });
    await L.pos(line, 0, -540 + 110);
    await ac.animation.set({ id: line, slot: "in", preset: "fade-up", unit: "word", staggerMs: 60, durationMs: 600 });

    const bodies = [];
    const sticker = async (word, i, at, big) => {
      const round = big ? false : L.rand() < 0.55;
      const fill = big ? L.C.clay : FILLS[i % FILLS.length];
      const size = big ? 0 : 118 + Math.round(L.rand() * 70);
      const fs = big ? 64 : Math.round(size * (word.length > 5 ? 0.2 : 0.27));
      const x = Math.round(-380 + L.rand() * 760), y = -660 - Math.round(L.rand() * 120);
      const t = await L.text(f, word, { name: `${word} word`, startMs: at, x, y, style: { fontFamily: "Inter", fontWeight: 800, fontSize: fs, color: big ? "#FAF9F5" : INKON[fill], letterSpacing: -0.5 } });
      const tb = await L.box(t);
      const w = round ? size : Math.max(size, tb.width + fs * 1.4), h = round ? size : fs * 2.2;
      const s = await (round ? L.ellipse : L.rect)(f, { name: `${word} sticker`, startMs: at, width: big ? tb.width + 96 : w, height: big ? 128 : h, cornerRadius: round ? 0 : (big ? 64 : h / 2), fill, stroke: { color: INK, width: 5 }, x, y });
      await ac.layers.restack({ ids: [s], to: { below: t } });
      const g = (await ac.layers.group({ ids: [s, t], name: `Sticker · ${word}` })).groupId;
      await ac.physics.body({ ids: g, type: "active", shape: round ? "sphere" : "box", bounce: 0.35, friction: 0.6, spin: [0, 0, Math.round((L.rand() - 0.5) * 240)], velocity: [Math.round((L.rand() - 0.5) * 200), 0, 0] });
      bodies.push(g);
    };
    for (const [i, w] of WORDS.entries()) await sticker(w, i, 200 + i * 140, false);
    await sticker("ship it ✦", 99, 4300, true);
    await ac.physics.scene({ frameId: f.id, gravity: 1400, walls: true, startMs: 0 });
  },
};
