"use client";

import * as React from "react";
import { aspectRatioLabel, FRAME_SIZE_PRESETS, type FrameMode } from "@solomotion/core";
import { FrameModeSwitch } from "../frames/frame-modes";
import { BookmarkPlus, Link2, Link2Off, RectangleHorizontal, RectangleVertical, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { IconToggle, Inline, PanelSection, Pair, PropRow } from "../inspector/controls";
import { FramePresetList, type PickedPreset } from "../ui/FramePresets";
import { useWorkspace } from "../state/workspace";

/**
 * New project — the two-pane document dialog every serious tool ships (Photoshop's
 * New Document, AE's Composition Settings): a SIZE LIST on the left, the fields
 * that describe the document on the right, and a preview of the thing you are
 * about to make above them.
 *
 * The shape is the fix. The old one was a scrolling wall of three-across cards
 * with the size controls stranded in a footer below it, so the two halves of one
 * decision — "which size" and "what size" — were in different places and neither
 * could see the other. Here they are the same column: the list writes the fields,
 * the fields un-select the list ("Custom"), and one preview shows the result.
 *
 * Size is still ONE value. `size` is the truth; the selected row is derived from
 * it by matching, never stored, so the two can never disagree.
 */

export interface NewProjectSpec {
  name: string;
  width: number;
  height: number;
  /** The first frame's mode — a timeline, a flipbook, or a static design. */
  mode: FrameMode;
}

const DEFAULT_SIZE = { width: 1080, height: 1920 };

export function NewProjectDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (spec: NewProjectSpec) => void;
}) {
  const customPresets = useWorkspace((s) => s.customFramePresets);
  const addFramePreset = useWorkspace((s) => s.addFramePreset);

  const [name, setName] = React.useState("Untitled");
  const [size, setSize] = React.useState(DEFAULT_SIZE);
  const [linked, setLinked] = React.useState(false);
  // A project's kind is chosen per project, never remembered. It used to be
  // the frame tool's persisted mode, so drawing one flipbook frame with the
  // tool made every later project open as a sheet ("Row 1 ×300") — a hidden
  // preference deciding what a brand-new file is.
  const [mode, setMode] = React.useState<FrameMode>("timeline");

  // Fresh defaults each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setName("Untitled");
      setSize(DEFAULT_SIZE);
      setLinked(false);
      setMode("timeline");
    }
  }, [open]);

  // Which preset the current size IS — derived, so editing W/H drops to "Custom"
  // and typing your way back onto a preset re-selects it, with no second state.
  const matched = React.useMemo(
    () =>
      [...FRAME_SIZE_PRESETS, ...customPresets].find(
        (p) => p.width === size.width && p.height === size.height,
      ),
    [size, customPresets],
  );

  const ratio = size.width / size.height;
  const setWidth = (w: number) => {
    const width = clampPx(w);
    setSize((s) => ({ width, height: linked ? clampPx(Math.round(width / ratio)) : s.height }));
  };
  const setHeight = (h: number) => {
    const height = clampPx(h);
    setSize((s) => ({ height, width: linked ? clampPx(Math.round(height * ratio)) : s.width }));
  };
  // Orientation is not a stored field — it IS which of w/h is larger, so the
  // button swaps them rather than setting a flag that could disagree.
  const orient = (want: "portrait" | "landscape") =>
    setSize((s) => {
      const isPortrait = s.height >= s.width;
      return isPortrait === (want === "portrait") ? s : { width: s.height, height: s.width };
    });

  const create = (spec?: PickedPreset) => {
    onCreate({
      name: name.trim() || "Untitled",
      width: spec?.width ?? size.width,
      height: spec?.height ?? size.height,
      mode,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // Radix focuses the first focusable child on open, which here is a
        // BUTTON in the header — so the preset list, which owns ↑/↓/Enter,
        // never got the keys. Declining Radix's autofocus lets the list's own
        // `autoFocus` stand. It is focused as a REGION, not as a text field:
        // the search box used to take the caret, which put a keyboard over
        // half the dialog on a tablet and a blinking cursor in a filter nobody
        // asked to use. Typing still searches — the list forwards the first
        // printable key into the field.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="flex h-[34rem] max-h-[86vh] w-[40rem] max-w-[94vw] flex-col gap-0 overflow-hidden p-0 shadow-[var(--elevation-3)]"
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <DialogTitle className="text-sm font-semibold tracking-tight">New project</DialogTitle>
          <DialogDescription className="sr-only">
            Choose a frame size for the new project, or set a custom one.
          </DialogDescription>
          <div className="flex-1" />
          <DialogClose className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
            <X className="size-3.5" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Left: the sizes. Recessed onto `--panel` so the split reads as two
              planes rather than as a box drawn inside a box. */}
          <FramePresetList
            className="min-w-0 flex-1 border-r border-border bg-[var(--panel)]"
            autoFocus
            isSelected={(p) => p.width === size.width && p.height === size.height}
            onPick={(p) => setSize({ width: p.width, height: p.height })}
            onActivate={(p) => create(p)}
          />

          {/* Right: what the document IS. Same row grammar as the inspector — a
              size dialog and the frame panel are the same fields twice. */}
          <aside className="flex w-[17rem] shrink-0 flex-col">
            <ScrollArea className="min-h-0 flex-1">
              <SizePreview
                width={size.width}
                height={size.height}
                label={matched?.name ?? "Custom size"}
              />

              <PanelSection title="Project" collapsible={false}>
                <PropRow label="Name">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && create()}
                    spellCheck={false}
                    className="h-7 w-full rounded-md bg-input px-2 text-xs text-foreground outline-none transition-colors focus:bg-muted focus:ring-1 focus:ring-ring"
                  />
                </PropRow>
              </PanelSection>

              <PanelSection title="Frame" collapsible={false}>
                <PropRow wide>
                  <FrameModeSwitch value={mode} onChange={setMode} />
                </PropRow>
                <PropRow label="Size">
                  <Inline
                    trailing={
                      <IconToggle
                        label="Lock aspect ratio"
                        pressed={linked}
                        onClick={() => setLinked((v) => !v)}
                      >
                        {linked ? <Link2 /> : <Link2Off />}
                      </IconToggle>
                    }
                  >
                    <Pair>
                      <NumberInput
                        label="W"
                        value={size.width}
                        min={16}
                        max={8192}
                        precision={0}
                        onChange={setWidth}
                      />
                      <NumberInput
                        label="H"
                        value={size.height}
                        min={16}
                        max={8192}
                        precision={0}
                        onChange={setHeight}
                      />
                    </Pair>
                  </Inline>
                </PropRow>

                {/* Full-bleed: "Orientation" does not fit the 56px label column,
                    and a labelled pair of buttons needs no label anyway. */}
                <PropRow wide>
                  <div className="grid grid-cols-2 gap-1">
                    <OrientationButton
                      icon={<RectangleVertical />}
                      label="Portrait"
                      active={size.height > size.width}
                      onClick={() => orient("portrait")}
                    />
                    <OrientationButton
                      icon={<RectangleHorizontal />}
                      label="Landscape"
                      active={size.width > size.height}
                      onClick={() => orient("landscape")}
                    />
                  </div>
                </PropRow>

                <PropRow wide>
                  <SavePresetButton
                    size={size}
                    matchedName={matched?.name}
                    onSave={(nm) => addFramePreset({ name: nm, width: size.width, height: size.height })}
                  />
                </PropRow>
              </PanelSection>
            </ScrollArea>

            <div className="flex shrink-0 gap-2 border-t border-border p-3">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" className="flex-1" onClick={() => create()}>
                Create
              </Button>
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function clampPx(v: number) {
  return Math.max(16, Math.min(8192, Math.round(v)));
}

/**
 * The document, to scale. A number pair is not a shape — this is the only thing
 * in the dialog that tells you at a glance that you are about to make something
 * tall, and it animates between sizes so clicking down the list reads as one
 * object changing rather than ten unrelated cards.
 */
function SizePreview({ width, height, label }: { width: number; height: number; label: string }) {
  const scale = Math.min(150 / width, 96 / height);
  return (
    <div className="p-3">
      <div className="flex h-[7.5rem] items-center justify-center rounded-lg bg-[var(--stage)] ring-1 ring-inset ring-border">
        <div
          className="rounded-[3px] bg-primary/15 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_55%,transparent)] transition-all duration-200 ease-out"
          style={{ width: Math.max(8, width * scale), height: Math.max(8, height * scale) }}
        />
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium">{label}</span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {width}×{height} · {aspectRatioLabel(width, height)}
        </span>
      </div>
    </div>
  );
}

function OrientationButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center justify-center gap-1.5 rounded-md text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-3.5",
        active
          ? "material-glass-raised text-primary"
          : "bg-input text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** Save the current size as a named app-level preset — it then appears under
 *  "Saved" in this list AND in the frame tool, since both read one source. */
function SavePresetButton({
  size,
  matchedName,
  onSave,
}: {
  size: { width: number; height: number };
  matchedName?: string;
  onSave: (name: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  React.useEffect(() => {
    if (open) setName("");
  }, [open]);
  const fallback = `${size.width}×${size.height}`;
  const save = () => {
    onSave(name.trim() || fallback);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="w-full justify-start"
          disabled={!!matchedName}
          title={matchedName ? `This size is already “${matchedName}”` : undefined}
        >
          <BookmarkPlus /> Save size as preset
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 space-y-2 p-2" side="left" align="end">
        <span className="block text-2xs font-semibold uppercase tracking-[0.09em] text-muted-foreground">
          Preset name
        </span>
        <input
          value={name}
          autoFocus
          placeholder={fallback}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          spellCheck={false}
          className="h-7 w-full rounded-md bg-input px-2 text-xs outline-none focus:bg-muted focus:ring-1 focus:ring-ring"
        />
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="xs" onClick={save}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
