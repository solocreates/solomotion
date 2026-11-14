"use client";

import { buildMixPlan, type MotionDocument, type MixPlan } from "@solomotion/core";
import { loudnessSource, requestLoudness, useLoudnessVersion } from "./loudness-cache";

/**
 * The LIVE mix plan — memoised on (document, comp, loudness version), so the
 * transport can ask for it every tick and pay for a rebuild only when the
 * project changed or another sound finished measuring. Asking is also what
 * queues the measurements a plan is still missing.
 */
let memo: { doc: MotionDocument; frameId: string; version: number; plan: MixPlan } | null = null;

export function livePlan(doc: MotionDocument, frameId: string): MixPlan {
  const version = useLoudnessVersion.getState().version;
  if (memo && memo.doc === doc && memo.frameId === frameId && memo.version === version) return memo.plan;
  const plan = buildMixPlan(doc, frameId, loudnessSource);
  if (plan.pending > 0) requestLoudness(plan.missingAssets, plan.missingPacks);
  memo = { doc, frameId, version, plan };
  return plan;
}
