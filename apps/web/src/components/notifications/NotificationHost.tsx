"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  useNotifications,
  type NotificationCorner,
  type NotificationEntry,
  type NotificationTone,
} from "./notification-store";

/**
 * Renders the notification bus (see notification-store). Mount ONCE near the app
 * root. Cards group by corner, each corner an independent fixed stack; the whole
 * layer is pointer-events-none so it never eats clicks, only the cards do.
 */
export function NotificationHost() {
  const items = useNotifications((s) => s.items);
  if (items.length === 0) return null;

  const byCorner = new Map<NotificationCorner, NotificationEntry[]>();
  for (const item of items) {
    const list = byCorner.get(item.corner) ?? [];
    list.push(item);
    byCorner.set(item.corner, list);
  }

  return (
    <>
      {[...byCorner.entries()].map(([corner, list]) => (
        <div
          key={corner}
          className={cn(
            "pointer-events-none fixed z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2",
            CORNER_POSITION[corner],
            // Bottom corners grow upward so the newest card hugs the corner.
            corner.startsWith("bottom") ? "flex-col-reverse" : "flex-col",
          )}
        >
          {list.map((item) => (
            <NotificationCard key={item.id} entry={item} />
          ))}
        </div>
      ))}
    </>
  );
}

const CORNER_POSITION: Record<NotificationCorner, string> = {
  "top-left": "top-4 left-4 items-start",
  "top-center": "top-4 left-1/2 -translate-x-1/2 items-center",
  "top-right": "top-4 right-4 items-end",
  "bottom-left": "bottom-4 left-4 items-start",
  "bottom-center": "bottom-4 left-1/2 -translate-x-1/2 items-center",
  "bottom-right": "bottom-4 right-4 items-end",
};

/** Accent bar / icon tint per tone — pulls straight from the design tokens. */
const TONE_ACCENT: Record<NotificationTone, string> = {
  default: "before:bg-border",
  brand: "before:bg-primary",
  success: "before:bg-emerald-500",
  warning: "before:bg-amber-500",
  destructive: "before:bg-destructive",
};

const TONE_ICON: Record<NotificationTone, string> = {
  default: "text-muted-foreground",
  brand: "text-primary",
  success: "text-emerald-500",
  warning: "text-amber-500",
  destructive: "text-destructive",
};

function NotificationCard({ entry }: { entry: NotificationEntry }) {
  const dismiss = useNotifications((s) => s.dismiss);
  const remove = useNotifications((s) => s.remove);
  // enter/leave animation: mount hidden, flip to shown next frame; when the
  // store marks the entry `leaving`, animate out and remove on transition end.
  const [shown, setShown] = React.useState(false);
  const fromRight = entry.corner.endsWith("right");
  const fromBottom = entry.corner.startsWith("bottom");

  React.useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Auto-dismiss timer (sticky when no duration).
  React.useEffect(() => {
    if (!entry.duration || entry.leaving) return;
    const t = setTimeout(() => dismiss(entry.id), entry.duration);
    return () => clearTimeout(t);
  }, [entry.duration, entry.leaving, entry.id, dismiss]);

  const visible = shown && !entry.leaving;
  const offset = entry.leaving || !shown ? (fromRight ? "translate-x-3" : fromBottom ? "translate-y-3" : "-translate-y-3") : "translate-x-0 translate-y-0";

  return (
    <div
      role="status"
      aria-live="polite"
      onTransitionEnd={(e) => {
        if (e.propertyName === "opacity" && entry.leaving) remove(entry.id);
      }}
      className={cn(
        "material-glass pointer-events-auto relative w-full overflow-hidden text-card-foreground",
        "pl-4 pr-2.5 py-3 transition-all duration-200 ease-out",
        // left accent bar
        "before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-['']",
        TONE_ACCENT[entry.tone],
        visible ? "opacity-100" : "opacity-0",
        offset,
      )}
    >
      <div className="flex items-start gap-3">
        {entry.icon != null && (
          <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", TONE_ICON[entry.tone])}>
            {entry.icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-snug">{entry.title}</div>
          {entry.description != null && (
            <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {entry.description}
            </div>
          )}
          {entry.actions && entry.actions.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {entry.actions.map((action, i) => (
                <Button
                  key={i}
                  size="sm"
                  variant={action.variant ?? (i === 0 ? "default" : "ghost")}
                  className="h-7 px-2.5 text-xs"
                  onClick={() => {
                    action.onClick();
                    if (!action.keepOpen) dismiss(entry.id);
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        {entry.dismissible && (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(entry.id)}
            className="-mr-0.5 -mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
