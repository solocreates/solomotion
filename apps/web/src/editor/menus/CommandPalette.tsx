"use client";

import * as React from "react";
import {
  ArrowRight,
  AudioLines,
  Box,
  Captions,
  Clipboard,
  Copy,
  Download,
  Frame,
  Group,
  Hand,
  Magnet,
  MousePointer2,
  Play,
  Redo2,
  Scissors,
  SkipBack,
  Trash2,
  Type,
  Undo2,
  Ungroup,
} from "lucide-react";
import { toast } from "@/lib/toast";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useDocStore } from "../state/document-context";
import {
  addClipAtPlayhead,
  copySelection,
  deleteSelection,
  duplicateSelectedClips,
  groupSelection,
  pasteClipboard,
  splitAtPlayhead,
  ungroupSelection,
} from "../state/clip-actions";
import { useSession, type Tool } from "../state/session";
import { comboFor, comboFromEvent, formatCombo } from "../state/shortcut-registry";
import { useNavigator } from "./Navigator";
import { addWorldAtPlayhead, makeClips3d, makeFrame3d } from "../world/make-3d";
import { soundEngine } from "../audio/sound-engine";
import { redoActive, undoActive } from "../state/history";

/**
 * ⌘K — every action in the app, one search away. Opens even while an input
 * has focus (that's the point), so it owns its own key listener instead of
 * living in the useShortcuts map.
 */
export function CommandPalette() {
  const open = useSession((s) => s.commandPaletteOpen);
  const store = useDocStore();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (comboFromEvent(e) === comboFor("view.palette")) {
        e.preventDefault();
        const s = useSession.getState();
        s.setCommandPaletteOpen(!s.commandPaletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const close = () => useSession.getState().setCommandPaletteOpen(false);
  /** Run an action and close — every item goes through this. */
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const setTool = (tool: Tool) => run(() => useSession.getState().setTool(tool));

  return (
    <CommandDialog open={open} onOpenChange={(v) => useSession.getState().setCommandPaletteOpen(v)}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Go to">
          <CommandItem onSelect={run(() => useNavigator.getState().setOpen(true))}>
            <ArrowRight /> Go to a frame, world, component or layer… <CommandShortcut>{formatCombo(comboFor("view.navigator"))}</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="3D">
          <CommandItem onSelect={run(() => addWorldAtPlayhead(store))}>
            <Box /> Add a 3D world
          </CommandItem>
          <CommandItem
            onSelect={run(() => {
              const s = useSession.getState();
              if (s.selectedClipIds.length) makeClips3d(store, s.selectedClipIds);
              else if (s.activeFrameId) makeFrame3d(store, s.activeFrameId);
            })}
          >
            <Box /> Make the selection 3D
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Add">
          <CommandItem onSelect={run(() => addClipAtPlayhead(store, "text"))}>
            <Type /> New text layer
          </CommandItem>
          <CommandItem onSelect={run(() => addClipAtPlayhead(store, "caption"))}>
            <Captions /> New caption
          </CommandItem>
          <CommandItem onSelect={run(() => addClipAtPlayhead(store, "audio"))}>
            <AudioLines /> New sound clip
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Edit">
          <CommandItem onSelect={run(() => void copySelection(store).then((w) => w && toast(`Copied ${w}`)))}>
            <Copy /> Copy <CommandShortcut>⌘C</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => void copySelection(store, true).then((w) => w && toast(`Cut ${w}`)))}>
            <Scissors /> Cut <CommandShortcut>⌘X</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => void pasteClipboard(store).then((w) => w && toast(`Pasted ${w}`)))}>
            <Clipboard /> Paste <CommandShortcut>⌘V</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => duplicateSelectedClips(store))}>
            <Copy /> Duplicate <CommandShortcut>⌘D</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => deleteSelection(store))}>
            <Trash2 /> Delete selection <CommandShortcut>⌫</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => splitAtPlayhead(store))}>
            <Scissors /> Split at playhead <CommandShortcut>⌘B</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => groupSelection(store))}>
            <Group /> Group layers <CommandShortcut>⌘G</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => ungroupSelection(store))}>
            <Ungroup /> Ungroup <CommandShortcut>⇧⌘G</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => undoActive())}>
            <Undo2 /> Undo <CommandShortcut>⌘Z</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => redoActive())}>
            <Redo2 /> Redo <CommandShortcut>⇧⌘Z</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Tools">
          <CommandItem onSelect={setTool("select")}>
            <MousePointer2 /> Select tool <CommandShortcut>V</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={setTool("hand")}>
            <Hand /> Hand tool <CommandShortcut>H</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={setTool("text")}>
            <Type /> Text tool <CommandShortcut>T</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={setTool("frame")}>
            <Frame /> Frame tool <CommandShortcut>F</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Playback">
          <CommandItem
            onSelect={run(() => {
              soundEngine.ensure();
              useSession.getState().togglePlaying();
            })}
          >
            <Play /> Play / pause <CommandShortcut>Space</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => useSession.getState().setPlayhead(0))}>
            <SkipBack /> Jump to start <CommandShortcut>Home</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={run(() => useSession.getState().setSnapping(!useSession.getState().snapping))}
          >
            <Magnet /> Toggle snapping
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="File">
          <CommandItem onSelect={run(() => useSession.getState().setExportDialogOpen(true))}>
            <Download /> Export video / sequence…
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
