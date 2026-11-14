"use client";

import type { MediaCapability } from "@solomotion/agent";
import { toast } from "@/lib/toast";
import { requireFeature } from "../entitlements";
import { getDocStore } from "../state/document-context";
import { usePanels } from "../state/panels";
import { editorApiSession } from "../state/session";
import { connectionFor } from "./runner";
import { callCommand } from "./call";
import { useAgent } from "./store";

/**
 * QUICK ACTIONS — the right-click AI menu's one-click jobs ("Cut out
 * subject", "Remove pauses", "Read aloud"). No chat, no model deciding: the
 * menu names a registry command and its input, and this runs it exactly as
 * the agent would — same verb, same routing, same Pro gate, same undo label —
 * with progress on the status bar instead of in a transcript.
 *
 * Loaded on first use (the menu imports it dynamically), so the editor's main
 * bundle carries none of it.
 */

export interface QuickAction {
  /** Registry command id, e.g. "media.remove_background". */
  command: string;
  input: Record<string, unknown>;
  /** The media job it needs a connection for. */
  capability: MediaCapability;
  /** Status-bar line while it runs, and the Undo menu label. */
  label: string;
  /** Status-bar line when it lands. */
  done: string;
}

let running = 0;

export async function runQuickAction(action: QuickAction): Promise<void> {
  if (!requireFeature("agents")) return;
  const store = getDocStore();
  if (!store) return;
  await useAgent.getState().load();
  if (!connectionFor(action.capability)) {
    toast.error(`No connection can do this yet`, {
      description: "Add one in Agents → Connections (fal covers every AI media job on one key).",
      action: { label: "Connect", onClick: openConnections },
    });
    return;
  }

  const id = toast.loading(`${action.label}…`);
  const controller = new AbortController();
  running++;
  try {
    const res = await callCommand(action.command, action.input, {
      store,
      actor: "AI",
      historyKey: `quick:${action.command}:${Date.now().toString(36)}`,
      historyLabel: action.label,
      signal: controller.signal,
      progress: (text) => toast.loading(`${action.label} — ${text}`, { id }),
      session: editorApiSession(),
    });
    if (!res.ok) {
      toast.error(res.error, { id, description: res.hint });
      return;
    }
    const undoLabel = `AI · ${action.label}`;
    toast.success(action.done, {
      id,
      action: {
        label: "Undo",
        // Only ever this action's own step — never something the user did since.
        onClick: () => {
          if (store.peekUndoLabel() === undoLabel) store.undo();
        },
      },
    });
  } catch (err) {
    toast.error((err as Error).message || "That did not work.", { id });
  } finally {
    running--;
  }
}

function openConnections(): void {
  usePanels.getState().showLeftPanel("agents");
  void useAgent.getState().load().then(() => useAgent.setState({ setupOpen: true }));
}

/** Whether a quick action is still working — for a page-leave guard. */
export const quickActionsRunning = () => running > 0;
