"use client";

import {
  planIsNeutral,
  soundDropPlan,
  type DocumentStore,
  type EarGuard,
  type LibraryItem,
  type SoundDropDefaults,
} from "@solomotion/core";
import { placeAssetClips } from "../../assets/import";
import { placeAboveSelection } from "../../state/clip-actions";
import { ensureLibraryAsset } from "../../library/downloads";
import { useSession } from "../../state/session";
import { activeCompId } from "../../timeline/timeline-utils";

/**
 * PLACE A LIBRARY SOUND, with the browser's defaults applied.
 *
 * The acquisition half is not re-implemented here: `ensureLibraryAsset` already
 * turns an online item into a document asset with the bytes streaming in
 * behind it, and `placeAssetClips` already knows how to put an asset on a lane.
 * What this adds is the layer those two cannot know about — the defaults the
 * panel is carrying — and it applies them through `soundDropPlan`, the same
 * pure function the drop-plan tests cover.
 *
 * Deliberately NOT wired into the generic drag-and-drop path. Dropping a sound
 * on a lane goes through the same handler every other media drag does, and
 * placing it lands the file at the drop point with no defaults applied. Making
 * the two agree means teaching `placeAssetClips` about a panel preference,
 * which would also apply it to a music track dragged out of the media library
 * — a surprise nobody asked for. Stated here rather than half-solved.
 */
export function placeLibrarySound(
  store: DocumentStore,
  item: LibraryItem,
  defaults: SoundDropDefaults,
  guard: EarGuard,
): void {
  const assetId = ensureLibraryAsset(store, item);
  if (!assetId) return;

  const session = useSession.getState();
  const doc = store.getState();
  const frameId = activeCompId(doc, session.activeFrameId);
  const frame = doc.frames.find((f) => f.id === frameId);
  const asset = doc.assets.find((a) => a.id === assetId);
  if (!frame || !asset) return;

  const peaks = item.preview.type === "peaks" ? item.preview : null;
  const plan = soundDropPlan(
    {
      durationMs: peaks?.durationMs ?? asset.durationMs ?? 0,
      hitMs: peaks?.hitMs ?? 0,
      loudnessDb: peaks?.loudnessDb ?? null,
    },
    session.playheadMs,
    defaults,
    guard,
  );

  void placeAssetClips(
    store,
    asset,
    { frameId: frame.id, startMs: plan.startMs },
    { width: frame.width, height: frame.height },
    // The resolver is handed the clip that is ABOUT to be inserted, so the
    // defaults ride in on the same update that creates it. Undo is then one
    // step called "Add audio" rather than a placement followed by a mystery
    // edit the user never asked for.
    (d, primary) => {
      if (primary.kind === "audio") {
        primary.soundBus = "sfx";
        if (!planIsNeutral(plan)) {
          primary.gain = plan.gain;
          primary.fadeIn = plan.fadeIn;
          primary.fadeOut = plan.fadeOut;
          primary.pitchSemitones = plan.pitchSemitones;
        }
      }
      return placeAboveSelection(d, primary);
    },
  );
}
