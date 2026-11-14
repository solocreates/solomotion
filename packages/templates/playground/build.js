// PLAYGROUND — the build.
//
// This file made this project: twelve scenes in twelve styles, each with
// a card holding the prompt that made it, filed on pages by family, and a
// cover with a live wall of the scenes. Change a line in any scene file and
// press Run: replace mode takes away what the last run made and builds it
// all again.
//
//   lib.js            the house style of the cards + small helpers (pixels,
//                     sounds)
//   scenes/*.js       one file per scene: { meta (its card), size, build(f) }
//   PROMPTS.md        the whole prompt book — 81 more ideas to ask for

const PAGES = [
  ["★ Start here", [["cover", 0]]],
  ["Type", [["swiss-grid", 0], ["font-roulette", 2100]]],
  ["Styles", [["pixel-quest", 0], ["open-late", 2100], ["riso-poster", 4200], ["paper-hills", 6300]]],
  ["UI & Hints", [["liquid-glass", 0], ["easing-explained", 2100]]],
  ["Characters", [["pixel-talker", 0], ["mochi", 2100]]],
  ["Heavy · Physics & 3D", [["gravity-stickers", 0], ["tiny-island", 2100]]],
];

// Where the files come from: the project's own Scripts (a template), or a
// folder served next to the editor while developing (PLAYGROUND_SOURCE).
const BASE = globalThis.PLAYGROUND_SOURCE;
const read = async (p) => {
  if (BASE) {
    const r = await fetch(`${BASE}${p}?t=${Date.now()}`);
    if (!r.ok) throw new Error(`${p}: ${r.status}`);
    return r.text();
  }
  return (await ac.script.read({ script: `playground/${p}` })).source;
};
const L = new Function("ac", await read("lib.js"))(ac);
const t0 = Date.now();

// Pages, in order. The project's first page becomes the cover's.
const start = here.frameId;
let pages = (await ac.doc.overview()).pages;
for (const [i, [name]] of PAGES.entries()) {
  if (pages.some((p) => p.name === name)) continue;
  if (i === 0 && ac.page.update && pages.length === 1 && /^Page \d+$/.test(pages[0].name)) await ac.page.update({ id: pages[0].id, name });
  else await ac.page.create({ name });
  pages = (await ac.doc.overview()).pages;
}

// Scenes first (the cover's wall nests them), then the cover.
const made = {};
const timings = {};
let cover = null;
for (const [page, scenes] of PAGES) {
  for (const [file, x] of scenes) {
    if (file === "cover") { cover = { page, x }; continue; }
    const t = Date.now();
    const def = new Function("ac", "L", await read(`scenes/${file}.js`))(ac, L);
    const { f } = await L.place(def, page, x, 0);
    made[def.meta.no] = f.id;
    timings[`${def.meta.no} ${def.meta.name}`] = Date.now() - t;
  }
}
const def = new Function("ac", "L", await read("scenes/cover.js"))(ac, L);
const { f: coverFrame } = await L.place(def, cover.page, cover.x, 0, made);

// The empty comp the project started with goes. The cover is where you land:
// a project opens on the top-left comp of its first page.
if (start && start !== coverFrame.id && (await ac.doc.overview()).comps.some((c) => c.id === start && c.layers === 0)) await ac.frame.delete({ id: start });
timings.total = Date.now() - t0;
console.log(`Playground built in ${(timings.total / 1000).toFixed(1)} s`);
return { cover: coverFrame.id, timings };
