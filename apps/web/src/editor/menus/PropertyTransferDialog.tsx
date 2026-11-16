"use client";

import * as React from "react";
import {
  captureProperties,
  layerEffectTypeDef,
  locateClip,
  propertyDomain,
  transferDomains,
  type CapturedProperties,
  type LayerEffect,
  type TransferItem,
} from "@solomotion/core";
import { Check, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/lib/toast";
import {
  applyCapturedToSelection,
  copyProperties,
  readPropertySource,
  type PropertySource,
} from "../state/clip-actions";
import { useDocSelector, useDocStore } from "../state/document-context";
import { clipLocalClamped } from "../inspector/animatable";
import { useSession } from "../state/session";
import { NAMES } from "@/editor/names";

/**
 * The ONE property-transfer dialog — "Copy properties…" and "Paste
 * properties…" are the same surface. It reads the copyable domains headlessly
 * from the core registry (so any clip kind shows exactly what it carries),
 * renders tri-state checkboxes (Effects lists each card as a child), and
 * remembers your last choices. Copy snapshots the checked domains to the
 * clipboard; Paste applies the clipboard — a property capture OR a whole
 * copied layer — onto the target, with non-matching domains disabled.
 */

const PREFS_KEY = NAMES.storage.propertyTransfer;

interface Prefs {
  domains: Record<string, boolean>;
  includeKeyframes: boolean;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      return { domains: parsed.domains ?? {}, includeKeyframes: parsed.includeKeyframes ?? true };
    }
  } catch {
    // First run / blocked storage — defaults below.
  }
  return { domains: {}, includeKeyframes: true };
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Non-persistent session is fine.
  }
}

type CheckState = "on" | "off" | "mixed";

function TriCheckbox({
  state,
  disabled,
  onToggle,
  label,
  sub,
  indent,
}: {
  state: CheckState;
  disabled?: boolean;
  onToggle: () => void;
  label: string;
  sub?: string;
  indent?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs transition-colors",
        disabled ? "opacity-40" : "hover:bg-muted/60",
        indent && "ml-5 w-[calc(100%-1.25rem)]",
      )}
    >
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-sm border [&_svg]:size-2.5",
          state === "off"
            ? "border-border bg-transparent"
            : "border-primary/60 bg-primary/15 text-primary",
        )}
      >
        {state === "on" && <Check strokeWidth={3.5} />}
        {state === "mixed" && <Minus strokeWidth={3.5} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </button>
  );
}

/** One row of the domain tree: a domain, its items, and the selection state. */
interface DomainRow {
  id: string;
  label: string;
  disabled: boolean;
  items: TransferItem[];
}

export function PropertyTransferDialog() {
  const store = useDocStore();
  const request = useSession((s) => s.propertyTransfer);
  const close = () => useSession.getState().closePropertyTransfer();

  const [source, setSource] = React.useState<PropertySource | null>(null);
  const [sourceLoaded, setSourceLoaded] = React.useState(false);
  const [checked, setChecked] = React.useState<Record<string, true | string[]>>({});
  const [includeKf, setIncludeKf] = React.useState(true);

  const mode = request?.mode;
  const clipId = request?.clipId;
  const clip = useDocSelector((d) => (clipId ? locateClip(d, clipId)?.clip : undefined));

  // Build the domain tree: copy reads the clip itself; paste reads the
  // clipboard source (capture or copied layer) and disables what the target
  // can't take.
  const rows: DomainRow[] = React.useMemo(() => {
    if (!clip) return [];
    if (mode === "copy") {
      return transferDomains(clip).map((d) => ({
        id: d.id,
        label: d.label,
        disabled: false,
        items: d.items?.(clip) ?? [],
      }));
    }
    if (!source) return [];
    const targetIds = new Set(transferDomains(clip).map((d) => d.id));
    if (source.kind === "clip") {
      return transferDomains(source.clip).map((d) => ({
        id: d.id,
        label: d.label,
        disabled: !targetIds.has(d.id),
        items: d.items?.(source.clip) ?? [],
      }));
    }
    return Object.keys(source.captured.domains).map((id) => {
      const effects = id === "effects" ? source.captured.domains[id]!.values["effects"] : null;
      return {
        id,
        label: propertyDomain(id)?.label ?? id,
        disabled: !targetIds.has(id),
        items: Array.isArray(effects)
          ? (effects as LayerEffect[]).map((e) => ({
              id: e.id,
              label: layerEffectTypeDef(e.type)?.label ?? e.type,
            }))
          : [],
      };
    });
  }, [clip, mode, source]);

  // On open: load the clipboard source (paste) and seed checks from prefs.
  React.useEffect(() => {
    if (!request) return;
    setSource(null);
    setSourceLoaded(false);
    const prefs = loadPrefs();
    setIncludeKf(prefs.includeKeyframes);
    if (request.mode === "paste") {
      void readPropertySource().then((s) => {
        setSource(s);
        setSourceLoaded(true);
      });
    } else {
      setSourceLoaded(true);
    }
  }, [request]);

  // Seed selection once rows exist: last-used domains, defaulting to all on.
  const seeded = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!request || rows.length === 0) return;
    const key = `${request.mode}:${request.clipId}`;
    if (seeded.current === key) return;
    seeded.current = key;
    const prefs = loadPrefs();
    const next: Record<string, true | string[]> = {};
    for (const r of rows) {
      if (!r.disabled && prefs.domains[r.id] !== false) next[r.id] = true;
    }
    setChecked(next);
  }, [request, rows]);

  if (!request || !clip) return null;

  const rowState = (r: DomainRow): CheckState => {
    const sel = checked[r.id];
    if (!sel) return "off";
    if (sel === true || r.items.length === 0 || sel.length >= r.items.length) return "on";
    return sel.length === 0 ? "off" : "mixed";
  };

  const toggleRow = (r: DomainRow) => {
    setChecked((c) => {
      const next = { ...c };
      if (rowState(r) === "off") next[r.id] = true;
      else delete next[r.id];
      return next;
    });
  };

  const toggleItem = (r: DomainRow, itemId: string) => {
    setChecked((c) => {
      const cur = c[r.id];
      const ids = cur === true ? r.items.map((i) => i.id) : cur ? [...cur] : [];
      const at = ids.indexOf(itemId);
      if (at >= 0) ids.splice(at, 1);
      else ids.push(itemId);
      const next = { ...c };
      if (ids.length === 0) delete next[r.id];
      else next[r.id] = ids.length >= r.items.length ? true : ids;
      return next;
    });
  };

  const setAll = (on: boolean) => {
    if (!on) return setChecked({});
    const next: Record<string, true | string[]> = {};
    for (const r of rows) if (!r.disabled) next[r.id] = true;
    setChecked(next);
  };

  const persist = () => {
    const prefs = loadPrefs();
    for (const r of rows) prefs.domains[r.id] = !!checked[r.id];
    prefs.includeKeyframes = includeKf;
    savePrefs(prefs);
  };

  const checkedIds = rows.filter((r) => !r.disabled && checked[r.id]).map((r) => r.id);

  const confirm = async () => {
    persist();
    if (mode === "copy") {
      const labels = await copyProperties(store, clip.id, checked, includeKf);
      if (labels) toast(`Copied ${labels.join(", ").toLowerCase()}`);
    } else if (source) {
      // Whole-layer source: capture it now with the dialog's choices; a
      // property capture pastes as-is (its keyframe choice was made at copy).
      const captured: CapturedProperties =
        source.kind === "clip"
          ? captureProperties(
              source.clip,
              {
                localMs: clipLocalClamped(source.clip, useSession.getState().playheadMs),
                includeKeyframes: includeKf,
              },
              checked,
            )
          : source.captured;
      const selection = useSession.getState().selectedClipIds;
      const targets = selection.includes(clip.id) ? selection : [clip.id];
      const what = applyCapturedToSelection(store, captured, checkedIds, targets);
      toast(what ? `Pasted ${what}` : "Nothing matched this layer");
    }
    close();
  };

  const empty = sourceLoaded && mode === "paste" && !source;

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-sm gap-0 p-0">
        <DialogHeader className="border-b border-border/60 px-4 py-3">
          <DialogTitle className="text-sm">
            {mode === "copy" ? "Copy properties" : "Paste properties"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {mode === "copy"
              ? "Choose what to copy from this layer."
              : source?.kind === "clip"
                ? "Choose what to take from the copied layer."
                : "Choose what to apply from the clipboard."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between px-4 py-2 text-[11px] text-muted-foreground">
          <div className="flex gap-3">
            <button type="button" className="hover:text-foreground" onClick={() => setAll(true)}>
              Select all
            </button>
            <button type="button" className="hover:text-foreground" onClick={() => setAll(false)}>
              Deselect all
            </button>
          </div>
          <label className="flex cursor-pointer items-center gap-1.5">
            Include animations
            <Switch
              checked={includeKf}
              disabled={mode === "paste" && source?.kind === "captured"}
              onCheckedChange={setIncludeKf}
            />
          </label>
        </div>

        <ScrollArea className="max-h-72 border-y border-border/60" viewportClassName="px-2 py-1.5">
          {empty ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              Nothing copyable on the clipboard — copy a layer or its properties first.
            </p>
          ) : rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">Reading clipboard…</p>
          ) : (
            rows.map((r) => (
              <React.Fragment key={r.id}>
                <TriCheckbox
                  state={rowState(r)}
                  disabled={r.disabled}
                  onToggle={() => toggleRow(r)}
                  label={r.label}
                  sub={r.disabled ? "no match" : r.items.length > 0 ? `${r.items.length}` : undefined}
                />
                {!r.disabled &&
                  r.items.map((item) => {
                    const sel = checked[r.id];
                    const on = sel === true || (Array.isArray(sel) && sel.includes(item.id));
                    return (
                      <TriCheckbox
                        key={item.id}
                        indent
                        state={on ? "on" : "off"}
                        onToggle={() => toggleItem(r, item.id)}
                        label={item.label}
                      />
                    );
                  })}
              </React.Fragment>
            ))
          )}
        </ScrollArea>

        <DialogFooter className="px-4 py-3">
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void confirm()} disabled={empty || checkedIds.length === 0}>
            {mode === "copy" ? "Copy" : "Paste"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
