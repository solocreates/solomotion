// HOOK LAB — the build.
//
// This file made this project: hooks that earn attention, each a 1080×1080
// stage with a card holding the prompt that made it, filed on pages, plus the
// kit of objects every hook is told with. Change a line in any scene file and
// press Run: replace mode takes away what the last run made and builds it all
// again.
//
//   lib.js            the look ("Ink & Clay"), the prompt card, and the objects:
//                     the hook on a line, the title card, the eyes, the
//                     envelope, the thumb, the counter, the pencil, the cursor
//   glyphs.js         the hero face as outlines + a single-line script
//   scenes/NN-*.js    one file per hook: { meta (its card), w, h, dur, build(f, ctx) }
//   scenes/kit.js     the Kit page: every object, once, labelled
//   scenes/cover.js   the cover
//
// Every scene logs its sound events (ev(t, kind)) — the clunk, the snap, each
// pen stroke with its speed. The run returns them, so a film can mix its sound
// from the picture instead of placing it by hand.

const PAGES = [
  ["★ Start here", []],
  ["The film · 12 hooks", ["01-stop", "02-look", "03-snap", "04-secret", "05-swipe", "06-pause", "07-story", "08-receipt"]],
  ["More hooks", []],
  ["Kit", []],
];
const STEP = 2100; // a hook (1080) + 48 + its card (760) + air

// Where the files come from: the project's own Scripts (a template), or a
// folder served next to the editor while developing (HOOKLAB_SOURCE).
const BASE = globalThis.HOOKLAB_SOURCE;
const read = async (p) => {
  if (BASE) {
    const r = await fetch(`${BASE}${p}?t=${Date.now()}`);
    if (!r.ok) throw new Error(`${p}: ${r.status}`);
    return r.text();
  }
  return (await ac.script.read({ script: `hook-lab/${p}` })).source;
};
const G = new Function(await read("glyphs.js"))();
const L = new Function("ac", "G", await read("lib.js"))(ac, G);
const t0 = Date.now();

// Pages, in order. The project's first page becomes the cover's.
const start = here.frameId;
let pages = (await ac.doc.overview()).pages;
for (const [i, [name]] of PAGES.entries()) {
  if (pages.some((p) => p.name === name)) continue;
  if (i === 0 && pages.length === 1 && /^Page \d+$/.test(pages[0].name)) await ac.page.update({ id: pages[0].id, name });
  else await ac.page.create({ name });
  pages = (await ac.doc.overview()).pages;
}
const pageId = (name) => pages.find((p) => p.name === name).id;
const kitPage = pageId("Kit");

const events = [];
const timings = {};
const made = {};
for (const [page, files] of PAGES) {
  for (const [i, file] of files.entries()) {
    const t = Date.now();
    const def = new Function("ac", "L", await read(`scenes/${file}.js`))(ac, L);
    const r = await L.place(def, pageId(page), i * STEP, 0, { kitPage, hooks: made }); // a later hook may nest an earlier one (06 holds 05)
    made[def.meta.no] = r.f.id;
    events.push(...r.events);
    timings[`${def.meta.no} ${def.meta.name}`] = Date.now() - t;
  }
}
const kit = await new Function("ac", "L", await read("scenes/kit.js"))(ac, L).build(kitPage);
const cover = await new Function("ac", "L", await read("scenes/cover.js"))(ac, L).build(pageId("★ Start here"), made);

// The empty comp the project started with goes. The cover is where you land.
if (start && start !== cover && (await ac.doc.overview()).comps.some((c) => c.id === start && c.layers === 0)) await ac.frame.delete({ id: start });
timings.total = Date.now() - t0;
console.log(`Hook Lab built in ${(timings.total / 1000).toFixed(1)} s · ${events.length} sound events`);
return { cover, kit, hooks: made, events, timings };
