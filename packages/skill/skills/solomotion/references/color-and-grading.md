# Colour and grading

## Palettes

- Build from roles: ground, surface, ink, secondary ink, one accent (the design system names them). Use the accent on 5–10% of the frame.
- Harmonies that stay tasteful: **analogous** (neighbours on the wheel) for calm; **complementary accent** (one small warm spot in a cool scene) for focus; **monochrome + one accent** for premium.
- Dark scenes: never pure black — tint the ground toward the accent's hue (`#0B0A12` for violet, `#0A0F12` for teal).
- Saturation budget: one saturated element; everything else muted.
- Contrast: body text ≥ 4.5:1 against what is behind it *at the busiest frame*.

## Logos and marks on imagery (the mistakes that read as amateur)

- **Use the mono version of a mark on a busy or saturated ground.** A gradient logo (orange→pink) over a violet night sky fights it and turns to mud; the same mark in white/cream with a soft cool glow reads instantly and belongs to the scene. Brand colour returns in the type or a small accent, not by forcing the gradient onto a clashing picture.
- **Give a mark a clearing.** A large, very soft radial scrim of the ground's darkest colour (≈70% at the centre → 0) behind the logo and its type — invisible as a shape, decisive for contrast.
- **A partner mark sits on its own tile.** Claude's spark (or any partner icon) goes on its brand-coloured or off-white rounded tile, app-icon style (corner ≈ 27% of the side), at the cap height of the line it sits in. A bare orange spark on a night sky disappears.
- **Never put one logo inside another.** A co-brand is a LOCKUP: mark · light-weight "×" · mark, side by side, equal optical weight, symmetric gaps. Merging a partner mark into your nucleus reads as a smudge, not a story.
- **One system for the end card**: mark → small tracked kicker → wordmark → one supporting line → CTA. Same centre axis, consistent gaps, one shadow recipe.

## The grade graph

A colour grade is an effect card (`grade`) holding a node graph, like DaVinci Resolve: **Source → correctors → Output**. Each corrector holds an ordinary stack of colour effects; nodes can run in series, in parallel (mixed back in), or as an "outside" node (the inverse of another node's key — grade the background of a secondary).

1. `grade_node {id, name: "Balance"}` — creates the grade with its first corrector.
2. `grade_effect {id, nodeId, type, values}` — put colour cards in it. `catalog_list layer-effects` with query `color` lists them (`adjust`, `colorGrade`, `gradientMap`, `vignette`, `posterize`, `overlay` …); `catalog_get` shows each field and range.
3. More nodes in order: `grade_node {after: <nodeId>, name: "Look"}`; parallel: `{parallelTo}`; secondary background: `{outsideOf}`.
4. `grade_read` shows the graph. Every value keyframes at `lfx.<card>.n.<node>.fx.<effect>.<field>` — animate a grade (a look that warms as the sun comes up).

Keys (qualifier by hue/sat/lum, depth, power windows that can follow a tracker) limit a node to part of the picture: edit with `layer_patch` on the node's `key` (`api_describe {type:"layerEffect", path:"[type=grade]"}`).

Grade the **whole edit** with an adjustment layer on top (`layer_create {kind:"adjustment"}`) and put the grade on it.

## Node order that works

1. **Balance** — exposure and white balance: neutral whites, blacks just above clipping, contrast to taste.
2. **Match** — make shots agree (same skin, same sky) before styling.
3. **Look** — the creative intent (below).
4. **Secondaries** — skin protection, sky, a product colour — keyed nodes.
5. **Finish** — vignette, grain, halation-style glow, gentle sharpening.

## A look from a feeling

| The user says | Move |
|---|---|
| warm, nostalgic, golden hour | temperature +, highlights toward amber, shadows toward teal-brown, saturation −10%, lifted blacks, soft grain |
| cinematic, blockbuster | teal shadows / orange skin (keep skin natural), contrast +, saturation of blues/greens down, slight vignette |
| clean, commercial, Apple-ish | neutral whites, high clarity, gentle contrast, saturation natural, no grain |
| moody, noir, tense | exposure −, contrast +, desaturate toward monochrome, cool shadows, crushed blacks, vignette |
| dreamy, soft, romantic | lifted blacks, low contrast, pastel highlights (pink/peach), glow/bloom, grain |
| retro 70s film | warm mids, faded blacks, greens toward olive, posterized highlights slightly, strong grain |
| cyberpunk, neon night | magenta/cyan split, saturated highlights, deep blue shadows, glow on lights |
| documentary, honest | neutral, restrained contrast, preserve skin, nothing stylised |

Always look at the result (`view_render` at `inspect` on a frame with a face or the key subject). Skin is the reference — if faces look wrong, the grade is wrong.
