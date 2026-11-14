// 05 · THE SWIPE — our video fills the frame; the camera rushes back until it
// is one tile in a wall of ~2,000 loud, generic, moving videos, all scrolling.
// A giant hand-drawn thumb slides in and hovers over the wall, twitching —
// then hides half behind the edge, caught. Our tile keeps a clay hairline so
// the eye never loses it.
//
// There is no repeater (FINDINGS A4), so the wall is built cheaply: six tiny
// looping "video" comps; ONE live 8×8 block of them around our tile; every
// other block is three flat layers (grey tiles, gradient tiles, caption bars);
// and a single wall comp of 7×7 blocks, nested once and zoomed. Our tile is a
// separate, crisp layer on top, scaled in step with the wall.

const W = 1080, H = 1080;
const DEFAULT = {
  dur: 13000,
  zoom: 300,      // the camera starts rushing back…
  zoomEnd: 2300,  // …and arrives: one tile in a wall
  thumb: 2500,    // the thumb slides in from the bottom
  twitches: [4300, 6200, 8000],
  hide: 9600,     // "Or… maybe not." — it ducks half behind the edge, caught
};
const TILE = 120, GAP = 12, P = TILE + GAP, N = 8, B = N * P, BLOCKS = 7; // a comp can't pass 8192 px
const TS = 240; // the six videos are drawn at 240 and nested at TILE/TS
const FINAL = 27 / P;          // the wall's last scale: a tile pitch of 27 px (40 across the frame)
const START = W / TILE;        // the wall's first scale: our tile fills the frame
const BABBLE = ["wait for it", "you won't believe this", "stop scrolling", "POV:", "day 47 of…", "this changed everything",
  "watch till the end", "three things nobody tells you", "I tried it so you don't have to", "here's why", "part two", "the secret is…"];

return {
  meta: {
    no: "05", family: "Show what's at stake", name: "The Swipe", film: true, heavy: true,
    why: "One video among thousands makes the risk real. You can feel how easy it is to be skipped.",
    prompt: "Start on a single video tile, then rush the camera back until it's one tile in a wall of a thousand moving videos, all generic and loud, all scrolling. Our tile keeps a thin clay border. A giant hand-drawn ink thumb slides in and hovers over the wall, twitching, then hides half behind the edge. Under it, a babble of creators saying their openers at the same time. 13 s.",
    use: "People need to feel what they could lose before you offer the fix.",
    hint: "Keep your own tile findable. A thin clay border means the eye never loses it.",
    remix: ["Your product is one bottle on an endless supermarket shelf.", "One star in a sky full of satellites.", "One CV in a pile of a thousand."],
    tech: "six looping tile comps reused by script · one live block near the camera, flat blocks far away · a zoom on a log curve · our tile as its own crisp layer · the babble logged line by line",
  },
  w: W, h: H, dur: DEFAULT.dur, bg: L.C.ink, seed: 505,
  async build(f, ctx = {}) {
    const T = { ...DEFAULT, ...(ctx.timing ?? {}) };
    const fr = L.frame, page = ctx.kitPage ?? ctx.page;
    L.reseed(505);
    const ui = { type: "solid", color: "#FFFFFFB3" };
    const grad = (a = L.C.aiA, b = L.C.aiB) => ({ type: "linear", stops: [{ offset: 0, color: a }, { offset: 1, color: b }], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } });

    // 1 · Six "videos": machine things, perfect eases, 1.5 s loops, no boil.
    // Each video comp holds TWO cycles, so an instance offset by up to one cycle never runs past its end.
    const LOOP = 1500, tiles = [];
    const two = (k) => [...k, ...k.map(([t, v, e]) => [t + LOOP, v, e])].filter(([t], i, a) => i === 0 || t !== a[i - 1][0]);
    for (let v = 0; v < 6; v++) {
      const t = await L.part({ name: `05 · tile ${v + 1}`, w: TS, h: TS, bg: "#00000000", dur: 2 * LOOP, page });
      const face = [grad(), { type: "solid", color: L.C.grey }, { type: "solid", color: L.C.greyDeep }, grad(L.C.aiB, L.C.aiA), { type: "solid", color: "#B9BDC6" }, grad("#A79DE8", "#7FB8E0")][v];
      await L.rect(t, { name: "face", width: TS, height: TS, cornerRadius: 18, fill: face });
      if (v === 0) { const id = await L.path(t, "M-30 -44L48 0L-30 44Z", { name: "play", fill: ui }); await L.keys(id, "scale", two([[0, 1, L.EASE.machine], [750, 1.14, L.EASE.machine], [LOOP, 1]])); }
      if (v === 1) { const id = await L.rect(t, { name: "caption", width: 150, height: 24, cornerRadius: 12, fill: L.C.greyDeep, x: 0, y: 60 }); await L.keys(id, "y", two([[0, 60, L.EASE.pop], [400, 30, L.EASE.machine], [800, 60, L.EASE.pop], [1150, 40, L.EASE.machine], [LOOP, 60]])); }
      if (v === 2) { const id = await L.ellipse(t, { name: "face blur", width: 110, height: 130, fill: "#D8B9A2", x: 0, y: -10 }); await L.fx(id, "blur", { radius: 16 }); await L.keys(id, "x", two([[0, -14, L.EASE.machine], [750, 14, L.EASE.machine], [LOOP, -14]])); }
      if (v === 3) { const id = await L.text(t, "POV:", { name: "pov", style: { fontFamily: L.F.sans, fontWeight: 900, fontSize: 52, color: "#FFFFFF" } }); await L.keys(id, "scale", two([[0, 0.9, L.EASE.pop], [300, 1.08, L.EASE.machine], [LOOP, 0.9]])); }
      if (v === 4) { await L.rect(t, { name: "track", width: 180, height: 10, cornerRadius: 5, fill: "#9EA3AD", x: 0, y: 70 }); const id = await L.rect(t, { name: "progress", width: 180, height: 10, cornerRadius: 5, fill: "#FFFFFF", x: -90, y: 70, set: { "anchor.x": 0 } }); await L.keys(id, "scale", [[0, 0.02, "linear"], [LOOP - 1, 1, "linear"], [LOOP, 0.02, "linear"], [2 * LOOP - 1, 1]]); }
      if (v === 5) for (let i = 0; i < 3; i++) { const id = await L.ellipse(t, { name: `dot ${i + 1}`, width: 22, height: 22, fill: "#FFFFFF", x: (i - 1) * 40 }); await L.keys(id, "opacity", two([[i * 200, 0.3, L.EASE.machine], [i * 200 + 300, 1, L.EASE.machine], [i * 200 + 600, 0.3]])); }
      if (v !== 3 && v !== 5) await L.rect(t, { name: "title bar", width: 130, height: 14, cornerRadius: 7, fill: "#FFFFFF66", x: -TS / 2 + 24 + 65, y: -TS / 2 + 30 });
      tiles.push(t.id);
    }
    // 2 · The live block: 8×8 nested videos with their own time offsets. Its (3,3) is left
    //     empty: our tile sits there, drawn on top in the scene.
    const near = await L.part({ name: "05 · live block (8×8)", w: B, h: B, bg: "#00000000", dur: T.dur, page });
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (r === 3 && c === 3) continue;
      const id = (await ac.layer.create({ kind: "comp", sourceFrameId: tiles[Math.floor(L.rand() * 6)], ...L.span(near, { x: (c - 3.5) * P, y: (r - 3.5) * P, set: { scale: TILE / TS } }), name: `video ${r}·${c}` })).id;
      await ac.layer.patch({ id, ops: [{ op: "set", path: "playback", value: { loop: "loop", loopLengthMs: LOOP - 1 } }, { op: "set", path: "trimInMs", value: Math.round(L.rand() * (LOOP - 1)) }] });
    }
    // 3 · A far block: three flat layers for 64 tiles (grey faces, gradient faces, caption bars that bob).
    const far = await L.part({ name: "05 · far block (3 layers)", w: B, h: B, bg: "#00000000", dur: T.dur, page });
    const sq = (x, y, w, h, r) => `M${x - w / 2 + r} ${y - h / 2}L${x + w / 2 - r} ${y - h / 2}Q${x + w / 2} ${y - h / 2} ${x + w / 2} ${y - h / 2 + r}L${x + w / 2} ${y + h / 2 - r}Q${x + w / 2} ${y + h / 2} ${x + w / 2 - r} ${y + h / 2}L${x - w / 2 + r} ${y + h / 2}Q${x - w / 2} ${y + h / 2} ${x - w / 2} ${y + h / 2 - r}L${x - w / 2} ${y - h / 2 + r}Q${x - w / 2} ${y - h / 2} ${x - w / 2 + r} ${y - h / 2}Z`;
    // The same mix as the live videos, so the live block doesn't read as a patch.
    const D = { grey: "", deep: "", light: "", grad: "", grad2: "", skin: "", play: "", bars: "" };
    const tri = (x, y) => `M${x - 8} ${y - 12}L${x + 13} ${y}L${x - 8} ${y + 12}Z`;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const x = (c - 3.5) * P, y = (r - 3.5) * P, k = Math.floor(L.rand() * 6), face = sq(x, y, TILE, TILE, 9);
      if (k === 0) { D.grad += face; D.play += tri(x, y - 6); }
      if (k === 1) { D.grey += face; D.bars += sq(x, y + 30, 75, 12, 6); }
      if (k === 2) { D.deep += face; D.skin += sq(x, y - 5, 52, 62, 26); }
      if (k === 3) { D.grad2 += face; D.bars += sq(x - 6, y + 30, 60, 12, 6); }
      if (k === 4) { D.light += face; D.bars += sq(x, y + 35, 90, 5, 2.5); }
      if (k === 5) { D.grad += face; D.bars += sq(x - 10, y + 30, 75, 12, 6); }
    }
    const fills = { grey: L.C.grey, deep: L.C.greyDeep, light: "#B9BDC6", grad: grad(), grad2: grad(L.C.aiB, L.C.aiA), skin: "#D8B9A2", play: "#FFFFFFB3" };
    for (const [k, fill] of Object.entries(fills)) if (D[k]) await L.path(far, D[k], { name: `far ${k}`, fill });
    const bars = await L.path(far, D.bars, { name: "caption bars", fill: "#FFFFFF66" });
    const by = (await ac.layer.get({ id: bars })).transform.y;
    await L.keys(bars, "y", [[0, by, L.EASE.machine], [700, by - 9, L.EASE.machine], [1400, by]]);
    // 4 · The wall: 7×7 blocks, the live one in the middle, shifted half a tile so a tile centre is the wall's centre.
    const WW = BLOCKS * B + P;
    const wallComp = await L.part({ name: "05 · the wall", w: WW, h: WW, bg: L.C.ink, dur: T.dur, page });
    for (let i = 0; i < BLOCKS; i++) for (let j = 0; j < BLOCKS; j++) {
      const mid = i === 3 && j === 3;
      const id = (await ac.layer.create({ kind: "comp", sourceFrameId: mid ? near.id : far.id, ...L.span(wallComp, { x: (j - 3) * B + P / 2, y: (i - 3) * B + P / 2 }), name: mid ? "live block" : `far ${i}·${j}` })).id;
      if (!mid) await ac.layer.patch({ id, ops: [{ op: "set", path: "trimInMs", value: Math.round(L.rand() * 1400) }, { op: "set", path: "playback", value: { loop: "loop", loopLengthMs: 1399 } }] });
    }

    // 5 · Our tile: the hanging title card, as a crisp layer of its own.
    const ours = await L.part({ name: "05 · our tile", w: W, h: H, bg: L.C.paper, dur: T.dur, page });
    const card = await L.titleCard(ours, { pivot: [0, -220] });
    await L.line(ours, { x: 23, eyeY: -359, behind: card.group });

    // The camera rushes back: a log-scale zoom on the reversed zoom-in ease, sampled per frame.
    const ease = L.bezier(0.16, 1, 0.3, 1), z0 = fr(T.zoom), z1 = fr(T.zoomEnd);
    const sAt = (t) => Math.exp(Math.log(START) + (Math.log(FINAL) - Math.log(START)) * ease((t - z0) / (z1 - z0)));
    const wall = (await ac.layer.create({ kind: "comp", sourceFrameId: wallComp.id, ...L.span(f, { x: 0, y: 0 }), name: "The wall" })).id;
    const tile = (await ac.layer.create({ kind: "comp", sourceFrameId: ours.id, ...L.span(f, { x: 0, y: 0 }), name: "Our tile" })).id;
    const border = await L.rect(f, { name: "Our tile · clay hairline", width: W + 6, height: H + 6, cornerRadius: 0, fill: null, stroke: { paint: { type: "solid", color: L.C.clay }, width: 3, align: "outside" } });
    await L.keys(wall, "scale", [[0, START], ...L.sampled(z0, z1, sAt)], "comp");
    await L.keys(tile, "scale", [[0, START * TILE / W], ...L.sampled(z0, z1, (t) => sAt(t) * TILE / W)], "comp");
    await L.keys(border, "width", [[0, W + 6], ...L.sampled(z0, z1, (t) => sAt(t) * TILE + 6)], "comp");
    await L.keys(border, "height", [[0, H + 6], ...L.sampled(z0, z1, (t) => sAt(t) * TILE + 6)], "comp");
    // …then the whole feed keeps scrolling up, slowly, forever.
    const drift = (t) => -((t - z1) / 1000) * 16;
    for (const id of [wall, tile, border]) await L.keys(id, "y", [[0, 0], [z1, 0, "linear"], [T.dur, drift(T.dur)]], "comp");

    // 6 · The thumb: huge, hand-drawn, boiling; slides in, hovers, twitches, hides half behind the edge.
    const th = await L.thumb(f, { x: 250, y: 380, s: 2.4, name: "Thumb" });
    const thumb = await L.group(th.ids, "Thumb");
    const t0 = fr(T.thumb);
    const yk = [[0, 900], [t0, 900, L.EASE.out], [t0 + 650, 0]];
    const xk = [[0, 0]], rk = [[0, 0]];
    for (const tw of T.twitches) {
      const a = fr(tw);
      xk.push([a, 0, "ease-out"], [a + 70, -16, "ease-in-out"], [a + 160, 6, "ease-in-out"], [a + 260, 0]);
      rk.push([a, 0, "ease-out"], [a + 70, -2.5, "ease-in-out"], [a + 160, 1, "ease-in-out"], [a + 260, 0]);
      L.ev(a, "thumb-twitch");
    }
    yk.push([fr(T.hide), 0, "ease-in-out"], [fr(T.hide) + 420, 420]);
    await L.keys(thumb, "y", yk, "comp");
    await L.keys(thumb, "x", xk, "comp");
    await L.keys(thumb, "rotation", rk, "comp");

    // Sound: the zoom, the thumb, and the feed's babble — one logged phrase each, for one clip per phrase later.
    L.ev(z0, "zoom-out-whoosh", { peakMs: z0 + 500 });
    L.ev(z1, "crowd-swell", { untilMs: T.dur });
    L.ev(t0, "thumb-slide", { peakMs: t0 + 300 });
    L.ev(fr(T.hide), "thumb-duck");
    BABBLE.forEach((text, i) => L.ev(z0 + 250 + i * 760 + Math.round(L.rand() * 300), "babble", { text, pan: +(L.rand() * 1.6 - 0.8).toFixed(2), distance: +(0.3 + L.rand() * 0.7).toFixed(2) }));
  },
};
