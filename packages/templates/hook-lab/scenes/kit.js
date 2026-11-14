// KIT — every object the hooks are told with, built once from lib.js and
// labelled: what it is and how it moves. Human things (ink, pencil, the thumb)
// boil at 12 fps; machine things (the cursor) glide. Copy any of them into
// your own hook, or call the same lib.js function from a script.

const W = 1920, H = 1080, DUR = 6000;
const COLS = [-720, -240, 240, 720], ROWS = [-270, 250];

return {
  async build(page) {
    const f = await L.comp({ name: "Kit · the objects", w: W, h: H, bg: L.C.paper, dur: DUR, page, x: 0, y: 0 });
    L.setHook("kit");
    const label = async (cx, cy, title, how) => {
      const t = await L.text(f, title, { name: `Label · ${title}`, style: { fontFamily: L.F.mono, fontSize: 18, fontWeight: 600, letterSpacing: 2.5, color: L.C.ink, lineHeight: 1.2 } });
      const h = await L.text(f, how, { name: `How · ${title}`, maxWidth: 400, style: { fontFamily: L.F.sans, fontSize: 18, color: L.C.graphite, lineHeight: 1.4, align: "center" } });
      const tb = await L.box(t), hb = await L.box(h);
      const top = cy + (cy < 0 ? 150 : 120);
      await L.pos(t, cx, top + tb.height / 2);
      await L.pos(h, cx, top + tb.height + 8 + hb.height / 2);
    };
    // Hairlines between the cells, so each object owns its square.
    for (const x of [-480, 0, 480]) await L.rect(f, { name: "Rule", width: 1.5, height: H - 144, fill: "#DDD4C3", x, y: 0 });
    await L.rect(f, { name: "Rule", width: W - 144, height: 1.5, fill: "#DDD4C3", x: 0, y: 20 });

    // 1 · the hook on a line
    await L.line(f, { x: COLS[0] + 23, eyeY: ROWS[0] - 40, top: -H / 2 - 40, name: "Kit line" });
    await label(COLS[0], ROWS[0], "LINE + HOOK", "line(): an ink stroke with a taper and a hook, split front and back so a card hangs through it. Boils.");

    // 2 · eyes in any O
    const look = await L.hero(f, "LOOK", { size: 150, x: COLS[1], y: ROWS[0] - 10, split: "O", name: "Kit LOOK" });
    const eyes = await L.eyes(f, look.parts.filter((p) => p.ch === "O"), { kitPage: page, name: "Kit eyes" });
    eyes.appear(300, [0, -1]);
    eyes.look(500, [-1, 0], 400, 100);
    eyes.look(1500, [1, 0], 500, 100);
    eyes.look(2600, [0, 0], 400, 100);
    await eyes.blink(3200);
    await eyes.squint(4300, 280);
    await eyes.commit();
    await label(COLS[1], ROWS[0], "EYES", "eyes(): pupils under any O, a 12 fps flipbook blink, a shape-key squint, the second eye late.");

    // 3 · the envelope and its seal
    const env = await L.envelope(f, { x: COLS[2], y: ROWS[0] - 20, w: 330, h: 220, name: "Kit envelope" });
    await L.waxSeal(f, { x: env.tip[0], y: env.tip[1] + 2, r: 34, name: "Kit wax" });
    await label(COLS[2], ROWS[0], "ENVELOPE + SEAL", "envelope() and waxSeal(): paper-cut folds, no shadows; clay wax with a debossed 12.");

    // 4 · the thumb
    await L.thumb(f, { x: COLS[3], y: ROWS[0] - 30, s: 0.62, name: "Kit thumb" });
    await label(COLS[3], ROWS[0], "THUMB", "thumb(): the judge. Hand-drawn ink and a nail; it boils.");

    // 5 · the counter
    await L.counter(f, { x: COLS[0], y: ROWS[1] - 50, size: 150, from: 1, to: 3, at: 1200, label: "HOOK", name: "Kit counter" });
    await label(COLS[0], ROWS[1], "COUNTER", "counter(): clay figures that roll up inside a mask. Everyone wants to see it reach 12.");

    // 6 · the pencil
    await L.pencil(f, "every word", { x: COLS[1], y: ROWS[1] - 90, size: 52, startMs: 600, durMs: 1200, name: "Kit pencil" });
    await L.pencil(f, "carefully", { x: COLS[1], y: ROWS[1] + 10, size: 52, startMs: 2000, durMs: 1100, name: "Kit pencil 2" });
    await label(COLS[1], ROWS[1], "PENCIL", "pencil(): single-line script written on stroke by stroke (Draw On), graphite, boiling.");

    // 7 · the cursor (a machine: it glides)
    const cur = await L.cursor(f, { x: COLS[2] - 60, y: ROWS[1] - 90, name: "Kit cursor" });
    await L.keys(cur.group, "x", [[800, 0, L.EASE.ui], [1700, 110], [3000, 110, L.EASE.ui], [3900, 0]], "comp");
    await L.keys(cur.group, "y", [[800, 0, L.EASE.ui], [1700, 40], [3000, 40, L.EASE.ui], [3900, 0]], "comp");
    await label(COLS[2], ROWS[1], "CURSOR", "cursor(): an arrow with a name tag that rides along. Machine things glide on perfect eases.");

    // 8 · the palette, as chips measured from their words
    const sw = [["PAPER", L.C.paper, L.C.ink], ["INK", L.C.ink, L.C.paper], ["CLAY", L.C.clay, L.C.paper], ["HONEY", L.C.honey, L.C.ink], ["MACHINE", L.C.grey, L.C.ink]];
    for (const [i, [n, bg, fg]] of sw.entries()) {
      const id = await L.text(f, n, { name: `Swatch · ${n}`, style: { fontFamily: L.F.mono, fontSize: 16, fontWeight: 700, letterSpacing: 2, color: fg, lineHeight: 1.2, highlight: { color: bg, radius: 6, paddingX: 12, paddingY: 8 } } });
      const b = await L.box(id);
      await L.pos(id, COLS[3], ROWS[1] - 150 + i * 44 + b.height / 2);
      if (n === "PAPER") await ac.layer.patch({ id, ops: [{ op: "merge", path: "style.highlight", value: { color: "#FBF8F2" } }] });
    }
    await label(COLS[3], ROWS[1], "INK & CLAY", "Paper and ink are human; grey glass is the machine. Clay once per frame, at most.");
    return f.id;
  },
};
