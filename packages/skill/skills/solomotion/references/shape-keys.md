# Shape keys — morphing a path or a mesh

A shape key is a drawn shape a vector PATH or an editable MESH bends to by a
weight: a mouth's visemes, a blink, a brow raise, ARKit `jawOpen`. Many keys
mix: `shape = base + Σ weight · delta`. Keys morph BEFORE bones and modifiers,
so a rigged mouth bends its morphed outline and a subdivided face smooths it.

## When to reach for it

- One drawing that changes shape smoothly → shape keys on that path.
- Drawings that SWAP (a hand-drawn mouth per viseme) → a switch group instead.
- Both are poses: a pose set can hold `key.<id>` values, a `switch` value or bone
  channels, so one lip sync drives any mouth.

## Verbs

- `shapekey_create { id, name, from?: "zero"|"mix", points?|verts?, relativeTo? }`
  — `points`: `[{ contour, index, x/y or dx/dy, hIn?, hOut? }]` in the layer's
  own space (handles follow their anchor unless given). Mesh: `verts:
  [{ index, x/y/z or dx/dy/dz }]`. A primitive needs `editable: true`. An
  imported model: `assetTarget: "jawOpen"` (its own glTF morph target; weight only).
- `shapekey_edit { id, key, points|verts|name|mute|relativeTo|duplicate|mirror }`
  — edits the KEY; the base and other keys stay. `mirror` reflects across the
  layer's own x = 0 and names the side (`Smile.L` → `Smile.R`).
- `shapekey_set { id, weights: { Smile: 0.8 } }` — resting weights.
- `shapekey_inspect { id, key? }` — keys, their `key.<id>` paths, and a key's shape.
- `shapekey_remove { id, keys }`.

## Animating a weight

The weight is the ordinary channel `key.<id>` (from `shapekey_inspect`):
`keyframes_set` it, `expression_set` it (`loudness("Voice")` on a jaw), or
put it in a pose set's values. 0..1 is the drawn range; 1.2 overshoots and
negative inverts — both are legal.

## Gotchas

- Draw keys from the SAME outline: adding or deleting points later is safe
  (every key follows), but a key cannot be a different drawing with other points.
- `relativeTo` draws a key on top of another (a corrective for "Open + Smile");
  its weight still adds on its own.
- Check a morph cheaply with `view_render` at two weights rather than many frames.
