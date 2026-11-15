"use client";

import * as React from "react";
import {
  addVariable,
  expressionById,
  exprTypeForVariable,
  isBound,
  parseSource,
  resolveVar,
  varToken,
  LITERAL_SOURCE,
  type MotionDocument,
  type Clip,
  type ValueSource,
  type VariableType,
  createModulator,
} from "@solomotion/core";
import { Crosshair, Link2, Link2Off, Plus, Settings2, SlidersHorizontal, Waves, Waypoints } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { FieldUnitProvider } from "@/components/ui/field-unit";
import { fieldUnitFor } from "./unit-control";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { evaluateAt, useExprContext } from "../expressions/expression-context";
import {
  detachedLiteral,
  ExpressionPopoverContent,
  WriteExpressionIcon,
  WRITE_EXPRESSION_LABEL,
} from "../expressions/ExpressionPopover";
import { VariablePickerContent } from "./variables/VariablePicker";
import { useClipModulatorHost, type ModulatorHost } from "./ModulatorControl";
import { DynamicFieldProvider, type DynamicFieldState } from "../binding/dynamic-field";
import { exposeAsInput, poseOwnerOf } from "@solomotion/core";
import { revealInInspector } from "../state/inspector-nav";
import { useSourceState } from "../binding/use-source-state";
import { useTypedSourceBinder } from "../binding/use-typed-source";
import { detachDriver, openBoardAtDriver } from "./driver-control";
import { KeyframeMenuItems, type KeyTarget } from "./keyframe-menu-items";
import { VARIABLE_TYPE_META } from "./variables/variable-meta";
import { useClipUpdater } from "./use-clip-updater";
import { enterPick } from "../pick/pick-mode";
import { propertyLinkRequest } from "../pick/property-link";

/**
 * BINDING FOR PROPERTY PATHS — the other half of the binding story.
 *
 * `BindableField` binds slots that store their own value (a colour string, a
 * font size). This binds the far larger family that does NOT: every animatable
 * property addressed by a PATH — `opacity`, `x`, `fill.<id>.color`,
 * `lfx.<id>.blur` — whose value lives in the clip's own typed field and can't
 * hold a token. Those bind through `clip.drivers[path]`, the map the node system
 * already built for exactly this purpose.
 *
 * Two storage seams, ONE vocabulary. The menu here offers the same verbs, opens
 * the same two panels and shows the same two chips as the slot-bound version,
 * because to the person using it there is no difference: they right-clicked a
 * field and asked for its value to come from somewhere else. Which of the two
 * places the reference is written is our problem, not theirs.
 *
 * `resolveDriver` reads all three token flavours off that map — `var:` (a
 * variable), `fx:` (an expression) and `expr:` (a node graph) — so mounting this
 * required no new resolution path, only a menu.
 */

/** The variable type a property row of this kind can be bound to. */
export function propertyVariableType(
  kind: "number" | "color" | "select" | "string",
): VariableType {
  return kind === "color" ? "color" : kind === "number" ? "number" : "string";
}

export interface PropertyBinding {
  token: string;
  source: ValueSource;
}

/** What (if anything) currently drives this property path. The three-way branch
 *  that used to live here is `parseSource` now — see `core/binding`. */
export function usePropertyBinding(
  clip: Clip,
  path: string,
): PropertyBinding | null {
  const token = clip.drivers?.[path];
  if (!token) return null;
  return { token, source: parseSource(token) };
}

/**
 * The one writer. Passing a token binds the path; passing anything else
 * detaches it — which mirrors `BindableField`'s `onChange` exactly, and is what
 * lets both panels be reused here verbatim instead of re-implemented.
 */
function useBindingWriter(clip: Clip, path: string) {
  const update = useClipUpdater(clip.id);
  return React.useCallback(
    (next: string | number, label: string) => {
      const token = isBound(next) ? (next as string) : null;
      update(label, (c) => {
        const drivers = { ...(c.drivers ?? {}) };
        if (token) drivers[path] = token;
        else delete drivers[path];
        c.drivers = Object.keys(drivers).length ? drivers : undefined;
      });
    },
    [update, path],
  );
}

export interface PropertyBindingProps {
  clip: Clip;
  path: string;
  kind: "number" | "color" | "select" | "string";
  label: string;
  /** The value the field shows when nothing drives it — seeds a new variable or
   *  expression, and is what a detach falls back to. */
  literal: string | number;
  /**
   * Optional. Property paths normally need NOTHING here: driving a path never
   * overwrote the clip's own base or keyframes, so dropping the token restores
   * exactly the value that was underneath it. Pass this only for a slot whose
   * literal really was replaced.
   */
  onChange?: (value: string | number) => void;
}

/**
 * Wrap any control to give it the full right-click vocabulary — bind it to a
 * variable or an expression, AND every keyframe verb the diamond has.
 *
 * The keyframe half is the fix for a real asymmetry: "reset this animation" and
 * "jump to the next key" lived only on the ◆, a 20px target that is invisible
 * until you hover the row, while the control you were actually looking at
 * offered nothing. Both hosts render the same two blocks from the same two
 * modules now, so they cannot drift into different answers about one property.
 *
 * The keyframe rows cost nothing when unused: Radix mounts a context menu's
 * content only while it is open, so the playhead subscription inside them does
 * not exist for the hundreds of rows nobody has right-clicked.
 */
/** Add a modulator to `path`. The same two lines `ModulatorControl.add` runs,
 *  routed through the host's `target` mapping so a variable's paint editor
 *  stores it where the variable actually reads it. */
function addModulator(host: ModulatorHost, path: string, label: string): void {
  const target = host.target?.(path) ?? path;
  host.write(`Modulate ${label}`, (list) => list.push(createModulator(target)));
}

export function PropertyBindingMenu({
  clip,
  path,
  kind,
  label,
  literal,
  onChange,
  keyTargets,
  children,
  className,
}: PropertyBindingProps & {
  /**
   * What this control ANIMATES. Usually the one path above, which is the
   * default; a ganged row (Position = X + Y) names both so the verbs act on the
   * pair. Pass `[]` for a control that cannot be keyed at all.
   */
  keyTargets?: readonly KeyTarget[];
  children: React.ReactNode;
  className?: string;
}) {
  const [panel, setPanel] = React.useState<null | "variable" | "expression">(
    null,
  );
  // Derived from the clip rather than passed in: every caller that has a clip
  // already has everything a modulator host needs, and asking them to thread it
  // would mean the menu was complete on the rows someone remembered.
  const modulatorHost = useClipModulatorHost(clip);
  const shared = usePropertyPanelProps(
    clip,
    path,
    kind,
    literal,
    onChange,
    () => setPanel(null),
  );
  const binding = usePropertyBinding(clip, path);
  const write = useBindingWriter(clip, path);
  const store = useDocStore();
  // A field animates its own path unless it says otherwise. `literal` is what
  // the control is showing, which is exactly the value a fresh key should hold.
  const literalRef = React.useRef(literal);
  literalRef.current = literal;
  const keys = React.useMemo<KeyTarget[]>(
    () => (keyTargets ? [...keyTargets] : [{ property: path, currentValue: () => literalRef.current }]),
    [keyTargets, path],
  );

  // THE FIELD'S OWN AFFORDANCE. The control inside is handed its source through
  // context, so it paints itself tinted and opens its own editor on click. A
  // path-addressed property needs no preview: the resolved document already gave
  // the control the live value.
  const openPanel = React.useCallback(
    (next: "variable" | "expression") => setPanel(next),
    [],
  );
  const detach = React.useCallback(() => {
    const token = clip.drivers?.[path];
    // A graph drive is detached at the WIRE, so the board and the document agree
    // about what is connected; the other two are just a token to drop.
    if (token && parseSource(token).kind === "graph")
      detachDriver(store, clip.id, path, token);
    else write(literal, `Detach ${label}`);
    onChange?.(literal);
  }, [clip.drivers, clip.id, path, store, write, literal, label, onChange]);
  const bound = useSourceState(binding?.source ?? LITERAL_SOURCE, {
    openPanel,
    detach,
    token: binding?.token,
  });
  const posed = usePoseField(clip.id, path);
  const dynamic = bound ?? posed;
  // …and its fastest path: type `#frame` into the field and it IS an expression.
  const acceptTyped = useTypedSourceBinder({
    expect: exprTypeForVariable(propertyVariableType(kind)),
    bind: React.useCallback((token: string) => write(token, `Bind ${label}`), [write, label]),
    disabled: binding !== null,
  });

  // Opening a popover FROM a menu item is a two-step dance in Radix: selecting an
  // item starts the menu's dismissal, and anything that opens during it is closed
  // again by the same outside-click and focus-restore pass. So the choice is only
  // REMEMBERED here, and acted on once the menu has finished closing — which is
  // exactly what `onCloseAutoFocus` marks, and is also the moment we must keep
  // focus from snapping back to the field so the editor can take it instead.
  const pending = React.useRef<"variable" | "expression" | null>(null);

  return (
    // The provider sits OUTSIDE the anchor on purpose: `asChild` clones its child
    // and hands it a ref, and a context provider renders no element to take one —
    // slipping it between the anchor and the control silently broke both the
    // anchor and the right-click trigger.
    <DynamicFieldProvider state={dynamic} accept={acceptTyped}>
      <Popover
        open={panel !== null}
        onOpenChange={(open) => !open && setPanel(null)}
      >
        {/* The field draws its own unit (a length's live chip) in its reserved
            slot. Scoped to the control, never the panels below it. */}
        <FieldUnitProvider unit={fieldUnitFor(clip, path)}>
        <ContextMenu>
          <ContextMenuTrigger asChild className={className}>
            {/* An anchor, not a trigger: the control keeps its own click and drag
              behaviour, and the panel merely opens against it. */}
            <PopoverAnchor asChild>{children}</PopoverAnchor>
          </ContextMenuTrigger>
          <ContextMenuContent
            className="min-w-52"
            onCloseAutoFocus={(event) => {
              if (!pending.current) return;
              event.preventDefault();
              setPanel(pending.current);
              pending.current = null;
            }}
          >
            <PropertyBindingItems
              clip={clip}
              path={path}
              kind={kind}
              label={label}
              literal={literal}
              onChange={onChange}
              onOpenPanel={(next) => {
                pending.current = next;
              }}
            />
            {/* MODULATORS live in this menu too, because "make this value move
                on its own" is one question with three answers — a variable, an
                expression, a signal — and answering two of them here while the
                third hid behind a badge that only some rows rendered is why
                people never found it. Numbers only: there is no meaningful
                signal to add to an enum, and offering it would be a promise the
                renderer cannot keep. */}
            {kind === "number" && modulatorHost && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => addModulator(modulatorHost, path, label)}>
                  <Waves /> Add modulator
                </ContextMenuItem>
              </>
            )}
            {keys.length > 0 && (
              <>
                <ContextMenuSeparator />
                <KeyframeMenuItems clip={clip} targets={keys} />
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
        </FieldUnitProvider>
        {panel === "variable" && (
          <VariablePickerContent
            {...shared}
            align="start"
            onWriteExpression={() => setPanel("expression")}
          />
        )}
        {panel === "expression" && (
          <ExpressionPopoverContent {...shared} align="start" />
        )}
      </Popover>
    </DynamicFieldProvider>
  );
}

/** The props both panels take — one place, so they can never drift apart, and
 *  so any host that opens them (a wrapped control, the keyframe diamond's menu)
 *  is opening the identical panel. */
export function usePropertyPanelProps(
  clip: Clip,
  path: string,
  kind: PropertyBindingProps["kind"],
  literal: string | number,
  onChange: ((value: string | number) => void) | undefined,
  close: () => void,
) {
  const write = useBindingWriter(clip, path);
  const binding = usePropertyBinding(clip, path);
  const type = propertyVariableType(kind);
  return {
    type,
    value: binding?.token ?? literal,
    literal: literal as never,
    onChange: (next: string | number) => {
      const bound = isBound(next);
      write(next, bound ? `Bind ${path}` : `Detach ${path}`);
      // Detaching restores the value that was on screen, so nothing moves.
      if (!bound) onChange?.(next);
    },
    onClose: close,
  };
}

/**
 * The menu rows on their own, so a host that already owns a context menu (the
 * keyframe diamond) can fold them in rather than nesting a second one.
 */
export function PropertyBindingItems({
  clip,
  path,
  kind,
  label,
  literal,
  onChange,
  onOpenPanel,
}: PropertyBindingProps & {
  onOpenPanel: (panel: "variable" | "expression") => void;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const ctx = useExprContext();
  const openManager = useSession((s) => s.setVariablesOpen);
  const write = useBindingWriter(clip, path);
  const binding = usePropertyBinding(clip, path);
  const type = propertyVariableType(kind);
  const meta = VARIABLE_TYPE_META[type];

  // Inside a component (or any comp with inputs) a field can become one of its
  // inputs — Figma's "create property".
  const home = doc.frames.find((f) => f.id === clip.frameId);
  const exposable = !!home && (home.component != null || (home.inputs?.length ?? 0) > 0);

  const variable =
    binding?.source.kind === "variable" ? resolveVar(doc, binding.token) : null;
  const expression =
    binding?.source.kind === "expression"
      ? (expressionById(doc, binding.source.id) ?? null)
      : null;

  const detach = (shown: string | number) => {
    write(shown, `Detach ${label}`);
    onChange?.(shown);
  };

  // The host decides WHEN to open (see `onCloseAutoFocus` above); this only says
  // which panel was asked for.
  const open = (panel: "variable" | "expression") => onOpenPanel(panel);

  if (binding?.source.kind === "input") {
    const inputId = binding.source.id;
    const home = doc.frames.find((f) => f.id === clip.frameId);
    const def = home?.inputs?.find((d) => d.id === inputId);
    return (
      <>
        <ContextMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {label}
        </ContextMenuLabel>
        <ContextMenuItem onSelect={() => home && useSession.getState().selectFrame(home.id)}>
          <SlidersHorizontal /> Edit input “{def?.name ?? "Input"}”
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => detach(literal)}>
          <Link2Off /> Detach from input
        </ContextMenuItem>
      </>
    );
  }

  if (binding?.source.kind === "graph") {
    // The verbs the sidecar "Nodes" chip used to carry, now on the field itself.
    return (
      <>
        <ContextMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {label}
        </ContextMenuLabel>
        <ContextMenuItem
          onSelect={() => openBoardAtDriver(store, binding.token)}
        >
          <Waypoints /> Open in the node editor
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => detachDriver(store, clip.id, path, binding.token)}
        >
          <Link2Off /> Detach from nodes
        </ContextMenuItem>
      </>
    );
  }

  return (
    <>
      <ContextMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </ContextMenuLabel>
      {variable ? (
        <>
          <ContextMenuItem onSelect={() => openManager(true)}>
            <Settings2 /> Edit “{variable.name}”…
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => detach(variable.value as string | number)}
          >
            <Link2Off /> Detach from variable
          </ContextMenuItem>
        </>
      ) : expression ? (
        <>
          <ContextMenuItem onSelect={() => open("expression")}>
            <WriteExpressionIcon /> Edit expression…
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              const shown = evaluateAt(
                expression.source,
                doc.variables,
                ctx,
                expression.id,
              );
              detach(detachedLiteral(type, shown?.value, literal));
            }}
          >
            <Link2Off /> Remove expression
          </ContextMenuItem>
        </>
      ) : (
        <>
          <ContextMenuItem onSelect={() => open("variable")}>
            <Link2 /> Link a variable…
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => open("expression")}>
            <WriteExpressionIcon /> {WRITE_EXPRESSION_LABEL}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => enterPick(propertyLinkRequest({ store, clip, path, label, owner: `link:${clip.id}/${path}` }))}>
            <Crosshair /> Link to a layer…
          </ContextMenuItem>
          {exposable && (
            <ContextMenuItem
              onSelect={() =>
                store.update(`Expose ${label} as input`, (d) => {
                  exposeAsInput(d, clip.id, path);
                })
              }
            >
              <SlidersHorizontal /> Expose as input
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onSelect={() => {
              let id: string | null = null;
              store.update(
                `Create ${meta.label.toLowerCase()} variable`,
                (d) => {
                  id = addVariableFromLiteral(d, type, label, literal);
                },
              );
              if (id) write(varToken(id), `Bind ${label}`);
            }}
          >
            <Plus /> Create variable from this value
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => openManager(true)}>
        <Settings2 /> Manage variables…
      </ContextMenuItem>
    </>
  );
}

/** Mint a variable seeded with the field's current value, returning its id.
 *  `addVariable` is typed per variant; the row's `kind` already guarantees the
 *  literal matches its type, so the pairing is asserted once, here. */
function addVariableFromLiteral(
  doc: MotionDocument,
  type: VariableType,
  name: string,
  literal: string | number,
): string {
  return addVariable(doc, type as "number", name, literal as never).id;
}

/**
 * Drop-in wrapper for a control that is NOT a `ValueField` — a transform pair, a
 * typography row, a vector field. It adds the right-click vocabulary and nothing
 * else: no layout, no chip, no width. Dense paired rows (Position = X + Y) keep
 * their two inputs side by side, and the fact that a value is driven is carried
 * by the input itself — tinted by its source — rather than by a chip beside it.
 *
 * This is the seam to reach for when adding binding to a new inspector: wrap the
 * input, name the path, done.
 */
export function BindableProperty({
  clip,
  path,
  kind = "number",
  label,
  literal,
  children,
}: {
  clip: Clip;
  path: string;
  kind?: PropertyBindingProps["kind"];
  label: string;
  literal: string | number;
  children: React.ReactNode;
}) {
  return (
    <PropertyBindingMenu
      clip={clip}
      path={path}
      kind={kind}
      label={label}
      literal={literal}
      className="min-w-0 flex-1"
    >
      {children}
    </PropertyBindingMenu>
  );
}

/**
 * The pose set that owns this path, as a field source — or null. A posed
 * value is written by the set every frame, so the field opens the set instead
 * of editing a value that would be overwritten.
 */
function usePoseField(clipId: string, path: string): DynamicFieldState | null {
  const doc = useDoc();
  const owner = poseOwnerOf(doc, clipId, path);
  const groupId = owner?.groupId;
  const setId = owner?.setId;
  return React.useMemo(() => {
    if (!groupId || !setId) return null;
    const g = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === groupId);
    const name = g?.kind === "group" ? (g.poses?.find((s) => s.id === setId)?.name ?? null) : null;
    const open = () => {
      useSession.getState().select([groupId]);
      revealInInspector({ tab: "character", section: "face", entry: setId });
    };
    return { source: { kind: "pose", groupId, setId }, name, preview: null, error: null, open, detach: open };
  }, [doc, groupId, setId]);
}
