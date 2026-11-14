export interface McpProduct {
  name: string;
  ns: string;
  webOrigin: string;
  port: number;
}
export interface McpIdentity {
  name: string;
  ns: string;
  port: number;
  package: string;
  bin: string;
  serverName: string;
  scheme: string;
  statusTool: string;
  home: string;
  envPrefix: string;
  origins: string[];
}
export function mcpIdentity(p: McpProduct): McpIdentity;
export function skillVars(id: McpIdentity, sliceExt: string): { name: string; ns: string; status_tool: string; project_exts: string };
