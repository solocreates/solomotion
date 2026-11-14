# Recipes

Worked builds to adapt. Coordinates assume the comp's centre is (0,0); `U` = short side / 100.

## Give any project a material in one call

Flat art + a texture look = a frame that looks made. Pick by feeling, apply to the comp, look, tune.

1. `catalog_list looks {query: "texture"}` if unsure — the Texture looks and their cards.
2. `effects_look {id: <comp id>, look: "paper-cut-out"}` — the whole frame becomes cut paper on paper. Crafty explainer → `paper-cut-out` · playful/handmade → `stop-motion` or `claymation` · teaching/dark → `chalk-on-card` · poster/indie → `riso-print` · cosy → `cross-stitch`, `felt` or `tufted-rug` · scores and signs → `led-board` · DIY → `cardboard` · a note → `crumpled-paper` · premium → `holo-foil`, `letterpress`, `embossed-paper` · night/tech → `neon-glass`, `crt-phosphor`, `liquid-chrome` · calm/craft → `ink-bleed`, `kintsugi`, `woodblock` · retro → `vhs`, `game-boy`, `photocopy`, `newspaper`.
3. `view_render` at rest (`detail: "look"`): the shapes should cast soft shadows on the ground and carry fibres. For stop motion, `view_frames` 3–4 frames 83 ms apart — the picture and the paper change together.
4. Tune with `effects_update {id: <returned id>, effectId, values}`: `lift` up for more depth, `edge` for a rougher cut, `lightAngle` to match a light in the art.
5. Gotchas: a look REPLACES the frame's stack (re-add a grade after); a photo has no flat ground, so cut-out depth needs real layers — apply the look to each cut-out layer instead; text under `chalk-on-card` breaks up too (keep captions on a layer above the frame effects or lower `breakup`).

## One shape, many materials (a transformation reel)

1. One flat illustration, one comp. `effects_look {id: <comp id>, look: "felt"}` — sets lift and edge, which every material in the chain shares.
2. `effects_morph {id: <comp id>, stops: [{material: "paper", atMs: 0}, {material: "felt", atMs: 1200}, {material: "clay", atMs: 2400}, {material: "foil", atMs: 3600}, {material: "chrome", atMs: 4800}], overMs: 700, style: "spread"}` — each material fully showing at its stop, a front growing into the next before it.
3. For the glass/metal materials the sheet matters: `effects_update` → `colorMode: "under"` gives chrome, neon and crystal their dark ground (that ground morphs too).
4. `view_frames` at each stop and mid-link (`detail: "glance"`). Put stops on beats; a whoosh on each link sells it.

## Title card (landscape)

1. Ground: full-frame rect, linear gradient ground → a deeper tint of the accent hue.
2. Depth: a large radial glow (accent at ~65% alpha → 0) off-centre, behind the text.
3. Stack, left-aligned on a 12U margin, `anchor.x: 0` on every line, same `x`: kicker (caps, tracked, accent), title (display size, 800, −3% tracking), subtitle (ink-2), a short accent rule.
4. Colour one title word with `text_style`.
5. Motion: kicker `fade-up` per letter (18ms); title `unblur-up` per word (110ms, expo, +220ms delay); subtitle `fade-up` per line (+700ms); rule `width` 0 → final (ease-out-expo); glow opacity 0 → 1 and scale 0.85 → 1 over ~2s.
6. Sound: `pop` per title word, volume ~0.3, randomness ~0.55.
7. `view_frames 0–2000ms`, then `view_render` at rest.

## Lower third

Group a surface pill (rect, radius = height/2) and two texts (name 700, role 400 ink-2) with auto layout (column, gap 0.6U, padding 2U 3U, alignX start). Place bottom-left inside title-safe. In: pill `slide-right`/`fade-up` 500ms, texts `fade-up` per line 80ms stagger. Hold ≥ 3s. Out: `fade` 300ms, ease-in.

## Social caption set (talking head, 9:16)

`media_transcribe {id, captions:{maxWords: 3}}` → style all caption layers alike: 5U, 800, ink, highlight pill on the focus state (accent), `caption.motion.travel: true`; y ≈ +18U (upper part of the lower third, clear of UI). Add `pop-in` per word for energy, or none for calm.

## Spotify-style lyrics

1. Transcribe the vocal with `maxWords` ~6, or build lines from provided lyrics with timings.
2. Each line is a caption layer: 6–7U, 800, left-aligned, `maxWidth` 80% of width. States: unread opacity 0.55, focus 1.0, read 0.35.
3. Stack the lines in an auto-layout column (gap 1.5U) inside a group placed at the left margin.
4. Key the group's `y` so the current line sits at the same height: each time a new line starts, move up by (line height + gap) over 350ms ease-in-out.
5. A soft blurred copy of the album art or a slow gradient behind; no sounds.

## Kinetic typography

One word at a time, huge (20–30U), centred; each word its own layer or a caption with `maxWords: 1`. Alternate entrances (`punch`, `slide-up`, `drop`) on the beat; colour-flash the key word; motion blur on; pops or thocks on each word.

## Logo reveal

Draw the mark as path layers (`d`), strokes only: `draw` in, 900ms staggered 120ms; then fade the fills in over the strokes (opacity 0 → 1, 300ms) and fade strokes out; a `shine` sweep across once; the wordmark `unblur-up` per letter after. A single low `pop` on the fill.

## Path morph

Two outlines written with the same command sequence (e.g. four `C` segments each) — a square with soft corners → a circle → a blob. `keyframes_set {id, property:"geometry", keys:[{at:0, value:"<d1>", easing:"ease-in-out"}, {at:800, value:"<d2>"}]}`. Add a colour key on the fill at the same times and a small rotation for life.

## Product promo (vertical, 15s)

Hook (0–1.5s): product image `pop-in` with a bold 3-word claim. Features (1.5–11s): three beats of 3s, each a photo + one line, `push` transitions. Offer (11–13.5s): price in accent, `punch`. End (13.5–15s): logo + CTA, hold. Music with beats on cuts; pops on each text entrance.

## Reel from a long video

`media_transcribe` the source → pick the hook and 3–5 strongest lines → new 1080×1920 comp → nest the source, scale to cover, key `x` to follow the speaker → `timeline_cut_ranges` everything but the kept lines (one call, captions stay in sync) → `media_remove_pauses` to tighten → punch-ins (`content.scale` 1 → 1.1) at every other cut → captions (maxWords 3) → a title card for the first second.

## Falling title (physics)

A word that drops in and settles on its letters. Set the type big (one text layer per word, or one per letter for a scatter). `physics_scene {walls: true, startMs: 0}`; `physics_body {ids, bounce: 0.25, friction: 0.6}`; stagger start heights (−900, −1100, −1300 px) so they land in sequence; a passive rule line as the shelf if the floor is too low. Hold 1 s after the last landing; push the camera in during the settle. Check with `physics_inspect` at the settle time.

## Sticker rain (physics)

Twenty image stickers (transparent PNGs) above the frame with small random `spin` (±90) and `velocity` x (±150); `walls: true`; pictures collide on their silhouettes, so they pile like paper. A wind (`physics_force wind strength 0`, `force.<id>.strength` keyed to 700 for 0.3 s) gives the pile a gust at the beat.

## Blinking mascot (characters)

Draw the head and eyes as layers; eyes as a switch (`switch_create {ids: [open, closed]}`), `expression_set {id: eyeSwitch, property: "switch", source: 'if(blink(4) > 0, "Closed", #value)'}` — reuse one `expressionId` for both eyes. `rig_create` with a Neck and a Head bone through the head; key a small head tilt (`rig_pose rotation ±4`) on the beat. A pupil pad control (`limits x/y ±12`) wired to the pupils' x/y with `bone()` lets the look be keyed with one handle.

## Waving arm (characters)

`rig_create` with Upper and Fore bones through the arm art plus a `deform: false`, `shape: "diamond"` Hand control; `rig_bone edit Fore ik {target: "Hand", chain: 2}`; key the Hand control on an arc (x/y) over 0.6 s, ease in-out, loop. The elbow follows by IK and keeps its side.

## Black hole (how a black hole is born, 9:16)

Proven end to end. Comp 1080×1920, background black.

1. **Sky**: full-frame rect fill `#020309`; `effects_add` `nebula` (preset Rose or Orion; `coverage` 0.35–0.5) THEN `starfield` (Deep sky). Key `starfield.driftY` slowly for parallax.
2. **The disk lives in its own comp**: `frame_create {name: "Disk", width: 1400, height: 1400, background: "#00000000"}`; in it `physics_scene {frameId, gravity: 0, floor: false}`, `physics_force {frameId, type: "gravity", position: [0, 0], horizon: 30, spin: 0.5}`, `physics_emit {frameId, look: "accretion", position: [0, 0]}`. Trim the emitter and the well to the comp's length — a nested comp shows nothing past its layers.
3. **See it at an angle, through its own gravity** — on every disk emitter card: `tilt`, `lensing: 1`, `beaming: 0.6`; keep the gas outside 3 × the horizon (`inner` ≥ 112 for horizon 30, `drag` ≤ 0.004). The far side arches over the hole, the near side is in front, the approaching side burns brighter, and streaks follow their curved paths. The angle is the call: **45°** leaves the shadow pure black ringed by light (the M87 look; the inner edge clears the shadow when inner × cos(tilt) > 2.6 × horizon); **84°** is Interstellar's edge-on Gargantua, with the front of the disk crossing the hole as a thin band. Never squash a nest with `scaleY` or crop a "near half" — a lens cannot bend half a disk without a seam.
4. **Nest it once** in the main comp: `layer_create {kind: "nested", sourceFrameId: <Disk>, set: {rotation: -8}}`, ABOVE the hole.
5. **The hole**: a 20 px black circle under the disk; `effects_add {id, type: "lens", values: {radius: 138, shadow: 78, glow: 0.45}}` — `shadow` = 2.6 × the well's horizon, so the sky's shadow and the disk's agree. It bends the sky, not the disk (the disk bends itself). Scale the lens layer with the disk for a push: lens and shockwave grow with their layer.
6. **The star before it**: a 560 px circle with `star` (Sun). Swell: `scale` 1 → 1.12 (0–2 s, ease-in-out) with `lfx.<id>.boil` 0.35 → 1.2. Compress and heat: `scale` 1.12 → 0.55 and `lfx.<id>.temperature` 5800 → 30000 (2–4 s, ease-in). Core gives way: `scale` 0.55 → 0 (4.0–4.35 s, ease-in — it falls into itself).
7. **The bang**: a `shockwave` on a small circle at the star's centre, clip starting 4.3 s: `radius` 0 → 1500 over 1.4 s (ease-out), `strength` 60 → 0. `physics_emit {look: "supernova"}` on a clip starting on the same frame.
8. **The hole forms** (4.4 s →): key `lfx.<lens>.strength` 0 → 1 and `shadow` 0 → 82 over 1 s (ease-out); fade the disk layer's `opacity` 0 → 1 over 2 s (a nested layer's opacity fades its particles; an emitter carrier's would not).
9. **Make the collapse readable** (the longer cut): show gravity as a WELL in a perspective grid — a path of grid lines over a disc of sheet seen from ~17° above, depth = K·(1/√(r² + c²) − 1/R) where `c` is the star's radius. Key its `geometry` to the star's scale: the mass never changes, the star shrinks, so the well deepens; at c → 0 it has no bottom and runs off the frame (clamp y just past the bottom edge). A vertical linear-gradient stroke dissolves the far rim (no horizon line), `screen` blend, under the star. Give way in BEATS, not one slide: `scale` 1.05 → 0.84 → 0.66 → 0.48 → 0.32, each with a small `ease-out-back` rebound, a heartbeat on each, shake growing between; `temperature` 4600 → 3100 (dying red) → 34000 (crushed blue-white); then 0.32 → 0 in 1 s. Keep the silence after the swallow under half a second and the sky half-lit: a long black gap reads as a lag, not as drama.
10. Hold on the spinning disk ≥ 2 s. Check stills with `view_render` at 1.5, 3.5, 4.4, 5, 7 s (`detail: "look"`); never play to check.

## Deep zoom on a sub-pixel difference (×1 → ×13 000, Two Balls v2)

Show something smaller than a pixel honestly (a 0.022 px miss on a ring): a real zoom on vectors, not a scaled raster.
- Nest the scene comp; scale the nested layer about the ONE room point Q that stays put between two shots
  (`Q = (S_B − S_A + Z_A·P_A − Z_B·P_B) / (Z_A − Z_B)`; `x = W.x − s·Q.x`). Interpolate log(zoom) with a monotone
  Hermite and key dense poses (every ~80 ms) with exact slopes: velocity-continuous, never a snap.
- Size every pen, marker and glow in SCREEN units (`references/units.md`): `stroke.<id>.width: "2spx"`, a dot
  `width/height: "8spx"`, `lfx.<id>.size: "24spx"`; a line that should grow with the room but stay readable:
  `"clamp(1spx, 0.3fw, 4spx)"`. No `Zoom` null, no `/ layer("Zoom").x` expressions.
- Write path points at full precision (`toPrecision(16)`): 2 decimals is 65 px wrong at ×13 000. Trim on a long path is
  imprecise that deep: draw the hero detail as its own 2–3 point path.
- Crisp to ×30 000 in testing, glows included (effects render at output resolution through the nest), and the nested
  layer's opacity fades crisply.
