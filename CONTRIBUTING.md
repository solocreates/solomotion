# Contributing to SoloMotion

Thank you for wanting to help. This page covers how to run the project, how a
change gets from your machine into a release, and the one agreement we ask you
to sign.

## Before you start

- **Small fixes** (a bug, a typo, a missing test): open a pull request directly.
- **Anything larger** (a new feature, a new kind of layer, a change to the file
  format): open a [Discussion](https://github.com/solocreates/solomotion/discussions) or an
  issue first. A short conversation saves a long review.
- **Security problems** never go in a public issue. See [SECURITY.md](SECURITY.md).

## Run it

You need Node.js 22 or later and pnpm (run `corepack enable` once).

```sh
pnpm install
pnpm dev          # the studio at http://localhost:3000
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

These are the same commands CI runs on every pull request.

## How a pull request flows

1. **Fork and branch** from `main`.
2. **Make the change.** Keep it focused on one thing. Logic that does not need
   the browser lives in a package and has tests next to it.
3. **Open the pull request** against `main` and fill in the template.
4. **Sign the CLA.** On your first pull request a bot asks you to sign the
   [Contributor License Agreement](CLA.md). It takes one click, once, and
   covers all your future contributions.
5. **CI runs** typecheck, lint, tests and the build. All of them must pass.
6. **Review.** The maintainer reviews every change. Expect questions; they are
   about the code, never about you.
7. **Merge.** Pull requests are squash-merged, with you as the author.

### Why your commit shows up twice

The code in this repository is published from the maintainer's development
tree, where the same engine also serves other products. When your pull request
merges here, it is applied to that tree with your name and email kept as the
author, and the next publish brings it back here. You keep the credit in both
places. A handful of files are generated during publishing (`README.md`,
`CONTRIBUTING.md`, the root `package.json`, `pnpm-workspace.yaml` and
`pnpm-lock.yaml`). Suggest changes to those in an issue rather than a pull
request.

## The Contributor License Agreement

SoloMotion is AGPL-3.0. The maintainer also builds products on the same engine
under other licenses, which is how the project pays for its time. The
[CLA](CLA.md) lets your contribution be used in both. You keep your copyright,
and we promise in the agreement that everything we accept stays available under
an open-source license.

## Style

- TypeScript, strict. No `any`, and no casts to get out of a typing problem.
- One concept lives in one place. Before adding a function, look for the one
  that already answers the question.
- Interface copy is short and specific. No paragraphs in panels.
- Commit messages and pull request titles are in the imperative mood: "Fix onion
  skin on nested comps", not "Fixed" or "Fixes".

## Other ways to help

Making something with SoloMotion and showing it is one of the most useful things
you can do for a project with no marketing budget. [Tell us what you
made](https://github.com/solocreates/solomotion/issues/new?template=3-made-something.yml) and
you go on the Creators wall.
