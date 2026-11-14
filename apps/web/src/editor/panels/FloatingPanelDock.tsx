"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { FloatingWindow, pixelBounds } from "@/components/ui/floating-window";
import { subscribePointerEnd } from "../input/pointer-gestures";
import { panelDef } from "./panel-registry";
import { panelWindowId } from "./floating-panels";
import { editorMeta, type EditorId } from "../workspace/editor-registry";
import type { FloatingWin } from "../workspace/layout-tree";
import { createDropSession } from "../workspace/drag";
import { useLayout, registerOsWindowFocus } from "../workspace/store";
import { EditorBody } from "../workspace/WorkspaceShell";
import { openOsWindow } from "../workspace/os-window";
import type { OsWindowHandle } from "../workspace/window-host";

/**
 * Every DETACHED editor — floating windows and OS windows — rendered from the
 * layout tree's `floating` and `windows` lists.
 *
 * Floating: the shared `FloatingWindow` chrome. Dragging its title runs the
 * SAME drop solver the rails use, so a window held over a region edge shows
 * the same calm preview and docks there on release; over the canvas it simply
 * stays a window. (It used to know one destination — the panel's hard-coded
 * home side — through a dashed placeholder of its own.)
 *
 * Closing either kind sends the editor HOME, to the region and slot it was
 * detached from.
 */
export function FloatingPanelDock() {
  const floating = useLayout((s) => s.ws.floating);
  const windows = useLayout((s) => s.ws.windows);
  return (
    <>
      {floating.map((w) => (
        <FloatingEditor key={w.editor} win={w} />
      ))}
      {windows.map((w) => (
        <OsWindowEditor key={w.editor} editor={w.editor} bounds={w.bounds} />
      ))}
    </>
  );
}

function FloatingEditor({ win }: { win: FloatingWin }) {
  const def = panelDef(win.editor);
  const session = React.useRef<ReturnType<typeof createDropSession> | null>(null);
  const last = React.useRef({ x: 0, y: 0 });
  const offs = React.useRef<Array<() => void>>([]);
  if (!def) return null;
  const Icon = def.icon;
  const L = useLayout.getState;

  const stopTracking = () => {
    offs.current.forEach((f) => f());
    offs.current = [];
  };

  return (
    <FloatingWindow
      title={def.name}
      icon={<Icon />}
      bounds={{ ...win.bounds, minimized: !!win.minimized }}
      windowId={panelWindowId(win.editor)}
      onBoundsChange={(patch) => L().setBounds(win.editor, pixelBounds(patch))}
      onClose={() => L().home(win.editor)}
      onToggleMinimize={() => L().toggleMinimized(win.editor)}
      body="fill"
      onMoveStart={() => {
        session.current = createDropSession(win.editor, { allowFloat: false });
        const move = (e: PointerEvent) => {
          last.current = { x: e.clientX, y: e.clientY };
          session.current?.move(last.current);
        };
        const cancel = () => {
          session.current?.end(false, last.current);
          session.current = null;
          stopTracking();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointercancel", cancel);
        const off = subscribePointerEnd((_, reason) => {
          if (reason !== "up") cancel();
        });
        offs.current = [
          () => window.removeEventListener("pointermove", move),
          () => window.removeEventListener("pointercancel", cancel),
          off,
        ];
      }}
      onMoveEnd={() => {
        stopTracking();
        session.current?.end(true, last.current);
        session.current = null;
      }}
    >
      <div className="h-full min-h-0">
        <EditorBody editor={win.editor} />
      </div>
    </FloatingWindow>
  );
}

/**
 * An editor in its own OS window: `window.open` + `createPortal`, one realm.
 * Popup blocked → the editor floats instead of vanishing.
 */
function OsWindowEditor({ editor, bounds }: { editor: EditorId; bounds: FloatingWin["bounds"] }) {
  const [handle, setHandle] = React.useState<OsWindowHandle | null>(null);
  React.useEffect(() => {
    const h = openOsWindow({
      key: editor,
      title: editorMeta(editor)?.name ?? "Editor",
      bounds,
      onClose: () => useLayout.getState().home(editor),
    });
    if (!h) {
      // Blocked by the browser: fall back to a floating window, still HOME-aware.
      useLayout.getState().windowToFloating(editor);
      return;
    }
    registerOsWindowFocus(editor, h.focus);
    setHandle(h);
    return () => {
      registerOsWindowFocus(editor, null);
      h.close();
    };
    // Bounds are the OPENING size; later moves belong to the OS.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  if (!handle) return null;
  return createPortal(
    <div className="flex h-full min-h-0 flex-col bg-background p-(--shell-gap)">
      <div className="shell-card flex min-h-0 flex-1 flex-col">
        <EditorBody editor={editor} />
      </div>
    </div>,
    handle.container,
  );
}
