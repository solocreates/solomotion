"use client";

import { FileGrid } from "../filer/FileGrid";
import type { ProjectRecord } from "../state/project-store";
import { FirstRun, timeAgo, type HomeKit } from "./home-kit";

/** The projects themselves, on the headless filer: the same grid in every Home layout. */
export function ProjectGrid({ kit }: { kit: HomeKit }) {
  if (kit.loading) return <p className="py-16 text-center text-body text-fg-faint">Loading…</p>;
  return (
    <FileGrid<ProjectRecord>
      fm={kit.fm}
      layout={kit.layout}
      renderThumb={kit.renderThumb}
      itemThumbUrl={(item) => item.data.thumbnail}
      itemMeta={(item) => `Edited ${timeAgo(item.data.updatedAt)}`}
      onNewFolder={kit.newFolder}
      onMoveToNewFolder={kit.moveToNewFolder}
      onRequestDelete={kit.requestDelete}
      empty={kit.isEmpty && kit.examples ? <FirstRun /> : undefined}
    />
  );
}
