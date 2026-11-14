"use client";

import * as React from "react";
import {
  isPartGroup,
  locateClip,
  partsOf,
  pathClipRegions,
  promotePathClip,
  type Promotion,
} from "@solomotion/core";
import { Link2, Scissors, Smile, Spline } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LayerCallout } from "./LayerCallout";
import { CHROME_CAPSULE } from "./StageChrome";
import { isSvgImageClip, openSvgClipAsVectors } from "../assets/import";
import { separateParts, separablePartCount } from "../drawing/part-actions";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { characterOffer } from "../character/offer";
import { openLinkEditor } from "../links/LinkEditor";

/**
 * What you can do to the layer you have selected, offered ON the layer.
 *
 * This is the registry of per-layer contextual actions — one place that asks
 * "given this selection, what should float beside it?". Positioning is not its
 * problem (`LayerCallout` owns that), so an action is a condition and a button.
 *
 * The bar is silent by default and that is the point. It appears only when the
 * selection can do something it cannot otherwise be asked to do — an SVG whose
 * paths have never been opened, artwork that is secretly several pieces. An
 * always-on toolbar floating over the canvas would be furniture; one that shows
 * up exactly when there is something to say is an answer.
 */
export function SelectionCallout({
  insets,
}: {
  /** Edges eaten by the rulers, so the callout never lands under the ticks. */
  insets?: { top?: number; left?: number };
}) {
  const doc = useDoc();
  const store = useDocStore();
  const selected = useSession((s) => s.selectedClipIds);
  const tool = useSession((s) => s.tool);
  const playing = useSession((s) => s.playing);
  const editingId = useSession((s) => s.editingClipId);
  const lettersSelected = useSession((s) => !!s.textSelection && s.textSelection.end > s.textSelection.start);

  const clip = selected.length === 1 ? (locateClip(doc, selected[0]!)?.clip ?? null) : null;

  // A drawing tool is armed, or the transport is running: the canvas is busy
  // being used, and a bar over the artwork is in the way of both.
  const quiet = playing || (tool !== "select" && tool !== "hand");

  const offerVectors = clip?.kind === "image" && isSvgImageClip(doc, clip) ? clip : null;
  // Artwork that is several pieces wearing one layer. The knife and the
  // importer already promote on their own (`promotePathClip`); this is the same
  // op offered for art that arrived that way before there was anything to
  // notice it.
  const offerSeparate = clip?.kind === "path" && pathClipRegions(clip) !== null ? clip : null;
  // The same offer for PAINT. Same word, same icon, same place — separating
  // artwork means one thing in this app, and whether the pieces turn out to be
  // outlines or surfaces is not the person's problem.
  //
  // It appears only when there is genuinely something to split
  // (`separablePartCount`, cached on the layer's paint revision). A button that
  // shows up on everything and then says "nothing to separate" is worse than no
  // button: it teaches people not to trust the toolbar.
  const offerParts = clip && separablePartCount(doc, clip.id) > 1 ? clip : null;
  // A group (or instance) whose layers read as a face: one click and it lives.
  const offerCharacter = React.useMemo(() => (clip && !quiet ? characterOffer(doc, clip.id) : null), [doc, clip, quiet]);

  // Letters selected while typing: the link a document editor offers right
  // there (⌘K and pasting a URL over them do the same).
  if (!playing && editingId && lettersSelected) {
    return (
      <LayerCallout clipIds={[editingId]} insets={insets}>
        <div className={CHROME_CAPSULE}>
          <Action icon={<Link2 />} label="Link" hint="⌘K, or paste a URL over the words" keepFocus onClick={() => void openLinkEditor(store.getState())} />
        </div>
      </LayerCallout>
    );
  }

  if (quiet || (!offerVectors && !offerSeparate && !offerParts && !offerCharacter)) return null;

  return (
    <LayerCallout clipIds={selected} insets={insets}>
      <div className={CHROME_CAPSULE}>
        {offerCharacter && clip && (
          <Action icon={<Smile />} label="Make character" hint={offerCharacter.found} onClick={() => void import("../character/make-character").then((m) => m.makeCharacter(store, clip.id))} />
        )}
        {offerVectors && (
          <Action
            icon={<Spline />}
            label="Edit as vector"
            hint="Open this SVG's paths for editing — it stays vector either way."
            onClick={() => void openSvgClipAsVectors(store, offerVectors.id)}
          />
        )}
        {offerSeparate && (
          <Action
            icon={<Scissors />}
            label="Separate"
            hint="This is several shapes in one layer — split it into a vector group so each piece can be coloured and animated on its own."
            onClick={() => {
              const id = offerSeparate.id;
              const out: Promotion[] = [];
              store.update("Separate artwork", (d) => {
                const r = promotePathClip(d, id);
                if (r) out.push(r);
              });
              const done = out[0];
              if (!done) return;
              const session = useSession.getState();
              // Land on the GROUP, not on its pieces: the parent timeline still
              // has one layer and that is what you just made. Expanded, so the
              // pieces are visible in the Layers panel without navigating.
              if (done.nestedId) {
                session.select([done.nestedId]);
                session.setNestedExpanded(done.nestedId, true);
              } else {
                session.select(done.pieceIds);
              }
            }}
          />
        )}
        {offerParts && (
          <Action
            icon={<Scissors />}
            label="Separate"
            hint="Split this drawing into a part per piece of ink, each on its own row — so every piece can be moved, timed and animated on its own."
            onClick={() => {
              separateParts(store, offerParts.id);
              const made = useSession.getState().selectedClipIds[0];
              if (made) useSession.getState().setNestedExpanded(made, true);
            }}
          />
        )}
      </div>
    </LayerCallout>
  );
}

function Action({
  icon,
  label,
  hint,
  onClick,
  keepFocus,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  /** Leave focus (and the caret) where it is — a press on a toolbar beside a text being typed in. */
  keepFocus?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
          onClick={onClick}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent [&_svg]:size-3.5 [&_svg]:text-primary"
        >
          {icon}
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{hint}</TooltipContent>
    </Tooltip>
  );
}
