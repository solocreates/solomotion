# State machines: characters that decide

A comp can carry Rive-style **state machines**: from its inputs (and its voice, and time), a machine picks which state each of its layers is in. The machine writes nothing — `state("Mood")` reads the state in any expression, usually a pose set's `pose.<set>` driver. It is **exact per frame**: scrub, play backward, export — the same state at the same instant. Nothing to bake.

## The model

- A machine has **layers** that run side by side (one for the face, one for the arms). Each layer is in exactly one state at any instant and starts in its **entry** state.
- A **transition** fires when ALL its conditions hold (none = at once). `from: "any"` fires from whatever state the layer is in (Any state); `to: "exit"` ends the layer (no state). Order is priority: Any state transitions first, then the state's own, each in list order.
- **Conditions**: `{kind:"input", input:"Mood", op:"==", value:"Happy"}` (ops `== != < <= > >=`; floats compare with a tolerance) · `{kind:"trigger", input:"Wave"}` (true on the frame its key lands) · `{kind:"speaking", layer:"Voice"}` (`is:false` for silent; "Voice" may be the comp's `layer` input — each instance hears its own voice) · `{kind:"time", op:">=", ms:2000}` (time in the current state).
- `exitTime` (ms): the transition waits until the state has run that long, even if its conditions held earlier. `durationMs`: the blend into the next state (what pose blending reads).
- The clock is the **instance's** time: inputs are keyed on the instance clip (`input.<id>`), and the machine inside follows the parent's timeline however the comp loops. The master drawn by itself reads input defaults and no trigger fires.

## Verbs

```
machine_create     {frameId?, name, layers: [{name?, entry?, states: [{name, x?, y?, output?}], transitions: [{from, to, when: [...], durationMs?, exitTime?}]}]}
                   → the machine in words + issues. Same name again REPLACES it (states keep ids and places) — edit a whole machine this way.
machine_state      {machine, layer?, add?: [{name, entry?}], edit?: [{state, name?, x?, y?, output?, entry?}], remove?: [names]}
machine_transition {machine, layer?, add?: [...], edit?: [{transition: id, from?, to?, when?, durationMs?, exitTime?: null removes}], remove?: [ids]}
machine_inspect    {frameId?, machine?, instance?, fromMs?, toMs?}  → states, transitions in words, ISSUES, and the STATE TIMELINE per layer
machine_evaluate   {machine, atMs, instance?}  → each layer's state, time in state, where it came from, blend progress
machine_remove     {machine}
```

States and inputs are named, not id'd, in every verb. Conditions store an input's id when the comp defines it, so renaming the input keeps the machine working.

## Wiring it to the character

1. Inputs on the component: `component_inputs {action:"define", def:{name:"Happy", type:"bool"}}`, a trigger `Wave`.
2. `machine_create` with states named like the poses they show (Idle, Joy, Waving).
3. Drive the pose set: give each state `output: {kind:"pose", set, pose}` and `expression_set` the group's `pose.<setId>` with `statePose("Mood")` — each state shows its own pose. (`state("Mood")` reads the state NAME, for `if()` tests.)
4. Key the instance: `keyframes_set {id: instance, property: "input.<id>", keys: [...]}` — a trigger fires at each key.
5. **Check with `machine_inspect {instance, toMs}`** before rendering anything: one call shows every state change and which transition caused it.

`stateTime("Mood")` gives seconds in the current state — ease something in after a change: `min(stateTime("Mood") / 0.3, 1)`.

## Gotchas

- A chain of instant transitions moves several states in one frame (Waving → Idle → Joy when Happy is still true). That is correct — read the timeline.
- Two transitions that are true together in a cycle (A→B and B→A, no conditions) are stopped by the loop guard: the layer alternates and the segment says `cut`. Add a condition or an `exitTime`.
- A trigger moves each layer once per key: a toggle on one trigger flips, it does not bounce back.
- Float `==` on a gliding number is fragile even with the tolerance; prefer `>=` / `<` thresholds for numbers.
- A condition on an input that does not exist never fires — `machine_inspect` lists it under `issues`.
