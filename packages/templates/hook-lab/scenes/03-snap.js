// 03 · THE SNAP — the card hangs; the line creaks and frays (it thins, fibres
// peel off, the eyes glance up at it), and on "second" it SNAPS: the card falls
// out of frame with real gravity, the stump of line sways. Empty paper. A beat
// later, a faraway crash, too late — and a little ink puff pops up from behind
// the bottom edge (and a smaller one on the bounce), so the joke reads muted.
//
// A joint can't break (FINDINGS A2), but a body leaves the simulation when its
// clip ends: the hanging assembly is pinned to a tiny invisible anchor whose
// clip ends on the snap frame. The stump is a twin: still until the snap, then
// an active body that enters swinging.

const W = 1080, H = 1080;
const DEFAULT = {
  dur: 4600,
  release: 450,  // the squint from 02 lets go…
  glance: 700,   // …and the eyes look up at the rope
  fray: 500,     // fibres start to peel, the line thins
  back: 1450,    // the eyes snap back to you
  snap: 1750,    // "…a second."
  crash: 3400,   // far away, too late
};
const PIVOT = [0, -220], LX = PIVOT[0] + 23, TOP = -H / 2 - 90, FY = -446; // FY: where the line gives

return {
  meta: {
    no: "03", family: "Say the opposite", name: "The Snap", film: true, heavy: true,
    why: "People guess where you're going. Go somewhere else and they lean back in.",
    prompt: "A card hangs from a line on warm paper. The line creaks and frays, fibres peeling off, and on the word 'second' it snaps: the card falls out of frame with real gravity and a little spin. Empty paper, the stump of line still swaying. A beat later, a faraway crash, too late, like a cartoon, and a little ink dust puff pops up from behind the bottom edge. 4.6 s.",
    use: "Your real point is the opposite of what the title makes people expect.",
    hint: "The late crash is what makes people smile. The laugh lives in the pause before the sound.",
    remix: ["A balloon string snaps instead.", "A \"BEST PRACTICE\" sign falls off its nail.", "The snap reverses: the card falls up."],
    tech: "a line that lets go when its anchor's clip ends · a stump that starts swinging on the snap · keyed thinning for the fray · a crash that comes late",
  },
  w: W, h: H, dur: DEFAULT.dur, bg: L.C.paper, seed: 303,
  async build(f, ctx = {}) {
    const T = { ...DEFAULT, ...(ctx.timing ?? {}) };
    const snap = L.frame(T.snap);
    const ink = (w, extra = {}) => ({ paint: { type: "solid", color: L.C.ink }, width: w, cap: "round", join: "round", ...extra });

    // The card and its eyes (still squinting from 02), on the lower line + hook.
    const card = await L.titleCard(f, { pivot: PIVOT });
    const eyes = await L.eyes(f, card.os, { kitPage: ctx.kitPage ?? ctx.page, origin: card.origin });
    await eyes.squint(0, 1, { from: 1, to: 1 });
    await eyes.squint(L.frame(T.release), 240, { from: 1, to: 0 });
    eyes.look(L.frame(T.glance), [0.45, -1], 300, 60);
    eyes.look(L.frame(T.back), [0, 0], 160, 0, "ease-out");
    await eyes.commit();
    const lower = await L.line(f, { x: LX, eyeY: PIVOT[1] - 139, top: FY, behind: card.group, name: "Line below" });
    const lst = await L.strokeId(lower.line);
    await L.set(lower.line, { [`stroke.${lst}.profile.startLength`]: 0.35 });
    await L.keys(lower.line, `stroke.${lst}.profile.startWidth`, [[T.fray, 0.7, "ease-in"], [snap, 0.2]], "comp");

    // Fibres peel off the break, stop-motion (12 fps steps), and fall with the card.
    const fibres = [];
    for (const [i, [dx, len, side]] of [[-1, 40, -1], [1, 34, 1], [0, 26, -1]].entries()) {
      const p0 = [LX + dx, FY + 4], p1 = [LX + dx + side * len * 0.55, FY + len * 0.6], p2 = [LX + dx + side * len, FY + len * 0.3];
      const d = `M${p0[0]} ${p0[1]}Q${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]}`;
      const bx = L.dBox(d);
      const id = await L.path(f, d, { name: `Fibre ${i + 1}`, fill: null, stroke: ink(2.4) });
      await L.set(id, { "anchor.x": (p0[0] - bx.l) / bx.w, "anchor.y": (p0[1] - bx.t) / bx.h, x: p0[0], y: p0[1] });
      const t0 = L.frame(T.fray + i * 330);
      const st = [[0, 0]];
      for (let k = 0; k <= 5; k++) st.push([t0 + k * 83, Math.min(1, (k + 1) / 5)]);
      await L.keys(id, "opacity", L.steps([[0, 0], [t0, 1]]), "comp");
      await L.keys(id, "rotation", L.steps(st.map(([t, u]) => [t, -side * 70 * (1 - u)])), "comp");
      fibres.push(id);
      L.ev(t0, "fibre");
    }

    // Everything below the break is ONE body, hung from an anchor that lives until the snap.
    const below = await L.group([lower.back, card.group, lower.line, lower.front, ...fibres], "Hanging");
    const origin = await L.centreGroup(f, below);
    const anchor = await L.ellipse(f, { name: "Break point (invisible)", width: 6, height: 6, fill: L.C.ink, x: LX, y: FY, durationMs: snap, set: { opacity: 0 } });
    await ac.physics.body({ ids: anchor, type: "passive" });
    await ac.physics.body({ ids: below, type: "active", damping: 0.2 });
    await ac.physics.joint({ id: below, add: [{ type: "pin", target: anchor, anchor: [LX - origin[0], FY - origin[1], 0], targetAnchor: [0, 0, 0] }] });

    // The stump: still, thinning at its end… then, from the snap, a body that swings.
    const stumpD = `M${LX} ${TOP}L${LX} ${FY}`;
    const stump = await L.path(f, stumpD, { name: "Line stump", fill: null, durationMs: snap, stroke: ink(4, { profile: { startWidth: 1, endWidth: 1, startLength: 0.2, endLength: 0.25, ease: 0 } }) });
    const sst = await L.strokeId(stump);
    await L.keys(stump, `stroke.${sst}.profile.endWidth`, [[T.fray, 1, "ease-in"], [snap, 0.2]], "comp");
    const swing = await L.path(f, stumpD, { name: "Line stump (swinging)", fill: null, startMs: snap, stroke: ink(4, { profile: { startWidth: 1, endWidth: 0.2, startLength: 0.2, endLength: 0.25, ease: 0 } }) });
    for (const id of [stump, swing]) await L.boil(id, { amount: 1.2, scale: 40, seed: 11 });
    await ac.physics.body({ ids: swing, type: "active", spin: [0, 0, -150], velocity: [0, -60, 0], damping: 0.35 });
    await ac.physics.joint({ id: swing, add: [{ type: "pin", target: null, anchor: [LX, TOP, 0], targetAnchor: [LX, TOP, 0] }] });

    await ac.physics.scene({ frameId: f.id, gravity: 4600, startMs: 0, floor: false, walls: false });

    // Sound: creaks rising in pitch, the snap on its frame, the fall, and the crash — late.
    L.ev(T.fray, "creak", { pitch: 0 });
    L.ev(T.fray + 650, "creak", { pitch: 1 });
    L.ev(snap, "snap");
    L.ev(snap + 60, "fall-whoosh", { peakMs: snap + 300 });
    L.ev(T.crash, "crash-far");
    L.ev(T.crash + 180, "bounce-far");
    // The joke has to read muted: a puff where it landed, then a smaller one on the bounce.
    const fell = (await ac.physics.inspect({ frameId: f.id, atMs: snap + 700 })).bodies.find((b) => b.id === below)?.at?.x ?? 0;
    await L.puffAt(f, Math.max(-260, Math.min(260, fell)), H / 2, L.frame(T.crash), 1.7, ctx.kitPage ?? ctx.page);
    await L.puffAt(f, Math.max(-260, Math.min(260, fell)) + 230, H / 2, L.frame(T.crash + 180), 0.75, ctx.kitPage ?? ctx.page);
  },
};
