// 03 · PIXEL QUEST — real pixels on a 12 px grid.
//
// Every sprite is a little text map (one character per pixel); each colour of
// it becomes ONE path layer of squares, so a whole mountain range is a single
// layer. The parallax is an expression that moves in whole pixels — pixel art
// never slides by half a pixel.

const P = 12;                 // one pixel, in comp px
const N = 90;                 // the comp is N × N pixels
const LOOP = 12000;
const SKY = ["#140c2a", "#1f1442", "#2e1d5c", "#46297a", "#6b3a8f"];
const BANDS = [0, 16, 28, 38, 46];          // first row of each sky colour
const GROUND = "#0e0a22", GRASS = "#1f3b3a", TUFT = "#2f5a4a";
const FAR = "#2a1b55", MID = "#1b1240", WINDOW = "#ffcf6b";
const MOON = "#f6edd0", CRATER = "#d9cba3", STAR = "#f4e9c8";

// px of a cell's top-left corner
const X = (c) => -540 + c * P, Y = (r) => -540 + r * P;

/** Cells → one path layer of squares (runs merged per row), placed where the cells are. */
async function pix(f, cells, color, name, extra = {}) {
  if (!cells.length) return null;
  const rows = new Map();
  for (const [c, r] of cells) (rows.get(r) ?? rows.set(r, new Set()).get(r)).add(c);
  let d = "", minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [r, set] of rows) {
    const cs = [...set].sort((a, b) => a - b);
    for (let i = 0; i < cs.length; ) {
      let j = i;
      while (j + 1 < cs.length && cs[j + 1] === cs[j] + 1) j++;
      const x0 = X(cs[i]), y0 = Y(r), w = (j - i + 1) * P;
      d += `M${x0} ${y0}h${w}v${P}h${-w}Z`;
      minX = Math.min(minX, x0); maxX = Math.max(maxX, x0 + w); minY = Math.min(minY, y0); maxY = Math.max(maxY, y0 + P);
      i = j + 1;
    }
  }
  const id = await L.path(f, d, { name, fill: color, x: (minX + maxX) / 2, y: (minY + maxY) / 2, ...extra });
  CENTRE.set(id, (minX + maxX) / 2);
  return id;
}
const CENTRE = new Map();

/** A text map → { colour: cells } with the map's top-left at (c0, r0). */
function sprite(map, legend, c0, r0) {
  const out = {};
  map.trim().split("\n").forEach((line, r) => [...line.trim()].forEach((ch, c) => {
    if (legend[ch]) (out[legend[ch]] ??= []).push([c0 + c, r0 + r]);
  }));
  return out;
}

/** Moves a layer left in whole pixels, wrapping every `tile` px, over the loop. */
const scroll = (id, tile, loops = 1) =>
  ac.expression.set({ id, property: "x", source: `${CENTRE.get(id)} - floor(mod(#time * ${(tile * loops) / (LOOP / 1000)}, ${tile}) / ${P}) * ${P}` });

/** A periodic ridge: for each column, the first row of ground. */
const ridge = (period, base, amp, seed) => (c) =>
  Math.round(base - amp * (0.6 * Math.sin((2 * Math.PI * c) / period + seed) + 0.4 * Math.sin((4 * Math.PI * c) / period + seed * 2.3)));

const KNIGHT_A = `
...PP....
..PPP....
..HHHH...
.HHHHHh..
.HHVVVh..
.HHHHHh.S
..TTTT..S
.TTTTTt.S
.TTTTTtSS
..tTTt...
..L..L...
.BB...BB.`;
const KNIGHT_B = `
.........
...PP....
..PPP....
..HHHH...
.HHHHHh..
.HHVVVh..
.HHHHHh.S
..TTTT..S
.TTTTTtSS
..tTTt...
...LL....
...BB....`;
const KNIGHT = { P: "#e0584a", H: "#c9d1e6", h: "#8a93ad", V: "#1a1530", T: "#4f7ddb", t: "#35589e", S: "#e8eef8", L: "#2b2350", B: "#4a3b2a" };

const CASTLE = `
.T.....T.....T.
.TT...TTT...TT.
TTTT.TTTTT.TTTT
TTTT.TTWTT.TTTT
TTTTTTTTTTTTTTT
TTTTTTTTTTTTTTT
TTWTTTTTTTTWTTT
TTTTTTTTTTTTTTT`;

return {
  meta: {
    no: "03", family: "Pixel & game", name: "Pixel Quest",
    line: "A night scene drawn as real pixels, scrolling in parallax, with a knight who never stops walking.",
    prompt: "An 8-bit night scene drawn as real pixels on a 12 px grid: moonlit hills, a castle on the far ridge, twinkling stars, a tiny knight walking (2-frame step) while the world scrolls past in parallax. 'LEVEL 1 · THE PROMPT' types on in a pixel font. CRT scanlines. A 12 s seamless loop.",
    remix: ["Make it a snowy morning: same hills, pale palette, 1-px snow.", "Swap the knight for a pixel cat chasing a firefly.", "Turn it into a 9:16 loading screen with a progress bar of hearts."],
    tech: "pixel paths from text maps · parallax expressions snapped to 12 px · 2-frame walk · scanlines adjustment",
  },
  w: 1080, h: 1080, dur: LOOP, bg: SKY[0],
  async build(f) {
    // Sky: bands with a dithered row at each seam.
    for (let k = 1; k < SKY.length; k++) {
      const cells = [];
      for (let r = BANDS[k]; r < N; r++) for (let c = 0; c < N; c++) cells.push([c, r]);
      for (let c = 0; c < N; c++) {
        if (c % 2 === 0) cells.push([c, BANDS[k] - 1]);
        if (c % 4 === 1) cells.push([c, BANDS[k] - 2]);
      }
      await pix(f, cells, SKY[k], `Sky ${k}`);
    }
    // Stars, in three twinkle groups.
    for (let g = 0; g < 3; g++) {
      const cells = [];
      for (let i = 0; i < 14; i++) {
        const c = Math.floor(L.rand() * N), r = Math.floor(L.rand() * 44);
        if (!(r >= 17 && r <= 36 && c >= 16 && c <= 74)) cells.push([c, r]); // keep the title clear
      }
      const id = await pix(f, cells, STAR, `Stars ${g + 1}`);
      await ac.expression.set({ id, property: "opacity", source: `0.3 + 0.7 * mod(floor(#time * 1.6 + ${g * 0.66}), 2)` });
    }
    // The moon, with craters.
    const moon = [], craters = [];
    for (let r = -6; r <= 6; r++) for (let c = -6; c <= 6; c++) if (c * c + r * r <= 38) moon.push([76 + c, 11 + r]);
    for (const [c, r] of [[74, 9], [75, 9], [78, 13], [79, 13], [78, 14], [73, 14]]) craters.push([c, r]);
    await pix(f, moon, MOON, "Moon");
    await pix(f, craters, CRATER, "Craters");

    // Far mountains: a 45-pixel tile, three copies, one tile per loop.
    const far = ridge(45, 53, 8, 0.4), farCells = [];
    for (let c = 0; c < 135; c++) for (let r = far(c); r < N; r++) farCells.push([c, r]);
    const farId = await pix(f, farCells, FAR, "Far mountains");
    await scroll(farId, 45 * P);

    // Mid hills + a castle: a 90-pixel tile, two copies.
    const mid = ridge(90, 66, 6, 2.1), midCells = [];
    for (let c = 0; c < 180; c++) for (let r = mid(c); r < N; r++) midCells.push([c, r]);
    const castleTop = mid(62) - 8;
    for (const copy of [0, 90]) {
      const s = sprite(CASTLE, { T: "t", W: "w" }, 55 + copy, castleTop);
      midCells.push(...(s.t ?? []), ...(s.w ?? []));
    }
    const midId = await pix(f, midCells, MID, "Mid hills");
    const winCells = [];
    for (const copy of [0, 90]) winCells.push(...(sprite(CASTLE, { W: "w" }, 55 + copy, castleTop).w ?? []));
    const winId = await pix(f, winCells, WINDOW, "Castle windows");
    await scroll(midId, 90 * P);
    await scroll(winId, 90 * P);
    await ac.expression.set({ id: winId, property: "opacity", source: `0.75 + 0.25 * mod(floor(#time * 3.1), 2)` });

    // Near ground: a 30-pixel tile of grass tufts, scrolls fastest.
    const groundCells = [], grassCells = [], tuftCells = [];
    for (let c = 0; c < 120; c++) {
      const top = 78 + (c % 30 === 7 || c % 30 === 19 ? -1 : 0);
      grassCells.push([c, top], [c, top + 1]);
      if (c % 30 === 7 || c % 30 === 19 || c % 30 === 8) tuftCells.push([c, top - 1]);
      for (let r = top + 2; r < N; r++) groundCells.push([c, r]);
      if (c % 11 === 3) groundCells.push([c, top + 1]);
    }
    for (const [cells, col, name] of [[groundCells, GROUND, "Ground"], [grassCells, GRASS, "Grass"], [tuftCells, TUFT, "Tufts"]]) {
      const id = await pix(f, cells, col, name);
      await scroll(id, 30 * P, 6);
    }

    // The knight walks in place; the world moves.
    for (const [map, k] of [[KNIGHT_A, 0], [KNIGHT_B, 1]]) {
      const s = sprite(map, KNIGHT, 22, 66);
      for (const [col, cells] of Object.entries(s)) {
        const id = await pix(f, cells, col, `Knight ${k ? "B" : "A"} ${col}`);
        await ac.expression.set({ id, property: "opacity", source: k ? "mod(floor(#time * 6), 2)" : "1 - mod(floor(#time * 6), 2)" });
      }
    }

    // Fireflies over the grass, drifting in whole pixels.
    for (let k = 0; k < 7; k++) {
      const c = 8 + Math.floor(L.rand() * 74), r = 70 + Math.floor(L.rand() * 6);
      const id = await pix(f, [[c, r]], WINDOW, `Firefly ${k + 1}`);
      const ph = (L.rand() * 6).toFixed(2), sp = (0.5 + L.rand() * 0.6).toFixed(2);
      await ac.expression.set({ id, property: "y", source: `${Y(r) + P / 2} + floor(sin(#time * ${sp} + ${ph}) * 3) * ${P}` });
      await ac.expression.set({ id, property: "x", source: `${X(c) + P / 2} + floor(sin(#time * ${sp} * 0.7 + ${ph} * 2) * 4) * ${P}` });
      await ac.expression.set({ id, property: "opacity", source: `0.25 + 0.75 * mod(floor(#time * 2.3 + ${ph}), 2)` });
    }

    // Title: a pixel face, hard pixel shadow, typed on.
    const shadow = [{ id: "tfx_px", type: "shadow", color: SKY[0], x: 6, y: 6, blur: 0 }];
    const t1 = await L.text(f, "LEVEL 1", { name: "Level", y: -236, startMs: 300, style: { fontFamily: "Press Start 2P", fontSize: 84, color: WINDOW, textEffects: shadow } });
    await ac.animation.set({ id: t1, slot: "in", preset: "typewriter", unit: "letter", staggerMs: 90 });
    const t2 = await L.text(f, "THE PROMPT", { name: "Subtitle", y: -132, startMs: 1100, style: { fontFamily: "Press Start 2P", fontSize: 36, color: STAR, letterSpacing: 4, textEffects: shadow } });
    await ac.animation.set({ id: t2, slot: "in", preset: "typewriter", unit: "letter", staggerMs: 70 });
    const t3 = await L.text(f, "▶ PRESS START", { name: "Press start", y: 444, startMs: 2400, style: { fontFamily: "Press Start 2P", fontSize: 28, color: STAR, textEffects: shadow } });
    await ac.expression.set({ id: t3, property: "opacity", source: "mod(floor(#time * 2), 2)" });

    // The CRT.
    const crt = (await ac.layer.create({ kind: "adjustment", ...L.span(f, { name: "CRT" }) })).id;
    await L.fx(crt, "scanlines", {});
  },
};
