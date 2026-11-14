import { mcpIdentity, skillVars } from "@solomotion/mcp/identity";
import { DEFAULT_DESIGN_SYSTEM_FILES as RAW_DESIGN, SKILL_FILES as RAW_SKILL, stampSkill } from "@solomotion/skill";
import { identity } from "@/editor/identity";

/**
 * The product's MCP bridge as the editor knows it — the port it knocks on, the
 * package and server name agents are told to add, the token file, the status
 * verb — derived by the bridge's own `mcpIdentity`, so the tab and the bridge
 * agree by construction.
 */
export const BRIDGE = mcpIdentity({ name: identity.name, ns: identity.ns, webOrigin: identity.webOrigin, port: identity.mcpPort });

/** The skill and default design system in this product's words (packages/skill `stampSkill`). */
const VARS = skillVars(BRIDGE, identity.sliceExt);
export const SKILL_FILES = stampSkill(RAW_SKILL, VARS);
export const DEFAULT_DESIGN_SYSTEM_FILES = stampSkill(RAW_DESIGN, VARS);
export { SKILL_VERSION } from "@solomotion/skill";
