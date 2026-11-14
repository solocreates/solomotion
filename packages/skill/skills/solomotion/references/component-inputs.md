# Component inputs

A component's INPUTS are its public, keyable knobs (Figma component
properties, Rive inputs). Use them whenever two instances of one thing must
differ — two characters with different moods, voices or colours, a button
that is Pressed in one place and not another. Never detach or duplicate a
component to vary it.

## Define

`component_inputs` with `action`:

- `define` — `frameId` (the component) + `def: {name, type, default?, min?, max?, step?, options?}`.
  Types: `number` · `bool` · `enum` (options) · `text` · `color` · `trigger` · `layer`.
- `expose` — `layerId` + `property` (any path from `layer_properties`): makes an
  input named, typed and defaulted from that field and binds the field to it.
  The fastest way: build the master, then expose what should vary.
- `update` / `remove` / `reorder` — `input` is an id or a name. Removing unbinds
  every field (it keeps the master's value) and drops every instance's keys.
- `variants` — on a component with variants: a NEW component holding a switch
  of every variant, driven by a `Variant` choice. Key that choice on an instance
  to change variant over time (never re-point `sourceFrameId` per frame).
- `list` — the inputs with their `input.<id>` path and what is bound.

## Set and key on an instance

An instance's inputs are ordinary channels on the nested clip:

- `layer_set {ids: instanceId, values: {"input.Mood": "Sad"}}` — by name or id;
  values are clamped / snapped to a choice.
- `keyframes_set {id: instanceId, property: "input.Mood", keys: [...]}` — name or
  id here too, and in `expression_set`; both answer with the `input.<id>` path.
  Numbers and colours glide; choices, text and flags hold.
- A `trigger` fires on the frame of each key — key it once per wave, jump, blink.
- Inputs run on the INSTANCE's clock (its time in the parent comp), not the
  looped/sped time inside it.

## Read inside the component

- A field bound by `expose` IS the input (`input:<id>` binding).
- In an expression: `input("Mood")` → the instance's value (the default when you
  edit the master directly). E.g. `expression_set(mouth, "switch", 'input("Mood") == "Sad" ? "Frown" : "Smile"')`.
- A component inside a component: expose the inner instance's `input.<id>` from
  the outer comp, or drive it with `input("OuterName")`.

## Voices for crowds

A `layer` input names a layer in the comp the instance sits in. Give the
character a `Voice` input, set each instance's to its own voice clip, and a
Lip sync behavior hearing every voice speaks each instance's own — two
instances, two lines. Or drive an
instance's input from the parent with an expression on `input.<id>`.

## Gotchas

- `random()`, `wiggle()`, `blink()` are seeded per instance: a crowd of one
  character does not blink in unison. Equal inputs otherwise share one picture,
  so a hundred identical instances cost one render.
- Check with `view_frames` at two instants on two instances.
