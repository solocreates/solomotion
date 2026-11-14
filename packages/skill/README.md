# @solomotion/skill

How an AI agent designs, animates and edits inside the studio — the motion design and video studio built on this engine.

It follows the [Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview) layout, so any agent that reads skills can use it:

```
skills/solomotion/
  SKILL.md                 the entry: the working loop, the command map, the craft rules
  references/*.md          read on demand — API, layout, type & captions, motion, vectors,
                           colour & grading, effects, editing, sound, media & generation,
                           review, recipes, reporting
design-systems/default/
  DESIGN.md                the default design system: grid, type scale, colour roles,
                           motion and sound tokens
```

## One skill, any product

The Markdown names no product. Where it must — the product's name, the skill's pack name, the bridge's status verb, the project files it opens — it says `{{name}}`, `{{ns}}`, `{{status_tool}}` or `{{project_exts}}`, and each product stamps its own words (`stampSkill` in `src/index.ts`; the MCP bridge does the same for its bundled copy).

## How it is used

- **Inside the editor** the skill and design system are bundled (`src/bundle.generated.ts`, built by `pnpm --filter @solomotion/skill bundle`). The entry files sit in the agent's system prompt; references are read with `skill_read` only when a task needs them.
- **From other agents** (Claude Code, Claude Desktop, Cursor…) through the MCP bridge (`packages/mcp`), which exposes the same commands the in-app agent uses and serves this skill as resources.

## The contract

The skill teaches *how to work*; the API describes *what exists*. Every command, field, effect, preset and template is discoverable at runtime (`api_describe`, `layer_properties`, `catalog_list`), read from the live schemas — so the skill never lists what the code can tell the agent itself, and it cannot go stale when the app grows.

## Improving it

Agents file `report_issue` when the skill or the API lets them down. Reports cluster by fingerprint and rank by severity × breadth × recency; the version in `SKILL.md` is stamped on every report, so a fix can be measured by watching its cluster shrink. Edit the Markdown, bump `version`, run the bundle.
