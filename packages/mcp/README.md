# @solomotion/mcp

The MCP server for [SoloMotion](https://github.com/novincode/solomotion), the
open-source motion studio. It lets Claude Code, Cursor, Codex or any
[MCP](https://modelcontextprotocol.io) client drive a SoloMotion editor that is
open in your browser: design, animate, edit and render, live on your canvas.

## Install

```bash
claude mcp add -s user solomotion -- npx -y @solomotion/mcp@latest
```

Then, in SoloMotion: **Agents > Use your agent app > Link**. The tab stays
linked and reconnects whenever your agent starts a session.

## Other clients

Any client that runs a stdio server takes the same command:

```json
{
  "mcpServers": {
    "solomotion": {
      "command": "npx",
      "args": ["-y", "@solomotion/mcp@latest"]
    }
  }
}
```

Keep `@latest`: without it, npx serves whichever copy it cached first.

## What your agent gets

- **Every editor command as a tool**, with live JSON schemas. They are the
  same commands SoloMotion's built-in agent uses.
- **Renders as images** (`view_render`, `view_frames`), so it can check its
  own work.
- **The skill** as resources (`solomotion://skill/SKILL.md` and its
  references): how to work well in the studio, and the default design system.
- **One undo step per request**, labelled with the agent's name. Several
  sessions can share one link.

## Security

The server listens on `127.0.0.1:7318` only. It trusts a tab by its Origin
header when the tab comes from SoloMotion itself, the desktop app or
`localhost`. A self-hosted build must send the pairing token printed on start
(also kept in `~/.solomotion-mcp`); add its origin with
`SOLOMOTION_MCP_ORIGINS`.

## Docs

[solomotion.app/docs](https://solomotion.app/docs)

## License

GPL-3.0-only
