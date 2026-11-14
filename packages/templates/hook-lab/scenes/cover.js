// COVER (placeholder) — where the project opens. The finished cover is a live
// wall of all twenty hooks (the same idea as hook 05); until then, the title
// hangs on the hook.

const W = 1920, H = 1080;

return {
  async build(page, made) {
    const f = await L.comp({ name: "Hook Lab", w: W, h: H, bg: L.C.paper, dur: 2000, page, x: 0, y: 0 });
    L.setHook("cover");
    const title = await L.hero(f, "HOOK LAB", { size: 220, x: 0, y: 40, split: "O", name: "Title" });
    // The hook catches the title's first O by its ring: shank in front, the rest behind.
    const O = title.parts.find((p) => p.ch === "O");
    const pivot = [O.box.cx, O.box.t + 0.15 * O.box.h];
    await L.line(f, { x: pivot[0] + 23, eyeY: pivot[1] - 139, top: -H / 2 - 60, behind: O.id, name: "Cover line" });
    const kick = await L.text(f, "A TEMPLATE · BUILT BY CLAUDE", { name: "Kicker", style: { fontFamily: L.F.mono, fontSize: 20, fontWeight: 600, letterSpacing: 3, color: L.C.clay, lineHeight: 1.2 } });
    const kb = await L.box(kick);
    await L.pos(kick, 0, title.ink.b + 72 + kb.height / 2);
    const sub = await L.text(f, "Twenty hooks that earn attention, each with the prompt that made it.", { name: "Line", style: { fontFamily: L.F.serif, fontSize: 40, italic: true, color: L.C.ink, lineHeight: 1.2 } });
    const sb = await L.box(sub);
    await L.pos(sub, 0, title.ink.b + 72 + kb.height + 24 + sb.height / 2);
    const n = Object.keys(made ?? {}).length;
    const note = await L.text(f, `${n} built so far · the film's hooks are on the next page, the objects on Kit`, { name: "Note", style: { fontFamily: L.F.mono, fontSize: 16, letterSpacing: 1.5, color: L.C.graphite, lineHeight: 1.2 } });
    const nb = await L.box(note);
    await L.pos(note, 0, H / 2 - 72 - nb.height / 2);
    return f.id;
  },
};
