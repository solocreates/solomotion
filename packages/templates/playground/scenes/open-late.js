// 04 · OPEN LATE — a neon sign on a wet brick wall.
//
// Neon is three things: a pale core (the glass), a saturated glow (the gas),
// and light on whatever is near it. The sign is one group; its reflection in
// the wet pavement is the same group duplicated, flipped and blurred.

const DUR = 8000;
const PINK = "#ff3d9a", PINK_CORE = "#ffd6ea", CYAN = "#22d8ff", CYAN_CORE = "#d9f8ff";
const BRICK = "#2a171c", MORTAR = "#140b0f", FLOOR = "#0c080c";
const FLOOR_Y = 330;

return {
  meta: {
    no: "04", family: "Neon & night", name: "Open Late",
    line: "A neon sign buzzes alive on a wet brick wall; one letter never quite works.",
    prompt: "A neon sign on a dark brick wall: 'open' in a pink cursive tube over 'LATE' in cyan capitals. It flickers alive, then one letter keeps failing. Light spills on the bricks, rain streaks fall, and the wet pavement reflects the sign. 8 s.",
    remix: ["Change the words to your café's name and its hours.", "Make it daytime: the tubes off, grey glass, and one switches on.", "Same sign, as a 1-bit pixel sprite."],
    tech: "text glow + layer glow · light spill blend · flipped duplicate for the reflection · rain by expression",
  },
  w: 1080, h: 1080, dur: DUR, bg: MORTAR, seed: 11,
  async build(f) {
    // Bricks: one path, running bond, a little irregular.
    let d = "";
    const BW = 120, BH = 44, G = 8;
    for (let r = 0; r * (BH + G) < FLOOR_Y + 540; r++) {
      const y = -540 + r * (BH + G);
      for (let x = -540 - (r % 2 ? BW / 2 : 0) - BW; x < 540; x += BW + G) {
        const j = Math.round((L.rand() - 0.5) * 4);
        d += `M${x} ${y + j * 0.5}h${BW + j}v${BH}h${-(BW + j)}Z`;
      }
    }
    const bricks = await L.path(f, d, { name: "Bricks", fill: BRICK, x: 0, y: (-540 + FLOOR_Y) / 2 });

    // Light spill on the wall: two soft pools, screen-blended.
    for (const [c, y, w, h, o] of [[PINK, -140, 900, 520, 0.38], [CYAN, 70, 760, 360, 0.28]]) {
      const id = await L.ellipse(f, { name: "Spill", width: w, height: h, fill: c, x: 0, y, set: { opacity: o } });
      await L.fx(id, "blur", { radius: 160 });
      await ac.layer.patch({ id, ops: [{ op: "set", path: "blendMode", value: "screen" }] });
      await ac.expression.set({ id, property: "opacity", source: `${o} * (0.92 + 0.08 * sin(#time * 37) * sin(#time * 5))` });
    }

    // The pavement.
    await L.rect(f, { name: "Pavement", width: 1080, height: 540 - FLOOR_Y, fill: FLOOR, x: 0, y: (FLOOR_Y + 540) / 2 });
    const kerb = await L.rect(f, { name: "Kerb light", width: 1080, height: 3, fill: "#3a2230", x: 0, y: FLOOR_Y });

    // The sign: "open" (script) over "LATE" (tube capitals), an underline tube.
    const glow = (c, r) => [{ id: `tfx_g${r}`, type: "glow", color: c, radius: r, intensity: 2.2 }];
    const open = await L.text(f, "open", { name: "open", y: -190, style: { fontFamily: "Yellowtail", fontSize: 300, color: PINK_CORE, textEffects: glow(PINK, 22) } });
    await L.fx(open, "glow", { color: PINK, radius: 60, intensity: 1.2 });
    await ac.animation.set({ id: open, slot: "in", preset: "flicker-on", target: "layer", durationMs: 1400 });

    const late = { fontFamily: "Tilt Neon", fontSize: 176, color: CYAN_CORE, letterSpacing: 18, textEffects: glow(CYAN, 18) };
    const lat = await L.text(f, "LAT", { name: "LAT", y: 60, startMs: 700, style: late });
    const e = await L.text(f, "E", { name: "E (failing)", y: 60, startMs: 700, style: late });
    const wl = (await L.box(lat)).width, we = (await L.box(e)).width;
    const x0 = -(wl + we) / 2;
    await L.pos(lat, x0 + wl / 2, 60);
    await L.pos(e, x0 + wl + we / 2, 60);
    for (const id of [lat, e]) {
      await L.fx(id, "glow", { color: CYAN, radius: 50, intensity: 1.1 });
      await ac.animation.set({ id, slot: "in", preset: "flicker-on", target: "layer", durationMs: 900 });
    }
    // The E fails twice a loop: a stutter, a dropout, a stutter.
    // (expressions are one value: a window a<t<b is clamp((t−a)·1e3)·clamp((b−t)·1e3))
    const win = (a, b) => `clamp((mod(#time, 4) - ${a}) * 1000, 0, 1) * clamp((${b} - mod(#time, 4)) * 1000, 0, 1)`;
    await ac.expression.set({ id: e, property: "opacity", source: `1 - 0.88 * (${win(2.3, 2.42)} + ${win(2.5, 3.1)} + ${win(3.16, 3.22)})` });

    // The underline tube draws itself after the words.
    const ul = await L.path(f, "M-300 0 C -150 -26 150 26 300 0", { name: "Underline tube", startMs: 1300, stroke: { color: "#ff8cc6", width: 10, cap: "round" }, fill: null, x: 0, y: 200 });
    await L.fx(ul, "glow", { color: PINK, radius: 34, intensity: 2.6 });
    await ac.animation.set({ id: ul, slot: "in", preset: "draw", durationMs: 700, easing: L.EASE.out });

    // One group, so the reflection is the same picture.
    const g = await ac.layers.group({ ids: [open, lat, e, ul], name: "Sign" });
    const sign = { id: g.id ?? g.groupId };
    const dup = await ac.layers.duplicate({ ids: [sign.id] });
    const refl = (dup.ids ?? [dup.id])[0];
    await L.named(refl, "Reflection");
    // Mirror about the kerb line: y' = 2·FLOOR_Y − y.
    // Mirror about the kerb, squashed: a point at y lands at FLOOR_Y + S·(FLOOR_Y − y).
    const S = 0.55, sy = (await ac.layer.get({ id: sign.id, fields: ["transform"] })).transform.y;
    await L.set(refl, { scaleY: -S, y: FLOOR_Y + S * (FLOOR_Y - sy), opacity: 0.32 });
    await L.fx(refl, "blur", { radius: 10 });
    await L.fx(refl, "wave", { angle: 90, wavelength: 46, amplitude: 5, cross: 0.2 });
    await ac.layers.restack({ ids: [refl], to: { below: kerb } });

    // Rain: thin streaks in three depths, each falling on its own loop.
    for (let i = 0; i < 46; i++) {
      const depth = i % 3, len = 30 + depth * 26, x = Math.round(-560 + L.rand() * 1120);
      const id = await L.path(f, `M0 0 L ${-len * 0.18} ${len}`, { name: `Rain ${i + 1}`, stroke: { color: "#b9a3c9", width: 1 + depth * 0.8, cap: "round" }, fill: null, x, y: 0, set: { opacity: 0.12 + depth * 0.1 } });
      const speed = 900 + depth * 700, ph = Math.round(L.rand() * 1200);
      await ac.expression.set({ id, property: "y", source: `-600 + mod(#time * ${speed} + ${ph}, 1200)` });
    }

    const v = (await ac.layer.create({ kind: "adjustment", ...L.span(f, { name: "Lens" }) })).id;
    await L.fx(v, "vignette", {});
    await L.fx(v, "grain", {});
  },
};
