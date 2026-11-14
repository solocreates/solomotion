import { identity } from "@/editor/identity";
import type { MenuTemplateNode } from "@solomotion/platform";
import type { MenuCommandId } from "./menu-commands";

/**
 * The headless native-menu spec. This is the ONE description of the desktop
 * menu's structure; the Electron shell builds its real OS menu from whatever the
 * renderer pushes here (see menu-spec → platform.menu.set → main.js). It mirrors
 * the in-window menubar (AppMenu) so the two never diverge, and every leaf routes
 * to the same `runMenuCommand` the in-window menu uses.
 *
 * Accelerators live only in the in-window menu: the app's shortcut handling is
 * focus-aware (canvas vs timeline), which a static native accelerator can't be,
 * so the native menu is intentionally click-to-run.
 */
export interface MenuSpecState {
  /** macOS gets the standard app menu + Window roles; other OSes fold those in. */
  mac: boolean;
  /** App name for the macOS app menu / About item. */
  appName: string;
  pixelGrid: boolean;
  rulers: boolean;
  motionPaths: boolean;
  muted: boolean;
  focusMode: boolean;
}

const sep = (): MenuTemplateNode => ({ type: "separator" });
const cmd = (label: string, command: MenuCommandId): MenuTemplateNode => ({ label, command });
const check = (label: string, command: MenuCommandId, checked: boolean): MenuTemplateNode => ({
  label,
  command,
  type: "checkbox",
  checked,
});

export function buildNativeMenu(s: MenuSpecState): MenuTemplateNode[] {
  const menus: MenuTemplateNode[] = [];

  if (s.mac) {
    menus.push({
      label: s.appName,
      submenu: [
        { role: "about" },
        sep(),
        cmd("Settings…", "file.settings"),
        sep(),
        { role: "services" },
        sep(),
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        sep(),
        { role: "quit" },
      ],
    });
  }

  menus.push({
    label: "File",
    submenu: [
      cmd("New project…", "file.new"),
      cmd("Open project…", "file.open"),
      sep(),
      cmd("Save project", "file.save"),
      cmd("Save project as…", "file.saveAs"),
      sep(),
      cmd("Import…", "file.import"),
      sep(),
      cmd("Export video / sequence…", "file.exportDialog"),
      cmd(`Export selection (${identity.sliceExt})`, "file.exportSlice"),
      cmd("Export document (.json)", "file.exportJson"),
      ...(s.mac ? [] : [sep(), cmd("Settings…", "file.settings"), sep(), { role: "quit" } as MenuTemplateNode]),
    ],
  });

  menus.push({
    label: "Edit",
    submenu: [
      cmd("Undo", "edit.undo"),
      cmd("Redo", "edit.redo"),
      sep(),
      cmd("Cut", "edit.cut"),
      cmd("Copy", "edit.copy"),
      cmd("Paste", "edit.paste"),
      cmd("Duplicate", "edit.duplicate"),
      sep(),
      cmd("Group", "edit.group"),
      cmd("Ungroup", "edit.ungroup"),
      cmd("Flatten to path", "edit.flatten"),
      cmd("Split at playhead", "edit.split"),
      sep(),
      cmd("Lock / unlock selection", "edit.lock"),
      cmd("Show / hide selection", "edit.hide"),
      sep(),
      cmd("Delete", "edit.delete"),
    ],
  });

  menus.push({
    label: "View",
    submenu: [
      check("Pixel grid", "view.pixelGrid", s.pixelGrid),
      check("Rulers", "view.rulers", s.rulers),
      check("Motion paths", "view.motionPaths", s.motionPaths),
      check("Mute preview", "view.mute", s.muted),
      sep(),
      check("Focus mode", "view.focusMode", s.focusMode),
      sep(),
      cmd("Command palette", "view.palette"),
    ],
  });

  menus.push({
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      sep(),
      cmd("Variables", "window.variables"),
      cmd("Console", "window.console"),
      ...(s.mac ? [sep(), { role: "front" } as MenuTemplateNode] : []),
      sep(),
      { role: "close" },
    ],
  });

  menus.push({
    label: "Help",
    submenu: [
      cmd("Report a bug…", "help.reportBug"),
      cmd("Send feedback…", "help.feedback"),
      sep(),
      cmd(`${identity.name} website`, "help.website"),
    ],
  });

  return menus;
}
