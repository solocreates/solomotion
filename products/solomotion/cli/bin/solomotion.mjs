#!/usr/bin/env node
/**
 * `npx solomotion`: the front door. With no command it opens the studio in the
 * browser; `solomotion mcp` runs the MCP server in this process, so an agent
 * app can use either `solomotion mcp` or `@solomotion/mcp` and get the same
 * bridge. The studio's address comes from the bridge's identity, the one place
 * that names it.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const identity = require("@solomotion/mcp/identity.json");
const [command, ...rest] = process.argv.slice(2);

const HELP = `${identity.name} ${own.version}

Usage
  npx solomotion            open the studio in your browser
  npx solomotion mcp        run the MCP server for an agent app (stdio)
  npx solomotion --version

Add it to Claude Code:
  claude mcp add -s user ${identity.ns} -- npx -y @${identity.ns}/mcp@latest

Docs: https://solomotion.app/docs`;

function open(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

if (command === undefined || command === "open") {
  open(identity.webOrigin);
  console.log(`Opening ${identity.webOrigin}`);
} else if (command === "mcp") {
  const pkgFile = require.resolve("@solomotion/mcp/package.json");
  const bin = JSON.parse(readFileSync(pkgFile, "utf8")).bin[`${identity.ns}-mcp`];
  const entry = join(dirname(pkgFile), bin);
  process.argv = [process.argv[0], entry, ...rest];
  await import(pathToFileURL(entry).href);
} else if (command === "--version" || command === "-v") {
  console.log(own.version);
} else if (command === "--help" || command === "-h" || command === "help") {
  console.log(HELP);
} else {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exitCode = 1;
}
