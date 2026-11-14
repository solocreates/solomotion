// 08 · THE RECEIPT — a little thermal printer pops up and prints, line by line
// as the voice counts them: CASHIER: CLAUDE · 1× TRICK · 1× PROMISE · 1× TRUTH
// · 1× RULE YOU CAN USE TODAY · TOTAL: 4 REASONS TO STAY · 0× ADS · NO REFUNDS.
// Then it's torn off and the end curls.
//
// The receipt is printed paper inside a mask that starts at the slot: it feeds
// down in mechanical steps (move, pause, move), so each line appears exactly as
// it passes the slot. One chatter burst per line, never a loop.

const W = 1080, H = 1080;
const LINES = [
  // [text, at (ms), style]
  ["HOOK LAB", 1000, "head"],
  ["CASHIER: CLAUDE", 3200, ""],
  ["– – – – – – – – – – – –", 6600, "rule"],
  ["1×  TRICK", 9800, ""],
  ["1×  PROMISE", 10800, ""],
  ["1×  TRUTH", 11800, ""],
  ["1×  RULE YOU CAN USE TODAY", 12900, ""],
  ["– – – – – – – – – – – –", 14200, "rule"],
  ["TOTAL: 4 REASONS TO STAY", 14600, "total"],
  ["0× ADS · NO REFUNDS", 15600, ""],
  ["THANK YOU FOR STAYING", 16300, "small"],
];
const DEFAULT = { dur: 18000, pop: 400, tail: 16900, tear: 17400, lines: LINES.map((l) => l[1]) };
const PW = 560, LH = 54, TOP = 34, SLOT = 330; // the printer's slot, near the bottom

return {
  meta: {
    no: "08", family: "Give them something", name: "The Receipt", film: true, heavy: false,
    why: "People stay for what they get. When you count it out loud, it feels real.",
    prompt: "A tiny receipt printer prints a thermal receipt line by line, in rhythm: 'CASHIER: CLAUDE', '1× TRICK', '1× PROMISE', '1× TRUTH', '1× RULE YOU CAN USE TODAY', 'TOTAL: 4 REASONS TO STAY', '0× ADS · NO REFUNDS'. Each line lands as it's said. It's torn off and the end curls. Mono type, warm paper. 18 s.",
    use: "Halfway through, to remind people what they've already got. It's why they stay for the rest.",
    hint: "One joke line per receipt (\"NO REFUNDS\"). Two and it turns into a bit instead of a payoff.",
    remix: ["A loot screen in a game.", "A petrol-pump counter of \"value\" ticking up.", "A parking ticket for wasting someone's time."],
    tech: "stepped keys for a printer's rhythm · paper revealed through a slot (a mask) · a torn edge and a curl (a shape morph) · sound in bursts, not loops",
  },
  w: W, h: H, dur: DEFAULT.dur, bg: L.C.paper, seed: 808,
  async build(f, ctx = {}) {
    const T = { ...DEFAULT, ...(ctx.timing ?? {}) };
    const fr = L.frame, at = (i) => fr(T.lines[i] ?? LINES[i][1]);

    // 1 · The receipt: paper (its tail torn later) + its printed lines, laid out from measured boxes.
    //     The printer sits at the bottom; the paper rises out of its slot, header first.
    const len = TOP + LINES.length * LH + 64; // printed lines + a blank tail
    const x0 = -PW / 2, y0 = SLOT;              // the paper's top edge, still inside the printer
    let teeth = "";
    for (let i = 18; i >= 0; i--) teeth += `L${x0 + (PW * i) / 18} ${y0 + len - (i % 2 ? 7 : 0)}`;
    // the free top end curls back once it's torn off: its corners lift toward the middle
    const paperD = (curl) => `M${x0} ${y0 + curl * 24}C${x0 + PW * 0.28} ${y0 + curl * 2} ${x0 + PW * 0.72} ${y0 + curl * 2} ${x0 + PW} ${y0 + curl * 24}L${x0 + PW} ${y0 + len}${teeth}Z`;
    const paper = await L.path(f, paperD(0), { name: "Receipt · paper", fill: "#FBF9F4", stroke: { paint: { type: "solid", color: "#DDD5C6" }, width: 1.5, join: "round" } });
    const ids = [paper];
    for (const [i, [text, , kind]] of LINES.entries()) {
      const st = { fontFamily: L.F.mono, fontSize: kind === "head" ? 38 : kind === "small" ? 24 : 30, fontWeight: kind === "head" || kind === "total" ? 800 : 600, letterSpacing: kind === "head" ? 4 : 1, color: L.C.ink, opacity: 0.9, lineHeight: 1.2, align: "left" };
      const id = await L.text(f, text, { name: `Receipt · ${text}`, style: st });
      const b = await L.box(id);
      const cy = y0 + TOP + i * LH + LH / 2;
      await L.pos(id, kind === "head" || kind === "rule" || kind === "small" ? 0 : x0 + 32 + b.width / 2, cy);
      ids.push(id);
    }
    const receipt = await L.group(ids, "Receipt");
    // Feed: line i prints by stepping the paper up until line i is just above the slot.
    // A step = 22 px in 2 frames, then a 2-frame pause: the printer's own rhythm.
    const feed = [[0, 0]];
    let y = 0;
    const step = (t0, px) => { const n = Math.max(1, Math.round(px / 22)); let t = t0; for (let k = 0; k < n; k++) { feed.push([t, y, "linear"]); y -= px / n; t += 2 * L.FRAME; feed.push([t, y, "linear"]); t += 2 * L.FRAME; } return t; };
    for (let i = 0; i < LINES.length; i++) {
      const out = TOP + (i + 1) * LH + 8; // paper above the slot once line i is printed (clear of the lip)
      const t1 = step(at(i), out - -y);
      L.ev(at(i), "print-line", { text: LINES[i][0], durMs: Math.round(t1 - at(i)) });
    }
    const tTail = step(fr(T.tail), len - -y - 4); // the blank tail, out to the tear
    L.ev(fr(T.tail), "print-feed", { durMs: Math.round(tTail - fr(T.tail)) });
    // Torn off: a tug up and away, a little swing, and the free end curls.
    const tr = fr(T.tear);
    feed.push([tr, y, "ease-out"], [tr + 260, y - 54, "ease-in-out"], [tr + 700, y - 44]);
    await L.keys(receipt, "y", feed, "comp");
    await L.keys(receipt, "rotation", [[0, 0], [tr, 0, "ease-out"], [tr + 300, 2.6, "ease-in-out"], [tr + 750, -0.8]], "comp");
    await ac.keyframes.set({ id: paper, property: "geometry", keys: [{ at: tr + 80, value: paperD(0), easing: "ease-out-back" }, { at: tr + 560, value: paperD(1) }], clock: "comp" });
    L.ev(tr, "paper-rip");

    // 2 · The slot's mask: only what has come out of the printer shows.
    const stencil = await L.rect(f, { name: "Slot (mask)", width: PW + 200, height: H * 2, fill: "#000000", x: 0, y: SLOT - H });
    await ac.layer.patch({ id: stencil, ops: [{ op: "set", path: "isStencil", value: true }] });
    const masked = await L.group([receipt, stencil], "Receipt (through the slot)");
    await ac.layer.patch({ id: masked, ops: [{ op: "set", path: "mode", value: "mask" }] });

    // 3 · The printer: a small machine. Crisp, no boil; it pops in, then judders on each line.
    const pw = 660, ph = 150, py = SLOT + ph / 2 - 6; // the slot is the body's top edge: nothing printed hides behind it
    const body = await L.rect(f, { name: "Printer · body", width: pw, height: ph, cornerRadius: 28, fill: "#2B2A27", x: 0, y: py });
    const lip = await L.rect(f, { name: "Printer · slot", width: PW + 40, height: 10, cornerRadius: 5, fill: "#151413", x: 0, y: SLOT + 8 });
    const led = await L.ellipse(f, { name: "Printer · light", width: 12, height: 12, fill: L.C.clay, x: pw / 2 - 52, y: py + 30 });
    const k1 = await L.rect(f, { name: "Printer · key", width: 46, height: 14, cornerRadius: 7, fill: "#4A4843", x: -pw / 2 + 70, y: py + 30 });
    const k2 = await L.rect(f, { name: "Printer · key 2", width: 46, height: 14, cornerRadius: 7, fill: "#4A4843", x: -pw / 2 + 130, y: py + 30 });
    const printer = await L.group([body, lip, led, k1, k2], "Printer");
    const pop = fr(T.pop);
    await L.keys(printer, "y", [[0, 400], [pop, 400, L.EASE.pop], [pop + 420, 0]], "comp");
    const jud = [[0, 0]];
    for (let i = 0; i < LINES.length; i++) jud.push([at(i), 0, "linear"], [at(i) + 33, 1.5, "linear"], [at(i) + 66, -1, "linear"], [at(i) + 100, 0]);
    await L.keys(printer, "x", jud, "comp");
    await L.keys(led, "opacity", L.steps([[0, 0.35], ...LINES.flatMap((_, i) => [[at(i), 1], [at(i) + 260, 0.35]])]), "comp");
    L.ev(pop, "printer-pop");
  },
};
