// 06 · PAPER HILLS — a calm paper-cut landscape. No words.
//
// Six hills, each a periodic ridge (so it can scroll forever without a seam),
// each with a darker paper edge under it instead of a soft shadow. Farther
// hills move slower: that difference IS the depth. Line boil keeps the cut
// edges hand-made.

const DUR = 24000;
const SKY = "#F4E7D4";
const HILLS = [
  // colour, edge, base row (y), amplitude, period (px), seed
  ["#DCD3B6", "#C9BF9E", 60, 46, 360, 0.3],
  ["#BFC29A", "#A9AD84", 130, 54, 540, 1.9],
  ["#9DAE7A", "#879863", 205, 50, 720, 3.1],
  ["#788C5D", "#64774B", 280, 58, 1080, 0.8],
  ["#56653F", "#455232", 370, 52, 1080, 2.4],
  ["#3A4530", "#2D3625", 455, 40, 1440, 4.2],
];

/** A ridge that repeats every `period` px, filled down to the bottom edge. */
function ridgePath(base, amp, period, seed) {
  const w = 1080 + period, step = 12;
  let d = `M0 ${600 - base}`;
  for (let x = 0; x <= w; x += step) {
    const a = (2 * Math.PI * x) / period;
    const y = -amp * (0.62 * Math.sin(a + seed) + 0.28 * Math.sin(2 * a + seed * 1.7) + 0.1 * Math.sin(3 * a + seed * 0.4));
    d += ` L${x} ${y.toFixed(1)}`;
  }
  return { d: d + ` L${w} ${600 - base} Z`, w };
}

return {
  meta: {
    no: "06", family: "Paper & print", name: "Paper Hills",
    line: "Six paper-cut hills drifting at six speeds under a clay sun. Nothing happens, beautifully.",
    prompt: "A calm paper-cut landscape: six layers of hills in sage, olive and oat, each with a darker paper edge, drifting at its own parallax speed under a clay sun. Paper clouds float by, two birds cross. Line boil on every edge, paper grain. No text. A 24 s seamless loop. Soothing.",
    remix: ["Night version: indigo hills, an ivory moon, fireflies.", "Autumn: rust, honey and plum hills, falling paper leaves.", "Put your logo on the sun and hold the last frame as a poster."],
    tech: "periodic ridges scrolled by expression · paper edges instead of shadows · line boil · seamless loop math",
  },
  w: 1080, h: 1080, dur: DUR, bg: SKY, seed: 5,
  async build(f) {
    // The sun and its halo.
    for (const [s, o] of [[520, 0.16], [400, 0.24]]) {
      const id = await L.ellipse(f, { name: "Halo", width: s, height: s, fill: "#E8B866", x: 150, y: -70, set: { opacity: o } });
      await ac.expression.set({ id, property: "scale", source: `1 + 0.03 * sin(#time * ${s === 520 ? 0.5 : 0.7})` });
    }
    await L.ellipse(f, { name: "Sun", width: 280, height: 280, fill: "#D97757", x: 150, y: -70 });

    // Clouds: lumps of paper, drifting right and wrapping.
    for (const [i, [y, s, sp]] of [[-330, 1, 18], [-200, 0.7, 12], [-400, 0.55, 9]].entries()) {
      const d = "M0 60 C0 30 30 10 60 18 C70 -10 120 -20 145 5 C170 -12 215 0 220 35 C245 38 260 52 258 60 Z";
      const edge = await L.path(f, d, { name: `Cloud ${i + 1} edge`, fill: "#E6D6BE", x: 0, y: y + 6 * s, set: { scale: 1.6 * s, scaleY: 1.6 * s } });
      const c = await L.path(f, d, { name: `Cloud ${i + 1}`, fill: "#FBF4EA", x: 0, y, set: { scale: 1.6 * s, scaleY: 1.6 * s } });
      const x0 = Math.round(-760 + L.rand() * 1500);
      for (const id of [edge, c]) await ac.expression.set({ id, property: "x", source: `-760 + mod(${x0 + 760} + #time * ${sp}, 1520)` });
    }

    // Two birds: a 'v' that flaps, crossing slowly.
    for (const [i, [y, sp, ph]] of [[-260, 34, 0], [-228, 30, 300]].entries()) {
      const id = await L.path(f, "M-14 -4 Q -7 -10 0 0 Q 7 -10 14 -4", { name: `Bird ${i + 1}`, stroke: { color: "#3A4530", width: 3, cap: "round", join: "round" }, fill: null, x: 0, y });
      await ac.expression.set({ id, property: "scaleY", source: `0.35 + 0.65 * abs(sin(#time * 5 + ${i}))` });
      await ac.expression.set({ id, property: "x", source: `-600 + mod(#time * ${sp} + ${ph}, 1200)` });
      await ac.expression.set({ id, property: "y", source: `${y} + sin(#time * 0.8 + ${i}) * 10` });
    }

    // The hills, back to front.
    for (const [i, [fill, edge, base, amp, period, seed]] of HILLS.entries()) {
      const { d, w } = ridgePath(base, amp, period, seed);
      const speed = period / (DUR / 1000);
      const x0 = -540 + w / 2;
      for (const [k, col, dy] of [[0, edge, -7], [1, fill, 0]]) {
        const id = await L.path(f, d, { name: `Hill ${i + 1}${k ? "" : " edge"}`, fill: col });
        const b = await L.box(id);
        // the path's box: x 0..w, y from the ridge top to the bottom edge
        await L.pos(id, x0, 540 - b.height / 2 + 60 + dy);
        await ac.expression.set({ id, property: "x", source: `${x0} - mod(#time * ${speed.toFixed(3)}, ${period})` });
        await L.fx(id, "boil", { amount: 1.6, scale: 40, variants: 3 });
      }
    }

    const paper = (await ac.layer.create({ kind: "adjustment", ...L.span(f, { name: "Paper" }) })).id;
    await L.fx(paper, "grain", {});
    await L.fx(paper, "vignette", {});
  },
};
