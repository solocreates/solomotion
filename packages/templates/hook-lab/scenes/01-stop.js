// 01 · THE STOP — a feed is flying; a hook drops in, catches one card,
// and EVERYTHING stops on one frame. Then the card swings on the hook (real
// physics) and settles.
//
// The stop is the hook, not the swing: the feed's keys and the card's keys end
// on the same frame, the motion blur dies with them, and physics only takes
// the card one millisecond later — so nothing drifts through the stop.

const W = 1080, H = 1080;
const DEFAULT = {
  dur: 4500,
  drop: 450,      // the line and hook fall in from above
  stop: 600,      // the catch: one frame, everything (frame 18 at 30 fps)
  dissolve: 200,  // the frozen feed turns to paper in 6 frames
  speed: 5200,    // px/s of the feed before the stop
};
const PIVOT = [0, -220]; // where the card's hole rests on the hook

return {
  meta: {
    no: "01", family: "Stop the scroll", name: "The Stop", film: true, heavy: true,
    why: "The feed has a rhythm, and people only notice when it breaks. Something stopping is louder than something moving.",
    prompt: "A 1080×1080 hook. Frame 0 is already moving: a column of blurred video tiles, grey and glossy-gradient, scrolls up fast. An ink line drops from the top with a fishing hook on its end, snags the next card, and everything stops on one frame with a metal clunk. The card swings on the hook and settles. On it: '12' in clay over 'HOOKS' in Fraunces 800 (SOFT 100) and 'that keep people watching' in italic. Warm paper, ink, one clay accent. The ink line boils at 12 fps; the machine tiles never boil. 4.5 s.",
    use: "Your first frame has to fight a scroll (every Short).",
    hint: "The stop is the hook, not the swing. Land it on a single frame, with the sound on that frame.",
    remix: ["The hook catches your product instead of a card.", "A pin stabs a tile to a corkboard instead of a hook.", "No hook at all: the scroll stops because a cat sits on the screen."],
    tech: "keys that end on one frame · motion blur that dies on the stop · a card hung on a pin (physics) · only the hand-drawn line boils",
  },
  w: W, h: H, dur: DEFAULT.dur, bg: L.C.paper, seed: 101,
  async build(f, ctx = {}) {
    const T = { ...DEFAULT, ...(ctx.timing ?? {}) };
    const stop = L.frame(T.stop), drop = L.frame(T.drop);
    const travel = (T.speed * stop) / 1000;
    // The shutter looks FORWARD (phase 0): frame 0 is already streaking, and the stop frame is sharp.
    await ac.frame.update({ id: f.id, ops: [{ op: "set", path: "motionBlur", value: { enabled: true, shutterAngle: 150, shutterPhase: 0, maxSamples: 24 } }] });

    // The feed (machine: perfect, linear, blurred), then the card on top of it.
    // Every layer is keyed itself: motion blur follows a layer's own motion
    // (a keyed group moves its children unblurred, FINDINGS A9).
    const pitch = L.CARD.size + 48, cardCy = PIVOT[1] - 5 - L.CARD.margin + L.CARD.size / 2; // as titleCard lays it out
    const fly = async (ids) => { for (const id of ids) { const y = (await ac.layer.get({ id })).transform.y; await L.keys(id, "y", [[0, y + travel, "linear"], [stop, y]], "comp"); } };
    const tiles = [];
    for (const k of [7, 6, 5, 4, 3, 2, 1, -1]) tiles.push(...(await L.feedTile(f, { name: `Feed ${k}`, size: L.CARD.size, x: 0, y: cardCy - k * pitch, ai: k % 2 === 0 })).ids);
    await fly(tiles);
    for (const id of tiles) await L.keys(id, "opacity", [[stop, 1, "ease-in"], [stop + T.dissolve, 0]], "comp");
    const card = await L.titleCard(f, { pivot: PIVOT });
    await fly(card.ids);

    // The line drops in, accelerating, and arrives on the same frame.
    const ln = await L.line(f, { x: PIVOT[0] + 23, eyeY: PIVOT[1] - 139, behind: card.group });
    for (const id of ln.ids) {
      const y = (await ac.layer.get({ id })).transform.y;
      await L.keys(id, "y", [[0, y - 340], [drop, y - 340, "ease-in"], [stop, y]], "comp");
    }

    // The catch: the card hangs on its hole from the hook and swings. Its keys
    // stop at `stop`; physics owns it from the next millisecond.
    await ac.physics.body({ ids: card.group, type: "active", velocity: [420, 0, 0], spin: [0, 0, 14], damping: 0.9 });
    await ac.physics.joint({ id: card.group, add: [{ type: "pin", target: null, anchor: [PIVOT[0] - card.origin[0], PIVOT[1] - card.origin[1], 0], targetAnchor: [PIVOT[0], PIVOT[1], 0], damping: 0.6 }] });
    await ac.physics.scene({ frameId: f.id, gravity: 9000, startMs: stop + 1, floor: false, walls: false });

    // Sound: the stream, the clink + CLUNK on the stop frame, a creak at every turn of the swing.
    L.ev(0, "feed-stream", { untilMs: stop, rising: true });
    L.ev(drop, "line-drop", { peakMs: stop - 40 });
    L.ev(stop, "clink");
    L.ev(stop, "clunk");
    let prev = null, dir = 0;
    for (let t = stop + 33; t < T.dur; t += 33) {
      const b = (await ac.physics.inspect({ frameId: f.id, atMs: t })).bodies.find((x) => x.id === card.group);
      const r = b?.at?.rotation ?? 0;
      if (prev != null) {
        const d = Math.sign(r - prev);
        if (d && dir && d !== dir && Math.abs(prev) > 0.6) L.ev(t - 33, "creak", { deg: +prev.toFixed(1) });
        if (d) dir = d;
      }
      prev = r;
    }
  },
};
