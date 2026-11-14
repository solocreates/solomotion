// 08 · EASING, EXPLAINED — a lesson with no narration.
//
// Four balls, the SAME two keyframes, four easings. The balls move on real
// keys (open any of them: two diamonds); the dot on each little graph rides
// the same curve by expression, so the lesson can't drift from the truth.

const DUR = 6000, T0 = 800, T1 = 2800;
const P = `clamp((#time - ${T0 / 1000}) / ${(T1 - T0) / 1000}, 0, 1)`;
const ROWS = [
  { name: "Linear", ease: "linear", color: L.C.slate, f: (p) => p, x: (p) => p },
  { name: "Ease in-out", ease: "ease-in-out", color: L.C.sky, f: (p) => p * p * (3 - 2 * p), x: (p) => `smoothstep(0, 1, ${p})` },
  { name: "Back", ease: "ease-out-back", color: L.C.fig, f: (p) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2, x: (p) => `1 + 2.70158 * pow(${p} - 1, 3) + 1.70158 * pow(${p} - 1, 2)` },
  { name: "Elastic", ease: "ease-out-elastic", color: L.C.clay, f: (p) => (p === 0 ? 0 : 2 ** (-10 * p) * Math.sin(((p * 10 - 0.75) * 2 * Math.PI) / 3) + 1), x: (p) => `pow(2, -10 * ${p}) * sin((${p} * 10 - 0.75) * 2.0944) + 1` },
];
const M = 88, TX0 = -540 + M + 28, TX1 = 150, GW = 200, GH = 96, GX = 540 - M - GW;

return {
  meta: {
    no: "08", family: "Explainer", name: "Easing, explained",
    line: "Four balls, the same two keyframes, four personalities. A lesson that needs no voice.",
    prompt: "Teach easing in 6 seconds without narration: four identical balls travel the same distance on the same two keyframes — linear, ease in-out, back, elastic. Beside each, its curve is drawn and a dot rides it in sync. Title 'Same two keyframes.', then 'Four personalities.' lands in clay italic. Paper, ink, Claude colours.",
    remix: ["Do the same for scale instead of position: four hearts beating.", "Add a sound per ball: a tick on landing, a boing for elastic.", "Make it a 9:16 tip card for your app's onboarding."],
    tech: "real keyframes with easing presets · expressions that ride the same curves · draw-on paths · auto layout by measured type",
  },
  w: 1080, h: 1080, dur: DUR, bg: L.C.ivory,
  async build(f) {
    const title = await L.text(f, "Same two keyframes.", { name: "Title", style: { fontFamily: L.F.serif, fontSize: 76, align: "left", letterSpacing: -1 } });
    const tb = await L.box(title);
    await L.pos(title, -540 + M + tb.width / 2, -540 + M + tb.height / 2);
    await ac.animation.set({ id: title, slot: "in", preset: "fade-up", unit: "word", staggerMs: 80, durationMs: 600 });

    for (const [i, r] of ROWS.entries()) {
      const y = -236 + i * 186;
      const lab = await L.text(f, r.name.toUpperCase(), { name: `${r.name} label`, style: { fontFamily: L.F.mono, fontSize: 20, letterSpacing: 2, fontWeight: 600, color: L.C.mute } });
      const lb = await L.box(lab);
      await L.pos(lab, -540 + M + lb.width / 2, y - 52);
      // The track and its two keyframes.
      await L.rect(f, { name: `${r.name} track`, width: TX1 - TX0, height: 2, fill: L.C.oat, x: (TX0 + TX1) / 2, y });
      for (const [k, x] of [[0, TX0], [1, TX1]]) {
        const d = await L.rect(f, { name: `${r.name} key ${k + 1}`, width: 16, height: 16, fill: k ? r.color : L.C.ivory, stroke: { color: r.color, width: 2.5 }, x, y: y + 34, set: { rotation: 45 } });
      }
      // The ball, on REAL keys.
      const ball = await L.ellipse(f, { name: `${r.name} ball`, width: 52, height: 52, fill: r.color, x: TX0, y });
      await L.keys(ball, "x", [[T0, TX0, r.ease], [T1, TX1]]);
      // The graph: hairline axes, the curve drawn on, a dot riding it.
      const gx0 = GX, gy0 = y + GH / 2;
      await L.path(f, `M0 0 V ${GH} H ${GW}`, { name: `${r.name} axes`, stroke: { color: L.C.oat, width: 2 }, fill: null, x: gx0 + GW / 2, y });
      let d = "";
      for (let s = 0; s <= 48; s++) { const p = s / 48; d += `${s ? "L" : "M"}${(p * GW).toFixed(1)} ${(-r.f(p) * GH).toFixed(1)} `; }
      const curve = await L.path(f, d, { name: `${r.name} curve`, stroke: { color: r.color, width: 3, cap: "round", join: "round" }, fill: null, startMs: 200 });
      // place the curve by its own box: x spans 0..GW, y spans min..max of f
      let lo = 0, hi = 0;
      for (let s = 0; s <= 48; s++) { const v = r.f(s / 48); lo = Math.min(lo, v); hi = Math.max(hi, v); }
      await L.pos(curve, gx0 + GW / 2, gy0 - ((lo + hi) / 2) * GH);
      await ac.animation.set({ id: curve, slot: "in", preset: "draw", durationMs: 700 });
      const dot = await L.ellipse(f, { name: `${r.name} dot`, width: 14, height: 14, fill: r.color, x: gx0, y: gy0 });
      await ac.expression.set({ id: dot, property: "x", source: `${gx0} + ${P} * ${GW}` });
      await ac.expression.set({ id: dot, property: "y", source: `${gy0} - (${r.x(P)}) * ${GH}` });
    }

    const pay = await L.text(f, "Four personalities.", { name: "Payoff", startMs: 3100, style: { fontFamily: L.F.serif, fontSize: 76, italic: true, color: L.C.clay, align: "left", letterSpacing: -1 } });
    const pb = await L.box(pay);
    await L.pos(pay, -540 + M + pb.width / 2, 540 - M - pb.height / 2);
    await ac.animation.set({ id: pay, slot: "in", preset: "fade-up", unit: "word", staggerMs: 90, durationMs: 700 });
  },
};
