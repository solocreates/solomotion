"use client";

import { product } from "@/editor/product";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Bug, Download, LayoutPanelTop, Redo2, Settings, Undo2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppMenu, WindowMenuItems } from "../menus/AppMenu";
import { ExportMenu } from "../export/ExportMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Search } from "lucide-react";
import { useLayout } from "../workspace/store";
import { regions, setCollapsed } from "../workspace/layout-tree";
import type { EditorId } from "../workspace/editor-registry";
import { WorkspaceMenuItems } from "../workspace/WorkspaceMenu";
import { useHistoryInfo } from "../state/document-context";
import { useSession } from "../state/session";
import { resolvePanel, usePanels } from "../state/panels";
import { useIsCompact } from "../state/use-shell-density";
import { useInspectorSections } from "../inspector/inspector-sections";
import { Rail, type RailItem } from "./Rail";
import { panelDef } from "./panel-registry";
import { redoActive, undoActive } from "../state/history";

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
      header={
        <>
          <AppMenu />
          <SearchButton />
        </>
      }
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
      // Minimal by design: this rail is pressed against the property panel, so
      // every pixel it takes is one the panel loses.
      variant="compact"
      // The button opens the export MENU, not the dialog directly — picking
      // what to export is a real choice (composition, this layer, Lottie, a
      // PNG of the current frame, a slice file) and the dialog only covers
      // some of them.
      header={<ExportButton />}
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
 * SEARCH, under the mark (D10). The palette has always existed behind ⌘K and
 * nobody found it; a door at the top of the rail is how it gets found.
 */
function SearchButton() {
  const large = !useIsCompact();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Search"
          onClick={() => useSession.getState().setCommandPaletteOpen(true)}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            large ? "mt-1 size-10 [&_svg]:size-5" : "size-8 [&_svg]:size-4",
          )}
        >
          <Search />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        Search <span className="ml-1 text-muted-foreground">⌘K</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Export — the one accent action in the app's chrome, on both rails and the
 *  compact dock. */
export function ExportButton() {
  return (
    <ExportMenu>
      <button
        type="button"
        aria-label="Export"
        className="group/action flex size-7 shrink-0 items-center justify-center rounded-md material-action text-primary transition-[filter] hover:brightness-110 [&_svg]:size-3.5"
      >
        <Download className="action-arrow" />
      </button>
    </ExportMenu>
  );
}

/**
 * UNDO · REDO · WORKSPACE · SETTINGS — the controls that belong to the app
 * rather than to any one surface.
 *
 * They anchor the left rail's foot when there is a left rail, and the compact
 * dock's end when there is not. One component because they are one GROUP: a
 * second copy in the dock is a second place to remember that undo is disabled
 * when there is nothing to undo, and the copy is the one that would forget.
 *
 * The dock keeps only what it has no other way to reach. Undo, redo and the
 * workspace presets all have a second door on a narrow screen — two- and
 * three-finger tap (`docs/responsive-and-gestures.md`) and the app menu, which
 * is at the other end of this same bar — and a dock that spends 90 of its 375
 * pixels on doors that already exist elsewhere leaves four of nine surfaces
 * reachable without a swipe. Duplicating a control is only free when there is
 * room for it.
 */
export function GlobalActions({ horizontal }: { horizontal?: boolean }) {
  const history = useHistoryInfo();
  // The rail narrows itself when the shell does (see Rail); its buttons have to
  // follow, or four 40px squares sit in a 44px column with no margin.
  const large = !useIsCompact() && !horizontal;

  return (
    <>
      {!horizontal && (
        <>
          <RailIconButton
            large={large}
            icon={Undo2}
            label={history.undoLabel ? `Undo ${history.undoLabel}` : "Undo"}
            disabled={!history.canUndo}
            onClick={() => undoActive()}
          />
          <RailIconButton
            large={large}
            icon={Redo2}
            label={history.redoLabel ? `Redo ${history.redoLabel}` : "Redo"}
            disabled={!history.canRedo}
            onClick={() => redoActive()}
          />
          <span aria-hidden className="my-1 h-px w-5 shrink-0 bg-border" />
        </>
      )}
      {!horizontal && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Workspace"
              className={cn(
                "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                large ? "size-10 [&_svg]:size-5" : "size-8 [&_svg]:size-4",
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
      {/* Beside Settings: both are about the app, not the document. */}
      <RailIconButton large={large} icon={Bug} label="Report a bug" onClick={() => product.feedback.open("bug")} />
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
  /**
   * Sized for the WIDE (left) rail. A 28px button centred in a 64px column
   * reads as a stray dot; in the 44px right rail the same button is correctly
   * proportioned. The difference belongs to the rail, not to the button, which
   * is why this is a prop rather than a new size everywhere.
   */
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
            large ? "size-10 [&_svg]:size-5" : "size-7 [&_svg]:size-3.5",
            accent
              ? "group/action material-action text-primary transition-[filter] hover:brightness-110"
              : "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
          )}
        >
          <Icon className={accent ? "action-arrow" : undefined} />
        </button>
      </TooltipTrigger>
      <TooltipContent side={accent ? "left" : "right"}>{label}</TooltipContent>
    </Tooltip>
  );
}
