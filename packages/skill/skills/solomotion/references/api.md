# The API — conventions and patterns

Every command is a tool. Names use `_` in tool calls (`layer_create`) and `.` inside `api_batch` (`layer.create`); both work anywhere a command id is accepted.

## Results and errors

- Results are compact JSON. Reads summarise; ask for more with `fields`, a narrower `path`, or a `group`.
- A failed call changes nothing. Errors say which field is wrong and what to do: read the `Hint:` line, fix, retry. Three kinds:
  - **input** — the arguments did not match the schema (`style.fontSize: Expected number`). Fix the named field.
  - **api** — the request was valid but cannot apply (`No layer with id…`, `"glow" does not apply to a shape`). The hint names alternatives.
  - **internal** — a bug. Retry once with a different approach, then `report_issue` (category `api-bug`).
- Typos get "Did you mean": `rotaton` → `rotation`.

## Reading, cheapest first

| Need | Call |
|---|---|
| Comps, sizes, selection, playhead | `doc_overview` |
| What is in a comp, where, when | `layers_list` (bounds and flags per layer) |
| One layer's data | `layer_get` (bulky parts folded — ask with `fields: ["subpaths"]`); its `box` is the measured size before scale (text, paths) — measure with it, not a probe render. For text it waits for the face to load, so it is never the fallback's width |
| What a layer can animate, and current values | `layer_properties` (optionally one `group`) |
| The exact shape of a type | `api_describe {type, path}` — e.g. `{type:"text", path:"style"}`, `{type:"layerEffect", path:"[type=glass]"}`, `{type:"paint"}`, `{type:"layout"}` |
| What exists to choose | `catalog_list {catalog, query}` then `catalog_get` for fields/knobs |

## Batching

`api_batch` runs calls in order and returns every result. Reference an earlier result with a string that is exactly `$<index>` or `$<index>.<path>`:

```json
{ "calls": [
  { "command": "layer.create", "input": { "kind": "shape", "shape": "rect", "width": 640, "height": 180, "fill": "#15151C", "cornerRadius": 28 } },
  { "command": "layer.create", "input": { "kind": "text", "text": "New drop", "placement": { "above": "$0.id" } } },
  { "command": "layers.group", "input": { "ids": ["$0.id", "$1.id"], "name": "Chip", "layout": { "padding": { "top": 24, "right": 40, "bottom": 24, "left": 40 } } } }
] }
```

Stops at the first failure (later calls are skipped and listed) unless `continueOnError: true`. Batches do not nest. Up to 40 calls.

- **Read every item's `ok`.** The batch itself succeeds even when a call inside it fails; a client that only checks the batch will silently skip everything after the failure.
- **One `keyframes_set` per property.** It replaces that property's keys (`replace: true` by default), so three calls keying `x` at three moments leave only the last. Collect a property's keys and write them once.
- **`layers_restack {ids, to}` stacks `ids` top to bottom** — the first id ends up highest. `to` is `"front"`, `"back"`, `{above: id}` or `{below: id}` (or pass `above`/`below` alone). `layers_copy` into another comp lands the copies in front.

Parallel tool calls in one turn also work: reads run together; writes run in the order you wrote them.

## Property paths (`layer_set`, `keyframes_set`, `expression_set`)

One grammar everywhere — keyframes, drivers, expressions, modulators, the node board:

| Path | Means |
|---|---|
| `x` `y` `rotation` `scale` `scaleY` `skewX` `skewY` `anchor.x` `anchor.y` | transform (scaleY present = non-uniform) |
| `opacity` `feather` `borderRadius.tl…` `crop.top…` `content.x/y/scale/rotation` | layer box and picture |
| `width` `height` `radius.tl…` | shape geometry |
| `fontSize` `letterSpacing` `lineHeight` `color` `fontFamily` `fontWeight` `fauxBold` `italic` `maxWidth` `text` | typography (text layers) |
| `fill.<paintId>` / `fill.<paintId>.opacity` / `fill.<paintId>.stop.<stopId>.color` | paints |
| `stroke.<strokeId>.width` / `.trim.end` … | strokes |
| `lfx.<effectId>.<field>` | a layer effect's field |
| `tfx.<effectId>.<field>` | a text effect's field |
| `afx.<effectId>.<field>` | an audio effect's field |
| `lfx.<gradeCard>.n.<node>.fx.<effect>.<field>` | a value inside a colour grade node |
| `audioMix.volume` `playback.speed` | sound level; playback speed |
| `mblur.*` | the layer's shutter |

Never guess a path: `layer_properties` lists them for the actual layer, with ranges.

## Patching (`layer_patch`)

Ops: `set` (replace), `merge` (shallow-merge an object), `insert` (into a list; `index` or append), `remove`, `move` (`to` index). Path steps: `a.b`, `[2]`, `[id=fx_1]` (prefer — stable), `[type=glass]`, `[-]` (append).

```json
{ "id": "Title", "ops": [
  { "op": "merge", "path": "style", "value": { "align": "left", "textCase": "upper" } },
  { "op": "insert", "path": "strokes", "value": { "paint": { "type": "solid", "color": "#000000" }, "width": 6, "align": "outside" } },
  { "op": "set", "path": "effects[type=shadow].enabled", "value": false }
] }
```

Missing `id`s in anything you insert are minted. The whole layer is re-validated; nothing lands unless all of it is valid. Some fields belong to verbs and are refused here: `text` (use `text_set`), timing (`timeline_*`), `frameId`, `kind`, `id`.

## Timing rules

- `startMs`/`durationMs` are comp time; placement floors a new layer onto the comp's frame grid.
- `timeline_move` and `timeline_trim` land exactly where asked. When another layer on the same lane is in the way, the layer moves to the lane just above (over the one that blocked it) and the result lists it under `relaned` with `blockedBy`. A trim edge can still stop short at the media's first frame or the 50 ms minimum — then the result carries `asked` beside the real `time`. Locked layers are listed under `blocked`.
- Keyframe `at` is **layer-relative** by default. A key can sit before 0 or after the end (it still shapes the curve). If you are thinking in comp time (syncing several layers that start at different moments), pass `clock: "comp"` on every one of them — see the pitfall in `motion.md`.
- Easing on a key shapes the segment **leaving** it. Shorthand: `"linear"`, a preset (`ease-out`, `ease-in`, `ease-in-out`, `ease-out-quart`, `ease-out-expo`, `ease-out-back`, `ease-in-out-back`, `ease-out-elastic`) or `"cubic-bezier(x1,y1,x2,y2)"`.

## Undo

All your writes in one user request are ONE undo step, labelled "AI · <their request>". If the user edits in between, your next writes start a new step. `history_undo` reverts your own most recent step only — useful to back out a wrong direction wholesale.

## When something is missing

If no verb, path or patch can express what you need, that is an API gap: do the closest honest thing, tell the user, and `report_issue` (`api-gap`) with the exact capability you needed.
