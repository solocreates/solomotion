// 06 · THE PAUSE — the wall from 05 freezes on one frame and the sound cuts to
// room tone. The colour drains a little. A second and a half of nothing. Then
// one pencil dot lands in the centre with a tiny tap, and holds.
//
// The freeze is 05 itself, nested at speed 0 on its last frame (so the film's
// seam is exact); the grade drop is an adjustment layer above it.

const W = 1080, H = 1080;
const DEFAULT = {
  dur: 6000,
  drain: 2200,  // the colour drains 20 % over this long
  dot: 1600,    // the pencil dot
};

return {
  meta: {
    no: "06", family: "Go quiet", name: "The Pause", film: true, heavy: false,
    why: "When everything is loud, stopping is what people notice. Silence makes them lean in.",
    prompt: "Everything on screen freezes mid-motion and the sound cuts to near silence. The colour drains a little. Hold it for a second and a half. Then one pencil dot appears in the centre with a tiny tap. Nothing else. 6 s.",
    use: "Right before your most important sentence.",
    hint: "Hold the silence a bit longer than feels comfortable. That itch is the hook.",
    remix: ["Freeze mid-laugh.", "Cut the screen to black for one beat.", "Stop everything except one blinking cursor."],
    tech: "the last hook held on one frame · a slow grade drop on an adjustment layer · one pencil dot · sound as the main event",
  },
  w: W, h: H, dur: DEFAULT.dur, bg: L.C.ink, seed: 606,
  async build(f, ctx = {}) {
    const T = { ...DEFAULT, ...(ctx.timing ?? {}) };
    const fr = L.frame;
    // 05, held on its last frame.
    const src = ctx.hooks?.["05"];
    if (src) {
      const len = (await ac.doc.overview()).comps.find((c) => c.id === src)?.durationMs ?? 13000;
      const held = (await ac.layer.create({ kind: "comp", sourceFrameId: src, ...L.span(f, { x: 0, y: 0 }), name: "05 · held on its last frame" })).id;
      // Speed can't be 0 (FINDINGS A19): at 0.0001 the whole hook plays 0.6 ms of 05 — one frame, held.
      await ac.layer.patch({ id: held, ops: [{ op: "set", path: "trimInMs", value: len - 2 * L.FRAME }, { op: "set", path: "playback", value: { speed: 0.0001 } }] });
    } else {
      await L.text(f, "(build 05 first: this hook holds its last frame)", { name: "Missing 05", style: { fontFamily: L.F.mono, fontSize: 24, color: L.C.paper } });
    }
    // The grade drops: 20 % less colour, a touch darker — slowly, so it's felt more than seen.
    const adj = (await ac.layer.create({ kind: "adjustment", ...L.span(f, {}), name: "Grade · drain" })).id;
    const fx = (await L.fx(adj, "adjust", { saturate: 1, brightness: 1 }));
    const fxId = fx.id ?? fx.effectId ?? (await ac.layer.get({ id: adj })).effects[0].id;
    await L.keys(adj, `lfx.${fxId}.saturate`, [[0, 1, "ease-in-out"], [T.drain, 0.8]], "comp");
    await L.keys(adj, `lfx.${fxId}.brightness`, [[0, 1, "ease-in-out"], [T.drain, 0.95]], "comp");
    // One pencil dot, pressed in: a tiny hand-drawn blob that lands with a squash and boils.
    const pts = [];
    for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2, r = 17 * (1 + L.jit(0.12)); pts.push([Math.cos(a) * r, Math.sin(a) * r * 0.9]); }
    const dot = await L.path(f, L.smooth(pts, true), { name: "Pencil dot", startMs: fr(T.dot), fill: "#2B2925", stroke: { paint: { type: "solid", color: "#2B2925" }, width: 3, join: "round" } });
    await L.boil(dot, { amount: 0.8, scale: 10 });
    await L.keys(dot, "scale", [[0, 1.6, "ease-out"], [70, 0.86, "ease-out-back"], [200, 1]]);
    await L.keys(dot, "scaleY", [[0, 1.6, "ease-out"], [70, 1.12, "ease-out-back"], [200, 1]]);

    L.ev(0, "cut-to-room-tone", { db: -55 });
    L.ev(fr(T.dot), "pencil-tap");
  },
};
