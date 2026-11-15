<h1 align="center">SoloMotion</h1>

<p align="center">The open-source motion studio.</p>

<p align="center">
  <a href="https://github.com/solocreates/solomotion/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/solocreates/solomotion/ci.yml?branch=main&label=CI&style=flat&labelColor=24292f"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-0b8a57?style=flat&labelColor=24292f"></a>
  <a href="https://github.com/solocreates/solomotion/releases"><img alt="Latest version" src="https://img.shields.io/github/v/release/solocreates/solomotion?include_prereleases&sort=semver&label=version&style=flat&labelColor=24292f&color=0b8a57"></a>
  <a href="https://github.com/sponsors/novincode"><img alt="Sponsors" src="https://img.shields.io/github/sponsors/novincode?label=sponsors&style=flat&labelColor=24292f&color=0b8a57"></a>
</p>

SoloMotion is a studio for motion design and video. Animate, draw, edit, grade
and score in one place, in your browser. There is no account, no subscription
and no watermark, and your projects stay on your machine.

## What it does

**Animate anything.** Keyframes, curves and expressions on every property.
Rigs and characters with bones, poses and shape keys. Frame-by-frame drawing
with onion skin. Physics when hand-keying would take a week.

**Edit on a real timeline.** Video, sound and captions sit beside your
animation on one timeline, with tracking, transitions, and a sound mix with
buses and automatic levelling.

**Make it look like something.** Stacked effects, a node-based colour page,
and a 3D world for scenes that need depth.

**Let agents drive it.** Every action in the studio is a command in one
registry. The same commands are open to AI agents over the Model Context
Protocol, so an agent can build a scene while you watch and undo it in one
step.
[`@solomotion/mcp`](packages/mcp) connects Claude Code, Codex, Cursor or any
other MCP client to the studio running in your browser.

**Make it yours.** The whole look is one theme file: colours, type, shape, and
how each control is drawn. Switch between the shipped themes or write your own.

## Open source, no budget

> **SoloMotion is open source and has no marketing budget. You're all we've got.**

There are two ways to keep it going.

**Fund it.** SoloMotion has no investors and no price. Funding pays for the
hours that build it.
[Sponsor on GitHub](https://github.com/sponsors/novincode), monthly or once, or
[buy a coffee](https://buymeacoffee.com/codeideal).

**Spread it.** Without a budget, you are how people find out. Post about it,
make a video or a tutorial, write about it, or show it to one person who makes
videos. Then [tell us what you made](https://github.com/solocreates/solomotion/issues/new?template=3-made-something.yml)
and you go on the wall below. Starring the repository helps more people find it.

## Supporters

Everyone who funds SoloMotion or makes something about it is listed here, in three rows:

- **First believers.** The first people to fund, post or make something about SoloMotion. This row is permanent.
- **Sponsors.** Monthly supporters.
- **Creators.** People who made a video, a tutorial, an article or a post.

The wall is empty today. [Sponsor](https://github.com/sponsors/novincode) or [tell us what you made](https://github.com/solocreates/solomotion/issues/new?template=3-made-something.yml) to be the first name on it.

## Run it locally

You need [Node.js](https://nodejs.org) 22 or later and pnpm, which Node
provides through Corepack.

```sh
git clone https://github.com/solocreates/solomotion.git
cd solomotion
corepack enable
pnpm install
pnpm dev
```

The studio opens at http://localhost:3000.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the studio with hot reload |
| `pnpm test` | Runs every package's tests |
| `pnpm typecheck` | Typechecks the whole workspace |
| `pnpm build` | Builds every package and the studio |

## Repository

| Package | What it is |
| --- | --- |
| [`@solomotion/web`](apps/web) | The editor: canvas, timeline, inspector, export — one app, any product on the engine. |
| [`@solomotion/agent`](packages/agent) | The agent runtime: provider dialects, the tool loop, knowledge packs, media generation and feedback folding. Provider- and UI-agnostic. |
| [`@solomotion/core`](packages/core) | The engine: the document, animation, timeline, effects, physics, rigging, the command API and its agent verbs. Pure data — no DOM, no React; runs in a test, a worker and the exporter alike. |
| [`@solomotion/lipsync`](packages/lipsync) | Headless speech foundation: lazy speech engines (analyze/align/synthesize), ARPAbet G2P, viseme alphabets, an offline Test Voice, cue post-processing and an evaluation harness. Zero dependencies, zero DOM. |
| [`@solomotion/mcp`](packages/mcp) | The SoloMotion MCP server: lets Claude Code, Cursor or any MCP client drive a running SoloMotion editor. |
| [`@solomotion/platform`](packages/platform) | The bridge between the app and its host (browser or desktop shell): files, clipboard, fonts, folders, updates, the log bus. |
| [`@solomotion/plugin-sdk`](packages/plugin-sdk) | Types and validation for SoloMotion plugins: the manifest schema, capabilities and the window.solomotion API. |
| [`@solomotion/skill`](packages/skill) | The agent skill and default design system — how an AI works inside the studio. |
| [`@solomotion/templates`](packages/templates) | The templates that ship in the studio — each a build script and the art it reads. |
| [`@solomotion/theme`](packages/theme) | The theme file: one schema that picks colours, type, shape and a dialect for every part, compiled to CSS. |
| [`@solomotion/ui`](packages/ui) | Shared UI primitives and cursors. |
| [`@solomotion/product`](products/solomotion) | SoloMotion, the open studio: its identity, Support, hosts and entitlements (everything unlocked). |
| [`solomotion`](products/solomotion/cli) | Open SoloMotion, the open-source motion studio, or run its MCP server for your agent. |

## Contributing

Bug reports, fixes and ideas are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for how a change goes from your machine to a
release, and the [Code of Conduct](CODE_OF_CONDUCT.md). Questions go to
[Discussions](https://github.com/solocreates/solomotion/discussions). Report security
problems privately, as [SECURITY.md](SECURITY.md) describes.

## License

SoloMotion is free software under the [GNU Affero General Public License v3.0](LICENSE).
You can use, study, change and share it. If you distribute a changed version,
or run one as a service for others, its source stays open under the same license.
