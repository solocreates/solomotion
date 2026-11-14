"use client";

import * as React from "react";
import { locateClip, type FaceStyle, type TextClip } from "@solomotion/core";
import { ExplorerFontBrowser, type FontTarget } from "../../fonts/FontBrowser";
import { fontPickPatch } from "../../fonts/library";
import { useScopeStyle, useScopeTarget } from "../../inspector/scope";
import { SelectionScope } from "../../inspector/selection-scope";
import { useAppShell } from "../../state/app-shell";
import { addClipAtPlayhead } from "../../state/clip-actions";
import { useDoc, useDocStore } from "../../state/document-context";
import { noteFontChosen } from "../../state/font-prefs";
import { useSession } from "../../state/session";
import { usePluginWindows } from "../plugin-windows";

/**
 * FONTS — the font browser with room: every family, big specimens, filters by
 * feeling, style and language, stars, collections, your own uploads.
 *
 * It applies to what the rest of the app is pointed at. Select a text layer
 * (or several), a run of letters inside one, or a caption's focus words, and
 * a card's Use writes there — through the SAME scope seam the inspector's
 * Typography fields write through (`useScopeTarget`), so a font set here lands
 * exactly where one set in the sidebar would, in one undo step, on every
 * selected layer. With nothing selected, a card starts a new text layer set
 * in that face, with the line you typed.
 *
 * The browser stays mounted while the selection changes; only its target is
 * swapped (`TargetBridge`), so your scroll position, search and filters
 * survive clicking around the canvas.
 */
export default function FontsPlugin() {
  const doc = useDoc();
  const store = useDocStore();
  const selected = useSession((s) => s.selectedClipIds);
  const intent = usePluginWindows((s) => s.intents.fonts);

  const clips = React.useMemo(
    () =>
      selected
        .map((id) => locateClip(doc, id)?.clip)
        .filter((c): c is TextClip => !!c && c.kind === "text"),
    [doc, selected],
  );
  const primary = clips[clips.length - 1];
  const [target, setTarget] = React.useState<FontTarget | null>(null);

  const addText = React.useCallback(
    (family: string, text: string, face?: FaceStyle) => {
      noteFontChosen(useAppShell.getState().currentProjectId, family);
      const patch = fontPickPatch(family, {}, face);
      addClipAtPlayhead(store, "text", { text: text || family, style: patch });
    },
    [store],
  );

  return (
    <>
      {primary && (
        <SelectionScope clips={clips}>
          <TargetBridge key={primary.id} clip={primary} count={clips.length} onTarget={setTarget} />
        </SelectionScope>
      )}
      <ExplorerFontBrowser target={primary ? target : null} initialQuery={intent?.params?.q} onAddText={addText} />
    </>
  );
}

/**
 * Reads the selection's scope and hands the browser a TARGET — renders nothing.
 * The target is rebuilt only when what it SHOWS changes (label, family,
 * weight, slant); its actions read the live scope through a ref, so a doc edit
 * elsewhere never re-renders a thousand cards.
 */
function TargetBridge({
  clip,
  count,
  onTarget,
}: {
  clip: TextClip;
  count: number;
  onTarget: (t: FontTarget | null) => void;
}) {
  const scope = useScopeTarget(clip);
  const style = useScopeStyle(scope);
  const live = React.useRef(scope);
  live.current = scope;

  const family = typeof style.fontFamily === "string" ? style.fontFamily : undefined;
  const weight = typeof style.fontWeight === "number" ? style.fontWeight : undefined;
  const italic = style.italic;
  const a = scope.address;
  const label =
    a.kind === "range"
      ? `“${truncate(clip.text.slice(a.start, a.end), 18)}”`
      : a.kind === "caption"
        ? "the caption’s focus words"
        : count > 1
          ? `${count} text layers`
          : clip.name || "this text";

  const target = React.useMemo<FontTarget>(
    () => ({
      label,
      family,
      weight,
      italic,
      pick: (fam, face) => {
        live.current.writeStyle(fontPickPatch(fam, { weight, italic }, face), "Change font");
        noteFontChosen(useAppShell.getState().currentProjectId, fam);
      },
    }),
    [label, family, weight, italic],
  );

  React.useEffect(() => {
    onTarget(target);
  }, [target, onTarget]);
  React.useEffect(() => () => onTarget(null), [onTarget]);
  return null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
