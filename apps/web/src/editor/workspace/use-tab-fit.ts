"use client";

import * as React from "react";
import { fitTabs } from "./list-insert";

/**
 * Names that fit, icons where they do not — the runtime half of `fitTabs`,
 * shared by every horizontal tab row (a region's tab strip, Properties'
 * section bar).
 *
 * The caller renders two things: the real row (`scroller`, its tabs tagged
 * `data-tab=<key>`) and an invisible MEASURING row (`measure`) holding every
 * tab at full width tagged `data-measure=<key>`, plus one icon-only tab tagged
 * `data-measure="__icon"`. Widths are read from that row, never guessed, and
 * re-read by ResizeObserver so late fonts and column resizes re-fit. Past the
 * fold the row scrolls: `fade` says which side is clipped, and the active
 * tab is kept in view.
 */
export function useTabFit(keys: readonly string[], active: string, gap: number) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const measure = React.useRef<HTMLDivElement>(null);
  const [widths, setWidths] = React.useState<{ full: Record<string, number>; icon: number }>({ full: {}, icon: 0 });
  const [room, setRoom] = React.useState(0);
  const keyStr = keys.join(",");

  React.useLayoutEffect(() => {
    const row = measure.current;
    const sc = scroller.current;
    if (!row || !sc) return;
    const read = () => {
      const full: Record<string, number> = {};
      let icon = 0;
      for (const el of Array.from(row.children) as HTMLElement[]) {
        const id = el.dataset.measure!;
        const w = el.getBoundingClientRect().width;
        if (id === "__icon") icon = w;
        else full[id] = w;
      }
      setWidths({ full, icon });
      setRoom(sc.clientWidth);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(row);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [keyStr]);

  const fit = React.useMemo(() => {
    if (!room || !widths.icon) return { collapsed: keys.map(() => false), overflow: false };
    return fitTabs(
      keys.map((k) => widths.full[k] ?? widths.icon),
      keys.map(() => widths.icon),
      keys.indexOf(active),
      room,
      gap,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyStr, active, room, widths, gap]);

  const [fade, setFade] = React.useState({ start: false, end: false });
  const onScroll = React.useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    const start = sc.scrollLeft > 1;
    const end = sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 1;
    setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
  }, []);

  React.useLayoutEffect(() => {
    const sc = scroller.current;
    const el = sc?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(active)}"]`);
    if (sc && el) {
      // By hand: scrollIntoView would scroll every ancestor, the shell included.
      if (el.offsetLeft < sc.scrollLeft) sc.scrollLeft = el.offsetLeft;
      else if (el.offsetLeft + el.offsetWidth > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = el.offsetLeft + el.offsetWidth - sc.clientWidth;
    }
    onScroll();
  }, [active, fit, onScroll]);

  return { scroller, measure, collapsed: fit.collapsed, fade, onScroll };
}
