"use client";

import { reify, saveScript, uniqueScriptName, type DocumentStore, type ReifyResult } from "@solomotion/core";
import { toast } from "@/lib/toast";
import { copyWithStatus } from "../console/console-report";
import { usePanels } from "../state/panels";
import { useScripts } from "./store";

/**
 * The editor's faces of the code bridge (core `scripts/reify.ts`): "Copy as
 * code" and "New script from selection". Both print through the ONE reify and
 * measure the round trip against the live registry, so what is copied is
 * exactly what `script.reify` gives an agent.
 *
 * Loaded on demand (the menu imports this module lazily): the registry it
 * measures with lives in the agent chunk.
 */

async function printLayers(store: DocumentStore, ids: readonly string[]): Promise<ReifyResult | null> {
  if (!ids.length) return null;
  const { agentApi } = await import("../agent/runner");
  try {
    return await reify(store.getState(), { layers: ids }, { registry: agentApi() });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** One line on what the code cannot say, so a copy is never silently lossy. */
function noteLosses(out: ReifyResult): void {
  if (out.warnings.length) toast(`${out.warnings.length === 1 ? out.warnings[0] : `${out.warnings.length} details have no code form`} — see the comment at the top.`);
}

/** Losses ride the code itself, where a reader (or a model) will see them. */
function withLosses(out: ReifyResult): string {
  if (!out.warnings.length) return out.code;
  return `${out.warnings.map((w) => `// ⚠ ${w.replace(/\s*\n\s*/g, " ")}`).join("\n")}\n${out.code}`;
}

export async function copyLayersAsCode(store: DocumentStore, ids: readonly string[]): Promise<void> {
  const out = await printLayers(store, ids);
  if (!out) return;
  await copyWithStatus(withLosses(out), "code");
  noteLosses(out);
}

/**
 * A new script that OWNS the selection: its ledger adopts the printed roots,
 * so the first Run (replace) removes the originals and rebuilds them from the
 * code — editing the code edits the layers, in place, instead of stacking a
 * copy on top.
 */
export async function newScriptFromLayers(store: DocumentStore, ids: readonly string[], name: string): Promise<void> {
  const out = await printLayers(store, ids);
  if (!out) return;
  let id = "";
  store.update("New script from selection", (d) => {
    // Always a NEW file: saveScript would overwrite one that already has this name.
    const s = saveScript(d, uniqueScriptName(d, null, name.replace(/[\\/]+/g, "-").trim() || "selection"), withLosses(out));
    s.onRun = "replace";
    s.output = { clipIds: [...out.owns.clipIds], frameIds: [...out.owns.frameIds] };
    id = s.id;
  });
  useScripts.getState().setOpen(id);
  usePanels.getState().showLeftPanel("scripts");
  noteLosses(out);
}
