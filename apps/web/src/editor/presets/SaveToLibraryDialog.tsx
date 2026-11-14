"use client";

import * as React from "react";
import { create } from "zustand";
import { FolderOpen, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * THE "save this to the library" dialog — one dialog for every kind of thing
 * that can become a reusable preset (effect cards today; text styles, layers,
 * components, whole stacks next), because they all ask the same two questions:
 * what is it called, and how far does it travel?
 *
 * Imperative on purpose: `saveToLibrary({...})` from a context menu, a picker
 * or a keyboard shortcut, with no local open/close state at the call site and
 * no second implementation of the scope choice. Mounted once, in the editor.
 */

export type LibraryScope = "project" | "app";

export interface SaveToLibraryRequest {
  /** Dialog heading — say what is being saved ("Save effect preset"). */
  title: string;
  /** One line under the heading. */
  description?: string;
  defaultName: string;
  /** Hide the scope picker (rename flows reuse this dialog). */
  scopeless?: boolean;
  /** Preselected scope; remembered from the caller's last choice if it wants. */
  defaultScope?: LibraryScope;
  confirmLabel?: string;
  onSave: (name: string, scope: LibraryScope) => void;
}

interface DialogStore {
  request: SaveToLibraryRequest | null;
  open: (req: SaveToLibraryRequest) => void;
  close: () => void;
}

const useLibraryDialog = create<DialogStore>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/** Pop the dialog from anywhere. */
export function saveToLibrary(req: SaveToLibraryRequest): void {
  useLibraryDialog.getState().open(req);
}

export function SaveToLibraryDialog() {
  const request = useLibraryDialog((s) => s.request);
  const close = useLibraryDialog((s) => s.close);
  const [name, setName] = React.useState("");
  const [scope, setScope] = React.useState<LibraryScope>("project");

  React.useEffect(() => {
    if (!request) return;
    setName(request.defaultName);
    setScope(request.defaultScope ?? "project");
  }, [request]);

  if (!request) return null;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    request.onSave(trimmed, scope);
    close();
  };

  return (
    <Dialog open onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          {request.description && <DialogDescription>{request.description}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground" htmlFor="preset-name">
              Name
            </label>
            <Input
              id="preset-name"
              value={name}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Frosted card"
            />
          </div>

          {!request.scopeless && (
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">Save to</span>
              <div className="grid grid-cols-2 gap-2">
                <ScopeCard
                  active={scope === "project"}
                  onClick={() => setScope("project")}
                  icon={<FolderOpen />}
                  label="This project"
                  hint="Saved in the file — travels with it when you share or export."
                />
                <ScopeCard
                  active={scope === "app"}
                  onClick={() => setScope("app")}
                  icon={<Monitor />}
                  label="All projects"
                  hint="Saved on this device — available in every project you open."
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim()}>
            {request.confirmLabel ?? "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeCard({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors [&_svg]:size-4",
        active
          ? "border-primary/70 bg-primary/10 text-foreground"
          : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      <span className="flex items-center gap-1.5 text-[12px] font-semibold">
        {icon}
        {label}
      </span>
      <span className="text-[10px] leading-snug opacity-70">{hint}</span>
    </button>
  );
}
