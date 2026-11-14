// MATERIAL LIBRARY — the build.
//
// This file made this project: ONE flat scene, and that scene in every
// Texture look the app ships, filed by family — so you can see them side by
// side, steal any of them (open a comp, the look is its frame effects), and
// judge a new one against the rest. Change a line and press Run: replace mode
// takes away what the last run made and builds it again.
//
//   Scene      the flat illustration every other comp nests — edit it once,
//              every material follows
//   families   a page each; every comp there is the scene + one look
//   Cover      a still wall of the strongest nine — the card you see first
//   Morph      one shape becoming many materials (effects.morph)

const SIZE = 1080;
const DUR = 8000;

const FAMILIES = [
  ["Craft", ["paper-cut-out", "stop-motion", "cardboard", "crumpled-paper", "felt", "claymation", "cross-stitch", "tufted-rug"]],
  ["Print", ["riso-print", "letterpress", "embossed-paper", "engraving", "woodblock", "newspaper", "photocopy", "cyanotype", "blueprint", "graph-paper"]],
  ["Paint & ink", ["watercolor", "ink-bleed", "chalk-on-card", "marbling"]],
  ["Glass, metal & fluid", ["holo-foil", "liquid-chrome", "stained-glass", "frosted-glass", "crystal", "kintsugi", "soap-film", "ferrofluid"]],
  ["Light & screens", ["neon-glass", "led-board", "crt-phosphor", "vhs", "game-boy"]],
];

// The cover's wall: the nine that read best at a glance, in a 3×3 that
// alternates light and dark so no two neighbours fight.
const COVER = ["felt", "neon-glass", "kintsugi", "liquid-chrome", "claymation", "holo-foil", "riso-print", "crystal", "blueprint"];

// The reel on the first page: each material fully showing at its stop.
// Light grounds to dark, ending with the lights on. Every stop shares the
// card's dials, so the card lays each material's OWN ground (colour mode
// "under"): chrome on its black, neon on its brick — on the cream they washed out.
const CHAIN = ["paper", "felt", "foil", "stainedGlass", "chrome", "neon"];

const start = here.frameId;
const t0 = Date.now();

async function page(name) {
  let pages = (await ac.doc.overview()).pages;
  const hit = pages.find((p) => p.name === name);
  if (hit) return hit.id;
  if (pages.length === 1 && /^Page \d+$/.test(pages[0].name) && ac.page.update) {
    await ac.page.update({ id: pages[0].id, name });
    return pages[0].id;
  }
  await ac.page.create({ name });
  pages = (await ac.doc.overview()).pages;
  return pages.find((p) => p.name === name).id;
}

// ── The scene: flat shapes on a plain ground — what a texture look is for.
// Every colour region is its own piece, so a material treats the sun on its
// star, the hills and the moon each as a piece of felt, a pane, a tube.
const startPage = await page("★ Start here");
// The cover first: a project (and its card) opens on the top-left comp of
// its first page. STILL on purpose — a card loops its comp on hover, and nine
// lit materials re-rendered every frame is the heaviest thing in the app.
const cover = await ac.frame.create({ name: "Material library", width: SIZE, height: SIZE, background: "#15120F", durationMs: 1000, pageId: startPage, mode: "static" });
const scene = await ac.frame.create({ name: "Scene", width: SIZE, height: SIZE, background: "#F2E8D5", durationMs: DUR, pageId: startPage });
const shape = (o) => ac.layer.create({ kind: "shape", frameId: scene.id, startMs: 0, durationMs: DUR, ...o });
await shape({ name: "Hill back", shape: "ellipse", width: 1500, height: 640, x: -300, y: 560, fill: "#2E8C7A" });
const rays = await shape({ name: "Rays", shape: "star", pointCount: 12, innerRatio: 0.46, width: 600, height: 600, x: 0, y: -90, fill: "#F26A2E" });
await shape({ name: "Sun", shape: "ellipse", width: 270, height: 270, x: 0, y: -90, fill: "#FAC43C" });
await shape({ name: "Hill front", shape: "ellipse", width: 1400, height: 560, x: 360, y: 640, fill: "#6BB36B" });
await shape({ name: "Moon", shape: "ellipse", width: 130, height: 130, x: -370, y: -390, fill: "#265CA0" });
// The rays turn slowly: a material is judged in motion, not as a still.
await ac.keyframes.set({ id: rays.id, property: "rotation", keys: [{ at: 0, value: 0, easing: "linear" }, { at: DUR, value: 30 }] });

/** A comp that is the scene + one look, on `pageId`. */
async function styled(name, pageId) {
  const f = await ac.frame.create({ name, width: SIZE, height: SIZE, background: "#F2E8D5", durationMs: DUR, pageId });
  await ac.layer.create({ kind: "comp", sourceFrameId: scene.id, frameId: f.id, startMs: 0, durationMs: DUR, name: "Scene" });
  return f;
}

// ── One shape, many materials.
const reel = await styled("Morph · one shape, many materials", startPage);
await ac.effects.look({ id: reel.id, look: "felt" });
// A stop every ~1.2 s, the last one held for the end.
const step = (DUR * 0.92) / (CHAIN.length - 1);
const morph = await ac.effects.morph({
  id: reel.id,
  stops: CHAIN.map((material, i) => ({ material, atMs: Math.round(i * step) })),
  overMs: 700,
  style: "spread",
});
await ac.effects.update({ id: morph.id, effectId: morph.effectId, values: { colorMode: "under" } });

// ── The families.
let count = 0;
const made = {};
for (const [family, looks] of FAMILIES) {
  const pageId = await page(family);
  for (const id of looks) {
    const f = await styled(id, pageId);
    const res = await ac.effects.look({ id: f.id, look: id });
    await ac.frame.update({ id: f.id, name: res.name });
    made[id] = { id: f.id, name: res.name };
    count++;
  }
}

// ── The cover's wall: each tile nests a family comp, so the cover shows the
// very picture its page does.
const GAP = 18;
const TILE = (SIZE - GAP * 4) / 3;
for (const [i, id] of COVER.entries()) {
  const comp = made[id];
  if (!comp) continue;
  const x = -SIZE / 2 + GAP + (i % 3) * (TILE + GAP) + TILE / 2;
  const y = -SIZE / 2 + GAP + Math.floor(i / 3) * (TILE + GAP) + TILE / 2;
  await ac.layer.create({ kind: "comp", sourceFrameId: comp.id, frameId: cover.id, startMs: 0, durationMs: 1000, name: comp.name, x, y, set: { scale: TILE / SIZE } });
}

// The empty comp the project started with goes.
if (start && (await ac.doc.overview()).comps.some((c) => c.id === start && c.layers === 0)) await ac.frame.delete({ id: start });
console.log(`Material library: ${count} looks in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
return { cover: cover.id, scene: scene.id, reel: reel.id, looks: count };
