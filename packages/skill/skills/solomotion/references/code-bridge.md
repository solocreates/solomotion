# Code bridge — read the code, edit it, run it

Anything visual in {{name}} has a code form: `script_reify` prints layers, a
whole comp, or one state machine as the `ac.*` script that rebuilds it. The
code IS the data, printed — so the fastest way to change something big is
often to read its code, edit the code, and run it.

## The loop

1. **Read.** `script_reify {layers: ["Hero"]}` (or the selection, or
   `{comp: "Intro"}`, or `{machine: {name: "Mood"}}`). You get `code`, `exact`
   (true = running it rebuilds the target, ids aside) and `warnings` (what the
   code cannot say — painted pixels, a visualizer).
2. **Own it.** `script_reify {layers: [...], save: "hero.js"}` saves the code as
   a script whose ledger OWNS those layers. Replace mode (the default) removes
   what a script owns before it runs — so the first run swaps the originals for
   the code's rebuild, in place: same stack position, same timing.
3. **Edit.** `script_read` / `script_save` the source: change a colour, a
   timing, add a key, loop the creation over data. Keep the variable style —
   `const card = await ac.layer.create(...)`, then `card.id`.
4. **Run.** `script_run {script: "hero.js"}`. Re-run as often as you like:
   each run replaces what the last one made. One undo step per run.

Use it when an edit touches many fields across many layers (restyle a whole
title card, retime a sequence, duplicate a rig with changes), when you want a
reviewable artefact, or to learn how something was built. For one property,
`layer_set` is still cheaper.

## Reading the code

- Layers are created bottom of the stack first; groups, rigs and switches
  after their members (`layers_group`, `rig_create`, `switch_create`).
- Ids flow through variables: `` `lfx.${cardGlow.effectId}.size` ``,
  `` `fill.${card.fills[0]}` ``, `` `bone.${armBone.Upper}.rotation` `` (a bone
  name → id map). Never paste raw ids from `layer_get` into code you keep.
- Effects, poses, shape keys, keys and expressions come after every layer
  exists — an expression may read a layer made after its own.
- A trailing "Exact details" block holds `layer_patch` edits for fields no
  verb sets. Leave them unless you mean to change those fields.
- `placement: { below: "Top" }` keeps the rebuilt layers under the layers
  that were above them. Keep it when editing in place.

## Gotchas

- Run a saved, owning script in **replace** mode. Append mode keeps the
  originals and adds a second copy.
- A whole-comp script re-creates the comp: other comps that nest it lose it on
  replace. Prefer reifying the comp's layers.
- Set values, don't increment them — a re-run applies the code again.
