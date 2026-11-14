// PLAYGROUND — the shared kit every scene builds with.
//
// The house style of the prompt cards (Claude's own colours, one serif, one
// sans, one mono) and small helpers over ordinary `ac.*` verbs. A scene file
// receives this as `L`.

const C = {
  ivory: "#FAF9F5", oat: "#E3DACC", paper: "#F0EBE1", slate: "#262624", mute: "#6B675E",
  clay: "#D97757", olive: "#788C5D", sky: "#6A9BCC", fig: "#C46686", honey: "#E8B866",
};
const F = { serif: "Instrument Serif", sans: "Inter", mono: "JetBrains Mono" };

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const reseed = (s) => { seed = s; };

/** A comp on a page, at a canvas position. */
async function comp({ name, w, h, bg = C.ivory, dur = 6000, page, x = 0, y = 0, mode = "timeline", fps = 30, world = false }) {
  const made = world
    ? await ac.world.create({ name, width: w, height: h, starter: false, pageId: page })
    : await ac.frame.create({ name, width: w, height: h, background: bg, durationMs: dur, pageId: page, mode, fps });
  const id = made.id ?? made.frameId;
  if (!id) throw new Error(`comp: no id in ${JSON.stringify(made)}`); // frame.update without an id edits the FOCUSED comp
  if (world) await ac.frame.update({ id, background: bg, durationMs: dur, fps });
  await ac.frame.update({ id, ops: [{ op: "set", path: "x", value: x }, { op: "set", path: "y", value: y }, { op: "set", path: "loop", value: "loop" }] });
  return { id, w, h, dur };
}

/** Every layer spans its comp unless told otherwise. */
const span = (f, o) => ({ frameId: f.id, startMs: 0, durationMs: f.dur, ...o, ...(o.startMs != null && o.durationMs == null ? { durationMs: f.dur - o.startMs } : {}) });

async function text(f, s, o = {}) {
  const { style = {}, ...rest } = o;
  return (await ac.layer.create({ kind: "text", text: s, ...span(f, rest), style: { fontFamily: F.sans, color: C.slate, ...style } })).id;
}
async function rect(f, o) {
  return (await ac.layer.create({ kind: "shape", shape: "rect", ...span(f, o) })).id;
}
async function ellipse(f, o) {
  return (await ac.layer.create({ kind: "shape", shape: "ellipse", ...span(f, o) })).id;
}
async function path(f, d, o = {}) {
  return (await ac.layer.create({ kind: "path", d, ...span(f, o) })).id;
}
const keys = (id, property, k, clock = "layer") => ac.keyframes.set({ id, property, keys: k.map(([at, value, easing]) => (easing ? { at, value, easing } : { at, value })), clock });
const fx = (id, type, values) => ac.effects.add({ id, type, values });
const box = async (id) => (await ac.layer.get({ id, fields: ["box"] })).box;
/** Resting position (never a key). */
const pos = (id, x, y) => ac.layer.set({ ids: id, values: y == null ? { x } : { x, y }, mode: "base" });
const set = (id, values) => ac.layer.set({ ids: id, values, mode: "base" });
/**
 * PIXEL KIT — a grid of P-px pixels over a W×H comp. `pix` turns cells into ONE
 * path layer of squares (runs merged per row); `sprite` reads a text map, one
 * character per pixel. `centre` remembers each layer's x for scrolling.
 */
function pixels(P, W, H) {
  const X = (c) => -W / 2 + c * P, Y = (r) => -H / 2 + r * P;
  const centre = new Map();
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
    const id = await path(f, d, { name, fill: color, x: (minX + maxX) / 2, y: (minY + maxY) / 2, ...extra });
    centre.set(id, (minX + maxX) / 2);
    return id;
  }
  function sprite(map, legend, c0, r0) {
    const out = {};
    map.trim().split("\n").forEach((line, r) => [...line.trim()].forEach((ch, c) => {
      if (legend[ch]) (out[legend[ch]] ??= []).push([c0 + c, r0 + r]);
    }));
    return out;
  }
  /** Every colour of a sprite as its own layer; returns the ids. */
  async function draw(f, map, legend, c0, r0, name, extra) {
    const ids = [];
    for (const [col, cells] of Object.entries(sprite(map, legend, c0, r0))) ids.push(await pix(f, cells, col, `${name} ${col}`, extra));
    return ids;
  }
  return { P, X, Y, pix, sprite, draw, centre };
}
/** Sounds and voices that ship beside the template (apps/web/public/templates/playground). */
const ASSETS = globalThis.PLAYGROUND_ASSETS ?? "/templates/playground/";
async function sound(f, file, name, startMs = 0, folder = "Playground") {
  try {
    const r = await ac.media.import({ url: ASSETS + file, name, folder, place: { frameId: f.id, startMs } });
    if (r.clipId) await ac.layer.patch({ id: r.clipId, ops: [{ op: "set", path: "name", value: name }] });
    return r;
  } catch (e) {
    console.warn(`${name}: the sound did not load (${e.message}).`);
    return null;
  }
}
const named = (id, name) => ac.layer.patch({ id, ops: [{ op: "set", path: "name", value: name }] });

const EASE = { ui: "cubic-bezier(0.76,0,0.24,1)", out: "ease-out-expo", pop: "ease-out-back", zoom: "cubic-bezier(0.7,0,0.84,0)" };

/**
 * THE PROMPT CARD — a static design beside each scene: number + family, the
 * scene's name, what it shows, the exact prompt that made it, three ways to
 * remix it, and the techniques it uses. Laid out top-down from measured type.
 */
async function card(page, s, x, y, h) {
  const W = 760, M = 64, TW = W - 2 * M;
  const f = await comp({ name: `${s.no} · Prompt`, w: W, h, bg: C.ivory, mode: "static", dur: 1000, page, x, y });
  let cy = -h / 2 + M;
  const put = async (str, style, o = {}) => {
    const id = await text(f, str, { maxWidth: TW, ...o, style: { align: "left", ...style } });
    const b = await box(id);
    await pos(id, -W / 2 + M + b.width / 2, cy + b.height / 2);
    cy += b.height;
    return { id, b };
  };
  await put(`${s.no}  ·  ${s.family.toUpperCase()}`, { fontFamily: F.mono, fontSize: 20, color: C.clay, letterSpacing: 2, fontWeight: 600 }, { name: "Kicker" });
  cy += 16;
  await put(s.name, { fontFamily: F.serif, fontSize: 104, lineHeight: 1, letterSpacing: -2 }, { name: "Scene name" });
  cy += 20;
  await put(s.line, { fontSize: 26, color: C.mute, lineHeight: 1.4 }, { name: "What it shows" });
  cy += 48;
  await put("THE PROMPT", { fontFamily: F.mono, fontSize: 18, color: C.mute, letterSpacing: 3, fontWeight: 600 }, { name: "Prompt label" });
  cy += 16;
  const top = cy;
  const p = await put(s.prompt, { fontFamily: F.mono, fontSize: 21, lineHeight: 1.55, color: C.slate }, { name: "Prompt", maxWidth: TW - 28 });
  await pos(p.id, -W / 2 + M + 28 + p.b.width / 2, null);
  await rect(f, { name: "Prompt rule", width: 4, height: cy - top, cornerRadius: 2, fill: C.clay, x: -W / 2 + M + 2, y: (top + cy) / 2 });
  cy += 48;
  await put("REMIX IT", { fontFamily: F.mono, fontSize: 18, color: C.mute, letterSpacing: 3, fontWeight: 600 }, { name: "Remix label" });
  cy += 16;
  for (const [i, r] of s.remix.entries()) {
    await put(`→  ${r}`, { fontSize: 22, lineHeight: 1.45, color: C.slate }, { name: `Remix ${i + 1}` });
    cy += 12;
  }
  // Footer, pinned to the bottom edge.
  const foot = await text(f, `${s.tech}`, { name: "Techniques", maxWidth: TW, style: { fontFamily: F.mono, fontSize: 16, color: C.mute, lineHeight: 1.5, align: "left" } });
  const fb = await box(foot);
  const fy = h / 2 - M - fb.height / 2;
  await pos(foot, -W / 2 + M + fb.width / 2, fy);
  await rect(f, { name: "Footer rule", width: TW, height: 1.5, fill: C.oat, x: 0, y: fy - fb.height / 2 - 24 });
  const tag = await text(f, s.heavy ? "HEAVY" : "LIGHT", { name: "Weight", style: { fontFamily: F.mono, fontSize: 15, fontWeight: 700, letterSpacing: 2, color: s.heavy ? C.ivory : C.slate, highlight: { color: s.heavy ? C.clay : C.oat, radius: 6, paddingX: 10, paddingY: 5 } } });
  const tb = await box(tag);
  await pos(tag, W / 2 - M - tb.width / 2 - 10, -h / 2 + M + 12);
  if (cy > fy - fb.height / 2 - 48) console.warn(`${s.no}: card text runs into the footer by ${Math.round(cy - (fy - fb.height / 2 - 48))} px`);
  return f;
}

/**
 * One scene on the canvas: its comp at (x, y), its prompt card 48 px to the
 * right, same height. A scene file is `{ meta, w, h, dur, bg, fps, build(f) }`.
 */
async function place(def, page, x, y, ctx) {
  const f = await comp({ name: `${def.meta.no} · ${def.meta.name}`, w: def.w, h: def.h, bg: def.bg ?? C.ivory, dur: def.dur ?? 6000, fps: def.fps ?? 30, page, x, y, world: !!def.world });
  reseed(def.seed ?? 7);
  await def.build(f, ctx);
  await card(page, def.meta, x + def.w + 48, y, def.h);
  return { f, width: def.w + 48 + 760 };
}

return { place, pixels, sound, ASSETS, C, F, rand, reseed, comp, span, text, rect, ellipse, path, keys, fx, box, pos, set, named, card, EASE };
