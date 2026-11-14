"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TabIndicator, useTabIndicator } from "@/components/ui/tab-indicator";
import { HELD_DRAG_SURFACE } from "../input/use-multi-touch";
import { editorIcon } from "../panels/panel-registry";
import { editorMeta, type EditorId } from "./editor-registry";
import { changeEditor, setActive, type RegionNode } from "./layout-tree";
import { useTabFit } from "./use-tab-fit";
import { beginEditorDrag, useDraggingEditor, useListPreview } from "./drag";
import { EditorSwitcher } from "./EditorSwitcher";
import { RegionMenuItems } from "./RegionMenu";
import { useLayout } from "./store";
import { useFlip } from "./use-flip";
import styles from "./workspace.module.css";

/** Px between tabs — the measured fit and the CSS gap must agree. */
const TAB_GAP = 2;

/**
 * A REGION'S TAB STRIP — the horizontal presentation of the same ordered
 * editor list a rail draws vertically (`layout-tree.ts`, "one model, two
 * presentations"). Every tab is NAMED, as in Photoshop, After Effects and
 * Blender: a strip of icons asks you to learn a pictogram per editor.
 *
 * When names do not fit, inactive tabs fold to their icon from the END first
 * and the active tab never folds (`fitTabs`, on MEASURED widths); past that
 * the strip scrolls with a fade at the clipped side.
 *
 * Drag a tab a little and it SORTS: the strip is a drop list, so the tab
 * takes the slot the pointer picks and its siblings slide (FLIP). Pull it
 * ~16px out of the strip (or a quarter-tab past an end) and the same drag
 * session tears it out into a dock drag — one recognizer, `beginEditorDrag`.
 * Any editor dragged onto the strip joins it the same way, as a live tab.
 *
 * Middle-click closes a tab (Close already exists in its menu). The strip is
 * a horizontal scroller, so on touch a tab lifts by holding (`defer`) and a
 * swipe still scrolls.
 */
export function RegionTabStrip({ region }: { region: RegionNode }) {
  const listId = `strip:${region.id}`;
  const preview = useListPreview(listId);
  const dragging = useDraggingEditor();

  // The list AS IT WILL BE: the badge (or the tab being sorted) at its slot.
  let tabs: EditorId[] = region.editors;
  if (preview) {
    const rest = tabs.filter((e) => e !== preview.editor);
    rest.splice(Math.min(preview.slot, rest.length), 0, preview.editor);
    tabs = rest;
  }
  const active = preview ? preview.editor : region.active;

  const { scroller, measure, collapsed, fade, onScroll } = useTabFit(tabs, active, TAB_GAP);
  useFlip(scroller);
  useTabIndicator(scroller);

  return (
    <div
      className={styles.regionHeader}
      data-dock-band={listId}
      data-dock-kind="strip"
      data-dock-region={region.id}
      onPointerDown={(e) => {
        // The strip's empty space moves the region's active editor.
        const t = e.target as HTMLElement;
        if (t === e.currentTarget || t === scroller.current) beginEditorDrag(e, region.active);
      }}
    >
      <div
        ref={scroller}
        role="tablist"
        aria-orientation="horizontal"
        data-part="tabs"
        className={styles.tabScroller}
        style={{ gap: TAB_GAP }}
        data-dock-list={listId}
        data-dock-axis="x"
        data-fade-start={fade.start || undefined}
        data-fade-end={fade.end || undefined}
        onScroll={onScroll}
      >
        <TabIndicator />
        {tabs.map((editor, i) => (
          <Tab
            key={editor}
            editor={editor}
            regionId={region.id}
            active={editor === active}
            collapsed={!!collapsed[i]}
            badge={!!preview && editor === preview.editor}
            lifted={!preview && dragging === editor}
          />
        ))}
      </div>
      <EditorSwitcher
        current={region.active}
        align="end"
        onPick={(id) => {
          useLayout.getState().apply((w) => changeEditor(w, region.id, id));
          useLayout.getState().reveal(id);
        }}
      >
        <button type="button" aria-label="Change editor" className={styles.stripButton}>
          <ChevronDown />
        </button>
      </EditorSwitcher>
      <div ref={measure} aria-hidden className={styles.tabMeasure}>
        {tabs.map((editor) => (
          <TabFace key={editor} icon={editorIcon(editor)} name={editorMeta(editor)?.name ?? editor} data-measure={editor} />
        ))}
        <TabFace icon={editorIcon(tabs[0] ?? "layers")} name="" collapsed data-measure="__icon" />
      </div>
    </div>
  );
}

/** A tab's face for the measuring row — the same class as the real tab. */
export function TabFace({
  icon: Icon,
  name,
  collapsed,
  ...rest
}: { icon: React.ComponentType<{ className?: string }>; name: string; collapsed?: boolean } & React.HTMLAttributes<HTMLSpanElement> & {
  "data-measure"?: string;
}) {
  return (
    <span className={styles.tab} data-collapsed={collapsed || undefined} {...rest}>
      <Icon />
      {!collapsed && <span>{name}</span>}
    </span>
  );
}

function Tab({
  editor,
  regionId,
  active,
  collapsed,
  badge,
  lifted,
}: {
  editor: EditorId;
  regionId: string;
  active: boolean;
  collapsed: boolean;
  /** The dragged editor shown at its drop slot — inert until the drop. */
  badge: boolean;
  /** Its editor is being dragged somewhere else. */
  lifted: boolean;
}) {
  const Icon = editorIcon(editor);
  const meta = editorMeta(editor);
  const name = meta?.name ?? editor;
  const btn = (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={name}
      data-flip={editor}
      data-tab={editor}
      data-dock-item={editor}
      data-dock-region={regionId}
      data-collapsed={collapsed || undefined}
      data-lifted={lifted || undefined}
      data-part="tab"
      className={cn(styles.tab, HELD_DRAG_SURFACE, badge && "pointer-events-none")}
      onPointerDown={(e) => {
        // Middle: no autoscroll puck — the release closes the tab.
        if (e.button === 1) {
          e.preventDefault();
          return;
        }
        beginEditorDrag(e, editor);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && meta?.closable) useLayout.getState().close(editor);
      }}
      onClick={() => useLayout.getState().apply((w) => setActive(w, regionId, editor))}
    >
      <Icon />
      {!collapsed && <span>{name}</span>}
    </button>
  );
  if (badge) return btn;
  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>{btn}</ContextMenuTrigger>
        </TooltipTrigger>
        {collapsed && <TooltipContent side="bottom">{name}</TooltipContent>}
      </Tooltip>
      <ContextMenuContent>
        <RegionMenuItems editor={editor} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
