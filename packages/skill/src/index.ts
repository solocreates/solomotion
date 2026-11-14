// @solomotion/skill — the knowledge the in-app agent starts with. The Markdown
// under skills/ and design-systems/ is the source; this module is its bundle.
export { SKILL_VERSION, SKILL_FILES, DEFAULT_DESIGN_SYSTEM_FILES } from "./bundle.generated";

/**
 * The words a product fills in. The skill's Markdown names no product: where
 * it must ("work in {{name}}", the pack name, the status verb), it says a
 * `{{token}}`, and each product stamps its own — so one source teaches every
 * product's agents, each in that product's words.
 */
export interface SkillVars {
  /** The product's name, as written in a sentence. */
  name: string;
  /** Its namespace: the skill's pack name (`skill_read {pack}`). */
  ns: string;
  /** The MCP bridge's status verb. */
  status_tool: string;
  /** The files `project_import` merges, as written in a table cell. */
  project_exts: string;
}

const TOKEN = /\{\{(name|ns|status_tool|project_exts)\}\}/g;

/** The files with every `{{token}}` filled in. */
export function stampSkill(files: Readonly<Record<string, string>>, vars: SkillVars): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, text]) => [path, text.replace(TOKEN, (_, k: keyof SkillVars) => vars[k])]));
}
