# Storytelling and hooks

Read this before planning **any video meant to be watched by strangers**: a Short, a reel, an ad, a
launch film, an explainer, a YouTube video. Motion makes people look; story makes them stay. Most people
who open {{name}} know what they want to *show*, not what *story* to tell. Finding it with them is part of
the job.

## Rule zero: "Should I say this or not?"

Ask it of every sentence, every shot and every caption. If the video works without it, cut it. If it's
risky (unprovable, unkind, a claim you can't show), cut it. Storytelling is mostly deciding what *not* to
say. Run the whole script through this question twice: once when it's written, once after you see it cut
to picture.

## Find the story before the first layer

Ask the person (or work out from what they gave you), in this order:
1. **Who is watching, and what do they already feel?** ("an editor whose retention graph dies at 0:03")
2. **What should they feel, know or do at the end?** One thing.
3. **What's true and specific that only this person knows?** A number, a moment, a mistake, a line they
   actually said. This is the material AI can't invent, and it's the part viewers trust. If the brief has
   none, ask for one before writing; don't fake it.
4. **What's the turn?** The point where the video reveals something the viewer didn't expect. No turn, no story.

Then write a **beat sheet**: one line per beat (what they see, what they hear, what they feel, how it hands
over to the next). Link beats with **"but" or "therefore", never "and then"** (Trey Parker and Matt Stone's
rule). A list of "and then" beats is a slideshow.

When someone hands you crowded thoughts, mine them. Their own phrasing is usually the strongest line in
the film. Keep it near-verbatim and build around it rather than replacing it with yours.

## The shape that holds attention

- **Hook (0–3 s):** a picture, a spoken line and on-screen text working *together* (three layers, one
  idea). Frame 0 is already moving or already strange. Never a logo, a fade from black, or "hey guys".
- **Promise (by 5 s):** what they'll get if they stay. Make it specific and keep it (the title too).
- **Body:** **give something every few seconds**: a laugh, a fact, a reveal, a rule they can use. People
  stay for what they get. Plant **open loops** ("you'll see it at the end") and keep the object of the loop
  visible on screen.
- **Turn:** recontextualise what they've seen. A good turn makes people rewatch.
- **Close:** pay off the open loop, and end on an invitation, not an order. A Short's last frame should flow
  into its first (a seamless loop counts as a rewatch).
- **Progress you can see** (a counter, chapter tabs, a filling bar) keeps people watching to the end (the
  goal-gradient effect). It's a hook in its own right.

## Twenty hooks, each with an {{name}} recipe

| Hook | Why it works | How to build it here |
|---|---|---|
| **Interrupt** | the eye notices a broken rhythm | frame 0 already moving; *stop* something on one frame with a hard sound (`physics_joint` rope catch, motion blur dying on the stop) |
| **Callout** | being looked at and described | eyes in a glyph (glyph → path, shape-key squint, flipbook blink), talking to the viewer about the viewer |
| **Turn** | broken prediction | say the opposite of the title's assumption; show it physically (a rope snaps, the card falls) |
| **Open loop** | unfinished things stick (Zeigarnik) | a sealed object that stays in a corner until the payoff |
| **Stakes** | loss made visible | infinite zoom-out until your tile is one of a thousand |
| **Pause** | stillness is a change too | freeze on one frame, cut the sound to room tone, hold 30 % longer than comfortable |
| **Chain** | causality pulls | "but/therefore" as physical links that pull taut (spring joints) |
| **Receipt** | value made countable | itemise what the viewer has got so far |
| **Specific** | details read as true | generic phrases pile up (glyph physics); a handwritten, true line cuts through |
| **Curtain** | process earns trust | flip the frame (`rotationY`) to show the real editor making it |
| **Switch** | a trick makes people watch the hands | same words, five voices (`generate_speech`), the type never moves |
| **Fingerprint** | vulnerability connects | show the real first draft, typos and all |
| **Yours** | people value what they finish | an empty field with a blinking cursor; no button, no arrow |
| **Anamorphic** | the brain loves a pattern snapping into place | 3D fragments that line up into a word from one camera angle |
| **Morph** | "what is it becoming?" | path `geometry` keys between shapes resampled to the same point count |
| **Before/after** | contrast is instant value | keyed mask wipe; make the 'before' honestly typical |
| **Mistake** | we can't leave an error alone | a typo in the title, fixed by hand after a full beat |
| **Satisfying fit** | closure rewards | letters dropping into letter-shaped holes, the last one wobbling on the rim |
| **Choice** | commitment: once they pick, they stay | A or B side by side, a cursor that won't choose |
| **Countdown** | an event at a known moment | each number in a different craft, hard cuts on the beat |

The built template **Hook Lab** shows every one, with the prompt that made it.

## Plain words (where people leave)

Hard words and hard names are exit points: a viewer who has to think about a word is a viewer who swipes. Use words a 12-year-old would say ("so", not "therefore"), drop famous names and jargon ("the Zeigarnik effect" belongs in your notes, never on screen), and never open with more words than the picture needs. The first seconds belong to the picture; a few spoken words at most.

## Writing that doesn't sound like AI

Viewers recognise machine-averaged prose instantly, and they swipe. Never write: "in today's fast-paced
world", "let's dive in", "here's the thing", "game-changer", "unlock", "elevate", "seamless", "delve",
"testament to", "buckle up", "it's not just X, it's Y", stacks of three adjectives, or a question you answer
yourself every time. Do write: short spoken sentences, contractions, one idea per breath, a concrete noun in
every line, cause and effect, **one** antithesis per video (the line people quote), and specifics only the
author knows. **Every claim must be true.** If it can't be checked, cut it.

## Voice, captions and sound for retention

- **Voice:** decide who is speaking before casting (a friend who found something, not an announcer).
  Audition with the hardest line (the joke, the turn), loudness-matched. Make **one clip per scene**, generated with the neighbouring lines as context (`previous_text`/`next_text`): the flow carries over, each scene stays editable, and a changed line costs one clip instead of the whole script. **Never direct a whisper or a hushed line** (`[whispers]`, `[quietly]`): it reads as fake. Weight comes from a short line and a beat of silence. Splice voice only in the middle of a word gap, with 10–20 ms fades and a measured fixed gain, so it never audibly jumps. Before any clip goes in, transcribe it (`media_transcribe` or speech-to-text) and diff it against the script: missing, extra or changed words, pauses over ~0.9 s, words per second. Match levels by comparing like with like (a 1–2 s phrase against the neighbouring phrase), not integrated loudness of a 1 s line. When one sentence changes, re-make that sentence alone, with its neighbours as context, and cut it in; never regenerate the scene. **The author's lines are theirs:** never add a sentence or reword one in their script. Fix punctuation only, and ask about anything else. More than one voice can be a device (a chorus of generic openers,
  a voice switch), never a crutch.
- **Captions:** 1–4 words at a time, word by word on the word timings, clearing on breaths. Never repeat
  words that designed type already says. Absent during silences and reveals. On a Short, keep everything
  important above the bottom ~320 px and away from the right-hand button column. For long YouTube videos,
  put only key phrases on screen and give the full transcript to CC.
- **Sound:** one real sound per thing with mass, on its frame. Silence before the big line. Music arranged
  to the story's acts (it drops out for the honest moment), never laid under it.

## The brand moment (soft sell)

A story that sells a product has to keep feeling like a story when the product appears. The brand
is a quiet beat, never an interruption:

- It arrives where the eye already is, at the size of the things around it, in the story's own
  motion language. No zoom punch onto a logo, no sudden full-screen wordmark, no camera lunge.
- Show the real mark with its name set under it, small and unhurried, for one beat. Or let the
  product do one true thing on screen (a plan landing in a timeline) and name it once.
- The line that names it is the narrator's own, said once. Never add a tagline the author didn't write.
- Don't move the camera at the brand. If the shot needs to change, change it on the next story beat.

## Packaging (title and thumbnail are part of the story)

- The title makes a promise the video keeps in the first 5 seconds ("This video will hook you 12 times").
  It's a dare, a number or an open loop. Never an insult, never a guarantee of virality.
- The thumbnail opens a second question instead of repeating the title: one visual idea, readable in
  50 ms at phone size, key content inside the centre square, no arrows or fake faces. Make it as a static
  comp, never by nesting the film. Make three and let the platform test them.

## Check before calling it done

1. **Mute test:** with the sound off, does each beat read in under a second?
2. **Blind test:** with the picture off, does the voice alone make you want the next line?
3. **Thumb test:** scrub to any random second. Is something there worth not swiping?
4. **Truth test:** is every sentence true, every number real, and the author's own lines intact?
5. **Rule zero, once more:** read the script aloud and cut anything you can.
