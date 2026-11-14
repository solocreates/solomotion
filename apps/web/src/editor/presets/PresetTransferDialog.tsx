"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import { create } from "zustand";
import {
  LFX,
  presetBundleExt,
  groupBundle,
  layerEffectTypeDef,
  makePresetBundle,
  mergePresetBundle,
  parsePresetBundle,
  PresetBundleError,
  type PresetBundle,
  type StoredPreset,
} from "@solomotion/core";
import { Check, Download, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useDoc, useDocStore } from "../state/document-context";
import { useAppPresets } from "../state/preset-store";
import { ENGINE } from "@/editor/names";

/**
 * EXPORT AND IMPORT, FOR PRESETS OF EVERY KIND.
 *
 * ONE dialog, two directions, because the decision is the same in both: which
 * KINDS do I want. Splitting it into two components would have meant two pick
 * lists, two ways of naming a kind, and two places to remember when a new kind
 * appears.
 *
 * Nothing here knows what a preset contains. The library's whole design is that
 * a `kind` is a namespace and the payload belongs to whoever registered it, so
 * this counts rows and writes JSON — and a kind invented next year travels with
 * no work at all. The only per-kind knowledge is the LABEL, and even that falls
 * back to the raw kind rather than refusing to show it.
 */

type Mode = "export" | "import";

interface TransferState {
  mode: Mode | null;
  /** Set when a file arrived (a drop, or the picker). */
  incoming: PresetBundle | null;
  open: (mode: Mode, incoming?: PresetBundle) => void;
  close: () => void;
}

export const usePresetTransfer = create<TransferState>((set) => ({
  mode: null,
  incoming: null,
  open: (mode, incoming) => set({ mode, incoming: incoming ?? null }),
  close: () => set({ mode: null, incoming: null }),
}));

/** Open the export sheet. */
export function exportPresets(): void {
  usePresetTransfer.getState().open("export");
}

/**
 * Take a dropped or picked file. Parses first and only then opens the dialog,
 * so a wrong file fails as a sentence instead of as an empty list.
 */
export async function importPresetFile(file: File | Blob): Promise<boolean> {
  try {
    const bundle = parsePresetBundle(await file.text());
    usePresetTransfer.getState().open("import", bundle);
    return true;
  } catch (err) {
    toast.error(err instanceof PresetBundleError ? err.message : "That file could not be read.");
    return false;
  }
}

/** A human name for a preset kind. `effect:glass` → "Liquid glass". */
function kindLabel(kind: string): string {
  if (kind === "grade") return "Colour looks";
  if (kind.startsWith("effect:")) {
    const type = kind.slice("effect:".length);
    const def = layerEffectTypeDef(type as never) ?? LFX.types.find((t) => t.type === type);
    return def?.label ?? type;
  }
  if (kind.startsWith("stack:")) return `${kind.slice("stack:".length)} stacks`;
  return kind;
}

export function PresetTransferDialog() {
  const mode = usePresetTransfer((s) => s.mode);
  const incoming = usePresetTransfer((s) => s.incoming);
  const close = usePresetTransfer((s) => s.close);

  const doc = useDoc();
  const store = useDocStore();
  const appEntries = useAppPresets((s) => s.entries);

  // What is on the table: everything savable on export (builtins are already in
  // the app, so exporting them would be shipping a copy of the app), or the
  // file's contents on import.
  const source: StoredPreset[] = React.useMemo(
    () => (mode === "import" ? (incoming?.presets ?? []) : [...appEntries, ...doc.presets]),
    [mode, incoming, appEntries, doc.presets],
  );
  const groups = React.useMemo(() => groupBundle(source), [source]);

  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [name, setName] = React.useState("");
  const [target, setTarget] = React.useState<"app" | "project">("app");

  // Everything ticked by default. A pick list that starts empty makes the
  // common case (take it all) into work.
  React.useEffect(() => {
    if (!mode) return;
    setPicked(new Set(groups.map((g) => g.kind)));
    setName(mode === "export" ? "My presets" : "");
    setTarget("app");
    // Re-arm per opening, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, incoming]);

  const chosen = source.filter((p) => picked.has(p.kind));

  const doExport = () => {
    const bundle = makePresetBundle(chosen, { ns: ENGINE.ns, label: name });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(name || "presets").replace(/[^\w\- ]+/g, "")}${presetBundleExt(ENGINE.ns)}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success(`Exported ${chosen.length} preset${chosen.length === 1 ? "" : "s"}`);
    close();
  };

  const doImport = () => {
    const kinds = picked;
    if (target === "app") {
      const merged = mergePresetBundle(useAppPresets.getState().entries, chosen, { kinds });
      useAppPresets.getState().replaceAll(merged.list);
      report(merged);
    } else {
      // Project scope travels with the file, so it is an ordinary document edit
      // and lands on the undo stack like one.
      let result = { added: 0, replaced: 0, skipped: 0 };
      store.update("Import presets", (d) => {
        const merged = mergePresetBundle(d.presets, chosen, { kinds });
        d.presets = merged.list;
        result = merged;
      });
      report(result);
    }
    close();
  };

  const report = (r: { added: number; replaced: number }) => {
    const parts = [r.added ? `${r.added} added` : null, r.replaced ? `${r.replaced} updated` : null].filter(Boolean);
    toast.success(parts.length ? `Presets imported — ${parts.join(", ")}` : "Nothing new to import");
  };

  const exporting = mode === "export";

  return (
    <Dialog open={mode !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {exporting ? <Download className="size-4" /> : <Upload className="size-4" />}
            {exporting ? "Export presets" : "Import presets"}
          </DialogTitle>
          <DialogDescription>
            {exporting
              ? `One file you can keep, send, or drop back into ${identity.name}.`
              : incoming?.label
                ? `From “${incoming.label}”.`
                : "Choose what to bring in."}
          </DialogDescription>
        </DialogHeader>

        {groups.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-muted-foreground">
            {exporting ? "You have not saved any presets yet." : "That file holds no presets."}
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                {chosen.length} of {source.length} selected
              </span>
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() =>
                  setPicked((p) => (p.size === groups.length ? new Set() : new Set(groups.map((g) => g.kind))))
                }
              >
                {picked.size === groups.length ? "Select none" : "Select all"}
              </button>
            </div>

            <ScrollArea className="max-h-64 rounded-md border border-border/70">
              <div className="divide-y divide-border/50">
                {groups.map((g) => (
                  <label
                    key={g.kind}
                    className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-muted/50"
                    title={g.names.slice(0, 12).join("\n")}
                  >
                    {/* There is no checkbox primitive in this app and adding
                        one for a single dialog would be a third selection
                        control beside Switch and Toggle. A tick box is four
                        lines of a button. */}
                    <span
                      role="checkbox"
                      aria-checked={picked.has(g.kind)}
                      onClick={(e) => {
                        e.preventDefault();
                        setPicked((p) => {
                          const next = new Set(p);
                          if (next.has(g.kind)) next.delete(g.kind);
                          else next.add(g.kind);
                          return next;
                        });
                      }}
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded border transition-colors",
                        picked.has(g.kind) ? "border-primary bg-primary text-primary-foreground" : "border-border",
                      )}
                    >
                      {picked.has(g.kind) && <Check className="size-3" />}
                    </span>
                    <span className="flex-1 truncate text-[12px]">{kindLabel(g.kind)}</span>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{g.count}</span>
                  </label>
                ))}
              </div>
            </ScrollArea>

            {exporting ? (
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this pack" className="h-8" />
            ) : (
              <div className="flex items-center gap-1">
                {(
                  [
                    { id: "app", label: "This device", hint: "Available in every project you open here" },
                    { id: "project", label: "This project", hint: "Travels with the file" },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    title={t.hint}
                    onClick={() => setTarget(t.id)}
                    className={cn(
                      "h-7 flex-1 rounded text-[11px] transition-colors",
                      target === t.id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" disabled={chosen.length === 0} onClick={exporting ? doExport : doImport}>
            {exporting ? "Export" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
