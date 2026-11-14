"use client";

import * as React from "react";
import { FolderOpen, Plus, Sparkles, Upload } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/lib/toast";
import { installPlugin } from "./install";
import { installSamplePlugin } from "./samples/title-card";
import { rememberDevHandle } from "./dev-folder";

/**
 * The ONE way into "get a plugin", as a menu on the Plugins panel's header.
 *
 * These three doors used to live in a separate manager DIALOG that also listed
 * every plugin — a second list of the same plugins, with its own row layout,
 * its own badges and its own idea of what "open" meant. Two surfaces answering
 * "what plugins do I have" is the bug; the panel is the survivor, so the doors
 * moved to it and the dialog is gone.
 */

interface DirectoryPickerWindow {
  showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
}

export function PluginInstallMenu() {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [canFolder, setCanFolder] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setCanFolder(typeof window !== "undefined" && "showDirectoryPicker" in window), []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // Cancelling the OS picker is not a failure worth a red toast.
      if (!/abort/i.test(msg)) toast.error(label, { description: msg });
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = () =>
    run("Couldn't install plugin", async () => {
      const file = fileInputRef.current?.files?.[0];
      if (!file) return;
      const res = await installPlugin({ kind: "zip", file });
      toast.success(res.replaced ? `Updated “${res.name}” to ${res.version}` : `Installed “${res.name}”`);
      if (fileInputRef.current) fileInputRef.current.value = "";
    });

  const onConnectFolder = () =>
    run("Couldn't connect folder", async () => {
      const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker;
      if (!picker) return;
      const handle = await picker({ mode: "read" });
      const res = await installPlugin({ kind: "folder", handle, folderName: handle.name });
      rememberDevHandle(res.id, handle);
      toast.success(`Connected “${res.name}” — live-reloading from ${handle.name}/`);
    });

  const onAddSample = () =>
    run("Couldn't add sample", async () => {
      const res = await installSamplePlugin();
      toast.success(res.replaced ? "Sample refreshed" : "Added the Title Card sample");
    });

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,.atomplugin,application/zip"
        className="hidden"
        onChange={onPickFile}
      />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Add a plugin"
                disabled={busy}
                // Bordered on purpose: beside a bordered field, a naked glyph
                // reads as an icon someone forgot to finish rather than a
                // control you can press.
                className="flex size-(--control-h) shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 [&_svg]:size-3.5"
              >
                <Plus />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Add a plugin</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
            <Upload /> Install from file…
          </DropdownMenuItem>
          {canFolder && (
            <DropdownMenuItem onClick={onConnectFolder}>
              <FolderOpen /> Connect a folder…
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onAddSample}>
            <Sparkles /> Add the sample plugin
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
