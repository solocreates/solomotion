# Lip sync

A mouth talks through ONE thing: the **Lip sync behavior** on its viseme pose set. The behavior hears a voice (`voice` = a layer name, or empty = whichever voice plays — in the comp, or through a component instance's `Voice` input) and answers the shape at each instant through the clip's own trim, speed, loop and reverse. Move, trim, retime or swap the voice and the mouth follows; there is nothing to regenerate. 2D drawings (a switch), shape keys and bones all talk this way, because each is a viseme pose set.

## Make it talk

```
character_bringToLife {id}                     → finds the Mouth (a switch, or a 3D face's shape keys), makes its viseme set and the Lip sync behavior
generate_speech {text, voice: "test", place}   → offline Test Voice: audio + EXACT mouth (presets test, test:bright, test:robo)
speech_bind {target, voice?}                   → point a mouth at one voice (no voice = every voice); adds the behavior if missing, a bare switch becomes a set
speech_bind {target, off: true}                → silence it (the behavior switches off; its Mouth map is kept)
```

- The behavior's other fields are the Mouth map: `as.<VISEME>` re-points a shape to any pose, `rest` (In pauses), `lead` (ms) — edit them with `behaviors_update`. Never put a `lipsync()` expression on the mouth channel yourself: that is a second driver.
- A 3D face talks once it has its sets (`world_import_model`, or `world_face` on a `world_add {kind: "head"}`): its Mouth set gets the behavior, hearing every voice.

- A mouth needs no special names: members/poses named `Rest MBP AI E O U FV L S` (or Rhubarb letters, Preston Blair, Character Animator names) all resolve; a missing shape shows its nearest one (no U → O). A three-drawing mouth still talks.
- Nothing to analyse first: the first frame that reads a voice queues its analysis; the mouth rests until it lands (seconds), then moves. Call `speech_analyze` to wait for it, to pick an engine, or with `force` to re-hear.
- No speech connection? `generate_speech` uses the Test Voice automatically.

## How it is heard (Auto)

1. A Test Voice line — exact.
2. Timed words: a TTS that returned its timing (ElevenLabs), a known script (`speech_analyze {id, text}` — always give it when you know the words; alignment ≈ 96% vs listening ≈ 37%), a transcription.
3. A routed word-timed transcription connection (paid once per recording, cached).
4. Listen (`spectral`, offline).

Settings live on the RECORDING (every clip of it shares them): `speech_analyze {id, engine?, text?, feel?, energy?}`. Feel: `natural` (default) · `snappy` (comedy, rap) · `relaxed` (narration) · `mumble` (background) · `shout`. Energy 1 = as heard. Lead, holds, closures and gap bridging are automatic and depend on the mouth's kind (drawings swap, shape keys morph, bones move) — don't fake them with keys.

## Voice functions (for anything that is not the mouth)

- `lipsync("Voice")` → the viseme at the instant (`X` in pauses), for a caption, a speaker light, a second prop.
- `speaking("Voice")` → 1 while words are said, 0 in pauses (breaths don't count): `if(speaking("Voice") > 0, "Talk", "Idle")`.
- `loudness("Voice")` → 0..1 smoothed: a jaw (`map(loudness("Voice"), 0, 1, 0, 18)` on a jaw bone's rotation), a nod, a `key.jawOpen` weight, a glow.

## Check and fix

```
speech_inspect {id: voiceLayer, fromMs?, toMs?}   → engine, status, words, cues (source ms + compMs), fixes, boundMouths (every mouth that hears it)
speech_fix {id: voiceLayer, startMs, endMs, viseme}  → a hand fix in comp ms; stored in the recording's time, survives moves and re-analysis
speech_fix {id, startMs, clear: true}             → back to computed
speech_bake {target, voice?}                      → hold keys on `pose.<set>`, the behavior switched off (moving the voice won't re-sync after)
```

Look with `view_frames` at a few word peaks rather than every frame. Bake only when the user wants to hand-key in the dope sheet — fixes keep it live.
