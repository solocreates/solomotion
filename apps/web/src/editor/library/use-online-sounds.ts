"use client";

import * as React from "react";
import { mergeLibrary, type LibraryItem } from "@solomotion/core";
import { libraryClient } from "./client";

/**
 * The sound picker's ONLINE section.
 *
 * This is §B.10 of the library plan and the reason `soundCatalog` never needed
 * a fifth group: an online sound is not a kind of catalogue entry, it is a
 * SEARCH RESULT — it exists in the picker only while you are looking for it,
 * and the moment you pick one it becomes an ordinary device sound in the group
 * that already existed. So the picker asks for results, not for a list.
 *
 * Nothing is fetched until you have typed two characters. A picker that hit the
 * network on open would make choosing a built-in pack — the overwhelmingly
 * common case — wait on a server it does not need.
 */
export function useOnlineSounds(query: string, ownedIds: string[]): {
  items: LibraryItem[];
  loading: boolean;
} {
  const [items, setItems] = React.useState<LibraryItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const text = query.trim();
  const ownedKey = ownedIds.join("|");

  React.useEffect(() => {
    const client = libraryClient();
    if (!client || text.length < 2) {
      setItems([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void client
        .search({ text, kinds: ["sound"] })
        .then((results) => {
          if (!alive) return;
          // Anything already on this device is shown by the local groups; a
          // second row for the same sound is the bug this fold prevents.
          const owned = ownedKey ? ownedKey.split("|") : [];
          const localStub = owned.map(
            (originId) => ({ originId }) as unknown as LibraryItem,
          );
          setItems(mergeLibrary(localStub, results).filter((i) => i.source === "online"));
          setLoading(false);
        })
        .catch(() => {
          if (alive) {
            setItems([]);
            setLoading(false);
          }
        });
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [text, ownedKey]);

  return { items, loading };
}
