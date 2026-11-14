"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Link2, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";
import { TOOL_ACCENT } from "./Toolbar";

/**
 * The one question the pen cannot answer for you: your stroke ended on another
 * path — should the two become one, or just touch?
 *
 * It appears AT the junction, and nothing has been written yet when it does.
 * That is the whole design: both answers are a single forward operation, so
 * there is no half-applied state to undo, no inverse op to keep in sync, and
 * whichever you pick lands as one clean history entry.
 *
 * It is also its own escape route. The remembered answer is pre-focused, so ⏎
 * repeats your last decision without reading anything; Esc takes the
 * non-committal one; and "Don't ask again" turns the prompt into a preference
 * you can still find on the pen toolbar. A prompt you cannot turn off is a
 * prompt that eventually gets clicked without being read.
 */
export function PenJunctionPrompt({
  at,
  connect,
  onChoose,
}: {
  /** Viewport position of the junction — the prompt sits just below it. */
  at: { x: number; y: number };
  /** The remembered answer: pre-focused, so ⏎ repeats it. */
  connect: boolean;
  /** `always` writes the choice back as the new default and stops the asking. */
  onChoose: (connect: boolean, always: boolean) => void;
}) {
  const [always, setAlways] = React.useState(false);
  const preferred = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    preferred.current?.focus();
  }, []);

  return createPortal(
    <div
      className="material-glass fixed z-61 w-56 p-1.5"
      style={{
        left: Math.min(Math.max(8, at.x - 112), window.innerWidth - 232),
        top: Math.min(at.y + 16, window.innerHeight - 130),
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onChoose(false, always);
        }
      }}
    >
      <div className="px-1.5 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">Paths meet here</div>
      <div className="flex flex-col gap-0.5">
        <Choice
          ref={connect ? preferred : undefined}
          preferred={connect}
          onPick={() => onChoose(true, always)}
          icon={<Link2 />}
          label="Connect"
          hint="Fuse the two runs into one path"
        />
        <Choice
          ref={connect ? undefined : preferred}
          preferred={!connect}
          onPick={() => onChoose(false, always)}
          icon={<Unlink />}
          label="Keep apart"
          hint="Leave the point sitting on top, unattached"
        />
      </div>
      <label className="mt-1 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground">
        <input
          type="checkbox"
          checked={always}
          onChange={(e) => setAlways(e.target.checked)}
          className="size-3 accent-[var(--pen-accent)]"
          style={{ ["--pen-accent" as string]: TOOL_ACCENT.pen }}
        />
        Don&rsquo;t ask again
      </label>
    </div>,
    document.body,
  );
}

/**
 * One answer. Its own component, not one made inside the prompt: a component
 * created during render is a NEW type every render, so ticking "Don't ask
 * again" used to remount both buttons and drop the focus that makes ⏎ repeat
 * the remembered answer.
 */
function Choice({
  ref,
  preferred,
  onPick,
  icon,
  label,
  hint,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  /** The remembered answer — outlined, and the one ⏎ presses. */
  preferred: boolean;
  onPick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onPick}
      title={hint}
      className={cn(
        "flex flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none",
        "transition-[background-color,color,box-shadow] duration-150 [&_svg]:size-4 [&_svg]:shrink-0",
        "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        preferred ? "text-foreground" : "text-muted-foreground",
      )}
      style={preferred ? { boxShadow: `inset 0 0 0 1px ${TOOL_ACCENT.pen}66` } : undefined}
    >
      {icon}
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}
