"use client";

import * as React from "react";
import { type Camera, type GraphNode, type NodeGraph, type ViewportSize } from "@solomotion/core";
import { CATEGORY_META, defaultNodeRegistry as reg } from "@solomotion/core";
import { nodeBounds, type NodeLayout } from "./board-geometry";
import { BoardMinimap } from "../board/BoardMinimap";

/**
 * The node board's MINIMAP — the shared board minimap (`board/BoardMinimap`)
 * fed the graph's cards in their category colours.
 */
export function Minimap({
  graph,
  layoutOf,
  camera,
  viewport,
  corner = "br",
  onCenterOn,
  onHide,
}: {
  graph: NodeGraph;
  layoutOf: (n: GraphNode) => NodeLayout;
  camera: Camera;
  viewport: ViewportSize;
  corner?: "tl" | "tr" | "bl" | "br";
  onCenterOn: (worldX: number, worldY: number) => void;
  onHide?: () => void;
}) {
  const items = graph.nodes.map((n) => {
    const def = reg.get(n.type);
    return { id: n.id, box: nodeBounds(n, layoutOf(n)), color: def ? CATEGORY_META[def.category].color : "#888" };
  });
  return <BoardMinimap items={items} camera={camera} viewport={viewport} corner={corner} onCenterOn={onCenterOn} onHide={onHide} />;
}
