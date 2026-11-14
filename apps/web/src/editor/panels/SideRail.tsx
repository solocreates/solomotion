"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { LayoutPanelTop, Settings } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WindowMenuItems } from "../menus/AppMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLayout } from "../workspace/store";
import { regions, setCollapsed } from "../workspace/layout-tree";
import type { EditorId } from "../workspace/editor-registry";
import { WorkspaceMenuItems } from "../workspace/WorkspaceMenu";
import { useSession } from "../state/session";
import { resolvePanel, usePanels } from "../state/panels";
import { useInspectorSections } from "../inspector/inspector-sections";
import { Rail, type RailItem } from "./Rail";
import { panelDef } from "./panel-registry";

/**
 * The LEFT and RIGHT rails — the vertical twins of the bottom bar.
 *
 * Both sides used to keep their surface switcher INSIDE the panel: a tab strip
 * in the left panel, another in the inspector. Two problems with that, and the
 * second is the one that matters.
 *
 * A strip inside a panel disappears when the panel does, so the control for
 * "show me Layers" was gone exactly when you needed it, and the only way back
 * was a different control somewhere else. And a horizontal row of words costs a
 * full row of a narrow column, which is why the inspector's tabs had to be
 * sticky, translucent and 11px — a whole cluster of workarounds for a strip
 * that was in the wrong place.
 *
 * On the rail they cost nothing: the rail is already there for the collapse
 * toggle, and it survives its panel by construction because it lives outside
 * it. Clicking a surface opens the panel if it is closed — you asked to see
 * something, not to arm a hidden flag.
 */

/**
 * A rail's surfaces come from THE LAYOUT TREE: the editors of every region
 * switched by that window edge, in region order, with a rule where the
 * document's surfaces end and the ones you added to the app begin (D10:
 * Layers · Library · Media │ Agents · Scripts · Plugins).
 *
 * It used to be the registry's `side: "left"` list, which is the reason a
 * panel could never move: the rail and the panel's location were the same
 * hard-coded fact. Now a panel dragged to the right rail appears there,
 * because the rail is reading where things ARE.
 */
export function useEdgeRailItems(edge: "left" | "right"): Array<RailItem | "separator"> {
  const key = useLayout((s) =>
    regions(s.ws.root)
      .filter((r) => r.rail === edge)
      .map((r) => `${r.id}:${r.active}:${r.editors.join(",")}:${r.collapsed ? 1 : 0}`)
      .join("|"),
  );
  const shown = {
    left: usePanels((s) => resolvePanel(s, "left")),
    inspector: usePanels((s) => resolvePanel(s, "inspector")),
  };
  const inspectorItems = useInspectorTabItems();
  return React.useMemo(() => {
    const out: Array<RailItem | "separator"> = [];
    const regs = key ? key.split("|").map((r) => {
      const [id, active, editors, collapsed] = r.split(":");
      return { id: id!, active: active as EditorId, editors: (editors ?? "").split(",").filter(Boolean) as EditorId[], collapsed: collapsed === "1" };
    }) : [];
    regs.forEach((r, ri) => {
      if (ri > 0) out.push("separator");
      const open = r.id === "left" ? shown.left : r.id === "inspector" ? shown.inspector : !r.collapsed;
      // Put the region away: legacy regions answer to their flag, the rest to `collapsed`.
      const hide = () =>
        r.id === "left" || r.id === "inspector"
          ? usePanels.getState().setVisible(r.id, false)
          : useLayout.getState().apply((w) => setCollapsed(w, r.id, true));
      let prevBand: string | null = null;
      for (const id of r.editors) {
        const def = panelDef(id);
        if (!def || id === "stage") continue;
        const band = def.group === "extend" ? "extend" : "doc";
        if (prevBand && band !== prevBand && out[out.length - 1] !== "separator") out.push("separator");
        prevBand = band;
        if (id === "inspector") {
          // Properties contributes its TABS — the rail is the tab strip.
          const isActive = r.active === "inspector";
          for (const t of inspectorItems)
            out.push({
              ...t,
              active: open && isActive && t.active,
              editor: "inspector" as EditorId,
              region: r.id,
              // A tab of Properties while another editor shares its region:
              // switch the region back to Properties, then to the tab.
              onClick: isActive
                ? t.onClick
                : () => {
                    useLayout.getState().reveal("inspector");
                    t.onClick();
                  },
            });
          continue;
        }
        const active = open && r.active === id;
        out.push({
          key: id,
          name: def.name,
          icon: def.icon,
          hint: def.hint,
          active,
          editor: id,
          region: r.id,
          onClick: () => {
            // On the surface you're already looking at → put the region away.
            // Anywhere else → switch, opening the region if it was closed.
            if (active) {
              hide();
              return;
            }
            useLayout.getState().reveal(id);
          },
          onPopOut: () => useLayout.getState().float(id),
        });
      }
    });
    return out;
  }, [key, shown.left, shown.inspector, inspectorItems]);
}

/** The left rail's items (kept by name: the compact dock reads it too). */
export function useLeftRailItems(): Array<RailItem | "separator"> {
  return useEdgeRailItems("left");
}

export function LeftRail() {
  return (
    <Rail
      side="left"
      // The mark anchors the rail's top and opens the app menu; settings anchor
      // the bottom. Both used to live in a full-width bar whose only other job
      // was holding them — removing it is what lets this rail reach the top and
      // bottom of the window, which is where the dark corners came from.
      // The mark, the app menu, search and Export live in the top bar now;
      // the rail is the panels and the app's own controls at its foot.
      footer={<GlobalActions />}
      items={useLeftRailItems()}
      dock
    />
  );
}

/**
 * The right rail's surfaces are PROPERTIES' SECTIONS (`useInspectorSections`,
 * the same hook Properties' own section bar reads when it is not on a rail).
 * On the rail, clicking the section you are on puts the panel away.
 */
function useInspectorTabItems(): RailItem[] {
  const open = usePanels((s) => resolvePanel(s, "inspector"));
  const sections = useInspectorSections();
  return sections.map((t) => ({
    key: t.key,
    name: t.name,
    icon: t.icon,
    hint: t.hint,
    active: open && t.active,
    onClick: () => {
      if (open && t.active) {
        usePanels.getState().setVisible("inspector", false);
        return;
      }
      if (t.key !== "project") useSession.getState().setInspectorTab(t.key);
      if (!open) usePanels.getState().setVisible("inspector", true);
    },
    onPopOut: () => useLayout.getState().float("inspector"),
  }));
}

/**
 * The right rail. Its surfaces are the INSPECTOR'S TABS — see
 * `useInspectorRailItems`, which the compact dock reads too, so the tab list
 * cannot exist in two versions that disagree about what is selected.
 */
export function RightRail() {
  return (
    <Rail
      side="right"
      // The button opens the export MENU, not the dialog directly — picking
      // what to export is a real choice (composition, this layer, Lottie, a
      // PNG of the current frame, a slice file) and the dialog only covers
      // some of them.
      items={useInspectorRailItems()}
      dock
    />
  );
}

/**
 * The right rail's items: every editor in regions switched from the right
 * edge — normally just Properties, whose TABS are the items.
 */
export function useInspectorRailItems(): Array<RailItem | "separator"> {
  return useEdgeRailItems("right");
}

/**
 * WORKSPACE · SETTINGS — the controls that belong to the app rather than to
 * any one surface or document. Undo and redo are the document's and live in
 * the top bar beside the project tabs; reporting a bug is in the app menu.
 *
 * They anchor the left rail's foot when there is a left rail, and the compact
 * dock's end when there is not (Settings only: the workspace presets have a
 * second door in the app menu, and the dock's width is for surfaces).
 */
export function GlobalActions({ horizontal }: { horizontal?: boolean }) {
  // A side rail is 44px at every width (see Rail): 32px squares, centred.
  const large = !horizontal;

  return (
    <>
      {!horizontal && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Workspace"
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg [&_svg]:size-4",
              )}
            >
              <LayoutPanelTop />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="right" className="w-56">
            <WorkspaceMenuItems />
            <DropdownMenuSeparator />
            <WindowMenuItems />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <RailIconButton
        large={large}
        icon={Settings}
        label="Settings"
        onClick={() => useSession.getState().setSettingsDialogOpen(true)}
      />
    </>
  );
}

/**
 * A plain icon button for a rail's header/footer — the things that are NOT
 * surfaces (the mark, settings, export) and so must not wear the armed state
 * that means "this surface is open".
 */
function RailIconButton({
  icon: Icon,
  label,
  accent,
  disabled,
  large,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  accent?: boolean;
  disabled?: boolean;
  /** A side rail's 32px square; the bottom bar's buttons are 28px. */
  large?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md",
            large ? "size-8 [&_svg]:size-4" : "size-7 [&_svg]:size-3.5",
            accent
              ? "group/action material-action text-primary transition-[filter] hover:brightness-110"
              : "text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40",
          )}
        >
          <Icon className={accent ? "action-arrow" : undefined} />
        </button>
      </TooltipTrigger>
      <TooltipContent side={accent ? "left" : "right"}>{label}</TooltipContent>
    </Tooltip>
  );
}
