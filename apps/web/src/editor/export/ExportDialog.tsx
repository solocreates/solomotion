"use client";

import * as React from "react";
import {
  frameTarget,
  framesTarget,
  selectionTarget,
  type ExportMedium,
  type ExportTarget,
} from "@solomotion/core";
import { FileImage } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Segmented } from "@/components/ui/segmented";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { ExportPanel } from "./ExportPanel";

/**
 * The export dialog — a thin shell around the ONE ExportPanel.
 *
 * Two subjects, Figma-style: the whole composition (with a comp picker when
 * the doc has several) and, whenever layers are selected, the selection as a
 * second tab named after it ("Logo", "3 layers", a group's name…). Menu items
 * preselect a subject/medium through `session.exportIntent`; the panel itself
 * decides smart defaults (video for anything that moves, SVG for pure
 * vectors) — identical behavior to the sidebar Export section, because it IS
 * the same component.
 */
export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const doc = useDoc();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const selectedFrameIds = useSession((s) => s.selectedFrameIds);
  const intent = useSession((s) => s.exportIntent);

  const [frameId, setFrameId] = React.useState<string | null>(null);
  const [subject, setSubject] = React.useState<"frame" | "selection" | "frames">("frame");
  // Several frames picked on the board — captured on open, IN PICK ORDER, the
  // order a PDF's pages and a batch's files follow.
  const [pickedFrames, setPickedFrames] = React.useState<string[]>([]);
  const [initialMedium, setInitialMedium] = React.useState<ExportMedium | null>(null);
  const [rendering, setRendering] = React.useState(false);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const cancelRender = React.useRef<(() => void) | null>(null);

  // Selection is captured when the dialog OPENS — clicking around beneath the
  // dialog must not silently retarget a running configuration.
  const [selTarget, setSelTarget] = React.useState<ExportTarget | null>(null);
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      const sel = selectionTarget(doc, selectedClipIds);
      setSelTarget(sel);
      const frames = selectedFrameIds.length > 1 ? [...selectedFrameIds] : [];
      setPickedFrames(frames);
      setSubject(intent?.scope === "selection" && sel ? "selection" : frames.length > 1 ? "frames" : "frame");
      setInitialMedium(intent?.medium ?? null);
      setFrameId(null);
      setConfirmCancel(false);
    }
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const frame = doc.frames.find((f) => f.id === (frameId ?? activeFrameId)) ?? doc.frames[0];
  if (!frame) return <NothingToExport open={open} onOpenChange={onOpenChange} />;
  const target: ExportTarget =
    subject === "selection" && selTarget
      ? selTarget
      : subject === "frames" && pickedFrames.length > 1
        ? framesTarget(doc, pickedFrames)
        : frameTarget(doc, frame.id);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // Closing mid-render (ESC, outside click, ×) asks first — an accidental
        // click must not throw away minutes of rendering.
        if (!v && rendering) {
          setConfirmCancel(true);
          return;
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="flex max-h-[88vh] max-w-lg flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-line px-5 py-4">
          <DialogTitle>Export</DialogTitle>
          <DialogDescription className="text-meta">
            {subject === "selection" && selTarget
              ? selTarget.name
              : subject === "frames" && pickedFrames.length > 1
                ? `${pickedFrames.length} frames, in the order you picked them`
                : `${frame.name} · ${frame.width}×${frame.height}`}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-5 py-4" contentClassName="space-y-4">
          {/* Subject tabs — the frame, or the captured selection by name. */}
          {(selTarget || pickedFrames.length > 1) && (
            <Segmented
              aria-label="What to export"
              stretch
              disabled={rendering}
              value={subject}
              onChange={setSubject}
              options={[
                ...(pickedFrames.length > 1 ? [{ value: "frames" as const, label: `${pickedFrames.length} frames` }] : []),
                { value: "frame" as const, label: frame.name },
                ...(selTarget ? [{ value: "selection" as const, label: selTarget.name }] : []),
              ]}
            />
          )}

          {/* Comp picker — only for the frame subject with several comps. */}
          {subject === "frame" && doc.frames.length > 1 && (
            <Select value={frame.id} onValueChange={setFrameId} disabled={rendering}>
              <SelectTrigger className="h-9 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {doc.frames.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name} · {f.width}×{f.height}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <ExportPanel
            target={target}
            variant="dialog"
            initialMedium={initialMedium}
            onRenderingChange={setRendering}
            onDone={() => onOpenChange(false)}
            cancelRef={cancelRender}
          />

          {confirmCancel && rendering && (
            <div className="flex w-full gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setConfirmCancel(false)}>
                Keep rendering
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                onClick={() => {
                  // Closing the dialog used to leave the render running with no
                  // way back to it but the Activity panel. Close means stop.
                  cancelRender.current?.();
                  setConfirmCancel(false);
                  onOpenChange(false);
                }}
              >
                Cancel and close
              </Button>
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/** An empty project: nothing to render yet, and the dialog says so plainly. */
function NothingToExport({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileImage className="size-4 text-primary" /> Export
          </DialogTitle>
          <DialogDescription>There are no frames to export yet.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
