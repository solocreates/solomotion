"use client";

import * as React from "react";
import { ArrowUpRight } from "lucide-react";
import { setClipsSoundBus, type Clip, type SoundBus } from "@solomotion/core";
import { useDoc, useDocStore } from "../../state/document-context";
import { useSession } from "../../state/session";
import { IconAction, PanelSection, PropRow } from "../controls";
import { mergeReads } from "../merge";
import { anyClip, usePeers } from "../selection-scope";
import { useClipUpdater } from "../use-clip-updater";
import { CategoryPicker } from "./CategoryPicker";
import { DuckingEditor } from "./DuckingEditor";
import { useBusMembers } from "./use-mix";

/**
 * MIX — where this layer's sound goes and what it gives way to. Every
 * sound-bearing kind gets it (a text layer's keystrokes, a video's dialogue, a
 * whole nested scene), which is why it lives on the Sound tab's spine and not
 * in the audio clip's own panel.
 *
 * The arrow opens the CATEGORY itself — its fader, its chain, its ducking and
 * everyone else in it — so going from one layer to the whole family is one
 * click, and back is one more.
 */
export function SoundMixSection({ clip }: { clip: Clip }) {
  const doc = useDoc();
  const store = useDocStore();
  const peers = usePeers(clip, anyClip);
  const members = useBusMembers();
  const update = useClipUpdater(clip.id);
  const tag = mergeReads(peers, (c) => c.soundBus ?? null);

  // What "Auto" means for this layer: the category its sound lands in untagged.
  const inherited: SoundBus | null = React.useMemo(() => {
    for (const [busId, ids] of members) {
      if (busId && ids.includes(clip.id)) return doc.soundBuses.find((b) => b.id === busId) ?? null;
    }
    return null;
  }, [members, clip.id, doc.soundBuses]);
  const effective = (tag.mixed ? null : tag.value) ?? inherited?.id ?? null;

  const route = (busId: string | null) =>
    store.update(busId ? "Route to category" : "Route automatically", (d) => setClipsSoundBus(d, peers.map((p) => p.id), busId));

  return (
    <PanelSection
      id="sound-mix"
      title="Mix"
      hint="Which category this layer's sound joins, and what it ducks under."
      summary={inherited || tag.value ? (doc.soundBuses.find((b) => b.id === effective)?.name ?? undefined) : undefined}
    >
      <PropRow
        label="Category"
        keyControl={
          effective ? (
            <IconAction label="Category settings" onClick={() => useSession.getState().inspectSoundBus(effective)}>
              <ArrowUpRight />
            </IconAction>
          ) : undefined
        }
      >
        <CategoryPicker
          value={tag.mixed ? null : tag.value}
          mixed={tag.mixed}
          inherited={inherited}
          onChange={route}
          onCreated={(id) => useSession.getState().inspectSoundBus(id)}
        />
      </PropRow>
      {peers.length === 1 && (
        <PropRow label="Ducking">
          <DuckingEditor
            rules={clip.ducking ?? []}
            owner={{ kind: "clip", id: clip.id }}
            onChange={(label, next, mergeKey) => update(label, (c) => void (c.ducking = next), mergeKey)}
          />
        </PropRow>
      )}
    </PanelSection>
  );
}
