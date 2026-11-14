# Sound

## Audio layers

Audio clips come from media (`media_import`, `layer_create {kind:"media", assetId}`) or generation (`generate_speech`). Each has gain, fades (`fadeIn`/`fadeOut`), playback speed, `audioMix.volume` (keyable) and an audio effect chain (`effects_add {domain:"audio"}`: eq, reverb, echo, compressor, saturator, filter, chorus, phaser, tremolo, ringMod, bitcrush, stereo). Order is the signal chain. Start from a card's presets (`catalog_get` lists them): filter `muffled`/`telephone`/`wah`/`wobble`, chorus `flanger`/`vibrato`, ringMod `robot`, bitcrush `8bit`/`radio`, tremolo `autopan`. Every numeric field keys at `afx.<id>.<field>` and exports exactly as it previews — a filter build is two keys on `afx.<id>.cutoffHz`. Filter and phaser carry their own LFO (`lfoRateHz`, `lfoDepth` in octaves, `lfoShape`); it stays in step with the clip's time in preview and export.

- Voice: gentle high-pass (EQ low cut ~90 Hz); the category's speech leveler does the rest.
- Fades: 20–50ms on every cut to avoid clicks; 1–3s fades for music in/out.

## The mix — categories, leveler, ducking (do this, don't hand-ride volumes)

Every sound routes into a CATEGORY (a bus): `voice` (Dialogue), `music`, `sfx` (Effects), `ambience`, or a custom one. Route with `layer_patch {id, ops:[{op:"set", path:"soundBus", value:"music"}]}` — on a nested clip it routes everything inside (the most specific tag wins). Untagged fired sounds (typing, pops, whooshes on the sounds stack) are Effects automatically; untagged media goes to the master, so TAG EVERY MEDIA CLIP. Imports named like "vo", "music", "whoosh" are tagged for you.

- `sound_category` lists, creates, tunes (fader `volume`, `character`, `targetLufs`, `muted`/`solo`) and deletes categories, and sets a category's `ducking`.
- **Ducking is a rule, not keyframes**: music ducking under voice is `sound_category {action:"update", id:"music", ducking:[{under:{kind:"bus", id:"voice"}, depthDb:10}]}` (new projects already have it). A single clip can duck under a category, a layer, or a whole nested scene: `layer_patch` path `ducking`. It looks ahead, so music is already down when the first word lands.
- **The leveler** lives on each comp: `frame_update {ops:[{op:"set", path:"soundMix.leveler.enabled", value:true}]}` (also `mode` "category"|"all", `strength` 0–1, `tameLoud`, `liftQuiet`, `evenSpeech`), plus `soundMix.limiter` (`ceilingDb`, default −1) and `soundMix.volume`. It measures every sound (speech/music by average loudness, effects by their loudest moment, rapid-fire typing as texture 7 dB under one-shots) and trims each one; it governs the whole tree of the comp you export, at any depth. Leave it ON for anything with more than a couple of sounds — it is what keeps effects from blasting.
- Balance between categories with the category faders, not by rewriting every clip's gain.

## Sounds on animation (the sounds stack)

Any layer can fire sounds from its own animation — this is how motion design gets its clicks, pops and whooshes, perfectly synced and re-synced when timing changes. A layer's `sounds` is a list of voices (`api_describe sound`):

```json
{ "pack": "pop", "volume": 0.3, "pitch": 1.05, "randomness": 0.55,
  "phase": "in", "trigger": { "kind": "text" }, "anchor": "start", "offsetMs": 0, "enabled": true }
```

- `trigger.kind`: `text` — every animating unit (letter/word/line) of a text animation; `layer` — the layer's own in/out animation (`animation_set`; keyframes are not one, and a `layer` sound on a layer with none never fires — `layer_patch` says `Silent: …`, and `export_render` lists it under `silentSounds`; for a sound at a keyed moment, place it as an audio layer at that time); `transition` — the cut transition at its edge; `hit` (`{kind: "hit", minSpeed: 60}`) — every time this physics BODY starts touching something, louder the harder it hits, silent below `minSpeed` units/s (flat comps; see `references/physics.md`).
- `phase`: `in` or `out`. `anchor`: start · peak · end of each unit's motion.
- `pack`: synthesized packs — `pop` (soft, bubbly; best general choice), `mechanical` and `thock` (keyboards/typewriters), `soft`, `vintage`, `digital`; tuned on C for notes: `marimba`, `kalimba`, `glass` (long ring), `pluck`, `wood` (temple block). Or `custom: {assetId, hitMs}` for any other sound. `sounds_list {query}` searches the packs, the project, this device and the online library (hundreds of CC0 sounds — search by what you hear: `click`, `whoosh`, `paper`, `chime`); `sounds_use {id}` makes a non-pack result playable here and returns the exact value to put in `sounds`.
- `randomness` varies pitch and timing per hit so repeats do not sound stamped (0.4–0.6). `pitch` 0.5–2.

Set with `layer_patch` (`set` or `insert` into `sounds`).

### Sets, notes and the climax

One repeated tone is the weakest sound a stream of hits can make. A voice can play **notes** instead: `notes: {scale, order, span}` — `scale` pentatonic · minorPentatonic · major · minor · wholeTone · fifths; `span` how many scale steps (pentatonic 5 = an octave); `order`:
- `rise` / `bounce` — walk the scale in the order things fire, counted across EVERY layer sharing the same sound (asset or pack + scale): a ring of balls plays one melody. On text, letter by letter.
- `body` — each body (letter) keeps its own note: the per-ball scale, no hand-set pitches.
- `strength` — harder hits higher. `random` — seeded, repeats every play.
`pitch` transposes the whole scale; `custom` samples take notes too (a marimba sample walks the scale by playback rate).

**Sets** are ready-made `{pack, custom, notes}`: `catalog_list sound-sets` (marimba-climb, marimba-balls, kalimba-drops, glass-bells, pluck-run, bubble-pops, wood-knocks, thock-impacts) — spread its `voice` into the entry.

**`intensity`** 0..1 on every entry is the climax dial, keyable at `snd.<entryId>.intensity` (`layer_properties` lists it). Rising, it lifts the notes an octave (a lone tone a fifth), adds up to 30% level and brightness, and past 0.5 a heavy low hit joins under each firing. 0 = the voice as tuned. "Climax at 16 s" = `keyframes_set` 0 at the build's start, 1 at 16 s. On a `hit` trigger, `rise: "hits"` makes it climb on its own with how busy the scene is (hit rate of everything sharing the sound, the comp's busiest moment = 1); keys then act as a floor.

### Recorded kits and a climax of weight (v105)

A synth pack pushed up two octaves is a test tone; real instruments sound real. Prefer a **kit**: `kit: {takes: [{assetId, hitMs, root, layer}]}` — imported recordings played in turn (round-robin: every take once per cycle, never the same twice in a row). `root` is the note the recording sounds, semitones from C (D = 2, A = -3): with `notes`, each take is retuned from its root to the scale note, so one handpan or kalimba recording plays the scale. `layer` `soft` / `hard` / `any` gives velocity layers (soft hits pick soft takes). A kit wins over `custom` and `pack`; its bodies are one ensemble and one levelled stream.
`climb: "weight"` keeps the register while the climax builds: notes damp shorter so a dense roll stays clear, a low weight joins past halfway, level rises, and body hits sit left–right where they struck (the field widens with the build). `climb: "pitch"` (default) is the older lift. With `notes`, `randomness` now humanises by cents (±12) and ±1.5 dB, never a different pitch.
Recipe — a ring of balls that sounds real: import one clean note of a warm instrument (handpan, kalimba, felt marimba) via `media_import`, then on every ball `{kit: {takes: [{assetId, hitMs, root}]}, notes: {scale: "minor", order: "body", span: 8}, climb: "weight", pitch: 2**(-10/12), randomness: 0.5, trigger: {kind: "hit", minSpeed: 140, rise: "hits"}}` — a D-minor field per ball, D3–D4, building by weight to the boom. Keep chimes, glitter and high sparkle out unless asked.

Streams are handled for you: at most 2 firings of one shared sound start per 45 ms (the hardest), and the leveler hears them as one stream — don't thin bodies or drop volumes to fight a dense ring; keep `volume` ~0.3.

Taste:

- Per **word** or per **element**, rarely per letter (letters only for typewriters, with `mechanical`/`thock` at low volume).
- Volume 0.15–0.35 for UI sounds under music; per-letter/per-word typing 0.15–0.3 with `randomness` 0.5–0.6. The loudest thing should be the voice. Never above 0.5 for a stream of hits — twenty hits a second at a one-shot's level is what makes typing sounds annoying.
- `mechanical` is the default typing voice and is tuned soft; for a harder keyboard use `thock` low, never crank `mechanical`.
- One sound family per piece. Lower pitch for heavier elements, higher for small ones.
- Silence is a tool — not every motion needs a sound.

## Making things react to sound

Every audio layer (and every video with sound) is analysed once — level, bands, brightness, hits, beat, tempo — and anything can read it live. Nothing is keyed, so retiming or trimming the music keeps everything in sync.

- **Expression:** `sound("Music", "bass")` is 0–1 at this instant. Features: `level` (default), `sub`, `bass`, `lowMid`, `mid`, `highMid`, `treble`, `brightness`, `onset` (hits), `beat` (1 on each beat, falls away). `soundBand("Music", 40, 90)` for any Hz range, `soundTempo("Music")` for BPM. An optional last argument shifts in ms: `sound("Music", "beat", -40)` lands motion just ahead of the hit.
- Shape it with the usual functions: `scale = 1 + 0.25 * sound("Music", "bass")`, `opacity = map(sound("Music"), 0.2, 0.9, 0, 1)`. `beat` and `onset` are already pulses — don't smooth them; `level` and the bands are smooth enough to drive size and light directly.
- **Nodes:** the Sound node (category Sound) outputs every feature at once — pick its Layer (or wire a Layer hub) and wire outputs into any property.
- **Visualizer:** a `waveform` layer reads the same analysis: `layer_create {kind: "waveform", target: "Music", waveform: {template, color, width, height…}}` spans its sound and moves with it.
- **Cutting to music:** `audio_analyze {id}` returns `tempo`, `compBeats` and `compOnsets` in comp time — split, cut and place hits there. Use expressions, not keys at those times, for anything that should keep reacting.
- Values are the sound's own, before the clip's volume, and read 0 until the analysis lands (a second or two for a song; export waits for it).

## Synced sound design from a library or folder

- Put each sound WHERE its cause is: a whoosh for a layer's entrance goes on that layer's `sounds` stack (`custom: {assetId, hitMs}`) or, as a clip, inside the same group / nested scene as the thing it belongs to, starting at the motion's peak — so moving the scene moves its sound. Never a pile of loose SFX lanes at the root.
- `hitMs` is the file's transient: align it, not the file start, to the frame of impact.
- Whooshes lead the cut by their rise (peak ON the cut); impacts land on the frame of contact; risers end on the downbeat.
- After placing sound, check the mix at the loudest moments (`view_frames` with the mixer, or just trust the leveler + limiter) — do not guess gains per clip.

## Voiceover

`generate_speech {text, voice, style, place}` writes a voice to the Media library (and the timeline). `voices_list {query: "warm british narrator"}` finds a voice that fits the brief; `style` directs the read ("warm, unhurried", "whispers", "excited") — Eleven v3, GPT and Gemini voices follow it. Write for the ear: short sentences, commas where a breath goes, numbers written as spoken. Then caption it (`media_transcribe {captions}`) and time visuals to the words.

**Never split one take to make a pause.** Word timestamps are approximate: consonants ("sh", "s", "f") start before the stamp, so a cut there leaves half a word on each side and the listener hears the seam. Generate each phrase that needs its own timing as its own clip (with the neighbouring lines as context so the read flows), and place clips whole. If a cut is truly unavoidable, cut inside a measured silence (20 ms RMS below −45 dBFS for at least 80 ms), never at a timestamp, and check the waveform at the seam. A clip that starts on a consonant at sample 0 gets silence padded in front, not a fade.

## Making and fixing sound with AI

- **Sound effects**: `generate_sound {prompt, durationS, loop}` — describe it physically: source, material, size, distance, room, attack and tail ("a soft felt thump, close, short dry tail"; "airy whoosh left to right, 0.6s"). Use the synth packs first for UI clicks and pops — they sync to animation for free — then the online library (`sounds_list {query}`), and generate only what neither has.
- **Music**: `generate_music {prompt, durationS, instrumental}` — genre, mood, tempo (bpm), instruments, structure ("builds from 0:10, hits at 0:20, clean ending"). Instrumental under voice. Cut it to the edit, duck it under speech. If it fails because no music provider is connected, compose offline (the user's tools, or a simple score you synthesise) and bring the stems in with `media_import`; never stall the film on it.
- **A noisy voice**: `audio_isolate {id}` keeps the speech and removes room, hum and music. On an audio layer it updates in place; on a video it adds a clean, linked voice layer and mutes the video's own sound.
