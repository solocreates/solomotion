// 09 · PIXEL TALKER — an RPG shopkeeper who talks while his words type.
//
// Pixel art (the shared pixel kit) + a dialogue box + timing: the mouth flaps
// only while letters are typing, the blips are rendered from the same letter
// schedule, and he blinks on his own clock. Talking without a voice.

const DUR = 8000, STAG = 42;
const PAGES = [[600, "Ah, a new creator! Everything here is editable, you know."], [3700, "Psst... every scene comes with its prompt. Steal them."]];
const WALL = "#2b2140", WALL2 = "#322650", SHELF = "#5a3a24", WOOD = "#6b4226", WOOD_HI = "#8a5a36", WOOD_LO = "#4a2c18";
const BOX = "#1a1530", CREAM = "#f4e9c8", HONEY = "#ffcf6b";

const MERCHANT = `
........hh..........
.......hhhh.........
......hhhhhh........
.....hhhhhhhh.......
....hhhhhhhhhh......
....hhhhhhhhhhh.....
..HHHHHHHHHHHHHHHH..
.hhhhhhhhhhhhhhhhhh.
....ssssssssssss....
....ssssssssssss....
....sseessssseess...
....ssssssssssss....
....ccsssSSsssscc...
....bbbbbbbbbbbb....
...bbbbmmmmmmbbbb...
...bbbbbbbbbbbbbb...
....bbbbbbbbbbbb....
..rrrbbbbbbbbbbrrr..
.rrrrrbbbbbbbbrrrrr.
.rrrrrrbbbbbbrrrrrr.
.rrrRrrrrbbrrrrRrrr.
.rrrRrrrrggrrrrRrrr.`;
const LEG = { h: "#6a4bb5", H: "#ffcf6b", s: "#f2c29b", S: "#d9a07a", e: "#1a1530", c: "#f0a08c", b: "#eeeae0", m: "#6b2b2b", r: "#2f6f8f", R: "#23546d", g: "#e8b866" };
const MOUTH_OPEN = `
.......oooooo
.......oooooo
........oooo`;
const BOTTLE = `
.n.
.n.
ccc
ccc
ccc`;

return {
  meta: {
    no: "09", family: "Characters", name: "Pixel Talker",
    line: "An RPG shopkeeper who blinks, talks while his words type, and gives you a tip.",
    prompt: "A pixel-art merchant behind a wooden counter, shelves of potions behind him, RPG style. A dialogue box with his name tab: each line types on letter by letter with soft square-wave blips, and his mouth flaps only while letters are typing. He blinks on his own. Line 1: 'Ah, a new creator! Everything here is editable, you know.' Line 2: 'Psst... every scene comes with its prompt. Steal them.' 8 s.",
    remix: ["Give him your product's FAQ, one page per question.", "Make it a cat shopkeeper who meows instead of blips.", "Two characters: a hero walks in and answers him."],
    tech: "pixel kit sprites · mouth/blink by expression windows · typewriter per letter · blips rendered from the same schedule",
  },
  w: 1080, h: 1080, dur: DUR, bg: WALL,
  async build(f) {
    const K = L.pixels(18, 1080, 1080); // 60 × 60 pixels
    // Wall stripes, shelves and potions.
    const stripes = [];
    for (let c = 0; c < 60; c += 4) for (let r = 0; r < 40; r++) stripes.push([c, r]);
    await K.pix(f, stripes, WALL2, "Wall stripes");
    for (const r of [9, 21]) {
      await K.pix(f, Array.from({ length: 56 }, (_, i) => [2 + i, r]), SHELF, `Shelf ${r}`);
      const colours = ["#e0584a", "#4fbf8f", "#4f7ddb", "#e8b866", "#c46686", "#9fe0ff"];
      for (let i = 0; i < 9; i++) {
        if (r === 21 && i >= 2 && i <= 6) continue; // his hat goes here
        const c = 4 + i * 6 + (i % 2), col = colours[(i + r) % colours.length];
        await K.draw(f, BOTTLE, { n: "#d9cba3", c: col }, c, r - 5, `Potion`);
      }
    }
    // The merchant (behind the counter), his blink, his mouth.
    const C0 = 20, R0 = 15;
    const body = await K.draw(f, MERCHANT, LEG, C0, R0, "Merchant");
    const lids = await K.pix(f, [[C0 + 6, R0 + 10], [C0 + 7, R0 + 10], [C0 + 13, R0 + 10], [C0 + 14, R0 + 10]], LEG.s, "Blink");
    await ac.expression.set({ id: lids, property: "opacity", source: "clamp((mod(#time, 3.1) - 2.95) * 1000, 0, 1)" });
    const talking = PAGES.map(([t, s]) => `clamp((#time - ${t / 1000}) * 1000, 0, 1) * clamp((${(t + s.length * STAG) / 1000} - #time) * 1000, 0, 1)`).join(" + ");
    const mouth = (await K.draw(f, MOUTH_OPEN, { o: "#3a0f14" }, C0, R0 + 14, "Mouth open"))[0];
    await ac.expression.set({ id: mouth, property: "opacity", source: `mod(floor(#time * 11), 2) * (${talking})` });
    // A 1-pixel idle bob for everything he's made of.
    const g = await ac.layers.group({ ids: [...body, lids, mouth], name: "Merchant" });
    await ac.expression.set({ id: g.id ?? g.groupId, property: "y", source: "floor(mod(#time * 1.6, 2)) * 18" });
    // The counter.
    const top = [], face = [], lo = [];
    for (let c = 0; c < 60; c++) { top.push([c, 36]); for (let r = 37; r < 43; r++) face.push([c, r]); if (c % 10 === 0) for (let r = 37; r < 43; r++) lo.push([c, r]); }
    await K.pix(f, face, WOOD, "Counter");
    await K.pix(f, top, WOOD_HI, "Counter top");
    await K.pix(f, lo, WOOD_LO, "Counter planks");
    // The dialogue box: cream frame, ink panel, name tab.
    await L.rect(f, { name: "Box frame", width: 1080 - 96, height: 288, fill: CREAM, x: 0, y: 372 });
    await L.rect(f, { name: "Box", width: 1080 - 96 - 24, height: 288 - 24, fill: BOX, x: 0, y: 372 });
    await L.rect(f, { name: "Name tab frame", width: 264, height: 72, fill: CREAM, x: -492 + 132 + 24, y: 228 });
    await L.rect(f, { name: "Name tab", width: 240, height: 48, fill: BOX, x: -492 + 132 + 24, y: 228 });
    await L.text(f, "MERCHANT", { name: "Name", x: -492 + 132 + 24, y: 230, style: { fontFamily: "Press Start 2P", fontSize: 22, color: HONEY } });
    for (const [k, [t, s]] of PAGES.entries()) {
      const end = k + 1 < PAGES.length ? PAGES[k + 1][0] - 200 : DUR;
      const id = await L.text(f, s, { name: `Line ${k + 1}`, startMs: t, durationMs: end - t, maxWidth: 1080 - 96 - 24 - 96, style: { fontFamily: "Press Start 2P", fontSize: 28, lineHeight: 1.7, color: CREAM, align: "left" } });
      const b = await L.box(id);
      await L.pos(id, -492 + 12 + 48 + b.width / 2, 260 + 48 + b.height / 2);
      await ac.animation.set({ id, slot: "in", preset: "typewriter", unit: "letter", staggerMs: STAG });
      const done = t + s.length * STAG + 150;
      const arrow = await L.text(f, "▼", { name: `More ${k + 1}`, startMs: done, durationMs: end - done, x: 492 - 12 - 48, y: 372 + 144 - 12 - 40, style: { fontFamily: "Press Start 2P", fontSize: 22, color: HONEY } });
      await ac.expression.set({ id: arrow, property: "opacity", source: "mod(floor(#time * 2.5), 2)" });
    }
    await L.sound(f, "merchant-blips.mp3", "Blips", 0);
    const crt = (await ac.layer.create({ kind: "adjustment", ...L.span(f, { name: "CRT" }) })).id;
    await L.fx(crt, "scanlines", { mix: 0.5 });
  },
};
