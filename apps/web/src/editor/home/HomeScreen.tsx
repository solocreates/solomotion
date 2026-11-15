"use client";

import { identity } from "@/editor/identity";
import * as React from "react";
import { createEmptyDocument } from "@solomotion/core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FilerLayout } from "../filer/FilerToolbar";
import { NewFolderDialog } from "../filer/NewFolderDialog";
import { TrashView } from "../filer/TrashView";
import { useFiler, useFilerManager } from "../filer/use-file-manager";
import { useAppShell } from "../state/app-shell";
import { useDocStore } from "../state/document-context";
import { pickAndImportProject } from "../state/open-project";
import { createProject, createProjectId } from "../state/project-store";
import { makeResident } from "../state/project-index";
import { createProjectsAdapter } from "./projects-adapter";
import { NAMES } from "@/editor/names";
import type { HomeLayoutId } from "@/editor/product-types";
import { renderProjectThumb, type HomeKit, type HomePlace, type NewPreset } from "./home-kit";
import { BrowserHome } from "./BrowserHome";
import { StudioHome } from "./StudioHome";

/**
 * HOME — where you open, start and tidy projects.
 *
 * This screen OWNS Home: the filer store (every interaction — selection,
 * marquee, drag-to-folder, keys, menus — rides the headless `filer/` engine),
 * where you are, and every action. It hands them to the product's layout
 * (`identity.home`) as one `HomeKit`; a layout only composes, so two products
 * can look nothing alike and still behave as one.
 */
const LAYOUTS: Record<HomeLayoutId, React.ComponentType<{ kit: HomeKit }>> = {
  browser: BrowserHome,
  studio: StudioHome,
};

const LAYOUT_KEY = NAMES.storage.homeLayout;
function readLayout(): FilerLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

const LEARN_URL = `${identity.siteUrl}/docs`;

export function HomeScreen() {
  const store = useDocStore();
  const openNewProject = useAppShell((s) => s.openNewProject);
  const adapter = React.useMemo(() => createProjectsAdapter(), []);
  const fm = useFilerManager(adapter);
  // Search always means "everywhere" here, and Home opens on Recents — set
  // before the first paint, so Projects never flashes first.
  const primed = React.useRef<typeof fm | null>(null);
  if (primed.current !== fm) {
    primed.current = fm;
    fm.setState((st) => ({ search: { ...st.search, recursive: true, flat: true } }));
  }
  const loading = useFiler(fm, (s) => s.loading);
  const flat = useFiler(fm, (s) => Boolean(s.search.flat));
  const folderId = useFiler(fm, (s) => s.currentFolderId);
  const query = useFiler(fm, (s) => s.search.query);
  const isEmpty = useFiler(fm, (s) => s.tree.items.length === 0 && s.tree.folders.length === 0);
  const section = useAppShell((s) => s.homeSection);
  const place: HomePlace = section === "community" && identity.examples ? "explore" : flat ? "recents" : "projects";
  const [layout, setLayoutState] = React.useState<FilerLayout>("grid");
  React.useEffect(() => setLayoutState(readLayout()), []);
  const setLayout = (next: FilerLayout) => {
    setLayoutState(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* a private window keeps it for this visit */
    }
  };

  const go = (to: HomePlace) => {
    const shell = useAppShell.getState();
    if (to === "explore") return shell.setHomeSection("community");
    shell.setHomeSection("projects");
    if (to === "recents") fm.getState().setFlat(true);
    else fm.getState().navigate(null);
  };

  // New-folder dialog, shared by the sidebar/background menu and "Move to → New
  // folder…". A pending id set means: create the folder, then move it into it.
  const [folderDialog, setFolderDialog] = React.useState<{ open: boolean; moveIds: string[] | null }>({
    open: false,
    moveIds: null,
  });
  const submitNewFolder = async (name: string) => {
    if (fm.getState().search.flat) fm.getState().navigate(null);
    const id = await fm.getState().newFolder(name);
    if (folderDialog.moveIds?.length) await fm.getState().move(folderDialog.moveIds, id);
  };

  // Delete confirm, shared by the keyboard, context menu and three-dot menu.
  const [deleteIds, setDeleteIds] = React.useState<string[] | null>(null);

  const createSized = (preset: NewPreset) => {
    const doc = createEmptyDocument(preset.name);
    const frame = doc.frames[0]!;
    frame.width = preset.width;
    frame.height = preset.height;
    const id = createProjectId();
    void createProject(id, doc);
    makeResident(store, id, doc);
  };

  const kit: HomeKit = {
    fm,
    place,
    go,
    layout,
    setLayout,
    loading,
    isEmpty,
    showNewRow: place !== "explore" && !query && (place === "recents" || folderId === null),
    title: place === "recents" ? "Recents" : place === "explore" ? "Explore" : null,
    learnUrl: LEARN_URL,
    examples: identity.examples,
    openNewProject,
    createSized,
    importProject: () => void pickAndImportProject(store),
    newFolder: () => setFolderDialog({ open: true, moveIds: null }),
    moveToNewFolder: (ids) => setFolderDialog({ open: true, moveIds: ids }),
    requestDelete: setDeleteIds,
    renderThumb: renderProjectThumb,
  };
  const Layout = LAYOUTS[identity.home];

  return (
    <>
      <Layout kit={kit} />
      <NewFolderDialog
        open={folderDialog.open}
        onOpenChange={(open) => setFolderDialog((s) => ({ ...s, open }))}
        onSubmit={submitNewFolder}
        title={folderDialog.moveIds ? "Move to new folder" : "New folder"}
      />
      <TrashView fm={fm} itemThumbUrl={(item) => item.data.thumbnail} />
      <DeleteConfirm
        ids={deleteIds}
        onCancel={() => setDeleteIds(null)}
        onConfirm={() => {
          if (deleteIds) void fm.getState().trashNodes(deleteIds);
          setDeleteIds(null);
        }}
      />
    </>
  );
}

function DeleteConfirm({
  ids,
  onCancel,
  onConfirm,
}: {
  ids: string[] | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const n = ids?.length ?? 0;
  return (
    <Dialog open={ids !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Move {n === 1 ? "item" : `${n} items`} to Recently Deleted?</DialogTitle>
          <DialogDescription>
            You can restore {n === 1 ? "it" : "them"} later from Recently Deleted. Deleting a folder removes
            everything inside it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
