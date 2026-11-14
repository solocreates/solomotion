// 02 · THE LOOK — the card from 01, at rest. The two O's of HOOKS become
// eyes: pupils grow looking up, then drift to look straight at you (the second
// eye three frames late), blink once, and on "it worked" narrow into a smug
// squint and hold. No mouth, no body: the eyes carry it.

const W = 1080, H = 1080;
const DEFAULT = {
  dur: 6000,
  appear: 300,  // pupils grow, looking up
  look: 420,    // …and drift down to the camera
  lag: 100,     // the second eye, three frames late
  blink: 1200,  // one slow blink (a 12 fps flipbook)
  squint: 4100, // "…it worked."
};
const PIVOT = [0, -220];

return {
  meta: {
    no: "02", family: "Talk to them", name: "The Look", film: true, heavy: false,
    why: "Nobody can ignore a face looking at them, or a sentence that says exactly what they're doing.",
    prompt: "The word HOOKS sits on a paper card. Its two O's become eyes: ink pupils drift and look straight at the viewer, the second eye a few frames late. One slow blink, then a smug squint as the voice says 'it worked'. No mouth, no body: the eyes carry it. 6 s.",
    use: "You want to say the quiet part (\"you're still here\") without showing your own face.",
    hint: "The late second eye and the squint do all the acting. Keep everything else still.",
    remix: ["The eyes are in your logo: the O of any wordmark.", "The eyes follow the cursor as it moves.", "One eye winks on the punchline."],
    tech: "letters as shapes · pupils hidden under the O · a 12 fps flipbook blink · a squint shape key · the second eye a beat late",
  },
  w: W, h: H, dur: DEFAULT.dur, bg: L.C.paper, seed: 202,
  async build(f, ctx = {}) {
    const T = { ...DEFAULT, ...(ctx.timing ?? {}) };
    const card = await L.titleCard(f, { pivot: PIVOT });
    await L.line(f, { x: PIVOT[0] + 23, eyeY: PIVOT[1] - 139, behind: card.group });
    const eyes = await L.eyes(f, card.os, { kitPage: ctx.kitPage ?? ctx.page, origin: card.origin });
    eyes.appear(L.frame(T.appear), [0.05, -1]);
    eyes.look(L.frame(T.look), [0, 0], 520, T.lag);
    await eyes.blink(L.frame(T.blink));
    await eyes.squint(L.frame(T.squint), 280);
    await eyes.commit();
    L.ev(T.appear, "pupils-appear");
  },
};
