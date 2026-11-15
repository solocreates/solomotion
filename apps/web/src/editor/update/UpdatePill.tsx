"use client";

import { useUpdate } from "./update-store";

/**
 * Ambient update affordance in the top bar, next to the project name. Present
 * only when there's genuinely something to update — otherwise it renders nothing
 * and takes no space. Quiet by design: a soft primary pill with a live dot, not
 * a nag. Clicking opens the full {@link UpdateDialog}.
 */
export function UpdatePill() {
  const hasUpdate = useUpdate((s) => s.hasUpdate());
  const setDialogOpen = useUpdate((s) => s.setDialogOpen);
  const latest = useUpdate((s) => s.latest);
  if (!hasUpdate) return null;

  return (
    <button
      type="button"
      onClick={() => setDialogOpen(true)}
      title={`Update to v${latest}`}
      className="ml-1 inline-flex items-center gap-1.5 rounded-(--r-sm) border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
      </span>
      <span className="max-md:hidden">Update</span>
    </button>
  );
}
