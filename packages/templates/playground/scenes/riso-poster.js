// 05 · RISO POSTER — two inks, one paper.
//
// A risograph prints one colour per pass, and the passes never line up quite
// right. So: every pink thing is in one group, every blue thing in another;
// both multiply onto the paper (pink × blue = the purple you see where they
// cross); each pass prints in on its own drum, then wobbles a pixel or two.

const DUR = 6000;
const PAPER = "#F3EEE4", PINK = "#FF48B0", BLUE = "#0078BF";
const M = 72;

const jitter = (seed, amp) => `round(sin(floor(#time * 8) * ${seed}) * ${amp})`;

return {
  meta: {
    no: "05", family: "Paper & print", name: "Riso Poster",
    line: "A two-ink gig poster that prints itself, pass by pass, and never quite lines up.",
    prompt: "A two-ink risograph gig poster that prints itself: fluoro pink and federal blue overprinting in multiply, so they make purple where they cross. Halftone moon, huge condensed 'NIGHT SHIFT', tiny mono details. Each ink pass rolls in like a print drum, then the registration jitters a pixel or two at 8 fps. Paper grain. 6 s.",
    remix: ["Swap the inks: teal + orange, and make it a bake sale.", "Print a third pass in yellow for a CMY feel.", "Use your photo as the halftone instead of the moon."],
    tech: "multiply blend overprint · halftone on a radial gradient · per-pass groups · stepped jitter expressions",
  },
  w: 1080, h: 1080, dur: DUR, bg: PAPER, seed: 3,
  async build(f) {
    const mult = (id) => ac.layer.patch({ id, ops: [{ op: "set", path: "blendMode", value: "multiply" }] });
    const radial = (c) => ({ type: "radial", stops: [{ offset: 0, color: c }, { offset: 0.55, color: c + "AA" }, { offset: 1, color: c + "00" }], start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 } });
    const mono = (s, size, color) => L.text(f, s, { name: s, style: { fontFamily: "Space Mono", fontSize: size, fontWeight: 700, color, letterSpacing: 1.5 } });
    const corner = async (id, cx, cy) => { const b = await L.box(id); await L.pos(id, cx * (540 - M - b.width / 2), cy * (540 - M - b.height / 2)); };

    // ── The blue pass ──
    const blue = [];
    const moon = await L.ellipse(f, { name: "Moon", width: 700, height: 700, fill: radial(BLUE), x: 200, y: -170 });
    await L.fx(moon, "halftone", { shape: "dot", size: 18, angle: 15, mode: "mono", inkColor: BLUE, paperColor: "#FFFFFF", contrast: 1.4 });
    blue.push(moon);
    const shift = await L.text(f, "SHIFT", { name: "SHIFT", y: 222, style: { fontFamily: "Anton", fontSize: 360, color: BLUE, letterSpacing: 4 } });
    blue.push(shift);
    for (const [s, cx, cy] of [["VOL. 07 — WAREHOUSE SESSIONS", -1, -1], ["ADMIT ONE", 1, 1]]) { const id = await mono(s, 22, BLUE); await corner(id, cx, cy); blue.push(id); }

    // ── The pink pass ──
    const pink = [];
    const sun = await L.ellipse(f, { name: "Glow", width: 640, height: 640, fill: radial(PINK), x: -230, y: 250 });
    await L.fx(sun, "halftone", { shape: "dot", size: 14, angle: 75, mode: "mono", inkColor: PINK, paperColor: "#FFFFFF", contrast: 1.4 });
    pink.push(sun);
    const night = await L.text(f, "NIGHT", { name: "NIGHT", y: -96, style: { fontFamily: "Anton", fontSize: 360, color: PINK, letterSpacing: 4 } });
    pink.push(night);
    for (const [s, cx, cy] of [["11.11", 1, -1], ["DOORS 23:00 · CLOSES WHEN THE SUN DOES", -1, 1]]) { const id = await mono(s, 22, PINK); await corner(id, cx, cy); pink.push(id); }

    for (const id of [...blue, ...pink]) await mult(id);
    for (const [ids, name, t0, sx, sy] of [[pink, "Pink pass", 0, 12.9898, 78.233], [blue, "Blue pass", 600, 39.346, 11.135]]) {
      const g = await ac.layers.group({ ids, name });
      const gid = g.id ?? g.groupId;
      await ac.layer.patch({ id: gid, ops: [{ op: "set", path: "blendMode", value: "multiply" }] });
      await L.keys(gid, "y", [[t0, -1150, L.EASE.out], [t0 + 900, 0]], "comp");
      await ac.expression.set({ id: gid, property: "x", source: jitter(sx, 2) });
      await ac.expression.set({ id: gid, property: "rotation", source: `${jitter(sy, 3)} * 0.08` });
    }

    const grain = (await ac.layer.create({ kind: "adjustment", ...L.span(f, { name: "Paper grain" }) })).id;
    await L.fx(grain, "grain", {});
  },
};
