# Perform — act a take, keep ordinary keys

Perform is how a person records motion live (⇧P on the stage, R to record,
drag a control or press 1–9 while it plays). `perform_take` is the same writer
for an agent: you hand it what you would have done with your hand.

## When to reach for it

- Motion that should feel HAND-MADE: a wobble, a nervous glance, a looping
  doodle path, a dial turned by feel. Generate dense samples (every 10–40 ms)
  from a function or a noise source and let the reducer find the keys.
- Timing a run of discrete choices to sound or a beat: mouth/pose changes,
  eye states, a switch flicking — trigger `events`.
- Not for two or three clean keys: `keyframes_set` is clearer.

## Samples (a drag)

```json
{ "id": "<layer>", "paths": ["x", "y"],
  "samples": [{ "at": 0, "value": [0, 0] }, { "at": 20, "value": [3, 1] }, …],
  "tolerance": 1, "smoothMs": 30 }
```

- `at` is ms from the layer's start (`clock: "comp"` for comp time), in the
  order performed. A time that jumps BACK is a loop wrap: a new pass, and the
  later pass replaces the earlier where they overlap.
- Channels sampled together (x/y of one drag) share key times.
- `tolerance` is in the channel's units (px, degrees, 0–1): the most the
  played curve may stray from a sample. Default ≈ 0.5 % of the take's range.
  Raise it for fewer, looser keys. `smoothMs` steadies a shaky hand.
- Keys land on the comp's frames, eased like the Smooth command (no overshoot
  at peaks). Rotations are unwrapped, so a dial can turn past 180°.
- ONLY the take's range is replaced; keys outside it and other channels are
  untouched. A channel with no keys keeps its old value up to one frame before
  the take.
- Bone channels (`bone.<id>.rotation`, `.x`, …) are written inside the bone's
  limits.

## Triggers (presses)

```json
{ "id": "<character group>", "path": "pose.<setId>", "mode": "touch",
  "events": [{ "at": 500, "kind": "down", "value": "AI" }, { "at": 900, "kind": "up", "value": "AI" }] }
```

- `latch`: each press keys its value; releases are ignored.
- `touch`: keyed while held; release returns to what showed before the press.
  Holds stack (press O while holding AI, release O → AI again). A held span
  replaces keys under it.
- A switch that a pose set drives is owned by the set: key `pose.<set>` on
  the CHARACTER GROUP, never the member's `switch` (the verb refuses it).
  A plain switch group takes `path: "switch"` with member names.

## Check

`view_frames` across the take's span; `layer_get` shows the keys written.
The result says `keys` per path and `passes`.
