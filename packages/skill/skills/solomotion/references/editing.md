# Editing video like a professional

## Reading the material first

- `media_list` and `layers_list` for what exists; `media_inspect` on a video for a contact sheet of its content.
- Speech: `media_transcribe {id}` gives the words and the pauses (in comp time for a layer). This is the script you edit against.
- Sound: `audio_analyze {id}` gives loudness, every silent stretch, the tempo, beats and hits (`compSilences`, `compBeats`, `compOnsets` for a layer).

## Cutting

- **`timeline_cut_ranges {id, ranges, ripple}`** takes stretches of comp time out of a layer in one step (one undo): razor, delete, ripple. `ripple: "sync"` (default) keeps the comp in sync like an NLE's sync-lock — captions and titles after a cut slide back with their words, a music bed spanning it is shortened instead of jumping. `"lane"` closes only this layer's lane; `"none"` leaves holes for B-roll.
- **Dead air**: `media_remove_pauses {id, minGapMs: 600, padMs: 120}` hears the words and cuts every longer pause plus the dead head and tail. `dryRun: true` returns the ranges first. Leave natural pauses after a punchline or a question — raise `minGapMs` (900–1200) for a calm interview, lower it (350–450) for punchy social.
- **"Cut the bullshit"** — the editorial loop:
  1. `media_transcribe {id}`; decide what stays (the strongest lines, in an order that tells the story);
  2. from the word timings, collect the ranges that go — cut in the pauses, ~100ms after the last kept word and ~80ms before the next;
  3. `timeline_cut_ranges {id, ranges}` — one call, the comp stays in sync.
- For a single cut: `timeline_split {id, atMs}`, `layers_delete`, `timeline_close_gaps {ids}`.
- Cut on action or on a sentence boundary, never mid-word. A cut in the middle of a movement hides the join.
- Jump cuts on a talking head are fine for social; soften them with a punch-in (below) or a B-roll cover.

## J-cuts and L-cuts

The audio leads (J) or trails (L) the picture across a cut — it is what makes an edit flow. `audio_detach {id}` separates a video's own sound into a linked audio layer (the video is muted, the sound stays in sync). Then trim the sound on its own: for a J-cut, extend the incoming shot's audio to start 300–800ms before its picture (`timeline_trim` its start earlier) and let the outgoing picture run over it; for an L-cut, let the outgoing sound run past the picture cut. `audio_rejoin` puts a sound back. A separate music or voice layer just needs `timeline_move` / `timeline_trim`.

## Pacing

- Social: a new visual beat every 1.5–3s; the hook in the first 1s (the most striking line or image first, not the intro).
- Explainers: 3–6s per shot; let key visuals hold.
- Music: cut on beats (downbeats for big changes, off-beats for energy). Place cuts on the frame of the transient.

## Speed

`layer_set {values: {"playback.speed": 1.5}}` changes a clip's playback speed; key `playback.speed` for ramps (fast through the boring part, slow into the moment). Keep speech between 0.9× and 1.15× (voice keeps pitch on voice-tagged audio). Slow motion needs high-fps footage to look smooth.

## Reframing and punch-ins

- A vertical cut from horizontal footage: `frame_create {width:1080, height:1920}`, then `layer_create {kind:"comp", sourceFrameId: <original comp>}` or the media itself, scaled to cover (`scale` ≈ 1920/1080 = 1.78 for 16:9 → 9:16) and positioned on the subject; key `x` to follow the action.
- Punch-in on a talking head: key the picture's `content.scale` 1 → 1.12 at a cut point (hard, not eased) to fake a second camera; or ease `content.scale` slowly (1 → 1.05 over the shot) for a push-in.
- Crop without moving the picture: `crop.*`; move the picture inside the window: `content.x/y`.

## Transitions

Mostly hard cuts. `transition_add` for a reason: `cross-dissolve` for time passing, `dip-to-color`/`fade` for section breaks, `whip-pan`/`push` for energy between similar shots, `zoom`/`glitch-cut`/`shake-cut` for social beats. 200–500ms. One transition style per piece.

## Versions (long and short)

Build the long version first. For a short version: duplicate the comp's content into a new comp (`frame_create` + nest, or `layers_duplicate` then move), keep the hook and the peak, cut everything between to fit the target (15s, 30s, 60s), re-time music to end on a beat. Same captions and look — only the edit changes. Offer both aspect ratios when the destination is social.

## Captions and titles in an edit

Caption every social cut (most watch muted): `media_transcribe {id, captions: {maxWords: 3}}`, then style consistently. Lower thirds for names: 1.5–3s after the person starts talking, hold ≥ 3s.
