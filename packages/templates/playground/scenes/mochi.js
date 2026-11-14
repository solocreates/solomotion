// 10 · MOCHI — a character drawn from a few shapes, alive in one call.
//
// Everything is drawn here from numbers: the body, two eyes (Open · Half ·
// Closed), brows, cheeks and NINE mouths named by viseme (X MBP AI E O U FV L
// S). Named like that, `character.bringToLife` finds the parts and wires
// blink, breathe, nod and lip sync to the voice — exact, because the voice
// ships with its word timings.

const DUR = 8600, VO_AT = 600;
const LINE = "Hi! I'm Mochi. Claude made me out of four circles... and a lot of opinions. Wanna make one too?";
const WORDS = [["Hi!", 0, 520], ["I'm", 640, 800], ["Mochi.", 907, 1520], ["Claude", 1760, 2000], ["made", 2080, 2240], ["me", 2320, 2400], ["out", 2480, 2560], ["of", 2640, 2720], ["four", 2800, 2960], ["circles...", 3120, 4080], ["and", 4160, 4320], ["a", 4400, 4520], ["lot", 4640, 4880], ["of", 4960, 5040], ["opinions.", 5120, 5880], ["Wanna", 6080, 6320], ["make", 6400, 6480], ["one", 6560, 6640], ["too?", 6720, 7280]];
const GROUND = "#A9C8E3", SKIN = "#F8E1D8", INK = "#3A2E2A", CHEEK = "#EE9A86", HOLE = "#5A2230", TONGUE = "#E07A6B";
const MY = 70; // Mochi's centre

/** A mouth hole w × h: a soft top lip, a deep bottom. */
const hole = (w, h) => `M${-w / 2} 0 C ${-w / 2} ${-h * 0.28} ${w / 2} ${-h * 0.28} ${w / 2} 0 C ${w / 2} ${h * 0.95} ${-w / 2} ${h * 0.95} ${-w / 2} 0 Z`;
const VISEMES = {
  X: { line: "M-34 0 Q 0 16 34 0" },
  MBP: { line: "M-28 3 Q 0 7 28 3", width: 9 },
  AI: { w: 92, h: 74, tongue: true },
  E: { w: 100, h: 40, teeth: true },
  O: { w: 58, h: 66, tongue: true },
  U: { w: 34, h: 38 },
  FV: { w: 72, h: 26, teeth: true },
  L: { w: 78, h: 54, tongue: true, lift: true },
  S: { w: 86, h: 20, teeth: true },
};

return {
  meta: {
    no: "10", family: "Characters", name: "Mochi",
    line: "A blob drawn from a handful of shapes that blinks, breathes and lip-syncs a real voice.",
    prompt: "Make a soft rice-cake blob character called Mochi on a pastel blue ground: ink outline, blush cheeks, eyes with Open/Half/Closed states, and nine viseme mouths. Bring it to life (blink, breathe, nod, lip sync) on an ElevenLabs line in a quirky voice: 'Hi! I'm Mochi. Claude made me out of four circles… and a lot of opinions. Wanna make one too?' On 'four circles' four little circles pop in and orbit it.",
    remix: ["Give Mochi a different voice and a new line: it re-syncs.", "Make a second character and let them argue.", "Draw Mochi as pixels and keep the same mouths."],
    tech: "parts named by role · viseme switch from generated paths · character.bringToLife · voice with word timings",
  },
  w: 1080, h: 1080, dur: DUR, bg: GROUND,
  async build(f) {
    // The stage: a soft disc and a flat contact shadow.
    await L.ellipse(f, { name: "Spot", width: 860, height: 860, fill: "#BCD5EA", x: 0, y: 0 });
    await L.ellipse(f, { name: "Contact", width: 420, height: 48, fill: "#8DB2D3", x: 0, y: MY + 222 });

    // The voice first: a character finds the voice that overlaps it.
    const said = await L.sound(f, "mochi-line.mp3", "Mochi's line", VO_AT, "Voices");
    if (said && ac.speech?.analyze) {
      await ac.speech.analyze({ id: said.assetId, text: LINE, words: WORDS.map(([text, startMs, endMs]) => ({ text, startMs, endMs })) }).catch((e) => console.warn(e.message));
    }

    const part = async (d, o, name) => L.path(f, d, { name, ...o });
    const body = await part("M-250 40 C -250 -150 -120 -210 0 -210 C 120 -210 250 -150 250 40 C 250 170 140 205 0 205 C -140 205 -250 170 -250 40 Z", { fill: SKIN, stroke: { color: INK, width: 8 }, x: 0, y: MY }, "Head");
    const face = [];
    for (const [s, sx] of [["R", -1], ["L", 1]]) {
      const ex = sx * 92, ey = MY - 18;
      const open = [await L.ellipse(f, { name: "Open iris", width: 46, height: 60, fill: INK, x: ex, y: ey }), await L.ellipse(f, { name: "Shine", width: 14, height: 14, fill: "#FFFFFF", x: ex + 8, y: ey - 12 })];
      const openG = (await ac.layers.group({ ids: open, name: "Open" })).groupId;
      const half = await L.ellipse(f, { name: "Half", width: 46, height: 26, fill: INK, x: ex, y: ey + 8 });
      const closed = await part("M-24 0 Q 0 14 24 0", { stroke: { color: INK, width: 8, cap: "round" }, fill: null, x: ex, y: ey + 8 }, "Closed");
      face.push((await ac.switch.create({ ids: [openG, half, closed], name: `Eye.${s}`, show: "Open" })).switchId);
      const brows = [];
      for (const [n, tilt, dy] of [["Neutral", 0, 0], ["Raised", 0, -14], ["Angry", 14 * sx, 6]]) {
        brows.push(await part("M-22 0 Q 0 -8 22 0", { stroke: { color: INK, width: 7, cap: "round" }, fill: null, x: ex, y: ey - 58 + dy, set: { rotation: tilt } }, n));
      }
      face.push((await ac.switch.create({ ids: brows, name: `Brow.${s}`, show: "Neutral" })).switchId);
      face.push(await L.ellipse(f, { name: `Cheek.${s}`, width: 62, height: 34, fill: CHEEK, x: sx * 150, y: MY + 36, set: { opacity: 0.6 } }));
    }
    // Nine mouths.
    const mouths = [];
    for (const [n, v] of Object.entries(VISEMES)) {
      const y = MY + 64;
      if (v.line) { mouths.push(await part(v.line, { stroke: { color: INK, width: v.width ?? 7, cap: "round" }, fill: null, x: 0, y }, n)); continue; }
      const ids = [await part(hole(v.w, v.h), { fill: HOLE, stroke: { color: INK, width: 6, join: "round" }, x: 0, y: y + v.h * 0.33 }, `${n} hole`)];
      if (v.tongue) ids.push(await L.ellipse(f, { name: `${n} tongue`, width: v.w * 0.55, height: v.h * 0.3, fill: TONGUE, x: 0, y: y + v.h * (v.lift ? 0.35 : 0.55) }));
      if (v.teeth) ids.push(await L.rect(f, { name: `${n} teeth`, width: v.w * 0.62, height: Math.max(6, v.h * 0.22), cornerRadius: 3, fill: "#FFFFFF", x: 0, y: y + 2 }));
      mouths.push((await ac.layers.group({ ids, name: n })).groupId);
    }
    face.push((await ac.switch.create({ ids: mouths, name: "Mouth", show: "X" })).switchId);
    const mochi = (await ac.layers.group({ ids: [body, ...face], name: "Mochi" })).groupId;
    const life = await ac.character.bringToLife({ id: mochi });
    console.log("Mochi:", (life.parts ?? []).join(", "));

    // "…out of four circles": four circles pop in and orbit.
    const COLS = [L.C.clay, L.C.honey, L.C.olive, L.C.fig];
    for (let i = 0; i < 4; i++) {
      const at = VO_AT + 3120 + i * 110;
      const id = await L.ellipse(f, { name: `Circle ${i + 1}`, width: 64, height: 64, fill: COLS[i], stroke: { color: INK, width: 6 }, startMs: at, x: 0, y: 0 });
      await ac.animation.set({ id, slot: "in", preset: "pop-in", target: "layer", durationMs: 450 });
      const a0 = -Math.PI / 2 + (i * Math.PI) / 2 + 0.6;
      await ac.expression.set({ id, property: "x", source: `cos(${a0.toFixed(3)} + #time * 0.6) * 360` });
      await ac.expression.set({ id, property: "y", source: `${MY - 20} + sin(${a0.toFixed(3)} + #time * 0.6) * 300` });
    }
  },
};
