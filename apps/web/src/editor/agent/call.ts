"use client";

import { locateClip, type CommandContext, type CommandResult } from "@solomotion/core";
import { beginAiWork } from "../state/ai-activity";
import { flushAutosave } from "../state/autosave";
import { useSession } from "../state/session";
import { agentApi } from "./runner";

/**
 * THE ONE DOOR every AI caller uses to run a registry command — the chat
 * agent, the right-click AI menu, external MCP agents. It is `registry.call`
 * plus the one thing a person should never have to wonder about: WHAT is
 * being worked on. Layers a writing command names shimmer on the canvas and
 * the timeline while it runs; a generation with nowhere to land yet shows a
 * ghost in its comp. Reads mark nothing — looking changes nothing.
 */

/** Input keys that name a layer the command works ON. */
const TARGET_KEYS = ["id", "ids", "edit", "from", "layer", "clipId", "clipIds", "references"] as const;

const GENERATES = /^generate\./;

/** Short present-tense words for the shimmer's pill. */
const ACTIVITY: Record<string, string> = {
  "generate.image": "Drawing",
  "generate.video": "Shooting",
  "generate.speech": "Recording voice",
  "generate.sound": "Designing sound",
  "generate.music": "Composing",
  "media.remove_background": "Cutting out",
  "media.upscale": "Upscaling",
  "media.transcribe": "Listening",
  "media.remove_pauses": "Tightening",
  "audio.isolate": "Cleaning voice",
};

/** Long enough that a fast edit is SEEN to happen, short enough not to linger. */
const MIN_VISIBLE_MS = 650;

export async function callCommand(commandId: string, input: unknown, ctx: CommandContext): Promise<CommandResult> {
  const before = ctx.store.getState();
  const res = await run(commandId, input, ctx);
  // DURABLE BEFORE IT ANSWERS: an edit an agent was told is done must survive
  // a reload that comes a second later. Asked of the document, not the verb,
  // so a script, a batch or a generation that landed something waits too.
  if (ctx.store.getState() !== before) await flushAutosave(ctx.store);
  return res;
}

async function run(commandId: string, input: unknown, ctx: CommandContext): Promise<CommandResult> {
  const api = agentApi();
  const def = api.get(commandId);
  if (!def || def.effect !== "write") return api.call(commandId, input, ctx);

  const doc = ctx.store.getState();
  const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const clipIds: string[] = [];
  for (const key of TARGET_KEYS) {
    const v = record[key];
    for (const id of Array.isArray(v) ? v : [v]) if (typeof id === "string" && locateClip(doc, id)) clipIds.push(id);
  }
  const place = record.place as { frameId?: string } | undefined;
  const frameId = !clipIds.length && GENERATES.test(commandId) ? (place?.frameId ?? useSession.getState().activeFrameId ?? doc.frames[0]?.id ?? null) : null;
  if (!clipIds.length && !frameId) return api.call(commandId, input, ctx);

  const work = beginAiWork({ clipIds, frameId }, ACTIVITY[commandId] ?? "Working");
  const started = Date.now();
  try {
    return await api.call(commandId, input, {
      ...ctx,
      progress: (text) => {
        work.progress(text);
        ctx.progress?.(text);
      },
    });
  } finally {
    const left = MIN_VISIBLE_MS - (Date.now() - started);
    if (left > 0) setTimeout(work.end, left);
    else work.end();
  }
}
