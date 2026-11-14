# @solomotion/lipsync

The headless speech foundation: audio, text or timed words in → timed
**viseme cues** out, through lazy, swappable engines. Zero dependencies, zero
DOM; runs in a test, a worker or the exporter.

```
pcm ──────────── spectral  (analyze)  ─┐
text|words|AI ── align     (align)    ─┼─▶ SpeechTrack { cues, energy, words?, phonemes? }
text ─────────── test-voice(synthesize)┘        │  (+ pcm for synthesize)
                                                ▼
                         shapeCues(cues, { profile, fps, loudness, energy, edits })   ← read time
                                                ▼
                                    lipsync() / mouth / ARKit weights
```

## Entries

| import | what | weight |
| --- | --- | --- |
| `@solomotion/lipsync` | visemes, ARPAbet phonemes, alphabets, engine registry, cue passes, feel pass, envelope, harness, AI bridge | tables only |
| `@solomotion/lipsync/spectral` | offline DSP analyzer | lazy |
| `@solomotion/lipsync/g2p` | English G2P (dictionary + morphology + NRL rules, numbers, acronyms) | lazy |
| `@solomotion/lipsync/align` | words / phonemes with times → cues | lazy |
| `@solomotion/lipsync/voice` | the Test Voice formant synthesizer, `toWav` | lazy |

Engines register metadata at import; `load()` dynamic-imports the heavy part
once. A test walks the root's static import graph to keep it that way.

```ts
import { runSpeechEngine, speechCacheKey, speechEngine, shapeCues } from "@solomotion/lipsync";

const track = await runSpeechEngine("spectral", { pcm: { samples, sampleRate } });
const key = speechCacheKey(assetId, speechEngine("spectral")!, settings); // asset+id+version+settings
const cues = shapeCues(track.cues, { profile: "drawings", fps: 24, loudness: track.energy });
```

Built-in engines: `spectral` (analyze, can't hear L), `align` (needs text or
timed words or phonemes; pcm optional), `test-voice` (synthesize; presets
`warm`, `bright`, `robo`; same text+preset+seed → identical samples).

**Any AI model** plugs in with `registerRemoteSpeechEngine({ id, version,
label, request })` — `request` returns a `RemoteSpeechResult`: timed words,
timed phonemes (ARPAbet or IPA), a viseme stream in any registered alphabet, or
character timing (`fromElevenLabsAlignment`, `fromSecondsWords` adapt common
APIs). Everything after the network call is the align engine.

## Visemes, phonemes, alphabets

Nine canonical mouths: `X` rest · `MBP` · `S` (teeth together, also most
consonants) · `E` · `AI` · `O` · `U` (and W) · `FV` · `L` (and TH). Every
ARPAbet phoneme maps to one (`PHONEMES[p].viseme`; diphthongs glide into a
second, H takes the next vowel's mouth). Alphabet tables (`toAlphabet`,
`fromAlphabet`): `rhubarb` (A–H, X), `preston-blair` (10), `disney-12`,
`oculus` (15) — total over the nine, finer when phonemes are known — and
`ARKIT_VISEME_WEIGHTS` for 3D shape-key faces.

## Feel (`shapeCues`)

Gate non-speech, bridge silences < 150 ms, round S/E/L before U/O, priority
merge under min hold (closures borrow time, never vanish), voice-time edits,
energy knob → `cue.intensity`, lead, frame grid. Profiles: drawings (lead 60,
hold 2 frames, cut), morph (90, 50 ms, blend 80), bones (110, 70 ms, blend 100).

## Measured (Test Voice ground truth, `evaluateCues`)

| engine | exact | ±40 ms | speaking recall / precision |
| --- | --- | --- | --- |
| spectral | 36.6% | 43.0% | 0.90 / 0.996 |
| align (word times) | 95.6% | — | — |

The feel pass cuts spectral's changes/s 5.5 → 3.9 (drawings) and lifts ±40 ms
accuracy to 0.48–0.50. G2P: 90.4% exact CMUdict match on a 52-word list.

## Drawing a mouth pack (the brief to hand an artist or an AI)

> Draw **nine mouth shapes**, one per viseme. Same face, scale and centre —
> only the mouth changes. Transparent background. Name each by its id:
>
> | id | shape |
> | -- | ----- |
> | `X`   | rest, lips together, relaxed |
> | `MBP` | lips pressed shut (m, b, p) |
> | `S`   | teeth nearly together, lips apart (s, t, d, n, k) |
> | `E`   | wide, slightly open, teeth showing (ee, eh) |
> | `AI`  | jaw open, relaxed (ah, eye) |
> | `O`   | rounded oval (oh, aw) |
> | `U`   | small tight round, lips forward (oo, w) |
> | `FV`  | top teeth on the lower lip (f, v) |
> | `L`   | open, tongue tip up behind the top teeth (l, th) |
>
> Only three? Make `X`, `AI` and `MBP` — the rest fall back automatically
> (`VISEME_FALLBACKS`). For a 3D head, key ARKit blendshapes instead; the
> weights per viseme are `ARKIT_VISEME_WEIGHTS`.

Names from other tools are understood (`fromAlphabet`, case- and
punctuation-insensitive): Rhubarb letters, Preston Blair / Papagayo (`WQ`,
`etc`, `rest`), Oculus (`PP`, `aa`, `ou`…).
