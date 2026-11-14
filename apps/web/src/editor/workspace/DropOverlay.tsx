"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { editorIcon } from "../panels/panel-registry";
import { editorMeta } from "./editor-registry";
import { useWorkspaceDrag } from "./drag";
import styles from "./workspace.module.css";

/**
 * THE DROP PREVIEW — one translucent rectangle where the editor WILL be, with
 * a thin accent edge and its name. No arrows, no compass rose, no five
 * targets lighting up at once: those are the docking UIs people learn to fear.
 * The rect is the solver's `resultRect`, i.e. the layout the drop produces.
 *
 * It glides between answers (120ms) so a change of target reads as the same
 * object moving, and it never takes a pointer event.
 *
 * The GHOST — a small chip of the editor under the pointer — is what you are
 * carrying. Over a rail or a tab strip it disappears: it has BECOME that
 * list's badge, drawn by the list itself among its items. Floating, the
 * float rect is the ghost. So there is only ever one thing that says where
 * the editor is going.
 */
export function DropOverlay() {
  const drag = useWorkspaceDrag((s) => s.drag);
  if (typeof document === "undefined" || !drag) return null;
  const rect = drag.solution?.resultRect;
  const name = editorMeta(drag.editor)?.name ?? "";
  const kind = drag.solution?.target.kind ?? "none";
  const floating = kind === "float";
  const ghost = kind !== "list" && kind !== "float";
  const Icon = editorIcon(drag.editor);
  return createPortal(
    <div className={styles.overlayRoot} aria-hidden>
      {ghost && (
        <div className={styles.ghost} style={{ left: drag.pointer.x + 12, top: drag.pointer.y + 12 }}>
          <Icon />
          <span>{name}</span>
        </div>
      )}
      {rect && (
        <div
          className={styles.dropRect}
          data-float={floating || undefined}
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        >
          <span className={styles.dropLabel}>{name}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
