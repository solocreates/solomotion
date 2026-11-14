"use client";

import * as React from "react";
import { useSession } from "../state/session";
import { PanelBoundary } from "../runtime/ErrorBoundary";
import { panelDef } from "./panel-registry";

/**
 * The left panel body — whichever left surface is armed, rendered from THE
 * panel registry. (No project header: D2 revised — the logo menu is where
 * the project lives.)
 *
 * It used to be a ternary chain over a `LeftTab` union declared right here,
 * which is what made `plugins` unreachable: the tab was added to the session
 * and the registry, this chain never heard about it, and its final `else`
 * quietly rendered Layers for a value it did not know. The registry can fail
 * loudly, by returning nothing for an id it doesn't have.
 *
 * Which surface is showing is chosen from the LEFT RAIL, not from a tab strip
 * in here: a strip inside a panel disappears with the panel.
 */
export function LeftPanel() {
  const leftTab = useSession((s) => s.leftTab);
  const def = panelDef(leftTab);
  const Body = def?.component;
  return (
    <div className="flex h-full min-h-0 flex-col" data-pick-area={leftTab}>
      {/* Each surface gets its OWN boundary, reset by switching surfaces, so
          one surface that throws reads "<name> couldn't draw" while the others
          stay one rail click away. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {Body ? (
          <PanelBoundary name={def.name} resetKey={leftTab}>
            <Body />
          </PanelBoundary>
        ) : null}
      </div>
    </div>
  );
}

