import { identity } from "@/editor/identity";
import * as React from "react";
import { osKind } from "@solomotion/platform";
import { platform } from "@/editor/platform";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { usePanels } from "../state/panels";
import { buildNativeMenu } from "./menu-spec";
import { runMenuCommand, type MenuCommandId } from "./menu-commands";

/**
 * Drives the native OS menu from the app's own state — the desktop counterpart
 * of the in-window <AppMenu>. It pushes the headless menu spec (rebuilt whenever
 * a reflected toggle changes, so native checkmarks stay honest) and routes item
 * clicks straight into the shared `runMenuCommand`. A no-op in the browser, where
 * `platform.menu` isn't supported. Mount once, high in the editor tree.
 */
export function useNativeMenu(): void {
  const store = useDocStore();
  const pixelGrid = useSession((s) => s.pixelGrid);
  const rulers = useSession((s) => s.rulers);
  const motionPaths = useSession((s) => s.motionPaths);
  const muted = useSession((s) => s.muted);
  const focusMode = usePanels((s) => s.focusMode);

  // Route native menu clicks to the one dispatcher. Bound once — the store is
  // stable for the editor's lifetime.
  React.useEffect(() => {
    if (!platform.menu.supported()) return;
    return platform.menu.onCommand((command) => runMenuCommand(store, command as MenuCommandId));
  }, [store]);

  // (Re)publish the menu whenever a reflected value changes.
  React.useEffect(() => {
    if (!platform.menu.supported()) return;
    platform.menu.set(
      buildNativeMenu({
        mac: osKind() === "macos",
        appName: identity.name,
        pixelGrid,
        rulers,
        motionPaths,
        muted,
        focusMode,
      }),
    );
  }, [pixelGrid, rulers, motionPaths, muted, focusMode]);
}
