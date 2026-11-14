// 07 · THE STORY — the pencil dot from 06 draws out into a line; four story
// cards clip onto it. The links between them say "and then", the line sags like
// wet laundry and the thumb at the bottom drifts away, bored. The links rewrite
// themselves in clay to "but" and "so", the line snaps taut, and the cards
// swing up in a wave. The thumb freezes. Then: A hook stops the thumb. / A story
// keeps it still.
//
// Real physics, one source of truth: four invisible hangers (animated bodies)
// move on curves sampled here; each card is an active body pinned to one, so
// the swing is the simulation's. The drawn line and the link words are sampled
// from the SAME curves, so nothing ever slips off the line.

const W = 1080, H = 1080;
const DEFAULT = {
  dur: 20000,
  draw: 300,        // the dot draws out into the line
  cards: 1300,      // the cards drop on, one after another
  sag: 4500,        // the line starts to sag…
  sagged: 6600,     // …limp: two full seconds of boredom from here
  drift: 6600,      // the thumb starts drifting off
  rewrite: [8800, 9500, 10100], // "and then" → but · so · so
  taut: 10600,      // the line snaps taut, left to right
  line1: 12600,     // A hook stops the thumb.
  line2: 14500,     // A story keeps it still.
};
const Y0 = -290;                       // the taut line
const UP = 600;                        // hangers live this far above the line
const XS = [-351, -117, 117, 351];     // hangers
const SAG = [70, 118, 118, 70];        // how far each hanger sinks
const BEATS = ["you post\na video", "nobody\nwatches", "you fix\nthe opening", "they\nstay"];
const LINKS = ["but", "so", "so"];

return {
  meta: {
    no: "07", family: "Tell a story", name: "The Story", film: true, heavy: true,
    why: "People stay to find out what happens next. A list gives them nothing to wait for.",
    prompt: "Four story cards hang from a line whose links say 'and then'. The line sags like wet laundry and a hand-drawn thumb at the bottom edge drifts away, bored. The links rewrite themselves in clay to 'but' and 'so', the line snaps taut and the cards swing up in a wave. The thumb freezes. Then the line 'A hook stops the thumb. A story keeps it still.' 20 s.",
    use: "You're teaching how to structure a video, or anywhere your script reads like a list.",
    hint: "Let the sag be boring for two full seconds. The relief only works after the boredom.",
    remix: ["Train carriages that only couple on 'but'.", "Dominoes that only fall when they're linked by 'because'.", "A map whose roads only open on 'so'."],
    tech: "cards pinned to moving hangers (physics) · the line and its words sampled from the same curves · a staggered snap for the wave · text that types out and back in · the thumb from 05",
  },
  w: W, h: H, dur: DEFAULT.dur, bg: L.C.paper, seed: 707,
  async build(f, ctx = {}) {
    const T = { ...DEFAULT, ...(ctx.timing ?? {}) };
    const fr = L.frame, ink = (w, extra = {}) => ({ paint: { type: "solid", color: L.C.ink }, width: w, cap: "round", join: "round", ...extra });
    const sm = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
    const back = L.bezier(0.34, 1.56, 0.64, 1); // the snap overshoots, once

    // Where hanger i is at time t: taut → sag (slow) → taut again (fast, left to right).
    const hy = (i, t) => {
      const s = sm((t - T.sag) / (T.sagged - T.sag));
      const tt = T.taut + i * 60, k = t < tt ? 0 : back(Math.min(1, (t - tt) / 260));
      return Y0 + SAG[i] * s * (1 - k);
    };
    // As the line straightens it tugs each hanger sideways for an instant, left to right: the cards swing.
    const hx = (i, t = 0) => { const u = (t - (T.taut + i * 60)) / 320; return XS[i] + (u > 0 && u < 1 ? 34 * Math.sin(Math.PI * u) : 0); };
    const chainD = (t) => L.smooth([[-620, Y0 - 30], ...XS.map((_, i) => [hx(i, t), hy(i, t)]), [620, Y0 - 30]]);
    // Sample only where things move; hold elsewhere.
    const spans = [[T.sag, T.sagged], [T.taut, T.taut + 560]];
    const sampleAll = (fn) => { const k = [[0, fn(0), "linear"]]; for (const [a, b] of spans) k.push([fr(a) - 1, fn(a - 1), "linear"], ...L.sampled(fr(a), fr(b), fn, 2 * L.FRAME)); return k; };

    // 1 · The line, drawn out from the centre dot.
    const chain = await L.path(f, chainD(0), { name: "The line", fill: null, stroke: ink(5, { profile: { startWidth: 1, endWidth: 1, startLength: 0.5, endLength: 0.5, ease: 0 } }) });
    await L.boil(chain, { amount: 1.2, scale: 40 });
    const cst = await L.strokeId(chain);
    await L.keys(chain, `stroke.${cst}.trim.start`, [[fr(T.draw), 0.5, L.EASE.out], [fr(T.draw) + 900, 0]], "comp");
    await L.keys(chain, `stroke.${cst}.trim.end`, [[fr(T.draw), 0.5, L.EASE.out], [fr(T.draw) + 900, 1]], "comp");
    await ac.keyframes.set({ id: chain, property: "geometry", keys: sampleAll((t) => chainD(t)).map(([at, value]) => ({ at, value, easing: "linear" })), clock: "comp" });
    const dot = await L.ellipse(f, { name: "Pencil dot (from 06)", width: 34, height: 31, fill: "#2B2925", durationMs: fr(T.draw) + 120 });
    await L.keys(dot, "scale", [[fr(T.draw), 1, "ease-in"], [fr(T.draw) + 120, 0.2]], "comp");
    L.ev(fr(T.draw), "pen", { lengthPx: 1240, durMs: 900, speed: 1380 });

    // 2 · Hangers: invisible animated bodies on the curves.
    const hangers = [];
    for (let i = 0; i < 4; i++) {
      // parked 600 px above the frame: a hanger inside the card's clip would shove its collider
      const id = await L.ellipse(f, { name: `Hanger ${i + 1} (invisible)`, width: 6, height: 6, fill: L.C.ink, x: XS[i], y: Y0 - UP, set: { opacity: 0 } });
      await L.keys(id, "x", sampleAll((t) => hx(i, t)), "comp");
      await L.keys(id, "y", sampleAll((t) => hy(i, t) - UP), "comp");
      await ac.physics.body({ ids: id, type: "animated" });
      hangers.push(id);
    }

    // 3 · The cards: paper, a little ink clip at the top, a number and a beat. Each a body pinned at its clip.
    const CW = 176, CH = 236, CLIP = 20; // 58 px between cards: room to swing without leaning on a neighbour
    for (const [i, beat] of BEATS.entries()) {
      const x = XS[i], top = Y0 + CLIP;
      const paper = await L.rect(f, { name: `Card ${i + 1} · paper`, width: CW, height: CH, cornerRadius: 10, fill: L.C.paperDeep, stroke: { paint: { type: "solid", color: "#D3CAB9" }, width: 2, align: "inside" }, x, y: top + CH / 2 });
      const clip = await L.path(f, `M${x - 7} ${Y0 + 2}L${x - 7} ${top + 22}Q${x - 7} ${top + 28} ${x} ${top + 28}Q${x + 7} ${top + 28} ${x + 7} ${top + 22}L${x + 7} ${Y0 + 8}Q${x + 7} ${Y0} ${x} ${Y0}Q${x - 4} ${Y0} ${x - 6} ${Y0 + 4}`, { name: `Card ${i + 1} · clip`, fill: null, stroke: ink(3.5) });
      await L.boil(clip, { amount: 0.8, scale: 20 });
      const no = await L.text(f, `0${i + 1}`, { name: `Card ${i + 1} · no.`, style: { fontFamily: L.F.mono, fontSize: 16, fontWeight: 600, letterSpacing: 2, color: L.C.graphite, lineHeight: 1.2 } });
      const nb = await L.box(no);
      await L.pos(no, x, top + 52 + nb.height / 2);
      const tx = await L.text(f, beat, { name: `Card ${i + 1} · beat`, style: { fontFamily: L.F.sans, fontSize: 26, fontWeight: 600, color: L.C.ink, lineHeight: 1.18, align: "center" } });
      const tb = await L.box(tx);
      await L.pos(tx, x, top + 52 + nb.height + 18 + tb.height / 2);
      const g = await L.group([paper, clip, no, tx], `Card ${i + 1}`);
      const o = await L.centreGroup(f, g);
      // drop on from above, landing on the line (keys), before physics takes over
      const t0 = fr(T.cards + i * 260);
      await L.keys(g, "y", [[0, o[1] - 900], [t0, o[1] - 900, "ease-in"], [t0 + 330, o[1]]], "comp");
      await ac.physics.body({ ids: g, type: "active", damping: 0.35 });
      await ac.physics.joint({ id: g, add: [{ type: "pin", target: hangers[i], anchor: [x - o[0], Y0 - o[1], 0], targetAnchor: [0, UP, 0], damping: 0.4 }] });
      L.ev(t0 + 330, "card-clip");
    }
    await ac.physics.scene({ frameId: f.id, gravity: 6000, startMs: fr(T.cards + 3 * 260 + 360), floor: false, walls: false });

    // 4 · The links: "and then" between the cards, riding the line; rewritten in clay.
    for (let i = 0; i < 3; i++) {
      // the drawn curve's own midpoint and slope between hangers i and i+1 (Catmull-Rom at u = ½)
      const pts = (t) => [[-620, Y0 - 30], ...XS.map((_, j) => [hx(j, t), hy(j, t)]), [620, Y0 - 30]];
      const seg = (t) => { const P = pts(t); return [P[i], P[i + 1], P[i + 2], P[i + 3]]; };
      const mid = (t) => { const [a, b, c, d] = seg(t); return [0, 1].map((k) => (-a[k] + 9 * b[k] + 9 * c[k] - d[k]) / 16); };
      const ang = (t) => { const [a, b, c, d] = seg(t); const v = [0, 1].map((k) => 0.75 * (c[k] + (c[k] - (d[k] - b[k]) / 6) - (b[k] + (c[k] - a[k]) / 6) - b[k])); return (Math.atan2(v[1], v[0]) * 180) / Math.PI; };
      const rw = fr(T.rewrite[i]);
      const show = fr(T.draw + 700 + i * 120);
      const old = await L.text(f, "and then", { name: `Link ${i + 1} · and then`, startMs: show, durationMs: rw + 280 - show, style: { fontFamily: L.F.mono, fontSize: 26, fontWeight: 500, color: L.C.graphite, lineHeight: 1.2 } });
      const neu = await L.text(f, LINKS[i], { name: `Link ${i + 1} · ${LINKS[i]}`, startMs: rw + 280, style: { fontFamily: L.F.mono, fontSize: 36, fontWeight: 700, color: L.C.clay, lineHeight: 1.2 } });
      for (const id of [old, neu]) {
        const b = await L.box(id);
        const lift = -b.height / 2 - 12; // sits just above the line
        await L.keys(id, "x", sampleAll((t) => mid(t)[0]), "comp");
        await L.keys(id, "y", sampleAll((t) => mid(t)[1] + lift), "comp");
        await L.keys(id, "rotation", sampleAll(ang), "comp");
      }
      await ac.animation.set({ id: old, slot: "out", preset: "typewriter", durationMs: 280 });
      await ac.animation.set({ id: neu, slot: "in", preset: "typewriter", durationMs: 200 });
      L.ev(rw + 280, "link-ting", { word: LINKS[i] });
    }

    // 5 · The thumb (from 05): at the bottom edge, drifting off bored… frozen on the snap.
    const th = await L.thumb(f, { x: 330, y: 560, s: 1.25, name: "Thumb" });
    const thumb = await L.group(th.ids, "Thumb");
    const d0 = fr(T.drift), d1 = fr(T.taut);
    await L.keys(thumb, "x", [[0, 0], [d0, 0, "ease-in"], [d1, 95]], "comp");
    await L.keys(thumb, "rotation", [[0, 0], [d0, 0, "ease-in"], [d1, 7]], "comp");
    await L.keys(thumb, "y", [[0, 0], [d1, 0, "ease-out"], [d1 + 90, -16, "ease-in-out"], [d1 + 260, 0]], "comp");

    // 6 · The thesis, as designed type (no caption under it).
    const l1 = await L.text(f, "A hook stops the thumb.", { name: "Thesis 1", startMs: fr(T.line1), style: { fontFamily: L.F.serif, fontSize: 60, fontWeight: 600, color: L.C.ink, lineHeight: 1.1, letterSpacing: -1 } });
    const l2 = await L.text(f, "A story keeps it still.", { name: "Thesis 2", startMs: fr(T.line2), style: { fontFamily: L.F.serif, fontSize: 60, fontWeight: 600, italic: true, color: L.C.ink, lineHeight: 1.1, letterSpacing: -1 } });
    const b1 = await L.box(l1), b2 = await L.box(l2);
    const top = 150; // below the lowest card swing, above the thumb's tip
    await L.pos(l1, -540 + 72 + b1.width / 2, top + b1.height / 2);
    await L.pos(l2, -540 + 72 + b2.width / 2, top + b1.height + 14 + b2.height / 2);
    for (const id of [l1, l2]) await ac.animation.set({ id, slot: "in", preset: "fade-up", unit: "word", staggerMs: 70, durationMs: 520 });

    L.ev(T.sag, "rope-groan", { untilMs: T.sagged });
    L.ev(T.sagged + 600, "slide-whistle-down", { soft: true });
    L.ev(T.taut, "taut-thwack");
    L.ev(T.drift, "thumb-drift", { untilMs: T.taut });
    L.ev(T.line1, "motif-in");
  },
};
