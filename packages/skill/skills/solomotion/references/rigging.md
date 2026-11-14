# Characters: rigs, controls and switches

A **rig** is a group whose bones bend the art inside it. A **switch** is a group that shows one member at a time (an eye's states, a mouth's shapes). A **control** is a bone a person grabs (a slider, a pad, an IK target). Together they are a character. The same model works in a flat comp and in a 3D world.

## The model in five lines

- The character IS the group (`rig_create`). Its layers are the art; its transform moves art and bones together.
- Every layer in a rig **follows its bones automatically** — no bind step. A piece one bone runs through **rides** that bone whole (crisp, cheap); a piece several bones run through **bends** with automatic weights (a sleeve, a whole-body picture, a long path). `rig_bind` overrides; `rig_paint` refines weights.
- Bones live in the **rig's space**: a flat comp's px (frame centre, y down), a world's units (Z up). Head → tail; a child is joined at its parent's tip unless it names another parent.
- A bone's pose is a **change from rest**, on ordinary channels `bone.<id>.<channel>` (`rotation`, `x`, `y`, `scale` = stretch along it, `scaleY` = thickness; in a world also `z`, `rotationY` pitch, `rotationX` roll). Keys, expressions, modulators and the node board all work on them.
- A switch's choice is the discrete property `switch` (a member's name, or a number counting from the top).

## Build a character

```
rig_create {ids:[…layers], name, bones:[{head:[x,y], tail:[x,y], name}, …]}   → {rigId, bones}
rig_bone {rigId, add:[…], edit:[{bone, head?, tail?, name?, parent?, deform?, ik?, shape?, limits?, color?}], remove:[…]}
rig_pose {rigId, atMs, key:true, poses:[{bone:"Fore", rotation: 40}]}
rig_inspect {rigId, atMs}   → every bone (rest and now) and how each layer follows (rides X / bends / ignores)
```

- **Draw bones through the art they move**, joint to joint: upper arm from shoulder to elbow, forearm from elbow to wrist.
- **Or join pieces with one bone each, centre to centre**: a bone drawn from piece A into piece B makes B ride it and A what it hangs from — the clock hand turns about its face, and the face stays. A piece a bone only STARTS in rides that bone's parent (or the rig itself, under a root); a piece no bone touches rides the nearest.
- Physics on a rigged piece acts through its bone (an `active` piece swings from its joint) — `references/physics.md`, "Rigs".
- **Cut-out characters** (separate pieces per limb) ride their bones and stay crisp. **One-piece art** (a drawn body, a photo, a long path) bends. Mix freely.
- Put a **head group** (eyes, mouth, brows) in the rig as ONE group: a group that is a switch, a rig of its own, or bound `rigid` rides one bone whole.
- `rig_inspect` after building: every member should say `rides <the bone you meant>` or `bends`. Fix a wrong one with `rig_bind {ids, mode: "rigid", bone}`.

## Controls — what animators grab

A control is a bone with `deform: false` (it bends nothing), a `shape` (`circle` · `square` · `diamond` · `cross`) and usually `limits` (`[min, max]` per channel; equal ends lock it):

| Control | Spec |
|---|---|
| IK target (a hand, a foot) | `deform:false, shape:"diamond"`, then `ik:{target: that control, chain: 2}` on the forearm/shin |
| Slider (a smile, a blink amount) | `deform:false, shape:"circle", limits:{x:[0,100], y:[0,0], rotation:[0,0]}` |
| Pad (eye target, mouth shape) | `deform:false, shape:"square", limits:{x:[-50,50], y:[-50,50], rotation:[0,0]}` |
| Mover (root) | `deform:false, shape:"cross"` with the other roots as its children |
| Knee that never bends backwards | `limits:{rotation:[0,150]}` on the shin |

Limits hold everywhere — keys, drags, expressions and `rig_pose` — so a control can never be animated past its range.

**Wire a control to anything** with an expression on the target property:

```
expression_set {id: mouthSwitch, property: "switch", source: 'map(bone("Face", "Mouth", "y"), 0, 40, 0, 3)'}
expression_set {id: brow, property: "y", source: '-30 + bone("Face", "Brow", "y")'}
```

`bone(rig, bone, channel?)` reads a bone's pose by the rig's layer name and the bone's name (rotation by default).

## Switches — eyes, mouths, hands

```
switch_create {ids:[open, half, closed], name:"Eye L", show:"Open"}    → {switchId, members}
switch_create {component: mouthComponentId, frameId, x, y}              → one instance per VARIANT, named for it
switch_show {id, show:"Closed", atMs: 1200, key: true}                  → a key (a blink is two keys)
switch_show {id, off: true}                                             → a plain group again
```

- Members are chosen by **name** (any case) or **number from the top** (0). A name no member has shows the top one — a character never loses its mouth.
- **A living blink**: `expression_set {id: eyeSwitch, property: "switch", source: 'if(blink(4) > 0, "Closed", #value)'}` — shut ~120 ms at an uneven ~4 s rhythm, the odd double blink, identical on every replay. Different eyes of one character should share ONE expression id (`expressionId`) so they blink together. `1 - blink()` closes a lid bone instead (`bone.<lid>.scaleY`).
- **Mouths for lip sync**: build the mouth set as a component with variants named by sound (`X` rest, `MBP`, `AI`, `E`, `O`, `U`, `FV`, `L`, `S`), then `switch_create {component}`. Key a sound per cue with `switch_show {key: true}`.
- Put the switch in the rig: it rides the head bone as one piece.

## Worlds

The same verbs in a world: bones are in world units (Z up), `rotation` is heading, `rotationY` pitch, `rotationX` roll. Meshes bend through their vertices; a 2D layer standing in a world bends as its picture plane. `world_move_into` carries a flat rig across exactly — bones, keys and limits through the change of axes.

## Checking

- `rig_inspect` at two or three moments of a move; the tips should be where you meant.
- `view_frames` across the motion: look for a joint that creases (raise the rig's `blend`, or paint it smooth with `rig_paint {mode:"smooth"}`), a piece following the wrong bone (`rig_bind`), an elbow folding the wrong way (`ik.flip`, or a pole bone).
- A switch: `view_render` at a time on each side of a key.

## Sides, symmetry, eyes that look, limits IK respects

### Name bones with a side

The side is read from the NAME — nothing else stores it. Any convention works:
`Arm.L` `arm_r` `Leg-L` `L_hand` `LeftFoot` `ear Right` `Finger.L.001`.
Middle bones (Spine, Head, Neck, a shared `Look` control) get no side. Sided
bones draw red (L) / blue (R) unless given a colour.

### Build one side, mirror the other

1. Draw the centre (Spine → Neck → Head) and the LEFT limbs only, with their
   IK targets, poles, limits and controls (`Hand_ctrl.L`, `Knee_pole.L`).
2. `rig_symmetrize { rigId }` — every `.L` bone gets its `.R` mirror across
   the character's middle: rest, parent, limits (turn ranges flip), shape,
   IK target/pole and constraint targets mapped to the mirrors. Existing
   right bones are updated in place (keys kept). Run it again after editing
   the left side; twice is once. `from: "R"` goes the other way; `axis` sets
   the mirror line (rig-space x) if the guess (middle of the centre bones) is off.
3. Bind/check with `rig_inspect` (each bone reports its `side`).

### Mirror poses

`rig_mirror { rigId, atMs, mode: "copy" }` copies every left bone's pose to
the right (`from: "R"` reverses; `bones: [...]` limits it). `mode: "flip"`
turns the whole pose over — the walk-cycle trick: key the left contact pose,
then at the half cycle `rig_mirror` flip with `key: true`. Turns and rolls
negate, moves flip across the body, stretch keeps — never hand-negate values.

### Eyes and heads that watch (constraints)

- **Look** (pupils): give each pupil a pad first (a `deform: false` control,
  `limits: { x: [-6, 6], y: [-6, 6] }`), then
  `rig_constrain { rigId, add: [{ bone: "Pupil.L", type: "look", target: "Look" }, { bone: "Pupil.R", type: "look", target: "Look" }] }`.
  The pupil slides toward the target, held to the ellipse its pad draws
  (`radius` holds it closer). Animate where the eyes look by moving ONE
  centre `Look` control; both pupils converge correctly.
- **Track** (head, 3D eyeball): `type: "track"` turns the bone so its tail
  points at the target, the short way, inside its rotation limits (give a
  head `limits: { rotation: [-25, 25] }`).
- `influence` (0..1) keys at `bone.<boneId>.con.<constraintId>` with
  `keyframes_set` — fade the look on and off. Ids come back from
  `rig_constrain` and `rig_inspect`.
- Order: IK, then constraints parents-first — a tracked head carries the
  eyes, then the pupils look from there.
- Targets are bones of the same rig or a point `[x, y]`. To look at a LAYER,
  drive the `Look` control's x/y with an expression reading that layer.

### Limits now bind IK

Rotation limits on IK chain bones are honoured: give a knee
`limits: { rotation: [0, 150] }` and the leg never bends backwards, even when
the target is out of reach (it settles at its best reach, steady frame to
frame). Limits are on the pose DELTA from the drawn rest, not the absolute angle.

## Posing by hand, and the 3D Bone tool

- **Reach or rotate.** Dragging a bone REACHES by default (IK over the chain
  above it, 3 bones; `[` `]` change it on the canvas) — pull a hand and the arm
  bends. Rotate turns one bone (FK). Pins (right-click a bone) hold while you
  reach. The same in a world.
- **Parent without a joint**: a child whose head is not at its parent's tip
  hangs off it by a dashed line. ⌘P parents the picked bones to the last one,
  ⌘⇧P connects, ⌥P clears — in Setup.
- **Setup vs Pose**: Setup edits rest (bones and art at rest); Pose moves the
  character. In a world the toolbar's Bone tool draws bones (click, click; E
  extrudes from the tip) and G / R / S with X / Y / Z move, turn and stretch
  them, Blender's way; X-ray is on while you work on bones.
- **Right-click a character** for its menu: poses, behaviors, rig, parts.

