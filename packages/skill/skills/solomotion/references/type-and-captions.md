# Type, text styling and captions

## Setting type

A text layer's look is `style` (see `api_describe textStyle`): `fontFamily`, `fontSize` (px), `fontWeight` (100–1000 — picks a face the family ships; tweens on variable fonts), `fauxBold` (extra thickness ON TOP of the weight, a fraction of the size per edge — 0.03 reads as bold; use it when the family has no heavier face), `italic`, `color`, `letterSpacing`, `lineHeight` (multiplier), `align`, `direction` (auto/ltr/rtl — Arabic and Persian shape and order correctly, and fade cleanly: opacity composites a word or a whole layer once, so joins never double), `orientation` (vertical columns), `decoration`, `textCase` (display-only: upper/lower/title), `opacity`, `highlight` (the pill behind text), `textEffects` (per-glyph shadow · glow · extrude · echo).

- Wrap: `maxWidth` (box width); `maxHeight` + `verticalAlign` for a fixed box. Without `maxWidth` each paragraph is one line.
- `align: "justify"` fills the `maxWidth` box edge to edge by widening the spaces between words; a paragraph's last line sits at its start edge (right for RTL). Use it for columns of body copy and poetry; it does nothing without `maxWidth`.
- Fonts: the full Google Fonts catalogue by family name (`"Inter"`, `"Space Grotesk"`, `"Playfair Display"`, `"Vazirmatn"`…) plus anything the user installed (`font_install` for an attached file). A Google family loads by name — just set `fontFamily: "Geist"`; `font_install` is only for an attached file. If a render shows a fallback face, the family name was wrong.

### Craft

- **Scale**: pick sizes from the design system's scale, never arbitrary. A title is 3–5× the body. On a 1080-wide vertical comp: display 120–200, heading 72–96, body 40–48, caption 44–64.
- **Tracking**: tighten large display type (−2% to −4% of size: `letterSpacing: -4` at 180px); open up small all-caps kickers (+6 to +12).
- **Leading**: 0.95–1.05 for display lines, 1.3–1.5 for body.
- **Weight contrast** does more than size contrast: 800 title over 400 subtitle.
- **Two families max** — a display face and a workhorse; often one family in two weights is better.
- **Measure**: body lines 30–45 characters on vertical video, 45–70 on landscape.
- Align to an edge (left for editorial, centre for posters and single lines). Mixed alignment within one block is a mistake.

### Measure type — never guess it

The most common amateur tell is text that is *nearly* centred: a label riding high in its pill, a pill too short for its words, "vs" kissing the title under it. It comes from guessing glyph sizes. Don't.

- **A text layer's bounds are its LINE BOX** (`fontSize × lineHeight` tall), not its ink. Where the ink sits inside that box depends on the face: a chunky display face's caps can sit ~0.12 em ABOVE the box centre; lowercase-heavy body text sits low. Centring by the box looks wrong.
- **Widths are real** (`layers_list` bounds), so size every pill/chip from the measured width — never from a characters × size estimate.
- **For optical work, measure the ink once:** render the text alone on a scratch `static` comp at `inspect`, read the ink box from the pixels, cache it per (text, family, size, weight, tracking, stroke). Then place the layer at `target − inkOffset`.
- **Pills and chips:** width = ink width + equal padding (≈0.85 em each side); an icon sits a fixed gap (≈0.38 em) from the ink's left edge; the ink is centred vertically on the pill. Or build the chip as an **auto layout** row (`layers_group` with `layout`, padding, `alignY: center`) and let the app hug it.
- **Stacks and rows:** space by equal OPTICAL gaps — ink bottom to ink top (stacks), ink edge to ink edge (rows); put every word of a row on one optical centre line.
- **Always look at type at `inspect` detail** before calling it done — overlaps and near-misses hide at `glance`.

### Blocks of big type (posters, hooks, statement Shorts)

A statement set huge is a designed block, not a pile of lines. Three ways a block goes wrong, all seen in real work:

- **Justified blocks: group words before you fit.** Fitting every line to the same width makes each line's size follow its character count. A 2–3 character line ("IS", "TO") fitted to the full measure becomes a slab twice the size of its neighbours. Re-break the sentence so lines are of similar length ("MARKETING / IS F#%ING / HARD"), then fit every line to ONE measure and stack with ONE optical gap. Size can follow meaning (the hero word biggest) only as a deliberate step, not as a side effect of letter count.
- **No small kicker line over a giant word.** A 40–60 px caps line floating above a 400 px word reads as template filler. Either the words share the block at display sizes, or the small text earns its own place on the grid (a margin column, a caption below the safe line), never just "above, smaller, tracked out".
- **Decoration that belongs to glyphs is measured from glyphs.** A censor bar, strike, underline or highlight covers exact characters: take their extents from prefix widths (`"F#"` vs `"F#%"` measured on a scratch layer) or from `text_outline` contours, never from `bounds ÷ character count` (proportional faces make that land on random letters). Group it with its text so a re-stack moves both; a shape left behind reads as "what is that rectangle?".
- **A look's pixel fields don't scale with the type.** Droplets' goo blur (16 px) and inner glow (solid white) were tuned for one size: on a 125 px line the goo closes counters (G reads as O) and the white glow bleaches the colour. After `effects_look` on type, set goo blur ≈ 0.028 × fontSize, glow `mode: auto` with saturation 1, and look at the smallest line.
- **A container around display type is sized from the ink.** Padding scales with cap height (vertical ≥ 0.4 × cap, horizontal ≥ 0.6 × cap), a pill's radius is exactly half its height, and the container is never drawn to the frame width first with the word fitted inside it afterwards.

### Type over a picture (readable, small, modern)

- **Readable comes from the ground, not the size.** A soft band behind the type (a gradient of the scene's darkest colour, ~80% at the edge → 0 over the type's area) plus ONE soft drop shadow (opacity 0.6–0.7, y 2–4, blur 12–18). Never a dark `glow` halo around letters — at preview and on phones it reads as a smudge.
- **Keep it small and confident.** On a 1080-wide vertical: story lines 64–80, wordmark 70–90, kicker 22–28 tracked +6–9, supporting line 30–36. Bigger is not clearer; contrast is.
- **Hold it long enough to read twice**: on screen ≥ 2.2 s + 0.25 s per word; exits 600–800 ms, ease-in-out. A line that leaves before it can be read is worse than no line.
- **Text in liquid glass**: tint the pill's own fill dark (#0A0B2A at ~70%) UNDER the glass so the text keeps contrast whatever is behind; mono 24–30 px, hairline 1–1.5 px white edge at ~15%.

## Styling part of a text

**Counting numbers.** Key the `text` property at two times with different numbers ("Raised $0" → "Raised $12,500") and the number COUNTS between the keys on the first key's easing, keeping decimals, separators and Persian/Arabic digits. Each number is one object: range styles and range animations follow the whole number at every value. The text's in-animation replays on each change (per digit for letter units = odometer, the whole number for word units) and its in-sound ticks with every visible change — so a count with a `pop` in-animation and a tick sound needs nothing else. Per number (the nth number in the text) `countUps: [{slot, enabled, easing|null, steps|null}]` switches a count off, gives it its own curve, or limits it to `steps` jumps (null = every value; 5–12 steps reads as a scoreboard, every value as a rolling counter). Ease-out counts land well: fast through the middle, slow onto the final figure.

`text_style {id, match: "free", style: {color: "#FFD60A", fontWeight: 900}}` styles a word (first match; `occurrence: "all"` or `2`…), or `start`/`end` grapheme indices. A word's own glyph effect goes in the same `style`: `style: {textEffects: [{type: "shadow", y: 6, blur: 0}]}` (added on top of the layer's). To OUTLINE or repaint just those words, `strokes` / `fills` sit beside `style` (same shape as `layer_create`'s): `text_style {id, match: "slop", strokes: [{color: "#000", width: 6, align: "outside"}]}`; `[]` removes them. Outlines are the stroke pipeline, never a text effect — on the whole layer they are the layer's `strokes`. Ranges are real style runs — they animate, carry through edits (`text_set` keeps them attached to their words), and keyframe with `range`.

Highlight a word: `style.highlight` on the range, or a colour + weight change. Emphasis is one idea per line.

## Letters as shapes

`text_outline {id}` turns a text layer into a path of its real letter outlines — the same layer (id, place, timing, paint, effects, motion keys), now vector. It returns each character's contour ids, largest first: the letter's body, then its dots and marks. Style one on its own with `layer_patch {ops:[{op:"set", path:"contourStyles.<contourId>", value:{props:{"fill.<paintId>.color":"#E8A33D"}}}]}` — saffron dots on a Persian word, a coloured vowel mark, a tittle. Do it last: the words can no longer be edited as text.

## Templates

`catalog_list text-templates` — complete looks (type, effects, in/out motion, sound) by category: Titles, Captions, Kinetic, Minimal, Editorial, Cinematic, Impact, Luxury, Handwritten, Playful, Retro, Neon, Glitch, Terminal. `layer_create {kind:"text", template:"film-title"}` or `template_apply` on existing text. A template is a strong starting point — then set the palette and type scale to the project's design system.

## Text on a path

A text layer can ride a shape or path outline (`path` module: host layer id, offset in laps, rise, flip). Create the host (an ellipse for circular text, a path for a curve), then `layer_patch` the text's `path`: `api_describe {type:"text", path:"path"}`. Animate `path.offset` to make words travel along it.

## Captions

A caption is a text layer whose **cues** are spans of its own text with times; the spoken word is "focus", words before are "read", after are "unread", and each state has its own look (`caption.states`). The highlight pill slides between words (`caption.motion`).

- From speech: `media_transcribe {id: <audio or video layer>, captions: {maxWords: 3}}` creates one caption layer per readable phrase, word-synced, above the source. `maxWords` 1–2 for punchy social, 3–5 for talking heads, 6–8 for subtitles. `keyterms` (names, brands, jargon) fixes spelling before it happens.
- **Known words — lyrics, a script**: `media_transcribe {id, lyrics: "<the text>", captions: {maxWords: 6}}` ALIGNS the given text to the audio instead of guessing it. Singing defeats recognition; alignment does not. Keep the user's line breaks as caption lines.
- Style every caption layer the same way: batch `layer_patch` (`merge` into `style` and `caption.states`), or apply one caption template to all.
- Position: vertical video — lower third of the safe area, clear of platform UI (bottom ~15%, right ~12%). Landscape — bottom, 8% margin.
- Legibility over footage: highlight pill, shadow, or a scrim. Test on the busiest frame.

### Readable when the ground changes

A caption that reads on paper vanishes when the scene irises to night, a white card slides under it,
or a honey-lit frame fills the band. Plan for every ground the caption crosses, not just the first one:

- **Map the band.** List the moments the ground under the caption area changes (cuts, irises, wipes,
  a light object passing behind) from your own build, and `view_frames` exactly those instants at
  `glance`. Treat each change as a cue boundary.
- **Measure it instead of guessing** when captions are built by a script: render the finished comp (before
  any caption exists) with `ac.view.render({atMs, detail: "glance"})`, decode `$image` (`createImageBitmap`
  → `OffscreenCanvas`) and read the mean luminance and its spread in the caption's band at the cue's
  start, middle and end. Light → ink, dark → paper, spread > 0.2 or mid-grey → pill. Two different ends
  → bisect to the flip frame (halve unsnapped time, cap at 8 renders, snap once at the end) and key a
  `hold` there.
- **The caption changes WITH the ground, on the same frame.** Key its colour (and the shadow's) with
  the transition itself: `hold` on a cut, the transition's own easing and duration on an iris or a
  wipe. A colour change that lands a few frames late flashes white-on-white.
- **When the ground is mixed or busy**, give the caption its own ground instead of guessing a colour:
  a `highlight` pill in the ink or paper of the scene, or a soft scrim band. A pill always reads.
- **Never rely on `difference` or `exclusion` to fix contrast.** Over mid-tones they turn the type
  into the same grey as its ground, and over colour they invert the palette into noise.
- Check each cue on the frame it starts AND on every ground change inside it; ≥ 4.5:1 for body
  captions, ≥ 3:1 for big display words.

### Lyric styles

- **Spotify-style synced lyrics**: large bold lines (700–800), current line full white, past lines dimmed (read state opacity 0.35), upcoming lines at 0.55; the focus word may brighten. One line per caption layer, 4–7 words, left-aligned in a column, lines stacked with auto layout (column flow, gap ~ 0.4× font size) so the block reflows. Animate the block's `y` upward by one line height on each new line (ease-in-out, ~350ms) — the scroll is what sells it.
- **Karaoke**: the focus word fills with colour (state `focus` colour + a highlight pill), `caption.motion.travel: true` so the pill glides.
- **Kinetic one-word**: `maxWords: 1`, huge type, `pop-in` or `punch` per cue with a sound on each.

## Direction and language

Set `direction: "rtl"` only to force it; `auto` detects. For Persian/Arabic prefer families with proper shaping (Vazirmatn, Noto Naskh Arabic, IBM Plex Sans Arabic). Letter-level animation on connected scripts should use `unit: "word"`.
