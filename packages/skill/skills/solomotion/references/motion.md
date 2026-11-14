# Motion

## Principles that make motion read as designed

1. **Purpose** — motion guides the eye to what matters next. If a move does not direct attention or express something, cut it.
2. **Easing** — nothing real moves linearly. Entrances **ease out** (fast in, settle: `ease-out-expo`, `ease-out-quart`). Exits **ease in** (gather, then leave). Moves between two rests **ease in-out**. `ease-out-back` adds a small overshoot — lively, use sparingly. `linear` is for continuous loops, tickers and camera drifts only.
3. **Timing** — UI-scale elements 250–500ms, headlines 500–900ms, big scene moves 800–1400ms. Faster feels confident; slower feels premium. Hold a finished state long enough to read it: ~ 300ms + 50ms per word.
4. **Stagger** — sequence related elements 30–80ms apart (letters 15–30ms, words 60–120ms, lines 120–200ms). Top-to-bottom, left-to-right, or from the focal point outward.
5. **Overlap** — start the next thing before the last finishes (~30–50% overlap). Nothing waits for a dead stop.
6. **Anticipation & follow-through** — a tiny opposite move before a big one; a settle after. Presets like `settle`, `rubber`, `drop` build these in.
7. **Consistency** — one motion language per piece: the same easing family, direction and distance for the same kind of element.
8. **Exits are quieter than entrances**, and usually faster (60–70% of the entrance duration).

## Scenes that flow into each other

- Design the SEAM, not just the scene: the last frame of scene A and the first of scene B share background colour, a carried element, or a motion direction. Build the shared world (background, palette, a persistent element) ONCE in a wrapper comp — one background layer spanning the whole film under the scene comps — and let the scenes be transparent on top, so colour never jumps and nothing is duplicated to re-edit.
- End screens are start screens: a scene ends where the next begins (match cut, a shape that becomes the next frame's container, a camera push that lands in the next layout). Keep it simple; one idea per seam.
- No dead air between scenes. A hold is a choice (≤ one beat to let a line land); a scene ending in stillness followed by another starting from nothing is a pause the viewer feels as a stall. Overlap outgoing and incoming motion by 100–300ms.
- Keep timelines tidy: new layers settle into free lanes automatically; put a scene's parts (its layers AND its sounds) inside its comp or group; run `timeline_compact` when a comp has gaps in its lanes. Never leave empty tracks behind.

## Camera restraint

- One continuous move per section: a push of 3–6% over ≥ 5 s, or a slow pull-back to reveal — eased `cubic-bezier(0.45,0,0.55,1)`, then STILL. A zoom punch on every beat (a kiss, a logo, a gust shake) reads as cheap and nervous.
- No shakes unless the story is physically violent, and then a few px for ≤ 300 ms.
- Big reframes (a character popping in large, a detail punch-in) take ≥ 1.4 s to settle; never snap back in under a second.
- **Never zoom into a logo or a product name.** A sudden push onto the brand is the frame where people leave. Let the brand arrive where the eye already is, small, with its name set under it, and keep the story's rhythm.
- A camera is a RIG, never baked keys on the world: pan on a World instance, zoom and shake on a Camera group that holds only it — `keyframing.md` › The camera rig.

## In / out animations (presets)

`animation_set {id, slot:"in"|"out", preset, …}` — the fastest way to animate anything.

- **Text** animates per `unit` (letter · word · line) with `staggerMs`, `durationMs`, `delayMs`, `easing`, `jitterMs` (humanised timing — typewriters), preset `params`.
- **Any visual layer** animates as a whole (`target: "layer"`).
- `catalog_list animations` (with `query`) lists presets with their scope; `catalog_get animations <id>` its knobs. Families: fade (fade, fade-up, blur-in, soft-focus, unblur-up, fade-through), slide (slide-up/down/left/right, fly-in, drift, nudge, slide-stagger, slide-through), scale (pop-in, scale-in, zoom-out, punch, grow, breathe), bounce (bounce-in, drop, rubber, settle), spin (flip-up/down, spin-in, roll-in, swing, pendulum), type (typewriter, wave, cascade, ripple, trace, flicker-on), stylize (whip, glitch, strobe, smear, shutter), and `draw` (strokes draw on — outlines only).

Pairings that work: `unblur-up` titles · `fade-up` body · `pop-in` badges/stickers · `typewriter` (+ caret, + typing sound) for terminal/UI · `slide-stagger` lists · `draw` for line art and logos · `whip` for energetic cuts.

## Keyframes

`keyframes_set {id, property, keys: [{at, value, easing}]}` — any path from `layer_properties`. Times are layer-relative. The key's easing shapes the segment leaving it. **Read `keyframing.md` before keying anything that moves more than once**: poses not samples, hops as `arc` keys, cuts as `hold`, the camera rig, `keyframes_inspect` to read keys cheaply.

- **Pitfall — mixed clocks.** `at` is measured from the LAYER's start. A layer that starts at 700ms keyed with comp times lands every key 700ms late — a cursor that lags the slider it drags, a hide/show toggle that fires late so two cursors show at once. When several layers must move in lockstep (a cursor and the knob it drags, a hand and the object it carries), write all of them with `clock: "comp"` — or give them all the same start. Never mix the two clocks inside one synced gesture.
- **Whole-layer animations have no `delayMs`** (only text's per-unit animations do; `animation_set` refuses it on a layer). Start the layer at the moment its entrance should begin.
- **Frame flooring.** Layer starts floor to the frame grid (at 30 fps, 433 ms → 400). When two layers must hand over on one frame (cursor → hand, cover panel → content), compute the floored frame and key the hand-over there; extend anything that must sit under a fading cover past the fade's end.
- **Swapping one prop for another** (an arrow cursor that becomes a grab hand while dragging): key the arrow's `opacity` to 0 over one frame at grab and back at release, give the hand the same `x`/`y` keys on the same clock, and check a frame mid-gesture — exactly one of them should show.

- Position moves: key `property: "position"` with `[x, y]` values — one motion key per pose. A thrown arc is `arc: <px above>` on the key it leaves; any other curve is `in`/`out` handles.
- Scale from a corner: set `anchor` first (e.g. `anchor.x: 0` to grow rightwards).
- Colour keys interpolate per channel — keep hue changes small or pass through a neutral.
- Rest on a value: two keys with the same value. Cut to a value: `easing: "hold"` on the key before the cut (one key per switch).
- Remove keys without jumps: `keyframes_clear` freezes the value at `atMs`.

## Expressions — live links between values

`expression_set {id, property, source}` drives a property from a formula evaluated every frame. `expression_reference` lists every function (`wiggle`, `random`, `noise`, `sin`, `clamp`, `mix`, `linear`, `ease`, `layer("Name").x`…) and global (`#time`, `#frame`, `#layer.*`, `#comp.*`, `#value` — the field's own keys or base, so `#value + wiggle(2, 5)` builds on the animation instead of replacing it).

- Link: `layer("Card").y - 120` keeps a label 120px above a card that animates. A read is what the layer IS at that instant — its keys, or its own expression's result (`layer("Count").x` where Count's `x` is an expression reads the formula's value), so chains follow and one leader can drive a row. A loop (A reads B reads A) reads the stored value where it closes. A body's simulated place is not readable: physics runs after expressions.
- Link by KEY when you have the id: `layer("clip:<id>").rotation` survives renames and same-named twins (text layers rename themselves as their text changes). Any path from `layer_properties` reads this way — effect fields (`.lfx.<id>.radius`), grade slots, paint, bones. A path segment that starts with a digit reads as `layer("clip:<id>", "<path>")`. This is exactly what the app's pick-whip writes.
- Loop: `sin(#time * 2) * 20` for a float; `#time * 90` for a constant spin.
- Organic: `wiggle(2, 8)` — 2 Hz, 8px.
- Reuse one expression for several properties with `expressionId`.
The property keeps its own value and keys underneath; `source: null` restores them.

## Modulators

A modulator (wiggle · random · wave · pulse · ramp) wobbles an already-animated value — "animate it, then shake it". Add via `layer_patch` → insert into `modulators` (`api_describe modulator`). Use for camera shake, flicker, breathing glows.

## Motion blur

Per-layer shutter (`motionBlur`) and per-comp master (`frame_update ops` → `motionBlur`). Turn it on for fast moves (whips, drops, big slides) — it is what makes CG motion feel filmed. Off for type that must stay crisp while reading. It reads every instant as the comp resolves it, so physics bodies, tracked layers and expression-driven moves blur like keyed ones — in a flat comp and in a 3D world alike (a carousel spun by `layer("Clock").x` smears). A fast move is one smooth streak, not a row of copies: each shutter sample's slice is integrated whole, so `maxSamples` only bounds how often the pose is evaluated (raise it for a curved path that must bend inside one frame). A world re-renders the whole scene per shutter instant (up to 24 when exporting), so a very fast 3D move can still show steps; there, a Directional blur keyed to the speed is the cheap look. A GROUP's own motion blurs what it holds (its keys, its in/out animation), so key the group of tiles, not each tile; a member moving inside the group adds its own blur on top.

**Cost: one buffer and up to `maxSamples` draws per moving layer, every frame.** It is on by default, so a comp of many moving bodies pays it per body: 100+ blurred balls is seconds per frame in `view_render` and export, where blur off is a fraction of one. For balls, switch blur off on the bodies (`layer_patch ops [{op: "merge", path: "motionBlur", value: {enabled: false}}]`) and give each a `trail` emitter (`references/physics.md`) — it reads as the streak and costs a fraction. Keep blur for a few hero moves.

**Trails are the shutter, not an effect.** A comet tail behind a moving thing: `shutterAngle` 720–3600 (2–10 frames of path), `shutterPhase` = −angle (all exposure in the past), `weighting: "trail"` (solid head, fading tail), `combine: "max"` (or `"screen"` for light that adds), `maxSamples: 64`. The tail follows the real path — it bends through a bounce. Whole comp: `frame_update ops [{op: "merge", path: "motionBlur", value: {enabled: true, shutterAngle: 2400, shutterPhase: -2400, weighting: "trail", combine: "max", maxSamples: 64}}]`. One layer only: `layer_patch ops [{op: "set", path: "motionBlur", value: {enabled: true, override: {...}}}]` — an override carries every field (`shutterAngle, shutterPhase, weighting, curve: {kind: "linear"}, sampling: "transform", combine, strength: 1, amount: 1, maxSamples`), and the comp's master must be on. Playback shows a cheap straight smear; a parked frame, `view_render` and export draw the true curved trail.

## Traces — the whole path

A **trace** is a layer that draws where a point has been over the **whole shot**: an orbit closing on itself, a Lissajous figure filling in, a ball's arc with a strobe ghost every 0.1 s. The motion-blur trail above is a shutter and only looks back a few frames; a trace keeps everything since it began (or the last `lengthMs`). It stores no points — every frame it samples its source from the bake, so scrubbing, playback and export draw the same line, and editing the source (its keys, its expression, a body's mass or launch speed) redraws it. Never bake a path into keys to draw one.

- **Follow a layer:** `layer_create {kind: "trace", source: "Dot"}` — keyed, expression-driven, a physics body, a tracked layer; it lands spanning the source. `point: {x, y}` traces a point off the centre (local px; it turns with the source — a rim point of a rolling wheel draws a cycloid).
- **A pen, no other layer:** omit `source` and drive the trace's own `x`/`y` (`expression_set` or keys); it draws its own position.
- **Look:** `trace: {head: {color, width, opacity}, tail: {...}, coolMs, falloff, lengthMs, cap, rate}`. Each point cools from head to tail by its age over `coolMs` (null = across the visible trace, so the oldest point is always the tail); `falloff` > 1 holds the heat longer. Default is ember `#FF5A2E` 8 px → chalk `#EDE9E2` 1 px at 35%. `lengthMs: null` = the whole history; a number = a comet of that length with an exact tail.
- **Strobe:** `trace: {ghosts: {enabled: true, everyMs: 100, style: "source" | "dot", opacity, fade, count}}` — `source` draws copies of the followed layer as it looked at each instant (rotated, squashed), `dot` draws discs of `size`. Ghost instants sit on a grid from the trace's start, so they never swim.
- Every look value is a property path (`trace.head.width`, `trace.tail.color`, `trace.coolMs`, `trace.lengthMs`, `trace.ghosts.everyMs`…): key it, drive it, `layer_set` it. Structure (source, `lengthMs: null`, ghost style) through `layer_patch` on `trace.*`.
- The line is drawn in **comp space**; put the trace beneath its source (the right-click *Trace path* does) and give it a Glow for an ember that burns. Keep `rate` (samples/s, default 120) higher for fast curves; the head is exact at any rate.

## Transitions between clips

`transition_add {ids, preset, edge}` puts a transition on cuts (see `editing.md`). For designed scene changes, animate the scenes themselves (outgoing `out` + incoming `in` overlapping) — it reads more intentional than a stock wipe.

## Frame rate

Each comp has its own fps; a layer can step on its own rate (`fps: 12` for animation on twos) — a stylistic choice for hand-made, stop-motion or snappy text.

## Check it

Always `view_frames` across the animated span (6–9 frames) before calling motion done. Look for: elements appearing in the intended order, nothing arriving at once that should stagger, no overshoot clipping outside the frame, a readable hold at the end.
