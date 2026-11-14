// 02 · FONT ROULETTE — picking a font, the honest version.
//
// Every face is its own text layer on a hard cut (no fades: a slot machine
// doesn't dissolve). The cuts start at two frames and stretch out like a wheel
// losing speed; each face is sized from its MEASURED width so the word never
// jumps in size, only in character.

const DUR = 6000, FPS_MS = 1000 / 30;
const WORD = "this one.";
const FACES = [
  ["Anton", 400, false], ["Pacifico", 400, false], ["Press Start 2P", 400, false], ["Playfair Display", 900, true],
  ["Bungee", 400, false], ["Monoton", 400, false], ["Caveat", 700, false], ["UnifrakturMaguntia", 400, false],
  ["Rubik Mono One", 400, false], ["Abril Fatface", 400, false], ["Righteous", 400, false], ["Space Mono", 700, false],
];
const LAND = ["Instrument Serif", 400, true];
const INK = "#1B1A17", TARGET_W = 760;

return {
  meta: {
    no: "02", family: "Type", name: "Font Roulette",
    line: "One phrase spins through twelve faces like a slot machine and lands on the right one.",
    prompt: "Picking a font, as a slot machine: the words 'this one.' cycle through twelve wildly different typefaces on hard cuts — fast at first, slowing like a wheel, each face's name ticking under it in mono — and land on Instrument Serif italic in clay. The kicker changes from 'picking a font…' to 'picked.'. Ink ground. 6 s.",
    remix: ["Use your brand name and land on your brand font.", "Spin colours instead of fonts and land on your accent.", "Add a tick sound per cut, pitched down as it slows."],
    tech: "hard-cut layers on a decelerating schedule · font size from measured width · kicker swap",
  },
  w: 1080, h: 1080, dur: DUR, bg: INK,
  async build(f) {
    // The schedule, in whole frames: each cut lasts ×1.16 longer than the last.
    const ms = (fr) => Math.ceil((fr * 1000) / 30);
    const cuts = [];
    let fr = 9, d = 2, i = 0;
    while (fr < 100) {
      const n = Math.max(2, Math.round(d));
      cuts.push([ms(fr), ms(fr + n) - ms(fr), FACES[i % FACES.length]]);
      fr += n; d *= 1.16; i++;
    }
    const landAt = ms(fr);
    // Make every face first, THEN size them: a web font measures as its
    // fallback until it has loaded, so wait for the faces before measuring.
    const made = [];
    const make = async (s, family, weight, italic, o) => {
      const id = await L.text(f, s, { ...o, style: { fontFamily: family, fontWeight: weight, italic, fontSize: 200, color: L.C.ivory, ...o.style } });
      made.push(id);
      return id;
    };
    for (const [k, [at, dur, [family, weight, italic]]] of cuts.entries()) {
      await make(WORD, family, weight, italic, { name: `${k + 1} · ${family}`, startMs: at, durationMs: dur, y: -10 });
      await L.text(f, family, { name: `${k + 1} · label`, startMs: at, durationMs: dur, y: 200, style: { fontFamily: L.F.mono, fontSize: 24, color: L.C.mute, letterSpacing: 1 } });
    }
    const land = await make(WORD, LAND[0], LAND[1], LAND[2], { name: "Landed · Instrument Serif", startMs: landAt, y: -10, style: { color: L.C.clay } });
    for (const id of made) {
      const b = await L.box(id);
      await L.set(id, { fontSize: Math.min(200 * (TARGET_W / b.width), 260) });
    }
    await L.keys(land, "scale", [[0, 1.08, L.EASE.out], [450, 1]]);
    await L.text(f, "Instrument Serif, italic", { name: "Landed · label", startMs: landAt, y: 200, style: { fontFamily: L.F.mono, fontSize: 24, color: L.C.oat, letterSpacing: 1 } });
    const ul = await L.path(f, "M-260 0 C -120 10 120 -8 260 2", { name: "Underline", startMs: landAt + 250, stroke: { color: L.C.clay, width: 6, cap: "round" }, fill: null, y: 130 });
    await ac.animation.set({ id: ul, slot: "in", preset: "draw", durationMs: 500 });
    // The kicker.
    const k1 = await L.text(f, "PICKING A FONT…", { name: "Kicker", durationMs: landAt, y: -330, style: { fontFamily: L.F.mono, fontSize: 24, letterSpacing: 4, color: L.C.mute, fontWeight: 600 } });
    const k2 = await L.text(f, "PICKED.", { name: "Kicker · picked", startMs: landAt, y: -330, style: { fontFamily: L.F.mono, fontSize: 24, letterSpacing: 4, color: L.C.clay, fontWeight: 600 } });
    await ac.expression.set({ id: k1, property: "opacity", source: "0.55 + 0.45 * mod(floor(#time * 3), 2)" });
    console.log(`${cuts.length} cuts, lands at ${Math.round(landAt)} ms`);
  },
};
