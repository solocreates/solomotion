"use client";

import * as React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, GripVertical, SlidersHorizontal, Trash2, type LucideIcon } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { Clip } from "@solomotion/core";
import { cn } from "@/lib/utils";
import { KeyedDot, SwitchKeyMenu } from "./keyframe-controls";
import { KeyframeMenuItems, type KeyTarget } from "./keyframe-menu-items";

/**
 * The ONE effect-card shell — the chrome shared by the whole-layer stack and
 * the per-glyph text stack.
 *
 * A card is a TITLE ROW: drag grip, name, keyframe diamond, settings, enable,
 * delete. Its fields live in the floating effect editor (one click on the row,
 * or the settings icon), because a stack of eight cards each unrolling ten
 * fields is a canyon you scroll instead of a panel you read — and rich effects
 * (Liquid glass has thirty fields plus a live preview) never fit a sidebar at
 * all. Same reason Figma puts effect settings in a popover; ours is a real
 * window you can move, resize and pin.
 *
 * Sortable relies on an ancestor <SortableContext>; when `sortable` is false the
 * grip is hidden but the hook stays wired (single-item lists don't drag).
 */
export interface EffectCardShellProps {
  id: string;
  label: string;
  icon: LucideIcon;
  enabled: boolean;
  /** Show the drag grip (list has >1 card and an ancestor SortableContext). */
  sortable?: boolean;
  /** Momentary highlight (e.g. just-added / focused card). */
  flash?: boolean;
  /** This card's editor window is the one currently open. */
  open?: boolean;
  /** The per-card keyframe control (keys every field of this effect at once). */
  keyControl?: React.ReactNode;
  /** Right-click menu items; when omitted the card has no context menu. */
  contextItems?: React.ReactNode;
  /**
   * Makes the EYE keyframable. `enabled` is an ordinary discrete property
   * (`lfx.<id>.enabled`, `afx.<id>.enabled`), so given the clip that owns the
   * track and the path, the eye gains the same right-click keyframe menu every
   * diamond has and wears a dot once it is animated. The WRITE still goes
   * through `onEnable`, because only the section knows how an edit fans across
   * a multi-selection — this prop adds reading and keying, not a second writer.
   */
  enableKey?: { clip: Clip; property: string };
  /**
   * Every path this card animates — the same list its group diamond keys.
   *
   * Right-clicking the CARD is how you reach the whole effect, and until now it
   * offered "settings" and "delete" while the effect's animation was only
   * reachable by hunting for the diamond in the title row. The verbs are the
   * shared ones, so the card, the diamond and every field inside the editor all
   * say the same thing about the same tracks.
   */
  keyTargets?: { clip: Clip; targets: KeyTarget[] };
  /** Part of a multi-card selection (marquee / shift / cmd-click). */
  selected?: boolean;
  /** A short state word after the name — "Mixed" when the selection disagrees. */
  badge?: string;
  /** Selection + marquee wiring, spread onto the card's root element. */
  rootProps?: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>;
  onOpen: () => void;
  onEnable: (enabled: boolean) => void;
  onRemove: () => void;
  /** Before the icon — a look's disclosure chevron. */
  lead?: React.ReactNode;
  /** Before the key diamond — a look's mix and swap. */
  trailing?: React.ReactNode;
  /** A member of a look: inset under its parent card. */
  indent?: boolean;
  /** A line under the title row — a look's mix. */
  below?: React.ReactNode;
}

export function EffectCardShell({
  id,
  label,
  icon: Icon,
  enabled,
  sortable,
  flash,
  open,
  keyControl,
  contextItems,
  enableKey,
  keyTargets,
  selected,
  badge,
  rootProps,
  onOpen,
  onEnable,
  onRemove,
  lead,
  trailing,
  indent,
  below,
}: EffectCardShellProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const cardRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (flash) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [flash]);

  const card = (
    <div
      ref={(el) => {
        setNodeRef(el);
        cardRef.current = el;
      }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...rootProps}
      className={cn(
        "group/card rounded-md border border-border/70 bg-secondary/30 px-2 transition-colors",
        !below && "flex h-9 items-center gap-1",
        indent && "ml-4",
        !enabled && "opacity-60",
        open && "border-primary/60 bg-primary/5",
        // Selection is a RING, never a border swap: the border already carries
        // "this card's editor is open", and two states fighting for one channel
        // is how a panel stops being readable.
        selected && "ring-2 ring-primary/50",
        isDragging && "relative z-10 shadow-lg",
        flash && "border-primary/70 ring-2 ring-primary/40",
      )}
    >
      <Row wrap={!!below}>
      {sortable && (
        <button
          type="button"
          aria-label="Reorder effect"
          className="-ml-1 flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/50 hover:text-foreground active:cursor-grabbing [&_svg]:size-3.5"
          {...attributes}
          {...listeners}
        >
          <GripVertical />
        </button>
      )}
      {lead}
      <Icon className={cn("size-4 shrink-0", open ? "text-primary" : "text-primary/80")} />
      {/* The whole name is the button — a big, obvious target, like Figma. A
          MODIFIED click is a selection gesture, though, never an activation:
          ⇧-clicking down a stack must extend the range, not open six editors. */}
      <button
        type="button"
        onClick={(e) => {
          if (e.shiftKey || e.metaKey || e.ctrlKey) return;
          onOpen();
        }}
        title="Open effect settings"
        className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold text-foreground/90 hover:text-foreground"
      >
        {label}
      </button>
      {badge && (
        <span className="shrink-0 rounded bg-muted/60 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {badge}
        </span>
      )}
      {trailing}
      {keyControl}
      <IconButton label="Effect settings" active={open} onClick={onOpen}>
        <SlidersHorizontal />
      </IconButton>
      <EnableEye enabled={enabled} onEnable={onEnable} enableKey={enableKey} />
      <IconButton label="Remove effect" danger onClick={onRemove}>
        <Trash2 />
      </IconButton>
      </Row>
      {below}
    </div>
  );

  const keyItems = keyTargets && keyTargets.targets.length > 0 ? keyTargets : null;
  if (!contextItems && !keyItems) return card;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {contextItems}
        {keyItems && (
          <>
            {contextItems && <ContextMenuSeparator />}
            <KeyframeMenuItems clip={keyItems.clip} targets={keyItems.targets} />
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The title row — its own line only when the card has one under it. */
function Row({ wrap, children }: { wrap: boolean; children: React.ReactNode }) {
  return wrap ? <div className="flex h-9 items-center gap-1">{children}</div> : <>{children}</>;
}

/**
 * The card's eye. Plain when the switch is a static flag; wrapped in the shared
 * keyframe menu (and dotted) when it can move in time.
 */
function EnableEye({
  enabled,
  onEnable,
  enableKey,
}: {
  enabled: boolean;
  onEnable: (v: boolean) => void;
  enableKey?: { clip: Clip; property: string };
}) {
  const eye = (
    <IconButton label={enabled ? "Disable" : "Enable"} onClick={() => onEnable(!enabled)}>
      {enabled ? <Eye /> : <EyeOff />}
      {enableKey && enableKey.clip.keyframes.some((t) => t.property === enableKey.property) && <KeyedDot />}
    </IconButton>
  );
  if (!enableKey) return eye;
  return (
    // The eye sits INSIDE the card's own context menu, so its right-click has to
    // stop bubbling or the card's menu (delete, copy, paste) wins and the
    // keyframe verbs are unreachable. The inner trigger has already fired by the
    // time this runs — the event only stops travelling upward.
    <span onContextMenu={(e) => e.stopPropagation()} className="contents">
      <SwitchKeyMenu clip={enableKey.clip} property={enableKey.property} on={enabled}>
        {eye}
      </SwitchKeyMenu>
    </span>
  );
}

/**
 * Forwards its ref and every extra prop, because Radix `asChild` (the keyframe
 * menu on the eye) merges its handlers onto the CHILD element — a component
 * that quietly drops them renders a control whose right-click does nothing,
 * with no error to find it by.
 */
const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; danger?: boolean }
>(function IconButton({ children, label, active, danger, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cn(
        "relative flex size-6 shrink-0 items-center justify-center rounded transition-colors [&_svg]:size-3.5",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground",
        danger && "hover:text-destructive",
        className,
      )}
    >
      {children}
    </button>
  );
});
