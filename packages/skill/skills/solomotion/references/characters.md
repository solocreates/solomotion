# Characters: from art to a talking character

The fastest path is two calls. Everything they build is ordinary rig, pose-set, expression and modulator data — `references/rigging.md` and `references/poses.md` cover editing it afterwards.

## 1. Read the art

```
character_detect {id: groupOrInstanceId}
  → {figure: "face"|"body", parts: [{role, id, name, confidence, reason, shapes?}], life}
```

- Pass the character's GROUP (rig or not) or a component INSTANCE.
- Roles: `head face hair brow.L/R eye.L/R lid.L/R pupil.L/R nose mouth neck torso hips arm/forearm/hand.L/R leg/shin/foot.L/R accessory`.
- `.L` is the CHARACTER's left — the screen's right on a figure facing you. A side in a layer's name always wins.
- It reads names in many languages and conventions (`Eye_L copy 2`, `left eye`, `ojo izquierdo`, `左目`, `eyeL`), the lip-sync viseme tag, switches whose members are visemes (canonical, Rhubarb `A–H X`, Character Animator, Preston Blair), eye states or hand poses, and the layout as a tiebreaker (a mirrored pair high in the head = eyes, a pair inside them = pupils, a centred piece below = mouth).
- Low confidence or a wrong role: pass `overrides: {"mouth": layerId, "eye.R": null}` to either verb.

## 2. Bring it to life

```
character_bringToLife {id, dryRun: true}   → {life, voice, parts, steps, script}   (changes nothing)
character_bringToLife {id}                  → one undo step
```

What it makes, from what it found:

| Behavior | Default | What it is |
|---|---|---|
| Talk | on when a voice exists | Mouth pose set (visemes) + a Lip sync behavior hearing every voice; an instance gets a `Voice` input set on the instance |
| Blink | on | Eyes pose set (Open/Closed — the eye switch's drawings, a lid's opacity, or the eye squashed) driven by ONE `blink(4)` expression: both eyes shut together |
| Breathe | on | Two seeded wave modulators on the torso (or the whole character): scaleY +1.2 % about its bottom edge, 3.6 s |
| Nod | on with a voice | the head group (or a face-only character) turns 1.5° with `loudness()` |
| Look | off | Pupil pads (`Pupil.L/R`, limited to the eye) that look at `Look.L/R` under one `Look` control — drag `Look`, or Perform |

- Brows and hands that are switches of known poses get their own pose sets too.
- `true`/`false` per behavior turns it on/off (the Life toggles are this verb). `voice: clipId` picks the voice; `null` none.
- Running it again plans nothing; `life` in `character_detect` says what is on and, when something cannot be, why (`No eyes found`, `Group the head with its face to nod`).
- `dryRun`'s `script` is the same calls as `ac.*` lines — run it in a script to get the identical result, or edit it first.

## When the art is one picture

Detection needs separate layers. For a flat picture, give it a mouth first (a starter mouth set placed on the face, `switch_create {component}`), put both in a group, then bring it to life.

## Check

`view_frames` across a few seconds: the eyes shut together about every 4 s, the mouth changes with the voice. `poses_inspect {groupId, atMs}` names the pose showing at a moment.

## After bringing it to life

Its life is a stack of **behaviors** (lip sync, blink, glance, breathe, sway,
nod, cycle, machine) — read `behaviors.md`. Every block on its timeline lanes
is editable like a clip (`poses_block`). Right-click it in the app for its
menu: pose sets, behaviors, rig, parts.

## Parts stay attached (hand-built characters)

A limb, ear or tail you key yourself turns about its **pivot**, and a new path or
shape's pivot is the middle of its box, not the joint. Key `rotation` on an arm
left there and it swings round its own centre and drifts off the body: loose
lines floating in space, the first thing viewers call AI slop.

- Before the first rotation key on any part, `layer_pivot {ids, anchor}` at its
  joint: the end that meets the body (an arm reaching up-right from the right
  shoulder: `bottom-left`). `layer_pivot` keeps the picture still; writing
  `anchor` with `layer.set` moves it.
- Draw the part so its joint end starts INSIDE the body (stacked under it), so a
  turn never opens a gap.
- Check it at the size it plays: `view_frames {detail: "inspect"}` at every pose
  key of that part (and on the stressed words), looking only for parts that do
  not touch the body. A contact sheet where the character is 60 px tall hides it.

## Any character, any part

Nothing is fixed to faces. Introduce a part by saying which layer it is:
group the tail's art, `rig_create`/`rig_bone` through it if it bends, then
`poses_create {groupId, fromLayer: tailId}` and capture its states
(`poses_add capture:true`). Drawn alternatives (hands, ears up/down) are a
switch: `switch_create`, then `poses_create {fromSwitch}`. A behavior can drive
any set (`behaviors_add {type:"cycle", set:"Tail", steps:[…]}` wags it).


## Build a character once; a still needs only what it shows

- **A character that appears in several comps** (a host in a reel, its long cut and the covers) is built ONCE, as a
  component, and placed as instances. Its poses and expressions are pose sets driven through the instance (inputs,
  `poses_key` on the instance's comp clock). Rebuilding the full rig in every comp multiplies layers, build time and
  memory, and every later fix has to be made N times.
- **A still** (thumbnail, cover, poster) shows one expression and one gesture. Do not build the rig for it: place an
  instance and pick its poses, or draw only the parts that show (one eye state, one mouth, one arm pose, the emotes in
  frame) as plain groups. No switches, no viseme mouths, no lip sync. In practice that is ~30 layers instead of ~250.
