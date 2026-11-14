# Media, references and generation

## Files the user gives you

**A file on your own machine** (Claude Code, any MCP client): `media_import {localPath}`, `font_install {localPath}`, `media_inspect {localPath}` — absolute, or relative to your working folder, up to 48 MB per call. Your session's own bridge reads it and hands the editor the bytes; no local server, no CORS. It works inside `api_batch` too, but not inside a script (the bridge never sees a script's calls). Larger media: serve it over http and pass `url`. A `url` import copies the file into the project, exactly like a local one: stop the server afterwards and the media still plays and exports.

Attachments arrive as `<attachment id="att_…" name="…" type="…" size="…" />` (images also arrive as pictures you can see). The bytes stay in the chat until a tool uses the id:

| Attachment | What to do |
|---|---|
| image / video / audio to use | `media_import {attachmentId, folder?, place?}` — moves the bytes into the project once; `place` puts it on the timeline. A picture shaped like its comp (a plate, a full-frame render) lands filling it; any other lands at up to 90% of the frame, never upscaled. Attachments can also be passed straight to AI jobs (`edit`, `from`, `references`, `id`) without importing first |
| font file | `font_install {attachmentId}` → the family name to set as `fontFamily` |
| a sound effect for animation | import it, then use `custom: {assetId}` in a layer's `sounds` |
| a reference ("make it like this") | `media_inspect {attachmentId}` — a video becomes a contact sheet of frames; study it (below) |
| text, Markdown, JSON, CSV, subtitles | already inlined in the message — read it |

## Reverse-engineering a reference

When the user says "design like this", decompose before building:

1. **Layout** — grid, margins, alignment, the size relationship between elements.
2. **Type** — category (geometric sans, grotesk, serif, script), weight, case, tracking, scale ratio.
3. **Colour** — ground, accent, how much of each; gradients and their direction.
4. **Motion** (video) — what moves first, the easing character (snappy expo vs. soft), stagger, direction, durations; count frames between contact-sheet tiles to estimate timing.
5. **Texture** — grain, glow, blur, shadows.

Say in one line what you took from it, build with {{name}}'s own pieces, then compare your `view_frames` with the reference and adjust. Recreate the idea, not a copy of someone's brand.

## Making and fixing media with AI

Each job runs on whichever connection the user routed to it (Agents → Connections). A job with nothing connected fails with a hint naming who can do it — tell the user; do not work around it. Everything lands in the Media folder **"AI generated"** with its provider, model and prompt on the asset. Edits keep the original and point back at it (`parentAssetId`) — never destroy the user's media. The user sees the layer being worked on shimmer on the canvas and timeline, and can undo the whole thing in one step.

### Pictures

- **Draw**: `generate_image {prompt, aspect, count, place?}`. Prompt like an art director: subject, composition (where the empty space goes — leave room for type), light, lens, palette, medium or style, mood. Say "no text" when type will be set in {{name}}; it will be sharper, editable and on-brand. Match `aspect` to where it goes.
- **Edit**: `generate_image {prompt, edit: <image layer | asset | attachment>}` changes that picture ("remove the cup", "make it dusk", "same product on marble"). On an image LAYER the result swaps in place — transform, timing, effects and keys kept (`replace: false` to place it beside instead). Describe the change, not the whole scene again.
- **Follow references**: `references: [ids]` — a style, a product, a face to keep consistent across shots.
- **Transparency**: `transparent: true` for stickers and cut-out objects (models that cannot draw alpha get a cut-out pass when one is connected).
- **Cut out a subject**: `media_remove_background {id}` — image → PNG with alpha, video → WebM with alpha. For a flat green/white backdrop the live `chromaKey` effect is cheaper and adjustable.
- **More resolution**: `media_upscale {id, factor: 2}` — the layer keeps its size on the canvas, only sharper. Use before punching in on small footage or a low-res logo.

### Footage

- **Shoot**: `generate_video {prompt, aspect, durationS, audio?, place?}` — takes minutes; say so before starting. Prompt like a DP: subject and action, camera move (slow push-in, orbit, handheld), lens, light, mood, and the sound if the model scores it (`audio: true`). 4–8 s clips, cut together, beat one long take.
- **Animate a still**: `from: <image>` makes it the first frame — keeps a brand look or a generated product consistent.
- **Edit footage**: `edit: <video>` ("make it snow", "change the jacket to red"). A video LAYER's edit lands on the lane above, aligned in time, so it can be compared, masked or cross-faded. Short clips edit best.

### Voice, sound, music, words

- `generate_speech {text, voice?, style?}` · `voices_list {query}` — see sound.md.
- `generate_sound {prompt, durationS}` · `generate_music {prompt, durationS, instrumental}` — see sound.md.
- `audio_isolate {id}` — clean up a noisy voice.
- `media_transcribe {id}` — words, pauses, captions; `lyrics` aligns known text. `media_remove_pauses {id}` tightens speech. See editing.md and type-and-captions.md.

### Cost and patience

Video and music take minutes and cost the user money. Do the cheap thing first (draw a still, check it with `view_render`, then animate it), generate one version unless asked for options, and never loop regenerating hoping for luck — change the prompt with intent.

## Organising media

Name imports meaningfully, use `folder` to group (Footage, Music, SFX, Logos). Importing a byte-identical file again reuses the asset already there, so a rebuild script can import freely.

**Media missing from this device.** The project document and its media are stored apart, and a browser can clear the media alone. Media that played a moment ago then fails after a reload, and `export_render`, `audio_analyze` and `media_inspect` say *"not on this device"* and name each file and asset id. Don't build around it, and never ship a silent export. Deleting media from the library and undoing it never loses the file: bytes leave the device only when no undo step and no project (a duplicate shares its media) can use them. Import the same files again with `media_import {localPath}`: the file goes back under **every old id that lost it**, so layers, scripts and hit sounds play again and no id needs remapping. Each import records the file's fingerprint, so a copy is recognised even when another file has the same size. Media imported before that is matched by file name and size. The `assetId` you get back is the copy the project uses most. An embedded browser pane may keep a site's storage only for as long as it runs, so keep the source files on disk. Keep a list of what you imported, and from where, in your notes. `media_remove {assetIds}` takes media out of the library (refused while a layer uses it); `media_remove {unused: true}` sweeps everything nothing uses.
