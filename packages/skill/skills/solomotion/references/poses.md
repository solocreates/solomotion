# Poses — parts with named states

A **pose set** lives on a group (the character, or a part of it): a mouth's
visemes, eyes, brows, hands, moods. Each pose is a list of `{clipId, path,
value}` on any layer under the group — so one set can swap drawings
(`switch`), morph (`key.<id>`), move bones (`bone.<id>.rotation`) or nudge any
field (`y`, `opacity`, a fill colour), or all at once. The set's channel
`pose.<setId>` picks a pose by NAME; the app eases between poses (default
120 ms). Discrete values (a switch) change on the key; numbers and colours blend.

```
poses_create {groupId, fromSwitch: mouthSwitchId}            → one pose per member, vocabulary guessed
poses_create {groupId, fromLayer: tailId}                    → ANY layer becomes a part (a tail, ears, a cape): one pose, Rest
poses_drawing {groupId, set:"Left hand", pose:"Fist"}        → the layer that pose shows — edit it to change the pose everywhere
poses_drawing {…, action:"duplicate"}                        → a copy as a NEW pose to redraw; the original untouched
poses_create {groupId, name:"Eyes", vocabulary:"eyes", poses:[{name:"Open", values:[…]}, {name:"Closed", values:[…]}]}
poses_add    {groupId, set:"Brows", name:"Angry", capture:true, targets:[{clipId, path:"rotation"}], atMs}
poses_key    {groupId, set:"Mouth", keys:[{atMs:0, pose:"X"}, {atMs:120, pose:"MBP"}, …]}   → one key per sound
poses_key    {groupId, set:"Brows", move:{fromMs:300, toMs:900}}  ·  {…, remove:300}   → retime / delete a block
poses_update {groupId, set:"Mouth", blend:{ms:60}}  ·  {…, pose:"Wink.L", mirror:true}  ·  {…, pose:"AI", setValues:[…]}
poses_inspect {groupId, atMs}                                → which pose shows, blend weights
poses_inspect {groupId, blocks:true, fromMs?, toMs?}         → the performance, block by block (the timeline's lanes)
poses_bake   {groupId, set}                                  → expression / lip sync / machine → pose keys
poses_block  {groupId, set, atMs, action:"split", splitMs}    → one block, edited like a clip (below)
poses_block  {groupId, set, atMs, action:"change", pose:"O"}  ·  {…, action:"trim", edge:"end", toMs, roll?}  ·  {…, action:"slide", deltaMs}  ·  {…, action:"delete"}
poses_remove {groupId, set, pose?}
```

- **Names are forgiving.** Case, spaces and punctuation are ignored; aliases
  work (`rest` = `X`, `shut` = `Closed`, `thumbsup` = `Thumb`). A name a set
  lacks walks the vocabulary's fallbacks (`U` → `O` → `AI`), then shows the
  first pose — a mouth never disappears. Vocabularies: `visemes` (X MBP S E AI
  O U FV L), `eyes` (Open Half Closed Wide Squint Happy), `brows`, `hands`
  (Relaxed Open Fist Point Thumb Peace Wave), `emotions`.
- **Drive it like any field — and build on it with `#value`.** `#value` is the
  field's own keys or base: `expression_set(groupId, "pose.<setId>", 'if(blink(4) > 0, "Closed", #value)')`
  blinks on top of whatever eyes you key (pick Angry and Angry blinks). A driver
  WITHOUT `#value` replaces the keys (lip sync, a machine): `poses_key` refuses
  it — fix one syllable with `speech_fix`, or `poses_bake` first.
- **Poses are layers on bones and shape keys.** On `bone.<id>.*` and `key.<id>`
  a pose ADDS to the part's own value (stretch multiplies): `rig_pose` sets what
  the bone SHOWS and writes your layer beneath the pose, and choosing another
  pose keeps your adjustment. Switches, colours and member placements are the
  pose's outright — change those in the pose (`poses_update setValues`).
- **Capture is what you see**: pose the parts (bones, keys, values), then
  `poses_add capture:true` (or `poses_update capture:true`). The captured pose
  shows from `atMs`, still adjustments move INTO it and keyed ones stay yours,
  so the frame does not change. This is how a new pose is invented from a
  preset: pick one, adjust, capture.
- **Read the performance as blocks**: `poses_inspect blocks:true` gives each
  set's `mode` (keyed · base · live) and its blocks `{fromMs, toMs, pose,
  source, keyMs, behavior, overridden}`.
- **Edit any block like a clip** with `poses_block` — by an instant inside it,
  whoever decided it: your keys (the key moves), a behavior's block (lip sync,
  blink, cycle — it becomes an override the behavior keeps), or the resting
  pose (keys over that stretch alone). `split` then `change` gives one syllable
  another mouth shape; a `trim` on an edge two blocks share ROLLS (one grows as
  the other shrinks) unless `roll:false`. Times land on the frame grid.
- **A set knows its part** (`part`: the layer it changes) — tiles frame it.
  `blend:{mode:"morph" | "swap"}` eases or cuts between poses;
  `transitions:[{from:"*", to:"Closed", ms:40}, {from:"Closed", to:"*", ms:110}]`
  times particular changes (a blink shuts fast, opens slow).
- Check with `poses_inspect atMs` at a key and half a blend after it, then
  `view_frames`.
- **Any part, any concept.** Vocabularies are only name lists (and their
  fallbacks); a part is whatever layer you say: `poses_create {fromLayer}` for
  a tail or ears, `fromSwitch` for drawings to swap between, or `poses` with
  values on any paths. Then pose it (bones, keys, values) and
  `poses_add capture:true` for each state.
- **A pose's drawing is shared.** A swap pose shows one layer (often a group of
  shapes); editing those shapes changes that pose everywhere it is used — like
  a component's master. To keep the original, `poses_drawing action:"duplicate"`
  first and edit the copy (rename it with `poses_update`).
- **What a pick changes** (the app's Face pad, and `poses_block`): the picked
  blocks, else the block under the playhead — never the whole lane; recording
  cuts at the playhead and changes from there to the block's end.

