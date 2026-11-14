# Scripts

A script is JavaScript run against the open project — from the Scripts panel, or by an agent through `script_run`. It speaks the same verbs as the tools: the tool `layer_create` is `await ac.layer.create({...})` in a script, with the same input and the same result.

## When to reach for one

- **Anything repetitive.** Five or more similar calls — a grid, a stagger across forty words, one card per row of data — is one `script_run` instead of forty tool calls. Faster, cheaper, and the code is a reviewable artefact.
- **Anything computed.** Positions on a circle, a layout from data, timings from a beat list, seeded randomness.
- **Anything the person will re-run or tweak.** Save it with `script_save` (it appears in their Scripts panel) and tell them which numbers to change.

One-off edits stay tool calls.

## The runtime

- The file is the body of an `async` function: top-level `await` works and `return value` shows the value in Output.
- Globals: `ac` (the API), `here` (where it runs — below) and `console`. No DOM, no `import`, no access to the editor beyond `ac`. Standard JS (`Math`, `JSON`, `Array`, `fetch`) is there.
- **Await every `ac.*` call.** A call fired without `await` still runs, but after your next line has already read stale state; the Output flags it.
- A failed call throws — `CommandError: layer.create: …` with a hint, and the run stops at that line. Wrap a step in `try/catch` only when failure is acceptable.
- `console.log` lands in Output with the line that logged it, and in the app's Console. `console` is the run's own, not a global: code you build with `new Function(...)` (a multi-file build loading its modules) must be handed it as a parameter, or its logs vanish.
- `await ac.help()` lists namespaces; `ac.help("layer")` the verbs; `ac.help("layer.create")` one verb's full input shape.

## Where a script runs: `here`

`here` is the comp the person was on when they pressed Run — `{ frameId, name, width, height, fps, durationMs }` — fixed for the whole run, so a click elsewhere halfway through changes nothing. Every call without a `frameId` lands in it.

- **Build in `here`.** Size and place from `here.width` / `here.height`; time from `here.durationMs`. That one script then works in any comp, any project.
- **Create a comp only when asked for one** — and then pass its `frameId` to every call that should land in it.
- **Never hard-code a comp id** from a brief or an earlier run; ids differ per project. Pass `frameId` only for a comp the script made or looked up by name.
- An agent picks another comp with `script_run { frameId }`.

## Re-running: replace or append

Each saved file has a run mode (toolbar):

- **Replace** (default) — once the file parses, everything its last run **created** (layers, comps) is removed, then it runs (a project's last comp goes as soon as the run has made another). Edit, run, edit, run: the scene is rebuilt, never stacked. A file that does not parse removes nothing: fix the syntax error and run again.
- **Append** — every run adds. ⇧⌘↵ runs once in append without changing the mode.

So write a script as **the whole recipe for its output**: it creates everything it needs, every time, and never deletes its own earlier output by hand. Changes it makes to layers it did *not* create are re-applied on each run, never undone — set values, don't increment them (`x: 200`, not `x: x + 20`).

The console prompt and `script_run {code}` own nothing: they always add.

A run is **one undo step**, labelled with the file.

## Gotchas — the refusals scripts hit most

- **Whole-layer animations have no delay.** `animation.set` with `target: "layer"` (every shape, image, group) plays from the layer's start. To enter at 1.2 s, create the layer with `startMs: 1200`. `delayMs`, `staggerMs`, `unit`, `jitterMs` are for text only.
- **Ids come from the catalog, never from memory.** A preset, effect, template or transition id that is not listed fails. Read the scope too: a `text`-only preset will not go on a shape.
- **An address that is `undefined` is refused, not read as "the focused one".** `ac.frame.update({ id: made.id })` when the result called it `frameId` used to edit whatever comp was in focus; now it errors. Leave the key out to mean the focused comp. `frame.create` returns `id`, `world.create` returns `frameId`.
- **Property names come from the Property paths list**, not from CSS or After Effects habits: horizontal scale is `scale` (Scale X) beside `scaleY` — there is no `scaleX`. The same names work in `set:`, `layer.set` and `keyframes.set`.
- **Keyframe `at` is relative to the layer's start** unless you pass `clock: "comp"`.
- **Unknown fields are refused, and nothing changes.** The error names the field; `ac.help("<verb>")` shows the real shape. Don't guess field names a verb's signature doesn't list.
- **Every visual change wants a look.** `ac.view.frames` / `ac.view.render` — what you return shows in Output.

## Make it designed, not generated

- Start from what exists: a **text template** for finished type, **animation presets** for entrances and exits, **effects** for glow, grain, blur, shadow. Hand-key only what no preset does.
- One idea per beat. Three to five elements on screen, a clear type scale, generous margins — read the craft sections you were given before placing anything.
- Timing carries the feel: stagger related things (40–120 ms), ease out on entrances, hold the important frame for at least a second.
- **A script writes poses, not samples.** Computing a motion is fine; writing a key on every frame of it is not. Find the poses (contacts, apexes, turns, rests) and key those with easing — a hop is one `position` key with `arc`, a switch is a `hold`, a pen stroke is two trim keys (`keyframing.md`). End the script with `ac.keyframes.inspect({})` and fix anything `baked`.

## Habits

- Keep ids from results: `const { id } = await ac.layer.create(...)`.
- Place from `here`: coordinates are comp space, centre origin, +y down (`x` spans ±here.width/2); times are ms.
- Name layers you will address later (`name: "Title"`): commands accept an exact, unique name in place of an id.
- Randomness that survives a re-run is seeded:

```js
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
```

- Put the knobs at the top as constants, so a person tweaking the script changes numbers, not logic.
- **Long builds run in the background.** `script_run {…, background: true}` returns a `runId` at once (budget
  15 min, `timeoutMs` up to 60 min; foreground runs stop themselves at 5, but your MCP client may drop a call after
  60 s, so anything that may take longer than ~45 s goes in the background). `console.log` one progress line
  per act or pass. Check `script_runs {}` (one line per live run: calls made, the verb it is awaiting, the
  last log), read only new lines with `script_logs {runId, since: next}`, and `script_stop {runId}` anything
  stuck. Never sit behind a foreground run for more than a few minutes.
- Give every loop that awaits the app (renders, searches, bisections) a hard iteration cap. A loop whose
  step snaps to a grid can stop shrinking: bisect on raw values and snap once at the end.
- A run that fails or is stopped keeps what it made: its report lists `leftBehind`, and `history_undo`
  takes the whole run back. Look before re-running.
- Check your work as an agent would: `return await ac.view.render({ detail: "glance" })` shows the frame in Output.

## Example — a staggered word stack

```js
const WORDS = ["Design", "in", "motion"];
const GAP = 140;     // px between lines
const STAGGER = 120; // ms between entrances

for (const [i, word] of WORDS.entries()) {
  const { id } = await ac.layer.create({
    kind: "text",
    text: word,
    name: `Word ${i + 1}`,
    y: (i - (WORDS.length - 1) / 2) * GAP, // lands in `here`
  });
  await ac.animation.set({ id, slot: "in", preset: "fade-up", unit: "letter", staggerMs: 18, delayMs: i * STAGGER });
}
```
