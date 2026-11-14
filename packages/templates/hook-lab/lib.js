// HOOK LAB — the kit every hook builds with ("Ink & Clay").
//
// Paper and ink are human: they boil at 12 fps. Grey glass and the purple-blue
// "AI gradient" are the machine average: they glide at full frame rate and
// never boil. Clay is the heart and appears once per frame, at most.
//
// A scene file receives this as `L`. It holds the palette and type, the prompt
// card, and the objects the film is told with — the hook on a line, the title
// card, the eyes, the envelope, the thumb, the counter, the pencil and the
// cursor — each built here once and reused by every hook and by both films.
// `G` is glyphs.js: the hero face as outlines and a single-line script.

const C = {
  paper: "#F3EEE4", paperDeep: "#E6DFD2", ink: "#1D1B18", graphite: "#7C776E",
  clay: "#D97757", honey: "#EBC46B", grey: "#C9CCD3", greyDeep: "#8E93A0",
  aiA: "#998EE4", aiB: "#70ADDA", // #8B7CF6 → #5AB0F0 at 70 % saturation: only on slop
  envelope: "#E9E1D2", envelopeBack: "#D9CFBD", envelopeFlap: "#EFE8DB", envelopeEdge: "#B5A88F", wax: "#C9663F",
};
const F = { serif: "Fraunces", sans: "Inter", mono: "JetBrains Mono" };
const EASE = {
  out: "ease-out-expo", ui: "cubic-bezier(0.76,0,0.24,1)", zoom: "cubic-bezier(0.7,0,0.84,0)",
  machine: "ease-in-out", pop: "ease-out-back",
};
const FPS = 30, FRAME = 1000 / FPS;
const frame = (ms) => Math.round(ms / FRAME) * FRAME; // snap a time to the 30 fps grid

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const reseed = (s) => { seed = s; };
const jit = (a) => (rand() * 2 - 1) * a;

// ── Sound events ────────────────────────────────────────────────────────────
// Every thing with mass logs ev(t, kind, data) in comp ms. The film's sound
// pass mixes from these lists; nothing is placed by hand.
let EVENTS = [], HOOK = "";
const ev = (t, kind, data = {}) => { EVENTS.push({ t: Math.round(t), kind, hook: HOOK, ...data }); };

// ── Plain verbs ─────────────────────────────────────────────────────────────
async function comp({ name, w, h, bg = C.paper, dur = 6000, page, x = 0, y = 0, mode = "timeline", fps = FPS }) {
  const made = await ac.frame.create({ name, width: w, height: h, background: bg, durationMs: dur, pageId: page, mode, fps });
  const id = made.id ?? made.frameId;
  if (!id) throw new Error(`comp: no id in ${JSON.stringify(made)}`);
  await ac.frame.update({ id, ops: [{ op: "set", path: "x", value: x }, { op: "set", path: "y", value: y }, { op: "set", path: "loop", value: "loop" }] });
  return { id, w, h, dur };
}
const span = (f, o) => ({ frameId: f.id, startMs: 0, durationMs: f.dur, ...o, ...(o.startMs != null && o.durationMs == null ? { durationMs: f.dur - o.startMs } : {}) });
async function text(f, s, o = {}) {
  const { style = {}, ...rest } = o;
  return (await ac.layer.create({ kind: "text", text: s, ...span(f, rest), style: { fontFamily: F.sans, color: C.ink, ...style } })).id;
}
const rect = async (f, o) => (await ac.layer.create({ kind: "shape", shape: "rect", ...span(f, o) })).id;
const ellipse = async (f, o) => (await ac.layer.create({ kind: "shape", shape: "ellipse", ...span(f, o) })).id;
/** Stepped values (no hold easing exists): each change is a 1 ms ramp. [[t, v]…] → keys. */
const steps = (tv) => tv.flatMap(([t, v], i) => (i === 0 ? [[t, v]] : [[t - 1, tv[i - 1][1]], [t, v]]));
const keys = (id, property, k, clock = "layer") => ac.keyframes.set({ id, property, keys: k.map(([at, value, easing]) => (easing ? { at, value, easing } : { at, value })), clock });
const fx = (id, type, values) => ac.effects.add({ id, type, values });
const box = async (id) => (await ac.layer.get({ id, fields: ["box"] })).box;
const set = (id, values) => ac.layer.set({ ids: id, values, mode: "base" });
const pos = (id, x, y) => set(id, y == null ? { x } : { x, y });
const named = (id, name) => ac.layer.patch({ id, ops: [{ op: "set", path: "name", value: name }] });
const strokeId = async (id) => (await ac.layer.get({ id })).strokes[0].id;
const group = async (ids, name) => (await ac.layers.group({ ids, name })).groupId;
/**
 * Put a group's origin on its box centre without moving anything on screen.
 * Physics draws a group body by its centre, so a group whose origin is
 * elsewhere lands offset by the difference (FINDINGS A8). Call it before
 * keying the children. Returns the centre [x, y] in comp space.
 */
async function centreGroup(f, gid) {
  const find = (ls) => { for (const l of ls) { if (l.id === gid) return l; const c = l.children && find(l.children); if (c) return c; } return null; };
  const g = find((await ac.layers.list({ frameId: f.id, depth: 3 })).layers);
  const kids = g.children ?? [];
  const bb = (k) => k.bounds; // children report their bounds in the parent's space (a nested group too)
  const bx = (Math.min(...kids.map((k) => bb(k)[0])) + Math.max(...kids.map((k) => bb(k)[2]))) / 2;
  const by = (Math.min(...kids.map((k) => bb(k)[1])) + Math.max(...kids.map((k) => bb(k)[3]))) / 2;
  for (const k of kids) await set(k.id, { x: k.pos[0] - bx, y: k.pos[1] - by });
  await set(gid, { x: bx, y: by });
  return [bx, by];
}
/** Human things boil: Line boil at 12 fps, a few drawings. Never on machine things. */
const boil = (id, o = {}) => fx(id, "boil", { rate: 12, amount: 1.4, scale: 34, complexity: 2, variants: 3, seed: 1 + Math.floor(rand() * 90), ...o });

// ── Path geometry ───────────────────────────────────────────────────────────
// Kit paths are written in COMP coordinates and placed at their exact curve
// box centre, so the layer draws where the numbers say — and a joint anchor on
// a path (which lives in its d space) is simply a comp point.
const num = (v) => +v.toFixed(2);
function parse(d) { // → [{cmd, pts:[[x,y]…]}] absolute M L Q C Z
  const out = [], tok = d.match(/[MLHVQCZmlhvqcz]|-?\d*\.?\d+(?:e-?\d+)?/g);
  let i = 0, cmd = "", cx = 0, cy = 0, sx = 0, sy = 0;
  const n = () => +tok[i++];
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    const C2 = cmd.toUpperCase(), rel = cmd !== C2;
    const P = () => { const x = n() + (rel ? cx : 0), y = n() + (rel ? cy : 0); return [x, y]; };
    if (C2 === "Z") { out.push({ cmd: "Z", pts: [] }); cx = sx; cy = sy; continue; }
    if (C2 === "M") { const p = P(); out.push({ cmd: "M", pts: [p] }); [cx, cy] = [sx, sy] = p; cmd = rel ? "l" : "L"; continue; }
    if (C2 === "L") { const p = P(); out.push({ cmd: "L", pts: [p] }); [cx, cy] = p; continue; }
    if (C2 === "H") { const x = n() + (rel ? cx : 0); out.push({ cmd: "L", pts: [[x, cy]] }); cx = x; continue; }
    if (C2 === "V") { const y = n() + (rel ? cy : 0); out.push({ cmd: "L", pts: [[cx, y]] }); cy = y; continue; }
    if (C2 === "Q") { const a = P(), b = P(); out.push({ cmd: "Q", pts: [a, b] }); [cx, cy] = b; continue; }
    if (C2 === "C") { const a = P(), b = P(), c = P(); out.push({ cmd: "C", pts: [a, b, c] }); [cx, cy] = c; continue; }
    throw new Error(`parse: unsupported ${cmd}`);
  }
  return out;
}
const write = (segs) => segs.map((s) => s.cmd + s.pts.map(([x, y]) => `${num(x)} ${num(y)}`).join(" ")).join("");
const transform = (d, s, tx, ty) => write(parse(d).map((g) => ({ cmd: g.cmd, pts: g.pts.map(([x, y]) => [x * s + tx, y * s + ty]) })));
/** Split every curve into n exact pieces (de Casteljau): more anchors, same drawing — for shapes that morph. */
function densify(d, n = 3) {
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const out = [];
  let c = [0, 0];
  for (const sg of parse(d)) {
    if (sg.cmd === "Q") { const [q1, q2] = sg.pts; sg.cmd = "C"; sg.pts = [lerp(c, q1, 2 / 3), lerp(q2, q1, 2 / 3), q2]; }
    if (sg.cmd === "C") {
      let [p0, p1, p2, p3] = [c, ...sg.pts];
      for (let i = n; i >= 1; i--) {
        const t = 1 / i;
        const a = lerp(p0, p1, t), b = lerp(p1, p2, t), e = lerp(p2, p3, t), ab = lerp(a, b, t), be = lerp(b, e, t), m = lerp(ab, be, t);
        out.push({ cmd: "C", pts: [a, ab, m] });
        [p0, p1, p2] = [m, be, e];
      }
      c = p3;
      continue;
    }
    out.push(sg);
    if (sg.pts.length) c = sg.pts[sg.pts.length - 1];
  }
  return write(out);
}
/** The exact box of the curves (not of their control points). */
function dBox(d) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, c = [0, 0];
  const add = ([x, y]) => { l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y); };
  const roots = (a, b2, c2) => { // of a t² + b t + c in (0,1)
    if (Math.abs(a) < 1e-9) return Math.abs(b2) < 1e-9 ? [] : [-c2 / b2];
    const D = b2 * b2 - 4 * a * c2; if (D < 0) return [];
    return [(-b2 + Math.sqrt(D)) / (2 * a), (-b2 - Math.sqrt(D)) / (2 * a)];
  };
  for (const s of parse(d)) {
    if (s.cmd === "M" || s.cmd === "L") { add(s.pts[0]); c = s.pts[0]; }
    else if (s.cmd === "Q") {
      const [p1, p2] = s.pts; add(p2);
      for (const k of [0, 1]) { const den = c[k] - 2 * p1[k] + p2[k]; if (den) { const u = (c[k] - p1[k]) / den; if (u > 0 && u < 1) add([0, 1].map((j) => (1 - u) ** 2 * c[j] + 2 * (1 - u) * u * p1[j] + u * u * p2[j])); } }
      c = p2;
    } else if (s.cmd === "C") {
      const [p1, p2, p3] = s.pts; add(p3);
      for (const k of [0, 1]) for (const u of roots(-c[k] + 3 * p1[k] - 3 * p2[k] + p3[k], 2 * (c[k] - 2 * p1[k] + p2[k]), p1[k] - c[k])) {
        if (u > 0 && u < 1) add([0, 1].map((j) => (1 - u) ** 3 * c[j] + 3 * (1 - u) ** 2 * u * p1[j] + 3 * (1 - u) * u * u * p2[j] + u ** 3 * p3[j]));
      }
      c = p3;
    }
  }
  return { l, t, r, b, w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
}
/** A path layer whose d is in comp coordinates. */
async function path(f, d, o = {}) {
  const bx = dBox(d);
  const id = (await ac.layer.create({ kind: "path", d, ...span(f, { x: bx.cx, y: bx.cy, ...o }) })).id;
  return id;
}
/** Catmull-Rom through points → cubic d (open), with a tension of 1/6. */
function smooth(pts, closed = false) {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${num(pts[0][0])} ${num(pts[0][1])}L${num(pts[1][0])} ${num(pts[1][1])}`;
  const P = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  let d = `M${num(P[1][0])} ${num(P[1][1])}`;
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    d += `C${num(p1[0] + (p2[0] - p0[0]) / 6)} ${num(p1[1] + (p2[1] - p0[1]) / 6)} ${num(p2[0] - (p3[0] - p1[0]) / 6)} ${num(p2[1] - (p3[1] - p1[1]) / 6)} ${num(p2[0])} ${num(p2[1])}`;
  }
  return d + (closed ? "Z" : "");
}
const plen = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
/** Subpaths as the app stores them → d (cubics). */
const subD = (subs) => subs.map((s) => {
  const p = s.points, h = (q, k) => (q[k] ? [q[k].x, q[k].y] : [q.x, q.y]);
  let d = `M${num(p[0].x)} ${num(p[0].y)}`;
  const seg = (a, b) => { const o = h(a, "hOut"), i = h(b, "hIn"); d += `C${num(o[0])} ${num(o[1])} ${num(i[0])} ${num(i[1])} ${num(b.x)} ${num(b.y)}`; };
  for (let i = 1; i < p.length; i++) seg(p[i - 1], p[i]);
  if (s.closed) { seg(p[p.length - 1], p[0]); d += "Z"; }
  return d;
}).join("");

// ── Type ────────────────────────────────────────────────────────────────────
// Fraunces at SOFT 100 / WONK 1 is the film's voice, but a text layer can't set
// font axes — so hero type is drawn from the font's own outlines (glyphs.js).
// Outlines are also exact: their box IS the ink, so placement is measured.
const FR = G.FRAUNCES;
function heroRun(str, size, track = -0.04) {
  const s = size / FR.em, chars = [...str], out = [];
  let x = 0;
  chars.forEach((ch, i) => {
    const g = FR.g[ch] ?? FR.g[ch.toUpperCase()];
    if (!g) throw new Error(`hero: no outline for "${ch}" (glyphs.js has ${Object.keys(FR.g).join("")})`);
    if (i > 0) x += (FR.k[chars[i - 1] + ch] ?? 0) * s;
    if (g[2]) out.push({ ch, x, d: transform(g[1], s, x, 0) });
    x += g[0] * s + (i < chars.length - 1 ? track * size : 0) + (ch === " " ? 0.1 * size : 0); // tight tracking needs a wider word space
  });
  return out;
}
/**
 * Hero type: outlines placed so the INK centre lands on (x, y). `split` puts
 * the named characters on layers of their own (the O's that become eyes).
 * Returns { ids, parts: [{id, ch, d, box}], ink } — boxes in comp space.
 */
async function hero(f, str, o = {}) {
  const { size = 184, track = -0.04, color = C.ink, x = 0, y = 0, split = "", name = str, ...rest } = o;
  const glyphs = heroRun(str, size, track);
  const all = dBox(glyphs.map((g) => g.d).join(""));
  const dx = x - all.cx, dy = y - all.cy;
  const groups = [];
  let run = null;
  for (const g of glyphs) {
    if (split.includes(g.ch)) { groups.push({ ch: g.ch, ds: [densify(g.d, 3)] }); run = null; } // split glyphs morph: give them anchors
    else { if (!run) groups.push((run = { ch: "", ds: [] })); run.ch += g.ch; run.ds.push(g.d); }
  }
  const parts = [];
  for (const gr of groups) {
    const d = transform(gr.ds.join(""), 1, dx, dy);
    const id = await path(f, d, { name: `${name} · ${gr.ch}`, fill: color, ...rest });
    parts.push({ id, ch: gr.ch, d, box: dBox(d) });
  }
  return { ids: parts.map((p) => p.id), parts, ink: { l: all.l + dx, t: all.t + dy, r: all.r + dx, b: all.b + dy, w: all.w, h: all.h } };
}
/** Ink metrics of a hero string without drawing it. */
const heroInk = (str, size, track = -0.04) => dBox(heroRun(str, size, track).map((g) => g.d).join(""));

// ── Handwriting (the pencil) ────────────────────────────────────────────────
// A text layer can't write itself on (FINDINGS A1), so handwriting is a single
// -line script (Hershey Script Simplex, glyphs.js) turned into smooth strokes
// and drawn on with Draw On (stroke trim), at a pen's speed, stroke by stroke.
const HS = G.SCRIPT;
/** → { strokes: [[x,y]…] in px around (0,0) baseline-left, words: [first stroke index], width } */
function scriptStrokes(str, size, o = {}) {
  const u = size / 21, wob = o.wobble ?? 0.22;
  const strokes = [], words = [0];
  let x = 0;
  for (const [ci, ch] of [...str].entries()) {
    const g = HS[ch] ?? HS["?"];
    if (ch === " ") { x += (g[1] - g[0]) * u * 0.8; words.push(strokes.length); continue; }
    const lift = jit(0.5) * u, sc = 1 + jit(0.03);
    for (const s of g[2]) {
      const pts = [];
      for (let i = 0; i < s.length; i += 2) pts.push([x + ((s[i] - g[0]) * sc + jit(wob)) * u, ((s[i + 1] - 9) * sc + jit(wob)) * u + lift]);
      strokes.push(pts);
    }
    x += (g[1] - g[0]) * u * (/\d/.test(ch) && /\d/.test(str[ci + 1] ?? "") ? 0.72 : 1); // Hershey sets figures wide: a hand doesn't
  }
  return { strokes, words, width: x };
}
/**
 * The pencil writes `src` (a string, or {strokes} of [[x,y]…] in px around
 * 0,0) with its ink-box centre at (x, y), starting at `startMs`, at `speed`
 * px/s with pen lifts between strokes. Graphite, boiling. Logs a 'pen' event
 * per stroke with its length and duration (the scratch follows the speed).
 */
async function pencil(f, src, o = {}) {
  const { x = 0, y = 0, size = 72, startMs = 0, speed = 640, lift = 60, wordGap = 170, color = C.graphite, width = Math.max(2.5, size / 17), name = "Pencil", durationMs, boil: doBoil = true } = o;
  const sc = typeof src === "string" ? scriptStrokes(src, size, o) : { strokes: src.strokes, words: src.words ?? [0] };
  const all = sc.strokes.flat();
  const bx = { l: Math.min(...all.map((p) => p[0])), r: Math.max(...all.map((p) => p[0])), t: Math.min(...all.map((p) => p[1])), b: Math.max(...all.map((p) => p[1])) };
  const keep = o.keep ?? (typeof src !== "string" && o.x == null); // strokes given in comp px stay where they are
  const ox = keep ? 0 : x - (bx.l + bx.r) / 2, oy = keep ? 0 : y - (bx.t + bx.b) / 2;
  const strokes = sc.strokes.map((s) => s.map(([px, py]) => [px + ox, py + oy]));
  const d = strokes.map((s) => smooth(s)).join("");
  const id = await path(f, d, { name, fill: null, startMs, durationMs, stroke: { paint: { type: "solid", color }, width, cap: "round", join: "round", roughness: { amount: 0.5, scale: 6 } } });
  if (doBoil) await boil(id, { amount: 1, scale: 26 });
  // Schedule: one stroke after another, a pen lift between, a longer one between words.
  const lens = strokes.map(plen), total = lens.reduce((a, b) => a + b, 0);
  // Pen lifts: none where cursive letters join (the next stroke starts where this one ended),
  // a short one inside a word, a longer one between words. `durMs` fits the writing, lifts included.
  const gapBefore = (i) => {
    if (i === 0) return 0;
    if (sc.words.includes(i)) return wordGap;
    const a = strokes[i - 1][strokes[i - 1].length - 1], b = strokes[i][0];
    return Math.hypot(a[0] - b[0], a[1] - b[1]) < size * 0.22 ? 0 : lift; // Hershey letters meet within ~0.2 em
  };
  const lifts = strokes.reduce((acc, _, i) => acc + gapBefore(i), 0);
  const v = o.durMs ? total / Math.max(0.1, (o.durMs - lifts) / 1000) : speed;
  const sched = [];
  let t = 0;
  strokes.forEach((s, i) => {
    t += gapBefore(i);
    const dur = (lens[i] / v) * 1000;
    sched.push({ t0: t, t1: t + dur, a: lens.slice(0, i).reduce((p, q) => p + q, 0), len: lens[i] });
    ev(startMs + t, "pen", { lengthPx: Math.round(lens[i]), durMs: Math.round(dur), speed: Math.round(v) });
    t += dur;
  });
  const st = await strokeId(id), k = [];
  for (let ms = 0; ms <= t + FRAME; ms += FRAME) {
    let drawn = 0;
    for (const s of sched) drawn = ms >= s.t1 ? s.a + s.len : ms > s.t0 ? s.a + s.len * ((ms - s.t0) / (s.t1 - s.t0)) : drawn;
    k.push([Math.round(ms), +(drawn / total).toFixed(4)]);
  }
  await keys(id, `stroke.${st}.trim.end`, k);
  return { id, endMs: startMs + t, box: { l: bx.l + ox, r: bx.r + ox, t: bx.t + oy, b: bx.b + oy } };
}
/** A hand-drawn arrow from a to b (comp px), bowed by `bend`, drawn on by the pencil. */
function arrowStrokes(a, b, bend = 0.25, head = 22) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, nx = -(b[1] - a[1]) * bend, ny = (b[0] - a[0]) * bend;
  const shaft = [];
  for (let i = 0; i <= 8; i++) {
    const u = i / 8, cx = mx + nx, cy = my + ny;
    shaft.push([(1 - u) ** 2 * a[0] + 2 * (1 - u) * u * cx + u * u * b[0] + jit(1.2), (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * cy + u * u * b[1] + jit(1.2)]);
  }
  const [p, q] = [shaft[7], shaft[8]], ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
  const wing = (s) => [[q[0] + Math.cos(ang + Math.PI - s) * head, q[1] + Math.sin(ang + Math.PI - s) * head], [q[0], q[1]]];
  return [shaft, [...wing(0.5), [q[0] + Math.cos(ang + Math.PI + 0.45) * head * 0.95, q[1] + Math.sin(ang + Math.PI + 0.45) * head * 0.95]]];
}

// ── The hook on a line ──────────────────────────────────────────────────────
/**
 * One ink line from above the frame to a fishing hook. The hook is two layers so
 * a card can hang THROUGH it: `front` (eye, shank, the near half of the bend)
 * sits in front of the card, `back` (the far half, the point, the barb)
 * behind it. `pivot` is the bottom of the bend: where a hole rests.
 * Everything is ink and boils.
 */
function hookGeometry(ex, ey, k = 1) {
  const P = (x, y) => `${num(ex + x * k)} ${num(ey + y * k)}`;
  const r = 8;
  const eye = `M${P(0, -r)}C${P(r * 0.55, -r)} ${P(r, -r * 0.55)} ${P(r, 0)}C${P(r, r * 0.55)} ${P(r * 0.55, r)} ${P(0, r)}C${P(-r * 0.55, r)} ${P(-r, r * 0.55)} ${P(-r, 0)}C${P(-r, -r * 0.55)} ${P(-r * 0.55, -r)} ${P(0, -r)}Z`;
  return {
    eye,
    front: `${eye}M${P(0, r)}L${P(0, 112)}C${P(0, 130)} ${P(-11.5, 139)} ${P(-23, 139)}`,
    back: `M${P(-23, 139)}C${P(-34.5, 139)} ${P(-46, 130)} ${P(-46, 112)}L${P(-46, 66)}L${P(-36.5, 85)}`,
    pivot: [ex - 23 * k, ey + 139 * k], wire: 9 * k, height: 147 * k,
  };
}
async function line(f, o = {}) {
  const { x = 0, eyeY = -380, top = -f.h / 2 - 90, k = 1, startMs = 0, durationMs, name = "Line", lineWidth = 4, behind } = o;
  const hk = hookGeometry(x, eyeY, k);
  const common = { startMs, durationMs, fill: null };
  const strokeOf = (w) => ({ paint: { type: "solid", color: C.ink }, width: w, cap: "round", join: "round" });
  const back = await path(f, hk.back, { ...common, name: `${name} · hook (back)`, stroke: strokeOf(hk.wire) });
  if (behind) await ac.layers.restack({ ids: [back], to: { below: behind } });
  const ln = await path(f, `M${x} ${top}L${x} ${num(eyeY - 8 * k)}`, { ...common, name: `${name} · line`, stroke: { ...strokeOf(lineWidth), profile: { startWidth: 0.7, endWidth: 1, startLength: 0.5, endLength: 0.2, ease: 0 } } });
  const front = await path(f, hk.front, { ...common, name: `${name} · hook`, stroke: strokeOf(hk.wire) });
  for (const id of [ln, front, back]) await boil(id, { amount: 1.2, scale: 40, seed: 11 });
  return { line: ln, front, back, pivot: hk.pivot, eye: [x, eyeY], top, ids: [back, ln, front] };
}

// ── The title card (the video itself) ───────────────────────────────────────
/**
 * A 1:1 paper card with a punched, ink-ringed hole at the top, "12" in clay
 * over HOOKS, and an italic line. Its O's are their own outlines (they become
 * eyes in 02). Built in comp space with its hole centred under `pivot`.
 * Returns { group, ids, os, hole, top, size }.
 */
const CARD = { size: 760, title: 184, hole: 21, margin: 78, gap12: 40, gapSub: 42, sub: 50 };
async function titleCard(f, o = {}) {
  const { pivot = [0, -256], name = "Card", startMs = 0, durationMs, kicker = "12", word = "HOOKS", sub = "that keep people watching" } = o;
  const S = CARD.size, R = CARD.hole;
  const hx = pivot[0], hy = pivot[1] + R - 5; // the hole's top edge rests on the wire
  const top = hy - R - CARD.margin, cx = pivot[0], cy = top + S / 2;
  const common = { startMs, durationMs };
  // Paper with a real hole (even-odd), so whatever is behind shows through it.
  const r = 18, L0 = cx - S / 2, R0 = cx + S / 2, T0 = top, B0 = top + S;
  const k = 0.5523 * R;
  const paperD = `M${L0 + r} ${T0}L${R0 - r} ${T0}C${R0 - r * 0.45} ${T0} ${R0} ${T0 + r * 0.45} ${R0} ${T0 + r}L${R0} ${B0 - r}C${R0} ${B0 - r * 0.45} ${R0 - r * 0.45} ${B0} ${R0 - r} ${B0}L${L0 + r} ${B0}C${L0 + r * 0.45} ${B0} ${L0} ${B0 - r * 0.45} ${L0} ${B0 - r}L${L0} ${T0 + r}C${L0} ${T0 + r * 0.45} ${L0 + r * 0.45} ${T0} ${L0 + r} ${T0}Z`
    + `M${hx} ${hy - R}C${hx + k} ${hy - R} ${hx + R} ${hy - k} ${hx + R} ${hy}C${hx + R} ${hy + k} ${hx + k} ${hy + R} ${hx} ${hy + R}C${hx - k} ${hy + R} ${hx - R} ${hy + k} ${hx - R} ${hy}C${hx - R} ${hy - k} ${hx - k} ${hy - R} ${hx} ${hy - R}Z`;
  const paper = await path(f, paperD, { ...common, name: `${name} · paper`, fill: C.paperDeep, stroke: { paint: { type: "solid", color: "#D3CAB9" }, width: 2, align: "inside" } });
  await ac.layer.patch({ id: paper, ops: [{ op: "set", path: "fillRule", value: "evenodd" }] });
  const ring = await path(f, `M${hx} ${hy - R - 3}C${hx + k + 2} ${hy - R - 3} ${hx + R + 3} ${hy - k - 2} ${hx + R + 3} ${hy}C${hx + R + 3} ${hy + k + 2} ${hx + k + 2} ${hy + R + 3} ${hx} ${hy + R + 3}C${hx - k - 2} ${hy + R + 3} ${hx - R - 3} ${hy + k + 2} ${hx - R - 3} ${hy}C${hx - R - 3} ${hy - k - 2} ${hx - k - 2} ${hy - R - 3} ${hx} ${hy - R - 3}Z`, { ...common, name: `${name} · eyelet`, fill: null, stroke: { paint: { type: "solid", color: C.ink }, width: 3.5 } });
  // The type stack, measured from the outlines (and the italic line's box).
  const ink12 = heroInk(kicker, CARD.title), inkW = heroInk(word, CARD.title);
  const subId = await text(f, sub, { ...common, name: `${name} · line`, style: { fontFamily: F.serif, fontSize: CARD.sub, italic: true, fontWeight: 500, color: C.ink, lineHeight: 1 } });
  const sb = await box(subId);
  // At line-height 1 the italic's ink fills its line box: ascender top ≈ 0.02 em under the box
  // top, descender bottom ≈ 0.04 em over the box bottom (measured on an inspect render).
  const subInkH = sb.height * (1 - 0.02 - 0.04);
  const stackH = ink12.h + CARD.gap12 + inkW.h + CARD.gapSub + subInkH;
  const holeBottom = hy + R;
  const yTop = holeBottom + (B0 - holeBottom - stackH) / 2 - 8; // optical: a touch above centre
  const n12 = await hero(f, kicker, { ...common, size: CARD.title, color: C.clay, x: cx, y: yTop + ink12.h / 2, name: `${name} · ${kicker}` });
  const nW = await hero(f, word, { ...common, size: CARD.title, x: cx, y: yTop + ink12.h + CARD.gap12 + inkW.h / 2, split: "O", name: `${name} · ${word}` });
  const subTop = yTop + ink12.h + CARD.gap12 + inkW.h + CARD.gapSub;
  await pos(subId, cx, subTop - sb.height * 0.02 + sb.height / 2);
  const ids = [paper, ring, ...n12.ids, ...nW.ids, subId];
  const g = await group(ids, name);
  const origin = await centreGroup(f, g);
  return { group: g, ids, paper, os: nW.parts.filter((p) => p.ch === "O"), word: nW, hole: [hx, hy], top, cy, size: S, origin };
}

// ── The eyes (the O's that look at you) ─────────────────────────────────────
/**
 * Eyes in two O outlines: pupils (ink dots) live UNDER each O so its ring
 * hides what's outside the counter. `look(t, [dx,dy])` moves both pupils
 * (fractions of the counter's half-size) with the second eye `lag` ms late;
 * `blink(t)` swaps each O for a 12 fps flipbook of its own lids; the squint
 * is a shape key on each O ("Squint", weight 0→1), the lower lid rising.
 */
function counterOf(subs) { // the inner contour = the one with the smaller box
  const bb = (s) => { const xs = s.points.map((p) => p.x), ys = s.points.map((p) => p.y); return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) }; };
  const boxes = subs.map(bb), area = (b) => (b.r - b.l) * (b.b - b.t);
  const i = boxes.reduce((m, b, j) => (area(b) < area(boxes[m]) ? j : m), 0);
  const b = boxes[i];
  return { index: i, ...b, cx: (b.l + b.r) / 2, cy: (b.t + b.b) / 2, w: b.r - b.l, h: b.b - b.t };
}
/**
 * Lids: the counter redrawn as the paper left between an upper lid (fraction
 * closed from the top, drooping a little in the middle) and a lower lid
 * (fraction from the bottom; `smile` lifts its middle — the smug squint). Each
 * of the counter's anchors keeps its angle from the centre, so the shape key
 * morphs point to point without twisting; handles are Catmull-Rom.
 */
function lidded(subs, ci, { upper = 0, lower = 0, smile = 0, droop = 0.04 }) {
  const c = counterOf(subs), hw = c.w / 2, hh = c.h / 2;
  const bell = (x) => Math.max(0, 1 - ((x - c.cx) / hw) ** 2);
  const yU = (x) => c.t + c.h * upper + droop * c.h * bell(x) * (upper > 0 ? 1 : 0);
  const yL = (x) => c.b - c.h * lower - smile * c.h * bell(x);
  const inside = (x, y) => ((x - c.cx) / hw) ** 2 + ((y - c.cy) / hh) ** 2 <= 1 && y >= yU(x) && y <= yL(x);
  const yc = (yU(c.cx) + yL(c.cx)) / 2;
  const pts = subs[ci].points.map((p) => {
    const a = Math.atan2(p.y - c.cy, p.x - c.cx);
    let lo = 0, hi = Math.max(c.w, c.h);
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (inside(c.cx + Math.cos(a) * m, yc + Math.sin(a) * m)) lo = m; else hi = m; }
    return [c.cx + Math.cos(a) * lo, yc + Math.sin(a) * lo];
  });
  const n = pts.length;
  const points = pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n], tx = (b[0] - a[0]) / 6, ty = (b[1] - a[1]) / 6;
    return { x: p[0], y: p[1], hIn: { x: p[0] - tx, y: p[1] - ty }, hOut: { x: p[0] + tx, y: p[1] + ty } };
  });
  return subs.map((s, i) => (i !== ci ? s : { closed: true, points }));
}
const flipbooks = new Map(); // one blink sheet per eye shape, shared by every hook that uses it
async function blinkSheet(eye, kitPage) {
  const key = `${Math.round(eye.box.w)}x${Math.round(eye.box.h)}`;
  if (flipbooks.has(key)) return flipbooks.get(key);
  const W = Math.ceil(eye.box.w + 8), H = Math.ceil(eye.box.h + 8);
  const fb = await ac.frame.create({ name: `Eyes · blink (${key})`, width: W, height: H, background: "#00000000", durationMs: 250, pageId: kitPage, mode: "flipbook", fps: 12 });
  const fid = fb.id ?? fb.frameId;
  await ac.frame.update({ id: fid, ops: [{ op: "set", path: "x", value: 2400 + flipbooks.size * 260 }, { op: "set", path: "y", value: 1500 }] });
  let sheet = await ac.flipbook.cells({ id: fid });
  await ac.flipbook.edit({ id: fid, ops: [{ op: "hold", cellId: sheet.rows[0].cells[0].id, frames: 1 }, { op: "add", count: 2, hold: 1 }] });
  sheet = await ac.flipbook.cells({ id: fid });
  const poses = [{ upper: 0.42, lower: 0.06 }, { upper: 0.64, lower: 0.30 }, { upper: 0.30, lower: 0.04 }]; // half · shut (a slit) · half
  for (const [i, cell] of sheet.rows[0].cells.entries()) {
    const d = subD(lidded(eye.subs, eye.counter.index, poses[i]));
    const bx = dBox(d);
    await ac.layer.create({ kind: "path", frameId: cell.drawingId, d, fill: C.ink, x: 0 + (bx.cx - eye.box.cx), y: 0 + (bx.cy - eye.box.cy), startMs: 0, durationMs: 1000, name: ["half", "shut", "half"][i] });
  }
  const out = { id: fid, durMs: 250 };
  flipbooks.set(key, out);
  return out;
}
async function eyes(f, os, o = {}) {
  const { startMs = 0, durationMs = f.dur - startMs, pupil = 0.44, kitPage, name = "Eyes", origin = [0, 0] } = o;
  const [ox, oy] = origin; // layers made inside a group are placed relative to its origin
  const E = [];
  for (const [i, part] of os.entries()) {
    const subs = (await ac.layer.get({ id: part.id, fields: ["subpaths"] })).subpaths;
    const counter = counterOf(subs);
    // counter in comp space (subpaths are in the layer's d space = comp space at rest)
    const pr = Math.min(counter.w, counter.h) * pupil / 2;
    const p = await ellipse(f, { name: `${name} · pupil ${i + 1}`, width: pr * 2, height: pr * 2 * 1.08, fill: C.ink, x: counter.cx - ox, y: counter.cy - oy, startMs, durationMs, placement: { below: part.id } });
    E.push({ part, subs, counter, pupil: p, pr, box: part.box, layer: part.id });
  }
  const reach = (e, [dx, dy]) => [e.counter.cx - ox + dx * (e.counter.w / 2 - e.pr * 0.9), e.counter.cy - oy + dy * (e.counter.h / 2 - e.pr * 1.05)];
  const pk = new Map(E.map((e) => [e.pupil, { x: [], y: [], s: [], rest: [e.counter.cx - ox, e.counter.cy - oy] }]));
  const api = {
    E,
    /** pupils appear (grow from nothing) at t, already looking `dir` */
    appear(t, dir = [0, 0]) {
      for (const e of E) { const [x, y] = reach(e, dir), k = pk.get(e.pupil); k.x.push([t, x]); k.y.push([t, y]); k.s.push([t, 0, EASE.pop], [t + 200, 1]); }
    },
    look(t, dir, dur = 450, lag = 100, ease = "ease-in-out") {
      E.forEach((e, i) => { const [x, y] = reach(e, dir), k = pk.get(e.pupil), t0 = t + i * lag; k.x.push([t0, null, ease], [t0 + dur, x]); k.y.push([t0, null, ease], [t0 + dur, y]); });
    },
    async blink(t) {
      ev(t, "blink");
      for (const e of E) {
        const sheet = await blinkSheet(e, kitPage);
        const inst = (await ac.layer.create({ kind: "comp", sourceFrameId: sheet.id, frameId: f.id, startMs: t, durationMs: sheet.durMs, x: e.box.cx - ox, y: e.box.cy - oy, name: `${name} · blink`, placement: { above: e.layer } })).id;
        // the O itself steps aside while its lids play
        await keys(e.layer, "opacity", steps([[0, 1], [t, 0], [t + sheet.durMs, 1]]), "comp");
        // no pupil shows through the shut slit
        const k = pk.get(e.pupil); k.o = (k.o ?? []).concat([[t + 83, 0], [t + 167, 1]]);
      }
    },
    /**
     * The squint: a shape key on each O ("Squint"), made once, keyed from `from`
     * to `to` over `dur`. The pupils ride into what's left of the eye (and back).
     */
    async squint(t, dur = 260, { lower = 0.4, upper = 0, smile = 0.1, from = 0, to = 1, pupilScale = 0.8 } = {}) {
      // Peak of the lower lid ≈ half the counter (lower + smile = 0.5), its edge a gentle smile; the
      // pupils stay whole dots resting just above it — smug, not an O filling with ink.
      if (to > from) ev(t, "squint");
      for (const e of E) {
        if (!e.squintKey) {
          const target = lidded(e.subs, e.counter.index, { upper, lower, smile, droop: 0 })[e.counter.index].points;
          const points = target.map((p, index) => ({ contour: e.counter.index, index, x: p.x, y: p.y, hIn: [p.hIn.x, p.hIn.y], hOut: [p.hOut.x, p.hOut.y] }));
          const sk = await ac.shapekey.create({ id: e.layer, name: "Squint", points });
          e.squintKey = sk.id ?? sk.keyId ?? sk.key?.id ?? "Squint";
          const c = e.counter;
          e.squintY = c.b - c.h * (lower + smile) - e.pr * pupilScale * 1.08 - 4 - oy; // a whole (smaller) pupil just above the lid's peak
          e.sk = [];
        }
        e.sk.push([t, from, to > from ? "ease-out" : "ease-in-out"], [t + dur, to]);
        const k = pk.get(e.pupil), y0 = e.counter.cy - oy;
        k.y.push([t, from ? e.squintY : null, "ease-out"], [t + dur, to ? e.squintY : y0]);
        k.s.push([t, from ? pupilScale : 1, "ease-out"], [t + dur, to ? pupilScale : 1]);
      }
    },
    /** write every pupil key collected so far */
    async commit() {
      for (const [id, k] of pk) {
        // a key with no value holds where the pupil already is (or its rest, at the start)
        const sorted = (arr, rest) => { let last = rest; return arr.sort((a, b) => a[0] - b[0]).map(([t, v, e]) => { if (v == null) v = last; last = v; return [t, v, e]; }); };
        if (k.x.length) await keys(id, "x", sorted(k.x, k.rest[0]), "comp");
        if (k.y.length) await keys(id, "y", sorted(k.y, k.rest[1]), "comp");
        if (k.s.length) await keys(id, "scale", sorted(k.s, 1), "comp");
        if (k.o) await keys(id, "opacity", steps([[0, 1], ...k.o]), "comp");
      }
      for (const e of E) if (e.sk) await keys(e.layer, `key.${e.squintKey}`, e.sk.sort((a, b) => a[0] - b[0]), "comp");
    },
  };
  return api;
}

// ── The puff (a cartoon dust cloud) ─────────────────────────────────────────
/**
 * A boiled ink puff in three 12 fps drawings — peeking, full, breaking up —
 * built once as a flipbook (on the Kit page) and nested wherever something
 * lands. `puffAt(f, x, y, t, s)` places one with its base at (x, y).
 */
let puffSheet = null;
function cloudD(cx, cy, R, bumps, seed0) {
  const pts = [];
  for (let i = 0; i < 22; i++) {
    const a = Math.PI + (i / 21) * Math.PI; // the top half: a puff rising from behind an edge
    const r = R * (1 + 0.16 * Math.abs(Math.sin(a * bumps + seed0)));
    pts.push([cx + Math.cos(a) * r * 1.25, cy + Math.sin(a) * r]);
  }
  return smooth(pts) + `L${num(cx + R * 1.25)} ${num(cy + R * 0.25)}L${num(cx - R * 1.25)} ${num(cy + R * 0.25)}Z`;
}
async function puffFlipbook(kitPage) {
  if (puffSheet) return puffSheet;
  const W = 420, H = 260;
  const fb = await ac.frame.create({ name: "Puff · 12 fps", width: W, height: H, background: "#00000000", durationMs: 250, pageId: kitPage, mode: "flipbook", fps: 12 });
  const fid = fb.id ?? fb.frameId;
  await ac.frame.update({ id: fid, ops: [{ op: "set", path: "x", value: 2400 }, { op: "set", path: "y", value: 1800 }] });
  let sheet = await ac.flipbook.cells({ id: fid });
  await ac.flipbook.edit({ id: fid, ops: [{ op: "hold", cellId: sheet.rows[0].cells[0].id, frames: 1 }, { op: "add", count: 2, hold: 1 }] });
  sheet = await ac.flipbook.cells({ id: fid });
  const base = H / 2 - 10; // drawings sit on the sheet's bottom edge
  const cells = [
    [cloudD(0, base, 52, 4, 0.3)],
    [cloudD(-40, base, 74, 5, 1.1), cloudD(70, base - 6, 58, 4, 2.2)],
    [cloudD(-110, base - 70, 26, 3, 0.7), cloudD(20, base - 96, 34, 3, 1.9), cloudD(120, base - 58, 22, 3, 2.8)],
  ];
  for (const [i, cell] of sheet.rows[0].cells.entries()) {
    const fc = { id: cell.drawingId, dur: 1000 };
    for (const d of cells[i]) {
      const id = await path(fc, d, { name: "puff", fill: C.paper, stroke: { paint: { type: "solid", color: C.ink }, width: 5, join: "round", cap: "round" } });
      await boil(id, { amount: 1.6, scale: 26 });
    }
  }
  puffSheet = { id: fid, durMs: 250, h: H };
  return puffSheet;
}
async function puffAt(f, x, y, t, s = 1, kitPage) {
  const sheet = await puffFlipbook(kitPage);
  ev(t, "puff", { scale: s });
  return (await ac.layer.create({ kind: "comp", sourceFrameId: sheet.id, frameId: f.id, startMs: t, durationMs: sheet.durMs, x, y: y - (sheet.h / 2) * s + 10 * s, name: "Puff", set: { scale: s } })).id;
}

// ── The envelope (the open loop) ────────────────────────────────────────────
/**
 * A paper-cut envelope seen from the back: body, two side folds, the bottom
 * fold, the top flap — flat paper, a 2 px darker edge, no shadows. The wax
 * seal sits on the flap's tip. Returns { group, flap, tip, ids } (comp space).
 */
async function envelope(f, o = {}) {
  const { x = 0, y = 0, w = 600, h = 400, startMs = 0, durationMs, name = "Envelope" } = o;
  const L0 = x - w / 2, R0 = x + w / 2, T0 = y - h / 2, B0 = y + h / 2, r = 10;
  const common = { startMs, durationMs };
  const edge = (c = C.envelopeEdge) => ({ paint: { type: "solid", color: c }, width: 2, join: "round" });
  const body = await path(f, `M${L0 + r} ${T0}L${R0 - r} ${T0}Q${R0} ${T0} ${R0} ${T0 + r}L${R0} ${B0 - r}Q${R0} ${B0} ${R0 - r} ${B0}L${L0 + r} ${B0}Q${L0} ${B0} ${L0} ${B0 - r}L${L0} ${T0 + r}Q${L0} ${T0} ${L0 + r} ${T0}Z`, { ...common, name: `${name} · body`, fill: C.envelopeBack, stroke: edge() });
  const mx = x, my = y + h * 0.06;
  const sides = await path(f, `M${L0 + 3} ${T0 + 6}L${mx - 26} ${my}L${L0 + 3} ${B0 - 6}ZM${R0 - 3} ${T0 + 6}L${mx + 26} ${my}L${R0 - 3} ${B0 - 6}Z`, { ...common, name: `${name} · side folds`, fill: C.envelope, stroke: edge() });
  const bottom = await path(f, `M${L0 + 4} ${B0 - 2}L${mx} ${my - 18}L${R0 - 4} ${B0 - 2}Z`, { ...common, name: `${name} · bottom fold`, fill: "#E3DACA", stroke: edge() });
  const tip = [x, y + h * 0.16];
  const flap = await path(f, `M${L0 + 2} ${T0 + 2}L${R0 - 2} ${T0 + 2}L${tip[0] + 14} ${tip[1] - 8}Q${tip[0]} ${tip[1] + 4} ${tip[0] - 14} ${tip[1] - 8}Z`, { ...common, name: `${name} · flap`, fill: C.envelopeFlap, stroke: edge() });
  const ids = [body, sides, bottom, flap];
  return { ids, flap, tip, box: { l: L0, r: R0, t: T0, b: B0 } };
}
/** A blob of clay wax with "12" pressed into it (deboss = a tight inner shadow, no blur halo). */
async function waxSeal(f, o = {}) {
  const { x = 0, y = 0, r = 62, startMs = 0, durationMs, label = "12", name = "Wax" } = o;
  const pts = [];
  for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2, rr = r * (1 + jit(0.07)); pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]); }
  const blob = await path(f, smooth(pts, true), { startMs, durationMs, name: `${name} · blob`, fill: C.wax });
  await fx(blob, "bevel", {});
  // the stamp's ring and number, pressed in
  const ring = await ellipse(f, { startMs, durationMs, name: `${name} · ring`, width: r * 1.36, height: r * 1.36, fill: null, stroke: { paint: { type: "solid", color: C.clay }, width: 4 }, x, y });
  const num12 = await hero(f, label, { startMs, durationMs, size: r * 0.95, color: C.clay, x, y: y + 1, track: -0.02, name: `${name} · ${label}` });
  for (const id of [ring, ...num12.ids]) await fx(id, "innerShadow", { color: "#7A3218cc", x: 0, y: 2, blur: 1.5 });
  return { ids: [blob, ring, ...num12.ids], blob };
}

// ── The thumb (the judge) ───────────────────────────────────────────────────
/** A hand-drawn ink thumb, nail and crease, pointing up-left; paper fill, boiling outline. */
async function thumb(f, o = {}) {
  const { x = 0, y = 0, s = 1, startMs = 0, durationMs, name = "Thumb" } = o;
  const P = (pts) => pts.map(([px, py]) => [x + (px + jit(1.5)) * s, y + (py + jit(1.5)) * s]);
  const outline = P([[-40, 260], [-48, 120], [-62, 10], [-70, -80], [-58, -150], [-20, -186], [26, -180], [58, -140], [66, -70], [70, 20], [92, 110], [118, 200], [126, 270]]);
  const nail = P([[-34, -120], [-30, -156], [0, -168], [30, -156], [38, -118], [26, -96], [-22, -96]]);
  const crease = P([[-30, 14], [0, 24], [34, 18]]);
  const crease2 = P([[-22, 40], [4, 46], [26, 42]]);
  const common = { startMs, durationMs };
  const fillId = await path(f, smooth([...outline, ...P([[126, 290], [-40, 290]])], true), { ...common, name: `${name} · skin`, fill: C.paper });
  const ink = { paint: { type: "solid", color: C.ink }, width: 6 * s, cap: "round", join: "round", profile: { startWidth: 0.3, endWidth: 0.3, startLength: 0.25, endLength: 0.25, ease: 0 } };
  const out = await path(f, smooth(outline), { ...common, name: `${name} · outline`, fill: null, stroke: ink });
  const det = await path(f, smooth(nail, true) + smooth(crease) + smooth(crease2), { ...common, name: `${name} · nail`, fill: null, stroke: { ...ink, width: 4 * s, profile: undefined } });
  for (const id of [fillId, out, det]) await boil(id, { amount: 1.6, scale: 30 });
  return { ids: [fillId, out, det] };
}

// ── The counter (the HUD's goal gradient) ───────────────────────────────────
/** A clay two-digit number that ROLLS from `from` to `to` at `at` inside a mask, with a mono label. */
async function counter(f, o = {}) {
  const { x = 0, y = 0, size = 160, from = 1, to = 2, at = 1000, dur = 520, label = "HOOK", startMs = 0, durationMs, name = "Counter" } = o;
  const common = { startMs, durationMs };
  const fmt = (n) => String(n).padStart(2, "0");
  const ink = heroInk("00", size, -0.02), lineH = ink.h * 1.5;
  const ids = [];
  for (let n = from, i = 0; n <= to; n++, i++) ids.push(...(await hero(f, fmt(n), { ...common, size, color: C.clay, x, y: y + i * lineH, track: -0.02, name: `${name} · ${fmt(n)}` })).ids);
  const roll = await group(ids, `${name} · roll`);
  const steps = to - from;
  const k = [[0, 0]];
  for (let s = 1; s <= steps; s++) k.push([at + (s - 1) * dur - 1, -(s - 1) * lineH, EASE.ui], [at + s * dur - 1 - 0, -s * lineH]);
  if (steps) { await keys(roll, "y", k, "comp"); for (let s = 1; s <= steps; s++) ev(at + (s - 1) * dur, "counter-roll", { to: from + s }); }
  const win = await rect(f, { ...common, name: `${name} · window`, width: ink.w + size * 0.3, height: ink.h + size * 0.2, fill: "#000000", x, y });
  await ac.layer.patch({ id: win, ops: [{ op: "set", path: "isStencil", value: true }] });
  const masked = (await ac.layers.group({ ids: [roll, win], name })).groupId;
  await ac.layer.patch({ id: masked, ops: [{ op: "set", path: "mode", value: "mask" }] });
  const lab = await text(f, label, { ...common, name: `${name} · label`, style: { fontFamily: F.mono, fontSize: 24, fontWeight: 600, letterSpacing: 2, color: C.ink } });
  const lb = await box(lab);
  await pos(lab, x - ink.w / 2 + lb.width / 2, y + ink.h / 2 + 24 + lb.height / 2);
  return { group: masked, label: lab, ids: [masked, lab] };
}

// ── The cursor (a machine thing: it glides) ─────────────────────────────────
/** An arrow cursor with a name tag that rides along, like a multiplayer cursor. Tip at (x, y). */
async function cursor(f, o = {}) {
  const { x = 0, y = 0, tag = "Claude", tagColor = C.clay, startMs = 0, durationMs, name = "Cursor" } = o;
  const s = 1.6;
  const pts = [[0, 0], [0, 25], [6.4, 19.2], [10.6, 28.8], [14.4, 27.2], [10.4, 17.8], [18.4, 17.8]].map(([px, py]) => [x + px * s, y + py * s]);
  const arrow = await path(f, `M${pts.map((p) => p.map(num).join(" ")).join("L")}Z`, { startMs, durationMs, name: `${name} · arrow`, fill: C.ink, stroke: { paint: { type: "solid", color: "#FFFFFF" }, width: 2.5, join: "round", align: "outside" } });
  const t = await text(f, tag, { startMs, durationMs, name: `${name} · tag`, style: { fontFamily: F.sans, fontSize: 22, fontWeight: 600, color: "#FFFFFF", highlight: { color: tagColor, radius: 8, paddingX: 10, paddingY: 5 } } });
  const tb = await box(t);
  await pos(t, x + 30 + 10 + tb.width / 2, y + 50 + tb.height / 2);
  const g = await group([arrow, t], name);
  return { group: g, ids: [arrow, t] };
}

// ── Parts: helper comps (tiles, blocks, walls) filed on the Kit page ─────────
let partsX = 0;
/** A helper comp parked in a row under the Kit sheet, out of the way. */
async function part(o) {
  const f = await comp({ page: o.page, x: partsX, y: 2600, ...o });
  partsX += o.w + 120;
  return f;
}
/** A cubic-bezier easing as a function of progress (0..1) → value (0..1). */
function bezier(x1, y1, x2, y2) {
  const B = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (u) => {
    if (u <= 0) return 0; if (u >= 1) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (B(x1, x2, m) < u) lo = m; else hi = m; }
    return B(y1, y2, (lo + hi) / 2);
  };
}
/** Keys sampled every frame from f(t) (linear between samples): for curves no single easing can say. */
const sampled = (t0, t1, fn, step = FRAME) => { const k = []; for (let t = t0; t < t1 + step / 2; t += step) { const v = fn(Math.min(t, t1)); k.push([Math.round(Math.min(t, t1)), typeof v === "number" ? +v.toFixed(5) : v, "linear"]); } return k; };

// ── The machine feed (glides, never boils) ──────────────────────────────────
/** A grey feed tile: rounded glass, a gradient or grey face, fake caption bars. */
async function feedTile(f, o = {}) {
  const { x = 0, y = 0, size = 760, ai = false, startMs = 0, durationMs, name = "Tile" } = o;
  const common = { startMs, durationMs };
  const face = ai
    ? { type: "linear", stops: [{ offset: 0, color: C.aiA }, { offset: 1, color: C.aiB }], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }
    : { type: "solid", color: C.grey };
  const t = await rect(f, { ...common, name: `${name} · face`, width: size, height: size, cornerRadius: 24, fill: face, x, y });
  const bar1 = await rect(f, { ...common, name: `${name} · bar`, width: size * 0.62, height: 30, cornerRadius: 15, fill: ai ? "#FFFFFF8C" : C.greyDeep, x: x - size / 2 + 56 + size * 0.31, y: y + size / 2 - 140 });
  const bar2 = await rect(f, { ...common, name: `${name} · bar 2`, width: size * 0.4, height: 30, cornerRadius: 15, fill: ai ? "#FFFFFF59" : "#A9AEB8", x: x - size / 2 + 56 + size * 0.2, y: y + size / 2 - 88 });
  const play = await path(f, `M${x - 34} ${y - 70}L${x + 46} ${y - 20}L${x - 34} ${y + 30}Z`, { ...common, name: `${name} · play`, fill: ai ? "#FFFFFFB3" : "#B6BAC3" });
  return { ids: [t, bar1, bar2, play] };
}

// ── The prompt card ─────────────────────────────────────────────────────────
/**
 * A static design beside each hook (760 × the hook's height): NN · FAMILY,
 * the name, why it works, THE PROMPT, use it when, the hint, three remixes,
 * and a footer with the techniques, LIGHT/HEAVY and ★ IN THE FILM. Laid out
 * top-down from measured boxes; it shrinks its body type until it fits.
 */
async function card(page, s, x, y, h) {
  const W = 760, M = 64, TW = W - 2 * M;
  for (const k of [1, 0.94, 0.88, 0.82]) {
    const f = await comp({ name: `${s.no} · Prompt`, w: W, h, bg: C.paper, mode: "static", dur: 1000, page, x, y });
    let cy = -h / 2 + M;
    const put = async (str, style, o = {}) => {
      const id = await text(f, str, { maxWidth: o.maxWidth ?? TW, name: o.name, style: { align: "left", ...style } });
      const b = await box(id);
      await pos(id, -W / 2 + M + (o.indent ?? 0) + b.width / 2, cy + b.height / 2);
      cy += b.height;
      return { id, b };
    };
    const label = (str, name) => put(str, { fontFamily: F.mono, fontSize: 16, color: C.graphite, letterSpacing: 2.5, fontWeight: 600, lineHeight: 1.2 }, { name });
    const body = (str, name, extra = {}) => put(str, { fontSize: Math.round(22 * k), color: C.ink, lineHeight: 1.42, fontWeight: 450, ...extra }, { name });
    await put(`${s.no}  ·  ${s.family.toUpperCase()}`, { fontFamily: F.mono, fontSize: 18, color: C.graphite, letterSpacing: 2.5, fontWeight: 600, lineHeight: 1.2 }, { name: "Kicker" });
    cy += 14;
    await put(s.name, { fontFamily: F.serif, fontSize: Math.round(84 * Math.min(1, k + 0.06)), fontWeight: 650, lineHeight: 1, letterSpacing: -2 }, { name: "Name" });
    cy += 18;
    await body(s.why, "Why it works", { color: C.graphite, fontSize: Math.round(23 * k) });
    cy += Math.round(36 * k);
    await label("THE PROMPT", "Prompt label");
    cy += 12;
    const top = cy;
    await put(s.prompt, { fontFamily: F.mono, fontSize: Math.round(17.5 * k * 10) / 10, lineHeight: 1.5, color: C.ink }, { name: "Prompt", maxWidth: TW - 26, indent: 26 });
    await rect(f, { name: "Prompt rule", width: 4, height: cy - top, cornerRadius: 2, fill: C.clay, x: -W / 2 + M + 2, y: (top + cy) / 2 });
    for (const [lab, val] of [["USE IT WHEN", s.use], ["HINT", s.hint]]) {
      cy += Math.round(28 * k);
      await label(lab, `${lab} label`);
      cy += 8;
      await body(val, lab);
    }
    cy += Math.round(28 * k);
    await label("REMIX IT", "Remix label");
    cy += 8;
    for (const [i, r] of s.remix.entries()) { await body(`→  ${r}`, `Remix ${i + 1}`); cy += 4; }
    // Footer, pinned to the bottom edge: techniques, then the chips on one row.
    const chipStyle = (bg, fg) => ({ fontFamily: F.mono, fontSize: 15, fontWeight: 700, letterSpacing: 2, color: fg, lineHeight: 1.2, highlight: { color: bg, radius: 6, paddingX: 10, paddingY: 6 } });
    const chips = [await text(f, s.heavy ? "HEAVY" : "LIGHT", { name: "Weight", style: chipStyle(s.heavy ? C.ink : C.paperDeep, s.heavy ? C.paper : C.ink) })];
    if (s.film) chips.push(await text(f, "★ IN THE FILM", { name: "In the film", style: chipStyle(C.paperDeep, C.ink) })); // clay stays on the prompt rule: once per frame
    const cbs = [];
    for (const c of chips) cbs.push(await box(c));
    const chipH = Math.max(...cbs.map((b) => b.height));
    const chipY = h / 2 - M - chipH / 2 - 6;
    let cx = -W / 2 + M + 10;
    for (const [i, c] of chips.entries()) { await pos(c, cx + cbs[i].width / 2, chipY); cx += cbs[i].width + 20 + 16; }
    const foot = await text(f, s.tech, { name: "Techniques", maxWidth: TW, style: { fontFamily: F.mono, fontSize: 15, color: C.graphite, lineHeight: 1.5, align: "left" } });
    const fb = await box(foot);
    const fy = chipY - chipH / 2 - 6 - 20 - fb.height / 2;
    await pos(foot, -W / 2 + M + fb.width / 2, fy);
    const ruleY = fy - fb.height / 2 - 20;
    await rect(f, { name: "Footer rule", width: TW, height: 1.5, fill: "#D3CAB9", x: 0, y: ruleY });
    const room = ruleY - 32 - cy;
    if (room >= 0) return f;
    console.warn(`${s.no}: card body runs ${Math.round(-room)} px into the footer at ${k} — trying smaller`);
    await ac.frame.delete({ id: f.id });
  }
  throw new Error(`${s.no}: the card text does not fit — shorten it`);
}

/**
 * One hook on the canvas: its 1080² comp at (x, y) and its prompt card 48 px to
 * the right. A scene is `{ meta, w, h, dur, bg, build(f, ctx) }`; ctx.timing
 * (optional) stretches a scene to the voice. Returns the comp and its events.
 */
async function place(def, page, x, y, ctx = {}) {
  const f = await comp({ name: `${def.meta.no} · ${def.meta.name}`, w: def.w, h: def.h, bg: def.bg ?? C.paper, dur: ctx.timing?.dur ?? def.dur, page, x, y });
  reseed(def.seed ?? 7);
  EVENTS = []; HOOK = def.meta.no;
  await def.build(f, { ...ctx, page });
  const events = EVENTS.sort((a, b) => a.t - b.t);
  await card(page, def.meta, x + def.w + 48, y, def.h);
  return { f, events, width: def.w + 48 + 760 };
}

return {
  C, F, EASE, FPS, FRAME, frame, rand, reseed, jit, ev,
  comp, span, text, rect, ellipse, path, keys, steps, centreGroup, fx, box, set, pos, named, strokeId, group, boil,
  parse, write, transform, densify, dBox, smooth, plen, subD,
  heroRun, hero, heroInk, scriptStrokes, pencil, arrowStrokes,
  hookGeometry, line, CARD, titleCard, counterOf, lidded, eyes, blinkSheet,
  puffFlipbook, puffAt, part, bezier, sampled, envelope, waxSeal, thumb, counter, cursor, feedTile, card, place,
  events: () => EVENTS, setHook: (h) => { HOOK = h; EVENTS = []; },
};
