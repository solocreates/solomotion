# @solomotion/mcp

Let **Claude Code**, **Claude Desktop**, **Cursor** — any [MCP](https://modelcontextprotocol.io) client — drive a running SoloMotion editor: design, animate, edit video, generate media, all live on your canvas.

| Your agent app | Add SoloMotion |
|---|---|
| Claude Code | `claude mcp add -s user solomotion -- npx -y @solomotion/mcp@latest` |
| Codex | `codex mcp add solomotion -- npx -y @solomotion/mcp@latest` |
| Gemini CLI | `gemini mcp add -s user solomotion npx -y @solomotion/mcp@latest` |
| VS Code | `code --add-mcp '{"name":"solomotion","command":"npx","args":["-y","@solomotion/mcp@latest"]}'` |
| Cursor · Claude Desktop · anything else | a stdio server: command `npx`, args `["-y", "@solomotion/mcp@latest"]` |

Then in SoloMotion: **Agents ▸ Use your agent app ▸ Link**. The tab stays linked and reconnects whenever your agent starts a session.

Run as many sessions as you like: they share the one link, each request lands as its own undo step, and closing a session never disconnects the others. It works with whatever model your agent app runs — MCP is between the app and SoloMotion, not the model.

What your agent gets:

- **Every editor verb as a tool**, with live JSON schemas — the same commands the built-in agent uses.
- **Eyes** — `view_render` / `view_frames` return real renders as images, so it checks its own work.
- **The skill** as resources (`solomotion://skill/SKILL.md` and its references) — how to work well in the app, plus the default design system.
- **Safety** — the bridge listens on `127.0.0.1:7318` only and trusts only the app's own origins (`app.solomotion.app`, the desktop app, `localhost`); a tab served from anywhere else must present the pairing token printed on start (also in `~/.solomotion-mcp`; extra origins via `SOLOMOTION_MCP_ORIGINS`). Every change is labelled with your agent's name in the Undo menu, one step per request.

## One bridge, any product

Who the bridge serves — name, port, token file, env prefix, origins, resource scheme, status verb — comes from `src/identity.json` (or `--identity <file>`), and every one of those strings derives from the product's namespace (`src/identity.mjs`). A studio built on this engine publishes the same source under its own name.

GPL-3.0.
