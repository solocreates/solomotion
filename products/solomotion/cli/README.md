# solomotion

The command line for [SoloMotion](https://github.com/novincode/solomotion),
the open-source motion studio: motion design, animation and video editing in
the browser, with agents as first-class collaborators.

## Use

```bash
npx solomotion
```

opens the studio in your browser. Nothing to install, nothing to sign up for.

## Connect an agent

SoloMotion speaks [MCP](https://modelcontextprotocol.io), so Claude Code,
Cursor or any MCP client can drive the studio you have open:

```bash
claude mcp add -s user solomotion -- npx -y @solomotion/mcp@latest
```

Then, in SoloMotion: **Agents > Use your agent app > Link**.
`solomotion mcp` runs the same server, if you already have this package.

## Commands

| Command              | Does                                    |
| -------------------- | --------------------------------------- |
| `solomotion`         | Open the studio in your browser.        |
| `solomotion mcp`     | Run the MCP server on stdio.            |
| `solomotion --help`  | Show the commands.                      |

## Docs

[solomotion.app/docs](https://solomotion.app/docs)

## License

GPL-3.0-only
