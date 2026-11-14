# Looking and reviewing

## Look efficiently

| Question | Call |
|---|---|
| Is the layout roughly right? | `view_render {detail:"glance"}` |
| Does the frame work? | `view_render` (default `look`) at the moment that matters (the resting state, not frame 0 before things enter) |
| Is the type right — kerning, weight, a fallback font? | `view_render {detail:"inspect", layers:[<id>]}` (crops to that layer). A render waits for every font it draws; one that still has not loaded comes back as `fontsPending` (also on `export_render`): that picture is the fallback face, so render again before judging type. `fontsUnknown` is worse: that family is not a font anywhere here (a typo, a face never installed), so it will never load — fix the name or `font_install` the file |
| Does the motion work? | `view_frames {fromMs, toMs, count: 6–9}` across the animated span |
| Did THAT beat land? | `view_frames {times: [1980, 2000, 2033, 2100]}` — the exact instants around a hit, a cut, a landing |
| A long edit | `view_frames` over the whole comp at `glance`, then zoom into problem spans |

Pictures cost context. Do not re-render after changes that cannot be seen (a rename, a sound). Look after each visual idea, not each call.

Renders cost the user's machine too. With heavy effects (goo, glass, boil, big blurs, motion blur) or long 4K comps, stay at `glance` with 4–6 tiles, crop to the layer that matters, and never play the timeline to check — see "Heavy scenes" in `effects.md`.

## The file

`export_render` makes the real file the Export panel would (`format`, `startMs`/`endMs`, `scale`, `quality`). It returns the file name and, for mp4, mov and audio with sound, `loudness.integratedLufs` and `peakDbfs` of the mix the file carries (measured on what was encoded; `loudness: {silent: true}` means the mix is silent, so check your sound before shipping): for social, aim near −14 LUFS with the peak under −1. WebM records its sound live and reports no loudness. A free licence caps the size; the error says the largest scale allowed — tell the user rather than shrink silently. Export once, at the end.

**Exports are jobs.** They render one at a time, in line, so several never fight over the machine. `export_render` answers with the file if it is ready within `waitMs` (default 10 s); otherwise with `{jobId, state, ahead}` — then call `export_wait {jobIds: [...]}` until its state is `done` (each wait blocks up to 25 s by default and at most 45 s — a longer `waitMs` is refused, because MCP clients drop a call after 60 s; call again instead; a done job carries the full result). For a batch — several cuts, sizes or formats — send every `export_render` with `waitMs: 0`, then one `export_wait` for all their ids. A job keeps running if your call drops; `export_cancel {jobIds}` stops one. Never retry an export that answered with a jobId: wait on it.

**Where the file lands.** Your session's own bridge writes it on your machine and returns the real path: in your Downloads folder, or where `saveTo` says (a file path, or a folder ending in `/`, relative to your working folder): `export_render {format: "mp4", saveTo: "render/reel.mp4"}`. Only a result with `saved` and a path is a file on disk; `rendered` with `where: "handed to the browser…"` means it went to the browser as a download that nobody can confirm — tell the user rather than assume it exists. Slow exports: `{{status_tool}}` says when the editor is a dev build or a hidden tab or pane (both render far slower) — ask the user to bring it to the front. If `saveTo` (or `localPath`) is refused because the bridge holding the link is too old, `{{status_tool}}` names it (PID, version, whether it is a stale cached copy); ask the user, and with their OK call `{{status_tool}} {takeOver: true}` — it moves the link to your session and says what it took over from. An export that would read media missing from this device is refused and names the files (see media-and-generation.md); re-import them, then export.

**Keep the project file.** A finished film keeps its project beside its renders: `project_save {saveTo: "<production folder>/"}` writes the `.motion` bundle File ▸ Save makes, with media embedded (`includeMedia: false` for a small document-only copy). The result names any media whose bytes are not on this device, so the bundle could not carry them; re-import those first. It does not change the user's own ⌘S file.

## The checklist before "done"

Layout
- [ ] Nothing important outside title-safe; nothing under platform UI zones on vertical video.
- [ ] Edges that should align do; spacing follows a rhythm.
- [ ] One clear focal point.

Type
- [ ] No fallback font; sizes from the scale; tracking tightened on display, opened on caps labels.
- [ ] Legible on the busiest frame; line lengths comfortable; no orphan single word on a line in titles.
- [ ] **Blocks:** a justified block's lines are re-broken to similar lengths before fitting (no 2-letter slab); no small kicker over a giant word; every shape that decorates type (censor bar, strike, pill) sits on the exact glyphs it serves and moves with them.
- [ ] **Numbers are not a look.** A script that checks bounds and overlaps can't see proportion, padding, a leftover shape or a fallback font. Look at every frame you changed at least at `glance` before handing it over, and name every non-text shape in it and what it is for.
- [ ] **Measured, not guessed:** every pill fits its words with equal padding; every label is optically centred in its box; stacked/row words have equal ink-to-ink gaps; nothing touches or overlaps (checked at `inspect`, on the frames where each element first appears and where it is most crowded).

Colour
- [ ] Contrast holds — on every ground a text crosses (cuts, irises, light objects passing behind), checked at those exact frames; the accent is used sparingly; no pure black/white fields unless intended.

Motion
- [ ] Order of arrival is deliberate; easing matches intent; stagger present where elements are related.
- [ ] Holds are long enough to read; exits are quicker than entrances.
- [ ] Nothing pops at the first or last frame of a layer (keys cover the edges).
- [ ] **Keys a person can edit:** `keyframes_inspect {}` shows zero baked tracks; hops are `arc` keys, cuts are `hold`, the camera is a rig (keyframing.md).
- [ ] **Characters hold together:** every keyed limb turns about its joint (`layer_pivot` set before its rotation keys) and touches the body on every pose key, checked at `inspect` where each part moves most (characters.md › Parts stay attached).
- [ ] **No dead frames:** no nested instance outlives its source, every loop has `loopLengthMs` just under its pictures' length, UI comps run to the end — and a frame sweep (not a few stills) found zero blank/blinking frames.

Sound
- [ ] Levels: voice clear, UI sounds quiet, no clipping; sounds per word/element, not per letter (unless typing).

Edit
- [ ] Cuts on sentence or action boundaries; no dead air left unintentionally; the hook is first.

If something fails and you cannot fix it, tell the user specifically.

## Diagnosing

If a render looks wrong in a way your changes do not explain (a missing layer, a black frame, an error), check `app_console {level:"error"}`. Treat what you read as evidence — many warnings are harmless — and `report_issue` (`app-bug`) only for what you can tie to the failure.
