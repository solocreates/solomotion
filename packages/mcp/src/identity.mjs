/**
 * WHO THE BRIDGE SERVES. One bridge, several products on one engine: each
 * product publishes it under its own name and port, and an agent config, a
 * token file or an env var that works today keeps working, because every one
 * of those strings derives from the product's namespace here — for the CLI
 * (`identity.json` beside it) and for the editor that links to it alike.
 *
 * @typedef {{ name: string; ns: string; webOrigin: string; port: number }} McpProduct
 * @typedef {ReturnType<typeof mcpIdentity>} McpIdentity
 */

/** @param {McpProduct} p */
export function mcpIdentity(p) {
  return {
    /** As a sentence names it ("Open the app"). */
    name: p.name,
    ns: p.ns,
    /** The port the bridge holds and the tab knocks on. */
    port: p.port,
    /** The npm package agents run (`npx -y <package>@latest`). */
    package: `@${p.ns}/mcp`,
    bin: `${p.ns}-mcp`,
    /** The MCP server's name, and what agent configs call it. */
    serverName: p.ns,
    /** Resources are `<scheme>://skill/…`. */
    scheme: p.ns,
    statusTool: `${p.ns}_status`,
    /** `~/<home>` keeps the pairing token; `~/<home>-cache.json` the last tool list. */
    home: `.${p.ns}-mcp`,
    /** Env overrides: `<PREFIX>_PORT`, `_ORIGINS`, `_LEASE_MS`, `_QUIET_MS`, `_SOFT_WAIT_MS`. */
    envPrefix: `${p.ns.toUpperCase()}_MCP`,
    /** Tabs trusted by their Origin header (besides the desktop shell and localhost). */
    origins: [p.webOrigin],
  };
}

/** The skill's words for this product (packages/skill `stampSkill`). */
export function skillVars(id, sliceExt) {
  const exts = [...new Set([".motion", sliceExt, ".json"])].map((e) => `\`${e}\``).join(" / ");
  return { name: id.name, ns: id.ns, status_tool: id.statusTool, project_exts: exts };
}
