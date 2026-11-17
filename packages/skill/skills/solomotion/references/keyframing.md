# Keyframing: poses, not samples

Somebody will open what you made and change it: retime a hop, soften a camera move, push a line
half a second later. A key is a decision they can grab. A key on every frame is a recording they can
only delete. A film built that way played perfectly and was unusable, with 194,000 keys where 3,000
would do. Build like an animator, with poses and curves, and build that way inside scripts too.

**Targets:** a move is 2 keys per property. A hop is one `position` key per contact plus about four
squash keys. A camera shot is one key per rig track. A cut is one `hold` key. A finished 60 s piece
lands around 1–4k keys with **zero baked tracks**.

## The rules

1. **Key the poses**: start, contacts, extremes, rests, end. Let easing draw the in-betweens. A loop
   that steps `t += frameMs` and writes a key each time is baking. Stop and find the poses.
2. **The easing lives on the key LEAVING the pose.** A cursor that "arrives with an ease" is off by one
   segment.
3. **Times come from the story and sit on frames.** A key's time is the beat: the word onset, the
   contact, the cut. Write keys on `clock: "comp"` when several layers share a gesture. Snap with
   `Math.round(t / frameMs) * frameMs`. Easing changes how a value travels between two poses, never
   WHEN the poses happen, so curves cannot break your sync.
4. **A rest is two equal keys; a cut is a `hold`.** `easing: "hold"` keeps the value until the next
   key, then switches on that frame: one key per switch (show/hide, swap a drawing, jump a value).
   Never two keys a millisecond apart. A `hold` whose next key has a DIFFERENT value is a cut: the
   whole picture jumps on one frame. To hold and then move, key the hold's end with the same value and
   ease from there. A script that collects keys per beat must sort them and check each `hold` against
   the key after it: two beats' keys interleaving is the usual source of a one-frame snap.
5. **Read before you write more.** `keyframes_inspect {id}` prints every track in one line
   (`time value easing · …`, comp ms, `↷` = a curved path key). `keyframes_inspect {}` gives the comp's
   budget and flags **baked** tracks. Use it instead of `layer_get`; it costs a few hundred tokens.

## Choosing the curve

| Intent | Easing |
|---|---|
| UI or camera move between two rests | `cubic-bezier(0.76,0,0.24,1)` |
| Arrival, settle into place | `ease-out-expo` · softer `ease-out-quart` |
| Pop, sticker, badge | `ease-out-back` (once; overshoot means something) |
| Leaving, falling, gathering speed | `ease-in` · `cubic-bezier(0.7,0,0.84,0)` into the lens |
| Thrown things | `linear` under an `arc`: the arc carries the gravity |
| A drop that bounces to rest | `bounce` on the key (below) |
| Springs, characters only | `ease-out-elastic` |
| Constant machines: marquee, timer, conveyor | `linear` |
| Cut, switch, stepped animation | `hold` |

Moves that should flow through a middle key instead of stopping on it: give them one continuous curve
(two keys) or run the keyframe **Smooth** action. Don't add a key in the middle of an eased move.

## Recipes

**Move between two rests:**
`keyframes_set {id, property: "position", clock: "comp", keys: [{at: 1200, value: [-300, 0], easing: "cubic-bezier(0.76,0,0.24,1)"}, {at: 1700, value: [300, 0]}]}`

**A hop, or a chain of hops.** `position` writes x and y as motion keys; `arc` on a key makes the
segment leaving it a thrown arc peaking that many px above the higher end. Its default linear easing
is exact gravity: constant sideways speed, a true parabola. One key per contact; a rest is the
same point keyed again.
```js
keys: [
  { at: 0,    value: [-400, 300], arc: 180 },  // take off
  { at: 520,  value: [-80, 300] },             // land, rest...
  { at: 700,  value: [-80, 300], arc: 120 },   // ...take off again
  { at: 1100, value: [240, 260] },             // land on the ledge
]
```
`arc` < 0 sags below the lower end (a swing, a dip). For any other path shape pass `in`/`out`
handles in px relative to the key, the same handles the stage's motion-path tool draws.

**A drop that bounces to rest.** `bounce` on a number key drops to the next key's value and bounces
there, written as real keys (an impact and an apex per bounce, each segment an exact parabola):
`keyframes_set {id, property: "y", keys: [{at: 0, value: -400, bounce: {count: 3, decay: 0.35}}, {at: 1400, value: 300}]}`.
`decay` is each rebound's height over the last. To travel while it bounces, key `x` separately with
its own easing — `x` and `y` are separate properties, and `position` keys move both together.

**What may squash, and what may not.** Squash and stretch is for soft bodies: a character, a ball, a blob. A button, a pill, a logo, a word or an icon scales **uniformly**, always: write the same keys to `scale` and `scaleY`. A stretched word is the fastest way to look like a beginner. Give a UI object its weight from what surrounds it: an accelerating fall, an overshoot of a few percent, and the world reacting to the hit (what it landed on recoils, a ring, shards, a camera punch).

**Squash and stretch at a contact.** Set the pivot on the contact first (`anchor.y: 1` for a floor),
then key `scale` and `scaleY` together, about four keys per contact:
`scaleY: [contact−1f 1.12 ease-out] → [contact 0.72 ease-out-quart] → [+3f 1.06 ease-in-out] → [+6f 1]`,
with `scale` moving the other way (1/scaleY) to keep volume. Stretch only in the frames
touching the contact. A ball in mid-air is round.

**Follow-through and overlap.** Secondary parts (eyes, a tag, a tail) take the SAME keys 2–4 frames
later. Copy the key list with a time offset; don't invent new motion.

**A switch.** `opacity: [{at: 0, value: 1, easing: "hold"}, {at: 2400, value: 0, easing: "hold"}, {at: 3100, value: 1}]`.
If a thing just stops existing, trim the layer instead: an end is not a key.

**A pen writing (draw-on).** A pen's speed is constant within a stroke, so `stroke.<id>.trim.end`
needs one key where each stroke starts and one where it ends, `linear` between. A pen lift
holds automatically (two equal keys). Ten strokes is twenty keys, not one per frame.

**Riding something** (a dot on a hook, a label on a card): group the rider with the carrier and key
the GROUP, or give both the same keys (same times, same easings) with a constant offset. To relate
two values permanently (a label 120 px above a card), use an expression: `layer("Card").y - 120`.

**One clock, many readers.** When the same piecewise timing (shot 1 until 4 s, shot 2 until 9 s…)
would drive several properties, don't paste the long expression into each: one copy drifts the
first time a shot is retimed. Make a CLOCK layer: an invisible 2×2 rect at opacity 0 named "Cam
clock", outside the camera rig, its `x` carrying the one expression (a progress, a shot index, a
zoom). Every other property reads it: `expression_set` on World `y` = `-layer("Cam clock").x * 840`,
on Camera `scale` = `1 + layer("Cam clock").x * 0.04`. A read returns the clock's evaluated value at
the same instant (its expression or its keys), chains work, and a cycle is cut, not looped.
Retime once, on the clock. Use spare channels (`y`, `rotation`) for a second signal.

**Tracing a drawn line** (the dot is the pen tip): the motion path IS the drawing. Key `position`
at the path's anchor points with `in`/`out` set to the path's own Bezier handles. Use `linear` per
segment and time each segment by its length. The keys are the vertices you drew, so they're editable.

**Idles, breathing, flicker, shake:** a modulator (`wiggle`, `wave`, `pulse`), never keys. Key the
modulator's `mod.<id>.amount` to fade it in and out.

**Simulations and data:** use the tools that own them: `physics_body` for falls and collisions,
expressions (`sound()`, `lipsync()`) for sound-driven values. When a script must compute motion,
compute its POSES (contacts, apexes, turns) and key those.

## The camera rig (flat comps)

A flat comp has no camera layer yet. Build this two-group rig; never key a camera onto the world's
own transform with a formula. A group scales about the centre of its members' REST box (where they
sit without keys or expressions; app 4.22+), so a camera whose zoom pivot follows the content drifts
every time someone edits the world, and pan + zoom on one layer couple into `x = −scale × look-at`, a
product only sampling can write.

1. Build the story layers (the world). Add two invisible pins at the world's MIRRORED far corners
   (`[-X, -Y]` and `[X, Y]`, a little past the farthest content; 2×2 rects at opacity 0, named "Camera
   pivot pin"). They make the world's box centre the screen centre.
2. `layers_group {ids: [...world, ...pins], name: "World"}`, then `layers_group {ids: [<World>], name: "Camera"}`.
   The Camera group holds ONLY World, so it zooms about the screen centre for good: World's pan never
   moves Camera's pivot, keyed or driven (before 4.22 an EXPRESSION pan dragged it along).
3. **Pan** = keys (or an expression) on World's `x`/`y`: minus the world point the camera looks at, in px.
   **Zoom** = keys on Camera's `scale`. A shot is one key per track at its start and one at its end,
   same easing on all three (`cubic-bezier(0.76,0,0.24,1)`). A shot that starts inside the last one
   re-targets from where the camera is.
4. **A hit** = a jolt on Camera's OWN `x`/`y` (free: pan lives on World): kick, recoil, settle, rest —
   `[hit−1f: 0 ease-out] → [+1f: a ease-in-out] → [+4f: −0.55a] → [+8f: 0.22a] → [+13f: 0]`, `y` ≈ 0.7× with
   the opposite sign. A continuous rumble is a `wiggle` modulator on a LAYER (not a group), with
   `mod.<id>.amount` keyed (keyable from app 4.11). First modulator: `layer_patch {ops: [{op: "set",
   path: "modulators", value: [{id: "mod_rumble", target: "x", shape: "wiggle", rate: 16, amount: 0}]}]}`;
   more: `path: "modulators[-]"`.
5. **HUD** (counters, captions, titles that never move) goes above Camera in the comp. A world point
   lands on screen at `zoom × (point − lookAt) + jolt`; compute HUD hand-offs from the same keys.

A nested world (`layers_nest {fullFrame}`) works as a camera too: a transparent comp spills past its box
even under motion blur (app 4.11+). Check a camera with `view_frames` at shot ends.

Restraint still rules (motion.md › Camera restraint): push-ins of 2–6 %, reframes eased over
≥ 1.2 s, and no snap-backs or zoom punches on a logo.

## Repairing baked keys

`keyframes_simplify {id}` re-keys a layer's numeric tracks as the fewest eased keys that replay
within tolerance (0.5 px position, 0.25° rotation, 0.3 % of the range otherwise; `tolerance`
overrides). `keyframes_simplify {frameId}` fixes every baked track in a comp. Use it to repair an
import or an old build. For new work, write poses in the first place: simplify keeps the timing,
not the intent.

## Check

- `keyframes_inspect {}`: zero baked tracks, or a reason for each one.
- `view_frames` on the contacts, the apexes and every camera hand-over, not on even spacing.
- Open one hop and one shot with `keyframes_inspect {id}`. Someone else should be able to read
  them as a list of decisions.
