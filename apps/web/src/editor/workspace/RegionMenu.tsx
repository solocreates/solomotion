"use client";

import * as React from "react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { editorIcon } from "../panels/panel-registry";
import { editorMeta, editorsByGroup, type EditorId } from "./editor-registry";
import {
  absentEditors,
  addToRegion,
  changeEditor,
  findRegion,
  hostOf,
  insertAtEdge,
  regionOf,
  splitRegion,
  type Edge,
} from "./layout-tree";
import { osWindowSupport } from "./os-window";
import { showRegion, useLayout } from "./store";

/**
 * THE REGION MENU (README D3) — the same items on a rail item's right-click
 * and a region header's: where can this editor go, what else can this region
 * show, and the way back to a known layout.
 *
 * Items that can never apply here are HIDDEN, not greyed (D8): the stage has
 * no Close, Tauri has no New window, an editor already on the left has no
 * "Move to Left".
 */
export function RegionMenuItems({ editor }: { editor: EditorId }) {
  const ws = useLayout((s) => s.ws);
  const region = regionOf(ws, editor);
  const meta = editorMeta(editor);
  if (!meta) return null;
  const isStage = editor === "stage";
  const L = useLayout.getState;

  const moveTo = (edge: Edge) => {
    // The classic regions ARE the edges: Left = the left region, Right = the
    // properties region, Bottom = the timeline region. Gone → a new column.
    const target = edge === "left" ? "left" : edge === "right" ? "inspector" : "timeline";
    if (findRegion(ws, target) && region?.id !== target) {
      L().apply((w) => addToRegion(w, target, editor));
      L().reveal(editor);
    } else {
      L().apply((w) => insertAtEdge(w, edge, editor));
      const r = regionOf(L().ws, editor);
      if (r) showRegion(r.id);
    }
  };

  const split = (edge: Edge) => {
    if (!region) return;
    const absent = absentEditors(ws).filter((id) => id !== "stage");
    const sameGroup = absent.find((id) => editorMeta(id)?.group === meta.group);
    const pick = sameGroup ?? absent[0];
    if (!pick) return;
    L().apply((w) => splitRegion(w, region.id, edge, pick));
  };

  const host = hostOf(ws, editor);
  const canWindow = osWindowSupport() === "portal" && meta.hosts.includes("window");
  const canSplit = !!region && absentEditors(ws).some((id) => id !== "stage");

  return (
    <>
      {!isStage && region && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>Change editor</ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-[70vh] overflow-y-auto">
            {editorsByGroup().map((g, gi) => (
              <React.Fragment key={g.group}>
                {gi > 0 && <ContextMenuSeparator />}
                {g.editors
                  .filter((e) => e.id !== "stage")
                  .map((e) => {
                    const Icon = editorIcon(e.id as EditorId);
                    return (
                      <ContextMenuItem
                        key={e.id}
                        onClick={() => {
                          L().apply((w) => changeEditor(w, region.id, e.id as EditorId));
                          L().reveal(e.id as EditorId);
                        }}
                      >
                        <Icon /> {e.name}
                      </ContextMenuItem>
                    );
                  })}
              </React.Fragment>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {!isStage && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {region?.id !== "left" && <ContextMenuItem onClick={() => moveTo("left")}>Left</ContextMenuItem>}
            {region?.id !== "inspector" && <ContextMenuItem onClick={() => moveTo("right")}>Right</ContextMenuItem>}
            {region?.id !== "timeline" && <ContextMenuItem onClick={() => moveTo("bottom")}>Bottom</ContextMenuItem>}
            {canWindow && host !== "window" && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => L().toWindow(editor)}>New window</ContextMenuItem>
              </>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {!isStage && host !== "floating" && <ContextMenuItem onClick={() => L().float(editor)}>Float</ContextMenuItem>}
      {!isStage && host !== "docked" && host !== null && (
        <ContextMenuItem onClick={() => L().home(editor)}>Dock back</ContextMenuItem>
      )}
      {region && canSplit && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>Split</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onClick={() => split("right")}>Horizontal</ContextMenuItem>
            <ContextMenuItem onClick={() => split("bottom")}>Vertical</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {region && (
        <ContextMenuItem onClick={() => L().toggleMaximised(region.id)}>
          {ws.maximised === region.id ? "Restore region" : "Maximise region"}
          <ContextMenuShortcut>⌃Space</ContextMenuShortcut>
        </ContextMenuItem>
      )}
      {meta.closable && host === "docked" && (
        <ContextMenuItem onClick={() => L().close(editor)}>Close</ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => L().reset()}>Reset workspace</ContextMenuItem>
    </>
  );
}
