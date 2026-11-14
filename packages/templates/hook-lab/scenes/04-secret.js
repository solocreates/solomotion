// 04 · THE SECRET — on 03's empty paper, an envelope slides in, stop
// motion at 12 fps, and lands with a slap. A blob of clay wax drops on the
// flap, squashes, and a stamp presses "12" into it. A pencil writes "open at
// 12" with an arrow. Then the envelope shrinks into the top-right corner and
// STAYS there: a promise you can see keeps nagging.

const W = 1080, H = 1080;
const DEFAULT = {
  dur: 7000,
  slide: 200,   // the envelope enters from the left…
  land: 700,    // …and slaps down
  wax: 900,     // the blob falls
  splat: 1000,  // lands and squashes
  stamp: 1300,  // "12" pressed in
  write: 1700,  // the pencil note (about two seconds, a human pace)
  park: 5000,   // shrink into the corner
};
const ENV = { x: 0, y: -130, w: 560, h: 374 };
const CORNER = { s: 0.3, x: 540 - 72 - 0.3 * 280, y: -540 + 72 + 0.3 * 187 }; // top-right, on the 72 px margin

return {
  meta: {
    no: "04", family: "Save it for later", name: "The Secret", film: true, heavy: false,
    why: "Something left unfinished keeps bugging people. If they can see it, they'll wait for it.",
    prompt: "A paper envelope slides onto warm paper in stop motion, 12 fps, and lands with a slap. A blob of clay-red wax drops on the flap, squashes, and a stamp presses '12' into it. A pencil writes 'open at 12' with an arrow. Then the envelope shrinks into the top-right corner and stays there. 7 s.",
    use: "You have a payoff at the end. Show the box now and open it later.",
    hint: "It only works if the thing stays in sight. Park it in a corner; don't let it vanish.",
    remix: ["A locked box with a timer.", "A covered painting under a sheet.", "A progress ring that only closes at the end."],
    tech: "stop motion at 12 fps · a squash on the wax · a 12 pressed into it · handwriting that draws itself · a prop that stays",
  },
  w: W, h: H, dur: DEFAULT.dur, bg: L.C.paper, seed: 404,
  async build(f, ctx = {}) {
    const T = { ...DEFAULT, ...(ctx.timing ?? {}) };
    const fr = L.frame;

    // The envelope and its seal, one paper object stepping at 12 fps.
    const env = await L.envelope(f, { ...ENV, name: "Envelope" });
    const wax = await L.waxSeal(f, { x: env.tip[0], y: env.tip[1] + 4, r: 56, startMs: fr(T.wax), name: "Wax" });
    const seal = await L.group(wax.ids, "Seal");
    const sealOrigin = await L.centreGroup(f, seal);
    const all = await L.group([...env.ids, seal], "Envelope (paper, 12 fps)");
    const o = await L.centreGroup(f, all);
    await ac.layer.patch({ id: all, ops: [{ op: "set", path: "fps", value: 12 }] });

    // Slide in from the left with a hand's jitter, land, settle.
    const xs = [[0, o[0] - 1020], [fr(T.slide), o[0] - 1020, L.EASE.out], [fr(T.land), o[0]]];
    const rot = [[0, -4]];
    for (let t = fr(T.slide); t < fr(T.land); t += 83) rot.push([t, -3 + L.jit(2.2)]);
    rot.push([fr(T.land), 1.2, "ease-out"], [fr(T.land) + 160, 0]);
    // …and park in the corner, where the films keep it.
    xs.push([fr(T.park), o[0], L.EASE.ui], [fr(T.park) + 700, CORNER.x]);
    await L.keys(all, "x", xs, "comp");
    await L.keys(all, "y", [[0, o[1]], [fr(T.park), o[1], L.EASE.ui], [fr(T.park) + 700, CORNER.y]], "comp");
    await L.keys(all, "scale", [[0, 1], [fr(T.park), 1, L.EASE.ui], [fr(T.park) + 700, CORNER.s]], "comp");
    await L.keys(all, "rotation", [...rot, [fr(T.park), 0, L.EASE.ui], [fr(T.park) + 350, -2, "ease-in-out"], [fr(T.park) + 700, 0]], "comp");

    // The wax: falls stretched, splats, recovers; then the stamp presses.
    const sy = sealOrigin[1] - o[1];
    await L.keys(seal, "y", [[fr(T.wax), sy - 320, "ease-in"], [fr(T.splat), sy]], "comp");
    await L.keys(seal, "scale", [[fr(T.wax), 0.86], [fr(T.splat), 1.32, "ease-out-back"], [fr(T.splat) + 250, 1], [fr(T.stamp), 1, "ease-out"], [fr(T.stamp) + 90, 1.06, "ease-out"], [fr(T.stamp) + 240, 1]], "comp");
    await L.keys(seal, "scaleY", [[fr(T.wax), 1.18], [fr(T.splat), 0.68, "ease-out-back"], [fr(T.splat) + 250, 1], [fr(T.stamp), 1, "ease-out"], [fr(T.stamp) + 90, 0.92, "ease-out"], [fr(T.stamp) + 240, 1]], "comp");
    for (const id of wax.ids.slice(1)) await L.keys(id, "opacity", L.steps([[0, 0], [fr(T.stamp) + 90, 1]]), "comp");

    // The pencil: "open at 12", then an arrow up to the seal. Graphite, boiling, written stroke by stroke.
    // There is no voice here: the seal and this note carry the hook alone, so the note is phone-sized
    // (x-height ≈ 56 px of 1080, ≈ 19 pt on a phone).
    const note = await L.pencil(f, "open at 12", { x: 0, y: ENV.y + ENV.h / 2 + 196, size: 128, startMs: fr(T.write), durMs: 2100, lift: 40, wordGap: 150, name: "Pencil · open at 12" });
    const a = [note.box.r - 70, note.box.t - 30], b = [env.tip[0] + 46, ENV.y + ENV.h / 2 + 26]; // from above the "12" up to just under the seal: it never crosses the paper
    const arrow = await L.pencil(f, { strokes: L.arrowStrokes(a, b, 0.22, 26) }, { startMs: fr(note.endMs + 200), durMs: 450, name: "Pencil · arrow" });
    for (const id of [note.id, arrow.id]) await L.keys(id, "opacity", [[fr(T.park) - 200, 1, "ease-in"], [fr(T.park) + 100, 0]], "comp");

    L.ev(T.slide, "paper-slide", { untilMs: T.land });
    L.ev(T.land, "paper-slap");
    L.ev(T.splat, "wax-plop");
    L.ev(T.stamp + 90, "stamp-thunk");
    L.ev(T.park, "shrink-whoosh", { peakMs: T.park + 350 });
    L.ev(T.park + 700, "settle-tap");
  },
};
