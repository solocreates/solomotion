"use client";

import * as React from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
} from "lucide-react";
import type { AlignMode, DistributeMode } from "@solomotion/core";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { alignSelection, distributeSelection } from "../state/align-actions";
import { IconTrack, PanelSection } from "./controls";

/**
 * Figma's align/distribute row, in the sidebar above Combine. A group counts as
 * one unit (see align-actions), so one click centralizes a lone layer, a group,
 * or a whole multi-selection. Distribute needs 3+ units.
 */
type AlignAction = AlignMode | DistributeMode;

const ALIGN_ACTIONS: ReadonlyArray<{ id: AlignAction; label: string; icon: React.ReactNode }> = [
  { id: "left", label: "Align left", icon: <AlignStartVertical /> },
  { id: "hcenter", label: "Align horizontal centers", icon: <AlignCenterVertical /> },
  { id: "right", label: "Align right", icon: <AlignEndVertical /> },
  { id: "top", label: "Align top", icon: <AlignStartHorizontal /> },
  { id: "vcenter", label: "Align vertical centers", icon: <AlignCenterHorizontal /> },
  { id: "bottom", label: "Align bottom", icon: <AlignEndHorizontal /> },
  { id: "dist-h", label: "Distribute horizontally", icon: <AlignHorizontalDistributeCenter /> },
  { id: "dist-v", label: "Distribute vertically", icon: <AlignVerticalDistributeCenter /> },
];

const DISTRIBUTE_IDS = new Set<AlignAction>(["dist-h", "dist-v"]);

export function AlignSection() {
  const store = useDocStore();
  return (
    <PanelSection title="Align" collapsible={false}>
      <IconTrack
        items={ALIGN_ACTIONS}
        dividerAfter={["bottom"]}
        onPick={(id) =>
          DISTRIBUTE_IDS.has(id)
            ? distributeSelection(store, id as DistributeMode)
            : alignSelection(store, id as AlignMode)
        }
      />
    </PanelSection>
  );
}
