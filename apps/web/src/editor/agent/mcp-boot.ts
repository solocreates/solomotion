"use client";

import * as React from "react";
import { NAMES } from "@/editor/names";

/**
 * Resume the external-agent link at boot — WITHOUT loading the agent.
 *
 * `mcp-link` pulls in the command registry and the runtime, which live in the
 * Agents panel's lazy chunk. This file is all the main bundle carries: one
 * storage read, and the import only for someone who switched the link on.
 */
export const AUTO_LINK_KEY = NAMES.storage.mcpAutoLink;

export function useExternalAgentResume(): void {
  React.useEffect(() => {
    let on = false;
    try {
      on = localStorage.getItem(AUTO_LINK_KEY) === "1";
    } catch {
      /* storage blocked — nothing to resume */
    }
    if (on) void import("./mcp-link").then((m) => m.resumeMcp());
  }, []);
}
