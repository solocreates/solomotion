# Relational sizes: units and limits

Any SIZE — a stroke width, a shape's width/height, a font size, letter spacing, padding, an auto-layout gap, a corner radius, a feather, every effect radius or offset (`lfx.<id>.size`, `.blur`, `.x`) — can be written relative to the comp, its parent or the screen. `layer.properties` marks those rows `length: true`, and shows a set unit as `unit` and `as` (`"8spx"`, `"clamp(1spx, 0.2fw, 6spx)"`).

Write it as text in `layer.set`, `layer.create {set}` or `keyframes.set`:

| Text | Means | Use it for |
|---|---|---|
| `2spx` | 2 SCREEN px — two pixels of the output at ANY scale: the layer's own, its groups', every nest above it | non-scaling lines, markers, halos and glows inside a zoom |
| `5vw` · `5vh` · `2vmin` · `2vmax` | % of the OUTPUT frame, also steady at any scale | type and UI that must read the same size on screen |
| `50fw` · `10fh` | % of the comp's width / height (scales with the comp, like px) | responsive layouts: a card 80fw wide fits any format |
| `25%` | % of the parent box (an auto-layout group with a set size, else the comp), along the field's axis | members sized to their container |
| `12px` | plain comp px (also how to go back) | |

**Limits, CSS-style.** `clamp(1spx, 0.2fw, 6spx)` grows with the comp but never draws under 1 or over 6 screen px; `max(1spx, 0.2fw)` only a floor; `min(0.2fw, 6spx)` only a ceiling. Each bound has its own unit. This is the answer to "the line should zoom with the scene, but never vanish and never turn into a slab".

Rules:
- The field KEEPS its unit and limits. A later bare number, every key, and a driver's result are in that unit. Keys of one track share one unit; changing the unit converts the existing keys so the size holds (exact for the root comp; inside a magnified nest, give the screen values themselves).
- `x`/`y` in screen units ignore the layer's OWN scale (they are measured in its parent) but count its groups and nests: `y: "60spx"` sits 60 output px below the parent origin at any zoom.
- Comp units (`fw`, `fh`, `%`) are layout units, sized before transforms — a group scaled ×2 shows a `50fw` box at the full comp width, as CSS does.
- A size of 0.0005 comp px is legal (that is what `8spx` is at ×13 000): shapes are not floored at 1 px.
- Expressions mix them like CSS `calc()`, each returning THIS field's px: `fw(50) - spx(8)`, `max(spx(1), fw(0.2))`, `clamp(fw(0.2), spx(1), spx(6))`, `pw(100) - 32`. Write those on a field left in px.
- Seen how? "Output" is the comp being rendered (an export, the comp on the stage). The stage's own zoom is a magnifier and never changes a size. A nested comp containing screen units is drawn live, not from the picture cache.

Effects are drawn at OUTPUT resolution through any nest: a glow on a dot inside a ×13 000 zoom is as crisp as one at ×1 (only what can land on screen is rasterised). Fading a magnified nest's opacity is crisp too.

Check: `view_render` the same instant at two zooms and compare; a screen-unit line must be the same width in both.
