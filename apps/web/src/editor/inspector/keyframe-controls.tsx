"use client";

import * as React from "react";
import { useClipHost } from "./clip-host";
import { type Clip, type KeyframeValue } from "@solomotion/core";
import { ChevronLeft, ChevronRight, Diamond } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useSession } from "../state/session";
import { useDocStore } from "../state/document-context";
import { propertyLinkRequest, whipOnDrag } from "../pick/property-link";
import { useClipUpdater } from "./use-clip-updater";
import { commitProperty, useEffectiveValue } from "./animatable";
import {
  KeyframeMenuItems,
  useKeyframeState,
  useKeyframeToggle,
  type KeyTarget,
} from "./keyframe-menu-items";
import { DrivenKeyframeStop } from "../binding/driven-keyframe-stop";
import { UnitChip } from "./unit-control";
import { PropertyBindingItems, usePropertyPanelProps, type PropertyBindingProps } from "./property-binding";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { ExpressionPopoverContent } from "../expressions/ExpressionPopover";
import { VariablePickerContent } from "./variables/VariablePicker";

/**
 * Keyframe controls: every animatable property row gets a ◆ that keys the value
 * at the playhead, and a right-click menu that jumps between keys and resets
 * the track. Sections get a group diamond that keys all their properties at
 * once.
 *
 * The verbs, the state and the toggle all live in `keyframe-menu-items` — the
 * diamond is the only thing here, plus the binding half of its menu. Everything
 * below is a SKIN over that one brain.
 */

/** Which family of variable a row's current value belongs to. */
function bindingKindOf(value: KeyframeValue): "number" | "color" | "string" {
  if (typeof value === "number") return "number";
  return typeof value === "string" && /^#([0-9a-fA-F]{3,8})$/.test(value.trim()) ? "color" : "string";
}

/**
 * The diamond's right-click menu: the binding vocabulary, then the keyframe
 * verbs. It is the SAME pair of blocks `PropertyBindingMenu` puts on the field
 * itself — two hosts, one menu, so the two can never drift into offering
 * different verbs for the same property.
 */
function KeyframeMenu({
  clip,
  targets,
  state,
  onToggle,
  binding,
  children,
}: {
  clip: Clip;
  targets: KeyTarget[];
  state: ReturnType<typeof useKeyframeState>;
  /** Toggle a key at the playhead — same effect as clicking the diamond. */
  onToggle: () => void;
  /**
   * Binding for this row's property, when it has exactly one. A group diamond
   * (Position = x + y) keeps only its keyframe verbs rather than silently
   * binding half of itself.
   */
  binding?: Omit<PropertyBindingProps, "clip" | "path">;
  children: React.ReactNode;
}) {
  const [panel, setPanel] = React.useState<null | "variable" | "expression">(null);
  // See `PropertyBindingMenu`: a popover opened during the menu's dismissal is
  // closed by that same pass, so the choice is remembered and acted on after.
  const pendingPanel = React.useRef<"variable" | "expression" | null>(null);

  const bindable = binding && targets.length === 1 ? binding : null;
  const panelProps = usePropertyPanelProps(
    clip,
    targets[0]?.property ?? "",
    bindable?.kind ?? "number",
    bindable?.literal ?? 0,
    bindable?.onChange,
    () => setPanel(null),
  );

  return (
    <Popover open={panel !== null} onOpenChange={(open) => !open && setPanel(null)}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <PopoverAnchor asChild>{children}</PopoverAnchor>
        </ContextMenuTrigger>
        <ContextMenuContent
          className="min-w-52"
          onCloseAutoFocus={(event) => {
            if (!pendingPanel.current) return;
            event.preventDefault();
            setPanel(pendingPanel.current);
            pendingPanel.current = null;
          }}
        >
          {bindable && (
            <>
              <PropertyBindingItems
                clip={clip}
                path={targets[0]!.property}
                {...bindable}
                onOpenPanel={(next) => {
                  pendingPanel.current = next;
                }}
              />
              <ContextMenuSeparator />
            </>
          )}
          <KeyframeMenuItems clip={clip} targets={targets} state={state} onToggle={onToggle} />
        </ContextMenuContent>
      </ContextMenu>
      {panel === "variable" && (
        <VariablePickerContent {...panelProps} align="start" onWriteExpression={() => setPanel("expression")} />
      )}
      {panel === "expression" && <ExpressionPopoverContent {...panelProps} align="start" />}
    </Popover>
  );
}

/**
 * The diamond itself — one look for the single, ganged and group controls.
 *
 * It SPREADS `...rest`, and that is load-bearing rather than tidy. This element
 * is handed to `KeyframeMenu`'s `ContextMenuTrigger asChild`, and `asChild`
 * works by cloning the child with the trigger's own props on it — the
 * `contextmenu` handler above all. A component that names the props it wants
 * and ignores the rest silently drops them, which is exactly what happened
 * here: the right-click handler landed on nothing, the event bubbled to the
 * SECTION's Copy/Paste-properties menu, and the keyframe verbs were
 * unreachable from every ◆ in the app.
 *
 * Nothing typechecks that. `asChild` is a runtime contract, so any element
 * passed to one must be transparent to props and to `ref`.
 */
function KeyDiamond({
  active,
  hasAny,
  label,
  title,
  large,
  onClick,
  ...rest
}: {
  active: boolean;
  hasAny: boolean;
  label: string;
  title: string;
  large?: boolean;
  onClick: () => void;
} & Omit<React.ComponentProps<"button">, "onClick" | "title">) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      {...rest}
      className={cn(
        "flex size-5 items-center justify-center rounded transition-colors",
        active
          ? "text-primary"
          : hasAny
            ? "text-primary/60 hover:text-primary"
            : "text-muted-foreground/50 hover:text-foreground",
        rest.className,
      )}
    >
      <Diamond className={cn(large ? "size-3" : "size-2.5", active && "fill-primary")} strokeWidth={2.5} />
    </button>
  );
}

export interface KeyControlProps {
  clip: Clip;
  property: string;
  /** Current effective value shown in the row (used when creating a key). */
  currentValue: () => KeyframeValue;
  /** Human name for the property, used by the binding menu. Falls back to the
   *  path, which is at least unambiguous. */
  label?: string;
  /** Show the "From Nodes" chip when the property is driven (sidebar only). The
   *  node board represents drivers as WIRES, so it turns this off. Default true. */
  driverBadge?: boolean;
}

/** A host with no clock (a sound category) has nothing to key — the diamond is not there. */
export function KeyControl(props: KeyControlProps) {
  const host = useClipHost(props.clip.id);
  return host?.timeless ? null : <KeyControlBody {...props} />;
}

function KeyControlBody({ clip, property, currentValue, label, driverBadge = true }: KeyControlProps) {
  const targets = React.useMemo<KeyTarget[]>(
    () => [{ property, currentValue }],
    // `currentValue` is a fresh closure every render by construction; the PATH
    // is the identity that matters.
    [property], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const state = useKeyframeState(clip, [property]);
  const toggle = useKeyframeToggle(clip, targets, state.active);
  const store = useDocStore();

  // A driven property is OWNED by its source, so a key set here could never be
  // read. The diamond stays — disabled, tinted, and saying so — rather than
  // vanishing or silently doing nothing.
  const drivingToken = driverBadge ? clip.drivers?.[property] : undefined;
  // A size's unit sits beside its diamond, so every length field has one.
  if (drivingToken) return (
    <div className="flex items-center">
      <UnitChip clip={clip} property={property} />
      <DrivenKeyframeStop token={drivingToken} />
    </div>
  );

  return (
    <div className="flex items-center">
    <UnitChip clip={clip} property={property} />
    <div
      className={cn(
        "flex items-center",
        // Quiet until the property is animated (or the row is hovered).
        state.hasAny ? "opacity-100" : "opacity-0 transition-opacity group-hover/row:opacity-100",
      )}
    >
      <KeyframeMenu
        clip={clip}
        targets={targets}
        state={state}
        onToggle={toggle}
        binding={{
          // The row's kind is read off the value it is showing: a string that
          // parses as a colour IS a colour, which is the same rule the language
          // uses for a text literal. One rule, so a colour row offers colour
          // variables here exactly as it does in the expression editor.
          kind: bindingKindOf(currentValue()),
          label: label ?? property,
          literal: currentValue() as string | number,
        }}
      >
        <KeyDiamond
          active={state.active}
          hasAny={state.hasAny}
          label={state.active ? "Remove keyframe" : "Add keyframe"}
          title="Keyframe at playhead · drag to a layer to link · right-click for more"
          onClick={toggle}
          // Drag the ◆ onto another layer and this value follows one of its own.
          onPointerDown={(e) => whipOnDrag(e, () => propertyLinkRequest({ store, clip, path: property, label: label ?? property, owner: `link:${clip.id}/${property}` }))}
        />
      </KeyframeMenu>
    </div>
    </div>
  );
}

// ── Keyframable switches ─────────────────────────────────────────────────────

/**
 * THE keyframable on/off, for any switch in the app.
 *
 * The design choice worth stating: `enabled` is not a new kind of thing. It is
 * an ordinary animatable property of kind `discrete` — the kind that holds
 * between keys — so the eye you already click IS the keyable control, and it
 * inherits the diamond, the right-click menu, record mode, the curve editor and
 * the dope sheet without any of them learning a new concept. The alternative
 * we did not build was a second "activeness" checkbox beside the eye, which
 * would put two switches on screen meaning one thing.
 *
 * Reading is the half that must not be forgotten: the switch shows its value AT
 * THE PLAYHEAD, so an effect keyed off at 00:04 dims its card at 00:04 rather
 * than only in the render.
 */
export function useSwitchKey(
  clip: Clip | undefined,
  property: string,
  base: boolean,
  undoLabel = "Toggle",
): { on: boolean; keyed: boolean; setOn: (v: boolean) => void } {
  const update = useClipUpdater(clip?.id ?? "");
  const on = useEffectiveValue(clip, property, base);
  const keyed = !!clip && clip.keyframes.some((t) => t.property === property);
  const setOn = React.useCallback(
    (v: boolean) => {
      if (!clip) return;
      // `commitProperty` is the app-wide animatable-write rule: a key at the
      // playhead when the property is animated or record is armed, the base
      // slot otherwise. A switch obeys it exactly like a slider does.
      update(undoLabel, (c) => commitProperty(c, property, v, useSession.getState().playheadMs));
    },
    [clip, property, update, undoLabel],
  );
  return { on, keyed, setOn };
}

/**
 * The right-click half: wraps a switch control in the same keyframe menu every
 * diamond has, so "Add keyframe here" / "Jump to next key" / "Reset keyframes"
 * work on a visibility eye exactly as they do on a number.
 *
 * Renders no chrome of its own — the caller supplies the button, which is what
 * lets an eye, a Switch and a mute icon share this without agreeing on looks.
 */
export function SwitchKeyMenu({
  clip,
  property,
  on,
  children,
}: {
  clip: Clip;
  property: string;
  on: boolean;
  children: React.ReactNode;
}) {
  const onRef = React.useRef(on);
  onRef.current = on;
  const targets = React.useMemo<KeyTarget[]>(
    () => [{ property, currentValue: () => onRef.current }],
    [property],
  );
  const state = useKeyframeState(clip, [property]);
  const toggle = useKeyframeToggle(clip, targets, state.active);

  return (
    <KeyframeMenu clip={clip} targets={targets} state={state} onToggle={toggle}>
      {children}
    </KeyframeMenu>
  );
}

/** The dot a switch wears once it is animated — the one signal that a control
 *  which looks static is actually being driven by the timeline. */
export function KeyedDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary", className)}
    />
  );
}

export function NavButton({
  dir,
  enabled,
  onClick,
}: {
  dir: "prev" | "next";
  enabled: boolean;
  onClick: () => void;
}) {
  const Icon = dir === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={dir === "prev" ? "Previous keyframe" : "Next keyframe"}
      disabled={!enabled}
      onClick={onClick}
      className={cn(
        // A disabled arrow STAYS VISIBLE. At 25% on a dark panel it read as
        // gone, so the pair looked like it appeared and disappeared as you
        // scrubbed past the last key — which turns a stable control into a
        // flicker and makes the row's width move with it. Once a property is
        // animated the arrows are permanent furniture; "nothing that way" is
        // dimmed, not absent.
        "flex size-4 items-center justify-center rounded transition-colors",
        enabled
          ? "text-muted-foreground hover:text-foreground"
          : "pointer-events-none text-muted-foreground/45",
      )}
    >
      <Icon className="size-3" strokeWidth={2.5} />
    </button>
  );
}

/**
 * Like KeyControl but spanning several properties (e.g. Position = x + y):
 * the diamond keys/unkeys all of them together, and its menu jumps across
 * whichever track has the nearest key.
 */
type KeyGroupProps = { clip: Clip; properties: Array<{ property: string; currentValue: () => KeyframeValue }> };

export function MultiKeyControl(props: KeyGroupProps) {
  const host = useClipHost(props.clip.id);
  return host?.timeless ? null : <MultiKeyControlBody {...props} />;
}

function MultiKeyControlBody({ clip, properties }: KeyGroupProps) {
  const paths = properties.map((p) => p.property);
  const state = useKeyframeState(clip, paths);
  const toggle = useKeyframeToggle(clip, properties, state.active);

  // Any of the ganged properties driven → the whole row's cluster gives way, for
  // the same reason a single one does.
  const ganged = properties.map((p) => clip.drivers?.[p.property]).find(Boolean);
  if (ganged) return <DrivenKeyframeStop token={ganged} />;

  return (
    <div
      className={cn(
        "flex items-center",
        state.hasAny ? "opacity-100" : "opacity-0 transition-opacity group-hover/row:opacity-100",
      )}
    >
      <KeyframeMenu clip={clip} targets={properties} state={state} onToggle={toggle}>
        <KeyDiamond
          active={state.active}
          hasAny={state.hasAny}
          label={state.active ? "Remove keyframes" : "Add keyframes"}
          title="Keyframe at playhead · right-click to jump between keys"
          onClick={toggle}
        />
      </KeyframeMenu>
    </div>
  );
}

/**
 * Section-header keyframe cluster: ◀ ◆ ▶ over every property in the section.
 *
 * The diamond keys the whole group; the arrows walk the playhead to the
 * nearest key on ANY of them. The arrows are the part that was missing, and
 * their absence was felt at exactly the moment they are needed: once a section
 * is animated you spend the next ten minutes moving between its keys, and the
 * only way to do it was to right-click a 20px diamond that only appears on
 * hover. After Effects and Premiere both put the pair either side of the
 * keyer, and this is one component so every section in the app — Transform,
 * Style, Highlight, an effect card, a modulator, an audio effect — gains them
 * at once rather than seven sections gaining them one at a time.
 *
 * They exist only once something is animated: two permanently-dead arrows on
 * every section header would be noise on the 95% that are not.
 */
export function GroupKeyButton(props: KeyGroupProps) {
  const host = useClipHost(props.clip.id);
  return host?.timeless ? null : <GroupKeyButtonBody {...props} />;
}

function GroupKeyButtonBody({ clip, properties }: KeyGroupProps) {
  const paths = properties.map((p) => p.property);
  const state = useKeyframeState(clip, paths);
  const toggle = useKeyframeToggle(clip, properties, state.active);

  const jump = (timeMs: number) => {
    const session = useSession.getState();
    session.setPlaying(false);
    session.setPlayhead(clip.startMs + timeMs);
  };

  return (
    <div className="flex items-center">
      {state.hasAny && (
        <NavButton dir="prev" enabled={state.prevTime !== null} onClick={() => jump(state.prevTime!)} />
      )}
      <KeyframeMenu clip={clip} targets={properties} state={state} onToggle={toggle}>
        <KeyDiamond
          active={state.active}
          hasAny={state.hasAny}
          large
          label="Keyframe all properties in this group"
          title="Keyframe the whole group · right-click for options"
          onClick={toggle}
        />
      </KeyframeMenu>
      {state.hasAny && (
        <NavButton dir="next" enabled={state.nextTime !== null} onClick={() => jump(state.nextTime!)} />
      )}
    </div>
  );
}
