// 07 · LIQUID GLASS — interface made of glass, over a living wallpaper.
//
// The wallpaper is four blurred colour blobs drifting on slow sines. Every
// panel above it is a near-clear shape with the Liquid glass effect, so it
// refracts whatever drifts behind it — nothing about the glass is faked.

const DUR = 8000;
const INK = "#15131d", WHITE = "#ffffff";
const BLOBS = [["#D97757", -260, -300, 620], ["#C46686", 300, -120, 560], ["#6A9BCC", -200, 260, 640], ["#E8B866", 320, 340, 460]];
const GLASS = { refraction: 0.55, depth: 34, dispersion: 0.25, frost: 22, light: 1.1, lightAngle: -60 };

async function panel(f, name, w, h, x, y, r, o = {}) {
  const id = await L.rect(f, { name, width: w, height: h, cornerRadius: r, fill: "#FFFFFF14", x, y, ...o });
  await L.fx(id, "glass", GLASS);
  return id;
}

return {
  meta: {
    no: "07", family: "Glass & UI", name: "Liquid Glass",
    line: "A now-playing widget, a toggle and a notification, all real refracting glass over a drifting wallpaper.",
    prompt: "A liquid-glass interface floating over slowly drifting colour blobs: a now-playing card with a moving progress bar, a toggle that flips with a spring, and a notification that drops in from the top and leaves. Everything refracts what's behind it. Calm, Apple-level polish. 8 s.",
    remix: ["Make it a weather widget: temperature counts up, a sun icon rotates.", "Light mode: pale wallpaper, ink text, frost turned up.", "Turn the notification into your app's onboarding tip."],
    tech: "liquid glass effect on near-clear shapes · blurred blobs on sine expressions · spring easing · pivot-left scale for the progress bar",
  },
  w: 1080, h: 1080, dur: DUR, bg: INK,
  async build(f) {
    // Wallpaper.
    for (const [i, [c, x, y, s]] of BLOBS.entries()) {
      const id = await L.ellipse(f, { name: `Blob ${i + 1}`, width: s, height: s * 0.9, fill: c, x, y });
      await L.fx(id, "blur", { radius: 120 });
      await ac.expression.set({ id, property: "x", source: `${x} + sin(#time * ${0.35 + i * 0.07} + ${i * 1.7}) * 140` });
      await ac.expression.set({ id, property: "y", source: `${y} + cos(#time * ${0.3 + i * 0.05} + ${i}) * 110` });
    }
    const t = (s, o) => L.text(f, s, { ...o, style: { fontFamily: L.F.sans, color: WHITE, align: "left", ...o.style } });
    const left = async (id, x, y) => { const b = await L.box(id); await L.pos(id, x + b.width / 2, y); };

    // The now-playing card.
    const CY = 20, CW = 800, CH = 300;
    const card = await panel(f, "Card glass", CW, CH, 0, CY, 72, { startMs: 0 });
    await ac.animation.set({ id: card, slot: "in", preset: "zoom-out", durationMs: 900, easing: L.EASE.out });
    const art = await L.rect(f, { name: "Cover art", width: 196, height: 196, cornerRadius: 40, fill: "#D97757", x: -CW / 2 + 52 + 98, y: CY - 20 });
    const spark = await L.text(f, "✦", { name: "Cover spark", x: -CW / 2 + 150, y: CY - 22, style: { fontSize: 110, color: "#FAF9F5" } });
    await ac.expression.set({ id: spark, property: "rotation", source: "#time * 20" });
    const TX = -CW / 2 + 52 + 196 + 40;
    const title = await t("Midnight Prompt", { name: "Song", style: { fontSize: 44, fontWeight: 650 } });
    await left(title, TX, CY - 74);
    const artist = await t("Claude & you", { name: "Artist", style: { fontSize: 30, opacity: 0.72 } });
    await left(artist, TX, CY - 26);
    const TW = CW / 2 - 56 - TX;
    await L.rect(f, { name: "Progress track", width: TW, height: 10, cornerRadius: 5, fill: "#FFFFFF40", x: TX + TW / 2, y: CY + 52 });
    const bar = await L.rect(f, { name: "Progress", width: TW, height: 10, cornerRadius: 5, fill: WHITE, x: TX, y: CY + 52, set: { "anchor.x": 0 } });
    await L.keys(bar, "scale", [[0, 0.18, "linear"], [DUR, 0.62]]);
    const t0 = await t("1:12", { name: "Elapsed", style: { fontSize: 22, opacity: 0.6, fontFamily: L.F.mono } });
    await left(t0, TX, CY + 88);
    const t1 = await t("−2:28", { name: "Remaining", style: { fontSize: 22, opacity: 0.6, fontFamily: L.F.mono } });
    const b1 = await L.box(t1);
    await L.pos(t1, TX + TW - b1.width / 2, CY + 88);
    for (const id of [art, spark, title, artist, t0, t1]) await ac.animation.set({ id, slot: "in", preset: "fade-up", target: "layer", durationMs: 700 });

    // The toggle: glass track, white knob that springs across at 3 s.
    const TYY = 330;
    const track = await panel(f, "Toggle glass", 220, 120, -150, TYY, 60);
    const tint = await L.rect(f, { name: "Toggle tint", width: 220, height: 120, cornerRadius: 60, fill: "#788C5D", x: -150, y: TYY, set: { opacity: 0 } });
    await L.keys(tint, "opacity", [[2900, 0, "ease-out"], [3300, 0.85]]);
    const knob = await L.ellipse(f, { name: "Knob", width: 96, height: 96, fill: WHITE, x: -200, y: TYY });
    await L.keys(knob, "x", [[2900, -200, "ease-out-back"], [3400, -100]]);
    await L.keys(knob, "scale", [[2800, 1, "ease-out"], [2950, 1.18, "ease-out-back"], [3400, 1]]);
    const lab = await t("Focus mode", { name: "Toggle label", style: { fontSize: 34, fontWeight: 600 } });
    await left(lab, -10, TYY - 18);
    const sub = await t("Only Claude gets through", { name: "Toggle sub", style: { fontSize: 24, opacity: 0.65 } });
    await left(sub, -10, TYY + 22);

    // The notification drops in, waits, and goes back up.
    const NY = -330;
    const note = await panel(f, "Notification glass", 820, 148, 0, NY, 74, { startMs: 1200, durationMs: 5400 });
    const icon = await L.rect(f, { name: "App icon", width: 84, height: 84, cornerRadius: 22, fill: "#D97757", x: -410 + 40 + 42, y: NY, startMs: 1200, durationMs: 5400 });
    const ic = await L.text(f, "✦", { name: "Icon spark", x: -410 + 82, y: NY - 2, startMs: 1200, durationMs: 5400, style: { fontSize: 50, color: "#FAF9F5" } });
    const nt = await t("Claude", { name: "Note title", startMs: 1200, durationMs: 5400, style: { fontSize: 30, fontWeight: 650 } });
    await left(nt, -410 + 150, NY - 22);
    const nb = await t("Your scene is ready. Want it in neon?", { name: "Note body", startMs: 1200, durationMs: 5400, style: { fontSize: 26, opacity: 0.8 } });
    await left(nb, -410 + 150, NY + 20);
    const now = await t("now", { name: "Note time", startMs: 1200, durationMs: 5400, style: { fontSize: 22, opacity: 0.55 } });
    const nw = await L.box(now);
    await L.pos(now, 410 - 44 - nw.width / 2, NY - 22);
    const g = await ac.layers.group({ ids: [note, icon, ic, nt, nb, now], name: "Notification" });
    const gid = g.id ?? g.groupId;
    await L.keys(gid, "y", [[1200, -260, "ease-out-back"], [1900, 0], [6000, 0, L.EASE.zoom], [6550, -260]], "comp");
    await L.keys(gid, "scale", [[1200, 0.9, "ease-out-back"], [1900, 1]], "comp");
  },
};
