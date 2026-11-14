import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * THE EMPTY STATE — an icon, one line, one action (v5 redesign, D9). Nothing else.
 *
 * Every empty panel used to write its own: a paragraph explaining what the
 * button beside it already offers, a second line of hints, sometimes two
 * buttons of equal weight. That is the "wall of grey text" Shayan kept
 * pointing at. One block means one shape everywhere, and the shape has no
 * slot for a paragraph — so nobody can add one.
 *
 * `title` is the ONE line ("No layers yet"). Explanation, if any is needed,
 * goes on the action's tooltip (`hint`), never under the title.
 */
export function EmptyState({
  icon,
  title,
  action,
  className,
  compact,
}: {
  /** A lucide icon element. Drawn at 20px in faint ink. */
  icon?: React.ReactNode;
  /** One line. Sentence case, no full stop. */
  title: React.ReactNode;
  /** One action. */
  action?: { label: string; onClick: () => void; icon?: React.ReactNode; hint?: string };
  className?: string;
  /** Tighter vertical rhythm for a short region (a popover, a list in a card). */
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-4 text-center",
        compact ? "py-4" : "py-8",
        className,
      )}
    >
      {icon && <span className="text-fg-faint [&_svg]:size-5 [&_svg]:stroke-[1.5]">{icon}</span>}
      <p className="text-body text-fg-muted">{title}</p>
      {action && (
        <Button variant="secondary" size="sm" className="mt-1" onClick={action.onClick} title={action.hint}>
          {action.icon}
          {action.label}
        </Button>
      )}
    </div>
  );
}
