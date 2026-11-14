# Physics: bodies, forces, particles, joints and rigs

Any layer can fall, collide, tumble, be blown and be held — in a flat comp and in a 3D world alike, with the same verbs. The simulation is **exact per frame**: it re-runs only when what it starts from changes, and any frame reads the same result whether scrubbed, looped or exported. There is no baking.

## The model

- A **body** is a layer with physics: `active` (falls, collides, tumbles), `passive` (a fixed collider — a floor, a shelf, a ramp), `animated` (moves by its own keys and pushes whatever is in the way — a hand shoving blocks, a paddle).
- A **group is ONE body** of everything in it (a word made of letter layers falls as one word; give each letter a body to have them scatter).
- A body **collides on what it is**: a rectangle as a box, a circle as a circle, a star, a path or a WORD on its real outline (cut into convex pieces), a picture on its silhouette (a sticker lands on its edge), a mesh as its box or a sphere when round. `shape` overrides: `box`, `sphere`, `hull` (no dents, fastest), `outline` (exact), `edge` (the LINE as a wall, as thick as its stroke — not the fill).
- **Inside a shape needs `edge`.** A closed shape is SOLID by default: a ball placed inside a passive circle is thrown out. Give the container `shape: "edge"` and things bounce around INSIDE it. An open path (a line drawn with the pen) is already its edge on `auto` — a ramp, a deflector, a funnel wall.
- **Forces** are a STACK any layer carries, like its effects: wind, point (attract; negative repels), vortex, turbulence, drag, **gravity** (a real inverse-square well: orbits, a horizon, spin — see Space below) — any number, repeats welcome (two winds at different angles, a vortex inside a drag). Usually on a new null from `physics_force`, but a fan image can BE the wind. Placed by its layer: a wind blows along the layer's +X (rotate the layer to aim it: 90° blows down a flat comp), a vortex swirls about it, a point pulls toward it. Forces add up, so stack order never changes the result.
- **Particles** are a STACK any layer carries too (`emitters`): a `stream` flows while its layer is on, a `burst` throws `count` at once as its layer starts (move its clip to time the pop), a `hit` throws a burst off every contact — on a body, ITS contacts; on a null, every body's in the comp — out of the surface they hit, more and faster the harder the hit, and a `sub` (sub-emitter) throws `count` from each particle of ANOTHER card in the same stack as it dies (`on: "death"`) or hits (`on: "hit"`) — a firework shell's burst, a raindrop's splash. They live in the same simulation: they fall with gravity × `weight` (0 floats, negative rises — smoke), feel every force, and bounce off every body, `edge` ring, wall and floor — swept, so fast sparks never slip through a line. One way: particles never push a body. Flat comps only.
- **A body lives on the timeline**: it enters the simulation at its clip's start (where its keys put it then) and leaves at its end. Two clips at different times never touch; when a shelf's clip ends, what rested on it falls. Hidden (eye off) is not in the simulation — an invisible collider is a body at opacity 0.
- **Joints** hold a body to another body or to the comp: `pin` (swings — a pendulum, a hanging sign, a door), `weld` (one piece), `rope` (slack until taut), `spring` (pulls back and bounces).
- The **comp** holds the settings: gravity (981 = Earth, 0 floats), when physics starts, a floor (a flat comp's bottom edge; a world's ground), walls (a flat comp's other edges), time scale (slow motion), and `guard` — on, a fast small body is substepped so it can never skip through a wall between two steps. New comps have it on; comps made before v106 have it OFF (their saved runs replay exactly): **turn it on (`physics_scene {guard: true}`) before building balls in an old comp.**

Units: 1 = 1 px = 1 cm. A flat comp's +y is DOWN; a world's Z is up.

## Verbs

```
physics_scene  {frameId?, gravity?, startMs?, floor?, floorAt?, walls?, timeScale?}
physics_body   {ids, type: "active"|"passive"|"animated"|null, shape?, mass?, bounce?, friction?, velocity?, spin?, damping?, follow?}
physics_force  {type: wind|vortex|point|turbulence|drag|gravity, strength?, radius?, falloff?, scale?, seed?, mass?, horizon?, spin?, core?, position?, rotation?, name?}   → {layerId, forceId}  (a new null)
physics_force  {id: layer, type, …}   (add a force to any layer's stack; call again to stack another)
physics_emit   {look?: sparks|fountain|smoke|rain|snow|confetti|firework|shell|trail|impact|dust|accretion|infall|wind|supernova, type?: stream|burst|hit|sub, position?, rotation?, …any field}   → {layerId, emitterId, emitterIds?}  (a new null placed for the look; a look of several cards returns them all)
physics_emit   {id: layer, look?: peony|crackle|splash | type: "sub", parent?: emitterId, on?: death|hit, inherit?}   (a sub-emitter on a layer's existing particles — omit parent for the card above)
physics_emit   {id: layer, …}   (particles from any layer's stack — `source: "outline"` sheds them along its edge)
effects_update {id: layer, effectId: forceId|emitterId, values?, enabled?, index?, remove?}   (change, mute, reorder, remove a card)
physics_joint  {id: body, add: [{type, target?, anchor?, targetAnchor?, length?, stiffness?, damping?}], edit?, remove?}
physics_inspect {frameId?, atMs}   → every body where it is then (a rigged piece: which bone it swings on), each rig's swinging bones, forces, joints, settings
```

- **Before the start** (`startMs`) bodies sit where their keys put them; from the start the simulation owns them. **A body keyed moving at the start keeps that motion** — key a throw over the first frames, start physics at the end of it, and it flies on. Add `velocity` (units/s) and `spin` (deg/s; a flat comp reads z, + clockwise) for a push.
- **Force strength** is an acceleration (gravity is 981): wind 300–800 is a breeze to a gale; attract 300–1500 pulls things into orbit; drag is % of speed lost per second. `radius` limits the reach (0 = everywhere), `falloff` fades it. Each card's numbers KEY at `force.<forceId>.<field>`: a gust is two keys on `force.<id>.strength` (`keyframes_set`), and a card switches on with `force.<id>.enabled`. `catalog_get forces <type>` lists a kind's fields.
- **`follow`** (0..1) pulls an active body back toward its own animation: keep its keys and add 0.1–0.3 for jiggle and overshoot (a bouncy badge, a wobbling sign), 0.8+ for a firm hold that only sags.
- A force or a body's ONE number changes the whole simulation from its start: edits re-simulate (fast for dozens of bodies).

## Space: gravity wells, orbits, horizons

`physics_force {type: "gravity"}` is REAL gravity — inverse square, so things orbit, slingshot and fall in, unlike `point` (a constant pull: a spring, nothing orbits). Space has no Earth: **`physics_scene {gravity: 0, floor: false}` first.**

- `mass` is the well's pull 100 units out (units/s²; GM = mass × 10⁴). The speed that holds a circle of radius r is **√(mass × 10⁴ / r)** — mass 8000 holds r = 200 at 632 units/s (a turn every 2 s), r = 400 at 447 (5.6 s). Key `force.<id>.mass` to make it grow.
- `horizon` (units, 0 = none): a particle that crosses it is gone; a DYNAMIC body that crosses it is swallowed — out of the simulation and hidden from that instant on (its layer is untouched; it simply stops drawing). Bodies and particles alike.
- `spin` −1..1 (+ clockwise on screen): frame dragging. Space near the well turns with it, hardest at the horizon, pulling everything toward that turn — orbits faster than space lose their way and spiral in; anything going the other way is turned round near the hole. 0.3–0.7 sells a disk being eaten.
- `core` softens the centre (a close pass slingshots instead of exploding). `radius` limits the reach (0 = everywhere — real gravity).
- On canvas the well draws its horizon (a dark disc) and its reach; select the null and drag either ring.
- Several wells superpose: a binary star, a slingshot past a planet.

**Particles that know they are in orbit** — emitter fields, on any stream or burst:

| Field | Does |
|---|---|
| `source: "ring"`, `inner`, `outer` | born anywhere in an annulus about the layer (units, comp space — same units as the well's horizon) |
| `launch: "orbit"`, `orbit` −2..2 | thrown sideways at the circular speed of the strongest well there × `orbit` (1 holds the circle; under 1 dips toward the well; over √2 escapes; the sign is the way round). With no well, `speed` about the layer. |
| `launch: "inward"` / `"outward"` | toward / away from the layer's origin at `speed` (collapse, explosion shell) |
| `colorBy: "temperature"`, `hot`, `kelvin` | glows as a blackbody whose heat rises with speed: `kelvin` at `hot` units/s, ∝ speed^1.5 below (dimmer and redder as it slows). Set `hot` ≈ the INNER orbit speed √(mass × 10⁴ / inner) so the inner edge burns white and the rim is ember. `colorBy: "speed"` ramps `color` → `colorEnd` the same way. Look-only. |

Real gravity alone does not spiral: an orbit is an ellipse forever. A disk spirals in with a little `drag` (0.02–0.05) or the well's `spin`.

Looks: **`accretion`** (a disk: ring 130–360, orbit, thermal sparks — put the null ON the well), **`infall`** (gas falling in from 520–900), **`wind`** (a star's wind blowing off a ring at its radius — put it on the star), **`supernova`** (a burst shell, `sphere`, cooling blue-white → ember as drag slows it). A flat comp's disk is face-on; `tilt` (0–89°) shows it from the side, `lensing` (0–1) bends its light round the heaviest well with a horizon (two images, a 2.6 Rs shadow), `beaming` (0–1) brightens the side coming at you. All three are look-only: keying them never re-runs the sim. See recipes › Black hole.

## Rigs: physics through the bones

In a rig (`references/rigging.md`) a body acts **through its bone** — set it on the PIECE, the bone does the rest:

| Piece's body | What happens |
|---|---|
| `active` on a piece riding a bone | The bone swings from its joint — a pendulum, a clock hand let go. Everything hanging off it rides along. Chains of them are ropes, tails, ragdoll limbs. |
| `active` + `follow` 0.2–0.6 | Spring bones: it follows the bone's keyed angle and lags, overshoots and settles — hair, ears, antennae, a tail behind a keyed walk. |
| `active` under a KEYED parent | Secondary motion with no keys: swing the arm, the dangling hand trails. |
| `passive` / `animated` on a piece | A collider that moves with its bone (a keyed foot that kicks a ball). |
| The rig group `active`, or an `active` piece the rig itself carries (no bone) | The whole character falls — a ragdoll, its dynamic limbs flopping. |

- A bone's **rotation limits** (`rig_bone limits.rotation`) are its hinge's stops in a flat comp: a door that swings 0–100°, a head that nods but never spins.
- The result lands as the bone's `rotation` channel at every frame — bending art, children and export follow; IK on a chain with a swinging bone lets go.
- Art that BENDS (a drawn tail, a scarf, a rope path with a bone chain through it) falls as a chain: every bone it is made of swings, and the art bends with them.
- `physics_joint` works on a rigged piece too: it pins that piece's bone (a rope from a hand to a balloon, a pin holding a sleeve to the wall).
- In 3D bones hang by ball joints; their rotation limits are stops there too.

## Use cases — reach for these

| Want | Build |
|---|---|
| A title that falls in and settles | Letters as text/paths (one layer each, or a group per word), `physics_body active bounce 0.2`, `physics_scene walls: true`; the word lands on its real letters |
| Logo drop with a bounce | Logo layer `active bounce 0.6`, a `passive` rectangle as the shelf (or the floor), start physics at 0.3 s after a keyed fade-in |
| Sticker / emoji rain | Many image layers `active` with small random `spin` and `velocity`, `walls: true`; pictures collide on their silhouettes |
| Wind blows it away | `physics_force wind` aimed with `rotation`, `radius` for a gust zone; key `force.<id>.strength` 0 → 900 for the gust |
| Wind with gusts that vary | One carrier, `physics_force wind` then `physics_force {id: carrier, type: "turbulence", scale: 300}` — the stack adds up |
| Things orbit / get sucked in | `physics_force {type: "gravity", horizon: 40}` + `gravity: 0`; particles with `launch: "orbit"` circle it; bodies with a sideways `velocity` of √(mass×10⁴/r) orbit; a `point` force is a constant pull (nothing orbits) |
| A black hole eating a disk | `physics_force gravity {horizon: 40, spin: 0.5}` + `physics_emit {look: "accretion"}` on the same spot; a `lens` effect on a small circle above (`references/effects.md`); see recipes › Black hole |
| A star collapsing / exploding | `physics_emit {look: "infall"}` around it; `{look: "supernova"}` on a clip starting on the boom frame |
| A platform that disappears | The platform `passive`, its clip ending where it should vanish; what stands on it falls then |
| A pendulum / clock hand / swinging lamp | Two pieces, a bone from the pivot piece to the hanging one (`rig_create`), the hanging piece `active` |
| A tail, ears, a scarf that trail a keyed character | Pieces on a bone chain `active` with `follow 0.3`; keys only on the body |
| A ragdoll tumble | Cut-out character rig, the rig group `active`, limbs `active`; `walls: true` |
| A hanging sign that swings | Sign `active`, `physics_joint add [{type: "pin", anchor: [x, top]}]` to the comp; push it with `spin` |
| A bouncy label on a spring | `physics_joint add [{type: "spring", targetAnchor: [x, y], length: 0, stiffness: 40, damping: 1}]` |
| Balls bouncing inside a circle (the "satisfying" loop) | Ring: an ellipse with a stroke and no fill, `physics_body passive shape: "edge" bounce: 1 friction: 0`. Balls: small circles `active bounce: 1 friction: 0 damping: 0` with a `velocity`; `physics_scene floor: false` (gravity 981 for arcs, 0 for straight lines). Add a `hit` sound to each ball (`references/sound.md`); comet tails = a `trail` emitter per ball (below), with motion blur off on the balls once there are more than a dozen |
| Dots travelling in straight lines, ricocheting off shapes | `physics_scene gravity: 0 floor: false walls: true`; dots `active bounce: 1 friction: 0 damping: 0 velocity: [vx, vy, 0]`; obstacles `passive` — `edge` for outlines, `auto` for solids, pen lines for deflectors |
| Marble run / plinko | Pen-drawn open paths as ramps (auto = edge), passive circles as pegs, balls `active bounce: 0.4`; a `hit` sound per ball with `minSpeed: 120` so rolling stays quiet |
| Dominoes | Tall thin rectangles `active` in a row, the first with `spin`, `friction 0.6` |
| Knock things over with keyed motion | The pusher `animated` with keys; the targets `active` |
| Sparks off a grinder, a fountain, smoke | `physics_emit {look: "sparks"|"fountain"|"smoke", position, rotation}` — rotation aims (−90 = up); key `emit.<id>.rate` 0 → 120 → 0 to start and stop it |
| Confetti on the reveal | `physics_emit {look: "confetti", position: [0, 400]}`, its clip starting on the beat; a `hit` sound on the null for paper landing |
| Rain / snow over a scene | `physics_emit {look: "rain"|"snow"}` (a strip across the top); `physics_scene floor: true` and the drops land; passive bodies (a roof, an umbrella) shelter what is under them |
| A comet tail behind each ball | `physics_emit {id: ball, look: "trail", colorEnd: <ball colour>}` — an emitter on a falling body RIDES it (any emitter: sparks off a thrown torch, smoke off a falling rocket); the trail is drawn behind the ball (`behind: true`) |
| Sparks where a ball lands / dust where it thuds | `physics_emit {id: ball, look: "impact"}` (or `"dust"`) — its hits only; `physics_emit {look: "impact"}` alone is a null that sparks off EVERY hit in the comp (the satisfying ring: one call). `threshold` (units/s) keeps a settling ball quiet; `count` is a hard hit's share |
| Fireworks over a title (a show) | `physics_emit {look: "shell"}` — shells rise from a strip along the bottom (fitted to the comp's height), each bursts in its own colour and crackles: three cards (stream → Peony → Crackle). `rate` is shells per second; `hue` on the Peony card (180 = any colour) sets how far shells differ. Dark background, glow does the rest |
| One firework where something lands | `physics_emit {look: "firework", position}` on a clip starting on the beat — a sphere that crackles (`sphere: true` is what fills it; without it 360° is a ring) |
| Pops: sparks that burst again | Any stream or burst, then `physics_emit {id, look: "crackle"}` (glitter where each dies) or `look: "peony"` (each particle bursts into a sphere) — a sub throws from the card above unless `parent` names one |
| Splashes where rain lands | `physics_emit {look: "rain"}` already brings `splash` (a sub `on: "hit"`); `physics_scene floor: true` or a passive body for it to land on — a sub on hit needs its parent to `collide` |
| Text that sheds particles | `physics_emit {id: text, source: "outline", shape: "spark", weight: -0.2}` — they leave along the letters |
| Particles as any picture (emoji, logo, petals) | Make the layer, hide it, `physics_emit {…, shape: "layer", instance: <its id>, spin: 360}` |
| Slow motion | `physics_scene timeScale: 0.3` |
| In 3D | The same verbs on meshes and on 2D layers standing in a world; a world's ground is its floor; aim a camera at a falling hero with `world_track lookAt` |

## Craft

- **Give it a stage.** Bodies need something to land on: the floor, a passive shelf, walls. `walls: true` keeps everything in frame.
- **Bounce reads as material**: rubber 0.6–0.8, wood 0.2–0.3, metal 0.1, cloth 0. Friction 0.6+ stops sliding; 0 glides.
- **Stagger the drop.** Start positions at different heights give a natural cascade; identical heights land in unison and look fake.
- **Hold the end.** Let bodies settle for ~1 s before the cut; a camera push during the settle feels expensive.
- **Mass is relative**: heavy things barely move when light things hit them.
- **Sound every contact**: a body's `sounds` stack takes `trigger: {kind: "hit", minSpeed}` — one hit per contact on the exact frame, louder the harder it lands. Keep `volume` ≤ 0.3 and `randomness` ~0.3–0.5 when many bodies sound. Never hand-key a pitch per ball: give every ball the SAME set with `notes` (`references/sound.md` › Sets) — `order: "body"` for a note per ball, `"rise"` for one melody the whole ring plays.
- **Nothing leaves the ring unless the story says so.** A ball that escapes between beats is a ball that VANISHES (or flies off) on screen — the worst bug a satisfying video can have, and viewers catch it. Guard on; balls ≥ 20 px while there are only a few (a lone small ball falls fastest); spawn a split's child a full diameter from its parent, never overlapping. After building, sweep `physics_inspect` every 16 ms: ANY body outside the container before the climax fails the build — fix the scene, never trim it away. Only during a deliberate overload (the ring straining before the boom) may escapes end where they cross.
- **Balls in a ring: a melody that climbs to the explosion.** Every ball: `{...voice of catalog_list sound-sets "marimba-climb", volume: 0.3, randomness: 0.3, phase: "in", trigger: {kind: "hit", minSpeed: 80, rise: "hits"}, anchor: "start", offsetMs: 0, enabled: true}`. As the balls double the hit rate climbs, so the notes rise an octave, brighten, and gain a low thud — peaking at the busiest moment, right before the boom. For an exact peak, key `snd.<entryId>.intensity` 0 → 1 on the balls instead (or as a floor with `rise: "hits"`). End the balls' clips on the boom frame so the melody stops with them; the boom is its own sound.
- **Fast and small tunnels**: walls are as thick as the stroke and there is no sweep for BODIES — a 10 px dot at 3000 units/s can pass a 2 px line. Give edges a stroke of 6+ or keep dots under ~120 × their radius per second. (Particles are swept and never tunnel.)
- **Particles: a look first, then argue.** Start from a `look`, then change two or three fields. Counts: a few hundred alive reads rich and stays fast; past ~2000 a frame costs real time (the cap is 4000 alive per emitter). `variance` 0.3–0.6 is what makes them natural; 0 looks like a printer. A burst's pop lands on its clip's first frame — put that on the beat.
- **A new null spans its whole comp** (a force's or an emitter's) and keeps spanning it when you set the comp's length later, so keys anywhere in the comp fire. Trimming it stops the tracking. A layer you made shorter only emits while it lives: `keyframes_set` answers with a `warning` when a key lands outside its layer — `timeline_trim` it to cover them.
- **Particles ignore their layer's opacity.** Once thrown they are their own picture: a word fading in sheds sparks before it shows, and an invisible collider (opacity 0) still sparks. Fade an effect on its card — key `emit.<id>.opacity` (or `rate` to stop the flow).
- **Many bodies: trails, not blur.** Motion blur is on by default and costs a buffer and up to 16 draws per moving body per frame — 100+ blurred balls take seconds a frame to render and export. Switch it off on the balls (`layer_patch ops [{op: "merge", path: "motionBlur", value: {enabled: false}}]`) and give each a `trail` emitter: it is the streak, at a fraction of the cost.
- **Soft and glow**: `soft` 0–1 feathers a dot into a puff (smoke, dust, bokeh — smoke at 1); `glow` 0–1 adds light instead of paint with a halo (sparks 0.6, fireworks 0.75), so crossings burn white — on dark grounds. `behind: true` draws them under their layer. All look-only: no re-simulation.
- **Colour over life sells it**: sparks `color` pale yellow → `colorEnd` deep orange with `grow` 0.3; smoke grows (`grow` 3) and fades; confetti keeps its colour (`hue` 180 spreads every colour) and fades little. Recolouring never re-simulates — tune looks freely.
- **Sub-emitters: small per particle.** A sub multiplies: 160 shells' worth of Peony is fine, but `count` 20 under a 300/s stream is 6000/s and hits the 4000-alive cap (each card has its own cap; births wait for deaths). `inherit` 0.1–0.3 lets a burst drift with its shell; 1 carries it on (sparks that split). A sub's `hue` wanders per PARENT particle — one colour per shell, never confetti. Subs never loop: two naming each other throw nothing. A card is named by its look in the panel (Firework shell / Peony / Crackle) while it still is one.
- **On hit, small and short**: impact sparks read at `count` 15–30, `life` 0.4–0.7 — a hit is an instant; hundreds per hit bury the ball. Two moving bodies glance: their spray goes along the contact both ways. A hit emitter's particles are silent — the body's own `hit` sound is the impact.
- **Particle sounds**: a `hit` sound on the emitter's own layer rings for its particles, at most once per 45 ms (the hardest hit) — rain on a roof, confetti landing. `minSpeed` 150+ keeps settling particles quiet.

## Checking

- `physics_inspect` at the moments that matter (impact, settle) — positions and rotations come back.
- `view_frames` across the motion: look for bodies leaving the frame (add walls), sinking into each other (lower speed or `bounce`), or a pile that never settles (more `friction`, less `bounce`, some `damping`).
