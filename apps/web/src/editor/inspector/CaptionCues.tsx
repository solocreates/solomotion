"use client";

import * as React from "react";
import {
  MIN_CUE_MS,
  activeCueIndexAt,
  buildCues,
  cueEdgeBounds,
  cueTextOf,
  cuesMisfitClip,
  dragCueEdge,
  fitCuesToClip,
  distributeCues,
  locateClip,
  mergeCueWithNext,
  normalizeCues,
  spliceClipText,
  replaceCueText,
  shiftCueSplit,
  splitCue,
  stampCueStart,
  type CaptionCue,
  type CueGrain,
  type TextClip,
} from "@solomotion/core";
import { ChevronLeft, ChevronRight, CircleDot, MoveHorizontal, Redo2, Scissors, Merge } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { PanelSection } from "./controls";
import { useClipUpdater } from "./use-clip-updater";

/**
 * THE CUE LIST — a caption's rows, the way a subtitle editor shows them.
 *
 * Every row is a span of the clip's ONE string, so the two edits people
 * actually make are cheap and lossless:
 *
 *  - retype a row → the string is spliced once and every other row's timing
 *    survives it (this used to rebuild the word list and re-time everything);
 *  - make a row longer or shorter → the split moves and the words cascade
 *    through every row after it. Not one character is moved, and no timing
 *    changes: which words are on a row and how long a row is on screen are
 *    two separate decisions, and the panel keeps them separate.
 *
 * Nothing here styles anything. How a row LOOKS is the Focus scope in the text
 * inspector, which is the whole text sidebar pointed at the words in focus.
 */
export function CaptionCues({ clip }: { clip: TextClip }) {
  const caption = clip.caption;
  if (!caption) return null;
  return <CueList clip={clip} cues={caption.cues} />;
}

function CueList({ clip, cues }: { clip: TextClip; cues: CaptionCue[] }) {
  const store = useDocStore();
  const update = useClipUpdater(clip.id);
  const [tapIndex, setTapIndex] = React.useState<number | null>(null);
  const rowRefs = React.useRef<Array<HTMLDivElement | null>>([]);

  const activeIndex = useSession((s) =>
    s.playheadMs >= clip.startMs && s.playheadMs < clip.startMs + clip.durationMs
      ? activeCueIndexAt(clip.caption!, s.playheadMs - clip.startMs)
      : -1,
  );
  const playing = useSession((s) => s.playing);
  // The cues and the clip disagree about how long the line is — crushed into
  // the head of a clip that grew, or hanging past one that was trimmed in.
  // The one state where "fit" is the answer, so the control says so rather
  // than sitting there looking like every other chip.
  const stranded = cuesMisfitClip(cues, clip.durationMs);

  React.useEffect(() => {
    if (activeIndex >= 0) rowRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  React.useEffect(() => {
    if (!playing) setTapIndex(null);
  }, [playing]);

  /** Every cue write ends in `normalizeCues`, so no row can leave the invariant. */
  const writeCues = (label: string, next: (cues: CaptionCue[], clip: TextClip) => CaptionCue[] | void, mergeKey?: string) =>
    update(
      label,
      (c) => {
        if (c.kind !== "text" || !c.caption) return;
        const result = next(c.caption.cues, c);
        c.caption.cues = normalizeCues(result ?? c.caption.cues, Infinity, c.durationMs);
      },
      mergeKey,
    );

  /**
   * Retype one row. Splices the clip's string and re-indexes BOTH the cues and
   * the style ranges against the same splice — the one place a caption edit and
   * a rich-text edit have to agree, and now they agree by construction.
   */
  const retypeRow = (cue: CaptionCue, text: string) => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed === cueTextOf(clip.text, cue)) return;
    store.update("Edit cue text", (d) => {
      const loc = locateClip(d, clip.id);
      if (!loc || loc.clip.kind !== "text" || !loc.clip.caption) return;
      const live = loc.clip.caption.cues.find((c) => c.id === cue.id);
      if (!live) return;
      const edit = replaceCueText(loc.clip.text, live, trimmed);
      // The pivot holds its point on its own (core `holdTextPivots`).
      spliceClipText(loc.clip, edit.text, edit);
      loc.clip.name = edit.text.slice(0, 24) || "Caption";
    });
  };

  const recut = (grain: CueGrain) =>
    writeCues(`Re-cut by ${grain}`, (_, c) => buildCues(c.text, c.durationMs, grain));

  const armTapSync = () => {
    const session = useSession.getState();
    session.select([clip.id]);
    session.setPlayhead(clip.startMs);
    session.setPlaying(true);
    setTapIndex(0);
  };

  const tap = () => {
    if (tapIndex === null) return;
    const local = useSession.getState().playheadMs - clip.startMs;
    writeCues("Sync cue", (cs, c) => void stampCueStart(cs, tapIndex, local, c.durationMs), "tap-sync");
    const next = tapIndex + 1;
    if (next >= cues.length) {
      setTapIndex(null);
      useSession.getState().setPlaying(false);
      toast.success("All cues synced");
    } else {
      setTapIndex(next);
    }
  };

  return (
    <PanelSection
      title="Cues"
      collapsible={false}
      actions={
        <div className="flex items-center gap-1">
          <Select value="" onValueChange={(v) => recut(v as CueGrain)}>
            <SelectTrigger className="h-5 w-auto gap-1 border-0 bg-secondary px-2 font-mono text-[10px] text-muted-foreground hover:text-foreground">
              <SelectValue placeholder="re-cut" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="word">One word per cue</SelectItem>
              <SelectItem value="line">One line per cue</SelectItem>
              <SelectItem value="letter">One letter per cue</SelectItem>
            </SelectContent>
          </Select>
          <button
            type="button"
            title="Stretch the cues to fill the clip, keeping their rhythm"
            className={cn(
              "flex h-5 items-center gap-1 rounded-(--r-xs) px-2 font-mono text-[10px] transition-colors",
              stranded
                ? "bg-primary/15 text-primary hover:bg-primary/25"
                : "bg-secondary text-muted-foreground hover:text-foreground",
            )}
            onClick={() => writeCues("Fit cues to clip", (cs, c) => fitCuesToClip(cs, c.durationMs))}
          >
            <MoveHorizontal className="size-2.5" /> fit
          </button>
          <button
            type="button"
            title="Spread every cue evenly across the clip"
            className="flex h-5 items-center gap-1 rounded-(--r-xs) bg-secondary px-2 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => writeCues("Even cues", (cs, c) => distributeCues(cs, c.durationMs))}
          >
            <Redo2 className="size-2.5" /> even
          </button>
        </div>
      }
    >
      {tapIndex === null ? (
        <Button variant="secondary" size="sm" className="w-full gap-1.5 text-xs" onClick={armTapSync}>
          <CircleDot className="size-3.5 text-primary" /> Tap sync — play &amp; tap each cue
        </Button>
      ) : (
        <Button
          size="sm"
          className="w-full animate-pulse gap-1.5 text-xs"
          onPointerDown={(e) => {
            e.preventDefault();
            tap();
          }}
        >
          Tap now → “{cueTextOf(clip.text, cues[tapIndex]!)}” ({tapIndex + 1}/{cues.length})
        </Button>
      )}

      <ScrollArea className="max-h-[22rem] rounded-md border border-border/60" viewportClassName="p-px" contentClassName="space-y-px">
        {cues.map((cue, i) => (
          <CueRow
            key={cue.id}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            clip={clip}
            cue={cue}
            index={i}
            last={i === cues.length - 1}
            active={i === activeIndex}
            onSeek={() => {
              const session = useSession.getState();
              session.setPlaying(false);
              session.setPlayhead(clip.startMs + cue.startMs + 1);
            }}
            onRetype={(text) => retypeRow(cue, text)}
            onShiftSplit={(delta) =>
              writeCues("Move words", (cs, c) => shiftCueSplit(cs, i, delta, c.text))
            }
            onDuration={(ms) =>
              writeCues(
                "Cue length",
                // THE gesture verb, not the invariant helper: a length typed
                // here pushes the cues after it exactly as dragging the ribbon
                // does, so the last cue can be lengthened at all.
                (cs, c) => void dragCueEdge(cs, cue.id, "end", cue.startMs + ms, c.durationMs),
                `cue-len-${cue.id}`,
              )
            }
            onStart={(ms) =>
              writeCues("Cue start", (cs, c) => void dragCueEdge(cs, cue.id, "start", ms, c.durationMs), `cue-start-${cue.id}`)
            }
            onSplit={() =>
              writeCues("Split cue", (cs) => splitCue(cs, i, Math.floor((cue.start + cue.end) / 2)))
            }
            onMerge={() => writeCues("Merge cues", (cs) => mergeCueWithNext(cs, i))}
          />
        ))}
        {cues.length === 0 && (
          <button
            type="button"
            className="w-full px-2 py-3 text-center text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => recut("word")}
          >
            Cut this text into cues
          </button>
        )}
      </ScrollArea>
    </PanelSection>
  );
}

interface CueRowProps {
  clip: TextClip;
  cue: CaptionCue;
  index: number;
  last: boolean;
  active: boolean;
  onSeek: () => void;
  onRetype: (text: string) => void;
  onShiftSplit: (deltaWords: number) => void;
  onDuration: (ms: number) => void;
  onStart: (ms: number) => void;
  onSplit: () => void;
  onMerge: () => void;
}

const CueRow = React.forwardRef<HTMLDivElement, CueRowProps>(function CueRow(
  { clip, cue, index, last, active, onSeek, onRetype, onShiftSplit, onDuration, onStart, onSplit, onMerge },
  ref,
) {
  const text = cueTextOf(clip.text, cue);
  // The row's own text is the draft's source of truth: an edit elsewhere (a
  // canvas keystroke, an undo) re-seeds it, and typing here does not fight it.
  const [draft, setDraft] = React.useState(text);
  React.useEffect(() => setDraft(text), [text]);
  const cues = clip.caption!.cues;
  const startBounds = cueEdgeBounds(cues, cue.id, "start", clip.durationMs);
  const endBounds = cueEdgeBounds(cues, cue.id, "end", clip.durationMs);

  return (
    <div
      ref={ref}
      className={cn(
        "group grid grid-cols-[1.25rem_1fr_auto] items-center gap-1 rounded-sm px-1.5 py-1 text-xs transition-colors",
        active ? "bg-primary/10" : "hover:bg-accent/50",
      )}
    >
      <button
        type="button"
        onClick={onSeek}
        title={`Jump to ${((clip.startMs + cue.startMs) / 1000).toFixed(2)}s`}
        className={cn(
          "text-left font-mono text-[9px] tabular-nums transition-colors",
          active ? "text-primary" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {index + 1}
      </button>

      <input
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onRetype(draft)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(text);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={cn(
          "min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 outline-none transition-colors",
          "hover:border-border/60 focus-visible:border-primary/60 focus-visible:bg-input/40",
          active && "font-medium text-primary",
        )}
      />

      <div className="flex items-center gap-0.5">
        <div className="flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <RowButton title="Give a word to the next cue" onClick={() => onShiftSplit(-1)} disabled={last}>
            <ChevronLeft className="size-3" />
          </RowButton>
          <RowButton title="Take a word from the next cue" onClick={() => onShiftSplit(1)} disabled={last}>
            <ChevronRight className="size-3" />
          </RowButton>
          <RowButton title="Split this cue in two" onClick={onSplit} disabled={cue.end - cue.start < 2}>
            <Scissors className="size-3" />
          </RowButton>
          <RowButton title="Merge with the next cue" onClick={onMerge} disabled={last}>
            <Merge className="size-3" />
          </RowButton>
        </div>
        {/* START and LENGTH, because those are the two numbers a person edits
            and only one of them was here. Both read their reach from the SAME
            `cueEdgeBounds` the ribbon's drag clamps against, so a field can no
            longer advertise a maximum it cannot get to — which is precisely
            what made the last cue look stuck. */}
        <NumberInput
          value={cue.startMs / 1000}
          min={(startBounds?.lo ?? 0) / 1000}
          max={(startBounds?.hi ?? clip.durationMs) / 1000}
          step={0.01}
          precision={2}
          unit="s"
          className="h-5.5 w-14"
          title="When this cue takes focus — drag to scrub"
          onChange={(v) => onStart(v * 1000)}
        />
        <NumberInput
          value={(cue.endMs - cue.startMs) / 1000}
          min={MIN_CUE_MS / 1000}
          max={Math.max(MIN_CUE_MS, (endBounds?.hi ?? clip.durationMs) - cue.startMs) / 1000}
          step={0.01}
          precision={2}
          unit="s"
          className="h-5.5 w-14"
          title="How long this cue holds focus — drag to scrub"
          onChange={(v) => onDuration(v * 1000)}
        />
      </div>
    </div>
  );
});

function RowButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
