"use client";

import * as React from "react";
import { TEMPLATE_CATEGORIES, librarySnapshotName } from "@solomotion/core";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSession } from "../state/session";
import { previewFromSnapshot, useWorkspace } from "../state/workspace";

/** Sentinel category value that reveals the "new category" name field. */
const NEW_CATEGORY = "__new__";

/**
 * "Add to library" — turns the captured selection (a LibrarySnapshot set by the
 * selection context menu) into a saved, reusable component. Pick or create a
 * category; the item is stored app-level in the workspace.
 */
export function AddToLibraryDialog() {
  const draft = useSession((s) => s.addToLibraryDraft);
  const customCategories = useWorkspace((s) => s.customCategories);
  const addCategory = useWorkspace((s) => s.addCategory);
  const addCustomTemplate = useWorkspace((s) => s.addCustomTemplate);

  const [name, setName] = React.useState("");
  const [category, setCategory] = React.useState("Custom");
  const [newCategory, setNewCategory] = React.useState("");

  React.useEffect(() => {
    if (draft) {
      // Named from what was actually captured — see `librarySnapshotName`.
      setName(librarySnapshotName(draft));
      setCategory("Custom");
      setNewCategory("");
    }
  }, [draft]);

  const categories = React.useMemo(
    () => [...new Set(["Custom", ...TEMPLATE_CATEGORIES, ...customCategories])],
    [customCategories],
  );

  const close = () => useSession.getState().setAddToLibraryDraft(null);
  const creatingCategory = category === NEW_CATEGORY;

  const save = () => {
    if (!draft) return;
    let cat = category;
    if (creatingCategory) {
      const fresh = newCategory.trim();
      if (!fresh) {
        toast.error("Name the new category first");
        return;
      }
      addCategory(fresh);
      cat = fresh;
    }
    addCustomTemplate({
      name: name.trim() || librarySnapshotName(draft),
      category: cat,
      snapshot: draft,
      preview: previewFromSnapshot(draft),
    });
    toast.success(`Saved “${name.trim() || librarySnapshotName(draft)}” to library`);
    close();
  };

  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add to library</DialogTitle>
          <DialogDescription>Save this selection as a reusable component.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">Name</span>
            <input
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              className="w-full rounded-md border bg-input/40 px-2 py-1.5 text-sm outline-none focus:border-primary/60"
              spellCheck={false}
            />
          </label>

          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">Category</span>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_CATEGORY}>
                  <span className="text-primary">+ New category…</span>
                </SelectItem>
              </SelectContent>
            </Select>
            {creatingCategory && (
              <input
                value={newCategory}
                autoFocus
                onChange={(e) => setNewCategory(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
                placeholder="New category name"
                className="w-full rounded-md border bg-input/40 px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:border-primary/60"
                spellCheck={false}
              />
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={save}>Save to library</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
