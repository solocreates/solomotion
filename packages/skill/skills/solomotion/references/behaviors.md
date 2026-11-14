# Behaviors — what a character does on its own

A character's life is a **stack of behaviors**, like an effects stack: each one
drives a pose set or a channel, live, over time — and none writes keys. Later
behaviors win where two are active; where none is, your keys (or the resting
pose) show.

| type | drives | what it does |
|---|---|---|
| `lipSync` | the mouth set | the syllables of whichever voice plays (or a named one) |
| `blink` | the eyes set | shuts the eyes now and then, through `Half` when the set has one |
| `glance` | a Look bone, or a layer | looks around and back to centre; same `seed` = eyes that look together |
| `breathe` | a bone or channel | a slow rise and fall that adds onto your keys |
| `sway` / `nod` | a bone or channel | idle drift; nod moves with the voice |
| `cycle` | any set | steps through poses on a loop (`steps: [{pose, ms}]`) — idles, walks |
| `machine` | the sets its states name | a state machine's current pose |

```
behaviors_inspect {groupId, types:true}                     → the stack, each behavior's fields; `types` lists every kind
behaviors_add     {groupId, type:"blink", fields:{every:3.5, half:"Half"}}   → tailored: its set, Closed/Half, its bone
behaviors_add     {groupId, type:"cycle", set:"Hands", steps:[{pose:"Wave", ms:400}, {pose:"Relaxed", ms:900}]}
behaviors_update  {groupId, id, fields:{every:2}}  ·  {…, enabled:false}  ·  {…, index:0}
behaviors_override {groupId, id, fromMs, toMs, pose:"Closed"}   → a blink you add; pose:null → none here; reset:true → automatic
behaviors_remove  {groupId, id}
```

- **Fields are keyable** at `bhv.<id>.<field>` (`keyframes_set` /
  `expression_set` like any property): key `bhv.<id>.enabled` off for a stretch,
  ramp a blink's `every`.
- **Fix a block like a clip.** Every block on a lane — a syllable, a blink, a
  cycle's step — takes `poses_block` (see `poses.md`): change its pose, split
  it, trim or roll its edge, slide it, delete it. On a behavior's block each is
  an OVERRIDE the behavior keeps when it regenerates (a new seed, a new take of
  the voice). `behaviors_inspect blocks:true` shows who decided each block and
  which are yours (`overridden`).
- **Voices**: `lipSync` with no `voice` follows whichever voice plays at the
  moment (the topmost audible), so one character can speak several lines with
  different voices; name one in `fields.voice` to pin it.
- **Mouth map**: each viseme (`X MBP S E AI O U FV L`) shows the set's pose of
  that name, else an alias or fallback. When the art is named otherwise, point
  a viseme at a pose: `behaviors_update {groupId, id, fields:{"as.MBP":"Closed",
  "as.O":"Oo"}}` (`null` = automatic again). Rest is the `rest` field ("In
  pauses"). The editor window shows the same map, so check it there.
- **State machine**: `behaviors_add {type:"machine"}` with no `machine` binds a
  machine of the comp no other machine behavior runs, or creates one with a
  state per pose of the set (first = entry). Wire transitions with `machine_*`.
- **Glance a 3D eye**: `fields:{layer: eyeGroupId}` turns that layer (degrees);
  two glances with the same `seed` look together. Up and down is Z in a world.
- **Bake** when you want keys: `poses_bake {groupId, set}` turns the set's live
  choice into pose keys and turns its behaviors off.
- `character_bringToLife` adds the usual stack (lip sync, blink, breathe, nod)
  in one step — start there, then edit the stack.
