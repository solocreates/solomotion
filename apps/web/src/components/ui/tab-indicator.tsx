"use client";

import * as React from "react";

/**
 * THE TAB INDICATOR — one element per tab row, placed under the active tab and
 * slid there when it changes. The playhead dialect draws it as the timeline's
 * 2px accent bar; other dialects hide it and paint the tab instead (`parts.css`).
 *
 * The hook needs no "which tab is active" plumbing: it watches the row for the
 * tab that SAYS it is active (`data-state="active"` from Radix, or
 * `aria-selected="true"`), so every strip in the app — a region's tabs,
 * Properties' sections, a comp's tabs, a dialog's tabs — shares it by
 * rendering `<TabIndicator />` in its row and calling this once.
 */
export function useTabIndicator(rowRef: React.RefObject<HTMLElement | null>): void {
  // The row may mount after the hook does (a bar that renders null until it
  // has two sections), so follow the element, not the first render.
  const [row, setRow] = React.useState<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (rowRef.current !== row) setRow(rowRef.current);
  });
  React.useLayoutEffect(() => {
    if (!row) return;
    let first = true;
    const place = () => {
      const tab = row.querySelector<HTMLElement>('[data-part="tab"]:is([data-state="active"], [aria-selected="true"])');
      if (!tab) {
        row.style.setProperty("--tab-w", "0px");
        return;
      }
      // offsetLeft is in the row's scrolled content, so the bar scrolls with
      // its tab inside a strip that overflows.
      row.style.setProperty("--tab-x", `${tab.offsetLeft}px`);
      row.style.setProperty("--tab-w", `${tab.offsetWidth}px`);
      if (first) {
        // The first placement must not slide in from the left edge.
        row.dataset.measured = "0";
        requestAnimationFrame(() => (row.dataset.measured = "1"));
        first = false;
      }
    };
    place();
    const mo = new MutationObserver(place);
    mo.observe(row, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "aria-selected", "data-collapsed"] });
    const ro = new ResizeObserver(place);
    ro.observe(row);
    for (const el of Array.from(row.children)) ro.observe(el);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [row]);
}

export function TabIndicator() {
  return <span aria-hidden data-el="indicator" />;
}
