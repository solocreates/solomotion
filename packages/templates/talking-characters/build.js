// TALKING CHARACTERS — the build.
//
// This file made this project. Change a line and press Run: the replace mode
// takes away what the last run made and builds it again. Every call is an
// ordinary `ac.*` verb, the same ones the agent and the panels use.
//
//   Pip     a 2D cut-out drawn as SVG parts (art/pip), put together here,
//           then brought to life: blinks, breathes, nods, talks, looks around.
//   Orbit   a 3D head that says the same line.
//   Title   the card.

const LINE = "Hi! I'm Pip. I blink, I look around, and I talk to whatever you say.";
const ORBIT_LINE = "And I'm Orbit. Same tricks. One more dimension.";

// The voices: two ElevenLabs reads that ship with the template (Jessica for
// Pip, Callum for Orbit), with the words' own timings, so each mouth is exact
// from the first frame. Off the app (a test, a server) the offline Test Voice
// says the same line instead.
const VOICES = {
  pip: {
    url: "/templates/talking-characters/pip-line.mp3",
    text: LINE,
    words: [["Hi!", 0, 560], ["I'm", 600, 720], ["Pip.", 800, 1320], ["I", 1520, 1600], ["blink,", 1680, 2320], ["I", 2360, 2400], ["look", 2480, 2560], ["around,", 2640, 3200], ["and", 3360, 3520], ["I", 3600, 3680], ["talk", 3800, 3920], ["to", 4000, 4080], ["whatever", 4280, 4480], ["you", 4560, 4640], ["say.", 4800, 5280]],
  },
  orbit: {
    url: "/templates/talking-characters/orbit-line.mp3",
    text: ORBIT_LINE,
    words: [["And", 0, 240], ["I'm", 280, 480], ["Orbit.", 560, 1240], ["Same", 1440, 1680], ["tricks.", 1760, 2440], ["One", 2640, 2800], ["more", 2880, 3040], ["dimension.", 3360, 4000]],
  },
};

/** Put a voice on the timeline: the shipped read with its timings, else the Test Voice. */
async function voice(v, frameId, name) {
  let said = null;
  if (ac.media && ac.media.import) {
    try {
      said = await ac.media.import({ url: v.url, name: `${name}.mp3`, folder: "Voices", place: { frameId, startMs: 300 } });
    } catch (e) {
      console.warn(`${name}: the shipped voice did not load (${e.message}) — using the Test Voice.`);
    }
  }
  if (said && ac.speech && ac.speech.analyze) {
    const words = v.words.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));
    await ac.speech.analyze({ id: said.assetId, text: v.text, words }).catch((e) => console.warn(`${name}: ${e.message}`));
  }
  if (!said && ac.generate && ac.generate.speech) said = await ac.generate.speech({ text: v.text, voice: "test", place: { frameId, startMs: 300 } });
  if (said && said.clipId) await ac.layer.patch({ id: said.clipId, ops: [{ op: "set", path: "name", value: name }] });
  return said;
}
const DUR = 7000;
const ART = "talking-characters/art/pip/";
const INK = "#1B1230";
const POP = { blue: "#4F7DFF", pink: "#FF5C93", yellow: "#FFC93C", cream: "#FFF8EC" };

/** A sticker panel: ink outline, a HARD ink shadow below it, round corners. */
async function sticker(frameId, name, { x, y, width, height, fill, radius = 48, shadow = 16 }) {
  const shape = { kind: "shape", shape: "rect", frameId, startMs: 0, durationMs: DUR, width, height, cornerRadius: radius };
  await ac.layer.create({ ...shape, name: `${name} shadow`, x, y: y + shadow, fill: INK });
  return (await ac.layer.create({ ...shape, name, x, y, fill, stroke: { color: INK, width: 8 } })).id;
}

// ── Reading the art ─────────────────────────────────────────────────────────
// The art convention (see art/pip): every shape is a <path> with absolute
// M/L/C/Z data, so every number pair is a point — the box the engine measures is
// exactly the box of those points. `data-pivot` on <svg> is the part's joint.
const read = async (file) => (await ac.script.read({ script: ART + file })).source;

function parseSvg(text) {
  const pivot = (/data-pivot="([^"]+)"/.exec(text) || [])[1];
  const attrs = (tag) => {
    const out = {};
    for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = m[2];
    return out;
  };
  return {
    pivot: pivot ? pivot.split(/\s+/).map(Number) : null,
    paths: [...text.matchAll(/<path\b([^>]*)\/>/g)].map((m) => attrs(m[1])),
  };
}

// Character space (the art's 800 × 1000 viewBox) → comp space.
const PIP = { cx: 400, cy: 500, scale: 0.95, x: -430, y: 30 };
const toComp = ([x, y], at = PIP) => [(x - at.cx) * at.scale + at.x, (y - at.cy) * at.scale + at.y];
// A mouth file is a 300 × 240 viewBox (the lip-sync mouth convention), centred on Pip's mouth.
const MOUTH_AT = { cx: 150, cy: 130, scale: 0.6, x: 400, y: 452 };
const mouthToComp = (p) => toComp(toComp(p, MOUTH_AT));

/** One SVG file → path layers; returns their ids (bottom first). */
async function drawFile(frameId, file, map = toComp) {
  const svg = parseSvg(await read(file));
  const ids = [];
  for (const p of svg.paths) {
    const nums = p.d.match(/-?\d*\.?\d+/g).map(Number);
    const pts = [];
    for (let i = 0; i < nums.length; i += 2) pts.push(map([nums[i], nums[i + 1]]));
    let k = 0;
    let n = 0;
    const d = p.d.replace(/-?\d*\.?\d+/g, () => {
      const v = pts[k][n].toFixed(1);
      if (++n === 2) (n = 0), k++;
      return v;
    });
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    // PHASE 2 gap: layer.create cannot take a pivot in the path's own space —
    // the normalised anchor has to be derived from the points here.
    const [px, py] = map(svg.pivot || [0, 0]);
    const w = box.maxX - box.minX || 1;
    const h = box.maxY - box.minY || 1;
    const set = { "anchor.x": (px - box.minX) / w, "anchor.y": (py - box.minY) / h };
    if (p.opacity) set.opacity = Number(p.opacity);
    const stroke = p.stroke ? { color: p.stroke, width: Number(p["stroke-width"] || 8) * (map === toComp ? PIP.scale : PIP.scale * MOUTH_AT.scale), join: "round", cap: "round" } : null;
    const made = await ac.layer.create({
      kind: "path", frameId, name: p.id, d, startMs: 0, durationMs: DUR,
      fill: p.fill && p.fill !== "none" ? p.fill : null, stroke, x: px, y: py, set,
    });
    ids.push(made.id);
  }
  return ids;
}

/** A part: one file, grouped (and named) when it has more than one shape. */
async function part(frameId, file, name, map) {
  const ids = await drawFile(frameId, file, map);
  if (ids.length === 1) {
    await ac.layer.patch({ id: ids[0], ops: [{ op: "set", path: "name", value: name }] });
    return ids[0];
  }
  return (await ac.layers.group({ ids, name })).groupId;
}

/** A switch: one drawing per state, named for the state. */
async function states(frameId, folder, names, name, map) {
  const members = [];
  for (const n of names) members.push(await part(frameId, `${folder}/${n}.svg`, n, map));
  // PHASE 2 gap: switch.create names its shown member by name, but there is no
  // way to say "these files ARE a switch" on import — we assemble it by hand.
  return (await ac.switch.create({ ids: members, name, show: names[0] })).switchId;
}

// ── Pip ─────────────────────────────────────────────────────────────────────
const scene = here.frameId;
await ac.frame.update({ id: scene, name: "Pip", width: 1920, height: 1080, background: "#4F7DFF", durationMs: DUR });

// The voice first: a character finds the voice that overlaps it.
const said = await voice(VOICES.pip, scene, "Pip's line");
if (!said) console.warn("No speech verb here — Pip is built without a voice (run me in the app to hear it).");

const SIDES = ["R", "L"]; // screen left first: drawn bottom to top
const torso = await part(scene, "torso.svg", "Torso");
const face = [];
face.push(await part(scene, "head.svg", "Skin"));
for (const s of SIDES) face.push(await part(scene, `sclera.${s}.svg`, `Sclera.${s}`));
for (const s of SIDES) face.push(await part(scene, `pupil.${s}.svg`, `Pupil.${s}`));
for (const s of SIDES) face.push(await states(scene, `eye.${s}`, ["Open", "Half", "Closed"], `Eye.${s}`));
for (const s of SIDES) face.push(await states(scene, `brow.${s}`, ["Neutral", "Raised", "Angry"], `Brow.${s}`));
face.push(await states(scene, "mouth", ["X", "MBP", "AI", "E", "O", "U", "FV", "L", "S"], "Mouth", mouthToComp));
face.push(await part(scene, "hair.svg", "Hair"));
const head = (await ac.layers.group({ ids: face, name: "Head" })).groupId;
const limbs = [];
for (const s of SIDES) {
  limbs.push(await part(scene, `arm.${s}.svg`, `Arm.${s}`));
  limbs.push(await part(scene, `forearm.${s}.svg`, `Forearm.${s}`));
  limbs.push(await states(scene, `hand.${s}`, ["Relaxed", "Open", "Point", "Fist", "Wave", "Thumb"], `Hand.${s}`));
}
const pip = (await ac.layers.group({ ids: [torso, head, ...limbs], name: "Pip" })).groupId;

// Bones for what swings: a body, and two arms that ride their own bones.
const C = (p) => toComp(p).map((v) => Math.round(v * 10) / 10);
const arm = (s) => {
  const m = s === "L" ? (x) => x : (x) => 800 - x;
  return [
    { name: `UpperArm.${s}`, head: C([m(522), 612]), tail: C([m(586), 718]), parent: "Body" },
    { name: `Forearm.${s}`, head: C([m(586), 718]), tail: C([m(612), 812]) },
    { name: `Hand.${s}`, head: C([m(612), 812]), tail: C([m(630), 870]) },
  ];
};
await ac.rig.create({ ids: [pip] });
await ac.rig.bone({
  rigId: pip,
  add: [{ name: "Body", head: C([400, 905]), tail: C([400, 560]), parent: null }, ...arm("L"), ...arm("R")],
});
// Alive by default, AFTER the skeleton exists so the eyes hang off Body and
// travel with it: one call reads the parts by their names and wires blink,
// breathe, nod, talk (to the voice above) and look.
const life = await ac.character.bringToLife({ id: pip, look: true });
console.log("Pip:", life.parts.join(", "));

const ride = [["Torso", "Body"]];
for (const s of SIDES) ride.push([`Arm.${s}`, `UpperArm.${s}`], [`Forearm.${s}`, `Forearm.${s}`], [`Hand.${s}`, `Hand.${s}`]);
const named = Object.fromEntries((await ac.layers.list({ frameId: scene })).layers.flatMap(function flat(l) {
  return [[l.name, l.id], ...(l.children || []).flatMap(flat)];
}));
for (const [layer, bone] of ride) await ac.rig.bind({ ids: named[layer], mode: "rigid", bone });
// The face moves as one with the body. Binding reads the art, and Pip's cheeks
// sit right where the raised arms' bones begin — left to it, each cheek rode an
// arm. Everything in the head rides Body; the pupils keep their look bones.
const headOf = (ls) => {
  for (const l of ls) {
    if (l.name === "Head" && l.children) return l.children;
    const found = headOf(l.children || []);
    if (found) return found;
  }
  return null;
};
const faceUnits = (headOf((await ac.layers.list({ frameId: scene })).layers) || []).filter((l) => !/^Pupil\./.test(l.name));
if (faceUnits.length) await ac.rig.bind({ ids: faceUnits.map((l) => l.id), mode: "rigid", bone: "Body" });

// The left hand: a Wave pose that also lifts the arm, and a machine that picks
// it — wave hello, then talk with an open hand, rest when quiet.
const sets = (await ac.poses.inspect({ groupId: pip })).sets;
const leftHand = sets.find((s) => s.name === "Left hand");
const rig = await ac.rig.inspect({ rigId: pip });
const bone = (n) => rig.bones.find((b) => b.name === n).id;
await ac.poses.update({
  groupId: pip, set: leftHand.id, pose: "Wave",
  setValues: [
    { clipId: pip, path: `bone.${bone("UpperArm.L")}.rotation`, value: -125 },
    { clipId: pip, path: `bone.${bone("Forearm.L")}.rotation`, value: -25 },
  ],
});
for (const p of ["Relaxed", "Open"]) {
  await ac.poses.update({
    groupId: pip, set: leftHand.id, pose: p,
    setValues: [
      { clipId: pip, path: `bone.${bone("UpperArm.L")}.rotation`, value: p === "Open" ? -20 : 0 },
      { clipId: pip, path: `bone.${bone("Forearm.L")}.rotation`, value: p === "Open" ? -35 : 0 },
    ],
  });
}
await ac.poses.update({ groupId: pip, set: leftHand.id, blend: { ms: 260, ease: "ease-in-out" } });
const voiceName = said ? "Pip's line" : null;
await ac.machine.create({
  frameId: scene,
  name: "Hands",
  layers: [{
    entry: "Waving",
    states: [
      { name: "Waving", output: { kind: "pose", set: leftHand.id, pose: "Wave" } },
      { name: "Talking", output: { kind: "pose", set: leftHand.id, pose: "Open" } },
      { name: "Idle", output: { kind: "pose", set: leftHand.id, pose: "Relaxed" } },
    ],
    transitions: voiceName
      ? [
          { from: "Waving", to: "Talking", exitTime: 1400 },
          { from: "Talking", to: "Idle", when: [{ kind: "speaking", layer: voiceName, is: false }] },
          { from: "Idle", to: "Talking", when: [{ kind: "speaking", layer: voiceName }] },
        ]
      : [{ from: "Waving", to: "Idle", exitTime: 1400 }],
  }],
});
// The machine is a behavior in Pip's stack: its states pick the hand's poses.
await ac.behaviors.add({ groupId: pip, type: "machine", fields: { machine: "Hands" } });

// Brows up on "Hi!", a look around on "I look around".
const brows = sets.find((s) => s.vocabulary === "brows");
if (brows) await ac.poses.key({ groupId: pip, set: brows.id, keys: [{ atMs: 0, pose: "Neutral" }, { atMs: 300, pose: "Raised" }, { atMs: 1300, pose: "Neutral" }] });
const look = [[0, 0, 0], [2600, 0, 0], [3000, -60, -10], [3500, 60, -10], [4000, 0, 0]];
for (const [at, x, y] of look) await ac.rig.pose({ rigId: pip, atMs: at, key: true, poses: [{ bone: "Look", x, y }] });

// The line, in a speech bubble beside him — the sticker look, big readable type.
await sticker(scene, "Bubble", { x: 400, y: -150, width: 920, height: 400, fill: POP.cream });
await ac.layer.create({
  kind: "text", frameId: scene, name: "Line", text: LINE, maxWidth: 800, startMs: 0, durationMs: DUR, x: 400, y: -150,
  style: { fontFamily: "Titan One", fontSize: 64, color: INK, lineHeight: 1.12, align: "center" },
});
await sticker(scene, "Tag", { x: 400, y: 200, width: 460, height: 96, fill: POP.yellow, radius: 48, shadow: 10 });
await ac.layer.create({
  kind: "text", frameId: scene, name: "Tag text", text: "PIP · 2D CUT-OUT", startMs: 0, durationMs: DUR, x: 400, y: 200,
  style: { fontFamily: "Titan One", fontSize: 40, color: INK, align: "center", letterSpacing: 2 },
});

// ── Orbit: a 3D head with a voice of its own ─────────────────────────────────
// Built like a puppet, organ by organ: a head whose mouth morphs (its shape
// keys), eyeballs and lids of their own set into it, irises that turn on eye
// bones, brows. The skin, eyeballs and lids are one UNION — a single solid
// that keeps each part's own colour and is outlined once, around the whole
// (never an eye's rim drawn inside the head it sits in).
const world = await ac.world.create({ name: "Orbit", width: 1920, height: 1080, starter: true });
const W = world.frameId;
await ac.frame.update({ id: W, durationMs: DUR });
const starter = await ac.world.inspect({ frameId: W });
const cube = starter.objects.find((o) => /cube/i.test(o.name));
if (cube) await ac.layers.delete({ ids: [cube.id] });

const HEAD = [0, 0, 120];
const SKIN = "#F3B896";
const orbitAt = (p) => [HEAD[0] + p[0], HEAD[1] + p[1], HEAD[2] + p[2]];
const orbitMesh = (name, primitive, params, position, extra = {}) => ac.world.add({ frameId: W, kind: "mesh", primitive, params, position, name, ...extra }).then((r) => r.id);

const orbitSkin = (await ac.world.add({ frameId: W, kind: "head", eyes: false, name: "Skin", position: HEAD })).id;
// The eyes, in the sockets the head was made with (its object space: ±33, −85.5, −6; radius 15).
const EYE = { L: orbitAt([33, -85.5, -6]), R: orbitAt([-33, -85.5, -6]) };
const EYE_RADIUS = 15;
const organs = { face: [orbitSkin], eyes: [], lids: {}, shells: [], brows: {} };
for (const s of ["L", "R"]) {
  organs.face.push(await orbitMesh(`Eyeball.${s}`, "uvSphere", { radius: EYE_RADIUS, segments: 32, rings: 16 }, EYE[s], { color: "#FBFAF6" }));
  // Iris, pupil, catchlight: caps of spheres about the eye's centre, facing front (−Y) — they turn with the eye.
  organs.eyes.push(await orbitMesh(`Iris.${s}`, "uvSphere", { radius: EYE_RADIUS * 1.012, segments: 32, rings: 6, arc: 34 }, EYE[s], { rotation: [-90, 0, 0], color: "#4A3560" }));
  organs.eyes.push(await orbitMesh(`Pupil.${s}`, "uvSphere", { radius: EYE_RADIUS * 1.022, segments: 24, rings: 4, arc: 16 }, EYE[s], { rotation: [-90, 0, 0], color: "#120D18" }));
  organs.eyes.push(await orbitMesh(`Shine.${s}`, "uvSphere", { radius: EYE_RADIUS * 1.03, segments: 12, rings: 2, arc: 6 }, EYE[s], { rotation: [-62, 0, s === "L" ? 26 : -26], color: "#FFFFFF" }));
  // Lids: two shells over the eyeball, a top and a bottom; a pose turns each
  // about the eye's centre. Open shells, so they stand OUTSIDE the union (a
  // solid merges solids) and draw their own rim — the lid line.
  const top = await orbitMesh(`LidTop.${s}`, "uvSphere", { radius: EYE_RADIUS * 1.1, segments: 32, rings: 10, arc: 90 }, EYE[s], { rotation: [145, 0, 0], color: SKIN });
  const bottom = await orbitMesh(`LidBottom.${s}`, "uvSphere", { radius: EYE_RADIUS * 1.08, segments: 32, rings: 8, arc: 90 }, EYE[s], { rotation: [55, 0, 0], color: SKIN });
  organs.shells.push(top, bottom);
  organs.lids[s] = { top, bottom };
  organs.brows[s] = await orbitMesh(`Brow.${s}`, "capsule", { radius: 3.2, length: 20, segments: 16, rings: 4 }, [EYE[s][0], EYE[s][1] - 8, EYE[s][2] + 24], { rotation: [0, 90, 0], color: "#3A2626" });
}
// One solid, one outline: the union keeps every part's colour, the skin's ink outlines it all.
const orbitFace = (await ac.layers.group({ ids: organs.face, name: "Face" })).groupId;
await ac.layer.patch({ id: orbitFace, ops: [{ op: "set", path: "mode", value: "union" }] });
const ink = (width) => [{ op: "set", path: "strokes", value: [{ paint: { type: "solid", color: INK }, width }] }];
await ac.layer.patch({ id: orbitSkin, ops: ink(3) });
for (const id of organs.shells) await ac.layer.patch({ id, ops: ink(2.5) });
const orbit = (await ac.layers.group({ ids: [orbitFace, ...organs.shells, ...organs.eyes, organs.brows.L, organs.brows.R], name: "Orbit" })).groupId;

// Centred by construction: the camera looks at the head, wherever it stands.
const cam = starter.objects.find((o) => o.kind === "camera");
// In front of the face, a little to its left and above: a portrait, not a profile.
if (cam) {
  await ac.layer.patch({ id: cam.id, ops: [{ op: "set", path: "transform.x", value: 240 }, { op: "set", path: "transform.y", value: -980 }, { op: "set", path: "transform.z", value: 290 }] });
  await ac.world.track({ id: cam.id, lookAt: orbitSkin });
}
const ring = await ac.world.add({ frameId: W, kind: "mesh", primitive: "torus", params: { majorRadius: 170, minorRadius: 7 }, name: "Ring", position: HEAD, rotation: [78, 0, 0], color: "#FFC93C" });
await ac.expression.set({ id: ring.id, property: "rotation", source: "#time * 40" });

// The rig: a head, two eye bones that track one Look control in front of the face.
await ac.rig.create({ ids: [orbit] });
const eyeBone = (s) => ({ name: `Eye.${s}`, head: EYE[s], tail: [EYE[s][0], EYE[s][1] - 12, EYE[s][2]], parent: "Head" });
await ac.rig.bone({
  rigId: orbit,
  add: [
    { name: "Head", head: orbitAt([0, 0, -80]), tail: orbitAt([0, 0, 60]), parent: null },
    eyeBone("L"),
    eyeBone("R"),
    { name: "Look", head: orbitAt([0, -320, -6]), tail: orbitAt([0, -332, -6]), parent: "Head", deform: false, shape: "cross" },
  ],
});
await ac.rig.constrain({ rigId: orbit, add: ["L", "R"].map((s) => ({ bone: `Eye.${s}`, type: "track", target: "Look" })) });
const irisOf = (s) => organs.eyes.slice(s === "L" ? 0 : 3, s === "L" ? 3 : 6);
for (const s of ["L", "R"]) await ac.rig.bind({ ids: irisOf(s).slice(0, 2), mode: "rigid", bone: `Eye.${s}` });
await ac.rig.bind({ ids: [orbitFace, ...organs.shells, organs.eyes[2], organs.eyes[5], organs.brows.L, organs.brows.R], mode: "rigid", bone: "Head" });

// Parts with named states: the mouth's visemes (the orbitSkin's own shape keys),
// the eyes (both lids, top and bottom), the brows.
const VISEMES = ["X", "MBP", "S", "E", "AI", "O", "U", "FV", "L"];
const orbitMouth = await ac.poses.create({
  groupId: orbit, name: "Mouth", vocabulary: "visemes", part: orbitSkin, blend: { ms: 70 },
  poses: VISEMES.map((v) => ({ name: v, values: v === "X" ? [] : [{ clipId: orbitSkin, path: `key.${v}`, value: 1 }] })),
});
const orbitLid = (topX, bottomX) => ["L", "R"].flatMap((s) => [
  { clipId: organs.lids[s].top, path: "rotationX", value: topX },
  { clipId: organs.lids[s].bottom, path: "rotationX", value: bottomX },
]);
const orbitEyes = await ac.poses.create({
  groupId: orbit, name: "Eyes", vocabulary: "eyes", part: orbitFace, blend: { ms: 50 },
  poses: [
    { name: "Open", values: orbitLid(145, 55) },
    { name: "Half", values: orbitLid(195, 45) },
    { name: "Closed", values: orbitLid(232, 34) },
    { name: "Squint", values: orbitLid(178, 42) },
  ],
});
await ac.poses.update({ groupId: orbit, set: orbitEyes.setId, transitions: [{ from: "*", to: "Closed", ms: 40 }, { from: "Closed", to: "*", ms: 110 }] });
const orbitBrow = (dz, tilt) => ["L", "R"].flatMap((s) => [
  { clipId: organs.brows[s], path: "z", value: EYE[s][2] + 24 + dz },
  { clipId: organs.brows[s], path: "rotationY", value: 90 + (s === "L" ? tilt : -tilt) },
]);
await ac.poses.create({
  groupId: orbit, name: "Brows", vocabulary: "brows", blend: { ms: 160 },
  poses: [
    { name: "Neutral", values: orbitBrow(0, 0) },
    { name: "Raised", values: orbitBrow(7, 0) },
    { name: "Angry", values: orbitBrow(-3, 18) },
    { name: "Sad", values: orbitBrow(2, -16) },
  ],
});

// Orbit's life is behaviors, like Pip's: it speaks with whichever voice plays
// in its world, blinks through its lids, looks around, and never quite stops.
const orbitSaid = await voice(VOICES.orbit, W, "Orbit's line");
if (orbitSaid) await ac.behaviors.add({ groupId: orbit, type: "lipSync", set: orbitMouth.setId });
await ac.behaviors.add({ groupId: orbit, type: "blink", set: orbitEyes.setId, fields: { every: 3.5, half: "Half" } });
await ac.behaviors.add({ groupId: orbit, type: "glance", fields: { bone: "Look", rangeX: 90, rangeY: 40, hold: 1.4 } });
await ac.behaviors.add({ groupId: orbit, type: "sway", fields: { channel: `bone.${(await ac.rig.inspect({ rigId: orbit })).bones.find((b) => b.name === "Head").id}.rotation`, amount: 3, speed: 0.2 } });
const talk = { groupId: orbit, mouthSetId: orbitMouth.setId, eyesSetId: orbitEyes.setId };

// ── Title ────────────────────────────────────────────────────────────────────
// Every box here is sized from the MEASURED words it holds (`layer.get` box —
// the real font in the app), never guessed: a fixed card around a 140 px title
// left the title hanging off both ends of it.
const title = await ac.frame.create({ name: "Title", width: 1920, height: 1080, background: POP.pink, durationMs: 3000 });
const TD = 3000;
const boxOf = async (id) => (await ac.layer.get({ id, fields: ["box"] })).box;
const card = { kind: "shape", shape: "rect", frameId: title.id, startMs: 0, durationMs: TD, width: 1200, height: 400, cornerRadius: 56, x: 0, y: -40 };
const shadow = (await ac.layer.create({ ...card, name: "Card shadow", y: card.y + 18, fill: INK })).id;
const front = (await ac.layer.create({ ...card, name: "Card", fill: POP.yellow, stroke: { color: INK, width: 12 } })).id;
const titleText = (await ac.layer.create({ kind: "text", frameId: title.id, name: "Title", text: "Talking Characters", startMs: 0, durationMs: TD, x: 0, y: -84, style: { fontFamily: "Titan One", fontSize: 116, color: INK, align: "center" } })).id;
const sub = (await ac.layer.create({ kind: "text", frameId: title.id, name: "Credits", text: "Give it a voice. It talks, blinks and looks around.", startMs: 0, durationMs: TD, x: 0, y: 44, style: { fontFamily: "Inter", fontSize: 40, fontWeight: 700, color: INK, align: "center" } })).id;
const [tb, sb] = [await boxOf(titleText), await boxOf(sub)];
const PAD_X = 96, PAD_Y = 64, GAP = 28;
const cardW = Math.min(1720, Math.round(Math.max(tb.width, sb.width) + PAD_X * 2));
const cardH = Math.round(tb.height + GAP + sb.height + PAD_Y * 2);
// Centre the words in the card: title on top, line under it, one gap between.
const top = card.y - cardH / 2 + PAD_Y;
await ac.layer.patch({ id: titleText, ops: [{ op: "set", path: "transform.y", value: Math.round(top + tb.height / 2) }] });
await ac.layer.patch({ id: sub, ops: [{ op: "set", path: "transform.y", value: Math.round(top + tb.height + GAP + sb.height / 2) }] });
for (const id of [shadow, front]) await ac.layer.patch({ id, ops: [{ op: "set", path: "width", value: cardW }, { op: "set", path: "height", value: cardH }] });
await ac.layer.patch({ id: shadow, ops: [{ op: "set", path: "transform.y", value: card.y + 18 }] });

const pillY = card.y + cardH / 2 + 110;
const pills = [];
for (const [i, name] of ["Pip · 2D", "Orbit · 3D"].entries()) {
  const pill = (await ac.layer.create({ kind: "shape", shape: "rect", frameId: title.id, name: `${name} pill`, startMs: 0, durationMs: TD, width: 300, height: 84, cornerRadius: 42, x: 0, y: pillY, fill: i === 0 ? POP.blue : INK, stroke: { color: INK, width: 7 } })).id;
  const word = (await ac.layer.create({ kind: "text", frameId: title.id, name, text: name, startMs: 0, durationMs: TD, x: 0, y: pillY, style: { fontFamily: "Titan One", fontSize: 38, color: "#FFFFFF", align: "center" } })).id;
  pills.push({ pill, word, width: Math.round((await boxOf(word)).width + 72) });
}
// The pair, centred as a pair with one gap between them.
const PILL_GAP = 32;
let px = -(pills.reduce((w, p) => w + p.width, 0) + PILL_GAP * (pills.length - 1)) / 2;
for (const p of pills) {
  const cx = Math.round(px + p.width / 2);
  await ac.layer.patch({ id: p.pill, ops: [{ op: "set", path: "width", value: p.width }, { op: "set", path: "transform.x", value: cx }] });
  await ac.layer.patch({ id: p.word, ops: [{ op: "set", path: "transform.x", value: cx }] });
  px += p.width + PILL_GAP;
}

return { pip, orbit: talk.groupId, title: title.id, voice: said ? said.assetId : null };
