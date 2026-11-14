"use client";

import * as React from "react";
import {
  builtinPresetSource,
  collectPresets,
  makePreset,
  removePreset,
  renamePreset,
  upsertPreset,
  type Preset,
  type PresetScope,
} from "@solomotion/core";
import { useDoc, useDocStore } from "../../state/document-context";
import { useAppPresets } from "../../state/preset-store";

/**
 * The three preset scopes, wired to their real homes and handed back as ONE
 * list plus one set of writes. Every preset surface in the app (the effect
 * editor's picker today; text styles, animations, whole stacks tomorrow) mounts
 * this hook and never touches storage itself — which is what keeps "save to
 * this project" vs "save for every project" one line of UI instead of two
 * parallel implementations.
 *
 * Pass `kind: ""` to collect across EVERY kind (the add-menu's saved list).
 */
export function usePresets(kind: string, query = "") {
  const doc = useDoc();
  const store = useDocStore();
  const app = useAppPresets((s) => s.entries);
  const appSave = useAppPresets((s) => s.save);
  const appRemove = useAppPresets((s) => s.remove);
  const appRename = useAppPresets((s) => s.rename);

  const presets = React.useMemo(() => {
    const sources = [
      builtinPresetSource(),
      { scope: "project" as const, entries: doc.presets },
      { scope: "app" as const, entries: app },
    ];
    if (kind) return collectPresets(sources, kind, query);
    // Every kind: the library is one namespace, so "all" is just the union.
    const kinds = new Set(sources.flatMap((s) => s.entries.map((e) => e.kind)));
    return [...kinds].flatMap((k) => collectPresets(sources, k, query));
  }, [doc.presets, app, kind, query]);

  const save = React.useCallback(
    (
      scope: Exclude<PresetScope, "builtin">,
      name: string,
      data: unknown,
      meta?: Parameters<typeof makePreset>[3],
      forKind = kind,
    ) => {
      if (scope === "app") {
        appSave(forKind, name, data, meta);
        return;
      }
      const entry = makePreset(forKind, name, data, meta);
      store.update("Save preset", (d) => {
        d.presets = upsertPreset(d.presets, entry);
      });
    },
    [appSave, kind, store],
  );

  const remove = React.useCallback(
    (preset: Preset) => {
      if (preset.scope === "builtin") return; // built-ins are read-only by design
      if (preset.scope === "app") {
        appRemove(preset.id);
        return;
      }
      store.update("Delete preset", (d) => {
        d.presets = removePreset(d.presets, preset.id);
      });
    },
    [appRemove, store],
  );

  const rename = React.useCallback(
    (preset: Preset, name: string) => {
      if (preset.scope === "builtin") return;
      if (preset.scope === "app") {
        appRename(preset.id, name);
        return;
      }
      store.update("Rename preset", (d) => {
        d.presets = renamePreset(d.presets, preset.id, name);
      });
    },
    [appRename, store],
  );

  return { presets, save, remove, rename };
}
