# Effects

Effects are ordered stacks; the first card applies first. Three domains:

- **Layer effects** (`effects`, path `lfx.<id>.<field>`) — process the whole layer's pixels.
- **Text effects** (`style.textEffects`, `tfx.…`) — per-glyph: shadow, glow, extrude, echo. They move with each letter's animation.
- **Audio effects** (`audioEffects`, `afx.…`) — EQ, reverb, echo, compressor, saturator, filter, chorus (also flanger/vibrato presets), phaser, tremolo (volume or auto-pan), ring mod (robot voice), bitcrush, stereo (width/pan).

`effects_add {id, domain, type, values}` (`id` may be a COMP id: the card goes on the whole frame's own effects) · `effects_look {id, look}` (a whole named stack, below) · `effects_update {id, effectId, values|enabled|index|remove}` · inside `layer_patch` (setting a whole `effects` list) a card's fields are FLAT on the card — `{id, type:"glow", size:22, intensity:1.4}`, not under `values`; an unknown field is refused by name · `catalog_list layer-effects` (with `query`) · `catalog_get layer-effects <type>` for fields, ranges and defaults. Every numeric field keyframes and can be driven by an expression or modulator.

## The families and when they earn a place

| Family | Types | Use for |
|---|---|---|
| Shadow & glow | shadow, innerShadow, glow, longShadow | separation from the background (soft shadow), neon and light (glow), graphic depth (long shadow) |
| Blur | blur, directionalBlur, zoomBlur, spinBlur, sharpen | depth of field on backgrounds, speed (directional), impact (zoom), focus pulls (animated blur) |
| Colour | adjust, grade, colorGrade, gradientMap, posterize, overlay, vignette | correction and looks (see colour-and-grading.md); `overlay` `mode: "image"` + `image` (an asset id) tiles a picture inside the shape — `scale` sizes the tile, `angle` turns it (90 = upright), `mirror` hides seams |
| Material | glass | liquid-glass panels over busy backgrounds — refracts what is behind; one pane per shot |
| Light | shine, lightRays, lensFlare, lightning | a sweep across a logo (shine), god rays, a flare on a reveal, energy |
| Hand-made | boil, roughenEdges | drawings that feel alive (boil), torn/chalk/burnt edges (roughenEdges) |
| Analog | grain, filmDamage, scanlines, noise | texture and era; grain at low strength ties graphics to footage |
| Distort | rgbSplit, bulge, wave, twirl, lensDistort, goo, glitch | glitch transitions, liquid/organic motion, hand-made edges |
| Space | lens, shockwave, star, starfield, nebula | gravity bending the sky (a black hole, an Einstein ring), a blast ripple through space, a boiling star coloured by its temperature, a real night sky, glowing gas clouds |
| Texture | surface | a real MATERIAL the picture is made of — paper, card, cloth, felt, clay, wood, newsprint; foil, chrome, neon, stained/frosted glass, crystal, soap film, ferrofluid, kintsugi, tufted rug, CRT phosphor, rice paper, marbling — and a MORPH from one to another; the cure for "flat" |
| Stylize | stroke, halftone, pixelate, bevel, chromaKey | outlines, print looks, retro games, green screen — `chromaKey` is live and free for a FLAT backdrop (green screen, studio white); for a real-world background use `media_remove_background` (AI cut-out, image or video) |

## Rules of thumb

- One hero effect per shot. Stack at most two on text.
- Shadows: large blur, low opacity, offset downward — a soft lift, not a smudge.
- Glow reads best on dark grounds with a saturated source colour.
- **A small bright thing — a star, a spark, a node, a dot under 20 px — takes `glowFalloff: "light"`** (a lens bloom: hot core, faint wide tail). The default `even` spreads its few pixels over the whole `size`, so the dot barely glows and the faint halo bands into rings on a dark sky. Keep `even` for big shapes and neon type.
- Glass needs something interesting behind it; over a flat colour it is invisible.
- Animated effects (a shine sweep, a glitch burst, a blur pull) should be brief — 200–600ms — and tied to a beat or a reveal.
- Chroma key: `chromaKey` on the footage, then tune the key colour, tolerance and spill.
- Background removal on a still image exists in the editor (context menu); through the API use `generate_image` edits with `parentAssetId` when a provider can, or tell the user.

## Which effect for which job

Every layer effect works on the layer's rendered pixels, so one card behaves the same on text, vectors, images (with or without a background), drawings, video and groups. Put a card on a **group** to treat several layers as one piece.

- **shine** — a band of light crossing the layer on its own clock: `duration` s per pass, `delay` s of stillness before each, `loop`. `position` is the start offset (0 = before the layer, 1 = past it) and is keyable at `lfx.<id>.position` — set `duration: 0` to drive it by hand. A pass fully enters and fully leaves (bands, spacing and bloom included), so a one-shot (`loop: false`) leaves nothing parked. One pass on a reveal: `loop: false`, `delay` = when it should cross.
- **boil** — hand-drawn life: lines redraw themselves on their own frame rate, like traced cel animation. The answer to "make this drawing / logo / sticker feel alive". `style` boil (fine shimmer) · wobble (soft, jelly) · jitter (scratchy chalk); `amount` px (1–3 gentle, 6+ falling apart), `scale` = wiggle size, `variants` = drawings in the loop (2–4 classic, 0 never repeats), `rate` 8–12 fps reads hand-made (12 = "on twos" at 24), `shake`/`rotate` for a paper that wasn't pinned. Presets: Line boil, Sketchy, Jelly wobble, Hand-held.
- **roughenEdges** — only the alpha edge moves; the inside stays sharp, so text stays readable. Torn paper, chalk, burnt, rusty. Its `rate` > 0 makes the edge crawl; combine with boil for a crayon look.
- **goo** — nearby shapes swell and fuse like liquid (metaballs). Put it on a GROUP of circles/blobs that move near each other; `blur` = reach, `threshold` = how tight the merge.
- **glass** — liquid glass: refracts and frosts what is behind the layer. Needs a busy backdrop (photo, gradient, moving type) or it is invisible. A pill or panel shape, not a word.
- **goo + glass** — liquid-glass blobs that merge: a group of moving shapes with `goo` FIRST, then `glass` (order matters — glass reads the merged silhouette).
- **lightning** — `mode` bolt (between two points), burst (from a centre), outline (arcs crawl along the layer's outline), fill (arcs inside the shape). Outline follows the line **as drawn**: under a Draw animate-in or a stroke `trim`, the arcs ride only the inked part — animate `trim.end` or add the draw-on and the energy chases the pen.
- **halftone** — print/comic dots; big `size` for posters, small for texture over footage.
- **glitch / rgbSplit** — short bursts on cuts and beats (100–300ms), never constant.
- **grain** — the cheapest way to make graphics sit in footage; 0.05–0.15.
- **filmDamage** — dust, scratches, flicker and weave. Frame slips (the print jumping a frame, with a splice bar) are OFF unless `splices: true`; `jump` is only their odds. Leave them off unless the brief is a genuinely broken reel — a one-frame lurch reads as a render bug.

Cards that move on their own (grain, noise, roughenEdges, filmDamage, scanlines, boil, glitch, lightning, shine, wave, glass ripples) carry one switch, `animate`. Off, the card holds one look for the whole clip — its keys and modulators still play. **Grain, noise and roughenEdges arrive still**; the rest arrive moving. Keep grain still under type and on paper or flat grounds: moving full-frame texture tires the eye and is the costliest picture a video codec can get. Turn it on (`effects_update {id, effectId, values: {animate: true}}`) for a film look over footage.

The re-rolling cards share one clock: `rate` (re-rolls per second, 0.1–120), `jitter`, `stutter`, `seed`. Change `seed` to get a different take of the same look — held still, `seed` picks which one.

## Texture — give anything a material

Flat vector art looks flat because nothing in it has a surface. **`surface`** is a lit material: a height field (fibres, tooth, threads, flutes, folds) raked by a light at `lightAngle`, and the fibres' own tone. `material` picks the recipe and every dial is relative to it (`scale`, `relief`, `tooth` are 1 at the tuned value), so switching material alone gives a finished one.

- **Your own texture**: `texture` is an image asset id (`media_import` the scan/photo, then `effects_update {values: {texture: "<assetId>"}}`; `""` goes back to the material's own pattern). The picture REPLACES THE PATTERN — its light is the sheet's high ground, its dark the valleys — and `material` keeps deciding how it BEHAVES: a crumpled-paper scan as `chrome`, a fabric photo as `felt`. `textureColor` 0–1 prints the picture's own colours too (0 = relief and tone only); `textureTiling: "mirror"` hides the seam of a photo that was not made to tile. `scale`, `relief`, `tooth` and the light work on it as on any material. A non-image id is refused.
- `colorMode`: `lit` (keep the picture's colours, add the material's light — default), `multiply` (print onto the material's own colour × `dye`; kraft warms everything), `under` (the material REPLACES the background — black card under chalk).
- `lift` px: shapes stand off the sheet like cut paper — a lit edge toward the light, a shade and a soft cast shadow away from it (`shadow`). `edge` 0–1: the material eats the outline (torn fibres; felt fuzz reaching out in the shape's colour). `breakup` 0–1: ink only on the tooth's crowns (chalk, dry brush).
- `lights` 0–1 (**Spare lights**): light in the picture is not printed on the card. Mark what gives off light with `layer_patch {id, ops: [{op: "set", path: "emitsLight", value: true}]}` (an ember, a lamp, a laser line, a lit sign; on a group or a nested comp it makes everything inside a light). The material is then laid on the picture WITHOUT the lights and the lights go back on top untouched: a white-hot core stays white, a glow's halo is light over the textured card. Works at any depth (lights inside a nested comp under a frame look). `lightsFrom: "colour"` instead guesses light from chroma, for video or photos that have no layers to mark; it cannot see a white core. Leave `lights` 0 when the colours themselves should be printed (riso, felt).
- A frame look reads the comp's own picture, so it looks the same at any zoom: nest a textured comp in a scaled camera group and the chalk keeps its cut (the texture scales with the picture).
- On a **whole frame** it finds a flat illustration's shapes by its ground (the one colour covering most of the frame), so `lift`, `edge`, `breakup` and `under` work on the frame too. A photo has no ground: there it is a texture only.
- `animate` + `rate` 12 re-rolls the sheet each held frame (stop-motion paper). Still by default — and still is one cached picture for the whole film.
- `lift` below 0 PRESSES the shapes into the sheet (letterpress, deboss). `colorMode: "blind"` drops the ink: only the relief shows (blind emboss).

### Behaviour — a material responds to the shape

Every region of one colour is a PIECE, and the material shapes each piece: `body` (felt's pillow, clay's dome, chrome's bulge, neon's tube along the edge, a paper bevel), `sheen` (highlights; foil's rainbow, which lives in the angle; chrome's studio reflection), `glow` (neon's hot core and halo, a phosphor's bloom, light through glass), `flow` (the picture carried along the material: marbling swirls it, frost scatters it). Each is × the material's tuned behaviour — 1 as tuned, 0 off, up to 4. Cut-out materials (paper, card, felt, clay, wood, cloth) round as far as they are THICK: their body needs `lift`. A sun drawn on a star is two pieces — two tubes, two pillows.

| Material | Feels like | Note |
|---|---|---|
| `foil` | premium, sticker, shimmer | key `lightAngle` and the rainbow slides across it |
| `chrome` | Y2K, liquid metal, luxury | best `colorMode: "under"` on its dark studio |
| `neon` | night, sign, bar | `under` puts the brick wall behind; each colour region becomes its own tube |
| `stainedGlass` | church, window, mosaic | lead along every colour boundary; the ground is glass too |
| `frosted` | privacy, winter, soft reveal | key `flow` down to 0 to "defrost" the picture |
| `crystal` | gem, ice, luxury | faceted; `under` |
| `soapFilm` | dreamy, bubble, oil slick | clear dome with swirling thin-film colour; `under` |
| `ferrofluid` | science, experimental | `edge` is the magnetic field: key it 0→0.8 and it spikes |
| `kintsugi` | repair, wabi-sabi, story of healing | glazed ceramic mended with gold |
| `tufted` | cosy, rug, punch needle | yarn loops in soft pillows, `edge` fuzz |
| `phosphor` | CRT, arcade, retro tech | RGB stripes + bloom; shines on a DARK picture |
| `ricePaper` | calligraphy, ink, calm | with `edge` up, ink bleeds along the fibres |
| `marble` | marbling, fluid, endpapers | key `flow` 0→1 and the picture marbles |
| `newsprint`, `wood`, `graph` | headline / woodblock / notebook | sheets |

### Morph — one material becoming another

`to` names the material it becomes and `morph` (0–1, keyable) how far; `morphStyle` is the front: `spread` (patches grow until they meet — frost, rust, a stain), `sweep` (a ragged front from the light's side), `fade` (all at once). Both materials render whole and blend at the front, so felt becoming foil is the pillow giving way to the bevel and rainbow — not a dissolve between textures. For a CHAIN use `effects_morph {id, stops: [{material: "paper", atMs: 0}, {material: "felt", atMs: 1500}, {material: "foil", atMs: 3000}], overMs: 800, style: "spread"}` — it keys `material`/`to` on hold keys and `morph` 0→1 per link so the switch between links is invisible. Apply a look first: lift, edge, colour mode and light are SHARED by every material in the chain (`lift` 6 + `edge` 0.3 suits most). Morph on a beat: end each `atMs` on a hit.

### Looks — one call


**A comp's own effects** are one stack, carried by its "Frame effects" layer (the topmost whole-comp adjustment; it is made the first time you add to a comp, and the result's `id` is that layer, `comp` the comp). Read it with `frame_get {id: <comp>}` → `effects: {layerId, cards} | null`. Replace it with `frame_update {id, effects: [{type: "vignette"}, ...]}` (cards in render order, ids minted; cards that go take their keys with them) and clear it with `effects: []` (the layer goes too). Key a card on the layer: `lfx.<effectId>.<field>` with `id: layerId`. A build script that rebuilds its look should set `frame_update {effects}` rather than add, so a re-run never stacks a second copy.

`catalog_list looks` lists every whole-stack look (layer, text, particle) with its `cards`; `effects_look {id, look}` applies one, one undo step, `id` a layer or a COMP (whole frame).

**A look is a GROUP card.** On a layer or comp it lands as `{type: "group", name, look, mix}` followed by its cards, each carrying `group: <groupId>`; what the layer already wore stays, the look runs after it. The result gives `groupId` and `mixPath` (`lfx.<groupId>.mix`): `mix` 0–1 crossfades the whole look over the layer as it arrived (1 = the cards exactly, 0 = untouched) and keys like any field — a look can fade in. To TRY looks, swap the one a group wears: `effects_look {id, look, into: groupId}` keeps its place and mix; never stack a second look to compare. `effects_update {id, effectId: groupId, values: {mix: 0.6}}` or `enabled: false` acts on the whole look; its cards are ordinary cards (tune them by `effectId`). `replace: true` is the old whole-stack swap with bare cards. Text and particle looks always replace their stack. The **Texture** looks:

| Look (`id`) | Feeling | Made of |
|---|---|---|
| Paper cut-out (`paper-cut-out`) | crafted, warm, explainer | paper + lift + a torn edge |
| Stop motion (`stop-motion`) | handmade, playful, on twos | paper re-rolling at 12 + gate weave + flicker; **holds the frame at 12 fps** |
| Chalk on card (`chalk-on-card`) | classroom, a sketch, a secret | the ground turns to black card, every fill breaks on its tooth, a gradient map turns what is left into pale chalk with a breath of its colour, white dust |
| Riso print (`riso-print`) | zine, indie poster | the picture separated into fluorescent pink + blue on cream (warm → pink, cool/dark → blue, purples where they meet), two screens, the pink drum 6 px off |
| Cross-stitch (`cross-stitch`) | cosy, pixel art in thread | one stitch per 24 px cell in the cell's colour, linen showing between (pixelate `cross` + `board`), the weave lighting it |
| LED board (`led-board`) | stadium, sign, score | dot cells on a dark board + light bloom |
| Felt (`felt`) | soft, children's, puppet | felt, fuzzy edges, puffy lift |
| Cardboard (`cardboard`) | DIY, box, maker | corrugated card with lift |
| Crumpled paper (`crumpled-paper`) | a note, a memory, rough draft | folds and creases catching the light |
| Claymation (`claymation`) | puppet, playful, handmade | clay (lumps, fingerprints, tool drags) + puffy lift; **holds the frame at 12 fps** |
| Blueprint (`blueprint`) | technical, science, a plan | Prussian-blue sheet with a drafting grid under + a blue gradient map (shapes print pale) |
| Engraving (`engraving`) | banknote, scientific plate, vintage | a line screen whose WEIGHT carries the tone, on paper |
| Watercolour (`watercolor`) | storybook, soft, painted | cold-press paper; the wash pools darker at its wet edge |
| Holographic foil (`holo-foil`) | premium, sticker, shimmer | foil flakes + grating; rainbow by angle |
| Liquid chrome (`liquid-chrome`) | Y2K, liquid metal | inflated mirror with a studio horizon, on dark |
| Neon glass (`neon-glass`) | night, sign | glowing tubes on a brick wall |
| Stained glass (`stained-glass`) | church, window | panes in lead, light through them |
| Frosted glass (`frosted-glass`) | privacy, winter | the picture scattered through etched glass |
| Crystal (`crystal`) | gem, ice, luxury | facets on dark |
| Soap film (`soap-film`) | dreamy, bubble | clear dome, swirling thin-film colour |
| Ferrofluid (`ferrofluid`) | science, experimental | black wet mirror, spiking |
| Kintsugi (`kintsugi`) | healing, wabi-sabi | glazed ceramic, gold cracks |
| Tufted rug (`tufted-rug`) | cosy, handmade | yarn pile |
| CRT phosphor (`crt-phosphor`) | arcade, retro tech | RGB stripes + bloom + tube falloff; give it a DARK picture |
| Ink on rice paper (`ink-bleed`) | calligraphy, calm | ink bleeding along fibres |
| Marbling (`marbling`) | fluid, endpapers | the picture swirled on water |
| Letterpress (`letterpress`) | stationery, premium | pressed into thick cotton paper |
| Embossed paper (`embossed-paper`) | minimal, seal | white on white, relief only |
| Cyanotype (`cyanotype`) | botanical, vintage | sun-print: bright → Prussian blue, dark → paper white |
| Newspaper (`newspaper`) | headline, history | halftone on grey newsprint |
| Woodblock (`woodblock`) | ukiyo-e, relief print | ink skipping the wood's grain |
| Graph paper (`graph-paper`) | explainer, notebook | a printed grid under everything |
| Photocopy (`photocopy`) | zine, punk, flyer | hard black and white, toner specks; light colours drop out |
| VHS (`vhs`) | 90s, found footage | tape wobble + colour split + interlace + grain |
| Game Boy (`game-boy`) | handheld, 8-bit | big pixels in four greens |

- Built for flat illustrations (flat shapes on a plain ground) — what you and the user usually make. On a whole frame apply to the COMP id; on one hero object apply to that layer (a layer's alpha is its shape, so its shadow falls outside it).
- Blueprint maps by brightness: light shapes print pale on the sheet, dark ones sink into it. Give a frame meant for it light or saturated shapes on a DARK ground.
- Engraving is a mono screen: colour goes, tone stays. A white ground stays clean paper; anything mid-tone fills with lines.
- Stop motion is only honest if the motion steps: it sets the frame effects' `fps` to 12, and a frame's own effects at a rate hold the WHOLE frame there (posterize time) while the comp still exports at its rate. Any look can be stepped the same way: `layer_patch {id: <frame effects id>, ops: [{op: "set", path: "fps", value: 12}]}` (`null` follows the comp again) (15 on a 30 fps comp is even twos). On a layer, the look sets that layer's own `fps`.
- A look is added after what is there (a grade on the frame survives); to change looks use `into`, so the frame never carries two.
- Tune afterwards with `effects_update` (the result lists each card's `effectId`): `lift` 4–12 px, `edge` 0.2–0.4 for paper, `breakup` for chalk (it is the share of the tooth that loses its ink: 0.45 ≈ a third).
- Cost: a still surface is computed once. `lift`/`edge`/`breakup`/`under` and every behaviour (body, sheen, glow, flow) read the picture's pixels each frame the picture changes — 100–300 ms at 1080×1920 for the glass, metal and neon materials, about double during a morph (both materials render). Export is exact; playback may drop frames. Check with `view_render` stills, not playback.

`halftone` `shape: "line"` is an engraving screen: lines run along `angle` and their weight (not a dot's area) carries the tone, so white stays white. `halftone` `mode: "riso"` separates the picture into two inks (`inkColor`, `ink2Color`) on `paperColor`, each its own screen, the second `misregister` px off — any two-colour print. `pixelate` has a `board` colour behind its cells (dark = an LED sign; clear = what is beneath shows) and `halftone` a `paper` switch that lays `paperColor` under the marks in any ink mode. On an ADJUSTMENT layer a card that leaves gaps (pixelate, halftone, `depthMatte`) consumes the picture it reads, so the gaps show the comp's background, never the original photo; `scope.source: "over"` lays it over the original instead.

## Space

- **lens** — gravitational lensing: everything BEHIND its layer is bent as by a point mass (β = θ − θE²/θ). Put it on a small circle (any fill — the lens replaces its layer's picture; nulls are not drawn) ABOVE what it should bend. `radius` = the Einstein radius (a star straight behind becomes a ring there), `strength` 0–1 (key it up from 0 and space visibly starts to curve), `shadow` px (the black hole: 2.6× the horizon you gave the gravity well; 0 = a lens with no hole), `ring` / `ringWidth` / `ringColor` (the photon ring), `glow`, `reach` (× radius; past it nothing bends). An accretion disk BEHIND the lens arcs over its top and under its bottom by itself — the Interstellar picture is a consequence, never drawn. Presets: Black hole, Gargantua, Quiet hole, Dark matter, Einstein ring.
- **shockwave** — a ring that refracts what is behind it. Same carrier rule as the lens. Key `radius` 0 → past the frame (≈1–1.5 s, ease-out) and `strength` down to 0 so it dies as it travels; `width` its thickness, `chroma` the colour split, `light` a bright front. Presets: Blast, Supernova, Ripple, Gravitational wave.
- **star** — put it on a CIRCLE: the circle is the star (its size is the disc; key its scale to swell or collapse). `temperature` K (key 5800 → 30000: sunlight → blue-white, and it brightens), `granulation` (cell size × radius: 0.03 the Sun, 0.2+ a red supergiant's giant cells), `contrast`, `limb`, `corona` + `coronaSize`, `boil` (speed). Presets: Sun, Blue giant, Red supergiant, White dwarf.
- **starfield** — on a full-frame rectangle (its fill is the space between the stars, e.g. `#020309`). Realistic magnitudes and spectral colours, spikes on the brightest few, a faint galactic `band`, `twinkle` (stepped at `rate`). Key `driftX/driftY` to move through space: near stars move more than far ones (parallax), wrapping forever. Presets: Deep sky, Milky Way, Sparse, Still.
- **nebula** — glowing gas with dust lanes on the same rectangle. `coverage`, `scale`, `warp` (filaments), `dust`, three colours edge → body → core, `evolve` (key it) or `speed` with `animate`. Presets: Rose, Orion, Carina, Deep violet, Faint veil.
- **A sky is ONE rectangle with `nebula` FIRST, then `starfield`.** In that order the still nebula is computed once and kept; only the twinkle redraws. (Starfield first makes the nebula re-render every twinkle step.)
- Cost at 1080×1920 (M1, stage playback): starfield + still nebula ≈ 7 ms, a boiling star ≈ 9 ms, a lens ≈ 15 ms (it also redraws what is under it each frame). For a heavy build, hold the star still (`animate: false`) where its boil is not the subject, and keep the lens off-screen until the hole forms. Machines without WebGL2 draw the same pictures on the CPU, around a second a frame.

## Adjustments scoped to layers

An adjustment layer grades everything below it; `scope: {reach:"all", filter:{mode:"only", targetIds:[…]}}` limits it to the layers you name (a boil on the drawing, never on the UI). Name the drawing's layers only — putting a full-frame background (paper) in the list widens it to everything. A scoped stack only works over its layers' own area, so scoping is also the cheap way to run a heavy card.

## Heavy scenes — be kind to the machine

Distortion and material cards (goo, glass, boil, roughenEdges, big blurs, lightning, motion blur) cost real CPU per frame, and they multiply on large layers and 4K comps.

- Never play the timeline to check work. Look with stills: `view_render` for a frame, `view_frames` for motion.
- On a heavy comp use `detail: "glance"` and `count` 4–6; go to `look`/`inspect` only for the one frame or layer (`view_render {layers:[id]}`) you must judge.
- A stepped card (boil at 12 fps) only changes every 1/rate s: to judge it, sample 3–4 frames one step apart (e.g. 0, 83, 166, 250ms), not the whole comp.
- Playback keeps a layer's pictures: boil with `variants` 3 renders 3 times for the whole film, not every frame — even while the layer SLIDES (x/y keys, or an expression on x/y such as a scrolling hill). Rotating or scaling it, keying the card's fields, a modulator on the layer, or `variants: 0` makes each frame a new picture. A single `view_render` is a cold render and always pays the full cost — it is not the playback cost.
- Expressions (`expression_set`) never stop other layers being kept. A layer whose own field is bound to a variable TOKEN (a colour set to `var:<id>`) is drawn fresh every frame — keep tokens off heavy layers.
- Put one card on a group rather than the same card on ten children.
- **halftone** costs per dot: a 14 px screen over 1080² is ~12k dots, tens of ms, and a still halftone is kept. A tiny `size` over a full 4K frame is still heavy — keep it on the layer that needs it, not an adjustment over everything.
- Lower the cost before stacking: smaller `blur`/`amount`/`detail`, fewer `variants` do not change the read much.
