"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Crosshair, Unlink2 } from "lucide-react";
import { pickCandidates, pickNoun, resolvePick, searchDocNodes, type PickCandidate, type PickFilter } from "@solomotion/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useDoc } from "../state/document-context";
import { DRAG_SURFACE } from "../input/use-multi-touch";
import { PickGlyph } from "./PickGlyph";
import { beginPickDrag, enterPick, exitPick, setPickPreview, usePickMode, type PickRequest } from "./pick-mode";

/**
 * THE OBJECT FIELD — every "point at something" field in the app.
 *
 * It shows what is linked (its icon and name, or a broken-link state when the
 * thing is gone), opens a searchable list of exactly what may be picked, and
 * carries an AIM button that arms pick mode: then you point at the thing
 * itself — on the stage, in the timeline, in the layers list — and the same
 * filter decides what lights up. Press-and-drag the aim to whip it straight to
 * a target; click it to aim with a tap.
 *
 * The field states WHAT may be picked as data (a core `PickFilter`, or several
 * named scopes) and nothing else: the list, the pick mode, the validity test
 * and the broken-link check are all the pick registry's, so a new kind of
 * pickable thing reaches every field without touching one.
 */

/** A named filter — "In this comp", "At playhead". The first is the default,
 *  and the one the aim button arms with. */
export interface PickScope {
  id: string;
  label: string;
  filter: PickFilter;
}

/** A choice that is not an object — "Every voice", "The whole character". */
export interface PickExtra {
  value: string;
  label: string;
  hint?: string;
}

export interface ObjectFieldProps {
  filter: PickFilter | readonly PickScope[];
  /** The stored key (`clip:<id>`, `frame:<id>`, …), or null. */
  value: string | null;
  onChange: (candidate: PickCandidate) => void;
  extras?: readonly PickExtra[];
  /** Which extra is the value, when one is. */
  extraValue?: string | null;
  onExtra?: (value: string) => void;
  /** What the pick mode asks for — "voice", "body". Default: the filter's kinds. */
  noun?: string;
  placeholder?: string;
  /** Shown when the value names nothing that exists. */
  missing?: string;
  /** For a field that stores a NAME rather than a key: it names nothing here.
   *  Keyed fields derive this themselves. */
  broken?: boolean;
  /** A right-aligned note per row (a voice's time). */
  note?: (candidate: PickCandidate) => React.ReactNode;
  /** After a pick, choose within it — see `PickRequest.refine`. */
  refine?: PickRequest["refine"];
  /** Where the aim may land — "stage", "timeline", a panel id. Default: anywhere. */
  on?: PickRequest["on"];
  size?: "default" | "sm";
  disabled?: boolean;
  className?: string;
}

const scopesOf = (filter: ObjectFieldProps["filter"]): readonly PickScope[] =>
  "kinds" in filter ? [{ id: "all", label: "All", filter }] : filter;

export function ObjectField({
  filter,
  value,
  onChange,
  extras = [],
  extraValue = null,
  onExtra,
  noun,
  placeholder = "None",
  missing,
  broken: brokenName = false,
  note,
  refine,
  on,
  size = "default",
  disabled,
  className,
}: ObjectFieldProps) {
  const doc = useDoc();
  const owner = React.useId();
  const scopes = scopesOf(filter);
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [scopeId, setScopeId] = React.useState(scopes[0]?.id ?? "");
  const scope = scopes.find((s) => s.id === scopeId) ?? scopes[0];
  const armed = usePickMode((s) => s.request?.owner === owner);

  const current = value ? resolvePick(doc, value) : null;
  const broken = brokenName || (!!value && !current);
  const currentExtra = !value && extraValue !== null ? extras.find((e) => e.value === extraValue) : undefined;

  const rows = React.useMemo(() => (open && scope ? searchDocNodes(pickCandidates(doc, scope.filter), search) : []), [open, doc, scope, search]);
  const kinds = new Set(rows.map((r) => r.kind));
  const grouped = kinds.size > 1;
  const term = search.trim().toLowerCase();
  const extraRows = term ? extras.filter((e) => e.label.toLowerCase().includes(term)) : extras;

  const close = () => {
    setOpen(false);
    setSearch("");
    setPickPreview(null);
  };
  React.useEffect(() => () => setPickPreview(null), []);

  const request = (): PickRequest => ({ owner, filter: (scopes[0] ?? scope)!.filter, noun, on, onPick: onChange, refine });
  const toggleAim = () => (armed ? exitPick("cancel") : enterPick(request()));

  const small = size === "sm";
  return (
    <div
      className={cn(
        "group/object flex w-full min-w-0 items-center rounded-md border border-input bg-transparent transition-colors",
        small ? "h-5 text-2xs" : "h-[var(--control-h)] text-sm",
        armed && "border-primary/60",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Popover open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-md text-left transition-colors hover:bg-accent/50 data-[state=open]:bg-accent/50",
              small ? "pl-1.5" : "pl-2",
            )}
          >
            {current ? (
              <>
                <PickGlyph candidate={current} className={cn("shrink-0 text-muted-foreground", small ? "size-3" : "size-3.5")} />
                <span className="min-w-0 flex-1 truncate">{current.name}</span>
              </>
            ) : broken ? (
              <>
                <Unlink2 className={cn("shrink-0 text-amber-500", small ? "size-3" : "size-3.5")} />
                <span className="min-w-0 flex-1 truncate text-amber-500">{missing ?? "Missing"}</span>
              </>
            ) : (
              <span className={cn("min-w-0 flex-1 truncate", !currentExtra && "text-muted-foreground")}>{currentExtra?.label ?? placeholder}</span>
            )}
            <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start" onCloseAutoFocus={(e) => armed && e.preventDefault()}>
          <Command
            shouldFilter={false}
            loop
            // The keyboard-highlighted row previews where its object is, like hover does.
            onValueChange={(v) => setPickPreview(v.startsWith("extra:") ? null : v || null)}
          >
            <CommandInput value={search} onValueChange={setSearch} placeholder="Search…" />
            {scopes.length > 1 && (
              <div className="flex gap-1 border-b border-border/60 px-2 py-1.5">
                {scopes.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setScopeId(s.id)}
                    className={cn(
                      "rounded-full px-2 py-0.5 text-2xs transition-colors",
                      s.id === scope?.id ? "material-glass-raised text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <CommandList className="max-h-72" onMouseLeave={() => setPickPreview(null)}>
              <CommandEmpty>Nothing here</CommandEmpty>
              {extraRows.length > 0 && (
                <CommandGroup>
                  {extraRows.map((e) => (
                    <CommandItem
                      key={`extra:${e.value}`}
                      value={`extra:${e.value}`}
                      onSelect={() => {
                        onExtra?.(e.value);
                        close();
                      }}
                      className="gap-2"
                    >
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate text-sm">{e.label}</span>
                        {e.hint && <span className="truncate text-2xs text-muted-foreground">{e.hint}</span>}
                      </span>
                      {!value && extraValue === e.value && <Check className="size-3.5 shrink-0" />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {(grouped ? [...kinds] : [null]).map((kind) => {
                const list = kind === null ? rows : rows.filter((r) => r.kind === kind);
                if (list.length === 0) return null;
                return (
                  <CommandGroup key={kind ?? "rows"} heading={kind ? `${pickNoun(kind)}s` : undefined}>
                    {list.slice(0, 200).map((c) => (
                      <CommandItem
                        key={c.key}
                        value={c.key}
                        onMouseEnter={() => setPickPreview(c.key)}
                        onSelect={() => {
                          onChange(c);
                          close();
                        }}
                        className="gap-2"
                      >
                        <PickGlyph candidate={c} className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                        {note ? (
                          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{note(c)}</span>
                        ) : (
                          c.where && <span className="max-w-[40%] shrink-0 truncate text-2xs text-muted-foreground">{c.where}</span>
                        )}
                        {c.key === value && <Check className="size-3.5 shrink-0" />}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <AimButton
        armed={armed}
        small={small}
        disabled={disabled}
        label={`Pick a ${noun ?? pickNoun((scopes[0] ?? scope)?.filter.kinds[0] ?? "layer")}`}
        onPress={(e) => {
          close();
          if (armed) exitPick("cancel");
          else beginPickDrag(e, request());
        }}
        onKeyboard={toggleAim}
      />
    </div>
  );
}

/**
 * THE AIM — the one affordance that enters pick mode, shared by every field
 * that can (ObjectField, the pick-whip, the expression editor). Press: arms,
 * and a drag from it whips to the target. Armed, it wears the app's armed
 * material with the accent on the icon.
 */
export function AimButton({
  armed,
  small,
  disabled,
  label,
  onPress,
  onKeyboard,
  className,
}: {
  armed: boolean;
  small?: boolean;
  disabled?: boolean;
  label: string;
  onPress: (e: React.PointerEvent<HTMLButtonElement>) => void;
  /** Enter / Space — a press with no pointer. */
  onKeyboard: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-pick-ui
      aria-label={label}
      aria-pressed={armed}
      title={label}
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onPress(e);
      }}
      // A pointer press already acted; only the keyboard's synthetic click is new.
      onClick={(e) => e.detail === 0 && onKeyboard()}
      className={cn(
        DRAG_SURFACE,
        "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
        small ? "size-5" : "size-[var(--control-h)]",
        armed && "material-glass-raised text-primary hover:text-primary",
        className,
      )}
    >
      <Crosshair className={small ? "size-3" : "size-3.5"} />
    </button>
  );
}

/**
 * A nullable LAYER ID — the shape most reference fields store (a constraint's
 * target, a modifier's path, a joint's other body). The object field with a
 * "none" row, translated to and from the id.
 */
export function LayerRefField({
  value,
  onChange,
  filter,
  none = "None",
  noun,
  size,
  disabled,
  className,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  filter: PickFilter;
  /** The empty choice's label; null = there is no empty choice. */
  none?: string | null;
  noun?: string;
  size?: ObjectFieldProps["size"];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <ObjectField
      filter={filter}
      value={value ? `clip:${value}` : null}
      onChange={(c) => onChange(c.id)}
      extras={none === null ? [] : [{ value: "", label: none }]}
      extraValue={value ? null : ""}
      onExtra={() => onChange(null)}
      placeholder={none ?? "None"}
      noun={noun}
      size={size}
      disabled={disabled}
      className={className}
    />
  );
}
