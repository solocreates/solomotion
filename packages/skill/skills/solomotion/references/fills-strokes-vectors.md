# Fills, strokes, shapes and vectors

## Paint (fills and strokes)

Every visual layer has ordered `fills` and `strokes` (bottom → top), Figma-style. A paint is one of (`api_describe paint`):

| type | use |
|---|---|
| `solid` | a colour (`#RRGGBB`, `#RRGGBBAA`, or `var:<id>` for a colour variable) |
| `linear` / `radial` / `angular` | gradient: `stops [{offset 0–1, color}]`, `start`/`end` in the layer's box (0–1) |
| `media` | an image/video as fill: `source` self or an asset, `fit` cover/contain/fill/tile, `focus`, `adjust` |
| `pattern` | stripes · grid · checks · dots · squares · cross · triangles · zigzag · waves · noise · image — with scale, angle, spacing, thickness, colours |
| `variable` | a paint variable (shared styles) |

Each paint has `opacity` and `blendMode`. Shortcut: `layer_create {fill: "#FF3366"}`; for gradients pass a paint object; several at once: `fills: [...]` / `strokes: [...]`, bottom first. Ids of anything new (paints, stops, effects, text effects) are minted — never invent them.

Craft:
- Gradients: neighbouring hues (analogous) or a colour to a darker version of itself. Avoid muddy complements through grey. Two to three stops.
- A soft radial glow (colour at 60–70% alpha → same colour at 0) behind a subject adds depth cheaply.
- Patterns at low opacity with `overlay`/`soft-light` blend add texture without noise.
- Animate paint: `fill.<paintId>` (colour), `fill.<paintId>.stop.<stopId>.color`, `.opacity`, gradient handles (`start.x`…), and every pattern field (`fill.<paintId>.pattern.spacing`, `.offsetX` to scroll, `.color`) — `layer_properties` lists them; key, drive or expose them like any other.
- Pattern lattice: `spacing` is the step from one mark to the next in a row, `spacing · aspect` from one row to the next — `aspect: 1` is a square grid of dots.

## Strokes

A stroke = paint + `width`, `align` (center/inside/outside), `cap`, `join`, `dash`, `dashOffset`, plus the pipeline: `trim` (start/end/offset — **draw-on**), `offset`, `profile` (taper), `wave`, `roughness`, `scatter`, `nib` (calligraphic), `markers` (arrowheads). Insert with `layer_patch` (`insert` into `strokes`).

- **Draw-on**: key `stroke.<id>.trim.end` 0 → 1 (ease-in-out, 800–1500ms), or `animation_set preset "draw"` on an outline layer.
- Hand-drawn: `roughness` + round caps; marker: thick + taper `profile`; technical: thin + dashes.
- Outline text: an `outside` stroke on a text layer (Impact/outline looks).

## Shapes

`layer_create {kind:"shape", shape: rect|ellipse|polygon|star, width, height, fill, stroke, cornerRadius, pointCount, innerRatio}`. Animatable: `width`, `height`, `radius.tl/tr/br/bl` (per-corner), star/polygon radius; ellipse arcs (`arcStartDeg`, `arcSweepDeg`, `arcRatio` — pies, rings, progress arcs) via `layer_patch`/`layer_set`.

- Pill: rect with corner radius = height/2.
- Progress ring: ellipse with `arcRatio` 0.85 and keyed `arcSweepDeg`.
- Any box can round its corners (`borderRadius`) — images and video too.

## Paths (pen)

`layer_create {kind:"path", d: "<SVG path data>", fill, stroke}` — any vector outline, in the layer's own space: `d`'s 0,0 is the pivot, so `x/y` place that origin and every point lands where `d` says. Compose shapes as SVG: `M` move, `L` line, `C` cubic, `Q` quad, `A` arc, `Z` close. One path layer = one piece of artwork (a compound path — holes included); separate pieces that need their own colour or motion are separate layers.

- Keep path coordinates around 0,0 and place the layer with `x/y`.
- Icons: draw simple geometric marks from primitives; for real icons ask the user or use the Library.
- A path created with a `fill` and no `stroke` has no outline; a bare path (neither) gets the default 4px light line so it is visible. Pass `stroke` to outline a filled shape.
- Morphing: key `geometry` with SVG `d` strings of the same command sequence (e.g. eight `C` segments each) — squircle → sparkle → heart morphs cleanly. The layer keeps the box of its ORIGINAL `d`, so the pivot does not drift mid-morph: a dot placed at `x + vertex` stays on that vertex through the whole morph if it shares the geometry's times and easings (pen-node overlays).
- Pivot anywhere: `anchor.x/y` are fractions of that box and may go past 0–1 (a pivot on a tip outside the box). Keying `anchor.y` and `y` together over the same times with the same easing moves the pivot with no visual jump.

## Booleans and masks

Group the pieces, set the group's `mode` (`union` · `subtract` · `intersect` · `exclude` · `mask`) and mark the cutters `isStencil: true`. Non-destructive: move a cutter and the result updates. A mask group reveals content only inside the stencil — animated stencils make wipes and reveals.

## Drawing, painting, flipbooks

- The editor has raster brushes, vector brushes, an eraser and a fill bucket for **hand** drawing in drawing/flipbook comps. Painting strokes pixel by pixel is **not available through the API**. Build illustration from shapes and paths instead, or generate an image (`generate_image`) when a painted look is wanted. If a request needs real brushwork, tell the user and `report_issue` (`api-gap`) so the need is counted.
- **Frame-by-frame = a FLIPBOOK, always.** Never fake it with nested comps laid side by side on a timeline — the user gets no sheet, no onion skin, no holds, and cannot draw over your poses. The flow: `frame_create {mode:"flipbook", fps:12}` → `flipbook_edit {id, ops:[{op:"add", count:7, hold:1}]}` (the sheet already has frame 1) → fill each cell's `drawingId` with `layer_create {frameId: drawingId}` (shapes, paths) → `view_frames` on the flipbook to check the motion.
  - `flipbook_cells` reads the sheet: rows, each cell's `frame` (start) and `hold` in animation FRAMES, and its `drawingId`.
  - Next pose = `{op:"duplicate", cellId}` of the last one, then move or reshape the copy's layers — that is how in-betweens are made. `hold` 2 = on twos (12 drawings a second at 24 fps reads hand-made). `addRow` stacks a second row (a character over a background, lines over colour).
  - A cell is a nested comp — usually a `static` drawing, an animated cell is a `timeline`. Painted (raster) pixels cannot be copied or drawn through the API; build poses from shapes and paths.
- **Painting with vector brushes** (a gouache sky, nebula, mist — worked well): a path whose only paint is a wide stroke with `profile` taper (0.05–0.1 at both ends, lengths ~0.4), `roughness` (amount 10–40, scale 30–110 — cloudy edges), `blendMode: "screen"` so colours add like light, softened with a **`blur` effect** (10–90 px). Several curves per layer as one compound `d` (one stroke style each); 3–4 widths × 5 colours read as a painted milky way. Dark rifts = the same brush, normal blend, a deep blue (never grey). Star dust = a thin stroke with `scatter` (density 6–9, size 0.3, spread 90–200). Never `feather` a stroke-only path — feather erodes inward from the silhouette and a tapered stroke vanishes; feather is for filled shapes (soft glows: a radial-filled ellipse + feather).
- **Hand-drawn look from paths** (worked well): Catmull-Rom through slightly jittered points, draw-on with `stroke.<id>.trim.end` sampled per frame on an ease-in-out curve, and a cursor keyed on the SAME samples by arc length — the pen stays exactly on the line. Pencil = thin, `roughness` 1.5 + light colour; ink = `profile` taper, no roughness; crayon = wide + `roughness` 2, drawn inside a `mask` group whose stencil is the shape ("draw inside").
- **Flipbook instances and dead frames:** a looped cycle needs `playback.loopLengthMs` = sheet length − 1 ms; an instance must never outlive the sheet; the flipbook comp's own `durationMs` is NOT the loop cycle (see the nesting rules in layers-and-layout.md). The first cell of a new sheet holds 120 frames — set its hold first.
- A drawing CYCLE is a flipbook too (8 drawings at 12 fps = 667 ms = one beat at 90 bpm); nest it where it plays and set the nested layer's `playback.loop: "loop"`. Stop motion WITHOUT drawings is different: a layer's own `fps` (8) steps a keyed move.
- `d` keeps its own coordinates: drawn from 0,0 to 200,100 at `x/y` 0,0, its corner is at the comp centre. An arc `M 400 0 A 400 400 0 0 1 0 400` at the same `x/y` as a 800 px circle lies ON that circle, and the layer turns and scales about `d`'s 0,0 (the circle's centre) — draw rings, arcs and spokes about 0,0. (The editor's pen keeps the pivot on the art's centre; move it with `anchor` like any layer.)
- A layer can step at its own `fps` (12 = on twos) for a hand-animated feel.
