/**
 * Overlay colours for trackers, assigned in creation order so several on one
 * plate are told apart at a glance. Saturated enough to read over footage,
 * none of them the accent (an armed control) or red (an error).
 */
export const TRACKER_COLORS = ["#4ade80", "#38bdf8", "#facc15", "#c084fc", "#fb923c", "#2dd4bf", "#f472b6", "#a3e635"] as const;

/** The colour the next tracker on a document gets. */
export function nextTrackerColor(existing: number): string {
  return TRACKER_COLORS[existing % TRACKER_COLORS.length]!;
}
