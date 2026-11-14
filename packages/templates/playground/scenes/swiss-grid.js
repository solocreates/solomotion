// 01 · SWISS GRID — a poster that assembles itself on its own grid.
//
// The 12-column grid is drawn first, as hairlines; then everything lands ON
// it — every left edge is a column edge. Motion here is the grid made visible:
// one easing (the UI in-out), one direction (from the left), one red.

const DUR = 6000, W = 1080, H = 1350;
const PAPER = "#F2EEE3", RED = "#E63B2E", BLACK = "#111111";
const M = 72, GUT = 16, COLS = 12;
const CW = (W - 2 * M - (COLS - 1) * GUT) / COLS;
const colX = (c) => -W / 2 + M + c * (CW + GUT); // left edge of column c (0-based)

return {
  meta: {
    no: "01", family: "Type", name: "Swiss Grid",
    line: "An International Typographic Style poster that draws its grid, then lands every word on it.",
    prompt: "A 1080×1350 Swiss-style poster that assembles itself: cream paper, signal red, black Inter. A 12-column grid draws on as red hairlines, then FORM / FOLLOWS / MOTION slide into column one, one by one, on cubic-bezier(.76,0,.24,1). A red rule sweeps under them, a giant red '01' turns into the top right last, and a small text block settles in columns 7–12. 6 s.",
    remix: ["Same grid, but the words are your three product values.", "Make it Bauhaus: primary colours, circle/square/triangle instead of words.", "Export the last frame as a poster (static comp)."],
    tech: "a real 12-column grid from math · left-edge alignment by measured type · pivot-left scale wipes · one easing for everything",
  },
  w: W, h: H, dur: DUR, bg: PAPER,
  async build(f) {
    const E = L.EASE.ui;
    // The grid: 12 column pairs of hairlines, drawn top-down with a stagger.
    for (let c = 0; c < COLS; c++) {
      for (const x of [colX(c), colX(c) + CW]) {
        const id = await L.path(f, `M0 0 V ${H - 2 * M}`, { name: `Grid ${c + 1}`, startMs: c * 30, stroke: { color: RED, width: 1.5 }, fill: null, x, y: 0, set: { opacity: 0.35 } });
        await ac.animation.set({ id, slot: "in", preset: "draw", durationMs: 800, easing: E });
        await L.keys(id, "opacity", [[3400, 0.35, "ease-in-out"], [4400, 0.12]], "comp");
      }
    }
    // Words, flush to column one.
    const words = ["FORM", "FOLLOWS", "MOTION"];
    const SIZE = 164;
    let y = -40;
    const ids = [];
    for (const [i, w] of words.entries()) {
      const id = await L.text(f, w, { name: w, startMs: 700 + i * 180, style: { fontFamily: "Inter", fontWeight: 900, fontSize: SIZE, letterSpacing: -7, color: i === 2 ? RED : BLACK, lineHeight: 1 } });
      ids.push(id);
    }
    for (const [i, id] of ids.entries()) {
      const b = await L.box(id);
      const x = colX(0) + b.width / 2 - 6; // optical: heavy caps overhang their box a touch
      await L.pos(id, x, y + i * 150);
      await L.keys(id, "x", [[0, x - 140, E], [700, x]]);
      await L.keys(id, "opacity", [[0, 0, "ease-out"], [250, 1]]);
    }
    // The rule under the stack, columns 1–8.
    const ruleW = colX(7) + CW - colX(0);
    const rule = await L.rect(f, { name: "Rule", startMs: 1400, width: ruleW, height: 14, fill: RED, x: colX(0), y: 350, set: { "anchor.x": 0 } });
    await L.keys(rule, "scale", [[0, 0, E], [800, 1]]);
    // The number: huge, red, turned, top right.
    const num = await L.text(f, "01", { name: "Number", startMs: 1900, style: { fontFamily: "Inter", fontWeight: 900, fontSize: 420, letterSpacing: -24, color: RED, lineHeight: 1 } });
    const nb = await L.box(num);
    const nx = colX(COLS) - GUT - nb.height / 2 + 30, ny = -H / 2 + M + nb.width / 2 + 48;
    await L.pos(num, nx, ny);
    await L.keys(num, "rotation", [[0, 0, E], [900, -90]]);
    await L.keys(num, "opacity", [[0, 0, "ease-out"], [200, 1]]);
    // A text block in columns 7–12, and a colophon in 1–4.
    const body = await L.text(f, "Motion is a grid in time.\nEvery move lands on a line,\nand every line was there first.", { name: "Body", startMs: 2500, maxWidth: colX(12) - colX(6) - GUT, style: { fontFamily: "Inter", fontSize: 30, fontWeight: 500, lineHeight: 1.35, color: BLACK, align: "left" } });
    const colo = await L.text(f, "Playground\nNº 01 — Type\nMade by Claude Opus", { name: "Colophon", startMs: 2700, style: { fontFamily: L.F.mono, fontSize: 20, lineHeight: 1.5, color: BLACK, align: "left" } });
    const bb = await L.box(body), cb = await L.box(colo);
    const by = H / 2 - M - bb.height / 2;
    await L.pos(body, colX(6) + bb.width / 2, by);
    await L.pos(colo, colX(0) + cb.width / 2, H / 2 - M - cb.height / 2);
    for (const id of [body, colo]) await ac.animation.set({ id, slot: "in", preset: "fade-up", target: "layer", durationMs: 600, easing: E });
  },
};
