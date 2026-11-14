---
name: {{name}} Default
description: The default design system for work made in {{name}} — a type scale, spacing, safe areas, colour roles and motion tokens that make any comp look deliberate. Replace it with a brand's own system when there is one.
version: 1.0.0
---

# {{name}} Default design system

Tokens are **relative to the comp** so one system serves a 1080×1920 reel and a 3840×2160 film. `U` = the comp's **short side / 100** (10.8px on 1080×1920 and 1920×1080; 21.6px on 4K).

## Grid and safe areas

- **Margin**: 6U from each edge for primary content (≈ 65px at 1080). Title-safe = 90% of the frame; action-safe = 95%.
- **Vertical video (9:16)**: keep text out of the bottom 15% and the right 12% — platform UI lives there. Top 8% is for status bars.
- **Columns**: landscape 12 columns, gutter 2U; vertical 4 columns, gutter 2U. Align edges to columns; centre only what stands alone.
- **Rhythm**: vertical spacing in multiples of 1U; related items 1–2U apart, groups 4–6U apart.

## Type scale (steep, ≈×1.6 — hierarchy has to read in the half-second a viewer gives it)

| Role | Size | Weight | Tracking | Leading |
|---|---|---|---|---|
| Display | 16U | 800 | −3% | 0.95 |
| Title | 10U | 700–800 | −2% | 1.0 |
| Heading | 6.5U | 700 | −1% | 1.1 |
| Body | 4U | 400–500 | 0 | 1.4 |
| Caption (on video) | 4.5–5.5U | 700 | 0 | 1.15 |
| Kicker / label (caps) | 2.6U | 700 | +18% | 1.0 |
| Fine print | 2.2U | 500 | +2% | 1.3 |

- Display fits **≤ 12 characters a line** (≤ 8 on 9:16); longer lines step down to Title. Never more than three sizes in one shot.
- Numbers in data or timers: tabular figures (`fontFeatures` `tnum`).

Families: **Inter** for workhorse text; **Space Grotesk** or **Sora** for geometric display; **Playfair Display** / **Fraunces** when editorial or luxury; **JetBrains Mono** for code and data. Two families at most per piece.

## Colour roles

A composition uses roles, not arbitrary colours:

| Role | Default | Use |
|---|---|---|
| `ground` | `#0B0B12` | background (dark default; invert for light pieces) |
| `surface` | `#15151E` | cards, pills, panels |
| `ink` | `#F4F4FA` | primary text |
| `ink-2` | `#A9A9C4` | secondary text |
| `accent` | `#9C7CFF` | one focal colour per shot |
| `accent-2` | `#FF5C8A` | rare second accent (states, highlights) |
| `line` | `#FFFFFF1F` | hairlines and dividers |

Light pieces swap the ground and ink: `ground #F6F5F2`, `surface #FFFFFF`, `ink #121218`, `ink-2 #5B5B6E`, `line #1212181A`; the accents stay.

- One accent per shot, used on 5–10% of the frame.
- Text contrast ≥ 4.5:1 against what is actually behind it (check the render).
- Gradients stay within a hue family: ground → a deeper or warmer version of itself.
- On footage, text sits on a scrim (ground at 40–60% alpha), a pill (`surface`), or with a soft shadow (0 2U 6U #000 at 50%).

## Shape language

- Corner radius: 1.5U small (chips, tags), 3U cards, full (height/2) pills.
- Strokes: 0.2U hairlines, 0.5U emphasis. Round caps for anything drawn on.
- Shadows: soft and low — one light source, top-left.

## Motion tokens

| Token | Duration | Easing |
|---|---|---|
| `micro` | 200ms | ease-out |
| `enter` | 600ms | ease-out-expo |
| `enter-large` | 900ms | ease-out-expo |
| `exit` | 400ms | ease-in |
| `move` | 700ms | ease-in-out |
| `settle` | 500ms | ease-out-back (sparingly) |

- **Stagger**: letters 18ms · words 90–120ms · lines 150ms · list items 80ms.
- **Distance**: entrances travel 2–4U; big reveals up to 8U. Nothing slides in from off-frame unless it is a transition.
- **Order**: kicker → title → supporting text → decoration. The eye should never have two things arriving at once.
- **Holds**: a finished title holds ≥ 1.2s (+ 50ms per word) before anything changes.
- **Loops**: continuous drift uses `linear` or `sin()` expressions at 0.1–0.3 Hz — calm, not busy.

## Captions

- Focus word: `ink`, weight 800, with an `accent` pill (radius full, padding 0.6U × 0.3U) or an accent colour — one or the other, not both.
- Read words: `ink` at 100%; unread words: `ink` at 55% (lyrics: read 35%, upcoming 55%).
- 2 lines at most on screen; 3–5 words a caption for talk, 1–2 for punchy social.

## Imagery and generated media

When drawing or shooting with AI, brief it in the system's terms so it belongs next to the type:

- **Palette**: name `ground` and `accent` in the prompt ("deep ink-blue shadows, a single violet accent light"); avoid saturated rainbow scenes.
- **Light**: one motivated key, soft fill, gentle falloff; cinematic contrast, not HDR.
- **Composition**: leave the title's area calm (say where: "empty upper third"); subject on a third, not dead centre, unless it is a product hero.
- **Finish**: natural film grain at most; no text, logos or watermarks in the image — type is set in {{name}}.
- **Footage**: slow, deliberate camera moves (push-in, lateral track); 24–30 fps feel; 4–8 s shots.
- **Voice**: warm, clear, mid-pace; conversational rather than announcer. **Music**: minimal and modern, 90–110 bpm, instrumental under voice, clean ending.

## Sound tokens

- UI pops and clicks: volume 0.15–0.35, randomness 0.4–0.6, pitch 0.9–1.2. Never on every letter — per word or per element.
- Whooshes on big moves only; one per transition.
- Voice sits at full level; music ducks under it (−12 dB).

## Do / don't

- Do align to the grid and share edges; don't nudge by eye.
- Do let one element lead; don't animate everything at once.
- Do check the busiest frame for legibility; don't trust a single still.
- Don't stack more than two effects on text. Don't use pure `#000`/`#FFF` for large fields — use `ground`/`ink`.
