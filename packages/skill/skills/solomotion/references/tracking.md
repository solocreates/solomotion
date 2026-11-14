# Tracking — putting things INTO footage

A tracker watches something in a video (a face, a sign, a phone screen, a ball) and knows where it is on every frame. Anything can then ride it: a layer, a caption, a blur, a grade window, any field through an expression. Use it whenever something you add must look like it is *in* the shot rather than on top of it.

Trackers belong to the **footage**, not to a clip: split, trim or retime the clip and the track stays glued. Everything you give and get is in **comp space and comp time** — the space `view_render` shows and `transform.x/y` is written in.

## The loop

1. **Look first.** `view_frames` over the shot at `glance`. Find a frame where the subject is clear, large and unblurred — that is where you draw.
2. **Create** — `track_create {layer, atMs, region: {shape, x, y, width, height}, channels}`. Draw the region snug around the subject *with a little texture inside* (a face with its hairline, a sign with its border). Too big and the background drags it; too small and there is nothing to hold.
3. **Solve** — `track_analyze {tracker}`. It waits, then returns coverage, confidence and `weakSpans` in comp time. It solves only what is missing, both ways from the drawn frame.
4. **Check cheaply** — `track_inspect {tracker, at: [a few comp ms]}` gives `position`, corners, `confidence`, `solved`. Then one `view_frames` with a small marker layer following it (or the real result) across a weak span.
5. **Fix** — on a bad frame, `track_correct {tracker, atMs, position}` (or `corners` for a surface), then `track_analyze {tracker, scope: "around", atMs}`. Only the stretch between the neighbouring fixes re-solves, and it lands on your fix. Fixes survive every later solve.
6. **Use it** (below).

## What to follow — channels

| The job | channels | Notes |
|---|---|---|
| A point: a dot, an eye, a corner | `["position"]` | Cheapest, steadiest |
| A thing: a face, a ball, a car | `["position", "scale", "rotation"]` | The default for drawn trackers |
| A flat surface: a screen, a sign, a wall, a book | `["position", "scale", "rotation", "skew", "perspective"]` | Needed for a corner pin; `method: "features"` |
| A bending outline: a hand, cloth | add `"shape"` | Slower; use a pen/polygon region |

Follow only what the shot needs — every channel is more work and more ways to wobble.

## How it matches — method

- `auto` (default): `features` if the region has texture, else `luma`. Leave it.
- `features`: many corners, outliers voted out — survives a hand passing in front, the only one that sees perspective well.
- `luma`: matches the patch itself — small or plain targets.
- `color` (set `colors`): a flat saturated subject that deforms or leaves frame (a jersey, a ball).

## Speed and quality

`quality`: `fast` · `balanced` (default) · `precise` · `exact`. Auto cadence skips calm frames and checks itself with a there-and-back test, stepping down to single frames wherever it doubts — so `balanced` is right for most shots. Use `fast` for long shots or a first look, `exact` for a hero close-up. A 1080p clip tracks at roughly 25–40 frames a second; a minute of footage is a minute or two of solving — say so to the user before starting one.

## Using a track

- **Stick a layer on it**: `track_follow {layer, tracker, channels}` — keeps the layer where it is and rides from there (`snap: true` puts it on the point). `perspective` in channels pins the layer's box to a tracked surface (corner pin) — screen replacements.
- **Stabilize**: `track_follow {layer: <the footage>, tracker, stabilize: true}` — the plate counter-moves so the subject holds still.
- **Any field, any maths** — expressions: `track("Face").position + vec(0, -120)` (a caption above a head), `track("Sign").rotation`, `track("Screen").topLeft`, `track("Ball").confidence` (fade when lost). Readings: `position x y scale scaleX scaleY rotation skew topLeft topRight bottomRight bottomLeft confidence solved`.
- **Nodes**: the Track node's outputs are the same readings.
- **Grade or blur a moving region**: a grade window with `source: {type: "tracker", trackerId}` (`grade_node`), or an adjustment layer above the footage keyed to it. The tracker's `region.feather/expand/invert` are the matte's edge.
- **Bake**: `track_follow {…, bake: true}` turns the follow into plain keyframes — for handing off, or before changing the footage.

## The camera that shot it — 3D in the shot

For text standing on a floor, a logo on a wall, an object sitting in a moving shot: solve the CAMERA, not a region.

1. `track_create {layer, kind: "camera"}` — `mode: "tripod"` when the camera only turns (a pan on a tripod), `"free"` when it travels, `auto` if unsure; `lens` (mm, full-frame) when known — it solves better on a short or shallow shot.
2. `track_analyze {tracker}` — reports `errorPx` (under ~1 px sits in the shot; over 1, try `tripod` or a known lens), the lens it found and how many points. Seconds for a short clip; it needs real parallax or rotation over rigid scenery — people walking through are voted out, but a shot that is mostly moving water or crowd will not solve.
3. `track_scene {tracker, ground: [3+ comp points on the floor], origin?, scale?: {from, to, cm}, text?: {text, at}}` — picks are COMP positions at `atMs` (read them off a `view_render` of that instant), each snapped to the nearest solved feature; `missPx` over ~20 means nothing solved was there — pick on textured floor, not a blank wall. The first call builds a world whose camera rides the solve, with the footage as its backplate, nested where the footage was; later calls reuse it. Ground levels it and turns on shadow catching.
4. Put things in the returned `world` (`layer_create` / `world_add` with that frame) — they move with the shot. Check with `view_frames` on the comp across the move: a thing that slides against the floor means a weak solve or the wrong ground.

## Depth — how far each pixel is

1. `track_create {layer, kind: "depth"}` then `track_analyze`. `model: "video"` keeps a shot steady (no flicker), `"still"` is sharper on a picture; `auto` picks. Roughly half a second a frame on a GPU — a 10 s clip is a minute or two; a still is seconds.
   - **Depth is a lazy engine.** Nothing of it ships with the app: the first depth run on a device downloads it (~60–130 MB by path, ~56 MB without a GPU) — tell the user BEFORE that first run, and say it is once. After that it is on the device for good: kept across app updates, and it works offline. `track_analyze` says which happened (`engine: cached` or `downloaded`). A failed download (offline on the first run) is a failed analyze with a network error — retry when online; nothing in the project is lost.
2. Use it — all read the footage's depth, 0 nearest … 1 farthest in the shot:
   - **Fog / atmosphere**: `effects_add {id: <footage>, type: "fog"}` (`start`, `end`, `density`, `color`).
   - **Rack focus**: `effects_add {id: <footage>, type: "lensBlur"}`; key `focus` from near to far.
   - **Behind the subject**: `effects_add {id: <title above the footage>, type: "depthMatte", values: {source: <footage layer>}}`; `depth` is how deep the title stands — wherever the footage is nearer, it hides the title.
   - **Grade by distance**: a grade window with `source: {type: "depth", trackerId, near, far, softness}`.
   - **Relief (a photo standing up in 3D)**: `world_move_into` the picture, then `effects_add {id, domain: "geometry", type: "displace", values: {source: "depth", strength, near, far, curve}}` — strength ~a quarter of the picture's width; `near`/`far` pick the stretch of depth that stands up, `curve` over 1 keeps only the nearest things proud.
3. A depth effect on footage with no depth does nothing — `track_inspect` lists the depth tracker and whether it is `solved`.

## Gotchas

- Draw on a frame where the subject is **fully visible**; the drawn frame is the truth the solve radiates from.
- A tracker named the same as a layer is fine — `track_*` verbs take `tracker`, layer verbs take `id`/`layer`.
- A subject that leaves frame or is fully covered shows as a weak span; the reader interpolates across it. Correct the first good frame after it.
- Positions are relative to the comp the footage is in. A follower in another comp does not resolve.
- Confidence under ~0.5 is where to look; `solved: false` means interpolated, not wrong.
