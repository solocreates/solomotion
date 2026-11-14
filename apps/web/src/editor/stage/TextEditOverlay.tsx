"use client";

import * as React from "react";
import {
  clipLocalTime,
  effectiveRanges,
  deleteClip,
  keyedText,
  setKeyedEditing,
  evaluateClipPose,
  gcOrphanNestedSources,
  locateClip,
  propertyHasKeys,
  resolveColor,
  resolveTextStyle,
  segmentTextCached,
  type StyleRange,
  type TextClip,
  type ResolvedTextStyle,
  type TextStyle,
  type MotionDocument,
  centerOffset,
  clipBox,
  mapLocal,
} from "@solomotion/core";
import { ClipboardPaste, Copy, Link2, Scissors, TextSelect, Trash2 } from "lucide-react";
import { pastedLinkTarget, textLinkAt } from "@solomotion/core";
import { openLinkEditor } from "../links/LinkEditor";
import { linkParseContext } from "../links/navigate";
import { setScopeLink } from "../links/link-scope";
import { comboFor, comboFromEvent } from "../state/shortcut-registry";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { isTypingTarget } from "../input/typing-target";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useStageView } from "../state/session";
import { clipboardPlainText } from "../state/clip-actions";
import { commitTextContent } from "../state/text-content";
import { layerEffectCssText } from "./render/layer-effect-css";
import { glyphPaintsFor, type GlyphPaints, type PaintSet } from "./render/draw-frame";
import { frameSpace, layerSpace } from "./edit-space";
import { pathTextRide } from "./text-path-chrome";
import { useResolvedDoc } from "../nodes/use-resolved";
import {
  boxWidthOf,
  domBaselineDrift,
  fauxBoldOutset,
  glyphStyleAt,
  highlightPills,
  layoutOverridesFor,
  layoutTextClip,
  type LayoutOverrides,
} from "./render/text-layout";

/**
 * Inline text editing on the canvas (double-click a text layer).
 *
 * A contentEditable overlay replaces the canvas-drawn clip, styled span-by-span
 * from the clip's ranges so styling is visible while you edit. Text flows
 * DOM → document store (splice-diffed, ranges remapped); the DOM is rebuilt
 * from the store after every change with the caret restored — one source of
 * truth, no drift. Selecting a range switches the inspector into range mode.
 */

export function TextEditOverlay() {
  // Reads the live stage — drag state, edit spaces, pointer geometry — every
  // render, outside React, by design. Memoising it would freeze the overlay.
  "use no memo";
  const doc = useDoc();
  const store = useDocStore();
  const editingClipId = useSession((s) => s.editingClipId);
  // Reactive playhead — but only while editing, so this component stays inert
  // during playback (which always exits edit mode). Honors the "playback never
  // re-renders React" contract while making the overlay a live view of the SAME
  // evaluation the canvas draws: scrub and it re-positions, re-styles and
  // re-contents in real time (keyframed motion, typography and content).
  const playheadMs = useSession((s) => (s.editingClipId ? s.playheadMs : 0));
  const view = useStageView();
  const rootRef = React.useRef<HTMLDivElement>(null);
  /** Desired selection in grapheme offsets, restored after each rebuild. */
  const desiredSelection = React.useRef<{ start: number; end: number } | null>(null);
  const suppressSelectionEvent = React.useRef(false);
  /** The exact string the current DOM was built from (effective at the time). */
  const renderedTextRef = React.useRef("");
  /** The context-menu verb chosen, run once focus and the caret are back. */
  const pendingAction = React.useRef<null | (() => void | Promise<void>)>(null);

  // Register BEFORE anything below reads content: while a clip is edited, all
  // of core reads its keyed text, never a number mid-count (see `keyedText`).
  setKeyedEditing(editingClipId);
  React.useEffect(() => () => setKeyedEditing(null), []);
  const loc = editingClipId ? locateClip(doc, editingClipId) : null;
  const clip = loc && loc.clip.kind === "text" ? (loc.clip as TextClip) : null;

  // A text ON A PATH keeps its glyphs on the canvas — there is no straight box
  // for a DOM editor to stand in for — so this overlay becomes the invisible
  // carrier of the keys and the DOM selection, parked on the host's box, and
  // the stage overlay paints the caret on the curve. Its pose is the HOST's
  // (the resolved document has already made it the text's own).
  // The RESOLVED clip carries the pose: a text on a path has its host's, a
  // member of a laid-out row has the row's, and a plain text has its own —
  // the same values the canvas painted, whichever relation put them there.
  const rdoc = useResolvedDoc();
  const ride = clip ? pathTextRide(clip, rdoc) : null;
  const rclip = clip ? ((locateClip(rdoc, clip.id)?.clip as TextClip | undefined) ?? clip) : clip;

  // Effective state at the playhead — mirrors evaluateClipPose + effectiveText
  // + resolveGlyphStyle so the editable spans match the rendered clip exactly.
  const local = clip ? clipLocalTime(clip, playheadMs) ?? 0 : 0;
  const pose = rclip ? evaluateClipPose(rclip, local) : null;
  // The KEYED text, not a number mid-count: typing writes the key.
  const effText = clip ? keyedText(clip, local) : "";
  const overrides: LayoutOverrides | undefined = pose ? layoutOverridesFor(pose) : undefined;
  // The box the clip actually lays out in right now — keyframed box width makes
  // this differ from `clip.maxWidth`, and the edit box must track the rendered
  // one or typing jumps the moment you focus.
  const boxW = clip ? boxWidthOf(clip, overrides) : null;
  // Measure the editable box with the SAME engine the canvas draws with, so the
  // editing box is pixel-identical to the rendered (and selected) box — no jump
  // in size or position when you focus/blur. Auto-width takes the measured
  // content width; a fixed/wrap box takes maxWidth. Height always follows the
  // layout (content block, or the fixed box height).
  // Typography with bindable values (var: tokens) resolved to literals — the
  // layout measures with it, and so must anything measuring alongside it.
  const rStyle = clip ? resolveTextStyle(doc, clip.style) : null;
  // The SAME ranges the canvas is painting with at this instant — a caption's
  // focused cue included, so the pill under the spoken word does not blink out
  // the moment you double-click into it.
  const ranges: StyleRange[] = clip ? effectiveRanges(clip, local) : [];
  const layout =
    clip && rStyle
      ? layoutTextClip(getMeasureCtx(), clip, overrides, effText === clip.text ? undefined : effText, rStyle, ranges)
      : null;
  // Rebuild the DOM whenever the effective content/styling changes (clip edits
  // OR the playhead moving over keyframes), keeping the caret.
  const renderSig = `${effText} ${JSON.stringify(overrides ?? null)}`;

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !clip) return;
    // Only pull the DOM selection back if WE still own focus. When the edit
    // came from the inspector/color popover, focus lives there — stealing the
    // selection would blur it and slam the popover shut mid-drag.
    const owns = root.contains(document.activeElement);
    suppressSelectionEvent.current = true;
    root.innerHTML = buildHtml(clip, effText, overrides, doc, ranges, glyphPaintsFor(clip, ranges, local));
    renderedTextRef.current = effText;
    if (owns) restoreSelection(root, effText, desiredSelection.current);
    // Allow selectionchange to flow again after this tick.
    const t = setTimeout(() => (suppressSelectionEvent.current = false), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `local` reaches this only through `ranges`; a per-tick rebuild would fight the caret
  }, [clip, renderSig, ranges]);

  const publishSelection = React.useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const text = renderedTextRef.current;
    const start = graphemeOffsetAt(root, text, range.startContainer, range.startOffset);
    const end = graphemeOffsetAt(root, text, range.endContainer, range.endOffset);
    const ordered = start <= end ? { start, end } : { start: end, end: start };
    desiredSelection.current = ordered;
    // What the selection MEANS — the layer, the spoken word, a range — is
    // core's `selectionScope`, read by the sidebar; nothing is decided here.
    useSession.getState().setTextSelection(ordered);
  }, []);

  // Focus + select-all on entry (Figma's double-click behavior).
  React.useEffect(() => {
    if (!editingClipId) return;
    const root = rootRef.current;
    if (root) {
      root.focus();
      const len = segmentTextCached(renderedTextRef.current).graphemes.length;
      desiredSelection.current = { start: 0, end: len };
      restoreSelection(root, renderedTextRef.current, desiredSelection.current);
      publishSelection();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingClipId]);

  // THE KEYS FOLLOW THE EDIT, not the last thing clicked. Clicking the canvas
  // beside a text you are editing — to look, to drag the grip of a text on a
  // path, to scrub — moves focus to whatever was pressed, and the next letter
  // typed then fell to the shortcut layer (⌘V went to the layer clipboard and
  // asked the OS for permission; a plain key did nothing at all). While a text
  // is being edited, a keystroke aimed at nothing that types is the editor's:
  // refocusing during `keydown` routes the input that follows into it.
  React.useEffect(() => {
    if (!editingClipId) return;
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(document.activeElement) || isTypingTarget(e.target)) return;
      // Bare modifiers and the app's own escape hatch stay where they are.
      if (e.key === "Escape" || e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift") return;
      root.focus();
      restoreSelection(root, renderedTextRef.current, desiredSelection.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editingClipId]);

  // Track selection while editing.
  React.useEffect(() => {
    if (!editingClipId) return;
    const handler = () => {
      if (suppressSelectionEvent.current) return;
      publishSelection();
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [editingClipId, publishSelection]);

  // Discard an empty text layer on blur (Figma): when we LEAVE editing a text
  // clip that has no typed content (and no keyframed content), remove it. This
  // is the ONE choke point — every exit path (Escape, click-away, tool switch,
  // select-away) clears editingClipId, so watching it here catches them all,
  // whether the empty clip was just drawn with the T tool or emptied by hand.
  const prevEditRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const prev = prevEditRef.current;
    prevEditRef.current = editingClipId;
    if (!prev || prev === editingClipId) return;
    const cur = store.getState();
    const l = locateClip(cur, prev);
    if (
      l &&
      l.clip.kind === "text" &&
      l.clip.text.trim() === "" &&
      !propertyHasKeys(l.clip.keyframes, "text")
    ) {
      store.update("Discard empty text", (d) => {
        deleteClip(d, prev);
        gcOrphanNestedSources(d);
      });
      const sess = useSession.getState();
      if (sess.selectedClipIds.includes(prev)) {
        sess.select(sess.selectedClipIds.filter((id) => id !== prev));
      }
    }
  }, [editingClipId, store]);

  if (!clip || !editingClipId || !pose) return null;

  const frame = doc.frames.find((f) => f.id === clip.frameId) ?? doc.frames[0]!;

  // A layer's POSITION is where its PIVOT sits, not where its box centre is —
  // and this overlay is centred on (left, top) by the translate(-50%,-50%)
  // below. Without the pivot term it therefore parks the box centre on the
  // pivot, so the instant an anchor is moved off centre the editable text lands
  // somewhere the canvas never drew it. `centerOffset` is the SAME seam the
  // renderer's `applyLayerPose` uses (its final translate by -anchorLocal), so
  // the edit box and the painted glyphs can't disagree. Exactly zero for the
  // default centred pivot, which is why this went unnoticed until one moved.
  const hostBox = ride ? clipBox(rdoc, ride.hs.host) : null;
  const poseBasis = {
    scale: pose.scale,
    scaleY: pose.scaleY,
    rotation: pose.rotation,
    skewX: pose.skewX,
    skewY: pose.skewY,
    anchor: pose.anchor,
    size: hostBox ?? { width: boxW ?? layout?.width ?? 0, height: layout?.height ?? 0, cx: 0, cy: 0 },
  };
  // On a path the box is the host's, whose centre can sit off its origin.
  const pivotShift = hostBox ? mapLocal(hostBox.cx, hostBox.cy, poseBasis) : centerOffset(poseBasis);
  // The caret box hangs off the frame's OWN chain, so editing text inside a
  // nested comp puts the box on the glyphs instead of at the source frame's
  // page slot, which nothing is painted at. A bound text hangs off its
  // LAYER's chain — the host's rows — for the same reason.
  const space = ride ? ride.hs.space : (layerSpace(clip.id, rdoc) ?? frameSpace(frame.id));
  const anchorLocal = { x: pose.x + pivotShift.x, y: pose.y + pivotShift.y };
  const anchorWorld = space
    ? space.toWorld(anchorLocal)
    : { x: frame.x + frame.width / 2 + anchorLocal.x, y: frame.y + frame.height / 2 + anchorLocal.y };
  const left = view.tx + anchorWorld.x * view.scale;
  const top = view.ty + anchorWorld.y * view.scale;
  const effScale = view.scale * pose.scale;

  // ── THE TEXT DOES NOT MOVE WHEN YOU START TYPING ──────────────────────────
  // The canvas and the browser lay lines out with different vertical models: we
  // put a baseline `LINE_ASCENT_RATIO x size` below the line top, CSS centres
  // the font's content area and puts it a real ascent below that. Left alone the
  // glyphs drop by a fifth of the font size the instant you double-click in —
  // the "it jumps down" that made editing feel broken. `domBaselineDrift` is the
  // one place that knows the difference; taking it off here means the DOM text
  // lands exactly on the pixels the canvas was painting.
  //
  // `blockOffsetY` is the other half: the browser stacks lines from the top of
  // the box, while a fixed-height box may anchor its block in the middle or at
  // the bottom. Both offsets are in LAYOUT px — inside the scaled wrapper — so
  // they need no view maths of their own.
  const baseStyle = rStyle!; // non-null here: we return above when `clip` is null
  const lineHeightFactor = overrides?.lineHeight ?? baseStyle.lineHeight;
  const firstLineSize = Math.max(
    ...(layout ? layout.glyphs.filter((g) => g.line === 0).map((g) => g.style.fontSize) : []),
    // An empty clip (or one whose first line is blank) still shows a caret, and
    // the caret is as tall as the style says.
    overrides?.fontSize ?? baseStyle.fontSize,
  );
  const textOffsetY =
    (layout?.blockOffsetY ?? 0) -
    domBaselineDrift(getMeasureCtx(), baseStyle, firstLineSize, lineHeightFactor);

  const onInput = () => {
    const root = rootRef.current;
    if (!root) return;
    const splice = commitTextContent(store, editingClipId, extractText(root));
    // Caret lands right after the inserted content.
    if (splice) desiredSelection.current = { start: splice.at + splice.inserted, end: splice.at + splice.inserted };
  };

  /**
   * THE TEXT MENU.
   *
   * The one place in the app where you are genuinely typing had no right-click
   * of its own: the stage's own menu won (it is bound in CAPTURE, so it beats
   * any child), which meant no cut/copy/paste/select-all — and opening it ended
   * the edit, because that is what the stage menu does before it aims at a
   * layer. The overlay now marks itself `data-text-edit` and the stage steps
   * aside for it, the same escape the vector overlay and the rulers already use.
   *
   * The actions run on CLOSE, not on select. A menu item's click has already
   * moved focus off the editable, and `execCommand` needs the caret back — so
   * the choice is remembered, `onCloseAutoFocus` restores focus AND the exact
   * grapheme selection the overlay was already tracking, and only then does the
   * verb run. That is the same two-step the binding menus use to open a popover.
   *
   * Clipboard reads/writes go through the async API rather than
   * `execCommand("copy"|"cut")`, which browsers have been narrowing for years;
   * the text is reconstructed from the same grapheme offsets the selection is
   * stored in, so an emoji or a joined family copies as one character.
   */
  const selection = desiredSelection.current;
  const hasSelection = !!selection && selection.start !== selection.end;
  const inLink = !!clip && !!selection && !!textLinkAt(clip, selection.start);

  const selectedText = (): string => {
    const sel = desiredSelection.current;
    if (!sel || sel.start === sel.end) return "";
    return segmentTextCached(renderedTextRef.current).graphemes.slice(sel.start, sel.end).join("");
  };

  const runMenuAction = (fn: () => void | Promise<void>) => {
    pendingAction.current = fn;
  };

  const selectAll = () => {
    const root = rootRef.current;
    if (!root) return;
    const len = segmentTextCached(renderedTextRef.current).graphemes.length;
    desiredSelection.current = { start: 0, end: len };
    restoreSelection(root, renderedTextRef.current, desiredSelection.current);
    publishSelection();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // keep global shortcuts out of typing
    if (e.key === "Escape") {
      e.preventDefault();
      useSession.getState().endTextEdit();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      document.execCommand("insertText", false, "\n");
      return;
    }
    // ⌘K — every document editor's "link" — or the app's own binding. Typing
    // keeps global shortcuts out, so the editor answers both itself.
    const combo = comboFromEvent(e.nativeEvent);
    if (combo === "mod+k" || combo === comboFor("edit.link")) {
      e.preventDefault();
      publishSelection();
      openLinkEditor(store.getState());
    }
  };

  // ── THE PILL IS DRAWN, NOT RE-DESCRIBED ───────────────────────────────────
  // The highlight used to be an inline `background` with padding computed from
  // the FONT's ascent and descent, which is a second engine's answer to a
  // question the layout already answers — so the pill changed shape the moment
  // you double-clicked in. These are the canvas's own rects, laid over the
  // editable in the same coordinates (box centre at 0,0 → the box's top-left
  // corner is the wrapper's origin). No layout impact, so the glyphs cannot be
  // pushed around by padding either.
  const domW = hostBox ? hostBox.width : (boxW ?? Math.max(1, layout?.width ?? 0));
  const domH = hostBox ? hostBox.height : (layout?.height ?? 0);
  const pills = layout && !ride ? highlightPills(layout) : [];

  const editable = (
    <div
      data-text-edit
      className="absolute z-10"
      style={{
        left,
        top,
        // Scale lives on the wrapper (not the child) so its hit box is the
        // VISIBLE text, not the unscaled layout box. At low zoom that box would
        // otherwise be a big invisible halo that eats "click-away-to-exit".
        transform: `translate(-50%, -50%) rotate(${pose.rotation}deg) scale(${effScale})`,
        transformOrigin: "center center",
        // A bound text's editor is invisible and must not sit between the
        // pointer and the stage: the grip, the outline and click-away all
        // belong to the canvas. Keys still arrive — focus does not need hits.
        ...(ride ? { pointerEvents: "none" as const, opacity: 0 } : null),
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {pills.length > 0 && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            // NO effect stack here, deliberately. On canvas a shadow or a glow
            // is computed over the MERGED silhouette — pill and glyphs as one
            // shape — so handing this bare rectangle its own copy of the filter
            // draws a halo around a box that the canvas never draws. Giving it
            // the effect looked more correct and measured less: the pill grew a
            // soft edge the moment you double-clicked into it.
          }}
        >
          {pills.map((p, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: p.x + domW / 2,
                top: p.y + domH / 2,
                width: p.width,
                height: p.height,
                background: resolveColor(doc, p.highlight.color),
                borderRadius: p.highlight.radius,
              }}
            />
          ))}
        </div>
      )}
      {/* No outline of its own: the stage keeps drawing this layer's selection
          box while you type (same rect, same weight, minus the grab-dots), so
          there is exactly ONE box and entering edit mode cannot re-frame it. */}
      <div
        ref={rootRef}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        dir={clip.style.direction === "auto" ? "auto" : clip.style.direction}
        // The selection is drawn OVER whatever the look already paints — a black
        // headline, a yellow pill, a neon glow — so it cannot be left to the
        // browser's default `Highlight`, which is opaque, platform-dependent,
        // and disappeared entirely on some of these looks. A translucent accent
        // reads on every one of them and keeps the glyph's own colour visible
        // underneath, which is the point: you are selecting text, not replacing it.
        className="cursor-text outline-none selection:bg-primary/40 selection:text-inherit"
        style={{
          // Positioned so it paints ABOVE the absolutely-positioned pills
          // behind it — an in-flow box would be painted under every one of them.
          position: "relative",
          transform: textOffsetY ? `translateY(${textOffsetY}px)` : undefined,
          // Auto-width never wraps (grows on one line, like the canvas); a
          // fixed/wrap box wraps at its width.
          whiteSpace: boxW ? "pre-wrap" : "pre",
          // Match the canvas line-breaker exactly: wrap only at word boundaries,
          // never mid-word. A word longer than the box overflows (and a fixed box
          // clips it on render) instead of breaking — so edit and display agree.
          overflowWrap: "normal",
          wordBreak: "normal",
          textAlign: clip.style.align,
          // Vertical writing: the browser's own column layout is close enough
          // to the canvas engine's for the caret to land on its letter.
          ...(clip.style.orientation === "vertical"
            ? { writingMode: "vertical-rl" as const, textOrientation: "upright" as const }
            : null),
          // Box dimensions come from the SHARED layout so the editing box equals
          // the rendered box exactly — a fixed box uses maxWidth, auto-width uses
          // the measured content width. Height always follows the layout (the
          // content block, or the fixed box height); content overflows visibly
          // as you type (the canvas render clips a fixed box to it).
          width: ride ? `${domW}px` : boxW ? `${boxW}px` : `${Math.max(1, layout?.width ?? 0)}px`,
          minWidth: "1ch",
          height: ride ? `${domH}px` : layout ? `${layout.height}px` : undefined,
          lineHeight: overrides?.lineHeight ?? clip.style.lineHeight,
          caretColor: "var(--primary)",
        }}
        onInput={onInput}
        onKeyDown={onKeyDown}
        // Paste is PLAIN, always: a text layer holds characters and its
        // styling is the clip's, so pasted markup would only inject spans the
        // rebuild throws away. Reading `clipboardData` needs no permission,
        // which is the whole reason this is not `navigator.clipboard`.
        // One exception, every document editor's: a URL pasted over selected
        // letters LINKS them and leaves the words alone.
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          if (!text) return;
          const sel = desiredSelection.current;
          const target = clip && sel && sel.end > sel.start ? pastedLinkTarget(text, linkParseContext()) : null;
          if (clip && sel && target) {
            const open = textLinkAt(clip, sel.start)?.link.open ?? "auto";
            setScopeLink(store, { kind: "range", clipId: clip.id, start: sel.start, end: sel.end }, { target, open });
            return;
          }
          document.execCommand("insertText", false, text);
        }}
      />
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{editable}</ContextMenuTrigger>
      <ContextMenuContent
        className="w-48"
        onCloseAutoFocus={(event) => {
          const run = pendingAction.current;
          pendingAction.current = null;
          if (!run) return;
          // Keep Radix from returning focus to the trigger WRAPPER — the caret
          // has to land back in the editable itself, on the same range.
          event.preventDefault();
          const root = rootRef.current;
          if (!root) return;
          root.focus();
          restoreSelection(root, renderedTextRef.current, desiredSelection.current);
          void run();
        }}
      >
        <ContextMenuItem disabled={!hasSelection} onSelect={() => runMenuAction(async () => {
          const text = selectedText();
          if (!text) return;
          await navigator.clipboard.writeText(text);
          document.execCommand("delete");
        })}>
          <Scissors /> Cut
          <ContextMenuShortcut>⌘X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onSelect={() => runMenuAction(async () => {
          const text = selectedText();
          if (text) await navigator.clipboard.writeText(text);
        })}>
          <Copy /> Copy
          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => runMenuAction(async () => {
          const text = clipboardPlainText(await navigator.clipboard.readText().catch(() => ""));
          // Always plain: a text layer holds characters, and its styling is the
          // clip's, so there is no rich flavour to offer a second item for.
          if (text) document.execCommand("insertText", false, text);
        })}>
          <ClipboardPaste /> Paste
          <ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => runMenuAction(() => void openLinkEditor(store.getState()))}>
          <Link2 /> {inLink ? "Edit link…" : "Add link…"}
          <ContextMenuShortcut>⌘K</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => runMenuAction(selectAll)}>
          <TextSelect /> Select all
          <ContextMenuShortcut>⌘A</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() => runMenuAction(() => void document.execCommand("delete"))}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/**
 * A shared offscreen 2D context used only to MEASURE the editable box with the
 * exact layout engine the canvas draws with — so the inline editor's box is the
 * same size as the rendered/selected box (Figma parity: focused === unfocused).
 */
let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d")!;
  }
  return measureCtx;
}

function styleToCss(s: ResolvedTextStyle, resolve: (c: string) => string, paints: PaintSet): string {
  // The DOM can only show a solid colour, so it shows the colour the canvas
  // would paint: the first solid fill when the glyph has fills, else `color`
  // — which is also the fallback the renderer's fill pass uses.
  let color = s.color;
  for (const f of paints.fills) {
    if (f.enabled && f.type === "solid") {
      color = f.color;
      break;
    }
  }
  const caseCss =
    s.textCase === "upper"
      ? "text-transform:uppercase"
      : s.textCase === "lower"
        ? "text-transform:lowercase"
        : s.textCase === "title"
          ? "text-transform:capitalize"
          : "";
  const parts = [
    `font-family:"${s.fontFamily}",sans-serif`,
    `font-size:${s.fontSize}px`,
    `font-weight:${Math.round(s.fontWeight)}`,
    `color:${resolve(color)}`,
    // Faux bold, the way the canvas draws it: the glyph's own paint stroked
    // around its edge, behind the fill, at the renderer's outset.
    s.fauxBold > 0 ? `-webkit-text-stroke:${fauxBoldOutset(s) * 2}px ${resolve(color)};paint-order:stroke fill` : "",
    `letter-spacing:${s.letterSpacing}px`,
    s.italic ? "font-style:italic" : "",
    s.decoration === "underline"
      ? "text-decoration:underline"
      : s.decoration === "strikethrough"
        ? "text-decoration:line-through"
        : "",
    caseCss,
    `opacity:${s.opacity}`,
  ];
  return parts.filter(Boolean).join(";");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the effective text as styled spans, split at every style boundary
 * (static ranges, the caption cue in focus, AND range-scoped keyframe slices).
 * Each span's style is the exact per-glyph resolution the canvas uses
 * (glyphStyleAt) over the exact same ranges the canvas lays out with, so a
 * keyframed colour, a focused caption word and keyframed content all stay
 * visible — and stay put — while you type into them.
 */
function buildHtml(
  clip: TextClip,
  text: string,
  overrides: LayoutOverrides | undefined,
  doc: MotionDocument,
  ranges: StyleRange[],
  paints: GlyphPaints,
): string {
  const seg = segmentTextCached(text);
  const len = seg.graphemes.length;
  if (len === 0) return "";
  const resolve = (c: string) => resolveColor(doc, c);
  const baseStyle = resolveTextStyle(doc, clip.style);

  const boundaries = new Set<number>([0, len]);
  for (const r of ranges) {
    boundaries.add(Math.min(r.start, len));
    boundaries.add(Math.min(r.end, len));
  }
  for (const rs of overrides?.rangeStyles ?? []) {
    boundaries.add(Math.min(rs.start, len));
    boundaries.add(Math.min(rs.end, len));
  }
  const sorted = [...boundaries].sort((a, b) => a - b);

  const fxCss = layerEffectCssText(clip.effects, resolve);

  let html = "";
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    if (to <= from) continue;
    const style = glyphStyleAt(baseStyle, ranges, from, overrides);
    const startStr = seg.graphemes[from]!.stringIndex;
    const endStr = to < len ? seg.graphemes[to]!.stringIndex : text.length;
    const slice = text.slice(startStr, endStr);
    const segCss = styleToCss(style, resolve, paints.at(from));
    const css = fxCss ? `${segCss};${fxCss}` : segCss;
    html += `<span data-seg style='${css}'>${escapeHtml(slice)}</span>`;
  }
  return html;
}

/** Plain text from the contentEditable (spans + text nodes; <br> and divs → \n). */
function extractText(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeName === "BR") {
      out += "\n";
      return;
    }
    const isBlock = node.nodeName === "DIV" || node.nodeName === "P";
    if (isBlock && out.length > 0 && !out.endsWith("\n")) out += "\n";
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out;
}

/** Map a DOM (node, offset) inside the overlay to a grapheme offset. */
function graphemeOffsetAt(root: HTMLElement, text: string, node: Node, offset: number): number {
  let stringOffset = 0;
  let found = false;

  const walk = (n: Node): boolean => {
    if (found) return true;
    if (n === node) {
      if (n.nodeType === Node.TEXT_NODE) {
        stringOffset += offset;
      } else {
        // Element node: offset counts child nodes — sum lengths of preceding children.
        for (let i = 0; i < offset && i < n.childNodes.length; i++) {
          stringOffset += (n.childNodes[i]!.textContent ?? "").length;
        }
      }
      found = true;
      return true;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      stringOffset += (n.textContent ?? "").length;
      return false;
    }
    if (n.nodeName === "BR") {
      stringOffset += 1;
      return false;
    }
    for (const child of Array.from(n.childNodes)) {
      if (walk(child)) return true;
    }
    return false;
  };
  walk(root);

  // Convert string offset → grapheme index.
  const seg = segmentTextCached(text);
  for (let i = 0; i < seg.graphemes.length; i++) {
    if (seg.graphemes[i]!.stringIndex >= stringOffset) return i;
  }
  return seg.graphemes.length;
}

/** Place the DOM selection at the given grapheme offsets. */
function restoreSelection(
  root: HTMLElement,
  text: string,
  target: { start: number; end: number } | null,
) {
  if (!target) return;
  const seg = segmentTextCached(text);
  const toStringIndex = (g: number) =>
    g >= seg.graphemes.length ? text.length : seg.graphemes[g]!.stringIndex;

  const startStr = toStringIndex(target.start);
  const endStr = toStringIndex(target.end);

  const locate = (strOffset: number): { node: Node; offset: number } => {
    let acc = 0;
    let result: { node: Node; offset: number } | null = null;
    const walk = (n: Node): boolean => {
      if (n.nodeType === Node.TEXT_NODE) {
        const len = (n.textContent ?? "").length;
        if (acc + len >= strOffset) {
          result = { node: n, offset: strOffset - acc };
          return true;
        }
        acc += len;
        return false;
      }
      for (const child of Array.from(n.childNodes)) {
        if (walk(child)) return true;
      }
      return false;
    };
    walk(root);
    return result ?? { node: root, offset: root.childNodes.length };
  };

  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const s = locate(startStr);
  const e = locate(endStr);
  try {
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    // Selection restore is best-effort; a failed restore just drops the caret.
  }
}
