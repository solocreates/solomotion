import type { LibraryItem } from "./item";

/**
 * Fold the online catalogue into the local one — by UPGRADING a card, never by
 * replacing it.
 *
 * An item you have downloaded exists twice: once as a card in the catalogue,
 * once as the thing on your disk. Showing both is the obvious bug — two rows,
 * same name. But dropping the ONLINE row and keeping the local one is the
 * subtler version of it: the card you just clicked disappears out from under
 * you and an identical-looking one appears somewhere else in the list, which
 * reads exactly like the download failing.
 *
 * So the online card survives, keeps its id and its blurb and its publisher,
 * and gains the local copy's ACTION. Same card, now usable. That is what makes
 * a download feel like the thing you were looking at changing state rather than
 * being swapped for a stranger.
 *
 * A local item whose origin is not in the catalogue (offline, or a pack that
 * was unpublished) still shows on its own — you keep what you downloaded.
 */
export function mergeLibrary(local: LibraryItem[], online: LibraryItem[]): LibraryItem[] {
  const byOrigin = new Map<string, LibraryItem>();
  for (const item of local) if (item.originId) byOrigin.set(item.originId, item);

  const upgraded = online.map((o) => {
    const mine = byOrigin.get(o.id);
    if (!mine) return o;
    byOrigin.delete(o.id);
    return { ...o, source: "downloaded" as const, action: mine.action, originId: o.id };
  });

  // Local items that matched an online card were folded above; the rest stand.
  const rest = local.filter((i) => !i.originId || byOrigin.has(i.originId));
  return [...rest, ...upgraded];
}

/** Is this online item already on the machine? */
export function isOwned(local: LibraryItem[], onlineId: string): boolean {
  return local.some((i) => i.originId === onlineId);
}
