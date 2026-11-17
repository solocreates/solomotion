# Layers, structure and layout

## Comps and layers

- A **comp** (frame) is an artboard with its own size, fps, duration and timeline. Pages hold comps. Source comps of nested layers live off-page and are reached by entering their layer. A comp's length is set with `frame_update {durationMs}` and only changes when something sets it; a comp made without one follows its content (it ends where its last layer ends, sounds included) — `frame_get` says which (`durationFollowsContent`). Set the length of anything you export.
- Pages keep a project readable — scenes on one, deliverables (master, reel, cutdowns) on another. `page_create {name, frameIds}` makes one and files comps on it; `frame_create {pageId}` creates there; `frame_update {id, pageId}` moves a comp (it lands beside the comps already on that page). `page_update {id, name, index}` renames or reorders one; `page_delete {id, moveTo}` removes one and moves its comps (or `comps: "delete"` takes them too; the last page always stays). Pages are named by id or name.
- A **layer** (clip) is one of: `text`, `shape` (rect · ellipse · polygon · star), `path` (vector outline), `image`, `video`, `audio`, `nested` (a comp inside a comp), `group`, `waveform`, `raster` (paint), `adjustment` (grades what is beneath it).
- A caption is a text layer carrying word cues (`caption`). Text on a path is a text layer riding another layer's outline (`path`).
- Stacking: the top of `layers_list` renders on top. Lanes (tracks) are kind-agnostic; each layer's `lane` is its timeline row (0 = top of its comp or group).
- Lanes are reused for you: a new layer lands on top of whatever plays during its span, on an existing lane when one is free at that z. Build scene after scene and the lane count stays at the most layers ever on screen at once — never create throwaway layers to "hold" lanes.
- `layers_list` reports `comp.lanes` (and `emptyLanes` when some are empty). After heavy restructuring (deletes, moves, many `placement` anchors), `timeline_compact` drops empty lanes and lets layers fall into free lanes below without changing what covers what.

## Frame modes — timeline, flipbook, static

Every comp has a `mode` (`doc_overview` reports it):

- `timeline` — layers move on a timeline. The default.
- `flipbook` — frame by frame: rows of cells, each cell a nested comp (a drawing). Build the cells with `flipbook_edit` and fill them with layers — see `references/fills-strokes-vectors.md`. Any frame-by-frame request is a flipbook.
- `static` — ONE picture: a video thumbnail, a poster, a social card, an e-book page. It shows its **still** (`stillMs`) whatever time is asked — nested in a timeline it holds, exported it is an image, and every layer made in it spans it (no timing to manage). A still is silent and has no playback.

Design a still as a still: `frame_create {mode:"static", width, height}` (1280×720 thumbnail, 1080×1350 feed post, 595×842 A4 page — 1px exports as 1pt in a PDF). Build it with the ordinary layer commands; skip `animation_set`, keyframes and timing. Check it with `view_render` (any time shows the still).

Switching is lossless — `frame_update {mode}`:

- timeline → static stills the comp at `atMs` (omitted = the focused comp's playhead). Clips and keys are untouched; switching back resumes there. To make a thumbnail from an animated scene, duplicate the comp and switch the copy, so the scene keeps playing.
- `frame_update {atMs}` on a static comp moves its still to another moment (only meaningful when its content moves: a still made from a timeline, or one holding an animated nested comp).
- → flipbook wraps the current content as frame 1 (a timeline's cell spans its whole length). Leaving a flipbook that still has only that one cell hands the layers back unchanged.

A nested timeline inside a still shows ONE moment — set by the nested layer's `trimInMs` (the source instant at the still's time). To show a different moment of a nested animation in a still, change `trimInMs`, not the still.

## Transform and pivot

`transform.x/y` place the **pivot** (`anchor`), stored as a fraction of the layer's own box: `{0.5,0.5}` centre, `{0,0.5}` left-middle, `{0,0}` top-left. Rotation and scale act about it. Writing `anchor` (`layer_set`) MOVES the picture, since the pivot is what is placed. To change only what it rotates and scales about, `layer_pivot {ids, anchor: "bottom" | {x, y}}`: position and every position key are corrected, so nothing moves on screen (the stage's pivot drag, as a verb).

- Left-aligned stacks: set `anchor.x: 0` on each line and give them the same `x`. Now edges align exactly and text grows to the right.
- A mirrored layer is a **negative scale** (there is no flip flag).
- `scale` alone is uniform; set `scaleY` for non-uniform. Keys on `scaleY` always win, even on a layer whose `scaleY` was never set — a grid line can draw on with `scaleY` 0→1.
- Cropped media has two transforms: `transform` moves the window; `content.*` pans and zooms the picture inside it (a punch-in without moving the frame).
- Cropping never moves the pixels that are left: an uneven crop leaves the window off the pivot. `layers_list` bounds are the window, so centre a cropped picture by its bounds.
- `feather` is in comp px, after the layer's scale: 40 is 40 px of soft edge on screen whether the picture is scaled 0.3 or 3.

## Groups

`layers_group {ids, name}` wraps layers in one; `layers_ungroup` dissolves. A group's time span is a window over its members. Groups have **modes** (`layer_patch` → `mode`):

| mode | effect |
|---|---|
| `pass` | a plain group |
| `union` | members merge into one silhouette (effects apply once to the whole) |
| `mask` | content shows only inside the stencil |
| `subtract` / `intersect` / `exclude` | vector booleans: content − / ∩ / ⊻ stencil |

Mark the cutter(s) with `isStencil: true` (`layer_patch`) — any number of stencils union first. A group put into a cutting mode with no stencil makes its TOP member the stencil (Combine does the same), so stack the cutter above what it cuts or flag it yourself. While the content is not on screen, a mask, subtract or intersect group draws nothing. A moving stencil is motion-blurred like any layer (blur is on by default), so a fast wipe's edge goes soft, as a real shutter would. For a crisp cut edge (torn paper, a hard wipe) switch it off on the stencil and on anything riding the edge: `layer_patch {ops: [{op: "merge", path: "motionBlur", value: {enabled: false}}]}`.

A group animates its members as one: key its `x`, `y`, `scale`, `rotation`, pivot, `opacity` and `feather` like any layer (the transform is a delta over the members, which keep their own positions), and give it effects. **A group's `x`/`y` is an offset, not a position**, and it scales and turns about its `pivot`: the centre of what it holds (by its anchor), which `layer_get` reports (parent space, at the playhead). A member at q lands at `pivot + (x, y) + scale·(q − pivot)`. A camera group zooming by `s` while comp point P stays put: `x = (1 − s)·(P.x − pivot.x)`, `y = (1 − s)·(P.y − pivot.y)`; to bring P to the centre instead, `x = −pivot.x − s·(P.x − pivot.x)`. The pivot follows the members, so read it again after moving them. For anything else as a unit — its own timeline, time remapping, a reusable piece — `layers_nest` instead.

## Auto layout

A group with `layout` ARRANGES its members like Figma/CSS flexbox. Use it for anything that should stay aligned when text changes: buttons, chips, cards, lower thirds, lists, lyric lines.

**Every icon beside a label is a row** (`flow: "row"`, `alignY: "center"`): layout centres each member's real box, so an icon drawn below its own origin (a heart, a pin, an arrow) still sits on the label's centre line. Hand-placing both at one `y` lines up the icon's ORIGIN instead, which is how a heart ends up low.

```json
{ "ids": ["Pill", "Label"], "name": "Button",
  "layout": { "flow": "row", "gap": 12, "padding": { "top": 18, "right": 32, "bottom": 18, "left": 32 }, "alignX": "center", "alignY": "center" } }
```

Spec (`api_describe layout`): `flow` row · column · wrap · grid (`columns`), `gap`, `lineGap`, `spaceBetween`, `padding`, `alignX`/`alignY` (start · center · end), `width`/`height` (`null` = hug), min/max sizes, `clipContent`. The box's **top-left** is `layout.x/y` (comp space).

- **A rect + a text grouped with layout** — the rect becomes the container's background and hugs the text (a button). `layout: {}` infers a layout from how members already sit.
- Per member (`layoutItem` via `layer_patch`): `fillX`/`fillY` (stretch), `absolute` (opt out and place freely — a badge on a card's corner), min/max.
- Change it later with `layout_set`; `layout: null` removes it, keeping members where they are.

## Nesting, components, reuse

- `layers_nest {ids}` precomposes layers into their own comp — one layer outside, a timeline inside. Pixels do not move. Use it to animate a finished card as a unit, reuse a sequence, or give a group its own fps/duration.
- `layer_create {kind:"comp", sourceFrameId}` places a comp inside another (a scene in an edit, a card reused three times). It is a LINK: the comp stays where it lives (its page, its own length and loop) and every edit to it shows in every place it is used — a cover's wall of live scenes, a lower third reused in ten edits.
- A nested layer's inside is one of three, shown as `inside:` in `layers_list` flags: `embedded` (its own comp, made by `layers_nest`; it has no page, its length is the layer's, you open it by entering the layer), `linked` (a comp on a page, or one several layers share) or `instance` (a component).
- `layers_makeUnique {ids}` gives linked layers their own embedded copy, so this one can change without touching the original (a looping layer keeps its cycle). Never duplicate a whole comp onto a page to vary one use of it.
- Components (instances that update together) are made in the editor; treat instance layers like nested comps — `layers_makeUnique` detaches one.
- Changing a source comp's duration also stretches every nested instance whose length equalled the old duration — re-trim instances that were meant to end early.
- **Re-time a comp without rebuilding it**: several instances of the same source, each with `playback.speed` and `trimInMs` (the source time it starts from), give slow-motion stretches and freeze-holds (`speed` near 0) of one master story — how a 16:9 cut and a 9:16 cut share every animated part. Keep a hand-over on the frame grid, or two instances overlap for a frame.
- **Does a nested comp crop at its box?** The nested layer's `clipContent` decides: `true` crops, `false` shows everything past the box, `null` (Auto, the default) asks the comp — a TRANSPARENT comp (a part: logo, character, cursor, drawing, a shockwave or glow that reaches past the box) spills; a comp with a visible background (a scene) crops; the comp's `overflow` 0/1 forces it. Set it with `layer_patch {ops:[{op:"set", path:"clipContent", value:false}]}` when a comp WITH a background must still spill (or `true` to crop a transparent one). Check a spill moment with `view_render` on the PARENT.
- Instances of one source stay in sync (edit a drawing once, every use updates) — that is the point of nesting; duplicate the source comp when one use must differ.
- **A series from one template**: `frame_duplicate {id, name, pageId?}` copies a finished comp with everything in it (new layer ids — read them with `layers_list`); then change the words. `layers_copy {ids, toFrameId, atMs?}` brings layers from one comp into another (a group with everything inside it, timing kept) — a kit's pieces into a Short.
- An effect on a nested layer (shadow, boil, blur) rasterises the nested content softly — fine for a deliberate blur, wrong for crisp UI or line art. Put the effect on the layers inside instead.

### Never leave a dead frame (nested clips, loops, flipbooks) — measured rules

A nested layer shows its source's pictures at the mapped time. When the mapped time lands where the source has **no picture**, the layer renders EMPTY for that frame — a blink in playback and export, and you will not see it in a handful of stills. Rules that keep every frame covered:

1. **An instance must NEVER OUTLIVE its source.** Up to the source's last frame it renders correctly; past its end it renders EMPTY — or holds a ghost of the comp's last *content* frame (a caption that faded out can stay on screen at 10 %). Cut play-once instances to the source's length (a flipbook of N frames at F fps is N·1000/F ms) and, if a longer hold is wanted, give the source a longer last hold instead.
2. **A loop cycle must be SHORTER than the pictures it loops.** `playback.loop:"loop"` alone leaves a ~30 ms dead window at the start of every cycle after the first (sweep-measured on a 2-frame flipbook); a cycle longer than the pictures gives a dead tail; `pingpong` has both. Always set `playback.loopLengthMs` = the pictures' real length − 1 ms (a flipbook of N frames at F fps is N·1000/F ms). With `playback.speed` ≠ 1 the cycle is wall-clock: divide by the speed — or better, don't loop a retimed instance.
3. **Static art that is nested for longer than its comp** (a 1 s soil comp used for 35 s) must be looped the same way, or built as long as the film.
4. **A comp's content end is what a held frame uses**, not its set duration: let every layer of a UI/caption comp run to the end of the film, fading to opacity 0 after its out-point.
5. **Prove it with a sweep, not stills.** Render a scratch instance of the source across ≥ 3 cycles at ≤ 10 ms steps (or the whole comp at every frame) and list the frames whose render is blank or differs from both neighbours. Zero or it is not done.

## Adjustment layers

`layer_create {kind:"adjustment"}` spans the comp and applies its effect stack to everything **below** it — a grade over a whole edit, a vignette, grain. Its crop/feather/radius limit the region.

## Organising a project

- **Name every layer** for what it is ("Title", "Price tag", "BG gradient"). You and the user both navigate by names.
- One idea, one group. Nest when a unit has its own timing.
- Keep the stack readable top→bottom: overlays, text, subject, backgrounds.
- Put media in folders (`media_import {folder}`); generated media files itself under "AI generated".
