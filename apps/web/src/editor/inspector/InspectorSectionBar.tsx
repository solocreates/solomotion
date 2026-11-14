"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TabIndicator, useTabIndicator } from "@/components/ui/tab-indicator";
import { useSession } from "../state/session";
import { TabFace } from "../workspace/TabStrip";
import { useTabFit } from "../workspace/use-tab-fit";
import styles from "../workspace/workspace.module.css";
import { useInspectorSections } from "./inspector-sections";

const GAP = 2;

/**
 * PROPERTIES' SECTION BAR — Design · Effects · Animate · Sound … at the top of
 * the panel, for wherever Properties lives WITHOUT a rail to carry them: a
 * region's tab strip, a floating window, an OS window. On a rail the rail is
 * this bar (one hook, `useInspectorSections`), so the panel never shows both.
 *
 * Same tabs as a region strip (names, fold to icons from the end, the shown
 * section never folds, then scroll), one level down: the strip says WHICH
 * editor, this says which part of it. Not draggable — sections are Properties'
 * own, they move with it.
 */
export function InspectorSectionBar() {
  const sections = useInspectorSections();
  const keys = sections.map((s) => s.key);
  const active = sections.find((s) => s.active)?.key ?? keys[0] ?? "";
  const { scroller, measure, collapsed, fade, onScroll } = useTabFit(keys, active, GAP);
  useTabIndicator(scroller);
  if (sections.length < 2) return null;
  return (
    <div className={styles.sectionBar}>
      <div
        ref={scroller}
        role="tablist"
        aria-label="Properties sections"
        data-part="tabs"
        className={styles.tabScroller}
        style={{ gap: GAP }}
        data-fade-start={fade.start || undefined}
        data-fade-end={fade.end || undefined}
        onScroll={onScroll}
      >
        <TabIndicator />
        {sections.map((s, i) => {
          const folded = !!collapsed[i];
          const Icon = s.icon;
          const btn = (
            <button
              type="button"
              role="tab"
              aria-selected={s.active}
              aria-label={s.name}
              data-tab={s.key}
              data-collapsed={folded || undefined}
              data-part="tab"
              className={cn(styles.tab, styles.sectionTab)}
              onClick={() => s.key !== "project" && useSession.getState().setInspectorTab(s.key)}
            >
              <Icon />
              {!folded && <span>{s.name}</span>}
            </button>
          );
          return (
            <Tooltip key={s.key}>
              <TooltipTrigger asChild>{btn}</TooltipTrigger>
              <TooltipContent side="bottom">{folded ? s.name : s.hint}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div ref={measure} aria-hidden className={styles.tabMeasure}>
        {sections.map((s) => (
          <TabFace key={s.key} icon={s.icon} name={s.name} data-measure={s.key} />
        ))}
        <TabFace icon={sections[0]!.icon} name="" collapsed data-measure="__icon" />
      </div>
    </div>
  );
}
